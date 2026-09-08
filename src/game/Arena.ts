import * as THREE from 'three';
import type { StageDef } from './Stages';
import { PAL } from '../render/Palette';
import { toonMat, glowMat } from '../render/Materials';
import { getTexture } from '../render/Textures';
import {
  createIslandPlatform, createCrate, createScrapPile, createPipeCluster, createGear,
  createAntenna, createWorkbench, createConveyorSegment, createBarrel,
  createTree, createBush, createFlowerPatch, createVinePost, createWindmill, createFountain,
  createTeslaCoil, createTurbine, createPylon, createCapacitorBank, createStormPipe,
  createPortal, createBoostPad, createHazardFan, createSteamVent, createEnergyBarrier,
  createDistantIsland,
} from '../render/models/Props';
import { makeRandom, randRange, randInt, clamp } from '../core/Util';

/**
 * Builds one playable island: the ground, the decorative set dressing, the
 * static hazards, and a *layout* describing where everything gameplay-related
 * should spawn.
 *
 * Two ideas drive the generation:
 *  1. The arena is a disc with a magnetic fence at the rim. Nobody ever falls
 *     off. For a 7-year-old, "you died because you fell" is the least fun
 *     failure there is, so the boundary shoves you back with a nice hum instead.
 *  2. Bolts are laid out in *routes* — arcs, figure-eights and spirals — rather
 *     than sprinkled randomly. Following a route naturally carves a turn, and
 *     carving a turn at speed is the thing that feels best in this game, so the
 *     level design is constantly nudging the player into the fun.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface FanSpawn extends Vec2 { radius: number; speed: number; }
export interface VentSpawn extends Vec2 { period: number; offset: number; }
export interface BarrierSpawn extends Vec2 {
  angle: number; width: number; travel: number; speed: number; phase: number;
}
export interface PadSpawn extends Vec2 { angle: number; }
export interface Obstacle extends Vec2 { r: number; }

export interface StageLayout {
  radius: number;
  spawn: Vec2;
  portal: Vec2;
  bolts: Array<Vec2 & { y: number }>;
  cells: Vec2[];
  pods: Vec2[];
  crates: Vec2[];
  fans: FanSpawn[];
  vents: VentSpawn[];
  barriers: BarrierSpawn[];
  pads: PadSpawn[];
  obstacles: Obstacle[];
}

interface Spinner {
  obj: THREE.Object3D;
  speed: number;
  axis: 'y' | 'x' | 'z';
}

export class Arena {
  readonly root = new THREE.Group();
  readonly layout: StageLayout;
  private spinners: Spinner[] = [];
  private fence!: THREE.Mesh;
  private fenceMat!: THREE.ShaderMaterial;
  private ambientProps: THREE.Object3D[] = [];
  private time = 0;

  constructor(stage: StageDef, seed: number) {
    const rng = makeRandom(seed);
    const R = stage.radius;
    this.layout = {
      radius: R,
      spawn: { x: 0, z: R * 0.55 },
      portal: { x: 0, z: -R * 0.7 },
      bolts: [],
      cells: [],
      pods: [],
      crates: [],
      fans: [],
      vents: [],
      barriers: [],
      pads: [],
      obstacles: [],
    };

    this.buildGround(stage, rng);
    this.buildFence(stage);
    this.placeDecor(stage, rng);
    this.placeHazards(stage, rng);
    this.placeGameplay(stage, rng);
  }

  // --- ground --------------------------------------------------------------

  private buildGround(stage: StageDef, rng: () => number): void {
    const island = createIslandPlatform({
      radius: stage.radius + 3.5,
      theme: stage.area,
      seed: Math.floor(rng() * 1e6),
      shape: stage.area === 'gardens' ? 'blob' : 'round',
    });
    island.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.receiveShadow = true;
        m.castShadow = false;
      }
    });
    this.root.add(island);

    // A ring of smaller satellite islands just outside the fence. Purely for
    // depth, but it's what makes the arena feel like a place instead of a disc.
    const satellites = 5 + Math.floor(rng() * 3);
    for (let i = 0; i < satellites; i++) {
      const a = (i / satellites) * Math.PI * 2 + rng() * 0.5;
      const dist = stage.radius + 12 + rng() * 16;
      const sat = createDistantIsland(Math.floor(rng() * 1e6), stage.area);
      sat.position.set(Math.cos(a) * dist, -4 - rng() * 8, Math.sin(a) * dist);
      sat.scale.setScalar(0.5 + rng() * 0.8);
      sat.rotation.y = rng() * 6.28;
      sat.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
      });
      sat.userData.baseY = sat.position.y;
      sat.userData.bob = rng() * 6.28;
      this.ambientProps.push(sat);
      this.root.add(sat);
    }
  }

  /**
   * The magnetic fence: a soft, obviously-friendly cylinder of light with a
   * scrolling hex pattern. It brightens as the player approaches so the
   * boundary announces itself *before* they hit it.
   */
  private buildFence(stage: StageDef): void {
    const geo = new THREE.CylinderGeometry(stage.radius + 0.6, stage.radius + 0.6, 5.5, 72, 1, true);
    this.fenceMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(PAL.energy) },
        uProximity: { value: 0 },
        uMap: { value: getTexture('gridGlow') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vY;
        void main() {
          vUv = uv;
          vY = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uProximity;
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying float vY;
        void main() {
          vec2 uv = vec2(vUv.x * 26.0, vUv.y * 2.0 - uTime * 0.16);
          float pattern = texture2D(uMap, uv).r;
          // Bright at the base, fading out toward the top so it never blocks
          // the player's view of the action.
          float vertical = pow(1.0 - vY, 2.2);
          float pulse = 0.55 + 0.45 * sin(uTime * 2.4 + vUv.x * 18.0);
          float a = vertical * (0.05 + pattern * 0.17 + uProximity * 0.55 * pulse);
          gl_FragColor = vec4(uColor * (0.7 + pattern * 0.9 + uProximity), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.fence = new THREE.Mesh(geo, this.fenceMat);
    this.fence.position.y = 2.75;
    this.fence.renderOrder = 6;
    this.root.add(this.fence);

    // A solid rim light on the floor so the edge is readable from above too.
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(stage.radius + 0.15, stage.radius + 0.75, 80),
      glowMat(PAL.energy, 0.3, true),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.03;
    rim.renderOrder = 5;
    this.root.add(rim);
  }

  // --- decoration ----------------------------------------------------------

  private placeDecor(stage: StageDef, rng: () => number): void {
    const R = stage.radius;
    const density = stage.decor;
    const makers: Array<() => THREE.Object3D> = [];

    if (stage.area === 'scrapyard') {
      makers.push(
        () => createScrapPile(),
        () => createPipeCluster(),
        () => createBarrel(),
        () => createWorkbench(),
        () => createAntenna(),
        () => createConveyorSegment(4 + rng() * 3),
        () => createGear(1.1 + rng() * 0.9, 10),
      );
    } else if (stage.area === 'gardens') {
      makers.push(
        () => createTree(Math.floor(rng() * 1e6)),
        () => createBush(Math.floor(rng() * 1e6)),
        () => createFlowerPatch(Math.floor(rng() * 1e6)),
        () => createVinePost(),
        () => createFountain(),
        () => createWindmill(),
      );
    } else if (stage.area === 'stormworks') {
      makers.push(
        () => createTeslaCoil(),
        () => createTurbine(),
        () => createPylon(),
        () => createCapacitorBank(),
        () => createStormPipe(),
      );
    } else {
      makers.push(
        () => createPylon(),
        () => createScrapPile(),
        () => createPipeCluster(),
        () => createCapacitorBank(),
      );
    }

    // Ring 1: chunky silhouette props hugging the rim. They frame the arena
    // and give the camera something to travel past.
    const rimCount = Math.round(14 * density);
    for (let i = 0; i < rimCount; i++) {
      const a = (i / rimCount) * Math.PI * 2 + randRange(rng, -0.14, 0.14);
      const d = R - randRange(rng, 0.6, 3.2);
      const obj = makers[randInt(rng, 0, makers.length - 1)]!();
      obj.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
      obj.rotation.y = rng() * 6.28;
      const s = randRange(rng, 0.85, 1.3);
      obj.scale.setScalar(s);
      this.registerProp(obj, s);
    }

    // Ring 2: sparser interior props. These are the ones that actually create
    // routes, so they're kept away from the centre and from each other.
    const innerCount = Math.round(9 * density);
    const placed: Obstacle[] = [];
    for (let i = 0; i < innerCount; i++) {
      let ok = false;
      for (let attempt = 0; attempt < 24 && !ok; attempt++) {
        const a = rng() * Math.PI * 2;
        const d = randRange(rng, R * 0.28, R * 0.78);
        const x = Math.cos(a) * d;
        const z = Math.sin(a) * d;
        if (Math.hypot(x - this.layout.spawn.x, z - this.layout.spawn.z) < 7) continue;
        if (Math.hypot(x - this.layout.portal.x, z - this.layout.portal.z) < 7) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 7.5)) continue;
        const obj = makers[randInt(rng, 0, makers.length - 1)]!();
        obj.position.set(x, 0, z);
        obj.rotation.y = rng() * 6.28;
        const s = randRange(rng, 0.9, 1.35);
        obj.scale.setScalar(s);
        this.registerProp(obj, s);
        placed.push({ x, z, r: 1.5 * s });
        ok = true;
      }
    }
  }

  /** Adds a prop to the scene, records its collider, and hooks up any spinner. */
  private registerProp(obj: THREE.Object3D, scale: number): void {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
      if (o.userData.spinner) {
        this.spinners.push({
          obj: o,
          speed: (o.userData.spinSpeed as number) ?? 1.4,
          axis: (o.userData.spinAxis as 'y' | 'x' | 'z') ?? 'y',
        });
      }
    });
    const collider = obj.userData.collider as number | undefined;
    if (collider && collider > 0) {
      this.layout.obstacles.push({
        x: obj.position.x,
        z: obj.position.z,
        r: collider * scale,
      });
    }
    this.root.add(obj);
  }

  // --- hazards -------------------------------------------------------------

  private placeHazards(stage: StageDef, rng: () => number): void {
    const R = stage.radius;
    const h = stage.hazards;

    for (let i = 0; i < (h.fans ?? 0); i++) {
      const p = this.findOpenSpot(rng, R * 0.3, R * 0.82, 6.5);
      if (!p) continue;
      const radius = randRange(rng, 1.9, 2.9);
      const fan = createHazardFan(radius);
      fan.position.set(p.x, 0, p.z);
      fan.rotation.y = rng() * 6.28;
      this.root.add(fan);
      const spinner = fan.userData.spinner as THREE.Object3D | undefined;
      if (spinner) {
        this.spinners.push({ obj: spinner, speed: randRange(rng, 2.4, 4.2) * (rng() < 0.5 ? -1 : 1), axis: 'y' });
      }
      fan.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = true;
      });
      this.layout.fans.push({ x: p.x, z: p.z, radius, speed: 1 });
    }

    for (let i = 0; i < (h.vents ?? 0); i++) {
      const p = this.findOpenSpot(rng, R * 0.22, R * 0.86, 5);
      if (!p) continue;
      const vent = createSteamVent();
      vent.position.set(p.x, 0, p.z);
      this.root.add(vent);
      this.layout.vents.push({
        x: p.x, z: p.z,
        period: randRange(rng, 2.6, 3.8),
        offset: rng() * 3.8,
      });
    }

    for (let i = 0; i < (h.barriers ?? 0); i++) {
      const p = this.findOpenSpot(rng, R * 0.25, R * 0.7, 9);
      if (!p) continue;
      const width = randRange(rng, 5, 8);
      const angle = rng() * Math.PI;
      const barrier = createEnergyBarrier(width, 3.2);
      barrier.position.set(p.x, 0, p.z);
      barrier.rotation.y = angle;
      this.root.add(barrier);
      this.layout.barriers.push({
        x: p.x, z: p.z, angle, width,
        travel: randRange(rng, 3.5, 6.5),
        speed: randRange(rng, 0.5, 0.85),
        phase: rng() * 6.28,
      });
      barrier.userData.layoutIndex = this.layout.barriers.length - 1;
      this.barrierObjects.push(barrier);
    }

    for (let i = 0; i < (h.boostPads ?? 0); i++) {
      const p = this.findOpenSpot(rng, R * 0.2, R * 0.85, 6);
      if (!p) continue;
      // Point pads roughly tangentially so they fling the player around the
      // arena rather than straight into the fence.
      const tangent = Math.atan2(p.x, -p.z) + (rng() < 0.5 ? 0 : Math.PI);
      const angle = tangent + randRange(rng, -0.5, 0.5);
      const pad = createBoostPad();
      pad.position.set(p.x, 0.02, p.z);
      pad.rotation.y = angle;
      this.root.add(pad);
      this.layout.pads.push({ x: p.x, z: p.z, angle });
    }
  }

  private barrierObjects: THREE.Object3D[] = [];

  // --- gameplay placement --------------------------------------------------

  private placeGameplay(stage: StageDef, rng: () => number): void {
    const R = stage.radius;

    for (let i = 0; i < stage.sparkies; i++) {
      const p = this.findOpenSpot(rng, R * 0.32, R * 0.88, 7.5);
      if (p) this.layout.pods.push(p);
    }
    for (let i = 0; i < stage.cells; i++) {
      const p = this.findOpenSpot(rng, R * 0.3, R * 0.8, 7);
      if (p) this.layout.cells.push(p);
    }
    for (let i = 0; i < stage.crates; i++) {
      const p = this.findOpenSpot(rng, R * 0.18, R * 0.9, 3.2);
      if (p) this.layout.crates.push(p);
    }
    this.buildBoltRoutes(stage, rng);
  }

  /**
   * Bolt routes. Four shapes, chosen so following one always means carving:
   *   arc      — a long sweep around the arena
   *   figure8  — two opposing curves, forces a direction change
   *   spiral   — pulls the player from the rim to the centre
   *   spray    — a short burst around a prop or hazard, the "risky" bonus
   */
  private buildBoltRoutes(stage: StageDef, rng: () => number): void {
    const R = stage.radius;
    const push = (x: number, z: number, y = 0.85): void => {
      if (Math.hypot(x, z) > R - 1.4) return;
      for (const o of this.layout.obstacles) {
        if (Math.hypot(o.x - x, o.z - z) < o.r + 0.7) return;
      }
      this.layout.bolts.push({ x, z, y });
    };

    for (let route = 0; route < stage.boltRoutes; route++) {
      const kind = route % 4;
      if (kind === 0) {
        const r = randRange(rng, R * 0.3, R * 0.85);
        const a0 = rng() * 6.28;
        const span = randRange(rng, 1.3, 2.6) * (rng() < 0.5 ? -1 : 1);
        const n = Math.round(Math.abs(span) * r * 0.42);
        for (let i = 0; i < n; i++) {
          const a = a0 + (i / Math.max(1, n - 1)) * span;
          push(Math.cos(a) * r, Math.sin(a) * r);
        }
      } else if (kind === 1) {
        const cx = randRange(rng, -R * 0.4, R * 0.4);
        const cz = randRange(rng, -R * 0.4, R * 0.4);
        const s = randRange(rng, 4.5, 7.5);
        const rot = rng() * 6.28;
        const n = 22;
        for (let i = 0; i < n; i++) {
          const t = (i / n) * Math.PI * 2;
          const lx = Math.sin(t) * s;
          const lz = Math.sin(t * 2) * s * 0.6;
          push(cx + lx * Math.cos(rot) - lz * Math.sin(rot), cz + lx * Math.sin(rot) + lz * Math.cos(rot));
        }
      } else if (kind === 2) {
        const a0 = rng() * 6.28;
        const turns = randRange(rng, 1.1, 1.8);
        const n = 24;
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          const r = (R * 0.86) * (1 - t * 0.78);
          const a = a0 + t * turns * Math.PI * 2;
          push(Math.cos(a) * r, Math.sin(a) * r);
        }
      } else {
        // Risky spray: right on top of a hazard, worth grabbing at speed.
        const near = this.layout.fans[randInt(rng, 0, Math.max(0, this.layout.fans.length - 1))]
          ?? this.layout.vents[randInt(rng, 0, Math.max(0, this.layout.vents.length - 1))];
        const cx = near ? near.x : randRange(rng, -R * 0.5, R * 0.5);
        const cz = near ? near.z : randRange(rng, -R * 0.5, R * 0.5);
        const ring = randRange(rng, 3.2, 4.6);
        const n = 10;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          push(cx + Math.cos(a) * ring, cz + Math.sin(a) * ring);
        }
      }
    }

    // A guaranteed welcome-trail from the spawn point toward the arena centre,
    // so the very first thing a new player sees is a line of shiny things.
    const sp = this.layout.spawn;
    for (let i = 1; i <= 9; i++) {
      const t = i / 9;
      push(sp.x * (1 - t) + 0, sp.z * (1 - t * 1.1));
    }
  }

  private findOpenSpot(
    rng: () => number,
    minR: number,
    maxR: number,
    clearance: number,
  ): Vec2 | null {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = rng() * Math.PI * 2;
      const d = randRange(rng, minR, maxR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (Math.hypot(x - this.layout.spawn.x, z - this.layout.spawn.z) < 6) continue;
      let clear = true;
      for (const o of this.layout.obstacles) {
        if (Math.hypot(o.x - x, o.z - z) < o.r + clearance * 0.55) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const list of [this.layout.pods, this.layout.cells, this.layout.fans, this.layout.vents, this.layout.pads]) {
        for (const p of list as Vec2[]) {
          if (Math.hypot(p.x - x, p.z - z) < clearance) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
      }
      if (clear) return { x, z };
    }
    return null;
  }

  // --- runtime -------------------------------------------------------------

  addPortal(area: StageDef['area']): THREE.Object3D {
    const portal = createPortal(area);
    portal.position.set(this.layout.portal.x, 0, this.layout.portal.z);
    portal.lookAt(0, 1.5, 0);
    portal.rotation.x = 0;
    portal.rotation.z = 0;
    this.root.add(portal);
    return portal;
  }

  addCrateMesh(x: number, z: number): THREE.Object3D {
    const crate = createCrate(1);
    crate.position.set(x, 0, z);
    crate.rotation.y = Math.random() * 6.28;
    crate.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.root.add(crate);
    return crate;
  }

  /** Distance-based fence glow + all the ambient prop motion. */
  update(dt: number, playerX: number, playerZ: number): void {
    this.time += dt;
    this.fenceMat.uniforms.uTime!.value = this.time;
    const d = Math.hypot(playerX, playerZ);
    const prox = clamp((d - (this.layout.radius - 7)) / 7, 0, 1);
    this.fenceMat.uniforms.uProximity!.value = prox * prox;

    for (const s of this.spinners) {
      if (s.axis === 'y') s.obj.rotation.y += s.speed * dt;
      else if (s.axis === 'x') s.obj.rotation.x += s.speed * dt;
      else s.obj.rotation.z += s.speed * dt;
    }

    for (const p of this.ambientProps) {
      p.position.y = (p.userData.baseY as number) + Math.sin(this.time * 0.4 + (p.userData.bob as number)) * 0.7;
      p.rotation.y += dt * 0.06;
    }

    // Moving energy barriers slide back and forth along their own axis.
    for (const obj of this.barrierObjects) {
      const idx = obj.userData.layoutIndex as number;
      const def = this.layout.barriers[idx];
      if (!def) continue;
      const offset = Math.sin(this.time * def.speed + def.phase) * def.travel;
      obj.position.x = def.x + Math.cos(def.angle + Math.PI / 2) * offset;
      obj.position.z = def.z + Math.sin(def.angle + Math.PI / 2) * offset;
      const field = obj.userData.field as THREE.Mesh | undefined;
      if (field) {
        const mat = field.material as THREE.Material & { opacity?: number; map?: THREE.Texture };
        if (mat.map) mat.map.offset.y = -this.time * 0.6;
        if (mat.opacity !== undefined) mat.opacity = 0.45 + Math.sin(this.time * 5 + def.phase) * 0.12;
      }
    }
  }

  /** Current world position of a moving barrier (for collision). */
  barrierPosition(index: number, out: { x: number; z: number }): void {
    const def = this.layout.barriers[index];
    if (!def) return;
    const offset = Math.sin(this.time * def.speed + def.phase) * def.travel;
    out.x = def.x + Math.cos(def.angle + Math.PI / 2) * offset;
    out.z = def.z + Math.sin(def.angle + Math.PI / 2) * offset;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose?.();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat && (mat as THREE.Material & { __shared?: boolean }).__shared !== true) {
          // Shared cached materials are owned by Materials.ts; only dispose
          // one-offs like the fence shader.
        }
      }
    });
    this.fenceMat.dispose();
    this.fence.geometry.dispose();
  }
}

export { toonMat };
