import { createEnemy, createScrapBurst } from '../render/models/Enemies';
import type { EnemyKind, EnemyModel } from '../render/models/Enemies';
import { createExtraEnemy, createExtraScrapBurst } from '../render/models/EnemiesExtra';
import type { ExtraEnemyKind } from '../render/models/EnemiesExtra';

/**
 * The full hostile roster, unifying the original five with the five added for
 * Swarm mode. Everything downstream (AI, waves, scoring, the bot) works off
 * `AnyEnemyKind` so a new type only has to be registered here and given a
 * behaviour in `Entities.think()`.
 */

export type AnyEnemyKind = EnemyKind | ExtraEnemyKind;

const EXTRA: ReadonlySet<string> = new Set<ExtraEnemyKind>([
  'skitter', 'lobber', 'splitter', 'snatcher', 'warden',
]);

export function isExtra(kind: AnyEnemyKind): kind is ExtraEnemyKind {
  return EXTRA.has(kind);
}

export function buildEnemyModel(kind: AnyEnemyKind): EnemyModel {
  return isExtra(kind) ? createExtraEnemy(kind) : createEnemy(kind);
}

export function buildScrapBurst(kind: AnyEnemyKind): {
  root: import('three').Group;
  update(dt: number): boolean;
  dispose(): void;
} {
  return isExtra(kind) ? createExtraScrapBurst(kind) : createScrapBurst(kind);
}

export interface EnemyCfg {
  hp: number;
  speed: number;
  damage: number;
  score: number;
  /** Collision radius. */
  radius: number;
  /** Resting height above the ground; 0 for ground-walkers. */
  hover: number;
  chargeSpeed?: number;
  beamRange?: number;
  blastRadius?: number;
  /** Lobber shell travel time and splash. */
  shellTime?: number;
  shellRadius?: number;
  /** Warden aura. */
  auraRadius?: number;
  /** Splitter children spawned on death. */
  splitInto?: number;
  /** How much of the parent's size/HP a child keeps. */
  childScale?: number;
  /** True if this type goes after the repair pad / Sparkies in Swarm mode. */
  targetsPad?: boolean;
}

export const ENEMY_CFG: Record<AnyEnemyKind, EnemyCfg> = {
  // --- originals -----------------------------------------------------------
  buzzbot: { hp: 2, speed: 3.4, damage: 1, score: 120, radius: 0.55, hover: 1.15, targetsPad: true },
  sawdrone: {
    hp: 3, speed: 4.2, chargeSpeed: 15.5, damage: 1, score: 200,
    radius: 0.6, hover: 0.95, targetsPad: true,
  },
  zapper: { hp: 4, speed: 0, damage: 1, score: 240, radius: 0.7, hover: 1.0, beamRange: 12 },
  bomblet: {
    hp: 2, speed: 5.6, damage: 1, score: 220, radius: 0.5, hover: 0.85,
    blastRadius: 3.4, targetsPad: true,
  },
  shieldbot: { hp: 4, speed: 3.0, damage: 1, score: 320, radius: 0.68, hover: 1.1, targetsPad: true },

  // --- new -----------------------------------------------------------------
  /** Fast, fragile ground swarmer. Comes in numbers; dies to anything. */
  skitter: { hp: 1, speed: 7.4, damage: 1, score: 90, radius: 0.42, hover: 0, targetsPad: true },
  /** Stationary artillery. Lobs a shell at a marked circle — pure "read the floor". */
  lobber: {
    hp: 5, speed: 0, damage: 1, score: 280, radius: 0.72, hover: 0,
    shellTime: 1.35, shellRadius: 3.2,
  },
  /** Slow pod that breaks into two smaller pods when destroyed. */
  splitter: {
    hp: 4, speed: 2.5, damage: 1, score: 260, radius: 0.66, hover: 1.05,
    splitInto: 2, childScale: 0.6, targetsPad: true,
  },
  /** Steals a Sparkie and runs for the rim. The reason Swarm mode has stakes. */
  snatcher: { hp: 4, speed: 5.0, damage: 1, score: 340, radius: 0.62, hover: 1.35 },
  /** Support drone: shields everything nearby. Kill it first. */
  warden: {
    hp: 6, speed: 2.2, damage: 1, score: 400, radius: 0.7, hover: 1.2, auraRadius: 7.5,
  },
};

/** Every kind, in the order they're introduced to the player. */
export const ALL_ENEMY_KINDS: AnyEnemyKind[] = [
  'buzzbot', 'skitter', 'sawdrone', 'bomblet', 'splitter',
  'zapper', 'lobber', 'shieldbot', 'snatcher', 'warden',
];
