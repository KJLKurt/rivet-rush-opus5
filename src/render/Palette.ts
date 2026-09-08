/**
 * Rivet Rush — original visual identity.
 *
 * One palette drives characters, props, VFX and UI so every area reads as the
 * same world at a different time of day. Hues are chosen so nothing important
 * is separated by red-vs-green alone: friendly things are warm gold + cyan,
 * hostile things are violet/magenta with a hard white core, and hazards always
 * carry a black/amber chevron texture in addition to their colour.
 */

export const PAL = {
  // --- Rivet ---------------------------------------------------------------
  furDark: 0x5d6a90,
  furMid: 0x9aa6c9,
  furLight: 0xdbe3f5,
  maskDark: 0x33395a,
  muzzle: 0xf3ead9,
  nose: 0x35304a,
  goggleRim: 0xffb03a,
  goggleGlass: 0x6de3ff,
  scarf: 0xff8a52,
  scarfDark: 0xd94f2c,
  belly: 0xe6ecfa,

  // --- Hoverboard ----------------------------------------------------------
  boardTop: 0xffb03a,
  boardEdge: 0xff7a2f,
  boardUnder: 0x2c3350,
  boardGlow: 0x53f2ff,

  // --- Friendly tech -------------------------------------------------------
  sparkieBody: 0xfff3c4,
  sparkieShell: 0x63e8ff,
  sparkieGlow: 0x9dfcff,

  // --- Hostile tech --------------------------------------------------------
  droneShell: 0x8e5cff,
  droneShellDark: 0x53308f,
  droneTrim: 0xff5ec4,
  droneEye: 0xfff2fb,
  droneEyeAngry: 0xff3d7f,

  // --- Boss ----------------------------------------------------------------
  bossPlate: 0x9aa4c8,
  bossPlateDark: 0x565f85,
  bossAccent: 0xff8a3d,
  bossCore: 0x7ef7ff,
  bossCoreAngry: 0xff5ec4,

  // --- Collectibles --------------------------------------------------------
  bolt: 0xffd447,
  boltHot: 0xfff3b0,
  cell: 0x53f2ff,
  cellHot: 0xd7fdff,
  heart: 0xff6f91,

  // --- Environment ---------------------------------------------------------
  metalLight: 0xd6ddf2,
  metalMid: 0x98a2c4,
  metalDark: 0x525b84,
  rockLight: 0xb9a58f,
  rockDark: 0x6f5f52,
  woodLight: 0xd9a25f,
  woodDark: 0x9c6634,
  leafLight: 0x7ee081,
  leafMid: 0x46b566,
  leafDark: 0x2b7a4b,
  petal: 0xffa8d8,
  hazard: 0xff9a2b,
  hazardDark: 0x2a2233,

  // --- Energy / FX ---------------------------------------------------------
  energy: 0x53f2ff,
  energyWarm: 0xffd447,
  overdrive: 0xffc93c,
  overdriveHot: 0xfff6d6,
  shield: 0x8ad7ff,
  danger: 0xff4d6d,
  white: 0xffffff,
} as const;

export type AreaTheme = {
  /** Sky gradient, top -> horizon -> ground haze. */
  skyTop: number;
  skyMid: number;
  skyLow: number;
  /** Below the horizon — the haze the player looks down into. */
  skyBelow: number;
  sunColor: number;
  sunIntensity: number;
  /** Direction the key light comes from (normalised in code). */
  sunDir: [number, number, number];
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  cloudColor: number;
  cloudShadow: number;
  /** Extra rim/fill light that makes silhouettes pop against the sky. */
  rimColor: number;
  rimIntensity: number;
  bloomStrength: number;
};

export const THEMES: Record<string, AreaTheme> = {
  // AREA 1 — Sunbeam Scrapyard: bright late-morning gold.
  scrapyard: {
    skyBelow: 0x5f93cf,
    skyTop: 0x2f7fe0,
    skyMid: 0x8fd0ff,
    skyLow: 0xffe6b8,
    sunColor: 0xffedc4,
    sunIntensity: 2.25,
    sunDir: [0.55, 0.86, 0.45],
    // The hemisphere fill leans warm here so the metal picks up the golden
    // hour rather than reading as cold grey under a blue sky.
    ambientSky: 0xa8cdf0,
    ambientGround: 0xffc98a,
    ambientIntensity: 0.95,
    fogColor: 0x9fcdf2,
    fogNear: 70,
    fogFar: 190,
    cloudColor: 0xffffff,
    cloudShadow: 0xc9dcf5,
    rimColor: 0x9fd8ff,
    rimIntensity: 0.75,
    bloomStrength: 0.45,
  },
  // AREA 2 — Cloudtop Gardens: soft afternoon green + pink.
  gardens: {
    skyBelow: 0x8fc7dd,
    skyTop: 0x3aa0d8,
    skyMid: 0xa9e7f2,
    skyLow: 0xffd9ef,
    sunColor: 0xfff6e2,
    sunIntensity: 2.2,
    sunDir: [-0.5, 1.0, 0.6],
    ambientSky: 0xd0f0ff,
    ambientGround: 0xbdf0c2,
    ambientIntensity: 1.25,
    fogColor: 0xc6ecf8,
    fogNear: 58,
    fogFar: 180,
    cloudColor: 0xfff4fb,
    cloudShadow: 0xd6e4f2,
    rimColor: 0xbdf0c2,
    rimIntensity: 0.8,
    bloomStrength: 0.42,
  },
  // AREA 3 — Stormworks: dramatic violet thunderhead.
  stormworks: {
    skyBelow: 0x2b2758,
    skyTop: 0x151a45,
    skyMid: 0x453a86,
    skyLow: 0x8b5fb0,
    sunColor: 0xc9d8ff,
    sunIntensity: 1.65,
    sunDir: [0.35, 1.0, -0.55],
    ambientSky: 0x5a63b8,
    ambientGround: 0x2a2450,
    ambientIntensity: 1.0,
    fogColor: 0x3b3470,
    fogNear: 48,
    fogFar: 160,
    cloudColor: 0x6f6ab8,
    cloudShadow: 0x2a2450,
    rimColor: 0x8ad7ff,
    rimIntensity: 1.5,
    bloomStrength: 0.7,
  },
  // FINALE — The Great Scrapbot: sunset arena above the storm.
  finale: {
    skyBelow: 0x7a5a9c,
    skyTop: 0x23285e,
    skyMid: 0x8a5a9e,
    skyLow: 0xffb56b,
    sunColor: 0xffd2a0,
    sunIntensity: 2.05,
    sunDir: [-0.65, 0.85, -0.4],
    ambientSky: 0x8f7fd0,
    ambientGround: 0xffb98a,
    ambientIntensity: 1.15,
    fogColor: 0x6f5a9a,
    fogNear: 56,
    fogFar: 200,
    cloudColor: 0xffc7a3,
    cloudShadow: 0x5b4a86,
    rimColor: 0xffb56b,
    rimIntensity: 1.25,
    bloomStrength: 0.62,
  },
};

/** Cosmetic trail colours unlocked through play. */
export const TRAIL_COLORS: Record<string, { a: number; b: number }> = {
  cyan: { a: 0x53f2ff, b: 0x2b7de0 },
  sunburst: { a: 0xffd447, b: 0xff7a2f },
  bubblegum: { a: 0xff9ad5, b: 0x9a5cff },
  mint: { a: 0x9dffd0, b: 0x2fb98a },
  storm: { a: 0xc7b3ff, b: 0x4a2fb9 },
  rainbow: { a: 0xff5ec4, b: 0x53f2ff },
};
