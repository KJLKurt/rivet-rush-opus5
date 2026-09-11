import * as THREE from 'three';
import { angleDelta, clamp, clamp01, damp, easeOutCubic, makeRandom } from '../core/Util';

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
/** Roughly where Rivet's body sits above the ground plane. */
const PLAYER_EYE = 0.4;

export type CameraMode = 'chase' | 'wide' | 'follow' | 'fpv';

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
  /**
   * When true the camera orbits to sit behind the player's facing, and the
   * game feeds it camera-relative stick input. The two overhead presets stay
   * world-aligned, which is what keeps their controls absolute and readable.
   */
  rotates: number;
  /** Sideways shoulder offset, so the player isn't dead-centre. */
  shoulder: number;
  /** Hide Rivet's model (first person only). */
  hideAvatar: number;
  /** Focus-spring stiffness. Lower = gentler, laggier, less jerky. */
  stiffness: number;
  damping: number;
}

const PRESETS: Record<CameraMode, CameraPreset> = {
  chase: {
    height: 11.4, dist: 16.0,        // ~35°
    zoomHeight: 5.2, zoomDist: 5.6,
    leadZ: 3.0, leadZPortrait: 1.4,
    lookHeight: 1.6,
    // Look-ahead is deliberately modest here. At 4.0 the focus point jumped
    // several metres every time the player changed direction, which is what
    // made this preset feel jittery compared to the others.
    leadScale: 2.2,
    rotates: 0, shoulder: 0, hideAvatar: 0,
    stiffness: 42, damping: 13.5,
  },
  wide: {
    height: 16.2, dist: 17.6,        // ~43°
    zoomHeight: 6.2, zoomDist: 5.0,
    leadZ: 2.6, leadZPortrait: 1.1,
    lookHeight: 1.35,
    leadScale: 2.8,
    rotates: 0, shoulder: 0, hideAvatar: 0,
    stiffness: 56, damping: 15,
  },
  // Over-the-shoulder. Low, close and orbiting — the horizon does the work here,
  // and speed reads far better than it does from above.
  follow: {
    // A low close camera makes the player subtend a large angle below the view
    // axis, so `leadZ` has to stay small here or he slides off the bottom of
    // the frame. These numbers put him around 72% down and just off-centre.
    // ~26° — shallow enough that the horizon and the sky stay in frame, steep
    // enough that the ground ahead (where all the danger telegraphs are drawn)
    // still fills most of it. At 13° the shot was two-thirds empty sky.
    height: 5.6, dist: 7.6,
    zoomHeight: 2.4, zoomDist: 3.4,
    leadZ: 1.6, leadZPortrait: 0.8,
    lookHeight: 1.3,
    leadScale: 0.8,
    rotates: 1, shoulder: 0.55, hideAvatar: 0,
    stiffness: 62, damping: 15.5,
  },
  // Goggle cam. Sits just in front of Rivet's face; his model is hidden so you
  // aren't looking at the inside of his head.
  fpv: {
    height: 1.58, dist: 0.1,
    zoomHeight: 0.4, zoomDist: 0.6,
    // Aims slightly down the board rather than at the horizon, so the ground
    // telegraph rings — which carry most of this game's danger information —
    // stay inside the frame instead of being foreshortened off the bottom.
    leadZ: 5.0, leadZPortrait: 4.2,
    lookHeight: 1.18,
    leadScale: 0.6,
    rotates: 1, shoulder: 0, hideAvatar: 1,
    stiffness: 78, damping: 17,
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
  private fromMode: CameraMode = 'chase';
  /** 0 = fully `fromMode`, 1 = fully `mode`. Eases so switching never cuts. */
  private modeBlend = 1;
  /** Smoothed camera yaw, in radians. Only used by rotating presets. */
  private camYaw = 0;
  private yawInitialised = false;
  private leadX = 0;
  private leadZ = 0;
  private rng = makeRandom(0xc0ffee);
  private noiseSeeds: number[] = [];

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    for (let i = 0; i < 12; i++) this.noiseSeeds.push(this.rng() * 1000);
  }

  /** Jump straight to a target without easing — used on stage transitions. */
  snapTo(x: number, z: number, facing?: number): void {
    if (facing !== undefined) {
      this.camYaw = facing;
      this.yawInitialised = true;
    }
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
    if (mode === this.mode) return;
    this.fromMode = instant ? mode : this.blendedModeSnapshot();
    this.mode = mode;
    this.modeBlend = instant ? 1 : 0;
  }

  /**
   * Freezes the current blend as the new starting point, so switching modes
   * mid-transition doesn't snap back to whatever preset we started from.
   */
  private blendedModeSnapshot(): CameraMode {
    return this.modeBlend > 0.5 ? this.mode : this.fromMode;
  }

  /** True while a rotating (third/first person) preset is in charge. */
  get isRotating(): boolean {
    return this.preset().rotates > 0.5;
  }

  /** The yaw the game should rotate stick input by. 0 for world-aligned modes. */
  get inputYaw(): number {
    return this.preset().rotates > 0.5 ? this.camYaw : 0;
  }

  /** 0..1 — how much Rivet's model should be hidden (first person). */
  get avatarHidden(): number {
    return this.preset().hideAvatar;
  }

  /**
   * sin(camera pitch), i.e. how much of a world-forward step actually shows up
   * as vertical movement on screen. 1 = straight down (no foreshortening).
   * The game uses this to correct stick input — see the note in Game.ts.
   */
  get pitchSin(): number {
    const p = this.preset();
    // This must be the camera's elevation *over the player*, not the pitch of
    // the look ray. Using the look ray (which aims ahead of the player, so it
    // is shallower) over-states the foreshortening and over-corrects the stick
    // — measured at +25° of diagonal error before this was fixed.
    const vertical = Math.max(0.01, p.height - PLAYER_EYE);
    const horizontal = Math.max(0.01, p.dist);
    return Math.sin(Math.atan2(vertical, horizontal));
  }

  /** 1 while the camera is world-aligned, 0 while it orbits behind the player. */
  get worldAligned(): number {
    return 1 - this.preset().rotates;
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /**
   * @param targetX/targetZ  where Rivet is
   * @param velX/velZ        his velocity, for look-ahead
   * @param dt               seconds
   */
  /**
   * @param facing  the player's heading, radians. Rotating presets orbit to sit
   *                behind it; world-aligned presets ignore it entirely.
   */
  update(
    targetX: number, targetZ: number,
    velX: number, velZ: number,
    dt: number,
    facing = 0,
  ): void {
    // Ease the camera yaw toward the player's heading. The lag is deliberate and
    // generous: snapping the camera to `facing` makes a turning player feel like
    // they're on a rotating platform, and at speed it induces motion sickness.
    // Trailing by a few tenths of a second reads as the camera "following".
    if (!this.yawInitialised) {
      this.camYaw = facing;
      this.yawInitialised = true;
    } else {
      const speed = Math.hypot(velX, velZ);
      // Track harder when moving fast, barely at all when standing still — so
      // idling doesn't slowly spin the world around the player.
      const rate = 1.2 + clamp(speed / 12, 0, 1) * 3.4;
      this.camYaw += angleDelta(this.camYaw, facing) * (1 - Math.exp(-rate * dt));
    }
    // Look-ahead, capped so it never whips around during quick direction flips.
    const speed = Math.hypot(velX, velZ);
    const p = this.preset();
    const leadScale = clamp(speed / 14, 0, 1) * p.leadScale;
    const lead = speed > 0.001 ? leadScale / speed : 0;
    // Ease the look-ahead offset rather than recomputing it from raw velocity
    // every frame. A hard direction change used to teleport the focus point,
    // and the spring then chased that jump — which reads as camera judder even
    // though the spring itself is smooth.
    this.leadX = damp(this.leadX, velX * lead, 6.5, dt);
    this.leadZ = damp(this.leadZ, velZ * lead, 6.5, dt);
    this.desired.set(targetX + this.leadX, 0, targetZ + this.leadZ);

    // Spring the focus point (softer than a plain lerp — it overshoots a hair,
    // which makes the camera feel alive rather than glued on).
    //
    // This is integrated in fixed sub-steps with an exponential damping term.
    // The obvious explicit-Euler version (`vel -= vel * damping * dt`) is
    // unstable the moment `damping * dt` exceeds 1 — at 15 fps that term hits
    // 1.03, the velocity flips sign every frame, and the camera simply stops
    // following the player. It looked fine at 60 fps and fell apart on exactly
    // the weak devices that can least afford a broken camera.
    const stiffness = p.stiffness;
    const damping = p.damping;
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

    this.modeBlend = Math.min(1, this.modeBlend + dt * 2.6);
    this.zoomOut = damp(this.zoomOut, this.targetZoomOut, 2.4, dt);
    this.punch = damp(this.punch, 0, this.punchDecay, dt);
    this.fovPunch = damp(this.fovPunch, 0, 5.5, dt);
    this.roll = damp(this.roll, this.targetRoll, 7, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.65);
    this.shakeTime += dt;

    this.applyTransform(dt, false);
  }

  /** The current preset, linearly blended from the previous mode to this one. */
  private preset(): CameraPreset {
    const b = this.modeBlend;
    const a = PRESETS[this.fromMode];
    const c = PRESETS[this.mode];
    _preset.height = a.height + (c.height - a.height) * b;
    _preset.dist = a.dist + (c.dist - a.dist) * b;
    _preset.zoomHeight = a.zoomHeight + (c.zoomHeight - a.zoomHeight) * b;
    _preset.zoomDist = a.zoomDist + (c.zoomDist - a.zoomDist) * b;
    _preset.leadZ = a.leadZ + (c.leadZ - a.leadZ) * b;
    _preset.leadZPortrait = a.leadZPortrait + (c.leadZPortrait - a.leadZPortrait) * b;
    _preset.lookHeight = a.lookHeight + (c.lookHeight - a.lookHeight) * b;
    _preset.leadScale = a.leadScale + (c.leadScale - a.leadScale) * b;
    _preset.rotates = a.rotates + (c.rotates - a.rotates) * b;
    _preset.shoulder = a.shoulder + (c.shoulder - a.shoulder) * b;
    _preset.hideAvatar = a.hideAvatar + (c.hideAvatar - a.hideAvatar) * b;
    _preset.stiffness = a.stiffness + (c.stiffness - a.stiffness) * b;
    _preset.damping = a.damping + (c.damping - a.damping) * b;
    return _preset;
  }

  private applyTransform(dt: number, instant: boolean): void {
    const cam = this.camera;
    const zo = this.zoomOut;
    const p = this.preset();
    const height = p.height + zo * p.zoomHeight - this.punch * 1.5;
    const dist = p.dist + zo * p.zoomDist - this.punch * 1.2;

    // Rotating presets orbit the offset around the focus; world-aligned ones
    // use the fixed offset they always have. `p.rotates` blends between the two
    // so switching between an overhead and an over-the-shoulder camera sweeps
    // around rather than cutting.
    // The player's forward vector is (sin(yaw), -cos(yaw)) — `facing` is built
    // with atan2(vx, -vz) — so the camera sits at focus MINUS forward × dist,
    // and the shoulder offset runs along the right vector (cos(yaw), sin(yaw)).
    // At yaw = 0 this collapses exactly to the world-aligned offset the
    // overhead presets use, which is what lets the two blend continuously.
    const yaw = this.camYaw * p.rotates;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const offX = p.shoulder;
    const offZ = dist;
    let px = this.focus.x - offZ * sin + offX * cos;
    let py = height;
    let pz = this.focus.z + offZ * cos + offX * sin;

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

    const lead = this.portrait ? p.leadZPortrait : p.leadZ;
    this.lookAt.set(
      this.focus.x + lead * sin + offX * cos,
      p.lookHeight + zo * 0.9,
      this.focus.z - lead * cos + offX * sin,
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
