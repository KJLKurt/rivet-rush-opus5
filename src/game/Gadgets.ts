import * as THREE from 'three';
import { createDeployable } from '../render/models/Deployables';
import type { DeployableKind, DeployableModel } from '../render/models/Deployables';
import type { Fx } from '../render/Fx';
import type { Enemies, EnemyHitEvent } from './Entities';
import { PAL } from '../render/Palette';
import { clamp01, swapRemove } from '../core/Util';

/**
 * The player's deployable gadgets, used in Swarm mode.
 *
 * Placement is deliberately aim-free: a gadget is always built **where Rivet is
 * standing**. The whole game is built on "you never aim, you position", and
 * asking a seven-year-old to drag a cursor around a 3D plane with their thumb
 * while drones close in would break that promise. Choosing *where to stand* is
 * the interesting decision; pointing at a tile is just friction.
 */

export interface GadgetSpec {
  kind: DeployableKind;
  name: string;
  /** Short enough for a button label under an icon. */
  blurb: string;
  icon: string;
  cost: number;
  hp: number;
  /** Effect radius, in world units. Also what the placement ring shows. */
  radius: number;
  /** Seconds between actions (turret shots, shocker pulses). */
  interval: number;
  damage: number;
  /** Lifetime in seconds; 0 = permanent until destroyed. */
  lifetime: number;
  colour: string;
}

export const GADGETS: Record<DeployableKind, GadgetSpec> = {
  turret: {
    kind: 'turret', name: 'Turret', blurb: 'Shoots drones',
    icon: 'power', cost: 50, hp: 6, radius: 9, interval: 0.55, damage: 1,
    lifetime: 0, colour: '#ffd447',
  },
  wall: {
    kind: 'wall', name: 'Wall', blurb: 'Blocks the way',
    icon: 'shield', cost: 30, hp: 14, radius: 1.6, interval: 0, damage: 0,
    lifetime: 0, colour: '#8ad7ff',
  },
  bomb: {
    kind: 'bomb', name: 'Bomb', blurb: 'Big boom',
    icon: 'wave', cost: 70, hp: 3, radius: 4.6, interval: 0, damage: 5,
    lifetime: 0, colour: '#ff7a4d',
  },
  shocker: {
    kind: 'shocker', name: 'Shocker', blurb: 'Zaps all around',
    icon: 'bolt', cost: 110, hp: 8, radius: 6.2, interval: 1.5, damage: 2,
    lifetime: 0, colour: '#c7b3ff',
  },
  beacon: {
    kind: 'beacon', name: 'Beacon', blurb: 'Heals the pad',
    icon: 'star', cost: 90, hp: 6, radius: 7.5, interval: 1, damage: 0,
    lifetime: 0, colour: '#9dffd0',
  },
};

/** The shocker's arc colour — a friendly violet, distinct from enemy magenta. */
const SHOCK_COLOUR = 0xc7b3ff;

export const GADGET_ORDER: DeployableKind[] = ['turret', 'wall', 'bomb', 'shocker', 'beacon'];

interface Gadget {
  kind: DeployableKind;
  model: DeployableModel;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  timer: number;
  build: number;
  facing: number;
  alive: boolean;
  /** Set the frame it fires, so the model can play its active pose. */
  active: boolean;
  age: number;
}

export type PlaceResult = 'ok' | 'tooPoor' | 'blocked' | 'full';

export class Gadgets {
  readonly root = new THREE.Group();
  private list: Gadget[] = [];
  private pools: Partial<Record<DeployableKind, DeployableModel[]>> = {};
  private time = 0;

  /** Hard cap, so a rich player can't tank the frame rate with 200 turrets. */
  readonly maxGadgets = 24;

  onFire: ((x: number, z: number, kind: DeployableKind) => void) | null = null;
  onDestroyed: ((x: number, z: number, kind: DeployableKind) => void) | null = null;

  get count(): number {
    return this.list.length;
  }

  /** Every live gadget's collider, so enemies path around walls. */
  colliders(out: Array<{ x: number; z: number; r: number }>): void {
    for (const g of this.list) {
      if (!g.alive || g.build < 0.6) continue;
      if (g.kind === 'wall') out.push({ x: g.x, z: g.z, r: 1.35 });
      else if (g.kind !== 'bomb') out.push({ x: g.x, z: g.z, r: 0.75 });
    }
  }

  canPlace(kind: DeployableKind, x: number, z: number, bank: number, keepClear: Array<{ x: number; z: number; r: number }>): PlaceResult {
    if (bank < GADGETS[kind].cost) return 'tooPoor';
    if (this.list.length >= this.maxGadgets) return 'full';
    for (const g of this.list) {
      if (!g.alive) continue;
      const min = g.kind === 'wall' || kind === 'wall' ? 2.4 : 1.9;
      if ((g.x - x) ** 2 + (g.z - z) ** 2 < min * min) return 'blocked';
    }
    for (const c of keepClear) {
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < c.r * c.r) return 'blocked';
    }
    return 'ok';
  }

  place(kind: DeployableKind, x: number, z: number, facing: number): void {
    const spec = GADGETS[kind];
    const pool = (this.pools[kind] ??= []);
    let model = pool.pop();
    if (!model) {
      model = createDeployable(kind);
      this.root.add(model.root);
    }
    model.root.visible = true;
    model.root.position.set(x, 0, z);
    model.setBuildProgress(0);
    model.setFacing(facing);
    this.list.push({
      kind, model, x, z,
      hp: spec.hp, maxHp: spec.hp,
      timer: spec.interval * 0.35,
      build: 0, facing, alive: true, active: false, age: 0,
    });
  }

  /** Damage the nearest gadget to a point — enemies attack what blocks them. */
  damageAt(x: number, z: number, radius: number, amount: number, fx: Fx): void {
    for (const g of this.list) {
      if (!g.alive) continue;
      const r = radius + (g.kind === 'wall' ? 1.4 : 0.8);
      if ((g.x - x) ** 2 + (g.z - z) ** 2 > r * r) continue;
      g.hp -= amount;
      g.model.hit();
      fx.burst('spark', g.x, 0.7, g.z, {
        count: 5, color: PAL.energyWarm, speed: 5, size: 0.22, life: 0.22,
      });
      if (g.hp <= 0) this.destroy(g, fx);
      return;
    }
  }

  /** Nearest live wall/turret to a point, for enemy target selection. */
  nearestBlocking(x: number, z: number, maxDist: number): { x: number; z: number } | null {
    let best: Gadget | null = null;
    let bestD = maxDist * maxDist;
    for (const g of this.list) {
      if (!g.alive || g.build < 0.6 || g.kind === 'bomb') continue;
      const d = (g.x - x) ** 2 + (g.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  private destroy(g: Gadget, fx: Fx): void {
    g.alive = false;
    fx.burst('glow', g.x, 0.6, g.z, {
      count: 18, color: PAL.energyWarm, color2: PAL.metalLight,
      speed: 8, size: 0.45, life: 0.5,
    });
    fx.burst('smoke', g.x, 0.6, g.z, {
      count: 8, color: 0x9aa4c8, speed: 4, size: 0.6, endSize: 1.1, life: 0.7, upBias: 0.6,
    });
    this.onDestroyed?.(g.x, g.z, g.kind);
  }

  /** Total repair-per-second contributed by beacons covering (x, z). */
  repairRateAt(x: number, z: number): number {
    let rate = 0;
    for (const g of this.list) {
      if (!g.alive || g.kind !== 'beacon' || g.build < 1) continue;
      const spec = GADGETS.beacon;
      if ((g.x - x) ** 2 + (g.z - z) ** 2 < spec.radius * spec.radius) rate += 1.1;
    }
    return rate;
  }

  update(
    dt: number,
    enemies: Enemies,
    fx: Fx,
    hits: EnemyHitEvent[],
  ): void {
    this.time += dt;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i]!;
      if (!g.alive) {
        g.model.root.visible = false;
        (this.pools[g.kind] ??= []).push(g.model);
        swapRemove(this.list, i);
        continue;
      }
      g.age += dt;
      g.build = Math.min(1, g.build + dt * 2.6);
      g.model.setBuildProgress(g.build);
      g.active = false;

      const spec = GADGETS[g.kind];
      if (g.build >= 1) {
        switch (g.kind) {
          case 'turret': {
            g.timer -= dt;
            const target = enemies.nearest(g.x, g.z, spec.radius);
            if (target) {
              g.facing = Math.atan2(target.x - g.x, -(target.z - g.z));
              if (g.timer <= 0) {
                g.timer = spec.interval;
                g.active = true;
                enemies.damageEnemy(target, spec.damage, false, hits, fx);
                fx.burst('spark', g.x, 0.95, g.z, {
                  count: 4, color: PAL.bolt, speed: 8, size: 0.2, life: 0.16,
                  dirX: Math.sin(g.facing), dirY: 0, dirZ: -Math.cos(g.facing), focus: 0.85,
                });
                this.onFire?.(g.x, g.z, 'turret');
              }
            }
            break;
          }
          case 'shocker': {
            g.timer -= dt;
            if (g.timer <= 0) {
              g.timer = spec.interval;
              g.active = true;
              enemies.damageAt(g.x, g.z, spec.radius, spec.damage, true, hits, fx);
              fx.shockwave(g.x, 0.12, g.z, 0.6, spec.radius * 2, 0.36, SHOCK_COLOUR, 0.9);
              fx.burst('glow', g.x, 1.2, g.z, {
                count: 16, color: 0xc7b3ff, speed: 9, size: 0.4, life: 0.35,
              });
              this.onFire?.(g.x, g.z, 'shocker');
            }
            break;
          }
          case 'bomb': {
            // Detonates on contact rather than on a timer, so it always feels
            // like the player set a trap that worked.
            const near = enemies.nearest(g.x, g.z, 2.2);
            if (near) {
              enemies.damageAt(g.x, g.z, spec.radius, spec.damage, true, hits, fx);
              fx.shockwave(g.x, 0.12, g.z, 0.8, spec.radius * 2.2, 0.42, PAL.hazard, 1);
              fx.burst('glow', g.x, 0.8, g.z, {
                count: 34, color: PAL.hazard, color2: PAL.overdriveHot,
                speed: 14, size: 0.6, life: 0.55,
              });
              this.onFire?.(g.x, g.z, 'bomb');
              this.destroy(g, fx);
            }
            break;
          }
          case 'beacon':
            g.timer -= dt;
            if (g.timer <= 0) {
              g.timer = spec.interval;
              g.active = true;
            }
            break;
          case 'wall':
            break;
        }
      }

      g.model.setFacing(g.facing);
      g.model.update(this.time, dt, clamp01(g.hp / g.maxHp), this.charge01(g, spec), g.active);
    }
  }

  private charge01(g: Gadget, spec: GadgetSpec): number {
    if (spec.interval <= 0) return clamp01(g.age * 0.6);
    return clamp01(1 - g.timer / spec.interval);
  }

  clear(): void {
    for (const g of this.list) {
      g.model.root.visible = false;
      (this.pools[g.kind] ??= []).push(g.model);
    }
    this.list.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const list of Object.values(this.pools)) {
      for (const m of list ?? []) m.dispose();
    }
  }
}

/** Eased placement-ghost helper shared by the HUD preview. */
export function ghostPulse(t: number): number {
  return 0.55 + Math.sin(t * 6) * 0.18;
}
