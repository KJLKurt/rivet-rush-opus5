/**
 * Rivet Rush — SWARM MODE: the player's deployable gadgets and the repair pad.
 *
 * In Swarm mode the rescued Sparkies huddle on a repair pad in the middle of the
 * arena and the player spends bolts to bolt together defences around them. These
 * are the *player's* things, so they follow a strict colour language that keeps
 * them separable from the violet/magenta drones at a glance:
 *
 *  - warm gold (`PAL.boardTop`, `PAL.bolt`) + cyan (`PAL.energy`, `PAL.cell`)
 *    on light metal (`PAL.metalLight`, `PAL.metalMid`),
 *  - chunky rounded silhouettes with visible rivets and deliberately mismatched
 *    plating — Rivet welded these together out of scrap in his workshop,
 *  - every gadget carries at least one emissive "powered" detail, so a placed
 *    gadget is still obvious on a screen full of enemies and particles.
 *
 * The rules from the prop kit all still apply: origin on the ground at y = 0,
 * 1 unit ≈ 1 metre, static sub-parts merged per material with `PartSet`,
 * geometry and materials from the shared caches, no allocation inside `update`.
 *
 * State never depends on colour alone. A hurt gadget smokes, sags and (for the
 * wall) sheds slats; a hurt pad cracks, tilts and smokes as well as shifting its
 * rim from cyan through amber to red.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAL } from '../Palette';
import { getTexture, getTextureTiled } from '../Textures';
import { toonMat, glowMat, roundedBoxGeometry, cacheGeometry } from '../Materials';
import { clamp, clamp01, lerp, easeOutBack, angleDelta } from '../../core/Util';

// ---------------------------------------------------------------------------
// public shape
// ---------------------------------------------------------------------------

export type DeployableKind = 'turret' | 'bomb' | 'wall' | 'shocker' | 'beacon';

export interface DeployableModel {
  root: THREE.Group;
  /**
   *  t         — total elapsed seconds
   *  dt        — delta seconds
   *  health01  — 1 = pristine, 0 = destroyed (drives damage smoke/sag)
   *  charge01  — 0..1 generic drive: turret reload, bomb fuse, shocker cooldown
   *  active    — true while it is doing its job this frame (firing, zapping)
   */
  update(t: number, dt: number, health01: number, charge01: number, active: boolean): void;
  /** Aim the turret / face the wall. Radians, world Y rotation. */
  setFacing(yaw: number): void;
  /** Brief white flash when it takes damage. */
  hit(): void;
  /** Plays the build-in pop; call once on placement. `p` goes 0 → 1. */
  setBuildProgress(p: number): void;
  dispose(): void;
}

/** The repair pad the rescued Sparkies gather on and the player defends. */
export interface RepairPadModel {
  root: THREE.Group;
  /** health01 drives the ring colour and the amount of damage smoke. */
  update(t: number, dt: number, health01: number, sparkieCount: number): void;
  hit(): void;
  dispose(): void;
}

type V3 = [number, number, number];

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

/** Effect radius each gadget covers, in metres. Drives the placement ghost. */
const EFFECT_RADIUS: Record<DeployableKind, number> = {
  turret: 6.5,
  bomb: 2.6,
  wall: 1.7,
  shocker: 3.4,
  beacon: 5.0,
};

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// cached geometry helpers  (same keys as the prop kit, so shapes are shared)
// ---------------------------------------------------------------------------

const k = (n: number): string => n.toFixed(3);

/** Chunky rounded box — the workhorse shape of the whole kit. */
function gBox(w: number, h: number, d: number, radius = 0.06, segments = 1): THREE.BufferGeometry {
  return roundedBoxGeometry(w, h, d, radius, segments);
}

function gCyl(rt: number, rb: number, h: number, seg = 12, open = false): THREE.BufferGeometry {
  return cacheGeometry(`cy|${k(rt)}|${k(rb)}|${k(h)}|${seg}|${open ? 1 : 0}`,
    () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
}

function gSph(radius: number, w = 10, h = 7): THREE.BufferGeometry {
  return cacheGeometry(`sp|${k(radius)}|${w}|${h}`, () => new THREE.SphereGeometry(radius, w, h));
}

function gTorus(radius: number, tube: number, rad = 6, tub = 14, arc = TAU): THREE.BufferGeometry {
  return cacheGeometry(`to|${k(radius)}|${k(tube)}|${rad}|${tub}|${k(arc)}`,
    () => new THREE.TorusGeometry(radius, tube, rad, tub, arc));
}

function gCone(radius: number, h: number, seg = 10): THREE.BufferGeometry {
  return cacheGeometry(`co|${k(radius)}|${k(h)}|${seg}`, () => new THREE.ConeGeometry(radius, h, seg));
}

/** Flat disc lying in the XZ plane, facing up — ground decals and auras. */
function gCircle(radius: number, seg = 24): THREE.BufferGeometry {
  return cacheGeometry(`ci|${k(radius)}|${seg}`, () => {
    const g = new THREE.CircleGeometry(radius, seg);
    g.rotateX(-HALF_PI);
    return g;
  });
}

/**
 * Flat annulus lying in the XZ plane, facing up.
 *
 * Ground rings are drawn with real geometry rather than a `ringSprite` disc:
 * the sprite's soft interior floods the whole circle once it is blended over a
 * bright surface, which turns an "effect radius" ring into a vague blob. A
 * hard-edged band stays a band on any background.
 */
function gRing(inner: number, outer: number, seg = 48): THREE.BufferGeometry {
  return cacheGeometry(`rg|${k(inner)}|${k(outer)}|${seg}`, () => {
    const g = new THREE.RingGeometry(inner, outer, seg);
    g.rotateX(-HALF_PI);
    return g;
  });
}

/** Upright quad facing +Z — energy fields and shimmer sheets. */
function gPlane(w: number, h: number): THREE.BufferGeometry {
  return cacheGeometry(`pl|${k(w)}|${k(h)}`, () => new THREE.PlaneGeometry(w, h));
}

/** Open-ended cone, apex at the top: the beacon's downward light shaft. */
function gLightCone(radius: number, h: number): THREE.BufferGeometry {
  return cacheGeometry(`lc|${k(radius)}|${k(h)}`,
    () => new THREE.ConeGeometry(radius, h, 18, 1, true));
}

// ---------------------------------------------------------------------------
// part merging  (the PartSet pattern from Props.ts)
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function prepare(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.clearGroups();
  return g;
}

/**
 * Collects transformed sub-geometries and merges them per material, so a static
 * gadget ends up as one mesh per material instead of a dozen Object3Ds.
 */
class PartSet {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos?: V3,
    rot?: V3,
    scale?: V3 | number,
  ): this {
    _p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
    _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
    _q.setFromEuler(_e);
    if (typeof scale === 'number') _s.setScalar(scale);
    else if (scale) _s.set(scale[0], scale[1], scale[2]);
    else _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);

    const g = prepare(geo).applyMatrix4(_m);
    const list = this.buckets.get(mat);
    if (list) list.push(g);
    else this.buckets.set(mat, [g]);
    return this;
  }

  /** Merges the collected parts and appends the resulting meshes to `target`. */
  into(target: THREE.Object3D, cast = true, receive = false): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, list] of this.buckets) {
      let geos = list;
      if (!geos.every((g) => g.index !== null)) {
        geos = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      }
      let merged: THREE.BufferGeometry | null = geos[0]!;
      if (geos.length > 1) merged = mergeGeometries(geos, false) as THREE.BufferGeometry | null;
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      target.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

function group(kind: string): THREE.Group {
  const g = new THREE.Group();
  g.name = kind;
  g.userData.propKind = kind;
  return g;
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

/** Untextured structural metal — used on small parts where a map would alias. */
function partMat(color: number, flat = false): THREE.Material {
  return toonMat(color, { ramp: 'hard3', flatShading: flat });
}

/**
 * A unique unlit glow material the caller may animate.
 *
 * `glowMat()` hands back a shared cache entry and a gadget must never mutate
 * one of those — a single blinking bomb would light up every glow in the world.
 * Anything whose opacity, colour or blending changes per frame gets one of
 * these instead, and the owner disposes it.
 */
function ownGlow(color: number, opacity = 1, additive = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: !additive,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// damage smoke
// ---------------------------------------------------------------------------

/** Fixed spread angles, so a plume looks scattered but rebuilds identically. */
const PLUME_ANGLE = [0.4, 2.3, 4.1, 1.2, 5.4, 3.2];

/**
 * A tiny looping smoke plume: `count` billboards that rise, swell and fade,
 * with the whole plume's density driven by damage. Every gadget and the pad
 * carries one, so "this thing is hurt" reads without relying on colour.
 *
 * Each puff owns its material (opacity is per-material) and the plume disposes
 * them; the smoke texture itself belongs to the shared texture cache.
 */
class Plume {
  readonly group = new THREE.Group();
  private puffs: THREE.Sprite[] = [];
  private mats: THREE.SpriteMaterial[] = [];
  private age: number[] = [];
  private count: number;
  private spread: number;
  private rise: number;
  private size: number;

  constructor(count: number, spread: number, rise: number, size: number, color = 0x8e96b4) {
    this.count = count;
    this.spread = spread;
    this.rise = rise;
    this.size = size;

    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: getTexture('smokeSprite'),
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true,
      });
      const puff = new THREE.Sprite(mat);
      puff.visible = false;
      this.group.add(puff);
      this.puffs.push(puff);
      this.mats.push(mat);
      // Stagger the phases so the plume is a continuous trickle, not a pulse.
      this.age.push(i / count);
    }
  }

  /** `density` 0 = healthy and silent, 1 = wrecked and pouring smoke. */
  update(dt: number, density: number): void {
    const d = clamp01(density);
    for (let i = 0; i < this.count; i++) {
      const puff = this.puffs[i]!;
      // Puffs switch on one at a time as the damage deepens.
      if (d <= i / this.count) {
        if (puff.visible) {
          puff.visible = false;
          this.mats[i]!.opacity = 0;
        }
        continue;
      }
      puff.visible = true;
      let a = this.age[i]! + dt * (0.45 + d * 0.55);
      if (a > 1) a -= 1;
      this.age[i] = a;

      const ang = PLUME_ANGLE[i % PLUME_ANGLE.length]!;
      const drift = this.spread * a;
      puff.position.set(Math.cos(ang) * drift, a * this.rise, Math.sin(ang) * drift);
      const s = this.size * (0.35 + a * 0.95);
      puff.scale.set(s, s, 1);
      this.mats[i]!.opacity = Math.sin(a * Math.PI) * 0.55 * d;
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// the shared gadget chassis
// ---------------------------------------------------------------------------

interface RigOptions {
  /** How far the damage smoke drifts sideways as it rises. */
  smokeSpread?: number;
  smokeRise?: number;
  smokeSize?: number;
  /** How far the gadget leans over when it is nearly destroyed, in radians. */
  sag?: number;
  /** Radius of the ground shockwave played during the build-in pop. */
  ringRadius?: number;
}

/**
 * Everything the five gadgets have in common: the build-in pop, the white
 * damage flash, the smoke and sag of a hurt gadget, and the smoothed facing
 * angle. Each builder makes one, hangs its parts off `rig.body`, and calls
 * `rig.frame(dt, health01)` at the top of its `update`.
 *
 * `body` is what the pop scales, so a gadget's own animation is free to move
 * anything inside it without fighting the build-in.
 */
class Rig {
  readonly root: THREE.Group;
  /** Every visible part hangs off here; the build-in pop scales it. */
  readonly body = new THREE.Group();

  private plume: Plume;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private flashers: THREE.MeshToonMaterial[] = [];
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;

  private flash = 0;
  private buildP = 1;
  private sag: number;
  private yawTarget = 0;
  private yawNow = 0;
  private yawInit = false;

  constructor(kind: DeployableKind, opts: RigOptions = {}) {
    this.root = group(kind);
    this.root.add(this.body);
    this.sag = opts.sag ?? 0.09;

    this.plume = new Plume(4, opts.smokeSpread ?? 0.25, opts.smokeRise ?? 0.8, opts.smokeSize ?? 0.55);
    this.body.add(this.plume.group);

    // The build-in shockwave: a ground ring that flares out as the gadget pops
    // into place, so a new gadget announces itself even off to the side.
    this.ringMat = ownGlow(PAL.energy, 0, true);
    this.mats.push(this.ringMat);
    const rr = opts.ringRadius ?? 0.8;
    this.ring = new THREE.Mesh(gRing(rr * 0.66, rr, 28), this.ringMat);
    this.ring.position.y = 0.03;
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  /**
   * A unique toon material that flashes white on `hit()`. Small unimportant
   * details should use the shared `partMat()` instead — two or three flashing
   * materials per gadget is plenty to sell the impact.
   */
  shell(color: number, map?: THREE.Texture): THREE.MeshToonMaterial {
    const m = toonMat(color, {
      ramp: 'hard3',
      map,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      unique: true,
    });
    this.flashers.push(m);
    this.mats.push(m);
    return m;
  }

  /** Takes ownership of an animated material so `dispose()` frees it. */
  own<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  /** Merges `parts` into `target`, keeping the merged geometry for disposal. */
  addParts(parts: PartSet, target: THREE.Object3D, cast = true, receive = false): void {
    for (const mesh of parts.into(target, cast, receive)) this.geos.push(mesh.geometry);
  }

  setFacing(yaw: number): void {
    this.yawTarget = yaw;
    // The first call places the gadget rather than animating it into place.
    if (!this.yawInit) {
      this.yawNow = yaw;
      this.yawInit = true;
    }
  }

  /** Frame-rate independent turn toward the requested facing. */
  stepYaw(dt: number, rate: number): number {
    this.yawNow += angleDelta(this.yawNow, this.yawTarget) * (1 - Math.exp(-rate * dt));
    return this.yawNow;
  }

  hit(): void {
    this.flash = 1;
  }

  setBuildProgress(p: number): void {
    this.buildP = clamp01(p);
    this.applyScale();
    const k2 = Math.sin(this.buildP * Math.PI);
    this.ringMat.opacity = k2 * 0.85;
    // Collapsed rather than merely hidden once the pop is over, so a finished
    // gadget's bounding box is its own size and not the shockwave's.
    const s = k2 > 0.01 ? 0.35 + this.buildP * 1.4 : 0.001;
    this.ring.scale.set(s, s, s);
    this.ring.visible = k2 > 0.01;
  }

  /** Call first thing in `update`: decays the flash, smokes, sags. */
  frame(dt: number, health01: number): void {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 4.5);
      this.applyScale();
    }
    const em = this.flash * this.flash;
    for (const m of this.flashers) m.emissiveIntensity = em;

    const damage = 1 - clamp01(health01);
    // Smoke only once it is genuinely hurt, then thickens fast.
    this.plume.update(dt, damage * 1.35 - 0.2);
    // …and it leans over as it goes, so damage reads in silhouette too.
    this.body.rotation.z = damage * damage * this.sag;
  }

  dispose(): void {
    this.plume.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
    this.flashers.length = 0;
  }

  /** Build-in pop plus a quick squash on every hit. */
  private applyScale(): void {
    const e = easeOutBack(this.buildP);
    const s = e * (1 + this.flash * 0.07);
    this.body.scale.set(s, s * (1 - this.flash * 0.13), s);
    this.body.visible = this.buildP > 0.02;
  }
}

// ---------------------------------------------------------------------------
// TURRET  — ~0.95 u across, ~1.1 u tall
// ---------------------------------------------------------------------------

/**
 * A squat bolted plinth with a turntable head carrying twin stubby barrels, a
 * sweeping radar fin and a whip antenna zip-tied to the back of the base.
 *
 * Animation: the head damps toward `setFacing`, the fin sweeps (faster while
 * shooting), and while `active` the barrels recoil *alternately* — one kicks
 * back 9 cm and pops a muzzle glow while the other resets, which reads as a
 * chattering twin gun far better than both firing together. `charge01` fills a
 * ring of eight LEDs around the collar: a count of lit lamps is readable from
 * any angle including straight down, and it is a shape change, not a tint.
 */
function createTurret(): DeployableModel {
  const rig = new Rig('turret', { smokeSpread: 0.26, smokeRise: 0.85, smokeSize: 0.5, ringRadius: 0.85 });
  const body = rig.body;

  const shell = rig.shell(PAL.metalLight, getTextureTiled('metalPanel', 1, 1));
  const gold = rig.shell(PAL.boardTop);
  const dark = partMat(PAL.metalDark);
  const boltM = partMat(PAL.bolt);

  // --- base: a square footplate under a hex plinth (mismatched on purpose) --
  const base = new PartSet();
  base.add(gBox(0.9, 0.1, 0.9, 0.04, 1), dark, [0, 0.05, 0]);
  base.add(gCyl(0.4, 0.48, 0.22, 8), shell, [0, 0.21, 0]);
  base.add(gTorus(0.4, 0.05, 5, 14), gold, [0, 0.31, 0], [HALF_PI, 0, 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI * 0.25;
    base.add(gSph(0.055, 6, 5), boltM, [Math.cos(a) * 0.37, 0.11, Math.sin(a) * 0.37]);
  }
  // The whip antenna: pure hand-made charm, and a tall thin cue at distance.
  base.add(gCyl(0.012, 0.024, 0.8, 4), dark, [-0.3, 0.68, -0.28], [0.22, 0, 0.18]);
  rig.addParts(base, body, true, true);
  const whipTip = new THREE.Mesh(gSph(0.038, 6, 5), glowMat(PAL.cell, 0.9, true));
  whipTip.position.set(-0.372, 1.06, -0.194);
  body.add(whipTip);

  // --- reload lamps: eight around the collar, lit count = charge -----------
  const LEDS = 8;
  const ledOn = glowMat(PAL.cell, 0.95, true);
  const ledOff = glowMat(PAL.metalMid, 0.28, false);
  const leds: THREE.Mesh[] = [];
  for (let i = 0; i < LEDS; i++) {
    const a = (i / LEDS) * TAU;
    const led = new THREE.Mesh(gBox(0.075, 0.055, 0.075, 0.022, 1), ledOff);
    led.position.set(Math.cos(a) * 0.44, 0.3, Math.sin(a) * 0.44);
    led.rotation.y = -a;
    body.add(led);
    leds.push(led);
  }

  // --- head ----------------------------------------------------------------
  const head = new THREE.Group();
  head.position.y = 0.5;
  body.add(head);

  const hp = new PartSet();
  hp.add(gCyl(0.22, 0.3, 0.2, 10), shell, [0, -0.14, 0]);            // turntable neck
  hp.add(gBox(0.46, 0.36, 0.44, 0.13, 2), gold, [0, 0.02, 0]);       // head shell
  hp.add(gBox(0.54, 0.14, 0.28, 0.05, 1), shell, [0, -0.08, -0.02]); // shoulder band
  hp.add(gBox(0.13, 0.26, 0.22, 0.05, 1), shell, [-0.27, 0.03, -0.03]); // salvaged plate…
  hp.add(gBox(0.1, 0.2, 0.26, 0.04, 1), dark, [0.27, 0.0, -0.02]);      // …and a different one
  hp.add(gSph(0.045, 6, 5), boltM, [-0.27, 0.15, 0.04]);
  hp.add(gSph(0.045, 6, 5), boltM, [0.27, 0.11, 0.05]);
  hp.add(gCyl(0.045, 0.05, 0.2, 6), dark, [0, 0.3, -0.06]);          // fin post
  rig.addParts(hp, head, true, false);

  // The one big emissive detail: a cyan lens staring down the barrels.
  const lens = new THREE.Mesh(gCyl(0.075, 0.075, 0.04, 12), glowMat(PAL.cell, 0.95, true));
  lens.position.set(0, 0.06, 0.22);
  lens.rotation.x = HALF_PI;
  head.add(lens);

  // --- twin barrels --------------------------------------------------------
  const barrels: THREE.Group[] = [];
  const muzzles: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const b = new THREE.Group();
    b.position.set(sx * 0.14, 0.0, 0.18);
    head.add(b);
    const bp = new PartSet();
    bp.add(gCyl(0.06, 0.075, 0.38, 8), shell, [0, 0, 0.19], [HALF_PI, 0, 0]);
    bp.add(gTorus(0.075, 0.026, 4, 10), gold, [0, 0, 0.36]);
    rig.addParts(bp, b, true, false);

    const mz = new THREE.Mesh(gSph(0.09, 8, 6), glowMat(PAL.boltHot, 0.95, true));
    mz.position.z = 0.4;
    mz.scale.setScalar(0);
    b.add(mz);
    barrels.push(b);
    muzzles.push(mz);
  }

  // --- radar fin -----------------------------------------------------------
  const fin = new THREE.Group();
  fin.position.set(0, 0.42, -0.06);
  head.add(fin);
  const fp = new PartSet();
  fp.add(gBox(0.32, 0.022, 0.12, 0.01, 1), shell, [0.08, 0, 0]);
  fp.add(gBox(0.08, 0.02, 0.1, 0.01, 1), gold, [-0.11, 0, 0]);
  rig.addParts(fp, fin, true, false);
  const finTip = new THREE.Mesh(gSph(0.04, 6, 5), glowMat(PAL.energy, 0.9, true));
  finTip.position.set(0.23, 0.01, 0);
  fin.add(finTip);

  let firePhase = 0;

  const model: DeployableModel = {
    root: rig.root,

    update(t, dt, health01, charge01, active) {
      rig.frame(dt, health01);
      head.rotation.y = rig.stepYaw(dt, 9);
      head.position.y = 0.5 + Math.sin(t * 2.2) * 0.006;
      fin.rotation.y += dt * (active ? 5.5 : 1.7);

      // Alternate recoil: one barrel punches back per shot, 6.5 shots a second.
      if (active) firePhase += dt * 6.5;
      const shot = firePhase - Math.floor(firePhase);
      const which = Math.floor(firePhase) & 1;
      const kick = active ? Math.max(0, 1 - shot * 3.2) : 0;
      for (let i = 0; i < 2; i++) {
        const k2 = which === i ? kick : 0;
        barrels[i]!.position.z = 0.18 - k2 * 0.09;
        muzzles[i]!.scale.setScalar(k2 * 1.2);
      }

      // Reload lamps. A full ring breathes gently so "ready" is unmistakable.
      const lit = clamp01(charge01) * LEDS;
      const ready = charge01 >= 0.999;
      for (let i = 0; i < LEDS; i++) {
        const on = i < lit;
        const led = leds[i]!;
        led.material = on ? ledOn : ledOff;
        led.scale.setScalar(on ? 1.1 + Math.sin(t * (ready ? 6 : 9) + i * 0.8) * 0.12 : 0.55);
      }
      lens.scale.setScalar(ready ? 1.05 + Math.sin(t * 5) * 0.08 : 0.85);
      whipTip.scale.setScalar(0.8 + Math.sin(t * 3.1) * 0.2);
    },

    setFacing(yaw) {
      rig.setFacing(yaw);
    },
    hit() {
      rig.hit();
    },
    setBuildProgress(p) {
      rig.setBuildProgress(p);
    },
    dispose() {
      rig.dispose();
    },
  };

  model.setBuildProgress(1);
  return model;
}

// ---------------------------------------------------------------------------
// BOMB  — ~0.78 u across the legs, ~0.75 u tall
// ---------------------------------------------------------------------------

/**
 * A chunky round proximity mine: a squashed gold ball on three fold-out legs,
 * with a screw-in lightbulb on top and two little cyan eyes on the front. It is
 * deliberately closer to a bath toy than a landmine — this is a *friendly*
 * gadget that happens to go bang.
 *
 * Animation: `setBuildProgress` unfolds the legs from tucked to splayed as it
 * drops into place. The bulb blinks, and `charge01` (the fuse) drives the blink
 * rate from a lazy ~1 Hz up to a frantic ~13 Hz while the whole hull squashes
 * and stretches faster and faster — audible-looking panic, no colour change
 * needed.
 */
function createBomb(): DeployableModel {
  const rig = new Rig('bomb', { smokeSpread: 0.18, smokeRise: 0.55, smokeSize: 0.4, sag: 0.05, ringRadius: 0.65 });
  const body = rig.body;

  const gold = rig.shell(PAL.boardTop);
  const light = rig.shell(PAL.metalLight);
  const dark = partMat(PAL.metalDark);
  const boltM = partMat(PAL.bolt);

  // `hull` is squashed by the fuse animation; the legs stay put outside it.
  const hull = new THREE.Group();
  hull.position.y = 0.31;
  body.add(hull);

  const hp = new PartSet();
  hp.add(gSph(0.27, 12, 9), gold, [0, 0, 0], undefined, [1, 0.9, 1]);
  hp.add(gTorus(0.27, 0.05, 5, 16), light, [0, 0.0, 0], [HALF_PI, 0, 0]);
  hp.add(gCyl(0.2, 0.24, 0.06, 10), light, [0, -0.22, 0]);            // belly plate
  hp.add(gCyl(0.11, 0.14, 0.09, 8), light, [0, 0.26, 0]);             // bulb collar
  hp.add(gTorus(0.115, 0.018, 4, 10), boltM, [0, 0.28, 0], [HALF_PI, 0, 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    hp.add(gSph(0.05, 6, 5), boltM, [Math.cos(a) * 0.27, 0.02, Math.sin(a) * 0.27]);
  }
  rig.addParts(hp, hull, true, false);

  // Two eyes: the single cheapest thing that makes a round object friendly.
  const eyeMat = glowMat(PAL.cell, 0.95, true);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(gSph(0.05, 8, 6), eyeMat);
    eye.position.set(sx * 0.1, 0.05, 0.24);
    eye.scale.set(1, 1, 0.6);
    hull.add(eye);
  }

  // --- the bulb ------------------------------------------------------------
  const bulbMat = rig.own(ownGlow(PAL.bolt, 1, true));
  const bulb = new THREE.Mesh(gSph(0.09, 10, 8), bulbMat);
  bulb.position.y = 0.38;
  hull.add(bulb);
  const filament = new THREE.Mesh(gCyl(0.014, 0.014, 0.08, 4), glowMat(PAL.white, 0.9, true));
  filament.position.y = 0.38;
  hull.add(filament);

  // A billboard halo around the bulb so the blink survives a bright sky, plus
  // a pool of light on the ground that swells as the fuse gets hot.
  const haloMat = rig.own(new THREE.SpriteMaterial({
    map: getTexture('glowSprite'),
    color: PAL.bolt,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  }));
  const halo = new THREE.Sprite(haloMat);
  halo.position.y = 0.69;
  halo.scale.setScalar(0.6);
  body.add(halo);

  const poolMat = rig.own(ownGlow(PAL.bolt, 0, true));
  const pool = new THREE.Mesh(gCircle(0.45, 16), poolMat);
  pool.position.y = 0.02;
  body.add(pool);

  // --- fold-out legs -------------------------------------------------------
  const LEG_SPLAY = 0.62;
  const legs: THREE.Group[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * 0.2, 0.3, Math.sin(a) * 0.2);
    pivot.rotation.y = -a;   // local +X now points radially outward
    body.add(pivot);
    const lp = new PartSet();
    lp.add(gCyl(0.032, 0.045, 0.3, 5), dark, [0, -0.15, 0]);
    lp.add(gSph(0.06, 7, 5), light, [0, -0.3, 0], undefined, [1.2, 0.7, 1.2]);
    rig.addParts(lp, pivot, true, false);
    legs.push(pivot);
  }

  let blink = 0;

  const model: DeployableModel = {
    root: rig.root,

    update(t, dt, health01, charge01, active) {
      rig.frame(dt, health01);
      body.rotation.y = rig.stepYaw(dt, 8);

      const fuse = clamp01(charge01);
      // Blink rate ramps with the fuse; arming (active) doubles it again.
      blink += dt * lerp(1.1, 13, fuse) * (active ? 2 : 1);
      if (blink > 1) blink -= 1;
      const on = blink < 0.42 ? 1 : 0;

      bulbMat.opacity = on ? 1 : 0.12;
      bulb.scale.setScalar(0.85 + on * 0.35);
      filament.scale.setScalar(on ? 1 : 0.4);
      haloMat.opacity = on * (0.3 + fuse * 0.55);
      halo.scale.setScalar(0.55 + fuse * 0.55 + on * 0.18);
      poolMat.opacity = on * fuse * 0.35;
      pool.scale.setScalar(0.8 + fuse * 0.5);

      // The hull tenses harder and faster as the fuse climbs.
      const tense = Math.sin(t * (4 + fuse * 26)) * 0.025 * (0.35 + fuse);
      hull.scale.set(1 + tense, 1 - tense, 1 + tense);
    },

    setFacing(yaw) {
      rig.setFacing(yaw);
    },
    hit() {
      rig.hit();
    },
    setBuildProgress(p) {
      rig.setBuildProgress(p);
      // Legs swing down and out over the second half of the drop.
      const spread = easeOutBack(clamp01((clamp01(p) - 0.35) / 0.65));
      for (const leg of legs) leg.rotation.z = lerp(0.02, LEG_SPLAY, spread);
    },
    dispose() {
      rig.dispose();
    },
  };

  model.setBuildProgress(1);
  return model;
}

// ---------------------------------------------------------------------------
// WALL  — ~2.66 u wide, ~1.65 u tall, ~0.7 u deep with the braces
// ---------------------------------------------------------------------------

/** How much health each slat survives to, top slat first. */
const SLAT_COUNT = 5;

/**
 * A deployable barricade: two braced posts with five stacked armour slats
 * between them, alternating gold and light metal so it reads as scavenged
 * plating rather than an extruded fence. A soft cyan shimmer sheet hangs
 * between the posts on both faces.
 *
 * This is the gadget whose damage state matters most, so the degradation is
 * the loudest part of the model: each slat has a health threshold, and as the
 * wall drops past it that slat rocks loose — it tilts, drops, twists out of the
 * plane and finally vanishes. The top slat goes first, so a battered wall is a
 * visibly *shorter* wall. The shimmer weakens and the posts' caps dim with it.
 */
function createWall(): DeployableModel {
  const rig = new Rig('wall', { smokeSpread: 0.45, smokeRise: 1.1, smokeSize: 0.75, sag: 0.06, ringRadius: 1.5 });
  const body = rig.body;

  const light = rig.shell(PAL.metalLight, getTextureTiled('metalPanel', 1, 2));
  const gold = rig.shell(PAL.boardTop);
  const dark = partMat(PAL.metalDark);
  const boltM = partMat(PAL.bolt);

  // --- posts, feet, braces and the capping rail ----------------------------
  const frame = new PartSet();
  for (const sx of [-1, 1]) {
    const x = sx * 1.2;
    frame.add(gBox(0.26, 1.5, 0.32, 0.08, 2), light, [x, 0.75, 0]);
    frame.add(gBox(0.48, 0.12, 0.72, 0.05, 1), dark, [x, 0.06, 0]);
    // One brace forward, one back — braced from both sides like real scaffold.
    frame.add(gBox(0.14, 0.95, 0.11, 0.05, 1), light, [x, 0.48, 0.3], [0.52, 0, 0]);
    frame.add(gBox(0.12, 0.8, 0.1, 0.04, 1), dark, [x, 0.42, -0.26], [-0.5, 0, 0]);
    for (const y of [0.22, 0.72, 1.24]) {
      frame.add(gSph(0.055, 6, 5), boltM, [x, y, 0.17]);
    }
  }
  frame.add(gBox(2.66, 0.14, 0.24, 0.06, 1), gold, [0, 1.56, 0]);
  rig.addParts(frame, body, true, true);

  // Post caps: the wall's "powered" tell, dimming as the wall is worn down.
  const capMat = rig.own(ownGlow(PAL.cell, 0.7, true));
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(gSph(0.09, 8, 6), capMat);
    cap.position.set(sx * 1.2, 1.63, 0);
    cap.scale.set(1, 0.7, 1);
    body.add(cap);
  }

  // --- armour slats --------------------------------------------------------
  const slatGeo = gBox(2.16, 0.24, 0.2, 0.06, 1);
  const slats: THREE.Mesh[] = [];
  const slatY: number[] = [];
  const slatThresh: number[] = [];
  const slatDir: number[] = [];
  for (let i = 0; i < SLAT_COUNT; i++) {
    const y = 0.24 + i * 0.29;
    const slat = new THREE.Mesh(slatGeo, i % 2 === 0 ? gold : light);
    slat.position.set(0, y, 0);
    slat.castShadow = true;
    slat.receiveShadow = true;
    body.add(slat);
    slats.push(slat);
    slatY.push(y);
    // Top slat (highest index) breaks first, at 85 % health.
    slatThresh.push(0.85 - (SLAT_COUNT - 1 - i) * 0.17);
    slatDir.push(i % 2 === 0 ? 1 : -1);
  }

  // --- energy shimmer, one sheet on each face ------------------------------
  const fieldMat = rig.own(new THREE.MeshBasicMaterial({
    map: getTextureTiled('gridGlow', 3, 2),
    color: PAL.energy,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  }));
  const fields: THREE.Mesh[] = [];
  for (const sz of [1, -1]) {
    const sheet = new THREE.Mesh(gPlane(2.2, 1.42), fieldMat);
    sheet.position.set(0, 0.78, sz * 0.13);
    body.add(sheet);
    fields.push(sheet);
  }

  const model: DeployableModel = {
    root: rig.root,

    update(t, dt, health01, charge01, active) {
      rig.frame(dt, health01);
      body.rotation.y = rig.stepYaw(dt, 14);

      const h = clamp01(health01);
      for (let i = 0; i < SLAT_COUNT; i++) {
        // 0 while the slat is intact, 1 once it has been fully knocked out.
        const wear = clamp01((slatThresh[i]! - h) / 0.24);
        const slat = slats[i]!;
        const d = slatDir[i]!;
        slat.visible = wear < 0.99;
        slat.rotation.z = wear * d * 0.42;
        slat.rotation.y = wear * d * 0.3;
        slat.position.y = slatY[i]! - wear * 0.14;
        slat.position.z = wear * d * 0.12;
        // A loose slat rattles until it finally drops off.
        if (wear > 0.05 && wear < 0.99) slat.rotation.x = Math.sin(t * 11 + i) * wear * 0.05;
      }

      // The field brightens as it recharges, flares on a hit, and thins out
      // along with the slats so a stripped wall looks stripped.
      const power = clamp01(charge01) * 0.5 + 0.3;
      const pulse = 0.75 + Math.sin(t * 3.1) * 0.25;
      fieldMat.opacity = power * pulse * (0.25 + h * 0.55) + (active ? 0.35 : 0);
      capMat.opacity = 0.2 + h * 0.5 + (active ? 0.25 : 0);
      for (const sheet of fields) sheet.scale.y = 0.35 + h * 0.65;
    },

    setFacing(yaw) {
      rig.setFacing(yaw);
    },
    hit() {
      rig.hit();
    },
    setBuildProgress(p) {
      rig.setBuildProgress(p);
    },
    dispose() {
      rig.dispose();
    },
  };

  model.setBuildProgress(1);
  return model;
}

// ---------------------------------------------------------------------------
// SHOCKER  — ~1.0 u across the rods, ~1.25 u tall
// ---------------------------------------------------------------------------

/**
 * A tesla-ish node: a copper-wound coil column on a hex base, a floating orb
 * hovering above the crown ring, and three grounding rods splayed out around
 * it with copper caps.
 *
 * Animation: the orb bobs and spins slowly, and its brightness is driven by
 * `charge01` while it recharges — dim and small when spent, fat and blazing
 * when ready. While `active` it flares and short arcs snap between the orb and
 * the rod caps, each arc flickering on its own rhythm so the discharge looks
 * chaotic rather than looped.
 */
function createShocker(): DeployableModel {
  const rig = new Rig('shocker', { smokeSpread: 0.24, smokeRise: 0.9, smokeSize: 0.5, ringRadius: 0.9 });
  const body = rig.body;

  const light = rig.shell(PAL.metalLight);
  const gold = rig.shell(PAL.bolt);
  const dark = partMat(PAL.metalDark);

  const ROD_R = 0.46;
  const ROD_TIP = 0.5;
  const ORB_Y = 1.0;

  // --- base, coil column, crown -------------------------------------------
  const parts = new PartSet();
  parts.add(gCyl(0.34, 0.42, 0.16, 8), light, [0, 0.08, 0]);
  parts.add(gTorus(0.34, 0.045, 5, 14), gold, [0, 0.17, 0], [HALF_PI, 0, 0]);
  parts.add(gCyl(0.09, 0.09, 0.62, 6), dark, [0, 0.48, 0]);
  // Ten thin torii read as wound copper for almost no triangles.
  for (let i = 0; i < 10; i++) {
    const y = 0.24 + (i / 10) * 0.5;
    parts.add(gTorus(0.16 - i * 0.004, 0.032, 4, 10), gold, [0, y, 0], [HALF_PI, 0, 0]);
  }
  parts.add(gCyl(0.12, 0.16, 0.09, 8), light, [0, 0.8, 0]);
  parts.add(gTorus(0.22, 0.055, 6, 16), light, [0, 0.86, 0], [HALF_PI, 0, 0]);
  // Grounding rods: splayed out, copper capped.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    parts.add(gCyl(0.045, 0.06, 0.52, 6), dark,
      [cx * ROD_R * 0.82, 0.26, cz * ROD_R * 0.82], [cz * 0.3, 0, -cx * 0.3]);
    parts.add(gSph(0.065, 7, 5), gold, [cx * ROD_R, ROD_TIP, cz * ROD_R]);
  }
  rig.addParts(parts, body, true, true);

  // --- the orb -------------------------------------------------------------
  const orbMat = rig.own(ownGlow(PAL.cell, 0.8, true));
  const orb = new THREE.Mesh(gSph(0.17, 12, 9), orbMat);
  orb.position.y = ORB_Y;
  body.add(orb);
  const orbCage = new THREE.Mesh(gTorus(0.21, 0.018, 4, 14), glowMat(PAL.cell, 0.7, true));
  orbCage.position.y = ORB_Y;
  orbCage.rotation.x = 0.7;
  body.add(orbCage);

  // --- arcs: one per rod, oriented once at build time ----------------------
  const arcMat = rig.own(ownGlow(PAL.white, 0, true));
  const arcs: THREE.Mesh[] = [];
  const from = new THREE.Vector3(0, ORB_Y, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const to = new THREE.Vector3(Math.cos(a) * ROD_R, ROD_TIP, Math.sin(a) * ROD_R);
    const dir = to.clone().sub(from);
    const len = dir.length();
    dir.normalize();
    // Thin at the rod, fat at the orb: the bolt looks like it is being thrown.
    const arc = new THREE.Mesh(gCyl(0.008, 0.032, len, 4), arcMat);
    arc.quaternion.setFromUnitVectors(UP, dir);
    arc.position.copy(from).addScaledVector(dir, len * 0.5);
    arc.visible = false;
    body.add(arc);
    arcs.push(arc);
  }

  const model: DeployableModel = {
    root: rig.root,

    update(t, dt, health01, charge01, active) {
      rig.frame(dt, health01);
      body.rotation.y = rig.stepYaw(dt, 6);

      const c = clamp01(charge01);
      orb.position.y = ORB_Y + Math.sin(t * 1.9) * 0.03;
      orb.rotation.y += dt * 1.4;
      orbCage.position.y = orb.position.y;
      orbCage.rotation.y += dt * 2.2;
      orbCage.rotation.z += dt * 1.1;

      // Recharging is written entirely in the orb: size and brightness.
      const power = lerp(0.22, 0.95, c) + (active ? 0.5 : 0);
      orbMat.opacity = clamp01(power * 0.85);
      orb.scale.setScalar(0.7 + c * 0.28 + (active ? 0.32 : 0) + Math.sin(t * 3.4) * 0.03);

      // Arc snap. Each arc has its own frequency so they never fire in step.
      arcMat.opacity = active ? 0.55 + Math.sin(t * 41) * 0.4 : 0;
      for (let i = 0; i < 3; i++) {
        const arc = arcs[i]!;
        const on = active && Math.sin(t * (37 + i * 13) + i * 2.1) > -0.2;
        arc.visible = on;
        if (on) arc.scale.set(0.55 + Math.sin(t * 61 + i) * 0.45, 1, 0.55 + Math.cos(t * 53 + i) * 0.45);
      }
    },

    setFacing(yaw) {
      rig.setFacing(yaw);
    },
    hit() {
      rig.hit();
    },
    setBuildProgress(p) {
      rig.setBuildProgress(p);
    },
    dispose() {
      rig.dispose();
    },
  };

  model.setBuildProgress(1);
  return model;
}

// ---------------------------------------------------------------------------
// BEACON  — ~0.55 u across the base, ~1.45 u tall
// ---------------------------------------------------------------------------

/**
 * A support pylon: a slim mast on a bolted three-finned foot, carrying a
 * hexagonal lantern head that turns slowly like a lighthouse, plus a soft
 * downward light cone that pools on the ground beneath it.
 *
 * `root.userData.aura` is a translucent additive disc of *unit* radius with a
 * bright rim ring parented to it — the game scales it to the effect radius and
 * both parts follow.
 *
 * Animation: the lantern turns at a lazy 0.55 rad/s; the bright lens on one
 * face is what makes the rotation legible. `charge01` and `active` push the
 * lantern, cone and aura brighter.
 */
function createBeacon(): DeployableModel {
  const rig = new Rig('beacon', { smokeSpread: 0.2, smokeRise: 1.0, smokeSize: 0.45, ringRadius: 0.7 });
  const body = rig.body;

  const light = rig.shell(PAL.metalLight);
  const gold = rig.shell(PAL.boardTop);
  const dark = partMat(PAL.metalDark);
  const boltM = partMat(PAL.bolt);

  const MAST_TOP = 1.02;

  // --- foot and mast -------------------------------------------------------
  const parts = new PartSet();
  parts.add(gBox(0.46, 0.1, 0.46, 0.04, 1), dark, [0, 0.05, 0]);
  parts.add(gCyl(0.16, 0.24, 0.16, 8), light, [0, 0.16, 0]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    parts.add(gBox(0.09, 0.2, 0.24, 0.04, 1), light,
      [Math.cos(a) * 0.2, 0.12, Math.sin(a) * 0.2], [0, -a, 0]);
    parts.add(gSph(0.045, 6, 5), boltM, [Math.cos(a) * 0.2, 0.23, Math.sin(a) * 0.2]);
  }
  parts.add(gCyl(0.052, 0.072, 0.86, 6), light, [0, 0.63, 0]);
  for (const y of [0.45, 0.8]) {
    parts.add(gTorus(0.07, 0.026, 4, 10), gold, [0, y, 0], [HALF_PI, 0, 0]);
  }
  // A short salvaged crossbar with a dangling cable clip — workshop charm.
  parts.add(gBox(0.3, 0.05, 0.05, 0.02, 1), dark, [0.08, 0.9, 0], [0, 0.4, 0.12]);
  rig.addParts(parts, body, true, true);

  // --- rotating lantern head ----------------------------------------------
  const lantern = new THREE.Group();
  lantern.position.y = MAST_TOP + 0.11;
  body.add(lantern);

  const lp = new PartSet();
  lp.add(gCyl(0.155, 0.155, 0.06, 6), gold, [0, -0.13, 0]);
  lp.add(gCyl(0.135, 0.135, 0.24, 6), light, [0, 0, 0]);
  lp.add(gCone(0.175, 0.14, 6), gold, [0, 0.19, 0]);
  lp.add(gSph(0.035, 6, 5), boltM, [0, 0.28, 0]);
  rig.addParts(lp, lantern, true, false);

  // The lamp core plus one bright lens on a single face: without the lens the
  // rotation is invisible and the head just looks like a glowing tube.
  const lampMat = rig.own(ownGlow(PAL.cell, 0.8, true));
  const lamp = new THREE.Mesh(gCyl(0.105, 0.105, 0.26, 8), lampMat);
  lantern.add(lamp);
  const lens = new THREE.Mesh(gBox(0.13, 0.16, 0.05, 0.02, 1), lampMat);
  lens.position.set(0, 0, 0.14);
  lantern.add(lens);

  // --- downward light cone -------------------------------------------------
  const coneMat = rig.own(ownGlow(PAL.energy, 0.14, true));
  const cone = new THREE.Mesh(gLightCone(0.85, MAST_TOP + 0.05), coneMat);
  cone.position.y = (MAST_TOP + 0.05) * 0.5;
  body.add(cone);

  // --- effect aura, unit radius, scaled by the game ------------------------
  const auraMat = rig.own(new THREE.MeshBasicMaterial({
    map: getTexture('glowSprite'),
    color: PAL.energyWarm,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  }));
  const aura = new THREE.Mesh(gCircle(1, 32), auraMat);
  aura.position.y = 0.02;
  rig.root.add(aura);

  const auraRimMat = rig.own(ownGlow(PAL.energy, 0.4, true));
  const auraRim = new THREE.Mesh(gRing(0.93, 1.0, 56), auraRimMat);
  auraRim.position.y = 0.012;   // child offset keeps it clear of the disc
  aura.add(auraRim);

  rig.root.userData.aura = aura;

  const model: DeployableModel = {
    root: rig.root,

    update(t, dt, health01, charge01, active) {
      rig.frame(dt, health01);
      body.rotation.y = rig.stepYaw(dt, 5);

      // A hurt beacon turns slower and dimmer — the support is failing.
      const h = clamp01(health01);
      lantern.rotation.y += dt * (0.55 + charge01 * 0.35) * (0.4 + h * 0.6);
      lantern.position.y = MAST_TOP + 0.11 + Math.sin(t * 1.6) * 0.008;

      const power = (0.45 + clamp01(charge01) * 0.4 + (active ? 0.3 : 0)) * (0.35 + h * 0.65);
      const pulse = 0.85 + Math.sin(t * 2.4) * 0.15;
      lampMat.opacity = clamp01(power * pulse + 0.15);
      lamp.scale.setScalar(0.95 + Math.sin(t * 2.4) * 0.05);
      coneMat.opacity = clamp01(power * 0.24 * pulse);
      auraMat.opacity = clamp01(0.1 + power * 0.16 + Math.sin(t * 1.7) * 0.03);
      auraRimMat.opacity = clamp01(0.22 + power * 0.35 + Math.sin(t * 1.7 + 1) * 0.06);
    },

    setFacing(yaw) {
      rig.setFacing(yaw);
    },
    hit() {
      rig.hit();
    },
    setBuildProgress(p) {
      rig.setBuildProgress(p);
      // The aura fades up with the build so it never snaps on at full size.
      aura.visible = p > 0.05;
    },
    dispose() {
      rig.dispose();
    },
  };

  model.setBuildProgress(1);
  return model;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Builds one of the five Swarm-mode gadgets. Every model puts its origin on the
 * ground at y = 0 and tags `root.userData.propKind` with its kind.
 */
export function createDeployable(kind: DeployableKind): DeployableModel {
  switch (kind) {
    case 'turret': return createTurret();
    case 'bomb': return createBomb();
    case 'wall': return createWall();
    case 'shocker': return createShocker();
    case 'beacon': return createBeacon();
  }
}

// ---------------------------------------------------------------------------
// REPAIR PAD
// ---------------------------------------------------------------------------

/** Health thresholds at which each crack on the deck appears. */
const CRACK_THRESH = [0.86, 0.72, 0.58, 0.44, 0.3, 0.16];
/** Where each crack sits: [angle, radius fraction, length fraction]. */
const CRACK_PLACE: V3[] = [
  [0.55, 0.62, 0.5],
  [1.9, 0.4, 0.42],
  [2.85, 0.74, 0.55],
  [3.7, 0.5, 0.46],
  [4.6, 0.68, 0.6],
  [5.6, 0.34, 0.4],
];

/** Radius of the pad's central hub, clamped so a huge pad keeps a small hub. */
const hubRadius = (R: number): number => Math.min(0.9, R * 0.22);

const _col = new THREE.Color();
const AMBER = new THREE.Color(PAL.hazard);
const RED = new THREE.Color(PAL.danger);
const CYAN = new THREE.Color(PAL.energy);

/**
 * The repair pad: Rivet's forward base, and the thing the player is defending.
 *
 * A low bevelled platform with a bright bordered rim, a warm glowing well in
 * the middle under a bolted hub, a ring of docking cradles the Sparkies sit in,
 * inward-pointing deck chevrons, and a little antenna / pipework / toolbox
 * cluster around the edge so it reads as somebody's workshop rather than a
 * plain disc. All of the deck decoration is flat and high contrast, because
 * this is normally seen from close to straight down.
 *
 * `update` drives:
 *   health01     — rim and rim-glow ramp cyan → amber → red, *and* cracks open
 *                  across the deck one at a time, the whole platform tilts, the
 *                  hub sinks and smoke pours out. Never colour alone.
 *   sparkieCount — lights up one cradle per Sparkie and brightens the well.
 *
 * `userData`: `{ propKind: 'repairPad', radius, cradleCount, cradleAnchors }` —
 * `cradleAnchors` are local-space seats the game can park Sparkies on.
 */
export function createRepairPad(radius: number): RepairPadModel {
  const root = group('repairPad');
  const tilt = new THREE.Group();       // damage lean lives here, not on root
  root.add(tilt);

  const ownedMats: THREE.Material[] = [];
  const ownedGeos: THREE.BufferGeometry[] = [];
  const own = <T extends THREE.Material>(m: T): T => {
    ownedMats.push(m);
    return m;
  };
  const addParts = (parts: PartSet, target: THREE.Object3D, cast = true, receive = false): void => {
    for (const mesh of parts.into(target, cast, receive)) ownedGeos.push(mesh.geometry);
  };

  const R = Math.max(1.5, radius);
  const seg = R > 6 ? 44 : 32;
  const DECK_Y = 0.3;

  // --- materials -----------------------------------------------------------
  const deckMat = own(toonMat(PAL.metalLight, {
    map: getTextureTiled('metalPlate', Math.max(2, R / 2.6)),
    ramp: 'hard3', emissive: 0xffffff, emissiveIntensity: 0, unique: true,
  }));
  const sideMat = own(toonMat(PAL.metalMid, {
    map: getTextureTiled('metalPanel', Math.max(3, R), 1),
    ramp: 'hard3', emissive: 0xffffff, emissiveIntensity: 0, unique: true,
  }));
  const rimMat = own(toonMat(PAL.energy, {
    ramp: 'hard3', emissive: 0xffffff, emissiveIntensity: 0, unique: true,
  }));
  const trimMat = partMat(PAL.boardTop);
  const darkMat = partMat(PAL.metalDark);
  const boltMat = partMat(PAL.bolt);
  const crackMat = partMat(PAL.hazardDark);

  // --- platform ------------------------------------------------------------
  const shellParts = new PartSet();
  shellParts.add(gCyl(R * 0.99, R * 0.9, DECK_Y, seg, true), sideMat, [0, DECK_Y * 0.5, 0]);
  shellParts.add(gCyl(R * 0.9, R * 0.78, 0.24, seg, true), sideMat, [0, -0.1, 0]);
  addParts(shellParts, tilt, true, true);

  const deckParts = new PartSet();
  deckParts.add(gCircle(R * 0.985, seg), deckMat, [0, DECK_Y, 0]);
  addParts(deckParts, tilt, false, true);

  // --- rim: raised lip, painted border band, and a narrow glow halo --------
  // The band is *opaque*, so the health colour survives any lighting; the
  // additive halo is deliberately narrow so it never floods the deck.
  const rim = new THREE.Mesh(gTorus(R * 0.99, 0.09, 6, seg + 8), rimMat);
  rim.position.y = DECK_Y;
  rim.rotation.x = HALF_PI;
  rim.castShadow = true;
  tilt.add(rim);

  const rimBand = new THREE.Mesh(gRing(R * 0.86, R * 0.97, seg + 8), rimMat);
  rimBand.position.y = DECK_Y + 0.01;
  tilt.add(rimBand);

  const rimGlowMat = own(ownGlow(PAL.energy, 0.4, true));
  const rimGlow = new THREE.Mesh(gRing(R * 0.9, R * 1.05, seg + 8), rimGlowMat);
  rimGlow.position.y = DECK_Y + 0.022;
  tilt.add(rimGlow);

  // --- deck markings: four chevrons pointing in at the landing zone --------
  // Painted, not glowing: from directly overhead an additive marking on a pale
  // deck disappears, while opaque gold on light metal always reads.
  const markParts = new PartSet();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI * 0.25;
    const apexR = R * 0.52;
    const armL = R * 0.26;
    const ax = Math.cos(a) * apexR;
    const az = Math.sin(a) * apexR;
    for (const s of [-1, 1]) {
      // Arms sweep back outward from the apex at ±0.62 rad: a real ">" shape.
      const phi = a + s * 0.62;
      markParts.add(gBox(armL, 0.03, R * 0.07, 0.012, 1), trimMat,
        [ax + Math.cos(phi) * armL * 0.5, DECK_Y + 0.012, az + Math.sin(phi) * armL * 0.5],
        [0, -phi, 0]);
    }
  }
  // The warm landing zone itself: a painted gold disc with a soft glow on top.
  markParts.add(gCircle(R * 0.42, 30), trimMat, [0, DECK_Y + 0.006, 0]);
  markParts.add(gRing(R * 0.42, R * 0.46, 30), darkMat, [0, DECK_Y + 0.006, 0]);
  addParts(markParts, tilt, false, true);

  // --- docking cradles -----------------------------------------------------
  const cradleCount = Math.round(clamp(R * 1.5, 6, 12));
  const cradleR = R * 0.74;
  const cradleParts = new PartSet();
  const cradleAnchors: THREE.Vector3[] = [];
  for (let i = 0; i < cradleCount; i++) {
    const a = (i / cradleCount) * TAU;
    const cx = Math.cos(a) * cradleR;
    const cz = Math.sin(a) * cradleR;
    cradleParts.add(gCyl(0.19, 0.24, 0.1, 8), darkMat, [cx, DECK_Y + 0.05, cz]);
    // Two little uprights make a seat the Sparkie visibly sits *in*.
    for (const sx of [-1, 1]) {
      cradleParts.add(gBox(0.07, 0.17, 0.09, 0.03, 1), trimMat,
        [cx + Math.cos(a + HALF_PI) * sx * 0.17, DECK_Y + 0.14, cz + Math.sin(a + HALF_PI) * sx * 0.17],
        [0, -a, 0]);
    }
    cradleAnchors.push(new THREE.Vector3(cx, DECK_Y + 0.12, cz));
  }
  addParts(cradleParts, tilt, true, true);

  // Each cradle's occupancy lamp: a flat ring that lights when a Sparkie lands.
  const lampOn = glowMat(PAL.sparkieGlow, 0.95, true);
  const lampOff = glowMat(PAL.metalMid, 0.22, false);
  const cradleLamps: THREE.Mesh[] = [];
  for (let i = 0; i < cradleCount; i++) {
    const a = (i / cradleCount) * TAU;
    const lamp = new THREE.Mesh(gTorus(0.15, 0.028, 4, 12), lampOff);
    lamp.position.set(Math.cos(a) * cradleR, DECK_Y + 0.11, Math.sin(a) * cradleR);
    lamp.rotation.x = HALF_PI;
    tilt.add(lamp);
    cradleLamps.push(lamp);
  }

  // --- centre: the warm glow over the landing zone + the bolted hub --------
  const wellMat = own(ownGlow(PAL.energyWarm, 0.25, true));
  const well = new THREE.Mesh(gRing(hubRadius(R), R * 0.4, 30), wellMat);
  well.position.y = DECK_Y + 0.016;
  tilt.add(well);

  const hub = new THREE.Group();
  hub.position.y = DECK_Y;
  tilt.add(hub);
  const hubParts = new PartSet();
  const hubR = hubRadius(R);
  hubParts.add(gCyl(hubR * 0.8, hubR, 0.26, 10), trimMat, [0, 0.13, 0]);
  hubParts.add(gTorus(hubR * 0.82, 0.05, 5, 14), darkMat, [0, 0.26, 0], [HALF_PI, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    hubParts.add(gSph(0.05, 6, 5), boltMat, [Math.cos(a) * hubR * 0.72, 0.27, Math.sin(a) * hubR * 0.72]);
  }
  addParts(hubParts, hub, true, true);

  const coreMat = own(ownGlow(PAL.cell, 0.9, true));
  const core = new THREE.Mesh(gSph(hubR * 0.6, 12, 9), coreMat);
  core.position.y = 0.34;
  core.scale.y = 0.7;
  hub.add(core);

  // --- workshop detail: antenna, pipework, toolbox -------------------------
  const detail = new PartSet();
  const antX = -R * 0.82;
  const antZ = R * 0.22;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    detail.add(gCyl(0.03, 0.045, 1.15, 4), darkMat,
      [antX + Math.cos(a) * 0.11, DECK_Y + 0.58, antZ + Math.sin(a) * 0.11],
      [Math.sin(a) * 0.05, 0, -Math.cos(a) * 0.05]);
  }
  for (const y of [0.3, 0.62, 0.94]) {
    detail.add(gTorus(0.1, 0.02, 4, 8), trimMat, [antX, DECK_Y + y, antZ], [HALF_PI, 0, 0]);
  }
  detail.add(gBox(0.36, 0.1, 0.36, 0.04, 1), darkMat, [antX, DECK_Y + 0.05, antZ]);

  const pipX = R * 0.66;
  const pipZ = -R * 0.5;
  detail.add(gCyl(0.13, 0.13, 0.6, 10), sideMat, [pipX, DECK_Y + 0.3, pipZ]);
  detail.add(gTorus(0.14, 0.04, 4, 10), trimMat, [pipX, DECK_Y + 0.58, pipZ], [HALF_PI, 0, 0]);
  detail.add(gCyl(0.11, 0.11, 0.55, 10), sideMat, [pipX - 0.28, DECK_Y + 0.62, pipZ], [0, 0, HALF_PI]);
  detail.add(gCyl(0.2, 0.22, 0.08, 10), darkMat, [pipX, DECK_Y + 0.04, pipZ]);
  // Rivet's toolbox and a coil of cable, parked by the hub.
  detail.add(gBox(0.42, 0.22, 0.28, 0.06, 1), partMat(PAL.scarf), [hubR + 0.45, DECK_Y + 0.11, 0.2], [0, 0.4, 0]);
  detail.add(gBox(0.2, 0.05, 0.06, 0.02, 1), boltMat, [hubR + 0.45, DECK_Y + 0.24, 0.2], [0, 0.4, 0]);
  detail.add(gTorus(0.22, 0.05, 4, 12), darkMat, [-hubR - 0.5, DECK_Y + 0.05, -0.35], [HALF_PI, 0, 0]);
  addParts(detail, tilt, true, true);

  const antBeacon = new THREE.Mesh(gSph(0.08, 8, 6), lampOn);
  antBeacon.position.set(antX, DECK_Y + 1.2, antZ);
  tilt.add(antBeacon);

  // --- damage cracks: hidden until the health drops past each threshold ----
  const cracks: THREE.Group[] = [];
  for (let i = 0; i < CRACK_PLACE.length; i++) {
    const place = CRACK_PLACE[i]!;
    const a = place[0];
    const rr = place[1] * R;
    const len = place[2] * R;
    const crack = new THREE.Group();
    crack.position.set(Math.cos(a) * rr, DECK_Y + 0.024, Math.sin(a) * rr);
    crack.rotation.y = -a * 1.7;
    crack.visible = false;
    // A three-segment zigzag reads as a split plate, not a painted line.
    const cp = new PartSet();
    for (let s = 0; s < 3; s++) {
      const off = (s - 1) * len * 0.32;
      cp.add(gBox(len * 0.36, 0.02, 0.1, 0.008, 1), crackMat,
        [off, 0, (s % 2 === 0 ? 1 : -1) * len * 0.06], [0, (s % 2 === 0 ? 0.35 : -0.35), 0]);
    }
    addParts(cp, crack, false, false);
    tilt.add(crack);
    cracks.push(crack);
  }

  // --- damage smoke --------------------------------------------------------
  const plume = new Plume(6, R * 0.35, 1.8, R * 0.28);
  plume.group.position.set(R * 0.25, DECK_Y, -R * 0.18);
  tilt.add(plume.group);

  root.userData.radius = R;
  root.userData.cradleCount = cradleCount;
  root.userData.cradleAnchors = cradleAnchors;

  let flash = 0;
  let blink = 0;

  return {
    root,

    update(t, dt, health01, sparkieCount) {
      const h = clamp01(health01);
      const dmg = 1 - h;

      if (flash > 0) flash = Math.max(0, flash - dt * 4.5);
      const em = flash * flash;
      deckMat.emissiveIntensity = em;
      sideMat.emissiveIntensity = em;
      rimMat.emissiveIntensity = em;

      // Rim colour ramp: cyan → amber over the top half, amber → red below it.
      if (h > 0.5) _col.copy(CYAN).lerp(AMBER, (1 - h) * 2);
      else _col.copy(AMBER).lerp(RED, (0.5 - h) * 2);
      rimMat.color.copy(_col);
      rimGlowMat.color.copy(_col);
      // …and a hurt rim flickers on top of the colour shift.
      const flicker = dmg > 0.35 ? Math.max(0, Math.sin(t * 9)) * dmg * 0.3 : 0;
      rimGlowMat.opacity = 0.34 + Math.sin(t * 1.9) * 0.06 + flicker;

      // Structural damage: cracks open, the platform lists, the hub settles.
      for (let i = 0; i < cracks.length; i++) cracks[i]!.visible = h < CRACK_THRESH[i]!;
      tilt.rotation.z = dmg * dmg * 0.05;
      tilt.rotation.x = -dmg * dmg * 0.03;
      hub.position.y = DECK_Y - dmg * dmg * 0.09;
      plume.update(dt, dmg * 1.25 - 0.12);

      // Occupancy: one lamp per Sparkie, and the well warms up with the crowd.
      const occupied = clamp(Math.round(sparkieCount), 0, cradleCount);
      for (let i = 0; i < cradleCount; i++) {
        const lamp = cradleLamps[i]!;
        const on = i < occupied;
        lamp.material = on ? lampOn : lampOff;
        lamp.scale.setScalar(on ? 1 + Math.sin(t * 4 + i * 0.9) * 0.1 : 0.7);
        lamp.position.y = DECK_Y + 0.11 + (on ? Math.sin(t * 3 + i) * 0.012 : 0);
      }
      const crowd = clamp01(sparkieCount / Math.max(1, cradleCount));
      wellMat.opacity = 0.22 + crowd * 0.28 + Math.sin(t * 2.2) * 0.05;
      well.scale.setScalar(0.94 + crowd * 0.06 + Math.sin(t * 2.2) * 0.02);
      coreMat.opacity = clamp01(0.55 + crowd * 0.4 + Math.sin(t * 3.6) * 0.08);
      core.rotation.y += dt * (0.6 + crowd * 1.2);
      core.scale.set(1, 0.7 + Math.sin(t * 3.6) * 0.05, 1);

      // The mast light blinks faster the worse things are going.
      blink += dt * (0.9 + dmg * 3.2);
      if (blink > 1) blink -= 1;
      const lit = blink < 0.4;
      antBeacon.material = lit ? lampOn : lampOff;
      antBeacon.scale.setScalar(lit ? 1.1 : 0.6);
    },

    hit() {
      flash = 1;
    },

    dispose() {
      plume.dispose();
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      ownedGeos.length = 0;
      ownedMats.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// PLACEMENT GHOST
// ---------------------------------------------------------------------------

const GHOST_OK = 0x7ee081;    // PAL.leafLight — valid
const GHOST_BAD = PAL.danger; // blocked

/** Simplified silhouettes: enough shape to tell the five gadgets apart. */
function ghostParts(kind: DeployableKind, parts: PartSet, mat: THREE.Material): void {
  switch (kind) {
    case 'turret':
      parts.add(gCyl(0.4, 0.48, 0.22, 8), mat, [0, 0.11, 0]);
      parts.add(gBox(0.46, 0.36, 0.44, 0.13, 1), mat, [0, 0.5, 0]);
      for (const sx of [-1, 1]) {
        parts.add(gCyl(0.06, 0.075, 0.38, 6), mat, [sx * 0.14, 0.5, 0.37], [HALF_PI, 0, 0]);
      }
      break;
    case 'bomb':
      parts.add(gSph(0.27, 10, 7), mat, [0, 0.31, 0], undefined, [1, 0.9, 1]);
      parts.add(gSph(0.09, 8, 6), mat, [0, 0.69, 0]);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.5;
        parts.add(gCyl(0.032, 0.045, 0.3, 5), mat,
          [Math.cos(a) * 0.32, 0.17, Math.sin(a) * 0.32], [0, -a, 0.62]);
      }
      break;
    case 'wall':
      for (const sx of [-1, 1]) parts.add(gBox(0.26, 1.5, 0.32, 0.08, 1), mat, [sx * 1.2, 0.75, 0]);
      for (let i = 0; i < 3; i++) {
        parts.add(gBox(2.16, 0.24, 0.2, 0.06, 1), mat, [0, 0.32 + i * 0.48, 0]);
      }
      parts.add(gBox(2.66, 0.14, 0.24, 0.06, 1), mat, [0, 1.56, 0]);
      break;
    case 'shocker':
      parts.add(gCyl(0.34, 0.42, 0.16, 8), mat, [0, 0.08, 0]);
      parts.add(gCyl(0.16, 0.16, 0.62, 6), mat, [0, 0.48, 0]);
      parts.add(gSph(0.17, 10, 7), mat, [0, 1.0, 0]);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.5;
        parts.add(gCyl(0.045, 0.06, 0.52, 5), mat,
          [Math.cos(a) * 0.38, 0.26, Math.sin(a) * 0.38], [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3]);
      }
      break;
    case 'beacon':
      parts.add(gCyl(0.16, 0.24, 0.16, 8), mat, [0, 0.16, 0]);
      parts.add(gCyl(0.052, 0.072, 0.86, 6), mat, [0, 0.63, 0]);
      parts.add(gCyl(0.135, 0.135, 0.24, 6), mat, [0, 1.13, 0]);
      parts.add(gCone(0.175, 0.14, 6), mat, [0, 1.32, 0]);
      break;
  }
}

/**
 * The translucent preview under the cursor while the player picks a spot.
 *
 * A simplified one-material version of the gadget plus a ground ring at its
 * effect radius. The valid/blocked state is a *shape* change as well as a
 * colour change: when blocked, a spiky warning ring of teeth and dashes plus a
 * big X over the middle switches on over the smooth ring, so it still reads for
 * a colour-blind player or a washed-out screen.
 *
 * `userData`:
 *   `propKind`  the kind, matching the real gadget
 *   `isGhost`   true
 *   `ring`      the smooth ground ring Mesh (its material may be recoloured)
 *   `blocked`   the spiky warning Mesh, hidden while the spot is valid
 *   `radius`    the effect radius the ring is drawn at, in metres
 *   `setValid`  `(ok: boolean) => void` — the preferred way to switch state;
 *               does the colour *and* the shape in one call
 *   `dispose`   `() => void` — frees this ghost's unique materials/geometry
 */
export function createPlacementGhost(kind: DeployableKind): THREE.Group {
  const g = group(kind);
  g.userData.isGhost = true;
  const R = EFFECT_RADIUS[kind];

  // --- the translucent gadget itself, one merged mesh ----------------------
  const bodyMat = toonMat(GHOST_OK, {
    ramp: 'hard3',
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    unique: true,
  });
  bodyMat.depthWrite = false;
  const parts = new PartSet();
  ghostParts(kind, parts, bodyMat);
  const meshes = parts.into(g, false, false);
  for (const m of meshes) m.renderOrder = 2;

  // --- the smooth "this is fine" ring --------------------------------------
  // Normal blending, not additive: an additive ring over a pale floor turns
  // white, and white is exactly the one colour that means nothing here.
  const ringMat = ownGlow(GHOST_OK, 0.9, false);
  const ring = new THREE.Mesh(gRing(R * 0.92, R, 56), ringMat);
  ring.position.y = 0.03;
  ring.renderOrder = 1;
  g.add(ring);

  // A very faint fill so the covered ground is visible without hiding it.
  const fillMat = ownGlow(GHOST_OK, 0.12, false);
  const fill = new THREE.Mesh(gCircle(R * 0.92, 40), fillMat);
  fill.position.y = 0.02;
  fill.renderOrder = 0;
  g.add(fill);

  // --- the spiky "blocked" ring: teeth, dashes and a great big X -----------
  const blockedMat = ownGlow(GHOST_BAD, 0.95, false);
  const bp = new PartSet();
  const TEETH = 16;
  for (let i = 0; i < TEETH; i++) {
    const a = (i / TEETH) * TAU;
    // Outward-pointing tooth: the cone's +Y is turned to +X, then swung to `a`.
    bp.add(gCone(0.11, 0.34, 4), blockedMat,
      [Math.cos(a) * R * 1.04, 0.04, Math.sin(a) * R * 1.04], [0, -a, -HALF_PI]);
    // …and a tangential dash just inside it, so the ring reads as broken up.
    bp.add(gBox((TAU * R) / TEETH * 0.45, 0.02, 0.1, 0.01, 1), blockedMat,
      [Math.cos(a) * R * 0.9, 0.035, Math.sin(a) * R * 0.9], [0, -a + HALF_PI, 0]);
  }
  for (const s of [1, -1]) {
    bp.add(gBox(R * 1.1, 0.02, 0.14, 0.01, 1), blockedMat, [0, 0.05, 0], [0, s * Math.PI * 0.25, 0]);
  }
  const blockedMeshes = bp.into(g, false, false);
  const blocked = blockedMeshes[0]!;
  blocked.renderOrder = 1;
  blocked.visible = false;

  const setValid = (ok: boolean): void => {
    ringMat.color.setHex(ok ? GHOST_OK : GHOST_BAD);
    ringMat.opacity = ok ? 0.75 : 0.35;
    bodyMat.color.setHex(ok ? GHOST_OK : GHOST_BAD);
    blocked.visible = !ok;
  };

  g.userData.ring = ring;
  g.userData.blocked = blocked;
  g.userData.radius = R;
  g.userData.setValid = setValid;
  g.userData.dispose = (): void => {
    for (const m of meshes) m.geometry.dispose();
    blocked.geometry.dispose();
    bodyMat.dispose();
    ringMat.dispose();
    blockedMat.dispose();
  };

  setValid(true);
  return g;
}
