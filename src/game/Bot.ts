import type { Game } from './Game';
import { CFG } from './Config';
import { clamp01 } from '../core/Util';

/**
 * An automated player.
 *
 * This exists so complete runs — every stage, the upgrade screens and the
 * whole boss fight — can be exercised repeatedly without a human holding the
 * controls, both during development and in the Playwright smoke test. It plays
 * roughly like a competent-but-not-brilliant human: it heads for the objective,
 * detours for nearby bolts, dashes to break crates and escape danger, and pops
 * Overdrive whenever it is available.
 *
 * It is never reachable from the interface — only from `window.__rivet` — so a
 * player can't stumble into it.
 */

export class PlaytestBot {
  private game: Game;
  private enabled = false;
  private repickTimer = 0;
  private targetX = 0;
  private targetZ = 0;
  private dashCooldown = 0;
  private stuckTimer = 0;
  private lastX = 0;
  private lastZ = 0;
  private wanderAngle = 0;
  private threats: Array<{ x: number; z: number; inner: number; outer: number }> = [];
  private hazards: Array<{ x: number; z: number; r: number }> = [];

  constructor(game: Game) {
    this.game = game;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.game.botInput = on ? { x: 0, y: 0, dash: false, overdrive: false } : null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Jumps straight into a run and fast-forwards to a given stage. */
  skipTo(stageIndex: number): void {
    this.game.startRun(false);
    for (let i = 0; i < stageIndex; i++) {
      // Drive the normal flow so upgrades and stage state stay consistent.
      const priv = this.game as unknown as { nextStage: () => void };
      priv.nextStage();
    }
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const input = this.game.botInput;
    if (!input) return;

    input.dash = false;
    input.overdrive = false;

    // Auto-advance through anything that waits for a tap.
    if (this.game.state === 'upgrade') {
      const priv = this.game as unknown as { pendingUpgrades: Array<{ id: string }> };
      const choice = priv.pendingUpgrades?.[0];
      if (choice) this.game.pickUpgrade(choice.id as never);
      return;
    }
    if (this.game.state === 'title') {
      this.game.startRun(false);
      return;
    }
    if (this.game.state === 'results') {
      return;
    }
    if (this.game.state !== 'playing') {
      input.x = 0;
      input.y = 0;
      return;
    }

    const player = this.game.playerRef;
    if (!player) return;
    const px = player.position.x;
    const pz = player.position.z;

    this.dashCooldown -= dt;
    this.repickTimer -= dt;

    // --- threat assessment -------------------------------------------------
    let threatX = 0;
    let threatZ = 0;
    let nearestThreat = Infinity;
    this.game.enemiesRef.forEachAlive((ex, ez) => {
      const d = Math.hypot(ex - px, ez - pz);
      if (d < 5.5) {
        const w = (5.5 - d) / 5.5;
        threatX -= ((ex - px) / (d || 1)) * w;
        threatZ -= ((ez - pz) / (d || 1)) * w;
      }
      if (d < nearestThreat) nearestThreat = d;
    });

    // --- ground hazards ----------------------------------------------------
    // The boss telegraphs everything on the floor, so the bot reads the same
    // information a player does: get out of the marked band, dashing if the
    // wave is already on top of it.
    this.threats.length = 0;
    this.game.bossRef?.collectThreats(this.threats);
    this.hazards.length = 0;
    this.game.collectHazards(this.hazards);
    for (const h of this.hazards) {
      const d = Math.hypot(px - h.x, pz - h.z);
      if (d < h.r) this.threats.push({ x: h.x, z: h.z, inner: 0, outer: h.r + 1.4 });
    }
    let dodgeX = 0;
    let dodgeZ = 0;
    let urgent = false;
    for (const t of this.threats) {
      const dx = px - t.x;
      const dz = pz - t.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > t.inner && d < t.outer) {
        // Inside the band: leave by the shortest route (outward for a ring
        // that has already passed the centre, inward otherwise).
        const outward = d > (t.inner + t.outer) * 0.5 ? 1 : -1;
        dodgeX += (dx / d) * outward * 2.2;
        dodgeZ += (dz / d) * outward * 2.2;
        urgent = true;
      } else if (d < t.outer + 2.5 && d > t.inner) {
        dodgeX += (dx / d) * 0.8;
        dodgeZ += (dz / d) * 0.8;
      }
    }

    // --- objective ---------------------------------------------------------
    if (this.repickTimer <= 0) {
      this.repickTimer = 0.4;
      this.pickTarget(px, pz);
    }

    let dx = this.targetX - px;
    let dz = this.targetZ - pz;
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist;
    dz /= dist;

    // Blend in threat avoidance, weighted by how close the danger is.
    const avoid = clamp01((6 - nearestThreat) / 6) * 0.9;
    let mx = dx * (1 - avoid * 0.55) + threatX * avoid;
    let mz = dz * (1 - avoid * 0.55) + threatZ * avoid;
    if (dodgeX !== 0 || dodgeZ !== 0) {
      const w = urgent ? 3.0 : 1.1;
      mx = mx * 0.35 + dodgeX * w;
      mz = mz * 0.35 + dodgeZ * w;
    }

    // If we've barely moved for a while, we're wedged on a prop — wander out.
    if (Math.hypot(px - this.lastX, pz - this.lastZ) < 0.35) {
      this.stuckTimer += dt;
    } else {
      this.stuckTimer = 0;
      this.lastX = px;
      this.lastZ = pz;
    }
    if (this.stuckTimer > 0.9) {
      this.wanderAngle += dt * 5;
      mx = Math.cos(this.wanderAngle);
      mz = Math.sin(this.wanderAngle);
      if (this.stuckTimer > 1.4 && this.dashCooldown <= 0) {
        input.dash = true;
        this.dashCooldown = 0.5;
        this.stuckTimer = 0;
      }
    }

    // Stay inside the arena.
    const radius = this.game.bossRef ? CFG.boss.arenaRadius : (this.game.arenaRef?.layout.radius ?? 26);
    const fromCentre = Math.hypot(px, pz);
    if (fromCentre > radius - 3) {
      mx -= (px / fromCentre) * 1.2;
      mz -= (pz / fromCentre) * 1.2;
    }

    const m = Math.hypot(mx, mz) || 1;
    input.x = mx / m;
    input.y = mz / m;

    // --- dash decisions ----------------------------------------------------
    if (urgent && this.dashCooldown <= 0 && player.dashCharge >= 1) {
      // Dash out of a live band — dash i-frames make this the correct answer.
      input.dash = true;
      this.dashCooldown = 0.42;
    } else if (this.dashCooldown <= 0 && player.dashCharge >= 1) {
      const boss = this.game.bossRef;
      if (boss && boss.coreExposed) {
        const cp = boss.model.corePosition;
        if (Math.hypot(cp.x - px, cp.z - pz) < 6.5) {
          input.dash = true;
          this.dashCooldown = 0.45;
        }
      } else if (nearestThreat < 2.6) {
        input.dash = true; // escape
        this.dashCooldown = 0.6;
      } else if (dist > 7 && nearestThreat > 5) {
        input.dash = true; // travel
        this.dashCooldown = 0.75;
      }
    }

    // --- overdrive ---------------------------------------------------------
    if (player.overdriveReady) input.overdrive = true;
  }

  private pickTarget(px: number, pz: number): void {
    const boss = this.game.bossRef;
    if (boss) {
      if (boss.coreExposed) {
        const cp = boss.model.corePosition;
        const bp = boss.bossPosition;
        // Stand just outside the hull and let the dash cover the last stretch.
        const ax = cp.x - bp.x;
        const az = cp.z - bp.z;
        const al = Math.hypot(ax, az) || 1;
        this.targetX = cp.x + (ax / al) * 2.5;
        this.targetZ = cp.z + (az / al) * 2.5;
      } else {
        // Circle at a respectful distance while it attacks.
        const bp = boss.bossPosition;
        const a = Math.atan2(pz - bp.z, px - bp.x) + 0.5;
        this.targetX = bp.x + Math.cos(a) * 13;
        this.targetZ = bp.z + Math.sin(a) * 13;
      }
      return;
    }

    const pods = this.game.podsRef;
    if (pods.remaining > 0) {
      const pod = pods.nearestPod(px, pz);
      if (pod) {
        // Detour for a bolt if one is basically on the way.
        const bolt = this.game.collectiblesRef.nearestTo(px, pz, 7);
        if (bolt) {
          const toPod = Math.hypot(pod.x - px, pod.z - pz);
          const viaBolt = Math.hypot(bolt.x - px, bolt.z - pz) +
            Math.hypot(pod.x - bolt.x, pod.z - bolt.z);
          if (viaBolt < toPod * 1.45) {
            this.targetX = bolt.x;
            this.targetZ = bolt.z;
            return;
          }
        }
        this.targetX = pod.x;
        this.targetZ = pod.z;
        return;
      }
    }

    const arena = this.game.arenaRef;
    if (arena) {
      // Everything rescued — sweep up nearby bolts, then take the exit.
      const bolt = this.game.collectiblesRef.nearestTo(px, pz, 12);
      if (bolt && this.game.collectiblesRef.count > 6) {
        this.targetX = bolt.x;
        this.targetZ = bolt.z;
        return;
      }
      this.targetX = arena.layout.portal.x;
      this.targetZ = arena.layout.portal.z;
    }
  }
}
