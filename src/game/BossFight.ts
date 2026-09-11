import * as THREE from 'three';
import { CFG } from './Config';
import { createBoss } from '../render/models/Boss';
import type { BossModel, BossPhase, BossAnimState } from '../render/models/Boss';
import type { Fx } from '../render/Fx';
import { PAL } from '../render/Palette';
import { glowMat } from '../render/Materials';
import { clamp, clamp01, makeRandom, swapRemove } from '../core/Util';

/**
 * THE GREAT SCRAPBOT fight.
 *
 * The teaching loop is deliberately simple and repeats all fight long:
 *
 *      it winds up  →  you dodge  →  it's stuck  →  you dash the core
 *
 * Every attack telegraphs with a pose *and* a ground marker, and every attack
 * except the sweep leaves the boss staggered with its chest open afterwards.
 * So a player who never reads a word still learns the whole fight in about
 * fifteen seconds, and the difficulty comes purely from the attacks getting
 * faster and denser, never from becoming less readable.
 *
 * Nothing here can chip a player to death from off-screen: the arena is small,
 * every damaging thing is drawn on the floor before it hurts, and dashing has
 * i-frames.
 */

export type BossEvent =
  | 'intro' | 'slam' | 'sweepStart' | 'spawn' | 'vacuum'
  | 'stagger' | 'phase2' | 'phase3' | 'hurt' | 'defeated';

interface Shockwave {
  x: number; z: number;
  radius: number;
  speed: number;
  thickness: number;
  life: number;
  hit: boolean;
  /** The ring the player actually sees. Its width matches the damage band. */
  mesh: THREE.Mesh;
}

interface ScrapDrop {
  x: number; z: number;
  timer: number;
  decal: THREE.Mesh;
  fallen: boolean;
}

export class BossFight {
  readonly model: BossModel;
  readonly root = new THREE.Group();

  hp: number = CFG.boss.maxHp;
  private maxHp: number = CFG.boss.maxHp;
  private readonly relaxed: boolean;
  phase: BossPhase = 1;
  defeated = false;

  private state: BossAnimState = 'dormant';
  private stateTime = 0;
  private stateDuration = 1;
  private attackCount = 0;
  private rng = makeRandom(0x5c2a9b);
  private shockwaves: Shockwave[] = [];
  private wavePool: THREE.Mesh[] = [];
  private drops: ScrapDrop[] = [];
  private dropPool: THREE.Mesh[] = [];
  private sweepAngle = 0;
  private sweepBeam: THREE.Mesh;
  private slamMarker: THREE.Mesh;
  private coreMarker: THREE.Mesh;
  private vacuumRing: THREE.Mesh;
  private time = 0;
  private introTimer = 0;
  private lastCoreHit = 0;

  /** Set by the game every frame. */
  playerX = 0;
  playerZ = 0;

  onEvent: ((e: BossEvent) => void) | null = null;
  /** Called when the boss wants buzzbots on the field. */
  onSpawnMinions: ((count: number) => void) | null = null;
  /** Scatters bolts (and, at phase changes, a repair heart) near the machine. */
  onReward: ((x: number, z: number, heart: boolean) => void) | null = null;
  /** Called when something should damage the player. */
  onDamagePlayer: ((x: number, z: number, force: number) => void) | null = null;
  /** Pull applied to the player during the phase-3 vacuum. */
  vacuumPull = 0;

  /** @param relaxed  softer ruleset: less health and longer punish windows. */
  constructor(relaxed = false) {
    this.relaxed = relaxed;
    if (relaxed) this.hp = Math.round(CFG.boss.maxHp * 0.7);
    this.maxHp = this.hp;
    this.model = createBoss();
    this.model.root.position.set(0, 0, -6);
    // The finale should feel like it towers over Rivet. Scaling the whole rig
    // is safe: every gameplay radius below is expressed in world units.
    this.model.root.scale.setScalar(1.3);
    this.root.add(this.model.root);

    // The rotating sweep beam.
    this.sweepBeam = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat(PAL.bossCore, 0.8, true));
    this.sweepBeam.rotation.x = -Math.PI / 2;
    this.sweepBeam.position.y = 0.1;
    this.sweepBeam.visible = false;
    this.sweepBeam.renderOrder = 7;
    this.root.add(this.sweepBeam);

    // Ground marker for the incoming slam.
    this.slamMarker = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 32), glowMat(PAL.danger, 0.7, true));
    this.slamMarker.rotation.x = -Math.PI / 2;
    this.slamMarker.position.y = 0.06;
    this.slamMarker.visible = false;
    this.slamMarker.renderOrder = 7;
    this.root.add(this.slamMarker);

    // "Hit me here" marker under the exposed core.
    this.coreMarker = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), glowMat(PAL.bolt, 0.85, true));
    this.coreMarker.rotation.x = -Math.PI / 2;
    this.coreMarker.position.y = 0.07;
    this.coreMarker.visible = false;
    this.coreMarker.renderOrder = 7;
    this.root.add(this.coreMarker);

    this.vacuumRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), glowMat(PAL.bossCoreAngry, 0.5, true));
    this.vacuumRing.rotation.x = -Math.PI / 2;
    this.vacuumRing.position.set(0, 0.05, -6);
    this.vacuumRing.visible = false;
    this.vacuumRing.renderOrder = 7;
    this.root.add(this.vacuumRing);
  }

  /** Live ground hazards: expanding rings, the slam marker and scrap drops. */
  collectThreats(out: Array<{ x: number; z: number; inner: number; outer: number }>): void {
    for (const w of this.shockwaves) {
      const band = clamp(w.radius * 0.18, 0.75, 2.0) * w.thickness + 1.2;
      out.push({ x: w.x, z: w.z, inner: w.radius - band, outer: w.radius + band });
    }
    if (this.state === 'slamWindup') {
      out.push({ x: this.slamTargetX, z: this.slamTargetZ, inner: 0, outer: 4.5 });
    }
    for (const d of this.drops) {
      if (!d.fallen) out.push({ x: d.x, z: d.z, inner: 0, outer: 3 });
    }
  }

  get healthFraction(): number {
    return clamp01(this.hp / this.maxHp);
  }

  get coreExposed(): boolean {
    return this.model.coreExposed && !this.defeated;
  }

  get bossPosition(): THREE.Vector3 {
    return this.model.root.position;
  }

  /** Kicks off the wake-up cinematic. */
  begin(): void {
    this.setState('dormant', 0.6);
    this.introTimer = 0;
  }

  startWake(): void {
    this.setState('wake', 2.2);
    this.onEvent?.('intro');
  }

  private setState(s: BossAnimState, duration: number): void {
    this.state = s;
    this.stateTime = 0;
    this.stateDuration = duration;
    this.model.setState(s);
  }

  /** Phase-scaled timing: later phases are quicker, never less readable. */
  private scale(v: number): number {
    const phase = this.phase === 1 ? 1 : this.phase === 2 ? 0.86 : 0.74;
    // Relaxed keeps every telegraph but gives more time to read it.
    return v * phase * (this.relaxed ? 1.25 : 1);
  }

  update(dt: number, fx: Fx): void {
    this.time += dt;
    this.stateTime += dt;
    this.vacuumPull = 0;

    this.model.lookAtTarget.set(this.playerX, 1.2, this.playerZ);

    if (!this.defeated) this.think(dt, fx);

    const progress = clamp01(this.stateTime / Math.max(0.001, this.stateDuration));
    this.model.update(this.time, dt, progress);

    this.updateShockwaves(dt, fx);
    this.updateDrops(dt, fx);
    this.updateMarkers(dt);

    // Damage smoke from the exhausts, thicker as it gets hurt.
    const dmg = 1 - this.healthFraction;
    if (Math.random() < dt * (4 + dmg * 30)) {
      const sx = Math.random() < 0.5 ? -1.3 : 1.3;
      fx.emitOne(
        'smoke',
        this.model.root.position.x + sx, 7.0, this.model.root.position.z - 1.3,
        (Math.random() - 0.5) * 1.2, 2.4 + Math.random() * 1.6, (Math.random() - 0.5) * 1.2,
        dmg > 0.6 ? 0x6b6f86 : 0xc8cee0,
        0.9 + Math.random() * 0.5, 1.4, 0.5, 0.9, -1.4,
      );
    }
    if (dmg > 0.5 && Math.random() < dt * 14) {
      fx.emitOne(
        'spark',
        this.model.root.position.x + (Math.random() - 0.5) * 4, 3 + Math.random() * 3,
        this.model.root.position.z + 1.4,
        (Math.random() - 0.5) * 4, 1 + Math.random() * 3, 2 + Math.random() * 2,
        PAL.bossAccent, 0.3, 0.5, 0.9, 2, 9,
      );
    }
  }

  private think(dt: number, fx: Fx): void {
    const done = this.stateTime >= this.stateDuration;
    const bx = this.model.root.position.x;
    const bz = this.model.root.position.z;

    switch (this.state) {
      case 'dormant':
        this.introTimer += dt;
        break;

      case 'wake':
        if (done) this.setState('idle', this.scale(1.4));
        break;

      case 'idle':
        if (done) this.chooseAttack();
        break;

      case 'slamWindup':
        if (done) {
          this.setState('slam', 0.9);
          this.onEvent?.('slam');
          // The impact lands at the start of the swing-down, on the marked spot.
          const tx = this.slamTargetX;
          const tz = this.slamTargetZ;
          this.shockwaves.push(this.makeWave(tx, tz, 15 + this.phase * 2.6, 1.0, 1.5));
          // A second, bigger ring in phase 3 — same rules, more to read.
          if (this.phase >= 3) {
            this.shockwaves.push(this.makeWave(tx, tz, 10.5, 0.9, 1.9));
          }
          fx.shockwave(tx, 0.08, tz, 1, 9, 0.45, PAL.bossAccent, 0.95);
          fx.burst('smoke', tx, 0.3, tz, {
            count: 22, color: 0xd7ddf0, speed: 9, size: 1.2, endSize: 2.4,
            life: 0.8, upBias: 0.5, drag: 2.4,
          });
          fx.burst('spark', tx, 0.3, tz, {
            count: 18, color: PAL.bossAccent, speed: 13, size: 0.4, life: 0.5,
            gravity: 16, bounce: 0.4,
          });
        }
        break;

      case 'slam':
        if (done) {
          // The fist is buried — this is the punish window.
          this.setState('stagger', CFG.boss.staggerTime * (this.relaxed ? 1.3 : 1));
          this.onEvent?.('stagger');
          // Phase 3 hands out a repair heart on every opening. By then the run
          // is seven minutes old and losing it to chip damage is miserable.
          this.onReward?.(bx, bz + 4, this.phase >= 3);
        }
        break;

      case 'sweepWindup':
        if (done) {
          this.sweepAngle = Math.atan2(this.playerX - bx, this.playerZ - bz) - 0.9;
          this.setState('sweep', this.scale(2.4));
          this.onEvent?.('sweepStart');
        }
        break;

      case 'sweep': {
        // A slow rotating beam. Easy to walk around, trivial to dash through,
        // but it forces the player to keep moving.
        const t = clamp01(this.stateTime / this.stateDuration);
        this.sweepAngle += dt * 1.25;
        this.sweepBeam.visible = true;
        const range = 30;
        const mat = this.sweepBeam.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.55 + Math.sin(this.time * 22) * 0.2;
        this.sweepBeam.scale.set(1.5, range, 1);
        this.sweepBeam.position.set(
          bx + Math.sin(this.sweepAngle) * range * 0.5,
          0.1,
          bz + Math.cos(this.sweepAngle) * range * 0.5,
        );
        this.sweepBeam.rotation.z = -this.sweepAngle;
        // Hit test against the beam line.
        const dx = Math.sin(this.sweepAngle);
        const dz = Math.cos(this.sweepAngle);
        const relX = this.playerX - bx;
        const relZ = this.playerZ - bz;
        const along = relX * dx + relZ * dz;
        if (along > 0 && along < range) {
          const perp = Math.abs(relX * dz - relZ * dx);
          if (perp < 1.2) this.onDamagePlayer?.(bx, bz, 10);
        }
        if (Math.random() < dt * 40) {
          const d = Math.random() * range;
          fx.emitOne(
            'glow', bx + dx * d, 0.3, bz + dz * d,
            (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2,
            PAL.bossCore, 0.4, 0.4, 0.9, 3,
          );
        }
        if (t >= 1) {
          this.sweepBeam.visible = false;
          this.setState('stagger', CFG.boss.staggerTime * 0.75);
          this.onEvent?.('stagger');
        }
        break;
      }

      case 'spawnWindup':
        if (done) {
          this.setState('spawn', 1.1);
          this.onSpawnMinions?.(this.phase === 1 ? 3 : this.phase === 2 ? 4 : 5);
          this.onEvent?.('spawn');
          fx.burst('glow', bx, 4.2, bz + 2, {
            count: 26, color: PAL.droneShell, color2: PAL.droneTrim,
            speed: 10, size: 0.55, life: 0.6,
          });
        }
        break;

      case 'spawn':
        if (done) {
          this.setState('stagger', CFG.boss.staggerTime * 0.7);
          this.onEvent?.('stagger');
        }
        break;

      case 'vacuum': {
        // Pulls the player in while scrap rains down. Dashing beats the pull,
        // so the answer is the verb the player already loves.
        const t = clamp01(this.stateTime / this.stateDuration);
        this.vacuumPull = Math.sin(t * Math.PI) * 15;
        this.vacuumRing.visible = true;
        this.vacuumRing.position.set(bx, 0.05, bz);
        this.vacuumRing.scale.setScalar(22 * (1 - (this.time * 0.6) % 1));
        (this.vacuumRing.material as THREE.MeshBasicMaterial).opacity =
          0.45 * ((this.time * 0.6) % 1) * Math.sin(t * Math.PI);
        if (Math.random() < dt * 6) this.addDrop();
        if (Math.random() < dt * 50) {
          const a = Math.random() * 6.28;
          const d = 10 + Math.random() * 12;
          fx.emitOne(
            'glow', bx + Math.cos(a) * d, 0.6 + Math.random() * 2, bz + Math.sin(a) * d,
            -Math.cos(a) * 9, 1, -Math.sin(a) * 9,
            PAL.bossCoreAngry, 0.34, 0.7, 0.85, 0.6,
          );
        }
        if (t >= 1) {
          this.vacuumRing.visible = false;
          this.setState('stagger', CFG.boss.staggerTime * 0.8);
          this.onEvent?.('stagger');
        }
        break;
      }

      case 'stagger':
        if (done) this.setState('idle', this.scale(1.5));
        break;

      case 'hurt':
        if (done) this.setState('stagger', Math.max(0.8, CFG.boss.staggerTime * 0.5));
        break;

      case 'defeated':
        break;
    }
  }

  private slamTargetX = 0;
  private slamTargetZ = 0;

  private chooseAttack(): void {
    this.attackCount++;
    const roll = this.rng();
    const bx = this.model.root.position.x;
    const bz = this.model.root.position.z;

    // Always open with a slam so the first thing the player ever sees is the
    // attack that teaches the whole fight.
    let attack: 'slam' | 'sweep' | 'spawn' | 'vacuum' = 'slam';
    if (this.attackCount > 1) {
      if (this.phase === 1) {
        attack = roll < 0.68 ? 'slam' : 'spawn';
      } else if (this.phase === 2) {
        attack = roll < 0.42 ? 'slam' : roll < 0.76 ? 'sweep' : 'spawn';
      } else {
        attack = roll < 0.34 ? 'slam' : roll < 0.6 ? 'sweep' : roll < 0.8 ? 'vacuum' : 'spawn';
      }
    }

    switch (attack) {
      case 'slam': {
        // Aim slightly ahead of the player so standing still is punished but
        // moving is always safe.
        this.slamTargetX = clamp(this.playerX, -18, 18);
        this.slamTargetZ = clamp(this.playerZ, -18, 18);
        this.slamMarker.visible = true;
        this.setState('slamWindup', this.scale(1.15));
        break;
      }
      case 'sweep':
        this.setState('sweepWindup', this.scale(1.25));
        break;
      case 'spawn':
        this.setState('spawnWindup', this.scale(0.95));
        break;
      case 'vacuum':
        this.setState('vacuum', 3.2);
        break;
    }
    void bx;
    void bz;
  }

  private addDrop(): void {
    const a = this.rng() * 6.28;
    const d = this.rng() * (CFG.boss.arenaRadius - 4);
    let decal = this.dropPool.pop();
    if (!decal) {
      decal = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 20), glowMat(PAL.hazard, 0.7, true));
      decal.rotation.x = -Math.PI / 2;
      decal.position.y = 0.06;
      decal.renderOrder = 7;
      this.root.add(decal);
    }
    decal.visible = true;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    decal.position.set(x, 0.06, z);
    decal.scale.setScalar(2.4);
    this.drops.push({ x, z, timer: 1.15, decal, fallen: false });
  }

  private updateDrops(dt: number, fx: Fx): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]!;
      d.timer -= dt;
      const mat = d.decal.material as THREE.MeshBasicMaterial;
      if (d.timer > 0) {
        mat.opacity = 0.4 + Math.sin(this.time * 26) * 0.3;
        d.decal.scale.setScalar(2.4 * (0.6 + (1 - d.timer / 1.15) * 0.4));
      } else if (!d.fallen) {
        d.fallen = true;
        fx.shockwave(d.x, 0.08, d.z, 0.5, 5.5, 0.35, PAL.hazard, 0.9);
        fx.burst('spark', d.x, 0.3, d.z, {
          count: 14, color: PAL.hazard, speed: 10, size: 0.35, life: 0.4,
          gravity: 18, bounce: 0.4,
        });
        if ((this.playerX - d.x) ** 2 + (this.playerZ - d.z) ** 2 < 2.4 * 2.4) {
          this.onDamagePlayer?.(d.x, d.z, 11);
        }
        d.decal.visible = false;
        this.dropPool.push(d.decal);
        swapRemove(this.drops, i);
      }
    }
  }

  /**
   * An expanding ground ring. The visual ring is built to exactly match the
   * damage band, because a hitbox the player cannot see is the difference
   * between a boss that teaches and a boss that feels cheap.
   */
  private makeWave(x: number, z: number, speed: number, thickness: number, life: number): Shockwave {
    let mesh = this.wavePool.pop();
    if (!mesh) {
      // Unit ring: inner 1 - band, outer 1. Scaling it keeps the band
      // proportional, so `scale` is set from radius and the geometry is rebuilt
      // per-frame-free.
      mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), glowMat(PAL.bossAccent, 0.9, true));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.09;
      mesh.renderOrder = 7;
      this.root.add(mesh);
    }
    mesh.visible = true;
    mesh.position.set(x, 0.09, z);
    mesh.scale.setScalar(0.5);
    return { x, z, radius: 0.5, speed, thickness, life, hit: false, mesh };
  }

  private updateShockwaves(dt: number, fx: Fx): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const w = this.shockwaves[i]!;
      w.radius += w.speed * dt;
      w.life -= dt;
      // The visible ring is an 18% annulus, so the damage band is derived from
      // the drawn radius rather than being a separate constant. Anything else
      // and the hitbox slowly drifts away from the graphic as the wave grows.
      const band = clamp(w.radius * 0.18, 0.75, 2.0) * w.thickness;
      if (!w.hit) {
        const d = Math.hypot(this.playerX - w.x, this.playerZ - w.z);
        if (Math.abs(d - w.radius) < band) {
          w.hit = true;
          this.onDamagePlayer?.(w.x, w.z, 13);
        }
      }
      // Visual ring pulses outward with the logical one.
      if (Math.random() < dt * 60) {
        const a = Math.random() * 6.28;
        fx.emitOne(
          'glow', w.x + Math.cos(a) * w.radius, 0.25, w.z + Math.sin(a) * w.radius,
          Math.cos(a) * 3, 2.5, Math.sin(a) * 3,
          PAL.bossAccent, 0.5, 0.4, 0.85, 2.5,
        );
      }
      w.mesh.scale.setScalar(w.radius);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.5 * clamp01(w.life / 1.2);
      if (w.life <= 0 || w.radius > 40) {
        w.mesh.visible = false;
        this.wavePool.push(w.mesh);
        swapRemove(this.shockwaves, i);
      }
    }
  }

  private updateMarkers(dt: number): void {
    const winding = this.state === 'slamWindup';
    this.slamMarker.visible = winding;
    if (winding) {
      const t = clamp01(this.stateTime / this.stateDuration);
      this.slamMarker.position.set(this.slamTargetX, 0.06, this.slamTargetZ);
      // Shrinks as the fist falls — an unmistakable countdown.
      this.slamMarker.scale.setScalar(6.5 - t * 2.6);
      (this.slamMarker.material as THREE.MeshBasicMaterial).opacity =
        0.45 + Math.sin(this.time * (10 + t * 30)) * 0.3 + t * 0.25;
    }

    const exposed = this.coreExposed;
    this.coreMarker.visible = exposed;
    if (exposed) {
      const bp = this.model.root.position;
      this.coreMarker.position.set(bp.x, 0.07, bp.z + 2.6);
      const pulse = 1 + Math.sin(this.time * 6) * 0.14;
      this.coreMarker.scale.setScalar(3.4 * pulse);
      (this.coreMarker.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(this.time * 6) * 0.28;
    }
    void dt;
  }

  /** Damage the boss. Only lands while the core is open. */
  damage(amount: number, fx: Fx, isDash: boolean): boolean {
    if (this.defeated || !this.coreExposed) return false;
    // Rate-limit dash hits so a single pass can't chunk two hits.
    if (isDash && this.time - this.lastCoreHit < 0.3) return false;
    if (isDash) this.lastCoreHit = this.time;

    this.hp = Math.max(0, this.hp - amount);
    this.model.hit();
    this.model.setHealth(this.healthFraction);
    this.onEvent?.('hurt');

    const cp = this.model.corePosition;
    fx.burst('spark', cp.x, cp.y, cp.z, {
      count: isDash ? 26 : 8, color: PAL.bossCore, color2: 0xffffff,
      speed: isDash ? 15 : 7, size: 0.4, life: 0.4,
    });
    if (isDash) {
      fx.shockwave(cp.x, cp.y, cp.z, 0.5, 6, 0.32, PAL.bossCore, 0.9, true);
    }

    const frac = this.healthFraction;
    if (frac <= 0) {
      this.defeat(fx);
      return true;
    }
    if (this.phase === 1 && frac <= CFG.boss.phase2At) {
      this.phase = 2;
      this.model.setPhase(2);
      this.onEvent?.('phase2');
      // A heart at each phase change. This fight is the climax of a 7-minute
      // run; losing it to attrition three seconds from the end is miserable.
      this.onReward?.(this.model.root.position.x, this.model.root.position.z + 7, true);
      this.setState('hurt', 1.4);
    } else if (this.phase === 2 && frac <= CFG.boss.phase3At) {
      this.phase = 3;
      this.model.setPhase(3);
      this.onEvent?.('phase3');
      this.onReward?.(this.model.root.position.x, this.model.root.position.z + 7, true);
      this.setState('hurt', 1.6);
    }
    return true;
  }

  private defeat(fx: Fx): void {
    this.defeated = true;
    this.setState('defeated', 6);
    this.sweepBeam.visible = false;
    this.vacuumRing.visible = false;
    this.slamMarker.visible = false;
    this.coreMarker.visible = false;
    for (const d of this.drops) {
      d.decal.visible = false;
      this.dropPool.push(d.decal);
    }
    this.drops.length = 0;
    for (const w of this.shockwaves) {
      w.mesh.visible = false;
      this.wavePool.push(w.mesh);
    }
    this.shockwaves.length = 0;
    const bp = this.model.root.position;
    fx.burst('glow', bp.x, 4, bp.z, {
      count: 60, color: PAL.overdriveHot, color2: PAL.bossCore,
      speed: 16, size: 0.8, life: 1.2, drag: 1.6,
    });
    this.onEvent?.('defeated');
  }

  /** Body collision radius, for contact damage while it is upright. */
  get bodyRadius(): number {
    return 3.4;
  }

  dispose(): void {
    this.model.dispose();
    this.sweepBeam.geometry.dispose();
    this.slamMarker.geometry.dispose();
    this.coreMarker.geometry.dispose();
    this.vacuumRing.geometry.dispose();
    for (const d of this.dropPool) d.geometry.dispose();
    for (const w of this.wavePool) w.geometry.dispose();
  }
}
