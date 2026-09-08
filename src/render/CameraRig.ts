import * as THREE from 'three';
import { clamp, clamp01, damp, easeOutCubic, makeRandom } from '../core/Util';

/**
 * Three-quarter chase camera. The player never controls it.
 *
 * Feel notes:
 *  - The camera aims slightly *ahead* of Rivet along his velocity, so fast
 *    movement reveals what's coming instead of what he just left.
 *  - Position uses critically-damped smoothing; the look-at point is smoothed
 *    faster than the position, which reads as the camera "leading" the action.
 *  - Shake is trauma-based: events add trauma, trauma decays, and the applied
 *    shake is trauma² so small bumps stay subtle while big hits really land.
 *  - A short FOV/dolly "punch" on impacts sells weight far more cheaply than
 *    any particle effect.
 */

/**
 * Two camera presets.
 *
 * `chase` sits closer and lower (~35°) so the cast reads roughly 40% bigger on
 * screen — which is the real fix for "I can't tell what's an enemy and what I'm
 * supposed to rescue". `wide` is the original ~43° overhead, which trades
 * character legibility for tactical awareness and is the right choice when a
 * lot of things are converging on you at once.
 *
 * Height/distance are what set the pitch: atan(h/d).
 */
export type CameraMode = 'chase' | 'wide';

interface CameraPreset {
  height: number;
  dist: number;
  /** Extra pull-back per unit of requested zoom-out. */
  zoomHeight: number;
  zoomDist: number;
  /** How far ahead of the player the camera aims. */
  leadZ: number;
  leadZPortrait: number;
  lookHeight: number;
  /** Look-ahead applied along the velocity vector. */
  leadScale: number;
}

const PRESETS: Record<CameraMode, CameraPreset> = {
  chase: {
    height: 11.4, dist: 16.0,        // ~35°
    zoomHeight: 5.2, zoomDist: 5.6,
    leadZ: 3.0, leadZPortrait: 1.4,
    lookHeight: 1.6,
    leadScale: 4.0,
  },
  wide: {
    height: 16.2, dist: 17.6,        // ~43°
    zoomHeight: 6.2, zoomDist: 5.0,
    leadZ: 2.6, leadZPortrait: 1.1,
    lookHeight: 1.35,
    leadScale: 3.4,
  },
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  /** Smoothed focus point on the ground plane. */
  private focus = new THREE.Vector3();
  private focusVel = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();

  private trauma = 0;
  private shakeTime = 0;
  private punch = 0;
  private punchDecay = 6;
  private roll = 0;
  private targetRoll = 0;

  /** Extra pull-back requested by gameplay (boss fights, big arenas). */
  private zoomOut = 0;
  private targetZoomOut = 0;
  private fovPunch = 0;
  private baseFov = 46;

  /** 0..1 — scaled by the player's accessibility setting. */
  shakeScale = 1;
  /** Portrait needs a gentler forward offset or Rivet sits on the bottom edge. */
  private portrait = false;
  private mode: CameraMode = 'chase';
  /** Eased 0 (chase) → 1 (wide), so switching mid-run glides instead of cutting. */
  private modeBlend = 0;
  private rng = makeRandom(0xc0ffee);
  private noiseSeeds: number[] = [];

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    for (let i = 0; i < 12; i++) this.noiseSeeds.push(this.rng() * 1000);
  }

  /** Jump straight to a target without easing — used on stage transitions. */
  snapTo(x: number, z: number): void {
    this.focus.set(x, 0, z);
    this.smoothedLook.set(x, 1.1, z);
    this.focusVel.set(0, 0, 0);
    this.applyTransform(0, true);
  }

  addTrauma(amount: number): void {
    this.trauma = clamp01(this.trauma + amount * this.shakeScale);
  }

  /** Quick dolly-in/out impulse. Positive pushes the camera closer. */
  addPunch(amount: number, decay = 6): void {
    this.punch = clamp(this.punch + amount, -1.6, 1.6);
    this.punchDecay = decay;
  }

  addFovPunch(amount: number): void {
    this.fovPunch = clamp(this.fovPunch + amount, -14, 18);
  }

  setZoomOut(amount: number): void {
    this.targetZoomOut = amount;
  }

  setRoll(radians: number): void {
    this.targetRoll = clamp(radians, -0.14, 0.14);
  }

  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  setPortrait(on: boolean): void {
    this.portrait = on;
  }

  /** Switches preset. The transition is eased unless `instant`. */
  setMode(mode: CameraMode, instant = false): void {
    this.mode = mode;
    if (instant) this.modeBlend = mode === 'wide' ? 1 : 0;
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /**
   * @param targetX/targetZ  where Rivet is
   * @param velX/velZ        his velocity, for look-ahead
   * @param dt               seconds
   */
  update(targetX: number, targetZ: number, velX: number, velZ: number, dt: number): void {
    // Look-ahead, capped so it never whips around during quick direction flips.
    const speed = Math.hypot(velX, velZ);
    const p = this.preset();
    const leadScale = clamp(speed / 14, 0, 1) * p.leadScale;
    const lead = speed > 0.001 ? leadScale / speed : 0;
    this.desired.set(targetX + velX * lead, 0, targetZ + velZ * lead);

    // Spring the focus point (softer than a plain lerp — it overshoots a hair,
    // which makes the camera feel alive rather than glued on).
    //
    // This is integrated in fixed sub-steps with an exponential damping term.
    // The obvious explicit-Euler version (`vel -= vel * damping * dt`) is
    // unstable the moment `damping * dt` exceeds 1 — at 15 fps that term hits
    // 1.03, the velocity flips sign every frame, and the camera simply stops
    // following the player. It looked fine at 60 fps and fell apart on exactly
    // the weak devices that can least afford a broken camera.
    const stiffness = 68;
    const damping = 15.5;
    const STEP = 1 / 120;
    let remaining = dt;
    for (let guard = 0; remaining > 1e-6 && guard < 24; guard++) {
      const h = Math.min(STEP, remaining);
      remaining -= h;
      this.focusVel.x += (this.desired.x - this.focus.x) * stiffness * h;
      this.focusVel.z += (this.desired.z - this.focus.z) * stiffness * h;
      const decay = Math.exp(-damping * h);
      this.focusVel.x *= decay;
      this.focusVel.z *= decay;
      this.focus.x += this.focusVel.x * h;
      this.focus.z += this.focusVel.z * h;
    }

    this.modeBlend = damp(this.modeBlend, this.mode === 'wide' ? 1 : 0, 3.2, dt);
    this.zoomOut = damp(this.zoomOut, this.targetZoomOut, 2.4, dt);
    this.punch = damp(this.punch, 0, this.punchDecay, dt);
    this.fovPunch = damp(this.fovPunch, 0, 5.5, dt);
    this.roll = damp(this.roll, this.targetRoll, 7, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.65);
    this.shakeTime += dt;

    this.applyTransform(dt, false);
  }

  /** The current preset, linearly blended between chase and wide. */
  private preset(): CameraPreset {
    const b = this.modeBlend;
    const a = PRESETS.chase;
    const c = PRESETS.wide;
    _preset.height = a.height + (c.height - a.height) * b;
    _preset.dist = a.dist + (c.dist - a.dist) * b;
    _preset.zoomHeight = a.zoomHeight + (c.zoomHeight - a.zoomHeight) * b;
    _preset.zoomDist = a.zoomDist + (c.zoomDist - a.zoomDist) * b;
    _preset.leadZ = a.leadZ + (c.leadZ - a.leadZ) * b;
    _preset.leadZPortrait = a.leadZPortrait + (c.leadZPortrait - a.leadZPortrait) * b;
    _preset.lookHeight = a.lookHeight + (c.lookHeight - a.lookHeight) * b;
    _preset.leadScale = a.leadScale + (c.leadScale - a.leadScale) * b;
    return _preset;
  }

  private applyTransform(dt: number, instant: boolean): void {
    const cam = this.camera;
    const zo = this.zoomOut;
    const p = this.preset();
    const height = p.height + zo * p.zoomHeight - this.punch * 1.5;
    const dist = p.dist + zo * p.zoomDist - this.punch * 1.2;

    let px = this.focus.x;
    let py = height;
    let pz = this.focus.z + dist;

    // Trauma shake: sum of two out-of-phase sines per axis reads as organic
    // handheld motion, and is far cheaper than sampling real noise.
    if (this.trauma > 0.0005) {
      const s = this.trauma * this.trauma * 1.5;
      const t = this.shakeTime;
      px += (Math.sin(t * 47 + this.noiseSeeds[0]!) + Math.sin(t * 31.3 + this.noiseSeeds[1]!)) * 0.35 * s;
      py += (Math.sin(t * 41 + this.noiseSeeds[2]!) + Math.sin(t * 27.7 + this.noiseSeeds[3]!)) * 0.3 * s;
      pz += (Math.sin(t * 53 + this.noiseSeeds[4]!) + Math.sin(t * 35.1 + this.noiseSeeds[5]!)) * 0.28 * s;
    }

    cam.position.set(px, py, pz);

    this.lookAt.set(
      this.focus.x,
      p.lookHeight + zo * 0.9,
      this.focus.z - (this.portrait ? p.leadZPortrait : p.leadZ),
    );
    if (instant) this.smoothedLook.copy(this.lookAt);
    else this.smoothedLook.lerp(this.lookAt, 1 - Math.exp(-18 * dt));
    cam.lookAt(this.smoothedLook);

    if (Math.abs(this.roll) > 0.0005) cam.rotateZ(this.roll);

    const fov = this.baseFov + this.fovPunch + zo * 1.5;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Cinematic helper for the boss reveal: orbit a point for `t` in 0..1. */
  cinematicOrbit(cx: number, cz: number, t: number, radius = 26, height = 12): void {
    const e = easeOutCubic(t);
    const angle = -0.9 + e * 1.5;
    // Pull *out* as the shot progresses rather than starting far away: opening
    // tight on the machine's face is what makes it feel big.
    const r = radius * (0.72 + e * 0.55);
    this.camera.position.set(cx + Math.sin(angle) * r, height + e * 8, cz + Math.cos(angle) * r);
    this.camera.lookAt(cx, 4.8 - e * 1.4, cz);
    this.focus.set(cx, 0, cz);
    this.smoothedLook.set(cx, 1.15, cz);
    this.focusVel.set(0, 0, 0);
  }

  get focusPoint(): THREE.Vector3 {
    return this.focus;
  }

  /** Diagnostics for the camera-framing test. */
  debug(): Record<string, number> {
    const p = this.preset();
    return {
      modeBlend: this.modeBlend,
      focusX: this.focus.x, focusZ: this.focus.z,
      lookX: this.smoothedLook.x, lookY: this.smoothedLook.y, lookZ: this.smoothedLook.z,
      zoomOut: this.zoomOut, punch: this.punch, fovPunch: this.fovPunch,
      presetHeight: p.height, presetDist: p.dist, presetLeadZ: p.leadZ,
      camFov: this.camera.fov, baseFov: this.baseFov, portrait: this.portrait ? 1 : 0,
    };
  }
}

/** Scratch for the blended preset — `preset()` runs every frame. */
const _preset: CameraPreset = { ...PRESETS.chase };
