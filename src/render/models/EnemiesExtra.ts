/**
 * RIVET RUSH: SKY SALVAGE — the second wave of hostile salvage-bots.
 *
 * Five more machines, each readable from silhouette alone at the fixed
 * 48-degree game camera and, crucially, never confusable with a Sparkie:
 *
 *   skitter    wide flat carapace scuttling on four two-segment legs
 *   lobber     squat armoured mortar with a thick barrel that elevates + recoils
 *   splitter   fat pod visibly clamped together from two halves
 *   snatcher   hunched flyer with two big grabber claws and a holding cage
 *   warden     tall obelisk inside a slowly rotating ring halo + orbiting nodes
 *
 * COLOUR LANGUAGE (this is a live bug fix — players were mistaking enemies for
 * the rescuable Sparkies). Friendlies are cream/cyan soft rounded blobs with big
 * soft eyes. Everything in this file is violet (PAL.droneShell /
 * PAL.droneShellDark) with magenta trim (PAL.droneTrim) and a HARD ANGULAR eye —
 * a chevron or wedge slit in PAL.droneEyeAngry, never a soft round pupil. Every
 * shape additionally carries spikes, blades or chevrons, so silhouette spikiness
 * is a second, colour-blind-safe "this one bites" channel. They are still goofy:
 * grumpy wind-up toys, not horror.
 *
 * CONVENTIONS (identical to Enemies.ts)
 *  - Model origin sits on the GROUND (y = 0) and the model builds upward, so a
 *    game object placed on the ground plane looks right with no extra offset.
 *    Flyers carry their own hover height internally; the exact value is
 *    published as `root.userData.hoverOffset` if the game wants to fly the root
 *    itself instead (subtract it in that case).
 *  - Nothing allocates in update(): every Vector3/Color scratch is made in the
 *    constructor or at module scope.
 *  - Shared cached materials are NEVER mutated. Anything that flashes, pulses or
 *    charges is requested with `unique: true` (or `.clone()`d for sprites).
 *  - Every instance gets a random phase offset, so a pack never moves in lockstep.
 *
 * The small geometry helpers and the hover/flash/stun base class below are
 * deliberate copies of the ones in Enemies.ts: those are module-private there,
 * and this file is not allowed to edit that one. Keep the two in sync by hand if
 * the house style ever changes.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAL } from '../Palette';
import { getTexture } from '../Textures';
import { glowMat, outlineGroup, roundedBoxGeometry, spriteMat, toonMat } from '../Materials';
import type { ToonOptions } from '../Materials';
import type { EnemyAnimState, EnemyModel } from './Enemies';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ExtraEnemyKind = 'skitter' | 'lobber' | 'splitter' | 'snatcher' | 'warden';

// ---------------------------------------------------------------------------
// Small shared helpers (mirrors of the private ones in Enemies.ts)
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
 * position/normal/uv.
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

/**
 * A four-sided cone: the workhorse "spike" of this file. Chunky, faceted and
 * angular — never a smooth needle. Apex points along +Y before `place()`.
 */
function spike(radius: number, height: number): THREE.BufferGeometry {
  return new THREE.ConeGeometry(radius, height, 4, 1);
}

interface Flasher {
  mat: THREE.MeshToonMaterial;
  base: THREE.Color;
  baseIntensity: number;
}

interface Pose {
  /** Primary pitch in radians. Meaning is per-enemy — see each pose table. */
  lean: number;
  /** Extra hover height / squat. */
  rise: number;
  /** Body squash (1 = neutral, >1 = puffed up). */
  squash: number;
  /** Eye / charge brightness (1 = normal alert). */
  eye: number;
}

const POSE_NEUTRAL: Pose = { lean: 0, rise: 0, squash: 1, eye: 1 };

// ---------------------------------------------------------------------------
// Base class — hover rig, hit flash, stun blend, dizzy stars, disposal
// ---------------------------------------------------------------------------

abstract class BaseExtraEnemy implements EnemyModel {
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

  constructor(kind: ExtraEnemyKind) {
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
    if (!cast) mesh.userData.noShadow = true;
    return mesh;
  }

  /** Unlit additive FX mesh: never outlined, never shadow-casting. */
  protected fx(g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(this.reg(g), m);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noShadow = true;
    mesh.userData.noOutline = true;
    return mesh;
  }

  /** A cloned (therefore safely animatable) additive glow material. */
  protected glow(color: number, opacity: number): THREE.MeshBasicMaterial {
    const m = glowMat(color, opacity, true).clone();
    this.uniqueMats.add(m);
    return m;
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
// 1. SKITTER — the ground crawler. ~0.88u wide, ~0.75u long, ~0.45u tall.
//
// Looks like: a violet beetle carapace barely off the floor, riding on four
// two-segment legs whose knees poke up ABOVE its back like a spider's. An
// angular magenta chevron visor glares out of the front of the shell, two little
// mandible spikes scissor in front of that, and a row of swept blades and a
// three-spike dorsal ridge break up the shell. It is the only ground-hugging
// enemy in the game, so the silhouette is deliberately the exact opposite of
// every flyer: wide, flat and leggy.
// Animates: a real four-legged gait — diagonal pairs (front-left + rear-right,
// then the other two), hips swinging fore/aft while the thigh lifts and the shin
// tucks on the recovery half of each stride. It does not walk steadily: a sharp
// burst wave (raised to a high power, so it is mostly "off") speeds the gait up
// and lurches the body forward, which is what makes it read as "scuttling".
// Telegraph rears the front half up and spreads the mandibles; attack slams the
// body forward and snaps them shut; stunned it sprawls flat on its belly with
// all four legs splayed out sideways.
// ---------------------------------------------------------------------------

/** lean = body pitch (negative rears up) · rise = ride height · squash · eye = visor. */
const SKITTER_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0, rise: 0, squash: 1, eye: 0.45 },
  chase: { lean: 0.2, rise: -0.02, squash: 0.95, eye: 1.15 },
  telegraph: { lean: -0.44, rise: 0.09, squash: 1.12, eye: 1.9 },
  attack: { lean: 0.5, rise: -0.05, squash: 0.9, eye: 2.4 },
  stunned: { lean: 0.1, rise: -0.15, squash: 0.82, eye: 0.05 },
  hurt: { lean: -0.28, rise: 0.04, squash: 1.1, eye: 1.6 },
  dying: { lean: 0.2, rise: -0.08, squash: 0.9, eye: 0 },
};

/**
 * Resting joint angles, in the leg's own frame (local +X points outward).
 * Tuned so the toe spike (0.35 out along the shin) lands at y ≈ 0.02 with the
 * hip at y = 0.22: 0.22 + 0.18·sin(THIGH) + 0.35·sin(THIGH + KNEE) ≈ 0.02.
 */
const THIGH_BASE = 0.75;
const KNEE_BASE = -1.93;
/** Hip layout: [x side, z side, gait pair]. Diagonal pairs share a phase. */
const SKITTER_LEGS: readonly (readonly [number, number, number])[] = [
  [-1, 1, 0], [1, 1, 1], [-1, -1, 1], [1, -1, 0],
];

class Skitter extends BaseExtraEnemy {
  private readonly hips: THREE.Group[] = [];
  private readonly thighs: THREE.Group[] = [];
  private readonly knees: THREE.Group[] = [];
  private readonly legYaw: number[] = [];
  private readonly legSide: number[] = [];
  private readonly legFront: number[] = [];
  private readonly legPhase: number[] = [];
  private readonly mandL = new THREE.Group();
  private readonly mandR = new THREE.Group();
  private readonly visorMat: THREE.MeshToonMaterial;

  private gait = Math.random() * TAU;
  private lean = 0;
  private rise = 0;
  private squash = 1;
  private glowK = 0.45;
  private pinch = 0.15;

  constructor() {
    super('skitter');
    this.hoverOffset = 0;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPanel'), emissive: PAL.droneShellDark, emissiveIntensity: 0.2, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3 }, true);
    this.visorMat = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.9 });

    // --- carapace: shell dome + snout plate + tipped-up tail plate ----------
    const carapace = this.mesh(mergeParts([
      place(rbox(0.42, 0.17, 0.46, 0.075, 2), 0, 0.26, 0),
      place(rbox(0.28, 0.12, 0.2, 0.05, 1), 0, 0.245, 0.25, 0.24),
      place(rbox(0.26, 0.1, 0.2, 0.045, 1), 0, 0.285, -0.26, -0.32),
    ]), shell, true, true);
    this.body.add(carapace);

    // Flat belly pan, so the underside is not hollow when the camera swings low.
    const belly = this.mesh(place(rbox(0.32, 0.09, 0.34, 0.04, 1), 0, 0.16, 0), dark, false);
    this.body.add(belly);

    // Dorsal ridge (three back-swept spikes) + two swept flank blades. All the
    // "do not pet me" cues merged into one magenta draw call.
    const spikes: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      spikes.push(place(spike(0.05, 0.15 - i * 0.02), 0, 0.36 - i * 0.005, 0.06 - i * 0.13, -0.5));
    }
    for (const sx of [-1, 1]) {
      spikes.push(place(rbox(0.055, 0.11, 0.3, 0.025, 1), sx * 0.22, 0.28, -0.03, 0, sx * 0.28, sx * -0.5));
      // forward-pointing shoulder barbs
      spikes.push(place(spike(0.04, 0.16), sx * 0.19, 0.27, 0.2, Math.PI / 2, sx * -0.45));
    }
    const ridge = this.mesh(mergeParts(spikes), trim);
    this.body.add(ridge);

    // --- face: hard chevron visor under a dark angular brow ----------------
    const brow = this.mesh(place(rbox(0.32, 0.055, 0.09, 0.02, 1), 0, 0.345, 0.27, -0.22), dark, false);
    this.body.add(brow);
    const visor = this.mesh(mergeParts([
      place(rbox(0.15, 0.05, 0.035, 0.012, 1), -0.076, 0.3, 0.325, 0, 0, -0.5),
      place(rbox(0.15, 0.05, 0.035, 0.012, 1), 0.076, 0.3, 0.325, 0, 0, 0.5),
    ]), this.visorMat, false);
    this.body.add(visor);

    // --- mandibles: two forward spikes on their own pivots ------------------
    const mandGeo = this.reg(place(spike(0.045, 0.18), 0, 0, 0.09, Math.PI / 2));
    for (const [pivot, sx] of [[this.mandL, -1] as const, [this.mandR, 1] as const]) {
      const m = new THREE.Mesh(mandGeo, trim);
      m.castShadow = true;
      pivot.add(m);
      pivot.position.set(sx * 0.11, 0.22, 0.26);
      this.body.add(pivot);
    }

    // --- four legs ----------------------------------------------------------
    // Each leg is built once in a canonical frame where local +X points straight
    // out from the body; the hip group's yaw then aims that frame at the corner.
    const thighGeo = this.reg(mergeParts([
      new THREE.SphereGeometry(0.055, 10, 8),
      place(rbox(0.18, 0.075, 0.085, 0.03, 1), 0.09, 0, 0),
    ]));
    const shinGeo = this.reg(mergeParts([
      new THREE.SphereGeometry(0.048, 10, 8),
      place(rbox(0.23, 0.055, 0.065, 0.025, 1), 0.115, 0, 0),
      // clawed toe spike, pointing along the shin (i.e. down at rest)
      place(spike(0.05, 0.13), 0.29, 0, 0, 0, 0, -Math.PI / 2),
    ]));

    for (let i = 0; i < SKITTER_LEGS.length; i++) {
      const [sx, sz] = SKITTER_LEGS[i];
      const pair = SKITTER_LEGS[i][2];
      // Aim local +X at (dx, dz): rotation.y = atan2(-dz, dx).
      const dx = sx * 0.82;
      const dz = sz * 0.58;
      const yaw = Math.atan2(-dz, dx);

      const hip = new THREE.Group();
      hip.position.set(sx * 0.11, 0.22, sz * 0.13);
      hip.rotation.y = yaw;

      const thighPivot = new THREE.Group();
      thighPivot.rotation.z = THIGH_BASE;
      const thigh = new THREE.Mesh(thighGeo, dark);
      thigh.castShadow = true;
      thighPivot.add(thigh);

      const kneePivot = new THREE.Group();
      kneePivot.position.x = 0.18;
      kneePivot.rotation.z = KNEE_BASE;
      const shin = new THREE.Mesh(shinGeo, shell);
      shin.castShadow = true;
      kneePivot.add(shin);

      thighPivot.add(kneePivot);
      hip.add(thighPivot);
      this.body.add(hip);

      this.hips.push(hip);
      this.thighs.push(thighPivot);
      this.knees.push(kneePivot);
      this.legYaw.push(yaw);
      this.legSide.push(sx);
      this.legFront.push(sz);
      this.legPhase.push(pair * Math.PI);
    }

    this.addOutlines();

    // Two little exhaust embers under the tail (after outlines: pure light).
    const emberGeo = this.reg(new THREE.SphereGeometry(0.045, 8, 6));
    for (const sx of [-1, 1]) {
      const e = this.fx(emberGeo, glowMat(PAL.droneTrim, 0.65));
      e.position.set(sx * 0.08, 0.27, -0.34);
      e.scale.set(1, 0.7, 1.3);
      this.body.add(e);
    }

    this.addDizzy(0.52, 0.2);
    this.root.userData.hoverOffset = 0;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = SKITTER_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 11, d);
    this.rise = approach(this.rise, p.rise, 9, d);
    this.squash = approach(this.squash, p.squash, 11, d);
    this.glowK = approach(this.glowK, p.eye, 9, d);

    // Bursty scuttle: a pulse train raised to a high power is mostly "off", so
    // the legs go still, then explode into a fast shuffle, then still again.
    const burst = Math.pow(0.5 + 0.5 * Math.sin(t * (1.7 + intensity * 2.4) * this.rate + this.phase), 6);
    const drive = (0.3 + intensity * 0.85) * (0.3 + burst) * (1 - s * 0.96);
    this.gait = (this.gait + d * (5 + drive * 26)) % TAU;

    // Body ride: low bob at twice the stride rate, plus a forward lurch on each
    // burst and a downward slump while stunned.
    const bob = Math.abs(Math.sin(this.gait)) * 0.02 * drive;
    this.rig.position.set(0, this.rise + bob - s * 0.14, burst * drive * 0.06);
    this.rig.rotation.set(
      this.lean * 0.5 + s * 0.12,
      0,
      Math.sin(this.gait) * 0.07 * drive + s * 0.34,
    );
    this.body.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));

    // Rearing: when the pose leans back, the front pair paws at the air.
    const rearK = Math.max(0, -this.lean) * (1 - s);

    for (let i = 0; i < this.hips.length; i++) {
      const ph = this.gait + this.legPhase[i];
      const swing = Math.sin(ph) * (0.14 + drive * 0.24) * (1 - s);
      // Lift is only the positive half of the cosine, so each leg spends most of
      // its cycle planted and snaps up quickly on the recovery stroke.
      const lift = Math.max(0, Math.cos(ph)) * (0.3 + drive * 0.55) * (1 - s);
      const paw = this.legFront[i] > 0 ? rearK * (1.5 + Math.sin(t * 11 + i * 2.3) * 0.35) : rearK * -0.2;

      // Positive `swing` must always push the foot forward, and a hip yaw turns
      // the opposite way on the two sides — hence the per-leg side factor.
      this.hips[i].rotation.y = this.legYaw[i] - this.legSide[i] * swing;
      this.thighs[i].rotation.z = THIGH_BASE + lift * 0.5 + paw - s * 0.56;
      this.knees[i].rotation.z = KNEE_BASE - lift * 0.32 - paw * 0.4 + s * 1.25;
    }

    // Mandibles: idle chewing, wide on telegraph, snapped shut on attack.
    const pinchTarget = state === 'attack' ? 0.55
      : state === 'telegraph' ? -0.45
        : 0.12 + Math.sin(t * 3.4 * this.rate + this.phase) * 0.12;
    this.pinch = approach(this.pinch, pinchTarget * (1 - s) - s * 0.5, state === 'attack' ? 24 : 9, d);
    this.mandL.rotation.y = this.pinch;
    this.mandR.rotation.y = -this.pinch;
    this.mandL.rotation.x = -this.pinch * 0.3 + s * 0.5;
    this.mandR.rotation.x = this.mandL.rotation.x;

    // Angular visor glare.
    this.visorMat.emissiveIntensity = (0.35 + this.glowK * 0.9) * (1 - s * 0.92);
  }
}

// ---------------------------------------------------------------------------
// 2. LOBBER — stationary artillery. ~1.3u tall, ~1.05u footprint.
//
// Looks like: a squat armoured mortar bolted to the deck. A hexagonal pad with
// three splayed outriggers ending in clawed feet, a hazard-striped loading band,
// an armoured turret block with a hard chevron visor and a brow plate, and a
// THICK short barrel sitting in trunnion cheeks with two blade fins along its
// top and a fat muzzle brake on the end. A little rack of shells rides on the
// back. Nothing on it is round and friendly.
// Animates: idles with a slow scanning yaw and the barrel drooping at rest. On
// TELEGRAPH the base squats, the barrel visibly ELEVATES to a high lob angle and
// a magenta shell inflates and brightens inside the muzzle behind expanding
// warning rings. On ATTACK the shell vanishes, a muzzle flash pops and the whole
// barrel slams back along its own axis and eases forward again (a spring, kicked
// by the state change — no timer to desync). Stunned it flops the barrel down
// into the dirt and the loading band goes dark.
//
// `root.userData.muzzle` is an Object3D parented inside the recoil slide, so its
// world transform is exactly where the projectile should be born, recoil and all.
// ---------------------------------------------------------------------------

/** lean = barrel elevation (positive = up) · rise = base squat · squash · eye = visor. */
const LOBBER_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0.12, rise: 0, squash: 1, eye: 0.25 },
  chase: { lean: 0.22, rise: 0.01, squash: 1.01, eye: 0.55 },
  telegraph: { lean: 0.66, rise: -0.07, squash: 0.9, eye: 1 },
  attack: { lean: 0.52, rise: 0.06, squash: 1.07, eye: 0.2 },
  stunned: { lean: -0.34, rise: -0.14, squash: 0.84, eye: 0 },
  hurt: { lean: 0.08, rise: 0.02, squash: 1.06, eye: 0.7 },
  dying: { lean: -0.5, rise: -0.08, squash: 0.9, eye: 0 },
};

class Lobber extends BaseExtraEnemy {
  private readonly turret = new THREE.Group();
  private readonly barrel = new THREE.Group();
  private readonly slide = new THREE.Group();
  private readonly shell: THREE.Mesh;
  private readonly shellMat: THREE.MeshToonMaterial;
  private readonly shellHalo: THREE.Mesh;
  private readonly shellHaloMat: THREE.MeshBasicMaterial;
  private readonly flashCone: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly flashSprite: THREE.Sprite;
  private readonly flashSpriteMat: THREE.SpriteMaterial;
  private readonly rings: THREE.Sprite[] = [];
  private readonly ringMats: THREE.SpriteMaterial[] = [];
  private readonly bandMat: THREE.MeshToonMaterial;
  private readonly visorMat: THREE.MeshToonMaterial;

  private pitch = 0.12;
  private rise = 0;
  private squash = 1;
  private charge = 0;
  private recoil = 0;
  private yaw = 0;
  private glowK = 0.25;
  private prevState: EnemyAnimState = 'idle';

  constructor() {
    super('lobber');
    this.hoverOffset = 0;

    const shellMatBody = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPlate'), emissive: PAL.droneShellDark, emissiveIntensity: 0.16, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.28 }, true);
    this.bandMat = this.toon(PAL.hazard, {
      unique: true, map: getTexture('hazardStripe'), emissive: PAL.hazard, emissiveIntensity: 0.2,
    });
    this.visorMat = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.8 });
    this.shellMat = this.toon(PAL.droneEye, {
      unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3, transparent: true, opacity: 0.92,
    });

    // --- base: hex pad + three splayed outriggers ---------------------------
    const baseParts: THREE.BufferGeometry[] = [
      place(new THREE.CylinderGeometry(0.34, 0.46, 0.18, 6), 0, 0.09, 0),
    ];
    const footParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + Math.PI / 6;
      const cx = Math.cos(a);
      const cz = -Math.sin(a);
      baseParts.push(place(rbox(0.34, 0.11, 0.17, 0.04, 1), cx * 0.32, 0.09, cz * 0.32, 0, a, 0));
      // clawed anchor foot: a pad with a downward toe spike
      footParts.push(place(rbox(0.2, 0.1, 0.24, 0.04, 1), cx * 0.44, 0.05, cz * 0.44, 0, a, 0));
      footParts.push(place(spike(0.06, 0.16), cx * 0.5, 0.11, cz * 0.5, Math.PI));
    }
    this.body.add(this.mesh(mergeParts(baseParts), dark, true, true));
    this.body.add(this.mesh(mergeParts(footParts), trim, true, true));

    // --- armoured hull + hazard loading band --------------------------------
    const hull = this.mesh(place(new THREE.CylinderGeometry(0.32, 0.42, 0.44, 6), 0, 0.4, 0), shellMatBody, true, true);
    this.body.add(hull);
    const band = this.mesh(place(new THREE.CylinderGeometry(0.44, 0.44, 0.1, 6), 0, 0.34, 0), this.bandMat, false);
    this.body.add(band);
    // Armour chevrons stuck on the hull so it is not a bare hexagon.
    const chevrons: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      chevrons.push(place(rbox(0.2, 0.12, 0.06, 0.02, 1), Math.sin(a) * 0.36, 0.52, Math.cos(a) * 0.36, 0, a, 0.5));
    }
    this.body.add(this.mesh(mergeParts(chevrons), trim, false));

    // Shell rack on the back — three little spare rounds, so it reads "mortar".
    const rack: THREE.BufferGeometry[] = [place(rbox(0.3, 0.09, 0.16, 0.03, 1), 0, 0.66, -0.32, 0.2)];
    for (let i = 0; i < 3; i++) {
      rack.push(place(spike(0.05, 0.16), (i - 1) * 0.1, 0.76, -0.34, -0.25));
    }
    this.body.add(this.mesh(mergeParts(rack), dark, true));

    // --- turret: yaws as a unit --------------------------------------------
    this.turret.position.y = 0.62;
    this.body.add(this.turret);

    const mantlet = this.mesh(place(rbox(0.46, 0.34, 0.36, 0.08, 2), 0, 0.2, -0.02), shellMatBody, true, true);
    this.turret.add(mantlet);
    // Trunnion cheeks the barrel is slung between.
    const cheekGeo = this.reg(rbox(0.09, 0.3, 0.3, 0.035, 1));
    for (const sx of [-1, 1]) {
      const c = new THREE.Mesh(cheekGeo, dark);
      c.position.set(sx * 0.27, 0.22, 0.02);
      c.castShadow = true;
      this.turret.add(c);
    }
    // Angular brow + chevron visor: the face of the gun.
    const gunBrow = this.mesh(place(rbox(0.34, 0.07, 0.1, 0.025, 1), 0, 0.33, 0.16, -0.3), dark, false);
    this.turret.add(gunBrow);
    const gunVisor = this.mesh(mergeParts([
      place(rbox(0.16, 0.055, 0.04, 0.015, 1), -0.08, 0.25, 0.19, 0, 0, -0.5),
      place(rbox(0.16, 0.055, 0.04, 0.015, 1), 0.08, 0.25, 0.19, 0, 0, 0.5),
    ]), this.visorMat, false);
    this.turret.add(gunVisor);
    // Two horn spikes on the turret shoulders, plus the rangefinder mast that
    // gives the resting silhouette its height.
    const horns: THREE.BufferGeometry[] = [
      place(rbox(0.055, 0.32, 0.055, 0.02, 1), -0.02, 0.52, -0.18, 0.12),
      place(rbox(0.18, 0.06, 0.11, 0.025, 1), -0.02, 0.66, -0.16, 0, 0, 0.3),
    ];
    for (const sx of [-1, 1]) {
      horns.push(place(spike(0.05, 0.2), sx * 0.2, 0.4, -0.06, -0.35, 0, sx * 0.4));
    }
    this.turret.add(this.mesh(mergeParts(horns), trim));

    // --- barrel: elevates on the trunnions, recoils along its own axis ------
    this.barrel.position.y = 0.22;
    this.turret.add(this.barrel);
    this.barrel.add(this.slide);

    const tube = this.mesh(mergeParts([
      // main tube
      place(new THREE.CylinderGeometry(0.14, 0.16, 0.62, 12), 0, 0, 0.31, Math.PI / 2),
      // muzzle brake
      place(new THREE.CylinderGeometry(0.19, 0.19, 0.14, 12), 0, 0, 0.66, Math.PI / 2),
      // breech block
      place(rbox(0.28, 0.26, 0.22, 0.06, 1), 0, 0, -0.06),
    ]), shellMatBody, true);
    this.slide.add(tube);
    // Two blade fins along the top of the tube + a chevron collar.
    const fins = this.mesh(mergeParts([
      place(rbox(0.045, 0.14, 0.34, 0.02, 1), -0.09, 0.14, 0.3, -0.12),
      place(rbox(0.045, 0.14, 0.34, 0.02, 1), 0.09, 0.14, 0.3, -0.12),
      place(new THREE.CylinderGeometry(0.185, 0.185, 0.06, 12), 0, 0, 0.16, Math.PI / 2),
    ]), trim, true);
    this.slide.add(fins);

    // The world anchor the game spawns the projectile from.
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0, 0.78);
    this.slide.add(muzzle);

    this.addOutlines();

    // --- charge + muzzle FX (after the outline pass) ------------------------
    this.shell = this.fx(new THREE.SphereGeometry(0.12, 14, 10), this.shellMat);
    this.shell.position.z = 0.6;
    this.slide.add(this.shell);
    this.shellHaloMat = this.glow(PAL.droneTrim, 0.55);
    this.shellHalo = this.fx(new THREE.SphereGeometry(0.19, 12, 10), this.shellHaloMat);
    this.shellHalo.position.z = 0.6;
    this.slide.add(this.shellHalo);

    this.flashMat = this.glow(PAL.droneEye, 0.9);
    this.flashCone = this.fx(place(spike(0.24, 0.42), 0, 0, 0.21, Math.PI / 2), this.flashMat);
    this.flashCone.position.z = 0.76;
    this.flashCone.visible = false;
    this.slide.add(this.flashCone);

    this.flashSpriteMat = spriteMat('glowSprite', PAL.droneTrim, true).clone();
    this.uniqueMats.add(this.flashSpriteMat);
    this.flashSprite = new THREE.Sprite(this.flashSpriteMat);
    this.flashSprite.position.z = 0.78;
    this.flashSprite.scale.setScalar(0.01);
    this.slide.add(this.flashSprite);

    for (let i = 0; i < 2; i++) {
      const m = spriteMat('ringSprite', PAL.droneTrim, true).clone();
      this.uniqueMats.add(m);
      this.ringMats.push(m);
      const sp = new THREE.Sprite(m);
      sp.position.z = 0.62;
      sp.scale.setScalar(0.01);
      this.slide.add(sp);
      this.rings.push(sp);
    }

    this.addDizzy(1.2, 0.26);
    this.root.userData.hoverOffset = 0;
    this.root.userData.muzzle = muzzle;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = LOBBER_POSES[state];
    const s = this.stun;
    this.pitch = approach(this.pitch, p.lean, state === 'telegraph' ? 4.5 : 8, d);
    this.rise = approach(this.rise, p.rise, 9, d);
    this.squash = approach(this.squash, p.squash, 10, d);
    this.glowK = approach(this.glowK, p.eye, 8, d);

    // Charge only climbs while telegraphing; it is dumped the instant it fires.
    const chargeTarget = state === 'telegraph' ? Math.max(0.12, intensity) : 0;
    this.charge = approach(this.charge, chargeTarget, state === 'attack' ? 30 : 7, d);

    // Recoil spring: kicked by the transition INTO attack, then eased back. The
    // kick is state-driven, so it can never drift out of sync with the AI.
    if (state === 'attack' && this.prevState !== 'attack') this.recoil = 1;
    this.prevState = state;
    this.recoil = approach(this.recoil, 0, 6.5, d);

    // Whole machine: idle hum, squat on telegraph, a hard shove on firing.
    // Positive-only hum: a bolted-down turret must never sink through the deck.
    const hum = (0.5 + 0.5 * Math.sin(t * 1.5 * this.rate + this.phase)) * 0.02;
    const shake = state === 'telegraph' ? Math.sin(t * 44 + this.phase) * 0.016 * this.charge : 0;
    this.rig.position.set(shake, this.rise + hum - this.recoil * 0.05 - s * 0.07, -this.recoil * 0.07);
    this.rig.rotation.set(s * 0.16 - this.recoil * 0.12, 0, s * 0.5);
    this.body.scale.set(1 + (1 - this.squash) * 0.5, this.squash, 1 + (1 - this.squash) * 0.5);

    // Idle scan sweep; snaps dead ahead as soon as it has something to shoot.
    const yawTarget = state === 'idle' ? Math.sin(t * 0.5 * this.rate + this.phase) * 0.8 : 0;
    this.yaw = approach(this.yaw, yawTarget, state === 'idle' ? 1.8 : 7, d);
    this.turret.rotation.y = this.yaw;

    // Barrel elevation (negative rotation.x lifts the +Z axis) + recoil slide.
    const jitter = Math.sin(t * 30 + this.phase) * 0.01 * this.charge;
    this.barrel.rotation.x = -(this.pitch + jitter) + s * 0.75;
    this.slide.position.z = -this.recoil * 0.24;

    // Shell charging in the muzzle.
    const c = this.charge;
    const wobble = 1 + Math.sin(t * (9 + c * 34)) * 0.09 * c;
    this.shell.visible = c > 0.02;
    this.shellHalo.visible = this.shell.visible;
    this.shell.scale.setScalar((0.2 + c * 1.1) * wobble);
    this.shellMat.emissiveIntensity = 0.25 + c * 4;
    this.shellMat.opacity = 0.5 + c * 0.5;
    this.shellHalo.scale.setScalar((0.35 + c * 1.4) * wobble);
    this.shellHaloMat.opacity = 0.1 + c * 0.5;

    // Expanding warning rings around the muzzle, faster as the shot nears.
    for (let i = 0; i < this.rings.length; i++) {
      const k = (t * (0.8 + c * 2) + i * 0.5) % 1;
      const vis = c > 0.05;
      this.rings[i].visible = vis;
      if (!vis) continue;
      const sc = 0.2 + k * (0.5 + c * 0.8);
      this.rings[i].scale.set(sc, sc, 1);
      this.ringMats[i].opacity = (1 - k) * c * 0.9;
    }

    // Muzzle flash: one hard pop that dies with the recoil spring.
    const f = this.recoil * this.recoil;
    this.flashCone.visible = f > 0.01;
    this.flashCone.scale.set(0.6 + f * 0.9, 0.5 + f * 1.2, 0.6 + f * 0.9);
    this.flashMat.opacity = f * 0.95;
    this.flashSprite.visible = this.flashCone.visible;
    const fs = 0.3 + f * 1.15;
    this.flashSprite.scale.set(fs, fs, 1);
    this.flashSpriteMat.opacity = f;

    // Loading band strobes toward the shot; visor glares.
    const strobe = 0.5 + 0.5 * Math.sin(t * (3 + c * 24) + this.phase);
    this.bandMat.emissiveIntensity = (0.15 + strobe * (0.3 + c * 1.8)) * (1 - s * 0.85);
    this.visorMat.emissiveIntensity = (0.3 + this.glowK * 1.1) * (1 - s * 0.9);
  }
}

// ---------------------------------------------------------------------------
// 3. SPLITTER — the slow floater that becomes two. ~1.1u tall, ~0.85u wide.
//
// Looks like: a fat violet pod that is very obviously TWO HALVES bolted
// together — a bright magenta seam runs straight down the middle, four heavy
// C-clamps straddle it top and bottom, a line of bolt heads marches down the
// front, and four spikes stick straight out of the seam ring. Each half wears
// its own angular armour blade and half of a V-shaped angry visor, so the two
// halves glaring at you form one chevron. It looks pressurised and cross.
// Animates: floats slowly with a lazy tumble, and constantly strains — the two
// halves push apart and snap back, breathing against the clamps, and the seam
// glows brighter and strobes faster as `intensity` rises. Telegraph inflates it
// like it is about to burst; attack is a hard clench. Stunned it deflates,
// tips over and the seam goes dim.
//
// Splitting: `root.userData.canScale = true`. Everything (hover height, dizzy
// stars, FX) lives under `root`, so the game can simply
// `root.scale.setScalar(root.userData.childScale)` on the two children and the
// smaller pods hover at the right height automatically.
// ---------------------------------------------------------------------------

/** lean = pitch · rise = hover · squash = internal pressure · eye = seam glow. */
const SPLITTER_POSES: Record<EnemyAnimState, Pose> = {
  idle: POSE_NEUTRAL,
  chase: { lean: 0.16, rise: 0.02, squash: 1.05, eye: 1.3 },
  telegraph: { lean: -0.22, rise: 0.14, squash: 1.22, eye: 2.2 },
  attack: { lean: 0.3, rise: -0.06, squash: 0.86, eye: 2.8 },
  stunned: { lean: 0.3, rise: -0.26, squash: 0.85, eye: 0.1 },
  hurt: { lean: -0.2, rise: 0.05, squash: 1.16, eye: 1.8 },
  dying: { lean: 0, rise: 0.08, squash: 1.3, eye: 3.2 },
};

class Splitter extends BaseExtraEnemy {
  private readonly halfL = new THREE.Group();
  private readonly halfR = new THREE.Group();
  private readonly seamMat: THREE.MeshToonMaterial;
  private readonly seamGlow: THREE.Mesh;
  private readonly seamGlowMat: THREE.MeshBasicMaterial;
  private readonly visorMat: THREE.MeshToonMaterial;

  private lean = 0;
  private rise = 0;
  private puff = 1;
  private glowK = 1;
  private strain = 0;

  constructor() {
    super('splitter');
    this.hoverOffset = 0.66;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPanel'), emissive: PAL.droneShellDark, emissiveIntensity: 0.2, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.28 }, true);
    this.seamMat = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.8 });
    this.visorMat = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.9 });

    // --- the two halves -----------------------------------------------------
    // Built as separate mirrored geometries rather than one geometry with
    // scale.x = -1: a negative-determinant transform would flip the winding of
    // the inverted-hull outline and paint it over the model.
    for (const [half, sx] of [[this.halfL, -1] as const, [this.halfR, 1] as const]) {
      const shellMesh = this.mesh(mergeParts([
        place(rbox(0.34, 0.62, 0.6, 0.2, 3), sx * 0.175, 0, 0),
        // outer armour blade — angular, swept back
        place(rbox(0.1, 0.28, 0.32, 0.04, 1), sx * 0.34, 0.14, -0.03, 0, 0, sx * -0.5),
        // three cooling louvres low on the flank
        place(rbox(0.13, 0.05, 0.24, 0.02, 1), sx * 0.31, -0.16, 0.02, 0, 0, sx * 0.25),
      ]), shell, true, true);
      half.add(shellMesh);

      // Half of the angry chevron visor.
      const eye = this.mesh(
        place(rbox(0.17, 0.06, 0.05, 0.018, 1), sx * 0.11, 0.09, 0.31, 0, 0, sx * 0.55),
        this.visorMat, false,
      );
      half.add(eye);
      // Dark brow chip over it, so the eye is set into a scowl.
      const browChip = this.mesh(
        place(rbox(0.2, 0.055, 0.06, 0.02, 1), sx * 0.12, 0.17, 0.29, -0.2, 0, sx * 0.5),
        dark, false,
      );
      half.add(browChip);

      // Outward-pointing horn near the top of each half.
      const horn = this.mesh(place(spike(0.05, 0.2), sx * 0.2, 0.3, -0.04, 0, 0, sx * -0.7), trim);
      half.add(horn);

      this.body.add(half);
    }

    // --- the clamp assembly that holds them together ------------------------
    // Four C-clamps straddling the seam (two over the top, two under the belly)
    // plus the seam spikes, merged into one magenta mesh.
    const clampParts: THREE.BufferGeometry[] = [];
    for (const dz of [-0.18, 0.18]) {
      for (const flip of [0, Math.PI]) {
        clampParts.push(place(
          new THREE.TorusGeometry(0.34, 0.05, 6, 10, Math.PI * 0.62),
          0, 0, dz, 0, 0, Math.PI / 2 - Math.PI * 0.31 + flip,
        ));
      }
    }
    // Spikes out of the seam ring: up, down, front, back.
    clampParts.push(place(spike(0.055, 0.17), 0, 0.4, 0));
    clampParts.push(place(spike(0.055, 0.17), 0, -0.4, 0, Math.PI));
    clampParts.push(place(spike(0.055, 0.17), 0, 0, 0.39, Math.PI / 2));
    clampParts.push(place(spike(0.055, 0.17), 0, 0, -0.39, -Math.PI / 2));
    this.body.add(this.mesh(mergeParts(clampParts), trim, true));

    // Bolt heads down the front of the seam — the "this comes apart" cue.
    const bolts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const y = -0.22 + i * 0.11;
      bolts.push(place(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 6), 0, y, 0.3, Math.PI / 2));
    }
    bolts.push(place(rbox(0.07, 0.56, 0.06, 0.02, 1), 0, 0, 0.29));
    this.body.add(this.mesh(mergeParts(bolts), dark, false));

    // The seam itself: a thin slab in the gap, lit from inside.
    const seam = this.mesh(place(rbox(0.06, 0.6, 0.58, 0.05, 2), 0, 0, 0), this.seamMat, false);
    this.body.add(seam);

    this.addOutlines(0.03); // slightly finer ink: the children run at 0.6 scale

    // Additive bloom over the seam, added after the outline pass.
    this.seamGlowMat = this.glow(PAL.droneTrim, 0.5);
    this.seamGlow = this.fx(place(rbox(0.1, 0.64, 0.62, 0.06, 2), 0, 0, 0), this.seamGlowMat);
    this.body.add(this.seamGlow);

    this.addDizzy(0.5, 0.24);
    this.root.userData.hoverOffset = this.hoverOffset;
    this.root.userData.canScale = true;
    this.root.userData.childScale = 0.6;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = SPLITTER_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 6, d);
    this.rise = approach(this.rise, p.rise, 5.5, d);
    this.puff = approach(this.puff, p.squash, 7, d);
    this.glowK = approach(this.glowK, p.eye, 6, d);

    // Slow, heavy float with a lazy tumble — it is the least agile thing here.
    const bob = Math.sin(t * 1.35 * this.rate + this.phase) * 0.07;
    const sway = Math.sin(t * 0.83 * this.rate + this.phase * 1.6) * 0.05;
    this.rig.position.set(sway, this.hoverOffset + this.rise + bob - s * 0.3, 0);
    this.rig.rotation.set(
      this.lean + s * 0.55,
      Math.sin(t * 0.42 + this.phase) * 0.3,
      Math.sin(t * 1.05 * this.rate + this.phase) * 0.11 - s * 0.6,
    );

    // Pressure wobble: an out-of-phase squash on each axis so it never looks
    // like a simple pulsing sphere.
    const pressure = 0.03 + intensity * 0.05;
    const wx = 1 + Math.sin(t * 3.1 * this.rate + this.phase) * pressure;
    const wy = 1 + Math.sin(t * 2.6 * this.rate + this.phase + 2.1) * pressure;
    this.body.scale.set(this.puff * wx, this.puff * wy, this.puff * (2 - wx * 0.5 - wy * 0.5));

    // The halves strain against their clamps: a fast creak that gets wider with
    // intensity, plus a big shove out on telegraph.
    const creak = Math.sin(t * (5 + intensity * 9) * this.rate + this.phase);
    const strainTarget = (0.012 + intensity * 0.02 + Math.max(0, this.puff - 1) * 0.16) * (1 - s * 0.7);
    this.strain = approach(this.strain, strainTarget, 8, d);
    const gap = this.strain * (0.6 + 0.4 * creak);
    this.halfL.position.x = -gap;
    this.halfR.position.x = gap;
    this.halfL.rotation.z = gap * 0.5 + creak * 0.02;
    this.halfR.rotation.z = -gap * 0.5 - creak * 0.02;
    this.halfL.position.y = creak * 0.008;
    this.halfR.position.y = -creak * 0.008;

    // Seam: brighter and faster with intensity — the "about to pop" read.
    const strobe = 0.5 + 0.5 * Math.sin(t * (4 + intensity * 16) + this.phase);
    const seamK = (0.5 + this.glowK * 0.8 + strobe * (0.3 + intensity * 1.5)) * (1 - s * 0.88);
    this.seamMat.emissiveIntensity = seamK;
    this.seamGlowMat.opacity = (0.12 + intensity * 0.25 + strobe * 0.15) * (1 - s * 0.9);
    const sg = 1 + gap * 2.5;
    this.seamGlow.scale.set(sg, 1, 1);
    this.visorMat.emissiveIntensity = (0.4 + this.glowK * 0.7) * (1 - s * 0.9);
  }
}

// ---------------------------------------------------------------------------
// 4. SNATCHER — the Sparkie thief. ~1.2u tall span, ~0.9u wide.
//
// Looks like: a hunched violet flyer leaning forward like a heron, with a
// wedge-shaped nose, two angled thruster nacelles, a swept dorsal blade and two
// forward-jutting shoulder barbs. Hanging underneath on a heavy yoke are TWO BIG
// GRABBER CLAWS, each a hooked jaw with two talons, and slung between them is a
// little barred containment cage that glows when it has a passenger. Everything
// about it points forward and down: it wants to take something.
// Animates: hovers nose-down with a greedy flexing of the claws (they never stop
// opening and closing), leans harder the faster it chases, opens WIDE on
// telegraph, and clamps shut with a snap on attack while the whole frame recoils
// upward as if hauling something heavy. Stunned it tips sideways, the claws hang
// open and limp, and the cage light dies.
//
// `root.userData.claw` is an empty Object3D at the pinch point inside the cage —
// parent a captured Sparkie to it and it rides along correctly.
// `root.userData.cage` is the cage group (hide it, or flash it, as you like).
// ---------------------------------------------------------------------------

/** lean = forward hunch · rise = hover · squash · eye = visor glare. */
const SNATCH_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0.12, rise: 0, squash: 1, eye: 0.5 },
  chase: { lean: 0.4, rise: -0.04, squash: 0.98, eye: 1.2 },
  telegraph: { lean: -0.3, rise: 0.2, squash: 1.08, eye: 1.9 },
  attack: { lean: 0.55, rise: -0.16, squash: 0.94, eye: 2.4 },
  stunned: { lean: 0.2, rise: -0.34, squash: 0.9, eye: 0.05 },
  hurt: { lean: -0.28, rise: 0.08, squash: 1.1, eye: 1.6 },
  dying: { lean: 0.35, rise: 0.05, squash: 1, eye: 0 },
};

class Snatcher extends BaseExtraEnemy {
  private readonly clawL = new THREE.Group();
  private readonly clawR = new THREE.Group();
  private readonly tipL = new THREE.Group();
  private readonly tipR = new THREE.Group();
  private readonly cage = new THREE.Group();
  private readonly cageGlow: THREE.Mesh;
  private readonly cageGlowMat: THREE.MeshBasicMaterial;
  private readonly cageMat: THREE.MeshToonMaterial;
  private readonly visorMat: THREE.MeshToonMaterial;

  private lean = 0;
  private rise = 0;
  private squash = 1;
  private glowK = 0.5;
  private grip = -0.12;

  constructor() {
    super('snatcher');
    this.hoverOffset = 0.92;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPanel'), emissive: PAL.droneShellDark, emissiveIntensity: 0.18, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    const trim = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.3 }, true);
    this.visorMat = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.85 });
    this.cageMat = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.6 });

    // --- chassis: wedge hull + nose cone + tail boom, one draw call ---------
    const hull = this.mesh(mergeParts([
      place(rbox(0.44, 0.26, 0.54, 0.09, 2), 0, 0, -0.02),
      place(spike(0.22, 0.3), 0, -0.03, 0.38, Math.PI / 2),
      place(rbox(0.2, 0.16, 0.2, 0.05, 1), 0, 0.03, -0.34),
    ]), shell, true, true);
    this.body.add(hull);

    // Thruster nacelles, canted outward, with magenta vent chevrons.
    const nacelles: THREE.BufferGeometry[] = [];
    const vents: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      nacelles.push(place(rbox(0.17, 0.19, 0.36, 0.06, 1), sx * 0.32, 0.04, -0.04, 0, 0, sx * -0.24));
      vents.push(place(rbox(0.06, 0.07, 0.26, 0.02, 1), sx * 0.4, 0.14, -0.04, 0, 0, sx * -0.24));
      // forward shoulder barb — greedy, reaching
      vents.push(place(spike(0.05, 0.24), sx * 0.28, 0.06, 0.24, Math.PI / 2, sx * -0.3, 0));
    }
    this.body.add(this.mesh(mergeParts(nacelles), dark, true));
    this.body.add(this.mesh(mergeParts(vents), trim, true));

    // Swept dorsal blade — the tallest part of the silhouette.
    const finGeo = mergeParts([
      place(rbox(0.05, 0.24, 0.32, 0.02, 1), 0, 0.2, -0.1, -0.34),
      place(rbox(0.05, 0.14, 0.2, 0.02, 1), 0, 0.2, 0.16, 0.4),
    ]);
    this.body.add(this.mesh(finGeo, trim, true));

    // Hunched head: a dark block pushed forward and down, with a hard chevron
    // visor. Small, mean, and low — it looks like it is eyeing the floor.
    const head = this.mesh(place(rbox(0.28, 0.16, 0.24, 0.05, 2), 0, -0.04, 0.3, 0.25), dark, true);
    this.body.add(head);
    const visor = this.mesh(mergeParts([
      place(rbox(0.13, 0.05, 0.04, 0.015, 1), -0.06, -0.05, 0.42, 0, 0, -0.55),
      place(rbox(0.13, 0.05, 0.04, 0.015, 1), 0.06, -0.05, 0.42, 0, 0, 0.55),
    ]), this.visorMat, false);
    this.body.add(visor);

    // --- yoke + the two grabber claws --------------------------------------
    const yoke = this.mesh(mergeParts([
      place(rbox(0.42, 0.12, 0.24, 0.04, 1), 0, -0.2, 0.04),
      place(new THREE.CylinderGeometry(0.07, 0.09, 0.12, 8), 0, -0.26, 0.04),
    ]), dark, true);
    this.body.add(yoke);

    for (const [claw, tip, sx] of [[this.clawL, this.tipL, -1] as const, [this.clawR, this.tipR, 1] as const]) {
      // Upper jaw: a broad plate curving inward under the yoke.
      const jaw = this.mesh(mergeParts([
        place(rbox(0.13, 0.26, 0.18, 0.05, 1), 0, -0.13, 0),
        place(rbox(0.12, 0.12, 0.22, 0.04, 1), sx * -0.02, -0.26, 0.03, 0.4),
      ]), shell, true);
      claw.add(jaw);

      // Finger tip: curls a little further than the jaw, with two talons.
      const finger = this.mesh(mergeParts([
        place(rbox(0.1, 0.18, 0.12, 0.035, 1), sx * -0.03, -0.08, 0.01, 0, 0, sx * 0.3),
        place(spike(0.045, 0.15), sx * -0.08, -0.18, 0.06, Math.PI, 0, sx * 0.5),
        place(spike(0.04, 0.13), sx * -0.06, -0.17, -0.06, Math.PI, 0, sx * 0.5),
      ]), trim, true);
      tip.add(finger);
      tip.position.set(0, -0.28, 0.02);
      claw.add(tip);

      claw.position.set(sx * 0.19, -0.26, 0.05);
      this.body.add(claw);
    }

    // --- containment cage between the claws --------------------------------
    const bars: THREE.BufferGeometry[] = [
      place(new THREE.TorusGeometry(0.13, 0.018, 5, 12), 0, 0.11, 0, Math.PI / 2),
      place(new THREE.TorusGeometry(0.13, 0.018, 5, 12), 0, -0.11, 0, Math.PI / 2),
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      bars.push(place(new THREE.CylinderGeometry(0.016, 0.016, 0.22, 5), Math.sin(a) * 0.13, 0, Math.cos(a) * 0.13));
    }
    const cageMesh = this.mesh(mergeParts(bars), this.cageMat, false);
    this.cage.add(cageMesh);
    this.cage.position.set(0, -0.42, 0.04);
    this.body.add(this.cage);

    this.addOutlines();

    // Cage interior light + thruster glow (unlit, added after the outlines).
    this.cageGlowMat = this.glow(PAL.droneTrim, 0.4);
    this.cageGlow = this.fx(new THREE.SphereGeometry(0.11, 12, 10), this.cageGlowMat);
    this.cage.add(this.cageGlow);

    const wash = this.reg(new THREE.SphereGeometry(0.08, 10, 8));
    for (const sx of [-1, 1]) {
      const g = this.fx(wash, glowMat(PAL.droneTrim, 0.6));
      g.position.set(sx * 0.32, 0.02, -0.24);
      g.scale.set(1, 1, 0.7);
      this.body.add(g);
    }

    // The anchor the game parents a captured Sparkie to: dead centre of the cage.
    const clawAnchor = new THREE.Object3D();
    clawAnchor.position.set(0, -0.42, 0.04);
    this.body.add(clawAnchor);

    this.addDizzy(0.42, 0.24);
    this.root.userData.hoverOffset = this.hoverOffset;
    this.root.userData.claw = clawAnchor;
    this.root.userData.cage = this.cage;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = SNATCH_POSES[state];
    const s = this.stun;
    this.lean = approach(this.lean, p.lean, 8, d);
    this.rise = approach(this.rise, p.rise, 7, d);
    this.squash = approach(this.squash, p.squash, 9, d);
    this.glowK = approach(this.glowK, p.eye, 9, d);

    // Hover: a slightly nervous, hunting drift — quicker and tighter than the
    // splitter's lazy float.
    const bob = Math.sin(t * 2.5 * this.rate + this.phase) * 0.05;
    const sway = Math.sin(t * 1.7 * this.rate + this.phase * 1.4) * 0.045;
    const hoist = state === 'attack' ? this.grip * 0.12 : 0;
    this.rig.position.set(sway, this.hoverOffset + this.rise + bob + hoist - s * 0.34, 0);
    this.rig.rotation.set(
      this.lean + s * 0.4,
      Math.sin(t * 0.7 + this.phase) * 0.16,
      Math.sin(t * 1.4 * this.rate + this.phase) * 0.12 * (1 - s) + s * 0.95,
    );
    this.body.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));

    // Claws: never still. Positive `grip` closes both jaws inward.
    const gripTarget = state === 'attack' ? 0.2
      : state === 'telegraph' ? -0.55
        : state === 'chase' ? -0.3 + Math.sin(t * 4.5 * this.rate + this.phase) * 0.12
          : -0.12 + Math.sin(t * 2.2 * this.rate + this.phase) * 0.14;
    this.grip = approach(this.grip, gripTarget * (1 - s) - s * 0.6, state === 'attack' ? 24 : 7, d);
    this.clawL.rotation.z = this.grip;
    this.clawR.rotation.z = -this.grip;
    // The finger tips lead the jaw slightly, which sells the "grab".
    this.tipL.rotation.z = this.grip * 0.75 + 0.12;
    this.tipR.rotation.z = -this.grip * 0.75 - 0.12;
    this.clawL.rotation.x = -this.lean * 0.3 + s * 0.4;
    this.clawR.rotation.x = this.clawL.rotation.x;

    // Cage: swings a beat behind the frame, and lights up as it closes in.
    this.cage.rotation.z = -this.lean * 0.25 + Math.sin(t * 2.9 + this.phase) * 0.06;
    this.cage.rotation.x = Math.sin(t * 2.3 + this.phase * 1.3) * 0.05;
    const pulse = 0.5 + 0.5 * Math.sin(t * (3 + intensity * 9) + this.phase);
    this.cageMat.emissiveIntensity = (0.35 + pulse * (0.3 + intensity * 1.2)) * (1 - s * 0.9);
    this.cageGlowMat.opacity = (0.14 + pulse * 0.2 + intensity * 0.2) * (1 - s * 0.9);
    this.cageGlow.scale.setScalar(0.9 + pulse * 0.12);

    this.visorMat.emissiveIntensity = (0.3 + this.glowK * 1) * (1 - s * 0.92);
  }
}

// ---------------------------------------------------------------------------
// 5. WARDEN — the support drone. ~1.55u tall, ~1.2u wide including the halo.
//
// Looks like: a thin stepped obelisk hanging point-down in the air — a spiked
// tail below, a faceted violet column, a small head block with a mean little
// chevron eye, and a four-sided crown spike on top. Around its waist floats a
// big magenta RING HALO carrying six outward blades, with a smaller
// counter-tilted ring above it and three angular nodes orbiting on their own.
// Nothing touches: the rings and nodes float free, which is the whole point —
// it reads as "the one doing something weird", so kill it first.
// Animates: rises and falls very slowly; the halo turns faster and the nodes
// draw inward as `intensity` climbs. On telegraph the halo tilts up flat and the
// nodes pull tight against the column; on attack the halo snaps level, the nodes
// fling outward and a shockwave ring expands across the aura footprint. Stunned,
// the halo sags to a drunken angle, the nodes drop and the aura fades out.
//
// `root.userData.aura` is a unit-radius translucent additive dome (with a bright
// rim disc as its child) sitting on the ground: the game scales THAT mesh to the
// aura radius. This model never writes aura.scale.
// ---------------------------------------------------------------------------

/** lean = halo tilt · rise = hover · squash = column stretch · eye = aura + eye. */
const WARDEN_POSES: Record<EnemyAnimState, Pose> = {
  idle: { lean: 0.14, rise: 0, squash: 1, eye: 0.6 },
  chase: { lean: 0.2, rise: 0.04, squash: 1.02, eye: 0.9 },
  telegraph: { lean: 0.62, rise: 0.18, squash: 1.1, eye: 1.9 },
  attack: { lean: -0.05, rise: -0.1, squash: 0.9, eye: 2.6 },
  stunned: { lean: 0.9, rise: -0.3, squash: 0.86, eye: 0.05 },
  hurt: { lean: 0.35, rise: 0.06, squash: 1.08, eye: 1.4 },
  dying: { lean: 1.1, rise: -0.05, squash: 0.85, eye: 0 },
};

class Warden extends BaseExtraEnemy {
  private readonly halo = new THREE.Group();
  private readonly halo2 = new THREE.Group();
  private readonly nodes = new THREE.Group();
  private readonly nodeMeshes: THREE.Mesh[] = [];
  private readonly aura: THREE.Mesh;
  private readonly auraMat: THREE.MeshBasicMaterial;
  private readonly pulseRing: THREE.Sprite;
  private readonly pulseMat: THREE.SpriteMaterial;
  private readonly haloMat: THREE.MeshToonMaterial;
  private readonly eyeMat: THREE.MeshToonMaterial;

  private tilt = 0.14;
  private rise = 0;
  private stretch = 1;
  private glowK = 0.6;
  private spin = Math.random() * TAU;
  private pulse = 0;
  private prevState: EnemyAnimState = 'idle';

  constructor() {
    super('warden');
    this.hoverOffset = 0.2;

    const shell = this.toon(PAL.droneShell, {
      unique: true, map: getTexture('metalPlate'), emissive: PAL.droneShellDark, emissiveIntensity: 0.18, ramp: 'hard3',
    }, true);
    const dark = this.toon(PAL.droneShellDark, { ramp: 'hard3' });
    this.haloMat = this.toon(PAL.droneTrim, { unique: true, emissive: PAL.droneTrim, emissiveIntensity: 0.6 });
    this.eyeMat = this.toon(PAL.droneEyeAngry, { unique: true, emissive: PAL.droneEyeAngry, emissiveIntensity: 0.9 });

    // --- the obelisk: tail spike, stepped column, head block, crown ---------
    const column = this.mesh(mergeParts([
      place(spike(0.15, 0.3), 0, 0.15, 0, Math.PI),
      place(new THREE.CylinderGeometry(0.17, 0.13, 0.24, 6), 0, 0.4, 0),
      place(rbox(0.26, 0.34, 0.26, 0.06, 2), 0, 0.66, 0),
      place(new THREE.CylinderGeometry(0.13, 0.17, 0.22, 6), 0, 0.92, 0),
    ]), shell, true, true);
    this.body.add(column);

    // Head block + crown spike + four little fins around the crown.
    const head = this.mesh(place(rbox(0.24, 0.24, 0.24, 0.055, 2), 0, 1.06, 0), dark, true);
    this.body.add(head);
    const crown: THREE.BufferGeometry[] = [place(spike(0.15, 0.24), 0, 1.22, 0)];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      crown.push(place(rbox(0.05, 0.16, 0.09, 0.02, 1), Math.sin(a) * 0.14, 1.16, Math.cos(a) * 0.14, 0, a, 0.35));
    }
    this.body.add(this.mesh(mergeParts(crown), this.haloMat, true));

    // Small hard eye — this one's face is deliberately tiny. The halo is the
    // silhouette; the eye just tells you which way it is looking.
    const eye = this.mesh(mergeParts([
      place(rbox(0.1, 0.04, 0.03, 0.012, 1), -0.05, 1.06, 0.13, 0, 0, -0.55),
      place(rbox(0.1, 0.04, 0.03, 0.012, 1), 0.05, 1.06, 0.13, 0, 0, 0.55),
    ]), this.eyeMat, false);
    this.body.add(eye);

    // --- the halo: a bladed ring that floats, unattached, around the waist --
    const haloParts: THREE.BufferGeometry[] = [
      place(new THREE.TorusGeometry(0.44, 0.05, 6, 24), 0, 0, 0, Math.PI / 2),
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      // outward blade
      haloParts.push(place(rbox(0.18, 0.06, 0.1, 0.025, 1), Math.sin(a) * 0.53, 0, Math.cos(a) * 0.53, 0, a, 0));
      // inward-pointing tooth, so the ring bites toward the column
      haloParts.push(place(spike(0.05, 0.16), Math.sin(a) * 0.35, 0, Math.cos(a) * 0.35, 0, a, Math.PI / 2));
    }
    this.halo.add(this.mesh(mergeParts(haloParts), this.haloMat, true));
    this.halo.position.y = 0.68;
    this.body.add(this.halo);

    // Second, smaller ring higher up and tilted the other way.
    const halo2Parts: THREE.BufferGeometry[] = [
      place(new THREE.TorusGeometry(0.28, 0.035, 6, 18), 0, 0, 0, Math.PI / 2),
    ];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      halo2Parts.push(place(rbox(0.12, 0.05, 0.07, 0.02, 1), Math.sin(a) * 0.33, 0, Math.cos(a) * 0.33, 0, a, 0));
    }
    this.halo2.add(this.mesh(mergeParts(halo2Parts), dark, true));
    this.halo2.position.y = 0.94;
    this.body.add(this.halo2);

    // Three orbiting nodes — faceted crystals, never spheres.
    const nodeGeo = this.reg(new THREE.OctahedronGeometry(0.09, 0));
    for (let i = 0; i < 3; i++) {
      const holder = new THREE.Group();
      holder.rotation.y = (i / 3) * TAU;
      const n = new THREE.Mesh(nodeGeo, this.haloMat);
      n.castShadow = true;
      n.position.set(0, 0, 0.56);
      holder.add(n);
      this.nodes.add(holder);
      this.nodeMeshes.push(n);
    }
    this.nodes.position.y = 0.82;
    this.body.add(this.nodes);

    this.addOutlines();

    // Node coronas (unlit, after the outline pass).
    const coronaGeo = this.reg(new THREE.SphereGeometry(0.12, 10, 8));
    for (const n of this.nodeMeshes) {
      const c = this.fx(coronaGeo, glowMat(PAL.droneTrim, 0.5));
      n.add(c);
    }

    // --- the projected aura -------------------------------------------------
    // A unit dome the GAME scales to the real aura radius. Owned by root (not
    // rig) so it stays planted on the ground while the drone bobs, and never
    // touched by this model's scale animation.
    this.auraMat = this.glow(PAL.droneTrim, 0.12);
    this.auraMat.side = THREE.DoubleSide;
    this.aura = this.fx(
      new THREE.SphereGeometry(1, 24, 10, 0, TAU, 0, Math.PI / 2),
      this.auraMat,
    );
    this.aura.position.y = 0.02;
    // Bright rim disc, parented to the dome so it scales with it.
    const rim = this.fx(
      place(new THREE.RingGeometry(0.88, 1, 40), 0, 0.001, 0, -Math.PI / 2),
      this.auraMat,
    );
    this.aura.add(rim);
    this.root.add(this.aura);

    // Shockwave ring for the buff pulse; scaled to match the current aura size.
    this.pulseMat = spriteMat('ringSprite', PAL.droneTrim, true).clone();
    this.uniqueMats.add(this.pulseMat);
    this.pulseRing = new THREE.Sprite(this.pulseMat);
    this.pulseRing.position.y = 0.06;
    this.pulseRing.scale.setScalar(0.01);
    this.pulseRing.visible = false;
    this.root.add(this.pulseRing);

    this.addDizzy(1.42, 0.24);
    this.root.userData.hoverOffset = this.hoverOffset;
    this.root.userData.aura = this.aura;
  }

  protected override animate(t: number, d: number, state: EnemyAnimState, intensity: number): void {
    const p = WARDEN_POSES[state];
    const s = this.stun;
    this.tilt = approach(this.tilt, p.lean, 5, d);
    this.rise = approach(this.rise, p.rise, 4.5, d);
    this.stretch = approach(this.stretch, p.squash, 7, d);
    this.glowK = approach(this.glowK, p.eye, 6, d);

    // A very slow, ceremonial float — it should feel like it is presiding.
    const bob = Math.sin(t * 1.1 * this.rate + this.phase) * 0.08;
    this.rig.position.set(0, this.hoverOffset + this.rise + bob - s * 0.22, 0);
    this.rig.rotation.set(s * 0.35, Math.sin(t * 0.3 + this.phase) * 0.2, s * 0.55);
    this.body.scale.set(1 / Math.sqrt(this.stretch), this.stretch, 1 / Math.sqrt(this.stretch));

    // Halo: the primary tell. Turns faster the harder it is working.
    this.spin = (this.spin + d * (0.6 + intensity * 2.6) * (1 - s * 0.9)) % TAU;
    this.halo.rotation.y = this.spin;
    this.halo.rotation.z = this.tilt * 0.5;
    this.halo.rotation.x = this.tilt * 0.35 + Math.sin(t * 0.9 + this.phase) * 0.05;
    this.halo.position.y = 0.68 + Math.sin(t * 1.6 + this.phase) * 0.03;
    this.halo2.rotation.y = -this.spin * 1.6;
    this.halo2.rotation.z = -this.tilt * 0.7;
    this.halo2.position.y = 0.94 + Math.sin(t * 1.9 + this.phase * 1.5) * 0.025;

    // Buff pulse: kicked by the transition into attack, then decays.
    if (state === 'attack' && this.prevState !== 'attack') this.pulse = 1;
    this.prevState = state;
    this.pulse = approach(this.pulse, 0, 2.6, d);

    // Nodes orbit against the halo, pull in tight while charging and fling out
    // on the pulse.
    this.nodes.rotation.y -= d * (0.9 + intensity * 3.2) * (1 - s * 0.9);
    this.nodes.position.y = 0.82 - s * 0.3;
    const reach = 0.56 - intensity * 0.13 + this.pulse * 0.36;
    for (let i = 0; i < this.nodeMeshes.length; i++) {
      const n = this.nodeMeshes[i];
      n.position.z = reach;
      n.position.y = Math.sin(t * 2.1 + i * 2.09 + this.phase) * 0.09 - s * 0.2;
      n.rotation.x += d * 1.6;
      n.rotation.y += d * 2.3;
      const k = 1 + Math.sin(t * (4 + intensity * 6) + i * 2.09) * 0.16 + this.pulse * 0.4;
      n.scale.setScalar(k * (1 - s * 0.5));
    }

    // Aura: opacity only — the game owns aura.scale.
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.4 * this.rate + this.phase);
    this.auraMat.opacity = (0.05 + breathe * 0.045 + intensity * 0.07 + this.pulse * 0.14) * (1 - s * 0.95);
    this.aura.rotation.y += d * 0.22;

    // Shockwave sized off whatever radius the game gave the aura.
    const radius = this.aura.scale.x;
    this.pulseRing.visible = this.pulse > 0.02;
    if (this.pulseRing.visible) {
      const k = 1 - this.pulse;
      const sc = radius * (0.35 + k * 1.9);
      this.pulseRing.scale.set(sc, sc, 1);
      this.pulseMat.opacity = this.pulse * 0.7;
    }

    this.haloMat.emissiveIntensity = (0.35 + this.glowK * 0.5 + breathe * 0.25) * (1 - s * 0.85);
    this.eyeMat.emissiveIntensity = (0.35 + this.glowK * 0.8) * (1 - s * 0.92);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtraEnemy(kind: ExtraEnemyKind): EnemyModel {
  switch (kind) {
    case 'skitter': return new Skitter();
    case 'lobber': return new Lobber();
    case 'splitter': return new Splitter();
    case 'snatcher': return new Snatcher();
    case 'warden': return new Warden();
  }
}

// ---------------------------------------------------------------------------
// Defeat effect — harmless bouncing scrap (same shape as Enemies.ts)
// ---------------------------------------------------------------------------

/** Where each enemy's "body" sits above its ground origin, so scrap pops from the right height. */
const SCRAP_HEIGHT: Record<ExtraEnemyKind, number> = {
  skitter: 0.3, lobber: 0.75, splitter: 0.66, snatcher: 0.9, warden: 0.8,
};
const SCRAP_COUNT: Record<ExtraEnemyKind, number> = {
  skitter: 7, lobber: 11, splitter: 8, snatcher: 9, warden: 10,
};
const SCRAP_TINT: Record<ExtraEnemyKind, readonly number[]> = {
  skitter: [PAL.droneShell, PAL.droneShellDark, PAL.droneTrim],
  lobber: [PAL.droneShell, PAL.droneShellDark, PAL.hazard],
  splitter: [PAL.droneShell, PAL.droneTrim, PAL.droneShellDark],
  snatcher: [PAL.droneShell, PAL.metalLight, PAL.droneTrim],
  warden: [PAL.droneShell, PAL.droneTrim, PAL.metalLight],
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
export function createExtraScrapBurst(kind: ExtraEnemyKind): { root: THREE.Group; update(dt: number): boolean; dispose(): void } {
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const chunks: Chunk[] = [];
  const sparks: THREE.Sprite[] = [];
  const sparkVel: THREE.Vector3[] = [];

  const h = SCRAP_HEIGHT[kind];
  const tints = SCRAP_TINT[kind];

  // Four shared chunk shapes, reused across every piece. The spike is what makes
  // this wave's debris read as "the angular ones" even mid-air.
  const shapes: THREE.BufferGeometry[] = [
    rbox(0.16, 0.11, 0.13, 0.035, 1),
    new THREE.IcosahedronGeometry(0.1, 0),
    new THREE.CylinderGeometry(0.085, 0.085, 0.07, 6),
    spike(0.08, 0.2),
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
