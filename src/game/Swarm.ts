import * as THREE from 'three';
import { createRepairPad } from '../render/models/Deployables';
import type { RepairPadModel } from '../render/models/Deployables';
import type { AnyEnemyKind } from './EnemyTypes';
import type { Fx } from '../render/Fx';
import { PAL } from '../render/Palette';
import { glowMat } from '../render/Materials';
import { clamp, clamp01, makeRandom } from '../core/Util';

/**
 * SWARM MODE — "Hold the Repair Pad".
 *
 * Rescued Sparkies gather on a pad in the middle of the arena. Waves of drones
 * come for them. You lose when the pad falls, **not** when you personally run
 * out of hearts — getting hit costs you tempo, not the run. That distinction is
 * the whole reason the mode works for the target age: a child who is having a
 * bad fight still gets to keep playing and try to save it.
 *
 * Structure is a loop of two phases:
 *   BUILD  — a short calm window to spend bolts on gadgets and rescue stragglers
 *   FIGHT  — a wave spawns at the rim and walks in
 * Each wave is bigger and mixes in one new enemy type at a time, so the player
 * always has exactly one new thing to read.
 */

export type SwarmPhase = 'build' | 'fight' | 'lost';

export interface WaveComposition {
  kind: AnyEnemyKind;
  count: number;
}

export interface SwarmSnapshot {
  phase: SwarmPhase;
  wave: number;
  /** Seconds left in the build phase (0 while fighting). */
  buildLeft: number;
  padHealth: number;
  padMax: number;
  /** Enemies still alive from the current wave. */
  remaining: number;
  sparkiesHome: number;
  bank: number;
}

const PAD_RADIUS = 4.6;
const PAD_MAX_HP = 180;
const BUILD_SECONDS = 16;
const FIRST_BUILD_SECONDS = 24;

export class SwarmDirector {
  readonly root = new THREE.Group();
  readonly padPosition = new THREE.Vector3(0, 0, 0);
  readonly padRadius = PAD_RADIUS;

  phase: SwarmPhase = 'build';
  wave = 0;
  padHp = PAD_MAX_HP;
  bank = 0;
  sparkiesHome = 0;

  private pad: RepairPadModel;
  private padRing: THREE.Mesh;
  private buildTimer = FIRST_BUILD_SECONDS;
  private spawnQueue: Array<{ kind: AnyEnemyKind; at: number }> = [];
  private waveClock = 0;
  private aliveFromWave = 0;
  private rng = makeRandom(0x5eed11);
  private time = 0;
  private damageFlash = 0;

  onWaveStart: ((wave: number, composition: WaveComposition[]) => void) | null = null;
  onWaveClear: ((wave: number) => void) | null = null;
  onSpawn: ((kind: AnyEnemyKind, x: number, z: number) => void) | null = null;
  onPadHit: ((remaining01: number) => void) | null = null;
  onLost: (() => void) | null = null;
  onSparkieHome: ((total: number) => void) | null = null;

  constructor(arenaRadius: number) {
    this.pad = createRepairPad(PAD_RADIUS);
    this.root.add(this.pad.root);

    // A soft ring marking the ground the player is defending.
    this.padRing = new THREE.Mesh(
      new THREE.RingGeometry(PAD_RADIUS + 0.2, PAD_RADIUS + 0.75, 48),
      glowMat(PAL.energy, 0.4, true),
    );
    this.padRing.rotation.x = -Math.PI / 2;
    this.padRing.position.y = 0.04;
    this.padRing.renderOrder = 4;
    this.root.add(this.padRing);
    this.arenaRadius = arenaRadius;
  }

  private arenaRadius: number;

  reset(): void {
    this.phase = 'build';
    this.wave = 0;
    this.padHp = PAD_MAX_HP;
    this.bank = 0;
    this.sparkiesHome = 0;
    this.buildTimer = FIRST_BUILD_SECONDS;
    this.spawnQueue.length = 0;
    this.aliveFromWave = 0;
    this.waveClock = 0;
  }

  snapshot(out: SwarmSnapshot): SwarmSnapshot {
    out.phase = this.phase;
    out.wave = this.wave;
    out.buildLeft = this.phase === 'build' ? Math.max(0, this.buildTimer) : 0;
    out.padHealth = this.padHp;
    out.padMax = PAD_MAX_HP;
    out.remaining = this.aliveFromWave;
    out.sparkiesHome = this.sparkiesHome;
    out.bank = this.bank;
    return out;
  }

  /** Enemy HP multiplier for the current wave. */
  get hpScale(): number {
    // Without this, a fixed wall of turret DPS eventually clears every wave
    // instantly and the mode plateaus no matter how many bodies arrive.
    return 1 + Math.max(0, this.wave - 2) * 0.16;
  }

  /** True on the big "elite" waves that arrive as one huge simultaneous drop. */
  isEliteWave(n: number): boolean {
    return n > 0 && n % 5 === 0;
  }

  /**
   * Wave composition. One new enemy type is introduced at a time and then kept,
   * so the player is never asked to learn two behaviours in the same wave.
   */
  composeWave(n: number): WaveComposition[] {
    const out: WaveComposition[] = [];
    const elite = this.isEliteWave(n) ? 1.6 : 1;
    const add = (kind: AnyEnemyKind, base: number, from: number): void => {
      if (n < from) return;
      const count = Math.max(1, Math.round(base * (1 + (n - from) * 0.5) * elite));
      out.push({ kind, count: Math.min(count, 22) });
    };
    add('buzzbot', 3, 1);
    add('skitter', 4, 2);
    add('sawdrone', 2, 3);
    add('splitter', 2, 4);
    add('bomblet', 2, 5);
    add('snatcher', 1, 6);
    add('zapper', 1, 7);
    add('lobber', 1, 8);
    add('shieldbot', 2, 9);
    add('warden', 1, 11);
    return out;
  }

  /** Total enemies in a wave — used for the HUD and for pacing the spawns. */
  private queueWave(n: number): void {
    const comp = this.composeWave(n);
    this.spawnQueue.length = 0;

    // Enemies arrive in SQUADS, not as a steady trickle.
    //
    // A one-at-a-time drip is trivially handled by any static defence: each
    // arrival gets focused down before the next appears, so a wall of turrets
    // clears wave 20 as easily as wave 2 and the mode plateaus. Grouping four
    // to eight drones into a squad that lands together, at the same point on
    // the rim, is what actually threatens an entrenched position — and it's
    // what makes the player move rather than camp.
    const pools = comp.map((c) => ({ kind: c.kind, left: c.count }));
    let total = 0;
    for (const p of pools) total += p.left;

    const squadSize = Math.min(8, 3 + Math.floor(n / 2));
    const gapBetweenSquads = Math.max(1.6, 4.2 - n * 0.18);
    let t = 0;
    let inSquad = 0;
    for (let i = 0; i < total; i++) {
      const live = pools.filter((p) => p.left > 0);
      const pick = live[Math.floor(this.rng() * live.length)]!;
      pick.left -= 1;
      this.spawnQueue.push({ kind: pick.kind, at: t });
      // Members of a squad land within a fraction of a second of each other.
      inSquad += 1;
      if (inSquad >= squadSize) {
        inSquad = 0;
        t += gapBetweenSquads;
      } else {
        t += 0.06;
      }
    }
    this.aliveFromWave = total;
    this.onWaveStart?.(n, comp);
  }

  /** Squads share a rim position, so they arrive as a group from one side. */
  private squadAngle = 0;
  private squadCounter = 0;

  nextSpawnPoint(radius: number, out: { x: number; z: number }): void {
    if (this.squadCounter <= 0) {
      this.squadCounter = Math.min(8, 3 + Math.floor(this.wave / 2));
      this.squadAngle = this.rng() * Math.PI * 2;
    }
    this.squadCounter -= 1;
    // Small jitter so they don't stack on one pixel.
    const a = this.squadAngle + (this.rng() - 0.5) * 0.5;
    const r = radius - 2.2 - this.rng() * 1.5;
    out.x = Math.cos(a) * r;
    out.z = Math.sin(a) * r;
  }

  /**
   * How many drones are on the field right now. The director will not exceed
   * `maxConcurrent`, holding the rest of the wave in the queue until slots free
   * up — a late wave is 170+ bodies, and rendering them all at once would cost
   * more frame rate than it adds tension.
   */
  liveEnemies = 0;
  readonly maxConcurrent = 42;

  /** Called by the game whenever an enemy dies, so the wave can end. */
  noteEnemyDefeated(): void {
    if (this.phase === 'fight') this.aliveFromWave = Math.max(0, this.aliveFromWave - 1);
  }

  /** Bolts collected in Swarm mode are currency as well as score. */
  addBank(amount: number): void {
    this.bank += amount;
  }

  spend(amount: number): boolean {
    if (this.bank < amount) return false;
    this.bank -= amount;
    return true;
  }

  /** A rescued Sparkie reached the pad. */
  registerSparkieHome(): void {
    this.sparkiesHome += 1;
    this.onSparkieHome?.(this.sparkiesHome);
  }

  damagePad(amount: number, fx: Fx): void {
    if (this.phase === 'lost') return;
    this.padHp = Math.max(0, this.padHp - amount);
    this.damageFlash = 1;
    this.pad.hit();
    this.onPadHit?.(clamp01(this.padHp / PAD_MAX_HP));
    fx.burst('spark', this.padPosition.x, 0.9, this.padPosition.z, {
      count: 8, color: PAL.danger, speed: 7, size: 0.3, life: 0.35,
    });
    if (this.padHp <= 0) {
      this.phase = 'lost';
      this.onLost?.();
    }
  }

  repairPad(amount: number): void {
    if (this.phase === 'lost') return;
    this.padHp = Math.min(PAD_MAX_HP, this.padHp + amount);
  }

  /** True while the player is standing on the pad (used for the build prompt). */
  isOnPad(x: number, z: number): boolean {
    return (x - this.padPosition.x) ** 2 + (z - this.padPosition.z) ** 2 < PAD_RADIUS * PAD_RADIUS;
  }

  update(dt: number, fx: Fx, repairRate: number): void {
    this.time += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.4);

    if (this.phase === 'build') {
      this.buildTimer -= dt;
      if (this.buildTimer <= 0) {
        this.phase = 'fight';
        this.waveClock = 0;
        this.wave += 1;
        this.queueWave(this.wave);
      }
    } else if (this.phase === 'fight') {
      this.waveClock += dt;
      while (
        this.spawnQueue.length > 0 &&
        this.spawnQueue[0]!.at <= this.waveClock &&
        this.liveEnemies < this.maxConcurrent
      ) {
        const next = this.spawnQueue.shift()!;
        // Spawn on the rim, so waves always arrive from outside the play space.
        this.nextSpawnPoint(this.arenaRadius, _spawnPt);
        this.onSpawn?.(next.kind, _spawnPt.x, _spawnPt.z);
      }
      if (this.spawnQueue.length === 0 && this.aliveFromWave <= 0) {
        this.onWaveClear?.(this.wave);
        this.phase = 'build';
        this.buildTimer = BUILD_SECONDS;
      }
    }

    if (repairRate > 0) this.repairPad(repairRate * dt);

    const health01 = clamp01(this.padHp / PAD_MAX_HP);
    this.pad.update(this.time, dt, health01, this.sparkiesHome);
    const mat = this.padRing.material as THREE.MeshBasicMaterial;
    const pulse = 0.5 + Math.sin(this.time * (health01 < 0.35 ? 7 : 2)) * 0.5;
    mat.opacity = 0.22 + pulse * (health01 < 0.35 ? 0.45 : 0.18) + this.damageFlash * 0.3;
    mat.color.setHex(health01 > 0.6 ? PAL.energy : health01 > 0.3 ? PAL.hazard : PAL.danger);

    // Smoke from a badly damaged pad — a second, non-colour cue that it's dying.
    if (health01 < 0.55 && Math.random() < dt * (10 + (1 - health01) * 30)) {
      fx.emitOne(
        'smoke',
        this.padPosition.x + (Math.random() - 0.5) * PAD_RADIUS * 1.4,
        0.6,
        this.padPosition.z + (Math.random() - 0.5) * PAD_RADIUS * 1.4,
        (Math.random() - 0.5) * 1.2, 2.4 + Math.random() * 1.5, (Math.random() - 0.5) * 1.2,
        health01 < 0.3 ? 0x6b6f86 : 0xb9c0d6,
        0.7, 1.3, 0.5, 1, -1.2,
      );
    }
  }

  /** Where a rescued Sparkie should fly to — a ring of docking spots on the pad. */
  homeSlot(index: number, out: THREE.Vector3): THREE.Vector3 {
    const ring = Math.floor(index / 8);
    const slot = index % 8;
    const a = (slot / 8) * Math.PI * 2 + ring * 0.4;
    const r = PAD_RADIUS * (0.55 + ring * 0.24);
    out.set(
      this.padPosition.x + Math.cos(a) * r,
      1.1 + Math.sin(this.time * 2 + index) * 0.12,
      this.padPosition.z + Math.sin(a) * r,
    );
    return out;
  }

  /**
   * End-of-run bonus, *added* to the score the player already watched tick up.
   * Replacing the running total made the number visibly drop on the results
   * screen, which reads as a punishment for finishing.
   */
  endBonus(): number {
    return (
      this.wave * 1200 +
      this.sparkiesHome * 350 +
      Math.round(clamp(this.padHp, 0, PAD_MAX_HP) * 8)
    );
  }

  dispose(): void {
    this.pad.dispose();
    this.padRing.geometry.dispose();
  }
}

const _spawnPt = { x: 0, z: 0 };
