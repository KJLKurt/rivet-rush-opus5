import * as THREE from 'three';
import { CFG } from './Config';
import type { Fx } from '../render/Fx';
import { PAL } from '../render/Palette';
import { glowMat } from '../render/Materials';
import { getTexture } from '../render/Textures';
import {
  createBoltPickup, createEnergyCell, createHeartPickup, createSparkiePod, createCrate,
} from '../render/models/Props';
import type { EnemyModel, EnemyAnimState } from '../render/models/Enemies';
import { buildEnemyModel, buildScrapBurst, ENEMY_CFG } from './EnemyTypes';
import type { AnyEnemyKind, EnemyCfg } from './EnemyTypes';
import { SparkieModel } from '../render/models/Sparkie';
import { clamp, clamp01, damp, swapRemove } from '../core/Util';

/**
 * All the things in an arena that aren't Rivet, the ground or the boss.
 *
 * Every system here pools its meshes: a stage teardown hides objects and
 * returns them to a free list instead of destroying them, so moving between
 * stages doesn't allocate or trigger a GC pause mid-run.
 */

// ===========================================================================
// Collectibles
// ===========================================================================

export type PickupKind = 'bolt' | 'cell' | 'heart';

interface Pickup {
  kind: PickupKind;
  obj: THREE.Group;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds since spawn; used for the pop-out arc and the spawn grace period. */
  age: number;
  phase: number;
  magnetised: boolean;
  alive: boolean;
}

export interface CollectEvent {
  kind: PickupKind;
  x: number; y: number; z: number;
}

export class Collectibles {
  readonly root = new THREE.Group();
  private active: Pickup[] = [];
  private pools: Record<PickupKind, THREE.Group[]> = { bolt: [], cell: [], heart: [] };
  private time = 0;

  /** Extra magnet sources (Sparkie helpers) — world positions + radius. */
  helpers: Array<{ x: number; z: number; r: number }> = [];

  private make(kind: PickupKind): THREE.Group {
    const pool = this.pools[kind];
    const reused = pool.pop();
    if (reused) {
      reused.visible = true;
      return reused;
    }
    const obj = kind === 'bolt' ? createBoltPickup() : kind === 'cell' ? createEnergyCell() : createHeartPickup();
    this.root.add(obj);
    return obj;
  }

  spawn(kind: PickupKind, x: number, z: number, y = 0.85, vx = 0, vy = 0, vz = 0): void {
    const obj = this.make(kind);
    obj.position.set(x, y, z);
    // The prop builders choose their own presentation scale; don't stomp it.
    obj.scale.setScalar(1);
    this.active.push({
      kind, obj, x, y, z, vx, vy, vz,
      age: 0,
      phase: Math.random() * 6.28,
      magnetised: false,
      alive: true,
    });
  }

  /** Bolts flung out of a smashed crate or a defeated drone. */
  burst(x: number, y: number, z: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 6.28 + Math.random() * 0.6;
      const speed = 3.4 + Math.random() * 3.6;
      this.spawn('bolt', x, z, y, Math.cos(a) * speed, 4.2 + Math.random() * 3.4, Math.sin(a) * speed);
    }
  }

  get count(): number {
    return this.active.length;
  }

  /**
   * @returns the pickups collected this frame (the caller scores them).
   */
  update(
    dt: number,
    px: number, pz: number,
    magnetRadius: number,
    fx: Fx,
    out: CollectEvent[],
  ): void {
    this.time += dt;
    const magnet2 = magnetRadius * magnetRadius;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.age += dt;

      // Ballistic pop-out for burst pickups, then settle to a hover.
      if (p.vy !== 0 || p.vx !== 0 || p.vz !== 0) {
        p.vy -= 26 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const drag = Math.exp(-2.6 * dt);
        p.vx *= drag;
        p.vz *= drag;
        if (p.y <= 0.85) {
          p.y = 0.85;
          if (p.vy < -1) {
            p.vy = -p.vy * 0.34;
            p.vx *= 0.55;
            p.vz *= 0.55;
          } else {
            p.vy = 0;
            p.vx = 0;
            p.vz = 0;
          }
        }
      }

      const dx = px - p.x;
      const dz = pz - p.z;
      const d2 = dx * dx + dz * dz;

      // Magnet: the player's own radius, plus any Sparkie helpers.
      let pull = d2 < magnet2;
      if (!pull) {
        for (const h of this.helpers) {
          const hx = h.x - p.x;
          const hz = h.z - p.z;
          if (hx * hx + hz * hz < h.r * h.r) {
            pull = true;
            break;
          }
        }
      }
      // A short grace period stops burst pickups snapping back instantly,
      // which would rob the player of the little shower of gold.
      if (pull && p.age > 0.18) {
        p.magnetised = true;
      }

      if (p.magnetised) {
        const d = Math.sqrt(d2) || 1;
        const accel = CFG.magnet.strength * (1 + (1 - clamp01(d / magnetRadius)) * 1.6);
        p.vx += (dx / d) * accel * dt;
        p.vz += (dz / d) * accel * dt;
        p.vy += ((1.0 - p.y) * 9 - p.vy * 3) * dt;
        const sp = Math.hypot(p.vx, p.vz);
        if (sp > CFG.magnet.maxSpeed) {
          p.vx = (p.vx / sp) * CFG.magnet.maxSpeed;
          p.vz = (p.vz / sp) * CFG.magnet.maxSpeed;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;

        // Sparkling comet tail while it flies in — this is what makes a big
        // magnet upgrade feel spectacular rather than merely convenient.
        if (Math.random() < dt * 34) {
          fx.emitOne(
            'glow', p.x, p.y, p.z,
            (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2,
            p.kind === 'cell' ? PAL.cell : p.kind === 'heart' ? PAL.heart : PAL.bolt,
            0.26, 0.24, 0.9, 4,
          );
        }
      }

      const pickR = p.kind === 'cell' ? 1.15 : 0.92;
      if (d2 < pickR * pickR) {
        out.push({ kind: p.kind, x: p.x, y: p.y, z: p.z });
        p.obj.visible = false;
        this.pools[p.kind].push(p.obj);
        swapRemove(this.active, i);
        continue;
      }

      // Idle animation.
      const bob = Math.sin(this.time * 2.6 + p.phase) * 0.11;
      p.obj.position.set(p.x, p.y + (p.magnetised ? 0 : bob), p.z);
      p.obj.rotation.y += dt * (p.kind === 'cell' ? 1.1 : 2.4);
      if (p.kind === 'cell') {
        p.obj.rotation.z = Math.sin(this.time * 1.4 + p.phase) * 0.16;
        const ring = p.obj.userData.ring as THREE.Mesh | undefined;
        if (ring) {
          ring.rotation.z += dt * 1.8;
          ring.scale.setScalar(1 + Math.sin(this.time * 3 + p.phase) * 0.12);
        }
      }
      const halo = p.obj.userData.halo as THREE.Sprite | undefined;
      if (halo) {
        const s = (p.kind === 'cell' ? 1.55 : p.kind === 'heart' ? 1.35 : 0.78) *
          (1 + Math.sin(this.time * 4 + p.phase) * 0.12 + (p.magnetised ? 0.35 : 0));
        halo.scale.setScalar(s);
      }
    }
  }

  clear(): void {
    for (const p of this.active) {
      p.obj.visible = false;
      this.pools[p.kind].push(p.obj);
    }
    this.active.length = 0;
    this.helpers.length = 0;
  }

  /** Nearest bolt to a point, for the Sparkie helpers' target selection. */
  nearestTo(x: number, z: number, maxDist: number): { x: number; z: number } | null {
    let best: Pickup | null = null;
    let bestD = maxDist * maxDist;
    for (const p of this.active) {
      if (p.kind !== 'bolt' || p.magnetised) continue;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }
}

// ===========================================================================
// Sparkie rescue pods
// ===========================================================================

interface Pod {
  obj: THREE.Group;
  sparkie: SparkieModel;
  x: number; z: number;
  rescued: boolean;
  openT: number;
  phase: number;
  /** Vertical column of cyan light: "a friend is trapped here". */
  beacon: THREE.Mesh;
  /** Bobbing chevron above the beacon, pointing down at the pod. */
  chevron: THREE.Mesh;
  /** Friendly ground ring, the counterpart to the enemies' hostile ring. */
  ring: THREE.Mesh;
}

export class SparkiePods {
  readonly root = new THREE.Group();
  private pods: Pod[] = [];
  private podPool: THREE.Group[] = [];
  private sparkiePool: SparkieModel[] = [];
  private markerPool: Array<{ beacon: THREE.Mesh; chevron: THREE.Mesh; ring: THREE.Mesh }> = [];
  private time = 0;

  /** Sparkies following Rivet in a conga line after being freed. */
  private followers: Array<{ model: SparkieModel; x: number; z: number; y: number; delay: number; home: boolean; carried: boolean }> = [];
  /**
   * Swarm mode: instead of trailing Rivet, freed Sparkies fly to a docking slot
   * on the repair pad. Returning null keeps the default conga-line behaviour.
   */
  homeSlotFor: ((index: number, out: THREE.Vector3) => THREE.Vector3 | null) | null = null;
  /** Fired the first time a Sparkie actually reaches its slot. */
  onReachedHome: ((index: number) => void) | null = null;
  private trailHistory: Array<{ x: number; z: number; t: number }> = [];

  spawn(x: number, z: number): void {
    let obj = this.podPool.pop();
    if (!obj) {
      obj = createSparkiePod();
      this.root.add(obj);
    }
    obj.visible = true;
    obj.position.set(x, 0, z);
    obj.rotation.y = Math.random() * 6.28;

    let sparkie = this.sparkiePool.pop();
    if (!sparkie) {
      sparkie = new SparkieModel();
      this.root.add(sparkie.root);
    }
    sparkie.root.visible = true;
    sparkie.setMood('trapped');
    sparkie.root.position.set(x, 0.62, z);
    sparkie.root.scale.setScalar(1);

    const marks = this.acquireMarkers();
    marks.beacon.position.set(x, 3.9, z);
    marks.chevron.position.set(x, 3.6, z);
    marks.ring.position.set(x, 0.05, z);
    this.pods.push({
      obj, sparkie, x, z, rescued: false, openT: 0, phase: Math.random() * 6.28,
      beacon: marks.beacon, chevron: marks.chevron, ring: marks.ring,
    });
  }

  /**
   * The "rescue me" marker set.
   *
   * Players reported not being able to tell rescue targets from enemies. A pod
   * is small, sits on the floor, and (deliberately) uses hostile magenta on its
   * cage locks, so at the game's camera distance it read as just another drone.
   * Three cheap additions fix it, and none of them rely on colour alone:
   *   - a tall column of cyan light, visible from anywhere in the arena
   *   - a chevron bobbing above it, pointing down
   *   - a soft friendly ground ring that *breathes* slowly, where the hostile
   *     ring pulses fast
   * All three vanish the instant the Sparkie is freed, so the screen only ever
   * advertises things you still have to do.
   */
  private acquireMarkers(): { beacon: THREE.Mesh; chevron: THREE.Mesh; ring: THREE.Mesh } {
    const hit = this.markerPool.pop();
    if (hit) {
      hit.beacon.visible = true;
      hit.chevron.visible = true;
      hit.ring.visible = true;
      return hit;
    }
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 1.05, 7.6, 14, 1, true),
      new THREE.MeshBasicMaterial({
        map: getTexture('gridGlow'),
        color: 0xffffff,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
    );
    beacon.renderOrder = 6;
    this.root.add(beacon);

    // A flat 3D chevron (two angled bars) rather than a sprite, so it reads as
    // part of the world and catches the light of the beacon behind it.
    const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.66, 0.95, 4), glowMat(PAL.cellHot, 0.95, true));
    chevron.rotation.x = Math.PI;
    chevron.rotation.y = Math.PI / 4;
    chevron.renderOrder = 7;
    this.root.add(chevron);

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 28), glowMat(PAL.sparkieGlow, 0.55, true));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 3;
    this.root.add(ring);

    return { beacon, chevron, ring };
  }

  get remaining(): number {
    let n = 0;
    for (const p of this.pods) if (!p.rescued) n++;
    return n;
  }

  get total(): number {
    return this.pods.length;
  }

  get rescuedCount(): number {
    return this.followers.length;
  }

  /** Nearest un-rescued pod, for the HUD's off-screen guidance arrow. */
  nearestPod(x: number, z: number): { x: number; z: number } | null {
    let best: Pod | null = null;
    let bestD = Infinity;
    for (const p of this.pods) {
      if (p.rescued) continue;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  /**
   * Rescue anything within `radius` of (x, z).
   * @returns the world positions of the pods opened this frame.
   */
  tryRescue(x: number, z: number, radius: number, out: Array<{ x: number; z: number }>): void {
    for (const p of this.pods) {
      if (p.rescued) continue;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < radius * radius) {
        p.rescued = true;
        p.sparkie.setMood('freed');
        this.followers.push({
          model: p.sparkie, x: p.x, z: p.z, y: 1.2,
          delay: this.followers.length * 0.09 + 0.22,
          home: false, carried: false,
        });
        out.push({ x: p.x, z: p.z });
      }
    }
  }

  update(dt: number, px: number, pz: number, playerSpeed: number): void {
    this.time += dt;

    // Record the player's path; followers replay it on a delay, which produces
    // a proper swooping conga line for free.
    this.trailHistory.push({ x: px, z: pz, t: this.time });
    while (this.trailHistory.length > 260) this.trailHistory.shift();

    for (const p of this.pods) {
      const dome = p.obj.userData.dome as THREE.Mesh | undefined;
      const locks = p.obj.userData.locks as THREE.Mesh[] | undefined;
      const glow = p.obj.userData.glow as THREE.Mesh | undefined;

      // Markers only exist while the Sparkie still needs you.
      const wanted = !p.rescued;
      const fade = wanted ? 1 : Math.max(0, 1 - p.openT * 2);
      p.beacon.visible = fade > 0.01;
      p.chevron.visible = fade > 0.01;
      p.ring.visible = fade > 0.01;
      if (fade > 0.01) {
        const breathe = 0.5 + Math.sin(this.time * 1.7 + p.phase) * 0.5;
        (p.beacon.material as THREE.MeshBasicMaterial).opacity = fade * (0.3 + breathe * 0.26);
        const bmat = p.beacon.material as THREE.MeshBasicMaterial;
        if (bmat.map) bmat.map.offset.y = -this.time * 0.28;
        p.chevron.position.y = 3.6 + Math.sin(this.time * 2.4 + p.phase) * 0.34;
        p.chevron.rotation.y = this.time * 0.9;
        (p.chevron.material as THREE.MeshBasicMaterial).opacity = fade * (0.7 + breathe * 0.3);
        const rs = 1.5 + breathe * 0.3;
        p.ring.scale.set(rs, rs, 1);
        (p.ring.material as THREE.MeshBasicMaterial).opacity = fade * (0.42 + breathe * 0.35);
      }

      if (p.rescued) {
        p.openT = Math.min(1, p.openT + dt * 3.4);
        if (dome) {
          dome.position.y = 0.28 + p.openT * 1.6;
          dome.scale.setScalar(1 + p.openT * 0.5);
          const m = dome.material as THREE.Material & { opacity: number };
          m.opacity = 0.34 * (1 - p.openT);
        }
        if (locks) {
          for (let i = 0; i < locks.length; i++) {
            const lock = locks[i]!;
            lock.scale.setScalar(Math.max(0, 1 - p.openT * 1.4));
            lock.position.y = 0.62 + p.openT * 0.8;
          }
        }
        if (glow) (glow.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - p.openT);
      } else {
        // Locked: the dome breathes and the locks pulse in sync, so an
        // un-rescued pod reads as "still needs you" at a glance.
        const pulse = 0.5 + Math.sin(this.time * 3 + p.phase) * 0.5;
        if (dome) dome.rotation.y += dt * 0.4;
        if (locks) {
          for (let i = 0; i < locks.length; i++) {
            const lock = locks[i]!;
            lock.scale.setScalar(0.85 + pulse * 0.3);
            (lock.material as THREE.MeshBasicMaterial).opacity = 0.6 + pulse * 0.4;
          }
        }
        if (glow) {
          (glow.material as THREE.MeshBasicMaterial).opacity = 0.22 + pulse * 0.2;
          glow.scale.setScalar(1 + pulse * 0.18);
        }
        p.sparkie.root.position.y = 0.62;
        p.sparkie.lookAt(px - p.x, pz - p.z);
      }
      p.sparkie.update(dt);
    }

    // Followers.
    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i]!;
      if (f.carried) {
        // A snatcher has it; the enemy drives its transform.
        f.model.update(dt, 4);
        continue;
      }
      let tx: number;
      let tz: number;
      const slot = this.homeSlotFor?.(i, _homeTmp) ?? null;
      if (slot) {
        tx = slot.x;
        tz = slot.z;
        if (!f.home && (f.x - tx) ** 2 + (f.z - tz) ** 2 < 1.2) {
          f.home = true;
          this.onReachedHome?.(i);
        }
      } else {
        const targetTime = this.time - f.delay;
        const target = this.sampleTrail(targetTime);
        tx = target ? target.x : px;
        tz = target ? target.z : pz;
      }
      f.x = damp(f.x, tx, 9, dt);
      f.z = damp(f.z, tz, 9, dt);
      f.y = damp(f.y, 1.15 + Math.sin(this.time * 3 + i * 0.9) * 0.16, 6, dt);
      f.model.root.position.set(f.x, f.y, f.z);
      f.model.root.scale.setScalar(0.85);
      if (f.model.currentMood === 'freed' && this.time > 1) f.model.setMood('follow');
      f.model.lookAt(px - f.x, pz - f.z);
      f.model.update(dt, playerSpeed);
    }
  }

  private sampleTrail(t: number): { x: number; z: number } | null {
    const h = this.trailHistory;
    if (h.length === 0) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]!.t <= t) return h[i]!;
    }
    return h[0]!;
  }

  /** Positions of the first N followers — used as extra magnet sources. */
  helperPositions(n: number, out: Array<{ x: number; z: number; r: number }>, radius: number): void {
    for (let i = 0; i < Math.min(n, this.followers.length); i++) {
      const f = this.followers[i]!;
      out.push({ x: f.x, z: f.z, r: radius });
    }
  }

  /** World position of rescued Sparkie #index, or null if it's gone. */
  followerAt(index: number): { x: number; z: number } | null {
    const f = this.followers[index];
    return f && !f.carried ? { x: f.x, z: f.z } : null;
  }

  /** The nearest un-carried, already-home Sparkie — a snatcher's shopping list. */
  nearestFollower(x: number, z: number, maxDist: number): number {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i]!;
      if (f.carried) continue;
      const d = (f.x - x) ** 2 + (f.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  setCarried(index: number, carried: boolean): void {
    const f = this.followers[index];
    if (f) {
      f.carried = carried;
      if (!carried) f.home = false;
    }
  }

  /** Moves a carried Sparkie to wherever its captor is. */
  placeCarried(index: number, x: number, y: number, z: number): void {
    const f = this.followers[index];
    if (!f) return;
    f.x = x;
    f.z = z;
    f.y = y;
    f.model.root.position.set(x, y, z);
  }

  /** Permanently removes a stolen Sparkie. */
  removeFollower(index: number): void {
    const f = this.followers[index];
    if (!f) return;
    f.model.root.visible = false;
    this.sparkiePool.push(f.model);
    this.followers.splice(index, 1);
  }

  get followerCount(): number {
    return this.followers.length;
  }

  /** Makes every rescued Sparkie celebrate (stage clear, victory). */
  cheer(): void {
    for (const f of this.followers) f.model.setMood('cheer');
  }

  clear(): void {
    for (const p of this.pods) {
      p.obj.visible = false;
      const dome = p.obj.userData.dome as THREE.Mesh | undefined;
      if (dome) {
        dome.position.y = 0.28;
        dome.scale.setScalar(1);
        (dome.material as THREE.Material & { opacity: number }).opacity = 0.34;
      }
      const locks = p.obj.userData.locks as THREE.Mesh[] | undefined;
      if (locks) for (const l of locks) l.scale.setScalar(1);
      this.podPool.push(p.obj);
      p.beacon.visible = false;
      p.chevron.visible = false;
      p.ring.visible = false;
      this.markerPool.push({ beacon: p.beacon, chevron: p.chevron, ring: p.ring });
      p.sparkie.root.visible = false;
      this.sparkiePool.push(p.sparkie);
    }
    this.pods.length = 0;
    for (const f of this.followers) {
      f.model.root.visible = false;
      this.sparkiePool.push(f.model);
    }
    this.followers.length = 0;
    this.trailHistory.length = 0;
  }
}

// ===========================================================================
// Smashable crates
// ===========================================================================

interface Crate {
  obj: THREE.Object3D;
  x: number; z: number;
  alive: boolean;
  shake: number;
}

export class Crates {
  readonly root = new THREE.Group();
  private crates: Crate[] = [];
  private pool: THREE.Object3D[] = [];

  spawn(x: number, z: number): void {
    let obj = this.pool.pop();
    if (!obj) {
      obj = createCrate(1);
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.root.add(obj);
    }
    obj.visible = true;
    obj.position.set(x, 0, z);
    obj.rotation.set(0, Math.random() * 6.28, 0);
    obj.scale.setScalar(1);
    this.crates.push({ obj, x, z, alive: true, shake: 0 });
  }

  /** Collision circles for the player, rebuilt whenever a crate breaks. */
  colliders(out: Array<{ x: number; z: number; r: number }>): void {
    for (const c of this.crates) if (c.alive) out.push({ x: c.x, z: c.z, r: 0.62 });
  }

  /** Smashes every crate within `radius`. Returns their positions. */
  smash(x: number, z: number, radius: number, out: Array<{ x: number; z: number }>): void {
    for (const c of this.crates) {
      if (!c.alive) continue;
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < radius * radius) {
        c.alive = false;
        c.obj.visible = false;
        this.pool.push(c.obj);
        out.push({ x: c.x, z: c.z });
      }
    }
  }

  update(dt: number, px: number, pz: number): void {
    for (const c of this.crates) {
      if (!c.alive) continue;
      // Crates rattle when the player is close — a nudge toward dashing them.
      const d = Math.hypot(c.x - px, c.z - pz);
      c.shake = damp(c.shake, d < 4 ? clamp01((4 - d) / 4) : 0, 6, dt);
      c.obj.rotation.z = Math.sin(performance.now() * 0.02 + c.x) * 0.03 * c.shake;
      c.obj.position.y = Math.abs(Math.sin(performance.now() * 0.011 + c.z)) * 0.05 * c.shake;
    }
  }

  clear(): void {
    for (const c of this.crates) {
      c.obj.visible = false;
      if (c.alive) this.pool.push(c.obj);
    }
    this.crates.length = 0;
  }
}

// ===========================================================================
// Enemies
// ===========================================================================

/** Per-kind tuning for the whole roster, originals and Swarm-mode additions. */
const ECFG = ENEMY_CFG;

export interface EnemyHitEvent {
  x: number; y: number; z: number;
  kind: AnyEnemyKind;
  killed: boolean;
  shieldBroken: boolean;
}

export interface EnemyAttackEvent {
  x: number; z: number;
  kind: AnyEnemyKind;
  /** Explosive attacks damage in a radius; contact attacks are point hits. */
  radius: number;
}

interface Enemy {
  kind: AnyEnemyKind;
  model: EnemyModel;
  x: number; z: number;
  vx: number; vz: number;
  hp: number;
  maxHp: number;
  state: EnemyAnimState;
  timer: number;
  cooldown: number;
  stun: number;
  hitFlash: number;
  phase: number;
  /** Direction locked in at the start of a charge/beam. */
  dirX: number; dirZ: number;
  shielded: boolean;
  /** Warden aura is granting this enemy temporary damage resistance. */
  warded: boolean;
  /** Snatcher: index of the Sparkie it has grabbed, or -1. */
  carrying: number;
  /** Splitter: how many generations down this pod is (0 = original). */
  generation: number;
  scale: number;
  alive: boolean;
  spawnT: number;
  /** Ground telegraph decal, shown during wind-ups. */
  decal: THREE.Mesh | null;
  beam: THREE.Mesh | null;
  /** Blob shadow, so the player can read where a hovering drone actually is. */
  shadow: THREE.Mesh;
  /** Pulsing magenta ring — the "this one is hostile" tell. */
  marker: THREE.Mesh;
}

export class Enemies {
  readonly root = new THREE.Group();
  private list: Enemy[] = [];
  private pools: Partial<Record<AnyEnemyKind, EnemyModel[]>> = {};
  private bursts: Array<{ fx: ReturnType<typeof buildScrapBurst> }> = [];
  private decalPool: THREE.Mesh[] = [];
  private beamPool: THREE.Mesh[] = [];
  private shadowPool: THREE.Mesh[] = [];
  private markerPool: THREE.Mesh[] = [];
  private time = 0;

  /**
   * In Swarm mode most drones ignore Rivet and march on the repair pad. Set
   * this and `padRadius` and anything with `targetsPad` will path to it,
   * attacking whatever gets in the way.
   */
  padTarget: { x: number; z: number; radius: number } | null = null;
  /** Called when a pad-seeking enemy reaches the pad and attacks it. */
  onPadAttack: ((x: number, z: number, damage: number) => void) | null = null;
  /** Called when a lobber's shell lands. */
  onShell: ((x: number, z: number, radius: number) => void) | null = null;
  /** Snatcher wants to grab a Sparkie; return an index or -1. */
  requestSparkie: ((x: number, z: number) => number) | null = null;
  /** Snatcher escaped the arena with Sparkie #index. */
  onSparkieStolen: ((index: number) => void) | null = null;
  /** Snatcher was destroyed while carrying Sparkie #index. */
  onSparkieDropped: ((index: number, x: number, z: number) => void) | null = null;
  /** Snatcher just clamped onto Sparkie #index. */
  onSparkieGrabbed: ((index: number) => void) | null = null;
  /** Per-frame position of a Sparkie being carried. */
  onCarryUpdate: ((index: number, x: number, y: number, z: number) => void) | null = null;
  /** Current world position of rescued Sparkie #index, or null if it's gone. */
  sparkieAt: ((index: number) => { x: number; z: number } | null) | null = null;
  /** Radius past which a fleeing snatcher counts as having escaped. */
  escapeRadius = 34;
  /** Nearest player-built obstacle to chew through on the way to the pad. */
  blockingLookup: ((x: number, z: number, maxDist: number) => { x: number; z: number } | null) | null = null;
  /** Called when a pad-seeker is attacking a player-built gadget. */
  onGadgetAttack: ((x: number, z: number, damage: number, dt: number) => void) | null = null;

  get count(): number {
    return this.list.length;
  }

  get aliveCount(): number {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  spawn(kind: AnyEnemyKind, x: number, z: number): void {
    const pool = (this.pools[kind] ??= []);
    let model = pool.pop();
    if (!model) {
      model = buildEnemyModel(kind);
      this.root.add(model.root);
    }
    model.root.visible = true;
    const cfg = ECFG[kind];
    model.root.position.set(x, cfg.hover, z);
    model.root.scale.setScalar(0.001); // pops in
    model.setStunned(false);

    this.list.push({
      kind, model, x, z, vx: 0, vz: 0,
      hp: cfg.hp, maxHp: cfg.hp,
      state: 'idle', timer: 0, cooldown: kind === 'zapper' ? 1.4 : 0.6,
      stun: 0, hitFlash: 0,
      phase: Math.random() * 6.28,
      dirX: 0, dirZ: 1,
      shielded: kind === 'shieldbot',
      warded: false,
      carrying: -1,
      generation: 0,
      scale: 1,
      alive: true,
      spawnT: 0,
      decal: null,
      beam: null,
      shadow: this.acquireShadow(),
      marker: this.acquireMarker(),
    });
  }

  /**
   * Flying enemies with no ground contact are genuinely hard to place on a
   * 3/4 camera. A blob under each one converts "somewhere over there" into an
   * exact ground position, which is the difference between a fair dodge and a
   * cheap hit.
   */
  private acquireShadow(): THREE.Mesh {
    const s = this.shadowPool.pop();
    if (s) {
      s.visible = true;
      return s;
    }
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: getTexture('shadowBlob'),
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        color: 0x0a1030,
        toneMapped: false,
        fog: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.03;
    mesh.renderOrder = 2;
    this.root.add(mesh);
    return mesh;
  }

  /**
   * Every hostile machine gets a pulsing magenta ring on the ground beneath it.
   *
   * Colour alone was not enough at the game's camera distance — players were
   * mistaking drones for the Sparkies they were meant to rescue. The ring adds
   * a second channel (a hard geometric shape that *pulses*, which nothing
   * friendly does) and it sits on the ground plane, where the player is already
   * looking to judge positions.
   */
  private acquireMarker(): THREE.Mesh {
    const m = this.markerPool.pop();
    if (m) {
      m.visible = true;
      return m;
    }
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.74, 1, 20),
      glowMat(PAL.droneTrim, 0.6, true),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.05;
    mesh.renderOrder = 3;
    this.root.add(mesh);
    return mesh;
  }

  private acquireDecal(): THREE.Mesh {
    const d = this.decalPool.pop();
    if (d) {
      d.visible = true;
      return d;
    }
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1, 28),
      glowMat(PAL.danger, 0.6, true),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 7;
    this.root.add(mesh);
    return mesh;
  }

  private releaseDecal(e: Enemy): void {
    if (!e.decal) return;
    e.decal.visible = false;
    this.decalPool.push(e.decal);
    e.decal = null;
  }

  private acquireBeam(): THREE.Mesh {
    const b = this.beamPool.pop();
    if (b) {
      b.visible = true;
      return b;
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat(PAL.danger, 0.85, true));
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 7;
    this.root.add(mesh);
    return mesh;
  }

  private releaseBeam(e: Enemy): void {
    if (!e.beam) return;
    e.beam.visible = false;
    this.beamPool.push(e.beam);
    e.beam = null;
  }

  /**
   * @param attacks  filled with attacks that land this frame
   */
  update(
    dt: number,
    px: number, pz: number,
    playerRadius: number,
    arenaRadius: number,
    obstacles: Array<{ x: number; z: number; r: number }>,
    fx: Fx,
    attacks: EnemyAttackEvent[],
    onTelegraph: (kind: AnyEnemyKind, x: number, z: number) => void,
  ): void {
    this.time += dt;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i]!;
      const cfg = ECFG[e.kind];

      if (!e.alive) {
        this.releaseDecal(e);
        this.releaseBeam(e);
        e.shadow.visible = false;
        this.shadowPool.push(e.shadow);
        e.marker.visible = false;
        this.markerPool.push(e.marker);
        e.model.root.visible = false;
        (this.pools[e.kind] ??= []).push(e.model);
        swapRemove(this.list, i);
        continue;
      }

      e.spawnT = Math.min(1, e.spawnT + dt * 3.4);
      const grow = e.spawnT < 1 ? 0.2 + e.spawnT * 0.8 : 1;
      e.model.root.scale.setScalar(grow * e.scale);
      if (e.hitFlash > 0) e.hitFlash -= dt;

      // Swarm mode: most drones march on the repair pad and only bother with
      // Rivet if he gets in the way. Redirecting the "toward the target" vector
      // here means every existing behaviour works unchanged against either
      // target, instead of each one needing a swarm branch.
      let aimX = px;
      let aimZ = pz;
      let chewing = false;
      const pad = this.padTarget;
      if (pad && ECFG[e.kind].targetsPad && e.carrying < 0) {
        const toPlayer = Math.hypot(px - e.x, pz - e.z);
        if (toPlayer > 5.5) {
          const blocker = this.blockingLookup?.(e.x, e.z, 4.5) ?? null;
          if (blocker) {
            aimX = blocker.x;
            aimZ = blocker.z;
            chewing = true;
          } else {
            aimX = pad.x;
            aimZ = pad.z;
          }
        }
      }
      const dx = aimX - e.x;
      const dz = aimZ - e.z;
      const dist = Math.hypot(dx, dz) || 1;
      const nx = dx / dist;
      const nz = dz / dist;

      if (e.stun > 0) {
        e.stun -= dt;
        e.state = 'stunned';
        e.vx *= Math.exp(-4 * dt);
        e.vz *= Math.exp(-4 * dt);
        if (e.stun <= 0) {
          e.model.setStunned(false);
          e.state = 'idle';
          e.cooldown = 0.5;
        }
      } else {
        e.cooldown -= dt;
        e.timer -= dt;
        this.think(e, cfg, dt, nx, nz, dist, attacks, onTelegraph, fx);
      }

      // Integrate + separate from other enemies so they never stack up into a
      // single unreadable blob.
      e.x += e.vx * dt;
      e.z += e.vz * dt;
      for (let j = 0; j < this.list.length; j++) {
        if (j === i) continue;
        const o = this.list[j]!;
        if (!o.alive) continue;
        const ox = e.x - o.x;
        const oz = e.z - o.z;
        const d2 = ox * ox + oz * oz;
        const minD = cfg.radius + ECFG[o.kind].radius;
        if (d2 < minD * minD && d2 > 1e-5) {
          const d = Math.sqrt(d2);
          const push = ((minD - d) / d) * 0.5;
          e.x += ox * push;
          e.z += oz * push;
        }
      }
      for (const ob of obstacles) {
        const ox = e.x - ob.x;
        const oz = e.z - ob.z;
        const minD = ob.r + cfg.radius;
        const d2 = ox * ox + oz * oz;
        if (d2 < minD * minD && d2 > 1e-5) {
          const d = Math.sqrt(d2);
          const push = (minD - d) / d;
          e.x += ox * push;
          e.z += oz * push;
        }
      }
      // Keep them inside the arena.
      const rd = Math.hypot(e.x, e.z);
      const limit = arenaRadius - cfg.radius - 0.4;
      if (rd > limit) {
        e.x = (e.x / rd) * limit;
        e.z = (e.z / rd) * limit;
        if (e.state === 'attack' && e.kind === 'sawdrone') {
          e.state = 'idle';
          e.cooldown = 1.1;
        }
      }

      // Contact damage (except bomblet, which only hurts when it detonates).
      if (e.kind !== 'bomblet' && e.spawnT >= 1 && e.stun <= 0) {
        const touch = cfg.radius + playerRadius;
        if (dist < touch) {
          attacks.push({ x: e.x, z: e.z, kind: e.kind, radius: 0 });
        }
      }

      // Chew through whatever the player built in the way. Without this the
      // defences are permanent and Swarm mode becomes a screensaver after the
      // first few turrets go down.
      if (chewing && e.stun <= 0 && e.spawnT >= 1) {
        const reach = ECFG[e.kind].radius + 1.5;
        if ((aimX - e.x) ** 2 + (aimZ - e.z) ** 2 < reach * reach) {
          this.onGadgetAttack?.(aimX, aimZ, ECFG[e.kind].damage, dt);
        }
      }

      // A carried Sparkie rides in the snatcher's claw.
      if (e.kind === 'snatcher' && e.carrying >= 0) {
        const claw = e.model.root.userData.claw as THREE.Object3D | undefined;
        if (claw) {
          claw.getWorldPosition(_clawPos);
          this.onCarryUpdate?.(e.carrying, _clawPos.x, _clawPos.y, _clawPos.z);
        }
      }

      // Pose + transform.
      const intensity = e.state === 'telegraph' && e.timer > 0
        ? 1 - clamp01(e.timer / (e.kind === 'zapper' ? 1.1 : e.kind === 'bomblet' ? 0.95 : 0.62))
        : e.state === 'attack' ? 1 : clamp01(Math.hypot(e.vx, e.vz) / (cfg.speed || 1));
      // Enemy models build upward from y = 0 and carry their own hover height
      // and bob internally (see the header of Enemies.ts). Lifting the root by
      // `cfg.hover` as well double-applied it, leaving flyers at roughly twice
      // their intended altitude and the ground-standing zapper hovering a metre
      // in the air. `cfg.hover` is now only a *visual centre* used for spawning
      // effects at chest height.
      e.model.root.position.set(e.x, 0, e.z);
      const faceDir = e.state === 'attack' || e.state === 'telegraph'
        ? Math.atan2(e.dirX, -e.dirZ)
        : Math.atan2(nx, -nz);
      e.model.root.rotation.y = damp(e.model.root.rotation.y, faceDir, 7, dt);
      e.model.update(this.time + e.phase, dt, e.state, intensity);

      const size = ECFG[e.kind].radius * 3.0 * e.model.root.scale.x;
      e.shadow.position.set(e.x, 0.03, e.z);
      e.shadow.scale.set(size, size, 1);
      (e.shadow.material as THREE.MeshBasicMaterial).opacity =
        0.3 * e.spawnT * (1 - Math.min(0.5, (ECFG[e.kind].hover - 0.8) * 0.3));

      // Hostile ring. It beats faster while the enemy is winding up an attack,
      // so the ground tells you both *what* it is and *when* it is dangerous.
      const beat = e.state === 'telegraph' || e.state === 'attack' ? 9 : 3.2;
      const pulse = 0.5 + Math.sin(this.time * beat + e.phase) * 0.5;
      const mSize = ECFG[e.kind].radius * (2.05 + pulse * 0.3);
      e.marker.position.set(e.x, 0.05, e.z);
      e.marker.scale.set(mSize, mSize, 1);
      const mMat = e.marker.material as THREE.MeshBasicMaterial;
      mMat.opacity = e.spawnT * (e.stun > 0 ? 0.2 : 0.35 + pulse * 0.3);
      mMat.color.setHex(e.stun > 0 ? PAL.metalMid : e.shielded ? PAL.shield : PAL.droneTrim);

      // Telegraph decal follows the wind-up.
      if (e.decal) {
        const mat = e.decal.material as THREE.MeshBasicMaterial;
        e.decal.position.set(e.x, 0.05, e.z);
        const grow = 0.4 + intensity * 0.75;
        e.decal.scale.setScalar((e.kind === 'bomblet' ? cfg.blastRadius ?? 3.4 : 2.2) * grow);
        mat.opacity = 0.35 + Math.sin(this.time * (12 + intensity * 24)) * 0.25 + intensity * 0.3;
      }
    }

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!this.bursts[i]!.fx.update(dt)) {
        const b = this.bursts[i]!;
        this.root.remove(b.fx.root);
        b.fx.dispose();
        swapRemove(this.bursts, i);
      }
    }
  }

  /** Per-kind behaviour. Each one telegraphs before it can hurt you. */
  private think(
    e: Enemy,
    cfg: EnemyCfg,
    dt: number,
    nx: number, nz: number, dist: number,
    attacks: EnemyAttackEvent[],
    onTelegraph: (kind: AnyEnemyKind, x: number, z: number) => void,
    fx: Fx,
  ): void {
    switch (e.kind) {
      case 'buzzbot': {
        // Simple drift with a lazy sine wobble, so it's easy to dodge and
        // easy to dash through. The whole point is to be a friendly first foe.
        e.state = 'chase';
        const wobble = Math.sin(this.time * 2.4 + e.phase) * 0.5;
        const tx = nx + -nz * wobble;
        const tz = nz + nx * wobble;
        const m = Math.hypot(tx, tz) || 1;
        e.vx = damp(e.vx, (tx / m) * cfg.speed, 3, dt);
        e.vz = damp(e.vz, (tz / m) * cfg.speed, 3, dt);
        break;
      }

      case 'sawdrone': {
        if (e.state === 'telegraph') {
          e.vx *= Math.exp(-6 * dt);
          e.vz *= Math.exp(-6 * dt);
          if (e.timer <= 0) {
            e.state = 'attack';
            e.timer = 0.85;
            const speed = cfg.chargeSpeed ?? 15;
            e.vx = e.dirX * speed;
            e.vz = e.dirZ * speed;
            this.releaseDecal(e);
          }
        } else if (e.state === 'attack') {
          if (e.timer <= 0) {
            e.state = 'idle';
            e.cooldown = 1.5;
          }
          e.vx *= Math.exp(-1.2 * dt);
          e.vz *= Math.exp(-1.2 * dt);
        } else {
          // Circle in, then commit to a straight charge. The charge is fast but
          // perfectly straight, so dashing sideways always beats it.
          e.state = 'chase';
          const strafe = Math.sin(this.time * 0.9 + e.phase) * 0.6;
          const tx = nx * 0.85 + -nz * strafe;
          const tz = nz * 0.85 + nx * strafe;
          const m = Math.hypot(tx, tz) || 1;
          e.vx = damp(e.vx, (tx / m) * cfg.speed, 3.5, dt);
          e.vz = damp(e.vz, (tz / m) * cfg.speed, 3.5, dt);
          if (e.cooldown <= 0 && dist < 12 && dist > 2.5) {
            e.state = 'telegraph';
            e.timer = 0.62;
            e.dirX = nx;
            e.dirZ = nz;
            e.decal = this.acquireDecal();
            (e.decal.material as THREE.MeshBasicMaterial).color.setHex(PAL.droneTrim);
            onTelegraph('sawdrone', e.x, e.z);
          }
        }
        break;
      }

      case 'zapper': {
        e.vx = 0;
        e.vz = 0;
        if (e.state === 'telegraph') {
          if (e.timer <= 0) {
            e.state = 'attack';
            e.timer = 0.3;
            // Fire: a line hit along the locked direction.
            const range = cfg.beamRange ?? 12;
            e.beam = this.acquireBeam();
            (e.beam.material as THREE.MeshBasicMaterial).color.setHex(PAL.droneTrim);
            e.beam.position.set(e.x + e.dirX * range * 0.5, 0.09, e.z + e.dirZ * range * 0.5);
            e.beam.scale.set(0.9, range, 1);
            e.beam.rotation.z = 0;
            e.beam.rotation.y = -Math.atan2(e.dirZ, e.dirX) - Math.PI / 2;
            this.releaseDecal(e);
            fx.burst('glow', e.x + e.dirX, 1.1, e.z + e.dirZ, {
              count: 14, color: PAL.droneTrim, color2: PAL.droneEye,
              speed: 9, size: 0.4, life: 0.3,
              dirX: e.dirX, dirY: 0, dirZ: e.dirZ, focus: 0.75,
            });
            // The beam itself is resolved by the caller via this attack event.
            attacks.push({ x: e.x, z: e.z, kind: 'zapper', radius: -1 });
          }
        } else if (e.state === 'attack') {
          if (e.beam) {
            const mat = e.beam.material as THREE.MeshBasicMaterial;
            mat.opacity = clamp01(e.timer / 0.3) * 0.9;
            e.beam.scale.x = 0.4 + clamp01(e.timer / 0.3) * 1.1;
          }
          if (e.timer <= 0) {
            this.releaseBeam(e);
            e.state = 'idle';
            e.cooldown = 2.5;
          }
        } else {
          e.state = 'idle';
          if (e.cooldown <= 0 && dist < (cfg.beamRange ?? 12)) {
            e.state = 'telegraph';
            e.timer = 1.1;
            e.dirX = nx;
            e.dirZ = nz;
            e.decal = this.acquireDecal();
            (e.decal.material as THREE.MeshBasicMaterial).color.setHex(PAL.droneTrim);
            onTelegraph('zapper', e.x, e.z);
          }
        }
        // While charging, keep tracking the player a little so a standing
        // target gets hit but a moving one escapes.
        if (e.state === 'telegraph') {
          e.dirX = damp(e.dirX, nx, 2.2, dt);
          e.dirZ = damp(e.dirZ, nz, 2.2, dt);
          const m = Math.hypot(e.dirX, e.dirZ) || 1;
          e.dirX /= m;
          e.dirZ /= m;
          if (e.decal) {
            const range = cfg.beamRange ?? 12;
            e.decal.position.set(e.x + e.dirX * range * 0.5, 0.05, e.z + e.dirZ * range * 0.5);
            e.decal.scale.set(0.55, 0.55, 1);
          }
        }
        break;
      }

      case 'bomblet': {
        if (e.state === 'telegraph') {
          e.vx *= Math.exp(-3 * dt);
          e.vz *= Math.exp(-3 * dt);
          if (e.timer <= 0) {
            // Detonate: harmless confetti-pop that damages in a radius.
            attacks.push({ x: e.x, z: e.z, kind: 'bomblet', radius: cfg.blastRadius ?? 3.4 });
            this.explode(e, fx);
            e.alive = false;
          }
        } else {
          e.state = 'chase';
          e.vx = damp(e.vx, nx * cfg.speed, 4.5, dt);
          e.vz = damp(e.vz, nz * cfg.speed, 4.5, dt);
          if (dist < 2.6) {
            e.state = 'telegraph';
            e.timer = 0.95;
            e.decal = this.acquireDecal();
            (e.decal.material as THREE.MeshBasicMaterial).color.setHex(PAL.hazard);
            onTelegraph('bomblet', e.x, e.z);
          }
        }
        break;
      }

      case 'skitter': {
        // Fast, fragile, and moves in erratic bursts rather than a smooth line,
        // so a crowd of them reads as a scuttling swarm instead of a queue.
        e.state = 'chase';
        const burst = 0.55 + Math.sin(this.time * 6 + e.phase * 3) * 0.45;
        const jitter = Math.sin(this.time * 11 + e.phase) * 0.35;
        const tx = nx + -nz * jitter;
        const tz = nz + nx * jitter;
        const m = Math.hypot(tx, tz) || 1;
        e.vx = damp(e.vx, (tx / m) * cfg.speed * burst, 9, dt);
        e.vz = damp(e.vz, (tz / m) * cfg.speed * burst, 9, dt);
        break;
      }

      case 'lobber': {
        // Stationary artillery. The shell is telegraphed by a ground circle for
        // its whole flight, so this enemy only ever punishes standing still.
        e.vx = 0;
        e.vz = 0;
        if (e.state === 'telegraph') {
          if (e.timer <= 0) {
            e.state = 'attack';
            e.timer = 0.45;
            const range = Math.min(dist, 20);
            const tx = e.x + e.dirX * range;
            const tz = e.z + e.dirZ * range;
            this.onShell?.(tx, tz, cfg.shellRadius ?? 3.2);
            this.releaseDecal(e);
            fx.burst('smoke', e.x, 1.1, e.z, {
              count: 8, color: 0xcbd2e8, speed: 5, size: 0.5, life: 0.45,
              dirX: e.dirX, dirY: 0.4, dirZ: e.dirZ, focus: 0.7,
            });
          }
        } else if (e.state === 'attack') {
          if (e.timer <= 0) {
            e.state = 'idle';
            e.cooldown = 2.6;
          }
        } else {
          e.state = 'idle';
          if (e.cooldown <= 0 && dist < 22 && dist > 4) {
            e.state = 'telegraph';
            e.timer = cfg.shellTime ?? 1.35;
            e.dirX = nx;
            e.dirZ = nz;
            e.decal = this.acquireDecal();
            (e.decal.material as THREE.MeshBasicMaterial).color.setHex(PAL.hazard);
            onTelegraph('lobber', e.x, e.z);
          }
        }
        if (e.state === 'telegraph' && e.decal) {
          // The marker sits on the impact point, not on the lobber.
          const range = Math.min(dist, 20);
          e.decal.position.set(e.x + e.dirX * range, 0.05, e.z + e.dirZ * range);
          const grow = 1 - clamp01(e.timer / (cfg.shellTime ?? 1.35));
          const r = (cfg.shellRadius ?? 3.2) * (0.55 + grow * 0.45);
          e.decal.scale.set(r, r, 1);
        }
        break;
      }

      case 'splitter': {
        // Slow and heavy. The danger isn't the pod, it's what it leaves behind.
        e.state = 'chase';
        e.vx = damp(e.vx, nx * cfg.speed, 2, dt);
        e.vz = damp(e.vz, nz * cfg.speed, 2, dt);
        break;
      }

      case 'snatcher': {
        // The thief. Goes for a Sparkie, grabs it, then runs for the rim. If it
        // escapes you lose that Sparkie for good, which is what gives Swarm
        // mode its urgency.
        if (e.carrying >= 0) {
          // Fleeing: head for the nearest edge.
          const d = Math.hypot(e.x, e.z) || 1;
          e.state = 'attack';
          e.vx = damp(e.vx, (e.x / d) * cfg.speed * 1.25, 3, dt);
          e.vz = damp(e.vz, (e.z / d) * cfg.speed * 1.25, 3, dt);
          if (d > this.escapeRadius) {
            this.onSparkieStolen?.(e.carrying);
            e.carrying = -1;
            e.alive = false;
          }
        } else {
          e.state = 'chase';
          const idx = this.requestSparkie?.(e.x, e.z) ?? -1;
          if (idx >= 0 && this.sparkieAt) {
            const target = this.sparkieAt(idx);
            if (target) {
              const gx = target.x - e.x;
              const gz = target.z - e.z;
              const gd = Math.hypot(gx, gz) || 1;
              e.vx = damp(e.vx, (gx / gd) * cfg.speed, 4, dt);
              e.vz = damp(e.vz, (gz / gd) * cfg.speed, 4, dt);
              if (gd < 1.5) {
                e.carrying = idx;
                this.onSparkieGrabbed?.(idx);
                fx.burst('spark', e.x, cfg.hover, e.z, {
                  count: 12, color: PAL.droneTrim, speed: 7, size: 0.3, life: 0.3,
                });
              }
              break;
            }
          }
          // Nothing to steal — harass the player instead.
          e.vx = damp(e.vx, nx * cfg.speed * 0.8, 3, dt);
          e.vz = damp(e.vz, nz * cfg.speed * 0.8, 3, dt);
        }
        break;
      }

      case 'warden': {
        // Support. Hangs back and shields its friends; the aura visual is
        // scaled to exactly the radius that actually protects them.
        e.state = 'chase';
        const stand = 9;
        const push = dist < stand ? -1 : 1;
        e.vx = damp(e.vx, nx * cfg.speed * push, 2, dt);
        e.vz = damp(e.vz, nz * cfg.speed * push, 2, dt);
        const aura = e.model.root.userData.aura as THREE.Object3D | undefined;
        if (aura) {
          const r = cfg.auraRadius ?? 7.5;
          // Squashed on Y: a full hemisphere at this radius occludes a third of
          // the screen, which is unacceptable for a support unit the player is
          // supposed to see *past* in order to fight everything it's shielding.
          aura.scale.set(r, r * 0.22, r);
        }
        break;
      }

      case 'shieldbot': {
        // Advances steadily behind its shield. Zaps bounce off the front, so
        // the player has to dash it (breaking the shield) or get behind it.
        e.state = 'chase';
        e.vx = damp(e.vx, nx * cfg.speed, 2.6, dt);
        e.vz = damp(e.vz, nz * cfg.speed, 2.6, dt);
        e.dirX = nx;
        e.dirZ = nz;
        const shieldObj = e.model.root.userData.shield as THREE.Object3D | undefined;
        if (shieldObj) shieldObj.visible = e.shielded;
        break;
      }
    }
  }

  /** Spawns a smaller copy of a splitter next to its parent. */
  private spawnChild(parent: Enemy, ox: number, oz: number): void {
    const scale = ECFG[parent.kind].childScale ?? 0.6;
    this.spawn(parent.kind, parent.x + ox, parent.z + oz);
    const child = this.list[this.list.length - 1];
    if (!child) return;
    child.generation = parent.generation + 1;
    child.scale = parent.scale * scale;
    child.hp = Math.max(1, Math.round(ECFG[parent.kind].hp * scale));
    child.spawnT = 0.5;
    child.vx = ox * 3;
    child.vz = oz * 3;
  }

  private explode(e: Enemy, fx: Fx): void {
    const cfg = ECFG.bomblet;
    fx.burst('glow', e.x, cfg.hover, e.z, {
      count: 34, color: PAL.hazard, color2: PAL.overdriveHot,
      speed: 13, size: 0.6, life: 0.55, drag: 3.2,
    });
    fx.burst('spark', e.x, cfg.hover, e.z, {
      count: 20, color: PAL.droneTrim, speed: 16, size: 0.4, life: 0.4,
    });
    fx.shockwave(e.x, 0.08, e.z, 0.4, (cfg.blastRadius ?? 3.4) * 2, 0.42, PAL.hazard, 0.9);
    this.releaseDecal(e);
    this.spawnScrap(e);
  }

  private spawnScrap(e: Enemy): void {
    const burst = buildScrapBurst(e.kind);
    burst.root.position.set(e.x, ECFG[e.kind].hover, e.z);
    this.root.add(burst.root);
    this.bursts.push({ fx: burst });
  }

  /**
   * Damages the nearest enemies. `dash` bypasses shields and stuns.
   * @returns hit events for scoring and feedback.
   */
  damageAt(
    x: number, z: number, radius: number, damage: number,
    dash: boolean, out: EnemyHitEvent[], fx: Fx,
  ): void {
    for (const e of this.list) {
      if (!e.alive || e.spawnT < 0.5) continue;
      const d2 = (e.x - x) ** 2 + (e.z - z) ** 2;
      const r = radius + ECFG[e.kind].radius;
      if (d2 > r * r) continue;
      this.applyDamage(e, damage, dash, x, z, out, fx);
    }
  }

  /** Damages one specific enemy — used by the auto-zap and its chains. */
  damageEnemy(target: EnemyRef, damage: number, dash: boolean, out: EnemyHitEvent[], fx: Fx): void {
    const e = this.list[target.index];
    if (!e || !e.alive || e.model !== target.model) return;
    this.applyDamage(e, damage, dash, e.x, e.z, out, fx);
  }

  private applyDamage(
    e: Enemy, damage: number, dash: boolean,
    fromX: number, fromZ: number,
    out: EnemyHitEvent[], fx: Fx,
  ): void {
    const cfg = ECFG[e.kind];
    let shieldBroken = false;

    if (e.shielded) {
      if (dash) {
        e.shielded = false;
        shieldBroken = true;
        const shieldObj = e.model.root.userData.shield as THREE.Object3D | undefined;
        if (shieldObj) shieldObj.visible = false;
        fx.burst('spark', e.x, cfg.hover, e.z, {
          count: 22, color: PAL.shield, color2: 0xffffff,
          speed: 11, size: 0.36, life: 0.42,
        });
        fx.shockwave(e.x, cfg.hover, e.z, 0.5, 3.4, 0.3, PAL.shield, 0.85, true);
      } else {
        // Zaps just spark off the shield — clear feedback that it didn't work.
        fx.burst('spark', e.x, cfg.hover, e.z, {
          count: 5, color: PAL.shield, speed: 5, size: 0.24, life: 0.22,
        });
        out.push({ x: e.x, y: cfg.hover, z: e.z, kind: e.kind, killed: false, shieldBroken: false });
        return;
      }
    }

    e.hp -= damage;
    e.hitFlash = 0.14;
    e.model.hit();

    // Knock them back a little so hits read as physical.
    const kx = e.x - fromX;
    const kz = e.z - fromZ;
    const kd = Math.hypot(kx, kz) || 1;
    const force = dash ? 12 : 4.5;
    e.vx += (kx / kd) * force;
    e.vz += (kz / kd) * force;

    if (dash && e.hp > 0) {
      e.stun = 1.5;
      e.state = 'stunned';
      e.model.setStunned(true);
      this.releaseDecal(e);
      this.releaseBeam(e);
    }

    const killed = e.hp <= 0;
    if (killed) {
      if (e.carrying >= 0) {
        this.onSparkieDropped?.(e.carrying, e.x, e.z);
        e.carrying = -1;
      }
      // A splitter breaks into smaller copies rather than simply dying.
      const splitInto = ECFG[e.kind].splitInto ?? 0;
      if (splitInto > 0 && e.generation < 1) {
        for (let k = 0; k < splitInto; k++) {
          const a = (k / splitInto) * Math.PI * 2 + Math.random();
          this.spawnChild(e, Math.cos(a) * 1.3, Math.sin(a) * 1.3);
        }
      }
      e.alive = false;
      this.spawnScrap(e);
      fx.burst('glow', e.x, cfg.hover, e.z, {
        count: 22, color: PAL.droneTrim, color2: PAL.overdriveHot,
        speed: 9, size: 0.5, life: 0.5,
      });
      fx.burst('spark', e.x, cfg.hover, e.z, {
        count: 14, color: 0xffffff, speed: 13, size: 0.3, life: 0.32,
      });
      fx.shockwave(e.x, 0.06, e.z, 0.3, 3.2, 0.34, PAL.droneShell, 0.7);
    } else {
      fx.burst('spark', e.x, cfg.hover, e.z, {
        count: 7, color: PAL.overdriveHot, speed: 7, size: 0.26, life: 0.25,
      });
    }
    out.push({ x: e.x, y: cfg.hover, z: e.z, kind: e.kind, killed, shieldBroken });
  }

  /** Nearest attackable enemy to a point, for the auto-zap. */
  nearest(x: number, z: number, maxDist: number, exclude?: EnemyModel): EnemyRef | null {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (!e.alive || e.spawnT < 0.5 || e.model === exclude) continue;
      const d = (e.x - x) ** 2 + (e.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    const e = this.list[best]!;
    return { index: best, model: e.model, x: e.x, y: ECFG[e.kind].hover, z: e.z, kind: e.kind };
  }

  /** Everything alive, for the boss fight's cleanup and the HUD counter. */
  forEachAlive(fn: (x: number, z: number, kind: AnyEnemyKind) => void): void {
    for (const e of this.list) if (e.alive) fn(e.x, e.z, e.kind);
  }

  /** Instantly clears the field with a celebratory pop (boss defeat). */
  vaporiseAll(fx: Fx, out: EnemyHitEvent[]): void {
    for (const e of this.list) {
      if (!e.alive) continue;
      e.alive = false;
      this.spawnScrap(e);
      fx.burst('glow', e.x, ECFG[e.kind].hover, e.z, {
        count: 16, color: PAL.overdriveHot, speed: 8, size: 0.45, life: 0.5,
      });
      out.push({ x: e.x, y: ECFG[e.kind].hover, z: e.z, kind: e.kind, killed: true, shieldBroken: false });
    }
  }

  clear(): void {
    for (const e of this.list) {
      this.releaseDecal(e);
      this.releaseBeam(e);
      e.shadow.visible = false;
      this.shadowPool.push(e.shadow);
      e.marker.visible = false;
      this.markerPool.push(e.marker);
      e.model.root.visible = false;
      (this.pools[e.kind] ??= []).push(e.model);
    }
    this.list.length = 0;
    for (const b of this.bursts) {
      this.root.remove(b.fx.root);
      b.fx.dispose();
    }
    this.bursts.length = 0;
  }

  /** Line-vs-circle test used to resolve zapper beams against the player. */
  static beamHitsPoint(
    ox: number, oz: number, dx: number, dz: number, length: number,
    px: number, pz: number, radius: number,
  ): boolean {
    const relX = px - ox;
    const relZ = pz - oz;
    const t = clamp(relX * dx + relZ * dz, 0, length);
    const cx = ox + dx * t;
    const cz = oz + dz * t;
    return (cx - px) ** 2 + (cz - pz) ** 2 < radius * radius;
  }

  /** The locked-in beam direction of a firing zapper, for hit resolution. */
  beamInfo(x: number, z: number): { dx: number; dz: number; range: number } | null {
    for (const e of this.list) {
      if (e.kind === 'zapper' && e.alive && Math.abs(e.x - x) < 0.01 && Math.abs(e.z - z) < 0.01) {
        return { dx: e.dirX, dz: e.dirZ, range: ECFG.zapper.beamRange ?? 12 };
      }
    }
    return null;
  }
}

export interface EnemyRef {
  index: number;
  model: EnemyModel;
  x: number; y: number; z: number;
  kind: AnyEnemyKind;
}

const _homeTmp = new THREE.Vector3();

const _clawPos = new THREE.Vector3();
