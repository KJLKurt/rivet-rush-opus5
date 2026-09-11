/**
 * Every gameplay number lives here.
 *
 * Having one file to tune is what made it possible to iterate on feel: the
 * values below are the result of repeated play-and-adjust passes, and the
 * comments record *why* a number is what it is so it doesn't get "cleaned up"
 * back into something that feels worse.
 */

export const CFG = {
  player: {
    /** Top speed. Fast enough to feel zippy, slow enough to react at this camera height. */
    maxSpeed: 12.6,
    /** Reaching top speed in ~0.28s is the difference between "responsive" and "floaty". */
    accel: 62,
    /** Deceleration when the stick is released — snappy, but with a little glide. */
    brake: 34,
    /** Extra turning force when steering against current velocity: kills drift-y feel. */
    turnAssist: 46,
    /** Radians/sec the model is allowed to rotate. High = instant direction changes. */
    turnRate: 13,
    hoverHeight: 0.42,
    radius: 0.62,
  },

  dash: {
    charges: 2,
    /** Seconds to refill one charge. */
    rechargeTime: 1.45,
    speed: 30,
    /** Short — a dash should be a punch, not a flight. */
    duration: 0.19,
    /** Post-dash speed carry, as a fraction of dash speed. Sells the momentum. */
    exitBoost: 0.52,
    /** Anticipation freeze before the burst. Tiny, but it's what makes it feel meaty. */
    windup: 0.045,
    /** Shockwave that stuns drones and smashes crates. */
    shockRadius: 3.1,
    /** Damage dealt by dashing through an enemy. */
    contactDamage: 2,
    /** Invulnerability window; generous so dashing out of danger always works. */
    iframes: 0.34,
    hitstop: 0.055,
  },

  zap: {
    /** Auto-attack. The player never aims. */
    range: 7.2,
    interval: 0.5,
    damage: 1,
    chains: 0,
    chainRange: 4.6,
    /** Arc travel time, purely cosmetic. */
    travel: 0.07,
  },

  magnet: {
    radius: 2.9,
    /** Pull acceleration; high enough that pickups snap satisfyingly. */
    strength: 46,
    maxSpeed: 26,
  },

  combo: {
    /** Seconds before the combo decays. Long enough to cross an arena at speed. */
    window: 2.6,
    /** Multiplier tiers — index = tier, value = score multiplier. */
    tiers: [1, 1.25, 1.5, 2, 2.5, 3, 4, 5],
    /** Pickups needed to reach each tier. */
    thresholds: [0, 4, 9, 16, 25, 36, 50, 70],
  },

  score: {
    bolt: 25,
    cell: 250,
    sparkie: 400,
    enemy: 150,
    crate: 40,
    /** Awarded per second of remaining "par time" when a stage is cleared. */
    timeBonusPerSecond: 30,
    stageClear: 500,
    noHitStage: 750,
    bossDefeat: 5000,
    /** Points for finishing a run without taking damage. */
    flawlessRun: 8000,
  },

  overdrive: {
    /** Meter units required. Gains below are tuned so a good stage yields ~1.3 fills. */
    max: 100,
    gainPerBolt: 1.5,
    gainPerCell: 8,
    gainPerSparkie: 10,
    gainPerEnemy: 6,
    /** Combo tier multiplies gains — rewarding good play with more Overdrive. */
    comboGainScale: 0.16,
    duration: 8,
    speedScale: 1.32,
    magnetScale: 3.1,
    zapIntervalScale: 0.45,
    zapDamageBonus: 1,
    scoreScale: 2,
    /** Dash charges are free while it's active. */
    freeDash: true,
  },

  health: {
    maxHearts: 3,
    /** Seconds of invulnerability after a hit. */
    invuln: 1.5,
    hitstop: 0.09,
  },

  arena: {
    /** Play radius. The magnetic fence pushes the player back inside. */
    radius: 27,
    fencePush: 34,
    fenceSoft: 1.6,
  },

  enemies: {
    buzzbot: { hp: 2, speed: 3.4, damage: 1, score: 120, radius: 0.55, hover: 1.15 },
    sawdrone: { hp: 3, speed: 4.2, chargeSpeed: 15.5, damage: 1, score: 200, radius: 0.6, hover: 0.95 },
    zapper: { hp: 4, speed: 0, damage: 1, score: 240, radius: 0.7, hover: 1.0, beamRange: 12 },
    bomblet: { hp: 2, speed: 5.6, damage: 1, score: 220, radius: 0.5, hover: 0.85, blastRadius: 3.4 },
    shieldbot: { hp: 4, speed: 3.0, damage: 1, score: 320, radius: 0.68, hover: 1.1 },
  },

  boss: {
    maxHp: 120,
    phase2At: 0.66,
    phase3At: 0.33,
    /** Seconds the core stays open after a successful stagger. */
    staggerTime: 5.4,
    coreDamagePerDash: 7.5,
    coreDamagePerZap: 1.1,
    arenaRadius: 24,
  },

  /** Time in seconds a competent player is expected to need per stage. */
  parTimes: [55, 60, 65, 70, 75, 80],

  hitstop: {
    /** Global cap so hitstop can never feel like lag. */
    max: 0.14,
  },
} as const;

export type Config = typeof CFG;
