import type { EnemyKind } from '../render/models/Enemies';

/**
 * The run: six escalating stages across three areas, then the boss.
 *
 * Pacing intent — every stage introduces exactly one new idea and then gives
 * the player a full stage to enjoy being good at it. Nothing is explained in
 * text; the layout teaches it. Stage 1 has no enemies for its first 18 seconds
 * so a child's very first experience is pure "go fast, grab shiny things".
 */

export type AreaId = 'scrapyard' | 'gardens' | 'stormworks' | 'finale';

export interface EnemyWave {
  kind: EnemyKind;
  count: number;
  /** Seconds into the stage before this wave arrives. */
  at: number;
  /** Spawn them together (a ring drop) or trickle them in. */
  trickle?: number;
}

export interface StageDef {
  index: number;
  area: AreaId;
  areaName: string;
  title: string;
  /** One short line shown on the stage card. Icon-led, minimal reading. */
  hint: string;
  radius: number;
  sparkies: number;
  cells: number;
  /** How many arcs/rings of bolts to lay down. */
  boltRoutes: number;
  crates: number;
  waves: EnemyWave[];
  hazards: {
    fans?: number;
    vents?: number;
    barriers?: number;
    boostPads?: number;
  };
  /** Seconds for full time bonus. */
  par: number;
  /** Density of decorative props. */
  decor: number;
  /** Repair hearts placed in the arena. Later stages hand out a safety net. */
  hearts?: number;
  music: 'area1' | 'area2' | 'area3' | 'boss';
}

export const STAGES: StageDef[] = [
  {
    index: 0,
    area: 'scrapyard',
    areaName: 'Sunbeam Scrapyard',
    title: 'Warm-Up Run',
    hint: 'Grab bolts. Free the Sparkies!',
    radius: 24,
    sparkies: 4,
    cells: 2,
    boltRoutes: 5,
    crates: 5,
    waves: [{ kind: 'buzzbot', count: 2, at: 18, trickle: 2.5 }],
    hazards: { boostPads: 2 },
    par: 55,
    decor: 0.7,
    music: 'area1',
  },
  {
    index: 1,
    area: 'scrapyard',
    areaName: 'Sunbeam Scrapyard',
    title: 'Bolt Yard',
    hint: 'Dash through crates!',
    radius: 26,
    sparkies: 5,
    cells: 3,
    boltRoutes: 6,
    crates: 12,
    waves: [
      { kind: 'buzzbot', count: 3, at: 4, trickle: 1.6 },
      { kind: 'buzzbot', count: 3, at: 30, trickle: 1.4 },
    ],
    hazards: { fans: 2, boostPads: 3 },
    par: 60,
    decor: 1,
    music: 'area1',
  },
  {
    index: 2,
    area: 'gardens',
    areaName: 'Cloudtop Gardens',
    title: 'Windmill Way',
    hint: 'Watch the spinning blades.',
    radius: 27,
    sparkies: 5,
    cells: 3,
    boltRoutes: 7,
    crates: 6,
    waves: [
      { kind: 'buzzbot', count: 3, at: 3, trickle: 1.2 },
      { kind: 'sawdrone', count: 2, at: 16, trickle: 3 },
      { kind: 'sawdrone', count: 3, at: 42, trickle: 2 },
    ],
    hazards: { fans: 4, vents: 3, boostPads: 3 },
    par: 65,
    decor: 1.2,
    music: 'area2',
  },
  {
    index: 3,
    area: 'gardens',
    areaName: 'Cloudtop Gardens',
    title: 'Greenhouse Rush',
    hint: 'Turrets glow before they fire.',
    radius: 28,
    sparkies: 6,
    cells: 3,
    boltRoutes: 8,
    crates: 8,
    waves: [
      { kind: 'zapper', count: 2, at: 2 },
      { kind: 'sawdrone', count: 3, at: 12, trickle: 1.8 },
      { kind: 'zapper', count: 2, at: 34 },
      { kind: 'buzzbot', count: 4, at: 46, trickle: 1 },
    ],
    hazards: { fans: 3, vents: 4, boostPads: 4 },
    par: 70,
    decor: 1.2,
    hearts: 1,
    music: 'area2',
  },
  {
    index: 4,
    area: 'stormworks',
    areaName: 'Stormworks',
    title: 'Live Wires',
    hint: 'Dash past the moving walls.',
    radius: 28,
    sparkies: 6,
    cells: 4,
    boltRoutes: 9,
    crates: 8,
    waves: [
      { kind: 'sawdrone', count: 3, at: 2, trickle: 1.4 },
      { kind: 'bomblet', count: 3, at: 16, trickle: 2.4 },
      { kind: 'zapper', count: 2, at: 32 },
      { kind: 'bomblet', count: 3, at: 50, trickle: 2.0 },
    ],
    hazards: { barriers: 3, vents: 3, fans: 3, boostPads: 4 },
    par: 75,
    decor: 1.1,
    hearts: 1,
    music: 'area3',
  },
  {
    index: 5,
    area: 'stormworks',
    areaName: 'Stormworks',
    title: 'Storm Core',
    hint: 'Dash to break shields!',
    radius: 30,
    sparkies: 7,
    cells: 4,
    boltRoutes: 10,
    crates: 10,
    waves: [
      { kind: 'shieldbot', count: 2, at: 3, trickle: 2.4 },
      { kind: 'sawdrone', count: 3, at: 15, trickle: 1.6 },
      { kind: 'bomblet', count: 3, at: 30, trickle: 2.0 },
      { kind: 'shieldbot', count: 2, at: 46, trickle: 2.4 },
      { kind: 'zapper', count: 2, at: 58 },
    ],
    hazards: { barriers: 3, vents: 4, fans: 3, boostPads: 5 },
    par: 80,
    decor: 1.15,
    hearts: 2,
    music: 'area3',
  },
];

export const BOSS_STAGE: StageDef = {
  index: 6,
  area: 'finale',
  areaName: 'The Great Scrapbot',
  title: 'Finale',
  hint: 'Dash the glowing core!',
  radius: 25,
  sparkies: 0,
  cells: 0,
  boltRoutes: 3,
  crates: 0,
  waves: [],
  hazards: { boostPads: 4 },
  par: 150,
  decor: 0.9,
  music: 'boss',
};

export const ALL_STAGES: StageDef[] = [...STAGES, BOSS_STAGE];

/** Area transitions get a full-screen title card; stage-to-stage doesn't. */
export function isAreaStart(index: number): boolean {
  if (index === 0) return true;
  const prev = ALL_STAGES[index - 1];
  const cur = ALL_STAGES[index];
  return !!prev && !!cur && prev.area !== cur.area;
}
