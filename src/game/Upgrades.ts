import { CFG } from './Config';
import { shuffle } from '../core/Util';

/**
 * Between stages the player picks one of three upgrades.
 *
 * Design rules, aimed squarely at a 9-year-old:
 *  - Every upgrade is a single sentence with a concrete verb. No percentages
 *    that need mental arithmetic, no stat sheets.
 *  - Each one changes something the player can *see* the very next stage —
 *    a bigger magnet ring, a second dash pip, a Sparkie that helps.
 *  - Nothing is a trap. The worst pick is still a real improvement, so a bad
 *    choice never ruins a run.
 *  - Repeat picks stack, so a run can commit to a "build" (all-magnet, all-dash,
 *    all-Sparkie) which is where the replayability comes from.
 */

export type UpgradeId =
  | 'magnet' | 'dashCharge' | 'dashSpeed' | 'dashRecharge' | 'shield' | 'heart'
  | 'zapRate' | 'zapPower' | 'zapChain' | 'overdriveLong' | 'overdriveFast'
  | 'speed' | 'sparkieHelper' | 'scoreBoost' | 'boltValue' | 'comboHold'
  | 'shockwave' | 'guardian';

export interface Upgrade {
  id: UpgradeId;
  name: string;
  /** Short enough to read at a glance on a phone. */
  desc: string;
  icon: string;
  /** Palette hue for the card. */
  color: string;
  maxStacks: number;
  /** Rarity weight — higher shows up more often. */
  weight: number;
  apply: (s: PlayerStats) => void;
}

export interface PlayerStats {
  maxSpeed: number;
  dashCharges: number;
  dashRecharge: number;
  dashSpeed: number;
  dashShockRadius: number;
  magnetRadius: number;
  zapInterval: number;
  zapDamage: number;
  zapChains: number;
  maxHearts: number;
  shields: number;
  overdriveDuration: number;
  overdriveGain: number;
  sparkieHelpers: number;
  scoreMultiplier: number;
  boltValue: number;
  comboWindow: number;
  /** Auto-revive once per run. */
  guardian: number;
}

export function baseStats(): PlayerStats {
  return {
    maxSpeed: CFG.player.maxSpeed,
    dashCharges: CFG.dash.charges,
    dashRecharge: CFG.dash.rechargeTime,
    dashSpeed: CFG.dash.speed,
    dashShockRadius: CFG.dash.shockRadius,
    magnetRadius: CFG.magnet.radius,
    zapInterval: CFG.zap.interval,
    zapDamage: CFG.zap.damage,
    zapChains: CFG.zap.chains,
    maxHearts: CFG.health.maxHearts,
    shields: 0,
    overdriveDuration: CFG.overdrive.duration,
    overdriveGain: 1,
    sparkieHelpers: 0,
    scoreMultiplier: 1,
    boltValue: CFG.score.bolt,
    comboWindow: CFG.combo.window,
    guardian: 0,
  };
}

export const UPGRADES: Upgrade[] = [
  {
    id: 'magnet',
    name: 'Big Magnet',
    desc: 'Pull bolts from further away.',
    icon: 'magnet',
    color: '#53f2ff',
    maxStacks: 4,
    weight: 12,
    apply: (s) => {
      s.magnetRadius += 1.5;
    },
  },
  {
    id: 'dashCharge',
    name: 'Extra Dash',
    desc: 'One more dash in the tank.',
    icon: 'dash',
    color: '#ffd447',
    maxStacks: 3,
    weight: 11,
    apply: (s) => {
      s.dashCharges += 1;
    },
  },
  {
    id: 'dashRecharge',
    name: 'Quick Charge',
    desc: 'Dashes come back faster.',
    icon: 'battery',
    color: '#ffd447',
    maxStacks: 4,
    weight: 11,
    apply: (s) => {
      s.dashRecharge = Math.max(0.42, s.dashRecharge * 0.76);
    },
  },
  {
    id: 'dashSpeed',
    name: 'Rocket Dash',
    desc: 'Dash further and hit harder.',
    icon: 'rocket',
    color: '#ff7a4d',
    maxStacks: 3,
    weight: 9,
    apply: (s) => {
      s.dashSpeed += 5.5;
      s.dashShockRadius += 0.35;
    },
  },
  {
    id: 'shockwave',
    name: 'Boom Dash',
    desc: 'Dash makes a bigger shockwave.',
    icon: 'wave',
    color: '#ff7a4d',
    maxStacks: 3,
    weight: 9,
    apply: (s) => {
      s.dashShockRadius += 1.25;
    },
  },
  {
    id: 'shield',
    name: 'Bubble Shield',
    desc: 'Blocks one hit. Comes back each stage.',
    icon: 'shield',
    color: '#8ad7ff',
    maxStacks: 3,
    weight: 10,
    apply: (s) => {
      s.shields += 1;
    },
  },
  {
    id: 'heart',
    name: 'Repair Kit',
    desc: 'One more heart, healed right now.',
    icon: 'heart',
    color: '#ff6f91',
    maxStacks: 3,
    weight: 8,
    apply: (s) => {
      s.maxHearts += 1;
    },
  },
  {
    id: 'zapRate',
    name: 'Fast Zapper',
    desc: 'Your zap tool fires quicker.',
    icon: 'bolt',
    color: '#c7b3ff',
    maxStacks: 4,
    weight: 11,
    apply: (s) => {
      s.zapInterval = Math.max(0.14, s.zapInterval * 0.74);
    },
  },
  {
    id: 'zapPower',
    name: 'Power Zap',
    desc: 'Zaps do more damage.',
    icon: 'power',
    color: '#c7b3ff',
    maxStacks: 4,
    weight: 10,
    apply: (s) => {
      s.zapDamage += 1;
    },
  },
  {
    id: 'zapChain',
    name: 'Chain Zap',
    desc: 'Zaps jump to another drone.',
    icon: 'chain',
    color: '#c7b3ff',
    maxStacks: 3,
    weight: 8,
    apply: (s) => {
      s.zapChains += 1;
    },
  },
  {
    id: 'overdriveLong',
    name: 'Long Overdrive',
    desc: 'Overdrive lasts longer.',
    icon: 'star',
    color: '#ffc93c',
    maxStacks: 3,
    weight: 8,
    apply: (s) => {
      s.overdriveDuration += 3;
    },
  },
  {
    id: 'overdriveFast',
    name: 'Overcharge',
    desc: 'Fill the Overdrive bar faster.',
    icon: 'charge',
    color: '#ffc93c',
    maxStacks: 3,
    weight: 9,
    apply: (s) => {
      s.overdriveGain += 0.45;
    },
  },
  {
    id: 'speed',
    name: 'Turbo Board',
    desc: 'Zoom around a bit faster.',
    icon: 'speed',
    color: '#9dffd0',
    maxStacks: 3,
    weight: 9,
    apply: (s) => {
      s.maxSpeed += 1.15;
    },
  },
  {
    id: 'sparkieHelper',
    name: 'Sparkie Buddy',
    desc: 'A Sparkie grabs bolts for you.',
    icon: 'sparkie',
    color: '#9dfcff',
    maxStacks: 4,
    weight: 10,
    apply: (s) => {
      s.sparkieHelpers += 1;
    },
  },
  {
    id: 'scoreBoost',
    name: 'Star Bonus',
    desc: 'Everything is worth more points.',
    icon: 'trophy',
    color: '#ffd447',
    maxStacks: 4,
    weight: 8,
    apply: (s) => {
      s.scoreMultiplier += 0.22;
    },
  },
  {
    id: 'boltValue',
    name: 'Golden Bolts',
    desc: 'Bolts are worth double.',
    icon: 'coin',
    color: '#ffd447',
    maxStacks: 2,
    weight: 7,
    apply: (s) => {
      s.boltValue *= 2;
    },
  },
  {
    id: 'comboHold',
    name: 'Combo Glue',
    desc: 'Your combo lasts longer.',
    icon: 'combo',
    color: '#ff9ad5',
    maxStacks: 3,
    weight: 9,
    apply: (s) => {
      s.comboWindow += 0.75;
    },
  },
  {
    id: 'guardian',
    name: 'Guardian Sparkie',
    desc: 'Saves you once if you run out.',
    icon: 'guardian',
    color: '#9dfcff',
    maxStacks: 1,
    weight: 5,
    apply: (s) => {
      s.guardian += 1;
    },
  },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function getUpgrade(id: UpgradeId): Upgrade {
  return BY_ID.get(id)!;
}

/**
 * Picks three distinct offers, weighted by rarity, excluding anything already
 * maxed. Guarantees variety by never offering two upgrades from the same
 * "family" when it can avoid it, so the choice always feels meaningful.
 */
export function rollUpgradeChoices(
  taken: Record<string, number>,
  rng: () => number,
  count = 3,
): Upgrade[] {
  const family: Record<string, string> = {
    magnet: 'collect', sparkieHelper: 'collect', boltValue: 'collect',
    dashCharge: 'dash', dashRecharge: 'dash', dashSpeed: 'dash', shockwave: 'dash',
    zapRate: 'attack', zapPower: 'attack', zapChain: 'attack',
    shield: 'defence', heart: 'defence', guardian: 'defence',
    overdriveLong: 'overdrive', overdriveFast: 'overdrive',
    speed: 'move', scoreBoost: 'score', comboHold: 'score',
  };

  const pool = UPGRADES.filter((u) => (taken[u.id] ?? 0) < u.maxStacks);
  const chosen: Upgrade[] = [];
  const usedFamilies = new Set<string>();

  for (let pass = 0; pass < 2 && chosen.length < count; pass++) {
    const candidates = shuffle(
      rng,
      pool.filter(
        (u) => !chosen.includes(u) && (pass === 1 || !usedFamilies.has(family[u.id] ?? u.id)),
      ),
    );
    // Weighted draw without replacement.
    while (chosen.length < count && candidates.length > 0) {
      let total = 0;
      for (const c of candidates) total += c.weight;
      let roll = rng() * total;
      let idx = 0;
      for (let i = 0; i < candidates.length; i++) {
        roll -= candidates[i]!.weight;
        if (roll <= 0) {
          idx = i;
          break;
        }
      }
      const picked = candidates.splice(idx, 1)[0]!;
      chosen.push(picked);
      usedFamilies.add(family[picked.id] ?? picked.id);
    }
  }
  return chosen;
}
