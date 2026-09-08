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
 * Camera placement. The pitch (~43°) is the compromise that matters most:
 * steep enough that ground positions stay easy to judge, shallow enough that
 * the sky and the island's edge stay in frame — without them the game stops
 * looking like it takes place in the air at all.
 */
const BASE_HEIGHT = 16.2;
const BASE_DIST = 17.6;

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

  /**
   * @param targetX/targetZ  where Rivet is
   * @param velX/velZ        his velocity, for look-ahead
   * @param dt               seconds
   */
  update(targetX: number, targetZ: number, velX: number, velZ: number, dt: number): void {
    // Look-ahead, capped so it never whips around during quick direction flips.
    const speed = Math.hypot(velX, velZ);
    const leadScale = clamp(speed / 14, 0, 1) * 3.4;
    const lead = speed > 0.001 ? leadScale / speed : 0;
    this.desired.set(targetX + velX * lead, 0, targetZ + velZ * lead);

    // Spring the focus point (softer than a plain lerp — it overshoots a hair,
    // which makes the camera feel alive rather than glued on).
    const stiffness = 68;
    const damping = 15.5;
    this.focusVel.x += (this.desired.x - this.focus.x) * stiffness * dt;
    this.focusVel.z += (this.desired.z - this.focus.z) * stiffness * dt;
    this.focusVel.x -= this.focusVel.x * damping * dt;
    this.focusVel.z -= this.focusVel.z * damping * dt;
    this.focus.x += this.focusVel.x * dt;
    this.focus.z += this.focusVel.z * dt;

    this.zoomOut = damp(this.zoomOut, this.targetZoomOut, 2.4, dt);
    this.punch = damp(this.punch, 0, this.punchDecay, dt);
    this.fovPunch = damp(this.fovPunch, 0, 5.5, dt);
    this.roll = damp(this.roll, this.targetRoll, 7, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.65);
    this.shakeTime += dt;

    this.applyTransform(dt, false);
  }

  private applyTransform(dt: number, instant: boolean): void {
    const cam = this.camera;
    const zo = this.zoomOut;
    const height = BASE_HEIGHT + zo * 6.2 - this.punch * 1.5;
    const dist = BASE_DIST + zo * 5.0 - this.punch * 1.2;

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

    this.lookAt.set(this.focus.x, 1.35 + zo * 0.9, this.focus.z - (this.portrait ? 1.1 : 2.6));
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
}
