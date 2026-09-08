/**
 * RIVET RUSH: SKY SALVAGE — hostile salvage-bots.
 *
 * Five enemies, each readable from silhouette alone at the fixed 48-degree
 * game camera:
 *
 *   buzzbot    small round pod + two fluttering wings + one huge cyclops eye
 *   sawdrone   long dart hull + a horizontal spinning saw disc slung underneath
 *   zapper     squat tripod tower + rotating dish and a charging orb
 *   bomblet    fat ball + comically oversized wind-up key + tiny propeller
 *   shieldbot  blocky brick + a big hexagonal energy shield held out front
 *
 * Colour language: every hostile machine is violet/magenta (PAL.droneShell,
 * PAL.droneShellDark, PAL.droneTrim) with a hard white eye (PAL.droneEye).
 * Nothing here is scary — they are wind-up toys that got a bit grumpy.
 *
 * CONVENTIONS
 *  - Model origin sits on the GROUND (y = 0) and the model builds upward, so a
 *    game object placed on the ground plane looks right with no extra offset.
 *    Flyers carry their own hover height internally; the exact value is
 *    published as `root.userData.hoverOffset` if the game wants to fly the root
 *    itself instead (subtract it in that case).
 *  - Nothing allocates in update(): every Vector3/Color scratch is made in the
 *    constructor or at module scope.
 *  - Shared cached materials are NEVER mutated. Anything that flashes, pulses or
 *    charges is requested with `unique: true` (or `.clone()`d for sprites).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAL } from '../Palette';
import { getTexture } from '../Textures';
import { glowMat, outlineGroup, roundedBoxGeometry, spriteMat, toonMat } from '../Materials';
import type { ToonOptions } from '../Materials';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EnemyAnimState = 'idle' | 'chase' | 'telegraph' | 'attack' | 'stunned' | 'hurt' | 'dying';
export type EnemyKind = 'buzzbot' | 'sawdrone' | 'zapper' | 'bomblet' | 'shieldbot';

export interface EnemyModel {
  root: THREE.Group;
  /**
   * Called every frame by the game.
   *  t         — total elapsed seconds (for idle motion)
   *  dt        — delta seconds
   *  state     — what the AI is currently doing
   *  intensity — 0..1 generic drive (charge-up, aggression, telegraph progress)
   */
  update(t: number, dt: number, state: EnemyAnimState, intensity: number): void;
  /** Flash white/red briefly on being hit. */
  hit(): void;
  /** Play the stun pose (used when the player dashes into them). */
  setStunned(on: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const FLASH_TIME = 0.2;
const FLASH_COLOR = new THREE.Color(0xffffff);
const TAU = Math.PI * 2;

/** Frame-rate independent ease toward a target. */
function approach(cur: number, target: number, rate: number, d: number): number {
  return cur + (target - cur) * Math.min(1, rate * d);
}

/** In-place transform of a geometry; returns it for chaining. */
function place(
  g: THREE.BufferGeometry,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/**
 * roundedBoxGeometry() returns a SHARED cached geometry, so every call here goes
 * through a clone: these models transform, merge and dispose their geometry and
 * must never touch the cache.
 */
function rbox(w: number, h: number, d: number, radius = 0.12, segments = 2): THREE.BufferGeometry {
  return roundedBoxGeometry(w, h, d, radius, segments).clone();
}

/**
 * Normalises a geometry so merging can never fail: de-indexed, exactly
 * position/normal/uv. Cheap for the tiny primitives used here and it means we
 * can merge rounded boxes with cones and cylinders without worrying about how
 * roundedBoxGeometry() happens to be built.
 */
function prepForMerge(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const out = new THREE.BufferGeometry();
  const pos = g.getAttribute('position');
  out.setAttribute('position', pos);
  const uv = g.getAttribute('uv');
  out.setAttribute('uv', uv ?? new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  const nrm = g.getAttribute('normal');
  if (nrm) out.setAttribute('normal', nrm);
  else out.computeVertexNormals();
  g.dispose();
  return out;
}

/** Merges (and consumes) a list of geometries into one draw call. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepped = parts.map(prepForMerge);
  for (const p of parts) p.dispose();
  const merged = mergeGeometries(prepped, false);
  for (const p of prepped) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

interface Flasher {
  mat: THREE.MeshToonMaterial;
  base: THREE.Color;
  baseIntensity: number;
}

interface Pose {
  /** Forward pitch in radians (positive = nose down / leaning in). */
  lean: number;
  /** Extra hover height. */
  rise: number;
  /** Body squash (1 = neutral, >1 = puffed up). */
  squash: number;
  /** Eye openness (1 = wide, 0 = squinting). */
  eye: number;
}

const POSE_NEUTRAL: Pose = { lean: 0, rise: 0, squash: 1, eye: 1 };

// ---------------------------------------------------------------------------
// Base class — hover rig, hit flash, stun blend, dizzy stars, disposal
// ---------------------------------------------------------------------------

abstract class BaseEnemy implements EnemyModel {
  readonly root = new THREE.Group();
  /** Hover height + lean + bank live here. */
  protected readonly rig = new THREE.Group();
  /** Squash/stretch and the "dying" spin live here. Subclasses must not write body.rotation.y. */
  protected readonly body = new THREE.Group();

  protected readonly geos = new Set<THREE.BufferGeometry>();
  protected readonly uniqueMats = new Set<THREE.Material>();
  protected readonly flashers: Flasher[] = [];
  protected outlines: THREE.Mesh[] = [];

  /** Per-instance phase offset so a pack of enemies never moves in lockstep. */
  protected readonly phase = Math.random() * TAU;
  protected readonly rate = 0.9 + Math.random() * 0.2;

  protected hoverOffset = 0;
  protected flashT = 0;
  private lastFlashK = -1;
  protected stunFlag = false;
  /** Smoothed 0..1 stun weight. */
  protected stun = 0;
  protected dieT = 0;

  private dizzy: THREE.Group | null = null;
  private readonly dizzySprites: THREE.Sprite[] = [];

  constructor(kind: EnemyKind) {
    this.root.name = kind;
    this.root.userData.kind = kind;
    this.root.add(this.rig);
    this.rig.add(this.body);
  }

  // --- construction helpers ------------------------------------------------

  protected reg<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.add(g);
    return g;
  }

  /** Toon material; pass `unique: true` in opts for anything animated. */
  protected toon(color: number, opts?: ToonOptions, flash = false): THREE.MeshToonMaterial {
    const m = toonMat(color, opts);
    if (opts && opts.unique) {
      this.uniqueMats.add(m);
      if (flash) this.flashers.push({ mat: m, base: m.emissive.clone(), baseIntensity: m.emissiveIntensity });
    }
    return m;
  }

  protected mesh(g: THREE.BufferGeometry, m: THREE.Material, cast = true, receive = false): THREE.Mesh {
    const mesh = new THREE.Mesh(this.reg(g), m);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  }

  /** House-style outline pass — call once, after the solid parts, before FX. */
  protected addOutlines(thickness?: number): void {
    this.outlines = thickness === undefined ? outlineGroup(this.root) : outlineGroup(this.root, thickness);
  }

  /** Three little sparkle stars that orbit the head while stunned. */
  protected addDizzy(y: number, radius: number): void {
    const g = new THREE.Group();
    g.position.y = y;
    g.visible = false;
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(spriteMat('sparkSprite', i === 1 ? PAL.overdriveHot : PAL.energyWarm, true));
      const a = (i / 3) * TAU;
      s.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      s.scale.setScalar(0.001);
      g.add(s);
      this.dizzySprites.push(s);
    }
    this.body.add(g);
    this.dizzy = g;
  }

  // --- runtime -------------------------------------------------------------

  update(t: number, dt: number, state: EnemyAnimState, intensity: number): void {
    const d = Math.min(dt, 0.05);

    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt);
    this.applyFlash();

    const stunTarget = this.stunFlag || state === 'stunned' ? 1 : 0;
    this.stun = approach(this.stun, stunTarget, 9, d);
    this.updateDizzy(t, d);

    this.animate(t, d, state, intensity);

    // Pop-and-spin collapse. Owns root.scale + body.rotation.y only, so the
    // game is still free to drive root.position / root.rotation.y for facing.
    if (state === 'dying') {
      this.dieT = Math.min(1, this.dieT + d * 3.4);
      const k = 1 - this.dieT;
      this.root.scale.setScalar(Math.max(0.02, k + Math.sin(this.dieT * Math.PI) * 0.18));
      this.body.rotation.y += d * (6 + this.dieT * 16);
    } else if (this.dieT > 0) {
      this.dieT = 0;
      this.root.scale.setScalar(1);
      this.body.rotation.y = 0;
    }
  }

  private applyFlash(): void {
    const k = this.flashT > 0 ? this.flashT / FLASH_TIME : 0;
    if (k === this.lastFlashK) return;
    this.lastFlashK = k;
    const e = k * k;
    for (let i = 0; i < this.flashers.length; i++) {
      const f = this.flashers[i];
      f.mat.emissive.lerpColors(f.base, FLASH_COLOR, e);
      f.mat.emissiveIntensity = f.baseIntensity + e * 2.4;
    }
  }

  private updateDizzy(t: number, d: number): void {
    const g = this.dizzy;
    if (!g) return;
    const vis = this.stun > 0.02;
    g.visible = vis;
    if (!vis) return;
    g.rotation.y += d * 4.6;
    for (let i = 0; i < this.dizzySprites.length; i++) {
      const s = this.dizzySprites[i];
      const k = 0.14 * this.stun * (0.7 + 0.3 * Math.sin(t * 8 + i * 2.1));
      s.scale.set(k, k, 1);
      s.position.y = Math.sin(t * 5.5 + i * 2.1) * 0.05;
    }
  }

  hit(): void {
    this.flashT = FLASH_TIME;
  }

  setStunned(on: boolean): void {
    this.stunFlag = on;
  }

  dispose(): void {
    for (let i = 0; i < this.outlines.length; i++) this.geos.add(this.outlines[i].geometry);
    for (const g of this.geos) g.dispose();
    for (const m of this.uniqueMats) m.dispose();
    this.geos.clear();
    this.uniqueMats.clear();
    this.outlines.length = 0;
    this.root.clear();
  }

  protected abstract animate(t: number, d: number, state: EnemyAnimState, intensity: number): void;
}

// ---------------------------------------------------------------------------
// 1. BUZZBOT — the tutorial enemy. ~0.8u tall, ~0.75u wide.
//
// Looks like: a plum-sized violet pod hovering at chest height, two fluttering
// insect wings, one enormous white cyclops eye taking up half its face, a bent
// antenna with a pink bulb, and two stubby legs that dangle uselessly.
// Animates: constant fast wing flutter + a lazy figure-of-eight wobble, legs
// swinging behind it. Leans in when chasing, rears back and squints while
// telegraphing, goes floppy and cross-eyed when stunned.
// ---------------------------------------------------------------------------

const BUZZ_POSES: Record<EnemyAnimState, Pose> = {
  idle: POSE_NEUTRAL,
  chase: { lean: 0.3, rise: 0.03, squash: 0.97, eye: 1 },
  telegraph: { lean: -0.36, rise: 0.16, squash: 1.14, eye: 0.45 },
  attack: { lean: 0.62, rise: -0.08, squash: 0.9, eye: 1.15 },
  stunned: { lean: 0.15, rise: -0.3, squash: 0.94, eye: 0.2 },
  hurt: { lean: -0.24, rise: 0.06, squash: 1.1, eye: 1.2 },
  dying: { lean: 0.1, rise: 0.1, squash: 1, eye: 0.3 },
};

class Buzzbot extends BaseEnemy {
  private readonly wingL = new THREE.Group();
  private readonly wingR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly eye = new THREE.Group();
  private readonly pupil = new THREE.Group();
  private readonly browL: THREE.Mesh;
  private readonly browR: THREE.Mesh;
  private readonly bulb: THREE.Mesh;

  private wingPhase = Math.random() * TAU;
  private lean = 0;
  private rise = 0;
  private squash = 1;
  private eyeOpen = 1;

  constructor() {
    super('buzzbot');
    this.hoverOffset = 0.62;

    const shell = this.toon(PAL.droneShell, {
      unique: true, emissive: PAL.droneShellDark, emissiveIntensity: 0.2, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3 }, true);
    const eyeMat = this.toon(PAL.droneEye, { unique: true, emissive: PAL.droneEye, emissiveIntensity: 0.55 }, true);
    const pupilMat = this.toon(PAL.hazardDark);

    // Pod: a slightly squashed ball with a riveted belly band.
    const pod = this.mesh(new THREE.SphereGeometry(0.24, 18, 12), shell);
    pod.scale.set(1, 0.9, 0.96);
    this.body.add(pod);

    const band = this.mesh(place(new THREE.TorusGeometry(0.222, 0.035, 6, 20), 0, -0.03, 0, Math.PI / 2), dark, false);
    this.body.add(band);

    // Face plate — a shallow dish the eye sits in.
    const face = this.mesh(place(new THREE.CylinderGeometry(0.155, 0.175, 0.07, 16), 0, 0.02, 0.185, Math.PI / 2), dark, false);
    this.body.add(face);

    // The one big goofy eye.
    const white = this.mesh(new THREE.SphereGeometry(0.125, 16, 12), eyeMat, false);
    white.scale.set(1, 1, 0.75);
    this.eye.add(white);
    this.pupil.position.z = 0.055;
    const iris = this.mesh(new THREE.SphereGeometry(0.062, 12, 10), pupilMat, false);
    iris.scale.set(1, 1, 0.6);
    this.pupil.add(iris);
    const shine = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.022, 8, 6)), glowMat(PAL.white, 0.95));
    shine.position.set(-0.035, 0.035, 0.05);
    this.pupil.add(shine);
    this.eye.add(this.pupil);
    this.eye.position.set(0, 0.025, 0.215);
    this.body.add(this.eye);

    // Eyebrow plates — the whole personality lives in these two chips.
    const browGeo = this.reg(rbox(0.13, 0.035, 0.05, 0.015, 1));
    this.browL = new THREE.Mesh(browGeo, trim);
    this.browR = new THREE.Mesh(browGeo, trim);
    this.browL.position.set(-0.075, 0.155, 0.235);
    this.browR.position.set(0.075, 0.155, 0.235);
    this.body.add(this.browL, this.browR);

    // Wings — flat rounded blades on shoulder pivots.
    const wingGeo = this.reg(rbox(0.34, 0.028, 0.16, 0.07, 2));
    for (const [pivot, side] of [[this.wingL, -1] as const, [this.wingR, 1] as const]) {
      const w = new THREE.Mesh(wingGeo, trim);
      w.castShadow = true;
      w.position.x = side * 0.17;
      pivot.add(w);
      pivot.position.set(side * 0.185, 0.105, -0.02);
      this.body.add(pivot);
    }

    // Dangling legs.
    const shinGeo = this.reg(new THREE.CylinderGeometry(0.028, 0.022, 0.15, 8));
    const footGeo = this.reg(new THREE.SphereGeometry(0.05, 10, 8));
    for (const [pivot, side] of [[this.legL, -1] as const, [this.legR, 1] as const]) {
      const shin = new THREE.Mesh(shinGeo, dark);
      shin.position.y = -0.075;
      const foot = new THREE.Mesh(footGeo, shell);
      foot.position.y = -0.15;
      foot.scale.set(1, 0.8, 1.15);
      foot.castShadow = true;
      pivot.add(shin, foot);
      pivot.position.set(side * 0.1, -0.18, 0);
      this.body.add(pivot);
    }

    // Antenna.
    const mast = this.mesh(place(new THREE.CylinderGeometry(0.014, 0.016, 0.17, 6), 0, 0.31, -0.02, 0, 0, 0.18), dark, false);
    this.body.add(mast);
    this.bulb = this.mesh(new THREE.SphereGeometry(0.045, 10, 8), trim, false);
    this.bulb.position.set(-0.032, 0.4, -0.02);
    this.body.add(this.bulb);

    this.addOutlines();

    // FX after the outline pass so the glow isn't given a black rim.
    const halo = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.07, 10, 8)), glowMat(PAL.droneTrim, 0.5, true));
    halo.position.copy(this.bulb.position);
    this.body.add(halo);

    this.addDizzy(0.42, 0.2);
    this.root.userData.hoverOffset = this.hoverOffset;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = BUZZ_POSES[state];
    const s = this.stun;

    this.lean = approach(this.lean, p.lean, 8, d);
    this.rise = approach(this.rise, p.rise, 7, d);
    this.squash = approach(this.squash, p.squash, 9, d);
    this.eyeOpen = approach(this.eyeOpen, p.eye, 10, d);

    // Hover: lazy figure-of-eight so it never looks like it is on rails.
    const bob = Math.sin(t * 2.3 * this.rate + this.phase) * 0.055;
    const sway = Math.sin(t * 1.31 * this.rate + this.phase * 1.7) * 0.05;
    this.rig.position.set(sway, this.hoverOffset + this.rise + bob - s * 0.22, 0);
    this.rig.rotation.set(
      this.lean + s * 0.5,
      Math.sin(t * 0.9 + this.phase) * 0.12,
      Math.sin(t * 1.7 * this.rate + this.phase) * 0.09 - s * 0.35,
    );

    // Wings: fast flutter, slowing to a sad flop when stunned.
    const beat = (24 + intensity * 26) * (1 - s * 0.85);
    this.wingPhase += d * beat;
    const flap = Math.sin(this.wingPhase) * (0.62 - s * 0.45);
    const droop = -0.5 * s;
    this.wingL.rotation.set(flap * 0.35, 0, -flap - droop);
    this.wingR.rotation.set(flap * 0.35, 0, flap + droop);

    // Legs swing opposite to the lean, like a toy on a string.
    const swing = Math.sin(t * 2.1 * this.rate + this.phase) * 0.16 - this.lean * 0.7 + s * 0.5;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = swing * 0.8 + 0.05;

    // Eye + brows carry the mood.
    this.body.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));
    this.eye.scale.set(1, Math.max(0.12, this.eyeOpen * (1 - s * 0.7)), 1);
    const look = Math.sin(t * 0.7 + this.phase) * 0.5 + this.lean * 0.6;
    this.pupil.position.x = look * 0.045 + (s ? Math.sin(t * 11) * 0.02 * s : 0);
    this.pupil.position.y = Math.sin(t * 0.55 + this.phase) * 0.02 - s * 0.03;
    const angry = state === 'chase' || state === 'attack' || state === 'telegraph' ? 1 : 0;
    const brow = approach(this.browL.rotation.z, 0.55 * angry - 0.3 * s, 8, d);
    this.browL.rotation.z = brow;
    this.browR.rotation.z = -brow;
    this.browL.position.y = 0.155 - angry * 0.012;
    this.browR.position.y = this.browL.position.y;

    // Antenna bulb pulses with aggression.
    const bulbK = 1 + Math.sin(t * (3 + intensity * 8)) * 0.12 * (0.4 + intensity);
    this.bulb.scale.setScalar(bulbK);
  }
}

// ---------------------------------------------------------------------------
// 2. SAWDRONE — aggressive patroller. ~1.15u long, ~0.7u wide, ~0.65u tall.
//
// Looks like: a violet paper-dart hull with a pointed nose, swept-back fins and
// a scowling red visor, flying nose-forward with a big chrome circular saw slung
// flat underneath it (horizontal, so the disc reads clearly from the top-down
// camera). The saw is the widest part of the silhouette.
// Animates: the disc spin rate is driven by `intensity`; it banks into turns,
// rears back like a wasp before a strafe, then pitches hard forward on attack.
// Stunned it tips onto its side and the blade grinds to a halt.
// ---------------------------------------------------------------------------

const SAW_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0.04, rise: 0, squash: 1, eye: 0.75 },
  chase: { lean: 0.34, rise: -0.04, squash: 1, eye: 1.3 },
  telegraph: { lean: -0.45, rise: 0.18, squash: 1, eye: 1.9 },
  attack: { lean: 0.6, rise: -0.12, squash: 1, eye: 2.2 },
  stunned: { lean: 0.25, rise: -0.34, squash: 1, eye: 0.1 },
  hurt: { lean: -0.3, rise: 0.08, squash: 1, eye: 1.6 },
  dying: { lean: 0.5, rise: 0, squash: 1, eye: 0 },
};

class Sawdrone extends BaseEnemy {
  private readonly saw = new THREE.Group();
  private readonly visor: THREE.MeshToonMaterial;
  private readonly browL: THREE.Mesh;
  private readonly browR: THREE.Mesh;
  private sawSpin = Math.random() * TAU;
  private sawRate = 0;
  private lean = 0;
  private rise = 0;
  private glowK = 0.7;

  constructor() {
    super('sawdrone');
    this.hoverOffset = 0.72;

    const hullMat = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPanel'), emissive: PAL.droneShellDark, emissiveIntensity: 0.18, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.25 }, true);
    this.visor = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.8 });
    const blade = this.toon(PAL.metalLight, { ramp: 'hard4' });

    // --- hull: one merged draw call (body + nose cone + tail block) ---------
    const nose = new THREE.ConeGeometry(0.235, 0.44, 4, 1);
    nose.rotateY(Math.PI / 4);
    nose.rotateX(Math.PI / 2);
    nose.translate(0, 0, 0.48);
    const hull = this.mesh(mergeParts([
      place(rbox(0.44, 0.26, 0.6, 0.1, 2), 0, 0, -0.02),
      nose,
      place(rbox(0.22, 0.2, 0.18, 0.06, 1), 0, 0, -0.36),
    ]), hullMat, true, true);
    this.body.add(hull);

    // Canopy + angry visor slit.
    const canopy = this.mesh(place(rbox(0.32, 0.11, 0.2, 0.05, 1), 0, 0.11, 0.14), dark, false);
    this.body.add(canopy);
    const slit = this.mesh(place(rbox(0.26, 0.075, 0.04, 0.02, 1), 0, 0.115, 0.25, -0.18), this.visor, false);
    this.body.add(slit);

    const browGeo = this.reg(rbox(0.13, 0.05, 0.05, 0.02, 1));
    this.browL = new THREE.Mesh(browGeo, trim);
    this.browR = new THREE.Mesh(browGeo, trim);
    this.browL.position.set(-0.08, 0.175, 0.235);
    this.browR.position.set(0.08, 0.175, 0.235);
    this.browL.rotation.z = 0.5;
    this.browR.rotation.z = -0.5;
    this.body.add(this.browL, this.browR);

    // Swept-back fins (merged — they never move on their own).
    const finGeo = this.reg(mergeParts([
      place(rbox(0.05, 0.24, 0.34, 0.025, 1), -0.24, 0.05, -0.16, -0.3, 0, 0.55),
      place(rbox(0.05, 0.24, 0.34, 0.025, 1), 0.24, 0.05, -0.16, -0.3, 0, -0.55),
      place(rbox(0.05, 0.22, 0.3, 0.025, 1), 0, 0.2, -0.18, -0.35),
    ]));
    const fins = new THREE.Mesh(finGeo, trim);
    fins.castShadow = true;
    this.body.add(fins);

    // Engine nozzles.
    const nozzleGeo = this.reg(place(new THREE.CylinderGeometry(0.075, 0.095, 0.1, 10), 0, 0, 0, Math.PI / 2));
    for (const sx of [-1, 1]) {
      const n = new THREE.Mesh(nozzleGeo, dark);
      n.position.set(sx * 0.13, 0.0, -0.44);
      this.body.add(n);
    }

    // --- the saw: disc + teeth merged, spun as one -------------------------
    const teeth: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.3, 0.3, 0.05, 20)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      teeth.push(place(new THREE.BoxGeometry(0.055, 0.05, 0.1), Math.sin(a) * 0.31, 0, Math.cos(a) * 0.31, 0, -a));
    }
    const disc = this.mesh(mergeParts(teeth), blade);
    this.saw.add(disc);
    const hub = this.mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.1, 10), dark, false);
    this.saw.add(hub);
    this.saw.position.y = -0.3;
    this.body.add(this.saw);

    // Blade guard over the rear half so it does not read as a pure disc.
    const guard = this.mesh(place(new THREE.TorusGeometry(0.335, 0.04, 6, 14, Math.PI), 0, -0.23, 0, Math.PI / 2, 0, 0), trim, false);
    this.body.add(guard);
    // Strut holding the saw on.
    const strut = this.mesh(place(rbox(0.1, 0.2, 0.14, 0.03, 1), 0, -0.18, -0.02), dark, false);
    this.body.add(strut);

    this.addOutlines();

    // Engine glow (after outlines so it stays a clean additive blob).
    const glowGeo = this.reg(new THREE.SphereGeometry(0.07, 10, 8));
    for (const sx of [-1, 1]) {
      const g = new THREE.Mesh(glowGeo, glowMat(PAL.droneTrim, 0.7, true));
      g.position.set(sx * 0.13, 0, -0.5);
      g.scale.set(1, 1, 0.6);
      this.body.add(g);
    }

    this.addDizzy(0.42, 0.24);
    this.root.userData.hoverOffset = this.hoverOffset;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = SAW_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 9, d);
    this.rise = approach(this.rise, p.rise, 7, d);
    this.glowK = approach(this.glowK, p.eye, 8, d);

    const bob = Math.sin(t * 2.7 * this.rate + this.phase) * 0.045;
    const shake = state === 'telegraph' ? Math.sin(t * 46) * 0.018 * intensity : 0;
    this.rig.position.set(shake, this.hoverOffset + this.rise + bob - s * 0.26, 0);
    this.rig.rotation.set(
      this.lean + s * 0.3,
      Math.sin(t * 0.83 * this.rate + this.phase) * 0.14,
      Math.sin(t * 1.15 * this.rate + this.phase) * 0.16 * (1 - s) + s * 1.05,
    );

    // Saw: spin rate is the readable tell for how dangerous it is right now.
    this.sawRate = approach(this.sawRate, (7 + intensity * 46) * (1 - s * 0.95), 3.5, d);
    this.sawSpin = (this.sawSpin + d * this.sawRate) % TAU;
    this.saw.rotation.y = this.sawSpin;
    this.saw.position.y = -0.3 - Math.min(0.06, this.sawRate * 0.0012);

    // Visor brightens as it winds up; brows pinch in.
    this.visor.emissiveIntensity = this.glowK * (1 - s * 0.9);
    const pinch = 0.5 + this.glowK * 0.16 - s * 0.7;
    this.browL.rotation.z = pinch;
    this.browR.rotation.z = -pinch;
  }
}

// ---------------------------------------------------------------------------
// 3. ZAPPER — stationary turret. ~1.3u tall, ~0.9u footprint.
//
// Looks like: a squat armoured drum on a splayed three-legged tripod, wearing a
// hazard-striped belt, with a satellite-dish emitter on top and a whip antenna
// out the back. Sits on the ground (origin at y = 0).
// Animates: idles by slowly sweeping the dish left and right. TELEGRAPH is the
// whole point of this enemy — it squats down on its legs, the dish rears back,
// the hazard belt strobes faster and faster, and a magenta orb inflates between
// the three emitter prongs with expanding warning rings until it fires; on
// attack it snaps forward and recoils.
// ---------------------------------------------------------------------------

const ZAP_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0, rise: 0, squash: 1, eye: 0.2 },
  chase: { lean: 0.06, rise: 0.01, squash: 1.02, eye: 0.5 },
  telegraph: { lean: -0.34, rise: -0.07, squash: 0.9, eye: 1 },
  attack: { lean: 0.22, rise: 0.06, squash: 1.08, eye: 0.15 },
  stunned: { lean: 0.55, rise: -0.12, squash: 0.86, eye: 0 },
  hurt: { lean: -0.16, rise: 0.03, squash: 1.05, eye: 0.4 },
  dying: { lean: 0.4, rise: -0.05, squash: 0.9, eye: 0 },
};

class Zapper extends BaseEnemy {
  private readonly turret = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly orb: THREE.Mesh;
  private readonly orbMat: THREE.MeshToonMaterial;
  private readonly halo: THREE.Mesh;
  private readonly haloMat: THREE.MeshBasicMaterial;
  private readonly rings: THREE.Sprite[] = [];
  private readonly ringMats: THREE.SpriteMaterial[] = [];
  private readonly beltMat: THREE.MeshToonMaterial;

  private pitch = 0;
  private rise = 0;
  private squash = 1;
  private charge = 0;
  private yaw = 0;

  constructor() {
    super('zapper');
    this.hoverOffset = 0;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPanel'), emissive: PAL.droneShellDark, emissiveIntensity: 0.16, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3 }, true);
    this.beltMat = this.toon(PAL.hazard, { unique: true, map: getTexture('hazardStripe'), emissive: PAL.hazard, emissiveIntensity: 0.2 });
    this.orbMat = this.toon(PAL.droneEye, {
      unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3, transparent: true, opacity: 0.92,
    });

    // --- tripod: base pad + three splayed legs + feet, one merged mesh -----
    const legParts: THREE.BufferGeometry[] = [
      place(new THREE.CylinderGeometry(0.3, 0.42, 0.12, 12), 0, 0.06, 0),
    ];
    const feet: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + Math.PI / 6;
      const leg = new THREE.CylinderGeometry(0.075, 0.055, 0.62, 8);
      leg.translate(0, -0.31, 0);
      leg.rotateZ(-0.62);
      leg.rotateY(a);
      leg.translate(0, 0.56, 0);
      legParts.push(leg);
      const fx = Math.cos(a) * 0.36;
      const fz = -Math.sin(a) * 0.36;
      feet.push(place(rbox(0.19, 0.09, 0.24, 0.035, 1), fx, 0.05, fz, 0, a, 0));
    }
    const tripod = this.mesh(mergeParts(legParts), dark, true, true);
    this.body.add(tripod);
    const pads = this.mesh(mergeParts(feet), trim, true, true);
    this.body.add(pads);

    // --- drum body ---------------------------------------------------------
    const drum = this.mesh(place(new THREE.CylinderGeometry(0.3, 0.37, 0.36, 12), 0, 0.68, 0), shell);
    this.body.add(drum);
    const belt = this.mesh(place(new THREE.CylinderGeometry(0.375, 0.375, 0.12, 12), 0, 0.62, 0), this.beltMat, false);
    this.body.add(belt);
    const collar = this.mesh(place(new THREE.CylinderGeometry(0.2, 0.3, 0.1, 12), 0, 0.89, 0), dark, false);
    this.body.add(collar);

    // Whip antenna out the back — the extra bit of height in the silhouette.
    const whip = this.mesh(place(new THREE.CylinderGeometry(0.016, 0.024, 0.42, 6), -0.03, 1.06, -0.28, 0, 0, 0.14), dark, false);
    this.body.add(whip);
    const tip = this.mesh(new THREE.SphereGeometry(0.05, 10, 8), trim, false);
    tip.position.set(-0.06, 1.27, -0.28);
    this.body.add(tip);

    // --- rotating turret ---------------------------------------------------
    this.turret.position.y = 0.94;
    this.body.add(this.turret);
    const yokeGeo = this.reg(rbox(0.07, 0.24, 0.24, 0.03, 1));
    for (const sx of [-1, 1]) {
      const y = new THREE.Mesh(yokeGeo, dark);
      y.position.set(sx * 0.24, 0.08, 0);
      y.castShadow = true;
      this.turret.add(y);
    }
    this.head.position.y = 0.13;
    this.turret.add(this.head);

    // Dish (open cone shell) + rim + inner horn.
    const dish = this.mesh(
      place(new THREE.CylinderGeometry(0.3, 0.15, 0.24, 14, 1, true), 0, 0, 0.02, Math.PI / 2),
      this.toon(PAL.droneShell, { ramp: 'hard3', side: THREE.DoubleSide }),
    );
    this.head.add(dish);
    const rim = this.mesh(place(new THREE.TorusGeometry(0.3, 0.035, 6, 18), 0, 0, 0.14), trim, false);
    this.head.add(rim);
    const horn = this.mesh(place(new THREE.CylinderGeometry(0.05, 0.13, 0.2, 10), 0, 0, 0.06, Math.PI / 2), dark, false);
    this.head.add(horn);
    const barrel = this.mesh(place(new THREE.CylinderGeometry(0.055, 0.075, 0.3, 10), 0, 0, 0.2, Math.PI / 2), dark);
    this.head.add(barrel);

    // Three prongs cradling the charge orb.
    const prongParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      const g = new THREE.CylinderGeometry(0.022, 0.035, 0.24, 6);
      g.translate(0, 0.12, 0);
      g.rotateZ(-0.34);
      g.rotateY(a);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, 0.28);
      prongParts.push(g);
    }
    const prongs = this.mesh(mergeParts(prongParts), trim, false);
    this.head.add(prongs);

    this.addOutlines();

    // --- charge FX (added after the outline pass) --------------------------
    this.orb = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.13, 16, 12)), this.orbMat);
    this.orb.position.z = 0.42;
    this.head.add(this.orb);

    this.haloMat = glowMat(PAL.droneTrim, 0.55, true).clone();
    this.uniqueMats.add(this.haloMat);
    this.halo = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.2, 12, 10)), this.haloMat);
    this.halo.position.z = 0.42;
    this.head.add(this.halo);

    for (let i = 0; i < 2; i++) {
      const m = spriteMat('ringSprite', PAL.droneTrim, true).clone();
      this.uniqueMats.add(m);
      this.ringMats.push(m);
      const s = new THREE.Sprite(m);
      s.position.z = 0.42;
      s.scale.setScalar(0.01);
      this.head.add(s);
      this.rings.push(s);
    }

    this.addDizzy(1.15, 0.24);
    this.root.userData.hoverOffset = 0;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = ZAP_POSES[state];
    const s = this.stun;
    this.pitch = approach(this.pitch, p.lean, 10, d);
    this.rise = approach(this.rise, p.rise, 9, d);
    this.squash = approach(this.squash, p.squash, 10, d);

    // Charge only really climbs while telegraphing; it snaps off on attack.
    const chargeTarget = state === 'telegraph' ? Math.max(0.12, intensity) : state === 'attack' ? 0 : 0;
    this.charge = approach(this.charge, chargeTarget, state === 'attack' ? 26 : 9, d);

    const hum = Math.sin(t * 1.6 * this.rate + this.phase) * 0.012;
    this.rig.position.y = this.rise + hum - s * 0.06;
    this.rig.rotation.z = s * 0.5;
    this.rig.rotation.x = s * 0.18;
    this.body.scale.set(1 + (1 - this.squash) * 0.5, this.squash, 1 + (1 - this.squash) * 0.5);

    // Idle scan sweep; snaps to dead-ahead as soon as it has a target.
    const yawTarget = state === 'idle' ? Math.sin(t * 0.55 * this.rate + this.phase) * 0.85 : 0;
    this.yaw = approach(this.yaw, yawTarget, state === 'idle' ? 2 : 8, d);
    this.turret.rotation.y = this.yaw;
    this.head.rotation.x = this.pitch + Math.sin(t * 1.1 + this.phase) * 0.02 + s * 0.6;

    // Charge orb: unmistakable growth + brightening.
    const c = this.charge;
    const wobble = 1 + Math.sin(t * (10 + c * 40)) * 0.08 * c;
    this.orb.visible = c > 0.02;
    this.halo.visible = this.orb.visible;
    this.orb.scale.setScalar((0.16 + c * 1.15) * wobble);
    this.orbMat.emissiveIntensity = 0.25 + c * 4.2;
    this.orbMat.opacity = 0.55 + c * 0.45;
    this.halo.scale.setScalar((0.3 + c * 1.5) * wobble);
    this.haloMat.opacity = 0.1 + c * 0.55;

    // Expanding warning rings, faster as the shot gets closer.
    for (let i = 0; i < this.rings.length; i++) {
      const k = (t * (0.7 + c * 1.9) + i * 0.5) % 1;
      const vis = c > 0.05;
      this.rings[i].visible = vis;
      if (!vis) continue;
      const sc = 0.15 + k * (0.5 + c * 0.7);
      this.rings[i].scale.set(sc, sc, 1);
      this.ringMats[i].opacity = (1 - k) * c * 0.9;
    }

    // Hazard belt strobes faster the closer it is to firing.
    const strobe = 0.5 + 0.5 * Math.sin(t * (3 + c * 26) + this.phase);
    this.beltMat.emissiveIntensity = 0.15 + strobe * (0.3 + c * 1.9) * (1 - s * 0.8);
  }
}

// ---------------------------------------------------------------------------
// 4. BOMBLET — chase-and-detonate. ~0.9u tall, ~0.66u wide.
//
// Looks like: a fat violet beach-ball with two little boots, two googly eyes, a
// glowing warning belt round its middle, a comically oversized brass wind-up key
// sticking out of its back and a tiny propeller beanie on top. Deliberately
// silly so that popping it reads as funny, not violent.
// Animates: hops along in a squash-and-stretch arc (stretch on take-off, splat
// on landing), key winds and propeller spins faster with `intensity`, and the
// warning belt strobes faster and faster as it closes in. On telegraph it puffs
// up, shudders and goes cross-eyed.
// ---------------------------------------------------------------------------

const BOMB_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0, rise: 0.35, squash: 1, eye: 0.25 },
  chase: { lean: 0.18, rise: 1, squash: 1.04, eye: 0.9 },
  telegraph: { lean: -0.12, rise: 0.1, squash: 1.3, eye: 2.6 },
  attack: { lean: 0, rise: 0, squash: 1.45, eye: 4 },
  stunned: { lean: 0.3, rise: 0, squash: 0.86, eye: 0 },
  hurt: { lean: -0.25, rise: 0.2, squash: 1.15, eye: 1.4 },
  dying: { lean: 0, rise: 0, squash: 1.3, eye: 3 },
};

class Bomblet extends BaseEnemy {
  private readonly blob = new THREE.Group();
  private readonly key = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly pupilL = new THREE.Group();
  private readonly pupilR = new THREE.Group();
  private readonly bandMat: THREE.MeshToonMaterial;
  private readonly footL: THREE.Mesh;
  private readonly footR: THREE.Mesh;

  private hopT = Math.random();
  private lean = 0;
  private hopK = 0.35;
  private puff = 1;
  private alarm = 0.25;

  constructor() {
    super('bomblet');
    this.hoverOffset = 0;
    this.body.add(this.blob);

    const shell = this.toon(PAL.droneShell, {
      unique: true, emissive: PAL.droneShellDark, emissiveIntensity: 0.2, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const brass = this.toon(PAL.bolt, { ramp: 'hard4' });
    const eyeMat = this.toon(PAL.droneEye, { unique: true, emissive: PAL.droneEye, emissiveIntensity: 0.5 }, true);
    const pupilMat = this.toon(PAL.hazardDark);
    this.bandMat = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.5 });

    // Fat body.
    const ball = this.mesh(new THREE.SphereGeometry(0.3, 18, 14), shell);
    ball.position.y = 0.34;
    ball.scale.set(1, 0.95, 1);
    this.blob.add(ball);

    // Warning belt.
    const band = this.mesh(place(new THREE.TorusGeometry(0.3, 0.05, 8, 24), 0, 0.3, 0, Math.PI / 2), this.bandMat, false);
    this.blob.add(band);
    // Rivet studs around the belt so it is not a bare torus.
    const studs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      studs.push(place(new THREE.SphereGeometry(0.035, 8, 6), Math.sin(a) * 0.31, 0.3, Math.cos(a) * 0.31));
    }
    this.blob.add(this.mesh(mergeParts(studs), dark, false));

    // Two googly eyes.
    const whiteGeo = this.reg(new THREE.SphereGeometry(0.095, 14, 10));
    const irisGeo = this.reg(new THREE.SphereGeometry(0.045, 10, 8));
    const shineGeo = this.reg(new THREE.SphereGeometry(0.017, 6, 5));
    for (const [pupil, sx] of [[this.pupilL, -1] as const, [this.pupilR, 1] as const]) {
      const w = new THREE.Mesh(whiteGeo, eyeMat);
      w.position.set(sx * 0.115, 0.43, 0.225);
      w.scale.set(1, 1, 0.8);
      this.blob.add(w);
      const iris = new THREE.Mesh(irisGeo, pupilMat);
      iris.scale.set(1, 1, 0.6);
      pupil.add(iris);
      const shine = new THREE.Mesh(shineGeo, glowMat(PAL.white, 0.95));
      shine.position.set(-0.024, 0.028, 0.035);
      pupil.add(shine);
      pupil.position.set(sx * 0.115, 0.43, 0.285);
      this.blob.add(pupil);
    }
    // Worried little mouth.
    const mouth = this.mesh(place(rbox(0.13, 0.04, 0.04, 0.015, 1), 0, 0.29, 0.285, 0, 0, 0.15), dark, false);
    this.blob.add(mouth);

    // Oversized wind-up key on its back.
    const shaft = this.mesh(place(new THREE.CylinderGeometry(0.038, 0.038, 0.2, 8), 0, 0, -0.1, Math.PI / 2), brass, false);
    this.key.add(shaft);
    const bow = this.mesh(place(new THREE.TorusGeometry(0.13, 0.042, 6, 16), 0, 0, -0.2), brass);
    bow.scale.set(1, 0.72, 1);
    this.key.add(bow);
    const bar = this.mesh(place(rbox(0.26, 0.05, 0.05, 0.02, 1), 0, 0, -0.2), brass, false);
    this.key.add(bar);
    this.key.position.set(0, 0.42, -0.26);
    this.blob.add(this.key);

    // Propeller beanie.
    const hub = this.mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.07, 8), dark, false);
    this.prop.add(hub);
    const bladeGeo = this.reg(rbox(0.3, 0.02, 0.07, 0.01, 1));
    for (const sx of [-1, 1]) {
      const b = new THREE.Mesh(bladeGeo, this.bandMat);
      b.position.set(sx * 0.14, 0.05, 0);
      b.rotation.z = sx * 0.25;
      b.castShadow = true;
      this.prop.add(b);
    }
    this.prop.position.y = 0.65;
    this.blob.add(this.prop);

    // Boots stay planted while the body squashes.
    const bootGeo = this.reg(rbox(0.14, 0.09, 0.19, 0.035, 1));
    this.footL = new THREE.Mesh(bootGeo, dark);
    this.footR = new THREE.Mesh(bootGeo, dark);
    this.footL.position.set(-0.13, 0.05, 0.02);
    this.footR.position.set(0.13, 0.05, 0.02);
    this.footL.castShadow = true;
    this.footR.castShadow = true;
    this.body.add(this.footL, this.footR);

    this.addOutlines();
    this.addDizzy(0.82, 0.2);
    this.root.userData.hoverOffset = 0;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = BOMB_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 8, d);
    this.hopK = approach(this.hopK, p.rise * (1 - s), 6, d);
    this.puff = approach(this.puff, p.squash, 9, d);
    this.alarm = approach(this.alarm, p.eye, 7, d);

    // --- hop cycle: 62% airborne arc, then a splat and recovery ------------
    this.hopT = (this.hopT + d * (1.5 + intensity * 2.4) * (1 - s * 0.92)) % 1;
    const cyc = this.hopT;
    let sy: number;
    let h: number;
    if (cyc < 0.62) {
      const u = cyc / 0.62;
      h = Math.sin(u * Math.PI) * (0.1 + this.hopK * 0.26);
      sy = 1 + Math.cos(u * Math.PI) * 0.17;
    } else {
      const u = (cyc - 0.62) / 0.38;
      h = 0;
      sy = 0.74 + (1 - Math.cos(u * Math.PI * 0.5)) * 0.26;
    }
    sy *= this.puff;
    const sxz = this.puff / Math.sqrt(sy / this.puff);

    const shudder = state === 'telegraph' || state === 'attack' ? Math.sin(t * 52) * 0.02 * intensity : 0;
    this.rig.position.set(shudder, h * this.hopK, 0);
    this.rig.rotation.set(this.lean + s * 0.35, 0, Math.sin(t * 2.2 * this.rate + this.phase) * 0.07 + s * 0.5);
    this.blob.scale.set(sxz, sy, sxz);
    this.footL.rotation.x = -h * 1.4;
    this.footR.rotation.x = -h * 1.2;

    // Key winds, propeller spins; both faster the angrier it is.
    const drive = (1.6 + intensity * 9) * (1 - s * 0.9);
    this.key.rotation.z -= d * drive;
    this.prop.rotation.y += d * drive * 2.6;
    this.prop.rotation.x = s * 0.6;

    // Cross-eyed panic; pupils drift lazily otherwise.
    const cross = Math.max(s, state === 'telegraph' || state === 'attack' ? intensity : 0);
    const drift = Math.sin(t * 1.4 + this.phase) * 0.03;
    this.pupilL.position.x = 0.115 * -1 + drift + cross * 0.035;
    this.pupilR.position.x = 0.115 - drift - cross * 0.035;
    const py = 0.43 + Math.sin(t * 1.1 + this.phase) * 0.014 - s * 0.02;
    this.pupilL.position.y = py;
    this.pupilR.position.y = py;

    // Warning belt: the strobe rate is the countdown.
    const rate = 2.5 + this.alarm * 11;
    const strobe = 0.5 + 0.5 * Math.sin(t * rate * TAU * 0.35 + this.phase);
    this.bandMat.emissiveIntensity = (0.25 + strobe * (0.4 + this.alarm * 1.5)) * (1 - s * 0.85);
  }
}

// ---------------------------------------------------------------------------
// 5. SHIELDBOT — the puzzle enemy. ~1.2u tall, ~1.05u wide (shield included).
//
// Looks like: a chunky brick of a drone — square shoulders, a letterbox visor,
// twin thrusters — holding a big translucent hexagonal energy shield out in
// front of it with both hands. Behind the shield its chest hatch shows a
// glowing core: that is what the player has to reach.
// Animates: hovers with a heavy, deliberate rhythm and braces the shield
// forward when telegraphing. The shield is `root.userData.shield` — hide it
// (or detach and shatter it) and the core immediately flares up and the bot
// panics, arms flailing, which is the player's cue that it is now vulnerable.
// ---------------------------------------------------------------------------

const SHIELD_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0, rise: 0, squash: 1, eye: 0.6 },
  chase: { lean: 0.16, rise: 0.02, squash: 1, eye: 1 },
  telegraph: { lean: -0.26, rise: 0.12, squash: 1, eye: 1.8 },
  attack: { lean: 0.42, rise: -0.06, squash: 1, eye: 2.2 },
  stunned: { lean: 0.35, rise: -0.3, squash: 1, eye: 0.05 },
  hurt: { lean: -0.3, rise: 0.05, squash: 1, eye: 1.5 },
  dying: { lean: 0.2, rise: 0, squash: 1, eye: 0 },
};

class Shieldbot extends BaseEnemy {
  private readonly shield = new THREE.Group();
  private readonly hex: THREE.Mesh;
  private readonly hexMat: THREE.MeshToonMaterial;
  private readonly core: THREE.Mesh;
  private readonly coreMat: THREE.MeshToonMaterial;
  private readonly coreHaloMat: THREE.MeshBasicMaterial;
  private readonly coreHalo: THREE.Mesh;
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly visorMat: THREE.MeshToonMaterial;

  private lean = 0;
  private rise = 0;
  private push = 0;
  private glowK = 0.6;
  private expose = 0;

  constructor() {
    super('shieldbot');
    this.hoverOffset = 0.68;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPlate'), emissive: PAL.droneShellDark, emissiveIntensity: 0.16, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.28 }, true);
    this.visorMat = this.toon(PAL.droneEye, { unique: true, emissive: PAL.droneEye, emissiveIntensity: 0.7 });
    this.coreMat = this.toon(PAL.cellHot, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.6 });
    this.hexMat = this.toon(PAL.shield, {
      unique: true, emissive: PAL.energy, emissiveIntensity: 0.8,
      transparent: true, opacity: 0.42, side: THREE.DoubleSide,
    });

    // Torso + backpack + shoulder pads merged into one chunky brick.
    const torso = this.mesh(mergeParts([
      rbox(0.56, 0.6, 0.44, 0.12, 2),
      place(rbox(0.38, 0.36, 0.18, 0.06, 1), 0, 0.02, -0.29),
      place(rbox(0.2, 0.26, 0.34, 0.07, 1), -0.36, 0.16, 0),
      place(rbox(0.2, 0.26, 0.34, 0.07, 1), 0.36, 0.16, 0),
    ]), shell, true, true);
    this.body.add(torso);

    // Recessed chest hatch the core sits in.
    const hatch = this.mesh(place(rbox(0.34, 0.34, 0.08, 0.05, 1), 0, 0.0, 0.2), this.toon(PAL.hazardDark), false);
    this.body.add(hatch);

    // Head: a low visor block with a hard white eye bar.
    const head = this.mesh(place(rbox(0.42, 0.18, 0.32, 0.06, 2), 0, 0.4, 0.02), dark);
    this.body.add(head);
    const eye = this.mesh(place(rbox(0.28, 0.075, 0.04, 0.02, 1), 0, 0.4, 0.19), this.visorMat, false);
    this.body.add(eye);
    // Little antenna ears so the head is not a bare slab.
    const earGeo = this.reg(rbox(0.05, 0.14, 0.06, 0.02, 1));
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(earGeo, trim);
      ear.position.set(sx * 0.23, 0.48, 0.0);
      ear.rotation.z = sx * 0.3;
      this.body.add(ear);
    }

    // Arms: identical merged geometry reused left and right (mirrored by scale).
    const armGeo = this.reg(mergeParts([
      place(rbox(0.15, 0.15, 0.3, 0.05, 1), 0, 0, 0.12),
      place(rbox(0.13, 0.13, 0.26, 0.05, 1), 0, -0.04, 0.38),
      place(rbox(0.1, 0.2, 0.12, 0.04, 1), 0, -0.04, 0.53),
    ]));
    for (const [arm, sx] of [[this.armL, -1] as const, [this.armR, 1] as const]) {
      const m = new THREE.Mesh(armGeo, dark);
      m.castShadow = true;
      arm.add(m);
      arm.position.set(sx * 0.34, 0.1, 0.04);
      arm.scale.x = sx;
      this.body.add(arm);
    }

    // Thrusters.
    const thrusterGeo = this.reg(new THREE.CylinderGeometry(0.1, 0.14, 0.14, 10));
    for (const sx of [-1, 1]) {
      const th = new THREE.Mesh(thrusterGeo, dark);
      th.position.set(sx * 0.18, -0.34, 0);
      th.castShadow = true;
      this.body.add(th);
    }

    this.addOutlines();

    // --- glowing core (never outlined) -------------------------------------
    this.core = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.14, 16, 12)), this.coreMat);
    this.core.position.set(0, 0, 0.235);
    this.body.add(this.core);
    this.coreHaloMat = glowMat(PAL.droneTrim, 0.5, true).clone();
    this.uniqueMats.add(this.coreHaloMat);
    this.coreHalo = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.2, 12, 10)), this.coreHaloMat);
    this.coreHalo.position.copy(this.core.position);
    this.body.add(this.coreHalo);

    // Thruster flames.
    const flameGeo = this.reg(place(new THREE.ConeGeometry(0.09, 0.24, 10), 0, -0.12, 0, Math.PI));
    for (const sx of [-1, 1]) {
      const f = new THREE.Mesh(flameGeo, glowMat(PAL.droneTrim, 0.6, true));
      f.position.set(sx * 0.18, -0.42, 0);
      this.body.add(f);
    }

    // --- the hexagonal energy shield ---------------------------------------
    this.hex = new THREE.Mesh(
      this.reg(place(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 6), 0, 0, 0, Math.PI / 2, 0, Math.PI / 6)),
      this.hexMat,
    );
    this.shield.add(this.hex);
    const rim = new THREE.Mesh(
      this.reg(place(new THREE.TorusGeometry(0.5, 0.04, 5, 6), 0, 0, 0, 0, 0, Math.PI / 6)),
      this.toon(PAL.energy, { unique: true, emissive: PAL.energy, emissiveIntensity: 1.1 }),
    );
    rim.castShadow = true;
    this.shield.add(rim);
    const inner = new THREE.Mesh(
      this.reg(place(new THREE.TorusGeometry(0.27, 0.022, 5, 6), 0, 0, 0.01, 0, 0, Math.PI / 6)),
      this.toon(PAL.energy, { unique: true, emissive: PAL.energy, emissiveIntensity: 1.1 }),
    );
    this.shield.add(inner);
    const boss = new THREE.Mesh(this.reg(new THREE.SphereGeometry(0.09, 12, 10)), trim);
    boss.scale.set(1, 1, 0.5);
    boss.position.z = 0.03;
    this.shield.add(boss);
    this.shield.position.set(0, 0.0, 0.6);
    this.body.add(this.shield);

    this.addDizzy(0.72, 0.24);
    this.root.userData.hoverOffset = this.hoverOffset;
    this.root.userData.shield = this.shield;
    this.root.userData.core = this.core;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = SHIELD_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 7, d);
    this.rise = approach(this.rise, p.rise, 6, d);
    this.glowK = approach(this.glowK, p.eye, 8, d);
    // The moment the game hides the shield, the core flares and it panics.
    this.expose = approach(this.expose, this.shield.visible ? 0 : 1, 5, d);

    const bob = Math.sin(t * 1.7 * this.rate + this.phase) * 0.06;
    const heave = Math.sin(t * 3.4 * this.rate + this.phase) * 0.012;
    this.rig.position.set(0, this.hoverOffset + this.rise + bob - s * 0.3, heave);
    this.rig.rotation.set(
      this.lean + s * 0.45,
      Math.sin(t * 0.6 + this.phase) * 0.1,
      Math.sin(t * 1.25 * this.rate + this.phase) * 0.07 - s * 0.5,
    );

    // Brace / bash: shield pushes forward on telegraph and attack.
    const pushTarget = (state === 'telegraph' ? 0.1 : state === 'attack' ? 0.26 : 0) * (1 - s);
    this.push = approach(this.push, pushTarget, state === 'attack' ? 20 : 8, d);
    const flail = this.expose * Math.sin(t * 13 + this.phase) * 0.5;
    this.armL.rotation.x = -0.1 - this.push * 0.5 + s * 0.9 + flail;
    this.armR.rotation.x = -0.1 - this.push * 0.5 + s * 0.9 - flail;
    this.armL.rotation.y = this.expose * 0.4;
    this.armR.rotation.y = -this.expose * 0.4;

    this.shield.position.z = 0.6 + this.push - s * 0.1;
    this.shield.position.y = Math.sin(t * 2.1 + this.phase * 1.4) * 0.03 - s * 0.28;
    this.shield.rotation.z += d * 0.35;
    this.shield.rotation.x = s * 0.8;
    const shimmer = 0.5 + 0.5 * Math.sin(t * 3 + this.phase);
    this.hexMat.emissiveIntensity = (0.55 + shimmer * 0.5 + intensity * 0.6) * (1 - s * 0.7);
    this.hexMat.opacity = 0.3 + shimmer * 0.12 + this.push * 0.4;
    this.hex.scale.setScalar(1 + Math.sin(t * 4.5 + this.phase) * 0.015);

    // Core: dim behind the shield, blazing once the shield is gone.
    const coreK = 0.5 + this.expose * 3.4 + Math.sin(t * (5 + this.expose * 9)) * (0.15 + this.expose * 0.5);
    this.coreMat.emissiveIntensity = coreK;
    this.coreHaloMat.opacity = 0.18 + this.expose * 0.6;
    const cs = 1 + this.expose * 0.25 + Math.sin(t * 6.5) * 0.05 * (0.3 + this.expose);
    this.core.scale.setScalar(cs);
    this.coreHalo.scale.setScalar(cs * (1 + this.expose * 0.4));

    this.visorMat.emissiveIntensity = this.glowK * (1 - s * 0.9) + this.expose * 0.8;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEnemy(kind: EnemyKind): EnemyModel {
  switch (kind) {
    case 'buzzbot': return new Buzzbot();
    case 'sawdrone': return new Sawdrone();
    case 'zapper': return new Zapper();
    case 'bomblet': return new Bomblet();
    case 'shieldbot': return new Shieldbot();
  }
}

// ---------------------------------------------------------------------------
// Defeat effect — harmless bouncing scrap
// ---------------------------------------------------------------------------

/** Where the enemy's "body" sits above its ground origin, so scrap pops from the right height. */
const SCRAP_HEIGHT: Record<EnemyKind, number> = {
  buzzbot: 0.62, sawdrone: 0.72, zapper: 0.8, bomblet: 0.36, shieldbot: 0.68,
};
const SCRAP_COUNT: Record<EnemyKind, number> = {
  buzzbot: 7, sawdrone: 9, zapper: 10, bomblet: 8, shieldbot: 10,
};
const SCRAP_TINT: Record<EnemyKind, readonly number[]> = {
  buzzbot: [PAL.droneShell, PAL.droneShellDark, PAL.droneTrim],
  sawdrone: [PAL.droneShell, PAL.metalLight, PAL.droneTrim],
  zapper: [PAL.droneShell, PAL.droneShellDark, PAL.hazard],
  bomblet: [PAL.droneShell, PAL.bolt, PAL.droneTrim],
  shieldbot: [PAL.droneShell, PAL.droneShellDark, PAL.shield],
};

interface Chunk {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  base: number;
}

const BURST_LIFE = 1.75;

/**
 * Bouncing harmless scrap chunks for the pop-into-parts defeat effect.
 * Place `root` at the defeated enemy's ground position (the same transform the
 * enemy model used) and call update(dt) until it returns false.
 */
export function createScrapBurst(kind: EnemyKind): { root: THREE.Group; update(dt: number): boolean; dispose(): void } {
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const chunks: Chunk[] = [];
  const sparks: THREE.Sprite[] = [];
  const sparkVel: THREE.Vector3[] = [];

  const h = SCRAP_HEIGHT[kind];
  const tints = SCRAP_TINT[kind];

  // Three shared chunk shapes, reused across every piece.
  const shapes: THREE.BufferGeometry[] = [
    rbox(0.16, 0.11, 0.13, 0.035, 1),
    new THREE.IcosahedronGeometry(0.1, 0),
    new THREE.CylinderGeometry(0.085, 0.085, 0.07, 6),
  ];
  geos.push(...shapes);

  const chunkMats = tints.map((c) => toonMat(c, { ramp: 'hard3', flatShading: true }));

  const n = SCRAP_COUNT[kind];
  for (let i = 0; i < n; i++) {
    const geo = shapes[i % shapes.length];
    const mesh = new THREE.Mesh(geo, chunkMats[i % chunkMats.length]);
    mesh.castShadow = true;
    const a = (i / n) * TAU + Math.random() * 0.6;
    const sc = 0.7 + Math.random() * 0.7;
    mesh.scale.setScalar(sc);
    mesh.position.set(Math.cos(a) * 0.08, h + (Math.random() - 0.5) * 0.2, Math.sin(a) * 0.08);
    mesh.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
    root.add(mesh);
    chunks.push({
      mesh,
      vel: new THREE.Vector3(Math.cos(a) * (1.6 + Math.random() * 1.6), 2.4 + Math.random() * 2.6, Math.sin(a) * (1.6 + Math.random() * 1.6)),
      spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
      base: sc,
    });
  }

  // Sparks.
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Sprite(spriteMat('sparkSprite', i % 3 === 0 ? PAL.overdriveHot : PAL.droneTrim, true));
    s.position.set(0, h, 0);
    s.scale.setScalar(0.22);
    root.add(s);
    sparks.push(s);
    const a = Math.random() * TAU;
    const p = Math.random() * 0.9;
    sparkVel.push(new THREE.Vector3(Math.cos(a) * (2 + p * 3), 1.5 + Math.random() * 3.4, Math.sin(a) * (2 + p * 3)));
  }

  // One expanding shock ring.
  const ringMat = spriteMat('ringSprite', PAL.droneTrim, true).clone();
  mats.push(ringMat);
  const ring = new THREE.Sprite(ringMat);
  ring.position.y = h;
  ring.scale.setScalar(0.2);
  root.add(ring);

  let life = 0;

  return {
    root,
    update(dt: number): boolean {
      const d = Math.min(dt, 0.05);
      life += d;
      const fade = Math.max(0, Math.min(1, (BURST_LIFE - life) / 0.5));

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        c.vel.y -= 17 * d;
        c.mesh.position.addScaledVector(c.vel, d);
        if (c.mesh.position.y < 0.07 && c.vel.y < 0) {
          c.mesh.position.y = 0.07;
          c.vel.y = -c.vel.y * 0.44;
          c.vel.x *= 0.7;
          c.vel.z *= 0.7;
          c.spin.multiplyScalar(0.65);
        }
        c.mesh.rotation.x += c.spin.x * d;
        c.mesh.rotation.y += c.spin.y * d;
        c.mesh.rotation.z += c.spin.z * d;
        c.mesh.scale.setScalar(c.base * fade);
      }

      const sparkFade = Math.max(0, 1 - life / 0.55);
      for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i];
        const v = sparkVel[i];
        v.y -= 9 * d;
        s.position.addScaledVector(v, d);
        const k = 0.24 * sparkFade * (0.6 + 0.4 * Math.sin(i * 2.3 + life * 26));
        s.scale.set(k, k, 1);
        s.visible = sparkFade > 0.01;
      }

      const rk = Math.min(1, life / 0.32);
      ring.scale.setScalar(0.25 + rk * 2.1);
      ringMat.opacity = (1 - rk) * 0.85;
      ring.visible = rk < 1;

      return life < BURST_LIFE;
    },
    dispose(): void {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      root.clear();
    },
  };
}
