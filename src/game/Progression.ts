import type { Profile } from '../core/Save';
import { RivetModel } from '../render/models/Rivet';
import { TRAIL_COLORS } from '../render/Palette';

/**
 * Achievements and cosmetic unlocks.
 *
 * Rules for a kids' game: no streaks, no daily login pressure, no grind walls.
 * Everything unlockable is reachable inside a handful of honest runs, and the
 * challenges describe *skills* ("clear a stage without getting hit") rather
 * than time served ("play 100 games"). Cosmetics never affect gameplay.
 */

export interface RunSummary {
  score: number;
  bestCombo: number;
  sparkies: number;
  bolts: number;
  cells: number;
  enemies: number;
  dashes: number;
  overdrives: number;
  crates: number;
  stagesCleared: number;
  won: boolean;
  timeSeconds: number;
  hitsTaken: number;
  perfectStages: number;
  daily: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** Returns true when the achievement is earned. */
  test: (run: RunSummary, profile: Profile) => boolean;
  /** Cosmetic id granted on unlock, if any. */
  grants?: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'firstRescue',
    name: 'Friend Finder',
    desc: 'Rescue your first Sparkie.',
    icon: 'sparkie',
    test: (_r, p) => p.totalSparkies >= 1,
  },
  {
    id: 'scrapyardClear',
    name: 'Yard Work',
    desc: 'Finish the Sunbeam Scrapyard.',
    icon: 'flag',
    test: (r) => r.stagesCleared >= 2,
  },
  {
    id: 'gardensClear',
    name: 'Green Thumb',
    desc: 'Finish the Cloudtop Gardens.',
    icon: 'leaf',
    test: (r) => r.stagesCleared >= 4,
    grants: 'trail:mint',
  },
  {
    id: 'stormClear',
    name: 'Storm Chaser',
    desc: 'Finish the Stormworks.',
    icon: 'storm',
    test: (r) => r.stagesCleared >= 6,
    grants: 'trail:storm',
  },
  {
    id: 'bossDown',
    name: 'Scrap Sorted',
    desc: 'Beat the Great Scrapbot.',
    icon: 'trophy',
    test: (r) => r.won,
    grants: 'board:scrapking',
  },
  {
    id: 'combo25',
    name: 'On A Roll',
    desc: 'Reach a 25 combo.',
    icon: 'combo',
    test: (r) => r.bestCombo >= 25,
  },
  {
    id: 'combo60',
    name: 'Unstoppable',
    desc: 'Reach a 60 combo.',
    icon: 'combo',
    test: (r) => r.bestCombo >= 60,
    grants: 'trail:bubblegum',
  },
  {
    id: 'perfectStage',
    name: 'Untouchable',
    desc: 'Clear a stage without a scratch.',
    icon: 'shield',
    test: (r) => r.perfectStages >= 1,
  },
  {
    id: 'flawless',
    name: 'Not A Scratch',
    desc: 'Win without taking any damage.',
    icon: 'star',
    test: (r) => r.won && r.hitsTaken === 0,
    grants: 'board:racer',
  },
  {
    id: 'allSparkies',
    name: 'Nobody Left Behind',
    desc: 'Rescue 33 Sparkies in one run.',
    icon: 'sparkie',
    test: (r) => r.sparkies >= 33,
    grants: 'board:sprout',
  },
  {
    id: 'score50k',
    name: 'High Flyer',
    desc: 'Score 50,000 in a run.',
    icon: 'trophy',
    test: (r) => r.score >= 50000,
    grants: 'trail:sunburst',
  },
  {
    id: 'score100k',
    name: 'Sky Legend',
    desc: 'Score 100,000 in a run.',
    icon: 'crown',
    test: (r) => r.score >= 100000,
    grants: 'board:sunburst',
  },
  {
    id: 'overdrive5',
    name: 'Overcharged',
    desc: 'Use Overdrive 5 times in a run.',
    icon: 'charge',
    test: (r) => r.overdrives >= 5,
  },
  {
    id: 'dash200',
    name: 'Board Master',
    desc: 'Dash 200 times overall.',
    icon: 'dash',
    test: (_r, p) => p.totalDashes >= 200,
    grants: 'trail:rainbow',
  },
  {
    id: 'crates25',
    name: 'Crate Expectations',
    desc: 'Smash 25 crates in one run.',
    icon: 'crate',
    test: (r) => r.crates >= 25,
  },
  {
    id: 'bolts5000',
    name: 'Bolt Collector',
    desc: 'Collect 5,000 bolts overall.',
    icon: 'coin',
    test: (_r: RunSummary, p: Profile) => p.totalBolts >= 5000,
  },
  {
    id: 'daily',
    name: 'Daily Dasher',
    desc: 'Finish a Daily Challenge.',
    icon: 'calendar',
    test: (r) => r.daily && r.won,
  },
];

export interface Cosmetic {
  id: string;
  kind: 'trail' | 'board';
  name: string;
  /** Hex colour used for the swatch in the UI. */
  swatch: number;
  /** How it's earned, shown while locked. */
  how: string;
}

export const COSMETICS: Cosmetic[] = [
  { id: 'trail:cyan', kind: 'trail', name: 'Sky Blue', swatch: TRAIL_COLORS.cyan!.a, how: 'Starter' },
  { id: 'trail:sunburst', kind: 'trail', name: 'Sunburst', swatch: TRAIL_COLORS.sunburst!.a, how: 'Score 50,000' },
  { id: 'trail:mint', kind: 'trail', name: 'Mint', swatch: TRAIL_COLORS.mint!.a, how: 'Finish the Gardens' },
  { id: 'trail:bubblegum', kind: 'trail', name: 'Bubblegum', swatch: TRAIL_COLORS.bubblegum!.a, how: 'Reach a 60 combo' },
  { id: 'trail:storm', kind: 'trail', name: 'Storm', swatch: TRAIL_COLORS.storm!.a, how: 'Finish the Stormworks' },
  { id: 'trail:rainbow', kind: 'trail', name: 'Rainbow', swatch: TRAIL_COLORS.rainbow!.a, how: 'Dash 200 times' },
  { id: 'board:classic', kind: 'board', name: 'Classic', swatch: 0xffb03a, how: 'Starter' },
  { id: 'board:racer', kind: 'board', name: 'Racer', swatch: 0xf2f7ff, how: 'Win without damage' },
  { id: 'board:sprout', kind: 'board', name: 'Sprout', swatch: 0x8ce06a, how: 'Rescue 33 Sparkies in a run' },
  { id: 'board:sunburst', kind: 'board', name: 'Sunburst', swatch: 0xffd447, how: 'Score 100,000' },
  { id: 'board:scrapking', kind: 'board', name: 'Scrap King', swatch: 0xd6ddf2, how: 'Beat the Great Scrapbot' },
];

export function cosmeticsOfKind(kind: 'trail' | 'board'): Cosmetic[] {
  return COSMETICS.filter((c) => c.kind === kind);
}

/** Board skins the model actually knows how to render. */
export function validBoardSkins(): string[] {
  return RivetModel.boardSkins;
}

export interface UnlockResult {
  achievements: Achievement[];
  cosmetics: Cosmetic[];
}

/**
 * Evaluates every achievement against a finished run and grants anything new.
 * Mutates the profile; the caller is responsible for saving.
 */
export function evaluateProgress(profile: Profile, run: RunSummary): UnlockResult {
  const gainedAchievements: Achievement[] = [];
  const gainedCosmetics: Cosmetic[] = [];

  for (const a of ACHIEVEMENTS) {
    if (profile.achievements[a.id] !== undefined) continue;
    let earned = false;
    try {
      earned = a.test(run, profile);
    } catch {
      earned = false;
    }
    if (!earned) continue;
    profile.achievements[a.id] = Date.now();
    gainedAchievements.push(a);
    if (a.grants && !profile.unlocked.includes(a.grants)) {
      profile.unlocked.push(a.grants);
      const cosmetic = COSMETICS.find((c) => c.id === a.grants);
      if (cosmetic) gainedCosmetics.push(cosmetic);
    }
  }

  return { achievements: gainedAchievements, cosmetics: gainedCosmetics };
}

/** Star rating for the results screen: 1–3 stars, generous by design. */
export function starsFor(run: RunSummary): number {
  if (!run.won) return 0;
  let stars = 1;
  if (run.hitsTaken <= 6 && run.score >= 30000) stars = 2;
  if (run.hitsTaken <= 2 && run.score >= 60000) stars = 3;
  return stars;
}

export interface DailyModifier {
  id: string;
  name: string;
  desc: string;
  icon: string;
}

/**
 * The Daily Challenge: a deterministic seed from the local date plus two
 * modifiers. Entirely offline — the same device shows the same challenge all
 * day, and there is nothing to lose by skipping a day.
 */
export const DAILY_MODIFIERS: DailyModifier[] = [
  { id: 'speedy', name: 'Turbo Day', desc: 'Everyone moves faster.', icon: 'speed' },
  { id: 'magnet', name: 'Magnet Day', desc: 'Huge pickup magnet.', icon: 'magnet' },
  { id: 'glass', name: 'Careful Day', desc: 'One heart, double points.', icon: 'heart' },
  { id: 'swarm', name: 'Busy Day', desc: 'More drones, more points.', icon: 'drone' },
  { id: 'dashy', name: 'Dash Day', desc: 'Dashes recharge instantly.', icon: 'dash' },
  { id: 'overdrive', name: 'Party Day', desc: 'Overdrive fills twice as fast.', icon: 'star' },
  { id: 'tiny', name: 'Bolt Rain', desc: 'Way more bolts everywhere.', icon: 'coin' },
];

export function dailyModifiers(seed: number): DailyModifier[] {
  const a = DAILY_MODIFIERS[seed % DAILY_MODIFIERS.length]!;
  let bIndex = (Math.floor(seed / 7) + 3) % DAILY_MODIFIERS.length;
  if (DAILY_MODIFIERS[bIndex]!.id === a.id) bIndex = (bIndex + 1) % DAILY_MODIFIERS.length;
  return [a, DAILY_MODIFIERS[bIndex]!];
}
