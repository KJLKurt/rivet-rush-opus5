import * as THREE from 'three';
import { CFG } from './Config';
import type { PlayerStats } from './Upgrades';
import { RivetModel } from '../render/models/Rivet';
import { Trail } from '../render/Trail';
import type { Fx } from '../render/Fx';
import { TRAIL_COLORS } from '../render/Palette';
import { clamp, clamp01, damp, angleDelta } from '../core/Util';

/**
 * Rivet's movement.
 *
 * The controls are the whole game, so a few things here are deliberate:
 *
 *  - Acceleration is high (~0.25s to top speed) but not instant. Instant
 *    velocity feels robotic; a long ramp feels like driving a bus. This sits
 *    in the small window that reads as "eager".
 *  - `turnAssist` adds extra force specifically against the component of
 *    velocity that opposes the stick. Without it, reversing direction at speed
 *    feels like ice; with it, the board bites and pivots while still carrying
 *    a satisfying arc.
 *  - Dash briefly overrides velocity entirely, then bleeds the excess speed
 *    back down. The leftover speed after a dash is a big part of why chaining
 *    dashes feels so good.
 *  - The player is never allowed to fall off. The rim fence pushes back with a
 *    spring, and props are resolved by simple circle push-out.
 */

export type DashResult = 'ok' | 'noCharge' | 'busy';

export interface PlayerHitInfo {
  fatal: boolean;
  blockedByShield: boolean;
}

export class Player {
  readonly model: RivetModel;
  readonly trail: Trail;
  readonly position = new THREE.Vector3(0, 0, 0);
  readonly velocity = new THREE.Vector3(0, 0, 0);

  facing = 0;
  private turnRateSmoothed = 0;

  stats: PlayerStats;

  // --- dash ---
  dashCharge = 0;
  dashTimer = 0;
  dashCooldownAccum = 0;
  private dashDirX = 0;
  private dashDirZ = 0;
  private postDashSpeed = 0;
  iframes = 0;

  // --- health ---
  hearts = 3;
  shields = 0;
  shieldMax = 0;
  invuln = 0;
  dead = false;
  usedGuardian = false;

  // --- overdrive ---
  overdriveMeter = 0;
  overdriveTimer = 0;
  get overdriveActive(): boolean {
    return this.overdriveTimer > 0;
  }
  get overdriveReady(): boolean {
    return this.overdriveMeter >= CFG.overdrive.max && this.overdriveTimer <= 0;
  }
  /** 0..1 blend used by visuals; eases in and out so nothing pops. */
  overdriveBlend = 0;

  // --- zap ---
  zapTimer = 0;

  /** Speed carried above the normal cap (boost pads, dash exit). Decays. */
  private overSpeed = 0;
  private padCooldown = 0;

  /** 0..1, for HUD and effects. */
  get speed01(): number {
    return clamp01(this.velocity.length() / this.maxSpeed);
  }

  get maxSpeed(): number {
    return this.stats.maxSpeed * (this.overdriveActive ? CFG.overdrive.speedScale : 1);
  }

  get magnetRadius(): number {
    return this.stats.magnetRadius * (this.overdriveActive ? CFG.overdrive.magnetScale : 1);
  }

  private hoverPhase = Math.random() * 6.28;
  private dustAccum = 0;
  private trailColors = TRAIL_COLORS.cyan!;

  constructor(stats: PlayerStats, boardSkin: string, trailId: string) {
    this.stats = stats;
    this.model = new RivetModel(boardSkin);
    // Deliberate character-scale cheat: at true 1:1 scale Rivet is a ~40px
    // speck on a phone. 1.25× keeps his silhouette and expression readable
    // without changing a single collision radius.
    this.model.root.scale.setScalar(1.25);
    this.trailColors = TRAIL_COLORS[trailId] ?? TRAIL_COLORS.cyan!;
    this.trail = new Trail(32, this.trailColors.a, this.trailColors.b);
    this.hearts = stats.maxHearts;
    this.shieldMax = stats.shields;
    this.shields = stats.shields;
    this.dashCharge = stats.dashCharges;
  }

  setTrail(trailId: string): void {
    this.trailColors = TRAIL_COLORS[trailId] ?? TRAIL_COLORS.cyan!;
    this.trail.setColors(this.trailColors.a, this.trailColors.b);
  }

  /** Called when stats change mid-run (upgrade picked). */
  refreshStats(): void {
    this.hearts = Math.min(this.stats.maxHearts, this.hearts);
    this.shieldMax = this.stats.shields;
    this.dashCharge = Math.min(this.dashCharge, this.stats.dashCharges);
  }

  resetForStage(x: number, z: number): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.facing = Math.atan2(-x, -z);
    this.dashTimer = 0;
    this.dashCharge = this.stats.dashCharges;
    this.dashCooldownAccum = 0;
    this.overSpeed = 0;
    this.postDashSpeed = 0;
    this.invuln = 0;
    this.iframes = 0;
    this.shields = this.shieldMax;
    this.zapTimer = 0;
    this.model.root.position.set(x, CFG.player.hoverHeight, z);
    this.trail.reset(x, CFG.player.hoverHeight, z);
  }

  // --- actions -------------------------------------------------------------

  tryDash(inputX: number, inputZ: number): DashResult {
    if (this.dashTimer > 0) return 'busy';
    const free = this.overdriveActive && CFG.overdrive.freeDash;
    if (!free && this.dashCharge < 1) return 'noCharge';
    if (!free) this.dashCharge -= 1;

    // Dash the way the stick points; if the stick is neutral, dash forward.
    let dx = inputX;
    let dz = inputZ;
    const mag = Math.hypot(dx, dz);
    if (mag < 0.2) {
      dx = Math.sin(this.facing);
      dz = -Math.cos(this.facing);
    } else {
      dx /= mag;
      dz /= mag;
    }
    this.dashDirX = dx;
    this.dashDirZ = dz;
    this.dashTimer = CFG.dash.duration;
    this.iframes = CFG.dash.iframes;
    this.facing = Math.atan2(dx, -dz);
    const speed = this.stats.dashSpeed * (this.overdriveActive ? 1.15 : 1);
    this.velocity.set(dx * speed, 0, dz * speed);
    this.postDashSpeed = speed * CFG.dash.exitBoost;
    return 'ok';
  }

  activateOverdrive(): boolean {
    if (!this.overdriveReady) return false;
    this.overdriveMeter = 0;
    this.overdriveTimer = this.stats.overdriveDuration;
    return true;
  }

  addOverdrive(amount: number, comboTier: number): void {
    if (this.overdriveActive) return;
    const scale = this.stats.overdriveGain * (1 + comboTier * CFG.overdrive.comboGainScale);
    this.overdriveMeter = Math.min(CFG.overdrive.max, this.overdriveMeter + amount * scale);
  }

  /** Returns null when the hit was ignored (i-frames / already dead). */
  takeHit(fromX: number, fromZ: number, force = 9): PlayerHitInfo | null {
    if (this.dead || this.invuln > 0 || this.iframes > 0) return null;

    if (this.shields > 0) {
      this.shields -= 1;
      this.invuln = 0.85;
      this.knockback(fromX, fromZ, force * 0.7);
      return { fatal: false, blockedByShield: true };
    }

    this.hearts -= 1;
    this.invuln = CFG.health.invuln;
    this.knockback(fromX, fromZ, force);
    if (this.hearts <= 0) {
      if (this.stats.guardian > 0 && !this.usedGuardian) {
        this.usedGuardian = true;
        this.hearts = 2;
        this.invuln = 2.4;
        return { fatal: false, blockedByShield: false };
      }
      this.hearts = 0;
      this.dead = true;
      return { fatal: true, blockedByShield: false };
    }
    return { fatal: false, blockedByShield: false };
  }

  private knockback(fromX: number, fromZ: number, force: number): void {
    let dx = this.position.x - fromX;
    let dz = this.position.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 0.001) {
      dx = 0;
      dz = 1;
    } else {
      dx /= d;
      dz /= d;
    }
    this.velocity.set(dx * force, 0, dz * force);
    this.dashTimer = 0;
    this.overSpeed = Math.max(this.overSpeed, force - this.maxSpeed);
  }

  heal(amount = 1): boolean {
    if (this.hearts >= this.stats.maxHearts) return false;
    this.hearts = Math.min(this.stats.maxHearts, this.hearts + amount);
    return true;
  }

  // --- per-frame -----------------------------------------------------------

  update(
    dt: number,
    inputX: number,
    inputZ: number,
    inputMag: number,
    arenaRadius: number,
    obstacles: Array<{ x: number; z: number; r: number }>,
    fx: Fx,
    camera: THREE.Camera,
  ): void {
    const dashing = this.dashTimer > 0;

    // --- timers ------------------------------------------------------------
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);
    if (this.iframes > 0) this.iframes = Math.max(0, this.iframes - dt);
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    if (this.padCooldown > 0) this.padCooldown -= dt;
    if (this.zapTimer > 0) this.zapTimer -= dt;

    if (this.overdriveTimer > 0) this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);
    this.overdriveBlend = damp(this.overdriveBlend, this.overdriveActive ? 1 : 0, 6, dt);

    if (this.dashCharge < this.stats.dashCharges) {
      this.dashCooldownAccum += dt;
      const need = this.stats.dashRecharge;
      while (this.dashCooldownAccum >= need && this.dashCharge < this.stats.dashCharges) {
        this.dashCooldownAccum -= need;
        this.dashCharge += 1;
        this.onDashRecharged?.();
      }
    } else {
      this.dashCooldownAccum = 0;
    }

    // --- movement ----------------------------------------------------------
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    const maxSpeed = this.maxSpeed;

    if (dashing) {
      // A little steering authority during the dash keeps it from feeling like
      // a cutscene, without letting the player cancel the commitment.
      if (inputMag > 0.25) {
        const steer = 5.5 * dt;
        this.dashDirX += inputX * steer;
        this.dashDirZ += inputZ * steer;
        const m = Math.hypot(this.dashDirX, this.dashDirZ) || 1;
        this.dashDirX /= m;
        this.dashDirZ /= m;
      }
      const speed = Math.hypot(vx, vz);
      this.velocity.set(this.dashDirX * speed, 0, this.dashDirZ * speed);
      this.facing = Math.atan2(this.dashDirX, -this.dashDirZ);
    } else if (inputMag > 0.001) {
      const targetVx = inputX * maxSpeed;
      const targetVz = inputZ * maxSpeed;
      // Base acceleration toward the desired velocity...
      let ax = (targetVx - vx);
      let az = (targetVz - vz);
      const alen = Math.hypot(ax, az) || 1;
      ax /= alen;
      az /= alen;
      let accel = CFG.player.accel;
      // ...plus a bonus when the stick opposes current motion. This is the
      // single most important line in the file for how the board feels.
      const dot = (vx * inputX + vz * inputZ) / (Math.hypot(vx, vz) || 1);
      if (dot < 0.4) accel += CFG.player.turnAssist * (0.4 - dot);
      const step = accel * dt;
      const remaining = Math.hypot(targetVx - vx, targetVz - vz);
      const applied = Math.min(step, remaining);
      this.velocity.x += ax * applied;
      this.velocity.z += az * applied;
    } else {
      // Coast to a stop, keeping just a touch of glide.
      const speed = Math.hypot(vx, vz);
      if (speed > 0.01) {
        const drop = Math.min(speed, CFG.player.brake * dt);
        this.velocity.x -= (vx / speed) * drop;
        this.velocity.z -= (vz / speed) * drop;
      }
    }

    // Bleed off anything above the cap (post-dash, boost pads, knockback).
    if (!dashing) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      const cap = maxSpeed + this.overSpeed;
      if (speed > cap && speed > 0.001) {
        const k = cap / speed;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
      this.overSpeed = Math.max(0, this.overSpeed - dt * 22);
      if (this.postDashSpeed > 0) {
        this.overSpeed = Math.max(this.overSpeed, this.postDashSpeed - maxSpeed);
        this.postDashSpeed = damp(this.postDashSpeed, 0, 7, dt);
      }
    }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // --- collision ---------------------------------------------------------
    for (const o of obstacles) {
      const dx = this.position.x - o.x;
      const dz = this.position.z - o.z;
      const minD = o.r + CFG.player.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / d;
        this.position.x += dx * push;
        this.position.z += dz * push;
        // Slide along the surface instead of stopping dead.
        const nx = dx / d;
        const nz = dz / d;
        const vn = this.velocity.x * nx + this.velocity.z * nz;
        if (vn < 0) {
          this.velocity.x -= nx * vn * 1.1;
          this.velocity.z -= nz * vn * 1.1;
        }
      }
    }

    // Rim fence: a spring, not a wall. It gets firmer the further you push.
    const dist = Math.hypot(this.position.x, this.position.z);
    const limit = arenaRadius - CFG.player.radius;
    if (dist > limit - CFG.arena.fenceSoft) {
      const over = dist - (limit - CFG.arena.fenceSoft);
      const nx = this.position.x / dist;
      const nz = this.position.z / dist;
      const push = CFG.arena.fencePush * (over / CFG.arena.fenceSoft) * dt;
      this.velocity.x -= nx * push;
      this.velocity.z -= nz * push;
      if (dist > limit) {
        this.position.x = nx * limit;
        this.position.z = nz * limit;
        const vn = this.velocity.x * nx + this.velocity.z * nz;
        if (vn > 0) {
          this.velocity.x -= nx * vn;
          this.velocity.z -= nz * vn;
        }
        this.onFence?.(this.position.x, this.position.z);
      }
    }

    // --- facing ------------------------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 0.35) {
      const target = Math.atan2(this.velocity.x, -this.velocity.z);
      const delta = angleDelta(this.facing, target);
      const rate = CFG.player.turnRate * (dashing ? 2.4 : 1);
      const step = clamp(delta * rate * dt * 1.6, -rate * dt, rate * dt);
      this.facing += step;
      this.turnRateSmoothed = damp(this.turnRateSmoothed, delta * rate, 12, dt);
    } else {
      this.turnRateSmoothed = damp(this.turnRateSmoothed, 0, 10, dt);
    }

    // --- visual ------------------------------------------------------------
    this.hoverPhase += dt * (2 + this.speed01 * 3);
    const hoverY = CFG.player.hoverHeight + Math.sin(this.hoverPhase) * 0.03;
    this.model.root.position.set(this.position.x, hoverY, this.position.z);
    this.model.root.rotation.y = this.facing;

    const dash01 = this.dashTimer / CFG.dash.duration;
    this.model.update(dt, {
      speed,
      speed01: this.speed01,
      turn: this.turnRateSmoothed,
      dash: dash01,
      hurt: this.invuln > 0 && this.shields === 0 ? clamp01(this.invuln / CFG.health.invuln) : 0,
      overdrive: this.overdriveBlend,
      pose: this.dead ? 'tumble' : this.invuln > 0.9 ? 'hurt' : dashing ? 'dash' : 'ride',
    });

    // Trail: swells hard on dash and in Overdrive, vanishes when standing still.
    const trailWidth = 0.34 + this.speed01 * 0.5 + dash01 * 1.35 + this.overdriveBlend * 0.5;
    const trailVis = clamp01(this.speed01 * 2.4 + dash01 * 2 + this.overdriveBlend);
    const anchor = this.model.trailAnchor;
    this.trail.setGlow(0.2 + dash01 * 0.9 + this.overdriveBlend * 0.75);
    this.trail.update(dt, anchor.x, anchor.y, anchor.z, trailWidth, trailVis, camera);
    if (this.overdriveBlend > 0.01) {
      this.trail.setColors(
        _mixColor(this.trailColors.a, 0xffd447, this.overdriveBlend),
        _mixColor(this.trailColors.b, 0xff7a2f, this.overdriveBlend),
      );
    }

    // --- ambient particles -------------------------------------------------
    this.dustAccum += dt * (2 + this.speed01 * 26 + (dashing ? 90 : 0) + this.overdriveBlend * 26);
    while (this.dustAccum >= 1) {
      this.dustAccum -= 1;
      const spread = 0.35;
      const back = 0.6;
      fx.emitOne(
        dashing ? 'glow' : 'smoke',
        this.position.x - Math.sin(this.facing) * back + (Math.random() - 0.5) * spread,
        0.14 + Math.random() * 0.16,
        this.position.z + Math.cos(this.facing) * back + (Math.random() - 0.5) * spread,
        -this.velocity.x * 0.12 + (Math.random() - 0.5) * 1.2,
        0.4 + Math.random() * 0.8,
        -this.velocity.z * 0.12 + (Math.random() - 0.5) * 1.2,
        dashing
          ? this.trailColors.a
          : this.overdriveBlend > 0.5
            ? 0xffd447
            : 0xdfe9ff,
        dashing ? 0.5 : 0.34,
        dashing ? 0.34 : 0.55,
        dashing ? 0.9 : 0.35,
        3.2,
        dashing ? -1.2 : -0.4,
      );
    }
  }

  /** Called by the game when the player rides over a boost pad. */
  applyBoostPad(angle: number): boolean {
    if (this.padCooldown > 0) return false;
    this.padCooldown = 0.55;
    const dx = Math.sin(angle);
    const dz = -Math.cos(angle);
    const boost = this.maxSpeed * 1.85;
    this.velocity.set(dx * boost, 0, dz * boost);
    this.overSpeed = Math.max(this.overSpeed, boost - this.maxSpeed);
    this.facing = angle;
    return true;
  }

  onDashRecharged: (() => void) | null = null;
  onFence: ((x: number, z: number) => void) | null = null;

  dispose(): void {
    this.model.dispose();
    this.trail.dispose();
  }
}

const _ca = new THREE.Color();
const _cb = new THREE.Color();
function _mixColor(a: number, b: number, t: number): number {
  _ca.setHex(a);
  _cb.setHex(b);
  return _ca.lerp(_cb, clamp01(t)).getHex();
}
