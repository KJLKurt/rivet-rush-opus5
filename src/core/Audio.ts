/**
 * RIVET RUSH: SKY SALVAGE — procedural audio engine.
 * =================================================================================
 * 100% original, 100% synthesized. There are no audio files, no network fetches and
 * no third-party libraries in this module: every sound effect, every drum, every
 * note of every music track is generated at runtime from Web Audio primitives.
 *
 * ---------------------------------------------------------------------------------
 * SYNTHESIS ARCHITECTURE
 * ---------------------------------------------------------------------------------
 * Bus graph (built once, lazily, inside unlock()):
 *
 *   [sfx one-shot voices] -> voice.out -> voice.pan? -> sfxGain ----\
 *                                       \-> sfxSend -> sfxFx -------+-> masterGain
 *   [music players]       -> lane gains -> player.gain -> musicGain -+     |
 *                                       \-> musicSend -> musicFx ---/      v
 *                                                       musicMuffle -> limiter -> destination
 *
 *   * musicMuffle is a lowpass on the music bus only (22.05k -> 420Hz) so the pause
 *     and upgrade screens duck the score without dulling the UI clicks.
 *   * sfxFx / musicFx are cheap "space" units: two short feedback delays through a
 *     lowpass, panned apart. They give bells and shimmer a tail without the CPU cost
 *     of a ConvolverNode on a phone.
 *   * limiter is a gentle DynamicsCompressorNode so a boss slam landing on top of a
 *     ten-bolt combo can never clip.
 *
 * Sound design is built from a handful of reusable primitives — blip, sweep,
 * noiseBurst, fmHit, chordStab, metalClank, subThump, zip — which are then *composed*
 * into each effect. e.g. `dash` = descending filtered noise whoosh + sub thump +
 * upward electric zip + transient click, all inside one voice.
 *
 * Noise is pre-rendered ONCE into two AudioBuffers (white + pink) during unlock and
 * replayed from random offsets, so no per-shot buffer allocation ever happens.
 *
 * ---------------------------------------------------------------------------------
 * VOICE MODEL
 * ---------------------------------------------------------------------------------
 * Every play() call allocates exactly one "voice": a GainNode (+ optional
 * StereoPannerNode for positional audio). All oscillators/noise sources of that
 * effect run through it. Voices are capped at MAX_VOICES (24); on overflow the voice
 * that ends soonest is stolen and faded out in 8ms. Each source counts itself in the
 * voice's pending counter and disconnects itself in onended; when the counter hits
 * zero the voice tears its own nodes down, so a 10-minute run leaks nothing.
 *
 * A 25ms per-name de-duplication window stops "machine-gun" distortion when ten
 * bolts are hoovered up on the same frame.
 *
 * Positional audio is deliberately cheap: StereoPannerNode driven by the clamped
 * x-delta from the listener plus a 1/(1+d*k) distance gain. No PannerNode, no HRTF.
 *
 * ---------------------------------------------------------------------------------
 * MUSIC MODEL
 * ---------------------------------------------------------------------------------
 * Six tracks are composed as real note data below (chords, bass, melody, drum grids).
 * A lookahead scheduler (25ms setInterval, 120ms horizon) converts 16th-note steps
 * into scheduled node graphs against ctx.currentTime, so timing never drifts and the
 * scheduler pauses cleanly on suspend().
 *
 * Up to two "players" run at once, which is how crossfades work: asking for a new
 * track while one is playing schedules the new player to *start on the next bar line*
 * of the old one, then equal-power-ish linear crossfades between them.
 *
 * Each player owns 8 lane gains (bass, chords, pad, drums, hats, lead, lead-octave,
 * arp). setMusicIntensity() slides those lanes in as the player performs, and
 * setOverdrive() unmutes the octave-doubled lead, opens the lead filter, pushes the
 * shimmer send and nudges the tempo up 3%.
 *
 * All area tracks share one key family (C major / C lydian / D dorian — the same
 * seven notes) and quote the same four-note motif (G–A–C–D), so the soundtrack reads
 * as one score rather than six unrelated loops.
 * =================================================================================
 */

// ---------------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------------

export type SfxName =
  | 'uiMove' | 'uiConfirm' | 'uiBack' | 'uiUnlock' | 'uiToggle'
  | 'bolt' | 'cell' | 'sparkieRescue' | 'sparkieChirp' | 'heart' | 'crateSmash'
  | 'dash' | 'dashFail' | 'dashRecharge' | 'boostPad'
  | 'zap' | 'zapChain' | 'enemyHit' | 'enemyDefeat' | 'enemyAttack' | 'enemyTelegraph'
  | 'playerHurt' | 'shieldGain' | 'shieldBreak'
  | 'comboUp' | 'comboBreak' | 'overdriveReady' | 'overdriveStart' | 'overdriveEnd'
  | 'upgradeShow' | 'upgradePick' | 'portalOpen' | 'portalEnter'
  | 'bossIntro' | 'bossSlam' | 'bossHurt' | 'bossPhase' | 'bossDefeat'
  | 'victory' | 'gameOver' | 'countdown' | 'countdownGo' | 'tallyTick' | 'tallyDone' | 'star';

export type MusicTrack = 'menu' | 'area1' | 'area2' | 'area3' | 'boss' | 'victory';

export interface SfxOptions {
  /** World position for cheap stereo panning + distance rolloff. */
  pos?: { x: number; y: number; z: number };
  /** Playback-rate style pitch multiplier, e.g. 1.06 ** comboStep. */
  pitch?: number;
  /** Linear gain multiplier, default 1. */
  gain?: number;
}

// ---------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------

/** Hard cap on simultaneous one-shot voices. */
const MAX_VOICES = 24;
/** Same-name retrigger window; below this the second hit is dropped. */
const DEDUPE_MS = 25;
/** Scheduler tick period (ms) and how far ahead it schedules (s). */
const SCHED_TICK_MS = 25;
const SCHED_HORIZON = 0.12;
/** Default music crossfade. */
const DEFAULT_FADE = 1.2;
/** Panning: world units at which the stereo image is fully hard-panned. */
const PAN_WIDTH = 13;
const PAN_MAX = 0.85;
/** Distance rolloff constant for 1/(1+d*k). */
const DIST_K = 0.055;

// ---------------------------------------------------------------------------------
// Math / music helpers — module scope, allocation free
// ---------------------------------------------------------------------------------

/** MIDI note -> Hz, precomputed so note scheduling never calls Math.pow. */
const MIDI_HZ: Float32Array = (() => {
  const t = new Float32Array(128);
  for (let i = 0; i < 128; i++) t[i] = 440 * Math.pow(2, (i - 69) / 12);
  return t;
})();

function hz(midi: number): number {
  if (midi >= 0 && midi < 128 && Number.isInteger(midi)) return MIDI_HZ[midi];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite smoothstep, used for intensity layer fades. */
function smooth(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** +/-3% "human" detune so repeated effects never sound machine-stamped. */
function wobble(amount = 0.03): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------------------
// MUSIC DATA
// ---------------------------------------------------------------------------------
// Everything is expressed on a 16th-note grid. A "step" is one 16th; a bar is 16
// steps. Lanes may loop shorter than the track (e.g. a 4-bar chord cycle under a
// 16-bar melody) via their own loop length.
//
//   Note      = [step, midiNote, lengthInSteps, velocity?]
//   ChordEvt  = [step, [midi, midi, ...]]
//   Drum grid = one 16-char string per bar, cycled by bar index:
//                 '.' rest   'x' hit   'X' accent   'g' ghost/soft   'o' open hat
// ---------------------------------------------------------------------------------

type Note = readonly [step: number, midi: number, len: number, vel?: number];
type ChordEvt = readonly [step: number, notes: readonly number[]];

type StabVoice = 'pluck' | 'brass' | 'bell';
type LeadVoice = 'lead' | 'pluck' | 'bell';

interface TrackDef {
  readonly bpm: number;
  /** Loop length in bars. */
  readonly bars: number;
  /** 0..0.35 — delay applied to odd 16ths for a swung feel. */
  readonly swing: number;
  /** Minimum effective intensity: menu/victory always play their full arrangement. */
  readonly floor: number;

  readonly chords: readonly ChordEvt[];
  readonly chordLoop: number;
  /** Per-bar rhythm grid deciding when the current chord is struck. */
  readonly chordRhythm: readonly string[];
  readonly stabVoice: StabVoice;
  readonly stabLevel: number;
  /** 0 = no sustained pad under the chords. */
  readonly padLevel: number;

  readonly bass: readonly Note[];
  readonly bassLoop: number;
  readonly bassLevel: number;
  /** Lowpass cutoff for the bass voice (Hz). */
  readonly bassCut: number;

  readonly melody: readonly Note[];
  readonly melodyLoop: number;
  readonly leadVoice: LeadVoice;
  readonly leadCut: number;
  readonly leadLevel: number;

  /** Counter-arpeggio (intensity > 0.8): chord-tone indices, rate in steps. */
  readonly arpShape: readonly number[];
  readonly arpRate: number;
  readonly arpOct: number;
  readonly arpVoice: 'bell' | 'pluck';

  readonly kick: readonly string[];
  readonly snare: readonly string[];
  readonly hat: readonly string[];
  readonly perc: readonly string[];
  readonly drumLevel: number;
  /** Kick starting pitch (Hz) — bigger for boss timpani-ish thump. */
  readonly kickTune: number;
}

// =================================================================================
// MENU — "Workshop Morning".  100 BPM, C major, 8 bars.
// Musical intent: hopeful and unhurried. A slow-attack pad holds maj9 colours while
// an FM bell sings the game's motif (G-A-C-D) up top. Only a shaker and a soft heart-
// beat kick move underneath, so the menu never nags.
// =================================================================================
const MENU_CHORDS: readonly ChordEvt[] = [
  [0, [48, 55, 64, 67, 71]],   // Cmaj9   (C3 G3 E4 G4 B4)
  [16, [45, 52, 64, 67, 72]],  // Am9     (A2 E3 E4 G4 C5)
  [32, [41, 48, 60, 65, 69]],  // Fmaj7   (F2 C3 C4 F4 A4)
  [48, [43, 50, 62, 67, 71]],  // G6      (G2 D3 D4 G4 B4)
  [64, [45, 52, 64, 69, 72]],  // Am
  [80, [41, 48, 60, 65, 69]],  // F
  [96, [48, 55, 64, 67, 71]],  // C
  [112, [43, 50, 62, 65, 69]], // G7sus4 -> loops home
];

const MENU_BASS: readonly Note[] = [
  [0, 36, 8, 0.8], [8, 36, 6, 0.5],
  [16, 45, 8, 0.8], [24, 45, 6, 0.5],
  [32, 41, 8, 0.8], [40, 41, 6, 0.5],
  [48, 43, 8, 0.8], [56, 43, 6, 0.5],
  [64, 45, 8, 0.8], [72, 45, 6, 0.5],
  [80, 41, 8, 0.8], [88, 41, 6, 0.5],
  [96, 36, 8, 0.8], [104, 36, 6, 0.5],
  [112, 43, 8, 0.8], [120, 43, 6, 0.5],
];

const MENU_MELODY: readonly Note[] = [
  // bar 0-1 — the motif, stated plainly: G A C ... B A G
  [4, 79, 4], [8, 81, 4], [12, 84, 6],
  [18, 83, 2], [20, 81, 4], [24, 79, 8],
  // bar 2-3 — answering phrase over F / G
  [36, 77, 4], [40, 79, 4], [44, 81, 6],
  [50, 79, 2], [52, 76, 4], [56, 74, 8],
  // bar 4-5 — lifts to the octave over Am / F
  [64, 72, 4], [68, 76, 4], [72, 81, 8],
  [82, 79, 2], [84, 77, 4], [88, 76, 8],
  // bar 6-7 — settles home, leaves the door open on D-B
  [96, 74, 4], [100, 76, 4], [104, 72, 10],
  [116, 74, 4], [120, 71, 8],
];

// =================================================================================
// AREA 1 — "Sunbeam Scrapyard".  124 BPM, C major, 16 bars.
// Musical intent: bouncy major-key adventure. Off-beat pluck stabs (a light ska
// skank), a walking 8th-note bass and a singable pentatonic tune. A-section states
// the motif, B-section answers it an octave up with busier rhythm.
// =================================================================================
const A1_CHORDS: readonly ChordEvt[] = [
  [0, [60, 64, 67, 72]],  // C add9-ish
  [16, [57, 60, 64, 69]], // Am
  [32, [53, 57, 60, 65]], // F
  [48, [55, 59, 62, 67]], // G
];
const A1_RHYTHM: readonly string[] = [
  '..x.x...x.x...x.',
  '..x.x...x.x.x.x.',
];
const A1_BASS: readonly Note[] = [
  // walking: root - root - 5th - root - 3rd - root - 5th - passing tone
  [0, 36, 2], [2, 36, 2], [4, 43, 2], [6, 36, 2], [8, 40, 2], [10, 36, 2], [12, 43, 2], [14, 45, 2],
  [16, 45, 2], [18, 45, 2], [20, 40, 2], [22, 45, 2], [24, 48, 2], [26, 45, 2], [28, 40, 2], [30, 43, 2],
  [32, 41, 2], [34, 41, 2], [36, 48, 2], [38, 41, 2], [40, 45, 2], [42, 41, 2], [44, 48, 2], [46, 50, 2],
  [48, 43, 2], [50, 43, 2], [52, 50, 2], [54, 43, 2], [56, 47, 2], [58, 43, 2], [60, 50, 2], [62, 47, 2],
];
const A1_MELODY: readonly Note[] = [
  // --- A section (bars 0-7): the motif and its answer -------------------------
  [0, 79, 2], [2, 81, 2], [4, 84, 4], [8, 81, 2], [10, 79, 2], [12, 76, 4],
  [16, 74, 4], [20, 76, 2], [22, 79, 2], [24, 81, 8],
  [32, 77, 2], [34, 79, 2], [36, 81, 4], [40, 79, 2], [42, 77, 2], [44, 74, 4],
  [48, 71, 2], [50, 74, 2], [52, 79, 4], [56, 74, 8],
  [64, 84, 2], [66, 81, 2], [68, 79, 4], [72, 76, 2], [74, 79, 2], [76, 81, 4],
  [80, 84, 4], [84, 86, 2], [86, 84, 2], [88, 81, 8],
  [96, 77, 2], [98, 81, 2], [100, 84, 4], [104, 81, 2], [106, 77, 2], [108, 79, 4],
  [112, 79, 2], [114, 76, 2], [116, 74, 4], [120, 72, 8],
  // --- B section (bars 8-15): same harmony, brighter and busier ---------------
  [128, 72, 2], [130, 76, 2], [132, 79, 2], [134, 84, 2], [136, 79, 4], [140, 76, 4],
  [144, 81, 2], [146, 79, 2], [148, 76, 2], [150, 72, 2], [152, 76, 8],
  [160, 77, 2], [162, 81, 2], [164, 84, 2], [166, 89, 2], [168, 84, 4], [172, 81, 4],
  [176, 79, 2], [178, 83, 2], [180, 86, 2], [182, 83, 2], [184, 79, 8],
  [192, 84, 2], [194, 86, 2], [196, 88, 4], [200, 86, 2], [202, 84, 2], [204, 81, 4],
  [208, 81, 4], [212, 84, 2], [214, 81, 2], [216, 76, 8],
  [224, 77, 2], [226, 79, 2], [228, 81, 4], [232, 84, 2], [234, 86, 2], [236, 84, 4],
  [240, 83, 2], [242, 86, 2], [244, 79, 4], [248, 74, 4], [252, 71, 4],
];

// =================================================================================
// AREA 2 — "Cloudtop Gardens".  128 BPM, C LYDIAN (raised 4th = F#), 16 bars.
// Musical intent: the same world one island higher. Identical key signature family,
// but the D-major-over-C voicing floats the lydian #4 and the hats swing, so it
// breathes. Longer note values, bells doubling the lead, softer drums.
// =================================================================================
const A2_CHORDS: readonly ChordEvt[] = [
  [0, [60, 64, 67, 71, 74]],  // Cmaj9
  [16, [60, 62, 66, 69, 74]], // D/C  <- the lydian colour
  [32, [52, 55, 59, 62, 67]], // Em7
  [48, [55, 59, 62, 67, 69]], // G6
];
const A2_RHYTHM: readonly string[] = [
  'x.....x...x.....',
  'x.....x...x...x.',
];
const A2_BASS: readonly Note[] = [
  [0, 36, 4], [6, 36, 2], [8, 43, 4], [12, 40, 2], [14, 43, 2],
  [16, 36, 4], [22, 38, 2], [24, 45, 4], [28, 42, 2], [30, 38, 2],
  [32, 40, 4], [38, 40, 2], [40, 47, 4], [44, 43, 2], [46, 40, 2],
  [48, 43, 4], [54, 43, 2], [56, 50, 4], [60, 47, 2], [62, 43, 2],
];
const A2_MELODY: readonly Note[] = [
  // --- A section: long, gliding phrases --------------------------------------
  [0, 76, 4], [4, 79, 4], [8, 83, 6], [14, 81, 2],
  [16, 79, 8], [24, 78, 4], [28, 76, 4],
  [32, 74, 4], [36, 78, 4], [40, 81, 6], [46, 83, 2],
  [48, 86, 8], [56, 83, 4], [60, 79, 4],
  [64, 83, 4], [68, 86, 4], [72, 88, 6], [78, 86, 2],
  [80, 83, 8], [88, 81, 4], [92, 79, 4],
  [96, 78, 4], [100, 81, 4], [104, 83, 6], [110, 86, 2],
  [112, 88, 4], [116, 86, 4], [120, 83, 8],
  // --- B section: the Area 1 motif returns, floated over lydian harmony -------
  [128, 79, 2], [130, 81, 2], [132, 84, 4], [136, 86, 4], [140, 83, 4],
  [144, 81, 4], [148, 79, 4], [152, 78, 8],
  [160, 76, 2], [162, 78, 2], [164, 81, 4], [168, 83, 4], [172, 86, 4],
  [176, 88, 8], [184, 86, 4], [188, 83, 4],
  [192, 84, 2], [194, 86, 2], [196, 88, 4], [200, 91, 4], [204, 88, 4],
  [208, 86, 4], [212, 83, 4], [216, 81, 8],
  [224, 79, 2], [226, 83, 2], [228, 86, 4], [232, 88, 4], [236, 86, 4],
  [240, 83, 4], [244, 79, 4], [248, 76, 8],
];

// =================================================================================
// AREA 3 — "Stormworks".  136 BPM, D DORIAN (same seven notes as C major — the key
// family never breaks), 16 bars.
// Musical intent: urgent, not scary. A syncopated 16th bass riff drives it, drums
// tighten to straight 16th hats, and the lead answers itself in short bursts. The
// B-section is a call-and-response version of the same shape.
// =================================================================================
const A3_CHORDS: readonly ChordEvt[] = [
  [0, [50, 53, 57, 62]],  // Dm
  [16, [48, 52, 55, 60]], // C
  [32, [53, 57, 60, 65]], // F
  [48, [55, 59, 62, 67]], // G
];
const A3_RHYTHM: readonly string[] = [
  'x..x..x...x..x..',
  'x..x..x...x.x.x.',
];
const A3_BASS: readonly Note[] = [
  [0, 38, 2], [3, 38, 1], [4, 38, 2], [7, 50, 1], [8, 38, 2], [11, 41, 1], [12, 45, 2], [14, 38, 2],
  [16, 36, 2], [19, 36, 1], [20, 36, 2], [23, 48, 1], [24, 36, 2], [27, 40, 1], [28, 43, 2], [30, 36, 2],
  [32, 41, 2], [35, 41, 1], [36, 41, 2], [39, 53, 1], [40, 41, 2], [43, 45, 1], [44, 48, 2], [46, 41, 2],
  [48, 43, 2], [51, 43, 1], [52, 43, 2], [55, 55, 1], [56, 43, 2], [59, 47, 1], [60, 50, 2], [62, 43, 2],
];
const A3_MELODY: readonly Note[] = [
  // --- A section -------------------------------------------------------------
  [0, 74, 2], [2, 77, 2], [4, 81, 4], [8, 79, 2], [10, 77, 2], [12, 74, 4],
  [16, 72, 2], [18, 74, 2], [20, 77, 6], [26, 76, 2], [28, 74, 4],
  [32, 77, 2], [34, 81, 2], [36, 84, 4], [40, 81, 2], [42, 77, 2], [44, 79, 4],
  [48, 79, 2], [50, 83, 2], [52, 81, 4], [56, 74, 8],
  [64, 81, 2], [66, 84, 2], [68, 86, 4], [72, 84, 2], [74, 81, 2], [76, 79, 4],
  [80, 77, 2], [82, 79, 2], [84, 81, 6], [90, 79, 2], [92, 77, 4],
  [96, 84, 2], [98, 86, 2], [100, 89, 4], [104, 86, 2], [106, 84, 2], [108, 81, 4],
  [112, 83, 2], [114, 81, 2], [116, 79, 4], [120, 74, 8],
  // --- B section: call (busy) / response (held) ------------------------------
  [128, 74, 1], [129, 74, 1], [130, 77, 2], [132, 81, 2], [134, 84, 2], [136, 81, 4], [140, 77, 4],
  [144, 79, 2], [146, 77, 2], [148, 74, 8],
  [160, 72, 1], [161, 72, 1], [162, 76, 2], [164, 79, 2], [166, 84, 2], [168, 79, 4], [172, 76, 4],
  [176, 77, 2], [178, 74, 2], [180, 72, 8],
  [192, 77, 2], [194, 81, 2], [196, 84, 4], [200, 86, 2], [202, 84, 2], [204, 81, 4],
  [208, 84, 2], [210, 86, 2], [212, 89, 6], [218, 86, 2], [220, 84, 4],
  [224, 83, 2], [226, 81, 2], [228, 79, 4], [232, 77, 2], [234, 79, 2], [236, 81, 4],
  [240, 86, 4], [244, 84, 4], [248, 81, 4], [252, 74, 4],
];

// =================================================================================
// BOSS — "The Great Scrapbot".  142 BPM, C minor with a harmonic-minor V, 16 bars.
// Musical intent: big and heroic cartoon-brass, never frightening. Syncopated octave
// bass riff, brass stabs on the off-beats, a call-and-response hook. Bars 8-11 drop
// to a half-time held-brass bridge so the return of the hook lands hard.
// =================================================================================
const BOSS_CHORDS: readonly ChordEvt[] = [
  [0, [48, 51, 55, 60]],  // Cm
  [16, [44, 48, 51, 56]], // Ab
  [32, [51, 55, 58, 63]], // Eb
  [48, [43, 47, 50, 55]], // G  (B natural — harmonic minor lift)
];
const BOSS_RHYTHM: readonly string[] = [
  '..x..x..x.x..x..',
  '..x..x..x.x.x.xx',
];
const BOSS_BASS: readonly Note[] = [
  [0, 36, 2], [3, 36, 1], [4, 36, 1], [6, 43, 2], [8, 36, 2], [10, 39, 1], [11, 41, 1], [12, 36, 2], [14, 48, 2],
  [16, 32, 2], [19, 32, 1], [20, 32, 1], [22, 39, 2], [24, 32, 2], [26, 35, 1], [27, 36, 1], [28, 32, 2], [30, 44, 2],
  [32, 39, 2], [35, 39, 1], [36, 39, 1], [38, 46, 2], [40, 39, 2], [42, 42, 1], [43, 44, 1], [44, 39, 2], [46, 51, 2],
  [48, 43, 2], [51, 43, 1], [52, 43, 1], [54, 50, 2], [56, 43, 2], [58, 46, 1], [59, 47, 1], [60, 43, 2], [62, 55, 2],
];
const BOSS_MELODY: readonly Note[] = [
  // --- hook: call ------------------------------------------------------------
  [0, 72, 2], [2, 75, 2], [4, 79, 4], [8, 75, 2], [10, 72, 2], [12, 79, 4],
  // --- hook: response --------------------------------------------------------
  [16, 84, 2], [18, 82, 2], [20, 79, 6], [26, 75, 2], [28, 72, 4],
  [32, 75, 2], [34, 79, 2], [36, 82, 4], [40, 79, 2], [42, 75, 2], [44, 82, 4],
  [48, 86, 2], [50, 84, 2], [52, 79, 4], [56, 75, 8],
  [64, 84, 2], [66, 87, 2], [68, 91, 4], [72, 87, 2], [74, 84, 2], [76, 79, 4],
  [80, 82, 2], [82, 84, 2], [84, 87, 6], [90, 84, 2], [92, 79, 4],
  [96, 80, 2], [98, 84, 2], [100, 87, 4], [104, 84, 2], [106, 80, 2], [108, 75, 4],
  [112, 83, 2], [114, 86, 2], [116, 91, 4], [120, 84, 4], [124, 79, 4],
  // --- bridge (bars 8-11): held brass, half time -----------------------------
  [128, 79, 8], [136, 75, 8],
  [144, 77, 8], [152, 72, 8],
  [160, 80, 8], [168, 82, 8],
  [176, 84, 12], [188, 83, 4],
  // --- hook returns, an octave brighter --------------------------------------
  [192, 84, 2], [194, 87, 2], [196, 91, 4], [200, 87, 2], [202, 84, 2], [204, 91, 4],
  [208, 94, 2], [210, 91, 2], [212, 87, 6], [218, 84, 2], [220, 80, 4],
  [224, 87, 2], [226, 91, 2], [228, 94, 4], [232, 91, 2], [234, 87, 2], [236, 82, 4],
  [240, 83, 2], [242, 86, 2], [244, 91, 4], [248, 84, 8],
];

// =================================================================================
// VICTORY — "Sky Salvage Complete".  120 BPM, C major, 4 bars, loops gently.
// Musical intent: a short lap of honour. Brass-ish lead with bell doubling, big
// drums on the downbeats, a plagal-ish IV-V-I walk home.
// =================================================================================
const VIC_CHORDS: readonly ChordEvt[] = [
  [0, [48, 55, 64, 67, 72]],  // C
  [16, [53, 60, 65, 69, 72]], // F
  [32, [55, 62, 67, 71, 74]], // G
  [48, [48, 55, 64, 72, 79]], // C (wide)
];
const VIC_RHYTHM: readonly string[] = ['x.x.x...x.x.x...'];
const VIC_BASS: readonly Note[] = [
  [0, 36, 6], [8, 36, 6],
  [16, 41, 6], [24, 41, 6],
  [32, 43, 6], [40, 43, 6],
  [48, 36, 8], [56, 48, 8],
];
const VIC_MELODY: readonly Note[] = [
  [0, 72, 2], [2, 76, 2], [4, 79, 4], [8, 84, 8],
  [16, 81, 2], [18, 84, 2], [20, 86, 4], [24, 89, 8],
  [32, 88, 2], [34, 86, 2], [36, 83, 4], [40, 86, 8],
  [48, 84, 16],
];

// ---------------------------------------------------------------------------------
// Track table
// ---------------------------------------------------------------------------------

const TRACKS: Readonly<Record<MusicTrack, TrackDef>> = {
  menu: {
    bpm: 100, bars: 8, swing: 0.06, floor: 1,
    chords: MENU_CHORDS, chordLoop: 128, chordRhythm: ['................'],
    stabVoice: 'pluck', stabLevel: 0, padLevel: 0.5,
    bass: MENU_BASS, bassLoop: 128, bassLevel: 0.5, bassCut: 320,
    melody: MENU_MELODY, melodyLoop: 128, leadVoice: 'bell', leadCut: 5200, leadLevel: 0.42,
    arpShape: [0, 2, 3, 2], arpRate: 4, arpOct: 1, arpVoice: 'bell',
    kick: ['x.......x.......'],
    snare: ['................'],
    hat: ['..g...g...g...g.'],
    perc: ['....x.......x...'],
    drumLevel: 0.32, kickTune: 105,
  },
  area1: {
    bpm: 124, bars: 16, swing: 0.08, floor: 0,
    chords: A1_CHORDS, chordLoop: 64, chordRhythm: A1_RHYTHM,
    stabVoice: 'pluck', stabLevel: 0.5, padLevel: 0.18,
    bass: A1_BASS, bassLoop: 64, bassLevel: 0.62, bassCut: 420,
    melody: A1_MELODY, melodyLoop: 256, leadVoice: 'pluck', leadCut: 3800, leadLevel: 0.5,
    arpShape: [0, 1, 2, 3, 2, 1], arpRate: 2, arpOct: 1, arpVoice: 'bell',
    kick: ['x...x...x...x...', 'x...x...x..x....'],
    snare: ['....x.......x...', '....x.......x.g.'],
    hat: ['X.x.x.x.X.x.x.x.', 'X.x.x.x.X.x.xxx.'],
    perc: ['..x...x...x...x.'],
    drumLevel: 0.6, kickTune: 120,
  },
  area2: {
    bpm: 128, bars: 16, swing: 0.17, floor: 0,
    chords: A2_CHORDS, chordLoop: 64, chordRhythm: A2_RHYTHM,
    stabVoice: 'bell', stabLevel: 0.34, padLevel: 0.42,
    bass: A2_BASS, bassLoop: 64, bassLevel: 0.5, bassCut: 360,
    melody: A2_MELODY, melodyLoop: 256, leadVoice: 'lead', leadCut: 3200, leadLevel: 0.34,
    arpShape: [0, 2, 4, 3, 2, 1], arpRate: 2, arpOct: 1, arpVoice: 'bell',
    kick: ['x.......x.......', 'x.......x...x...'],
    snare: ['....x.......x...', '....x.....g.x...'],
    hat: ['x.g.x.g.x.g.x.o.'],
    perc: ['..x..x..x..x..x.'],
    drumLevel: 0.5, kickTune: 112,
  },
  area3: {
    bpm: 136, bars: 16, swing: 0, floor: 0,
    chords: A3_CHORDS, chordLoop: 64, chordRhythm: A3_RHYTHM,
    stabVoice: 'brass', stabLevel: 0.3, padLevel: 0.16,
    bass: A3_BASS, bassLoop: 64, bassLevel: 0.72, bassCut: 620,
    melody: A3_MELODY, melodyLoop: 256, leadVoice: 'lead', leadCut: 3000, leadLevel: 0.42,
    arpShape: [0, 1, 2, 1], arpRate: 1, arpOct: 1, arpVoice: 'pluck',
    kick: ['x..x..x...x.x...', 'x..x..x...x.x.x.'],
    snare: ['....x.......x...', '....x.....g.x..g'],
    hat: ['Xxxxxxx.Xxxxxxx.', 'Xxxxxxx.Xxxxxxxo'],
    perc: ['..x...x...x...x.'],
    drumLevel: 0.72, kickTune: 130,
  },
  boss: {
    bpm: 142, bars: 16, swing: 0, floor: 0.35,
    chords: BOSS_CHORDS, chordLoop: 64, chordRhythm: BOSS_RHYTHM,
    stabVoice: 'brass', stabLevel: 0.5, padLevel: 0.2,
    bass: BOSS_BASS, bassLoop: 64, bassLevel: 0.8, bassCut: 700,
    melody: BOSS_MELODY, melodyLoop: 256, leadVoice: 'lead', leadCut: 3400, leadLevel: 0.46,
    arpShape: [0, 1, 2, 3, 2, 1], arpRate: 1, arpOct: 1, arpVoice: 'pluck',
    kick: ['x..x..x.x..x..x.', 'x..x..x.x.x.x.x.'],
    snare: ['....x.......x..x', '....x.......x.xx'],
    hat: ['Xxxxxxxxxxxxxxxx', 'XxxxxxxxxxxxxxxO'],
    perc: ['x...x...x...x...'],
    drumLevel: 0.8, kickTune: 145,
  },
  victory: {
    bpm: 120, bars: 4, swing: 0, floor: 1,
    chords: VIC_CHORDS, chordLoop: 64, chordRhythm: VIC_RHYTHM,
    stabVoice: 'brass', stabLevel: 0.42, padLevel: 0.35,
    bass: VIC_BASS, bassLoop: 64, bassLevel: 0.6, bassCut: 500,
    melody: VIC_MELODY, melodyLoop: 64, leadVoice: 'lead', leadCut: 4200, leadLevel: 0.5,
    arpShape: [0, 1, 2, 3, 4, 3, 2, 1], arpRate: 1, arpOct: 1, arpVoice: 'bell',
    kick: ['x...x...x...x...', 'x...x...x.x.x...'],
    snare: ['....x.......x...', '....x...x.x.x.x.'],
    hat: ['x.x.x.x.x.x.x.x.'],
    perc: ['x.......x.......'],
    drumLevel: 0.7, kickTune: 125,
  },
};

// ---------------------------------------------------------------------------------
// Internal runtime structures
// ---------------------------------------------------------------------------------

/** One live sound effect. All of its oscillators/noise run through `out`. */
interface Voice {
  out: GainNode;
  pan: StereoPannerNode | null;
  send: GainNode | null;
  /** ctx time this voice is expected to fall silent — used for voice stealing. */
  endsAt: number;
  /** Number of scheduled sources still running. At 0 the voice tears itself down. */
  pending: number;
  dead: boolean;
}

/** Lane indices into Player.lanes. */
const L_BASS = 0;
const L_CHORD = 1;
const L_PAD = 2;
const L_DRUM = 3;
const L_HAT = 4;
const L_LEAD = 5;
const L_LEADOCT = 6;
const L_ARP = 7;
const LANE_COUNT = 8;

/** One playing music track. Two can exist at once during a crossfade. */
interface Player {
  def: TrackDef;
  gain: GainNode;
  lanes: GainNode[];
  laneTargets: Float32Array;
  leadFilter: BiquadFilterNode;
  send: GainNode;
  /** Next 16th-note step index to schedule (within the loop). */
  step: number;
  /** ctx time of that step. */
  nextTime: number;
  /** ctx time the player becomes audible. */
  startAt: number;
  /** ctx time to destroy the player, or 0 for "keep going". */
  stopAt: number;
  /** Rolling counter for the arpeggio shape. */
  arpIndex: number;
  fadingOut: boolean;
}

// ---------------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------------

export class AudioEngine {
  // --- context + buses -----------------------------------------------------------
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicMuffle: BiquadFilterNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private sfxFxIn: GainNode | null = null;
  private musicFxIn: GainNode | null = null;

  // --- pre-rendered noise --------------------------------------------------------
  private whiteBuf: AudioBuffer | null = null;
  private pinkBuf: AudioBuffer | null = null;

  // --- volumes (0..1), owned by the caller for persistence ------------------------
  private volMaster = 0.85;
  private volMusic = 0.6;
  private volSfx = 0.85;

  // --- sfx voices ----------------------------------------------------------------
  private voices: Voice[] = [];
  private lastPlayed: Map<SfxName, number> = new Map();

  // --- listener (updated every frame, never allocates) ----------------------------
  private lx = 0;
  private ly = 0;
  private lz = 0;

  // --- music state ---------------------------------------------------------------
  private players: Player[] = [];
  private schedTimer: ReturnType<typeof setInterval> | null = null;
  private currentTrack: MusicTrack | null = null;
  private pendingTrack: MusicTrack | null = null;
  private intensity = 0.55;
  private lastIntensity = -1;
  private overdrive = false;
  private muffle = 0;
  private timeScale = 1;
  private unlocking = false;
  private disposed = false;

  // --- hoverboard engine ----------------------------------------------------------
  private hoverWanted = false;
  private hoverOn = false;
  private hoverSawA: OscillatorNode | null = null;
  private hoverSawB: OscillatorNode | null = null;
  private hoverSub: OscillatorNode | null = null;
  private hoverNoise: AudioBufferSourceNode | null = null;
  private hoverNoiseGain: GainNode | null = null;
  private hoverNoiseBP: BiquadFilterNode | null = null;
  private hoverFilter: BiquadFilterNode | null = null;
  private hoverGain: GainNode | null = null;
  private hoverLfo: OscillatorNode | null = null;
  private hoverLfoGain: GainNode | null = null;
  private hoverSpeed = -1;
  private hoverBoost = false;

  /** True once the AudioContext exists and is running. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  // ===============================================================================
  // Lifecycle
  // ===============================================================================

  /**
   * Create/resume the AudioContext. MUST be called from a real user gesture
   * (pointerdown / keydown). Safe to call as often as you like.
   */
  async unlock(): Promise<void> {
    if (this.disposed || this.unlocking) return;
    this.unlocking = true;
    try {
      if (!this.ctx) {
        const g = globalThis as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const Ctor = g.AudioContext ?? g.webkitAudioContext;
        if (!Ctor) return; // SSR / prerender / ancient browser: stay silent, never throw.
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.buildGraph();
      }
      if (this.ctx.state !== 'running') {
        await this.ctx.resume();
      }
      // A silent 1-sample blip convinces stubborn iOS builds that we are legit.
      this.primeIos();
      this.startScheduler();
      if (this.hoverWanted && !this.hoverOn) this.startHoverNodes();
      if (this.pendingTrack) {
        const t = this.pendingTrack;
        this.pendingTrack = null;
        this.playMusic(t, 0.6);
      }
    } catch {
      /* A dead audio device must never take the game down. */
    } finally {
      this.unlocking = false;
    }
  }

  private primeIos(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.start(0);
      b.onended = () => {
        try { b.disconnect(); } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
  }

  /** Builds the fixed bus graph + pre-renders the noise buffers exactly once. */
  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // limiter -> destination: gentle glue so overlapping impacts never clip.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -9;
    lim.knee.value = 8;
    lim.ratio.value = 7;
    lim.attack.value = 0.004;
    lim.release.value = 0.18;
    lim.connect(ctx.destination);
    this.limiter = lim;

    const master = ctx.createGain();
    master.gain.value = this.volMaster * 0.85; // headroom
    master.connect(lim);
    this.masterGain = master;

    // Music bus runs through the muffle lowpass (pause / upgrade screens).
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 22050;
    muffle.Q.value = 0.4;
    muffle.connect(master);
    this.musicMuffle = muffle;

    const music = ctx.createGain();
    music.gain.value = this.volMusic;
    music.connect(muffle);
    this.musicGain = music;

    const sfx = ctx.createGain();
    sfx.gain.value = this.volSfx;
    sfx.connect(master);
    this.sfxGain = sfx;

    // Two cheap "space" units (dual feedback delay), one per bus so the volume
    // sliders also control their own tails.
    this.sfxFxIn = this.buildSpace(ctx, sfx, 0.105, 0.157, 0.3, 2600);
    this.musicFxIn = this.buildSpace(ctx, music, 0.135, 0.191, 0.38, 3000);

    this.renderNoise(ctx);
  }

  /**
   * A poor-man's reverb: two short feedback delays through a lowpass, panned apart.
   * Far cheaper than a ConvolverNode on mobile and perfectly good for shimmer tails.
   */
  private buildSpace(
    ctx: AudioContext, dest: AudioNode, tA: number, tB: number, fb: number, cut: number,
  ): GainNode {
    const input = ctx.createGain();
    input.gain.value = 1;

    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = cut;
    input.connect(damp);

    const mk = (time: number, panPos: number): void => {
      const d = ctx.createDelay(1);
      d.delayTime.value = time;
      const f = ctx.createGain();
      f.gain.value = fb;
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const out = ctx.createGain();
      out.gain.value = 0.5;
      damp.connect(d);
      d.connect(f);
      f.connect(d); // feedback loop (Web Audio inserts a one-block delay: safe)
      d.connect(out);
      if (p) {
        p.pan.value = panPos;
        out.connect(p);
        p.connect(dest);
      } else {
        out.connect(dest);
      }
    };
    mk(tA, -0.55);
    mk(tB, 0.55);
    return input;
  }

  /** White + pink noise rendered ONCE and replayed from random offsets forever after. */
  private renderNoise(ctx: AudioContext): void {
    const len = Math.floor(ctx.sampleRate * 2);

    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;
    this.whiteBuf = white;

    // Paul Kellett's economical pink filter — warmer noise for whooshes and air.
    const pink = ctx.createBuffer(1, len, ctx.sampleRate);
    const pd = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    this.pinkBuf = pink;
  }

  suspend(): void {
    this.stopScheduler();
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.state === 'running') void ctx.suspend();
    } catch { /* ignore */ }
  }

  resume(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    try {
      if (ctx.state !== 'running') {
        void ctx.resume().then(() => this.startScheduler()).catch(() => { /* ignore */ });
      } else {
        this.startScheduler();
      }
    } catch { /* ignore */ }
  }

  dispose(): void {
    this.disposed = true;
    this.stopScheduler();
    this.stopHover();
    for (const p of this.players) this.destroyPlayer(p);
    this.players.length = 0;
    for (const v of this.voices) this.releaseVoice(v);
    this.voices.length = 0;
    // Tear the fixed bus graph down before closing, so nothing is left referenced.
    for (const n of [this.sfxFxIn, this.musicFxIn, this.sfxGain, this.musicGain,
      this.musicMuffle, this.masterGain, this.limiter]) {
      if (!n) continue;
      try { n.disconnect(); } catch { /* ignore */ }
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      try { void ctx.close(); } catch { /* ignore */ }
    }
  }

  // ===============================================================================
  // Volumes / listener / global modifiers
  // ===============================================================================

  setVolumes(v: { master?: number; music?: number; sfx?: number }): void {
    if (typeof v.master === 'number') this.volMaster = clamp01(v.master);
    if (typeof v.music === 'number') this.volMusic = clamp01(v.music);
    if (typeof v.sfx === 'number') this.volSfx = clamp01(v.sfx);
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.volMaster * 0.85, t, 0.02);
      if (this.musicGain) this.musicGain.gain.setTargetAtTime(this.volMusic, t, 0.02);
      if (this.sfxGain) this.sfxGain.gain.setTargetAtTime(this.volSfx, t, 0.02);
    } catch { /* ignore */ }
  }

  getVolumes(): { master: number; music: number; sfx: number } {
    return { master: this.volMaster, music: this.volMusic, sfx: this.volSfx };
  }

  /** Called once per frame — stores three numbers, allocates nothing. */
  setListener(x: number, y: number, z: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
  }

  /** 0 = normal, 1 = fully muffled (pause + upgrade screens). */
  setMuffle(amount: number): void {
    const a = clamp01(amount);
    if (Math.abs(a - this.muffle) < 0.001) return;
    this.muffle = a;
    const ctx = this.ctx;
    const f = this.musicMuffle;
    if (!ctx || !f) return;
    try {
      // 22.05k -> 420Hz, exponential so it sounds like a door closing.
      const target = 420 * Math.pow(22050 / 420, 1 - a);
      f.frequency.cancelScheduledValues(ctx.currentTime);
      f.frequency.setTargetAtTime(target, ctx.currentTime, 0.08);
      f.Q.setTargetAtTime(0.4 + a * 1.6, ctx.currentTime, 0.08);
    } catch { /* ignore */ }
  }

  /** Slow-motion / impact-freeze: dips music tempo, note pitch and the hover whine. */
  setTimeScale(scale: number): void {
    const s = clamp(scale, 0.35, 2);
    if (Math.abs(s - this.timeScale) < 0.002) return;
    this.timeScale = s;
    this.applyHoverParams(true);
  }

  /** Cents of detune implied by the current time scale (0 at scale 1). */
  private get scaleCents(): number {
    return 1200 * Math.log2(this.timeScale);
  }

  // ===============================================================================
  // Voice management
  // ===============================================================================

  private releaseVoice(v: Voice): void {
    if (v.dead) return;
    v.dead = true;
    try { v.out.disconnect(); } catch { /* ignore */ }
    if (v.pan) { try { v.pan.disconnect(); } catch { /* ignore */ } }
    if (v.send) { try { v.send.disconnect(); } catch { /* ignore */ } }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /**
   * Grabs a voice, applying positional panning + distance attenuation. Returns null
   * when audio is not available. Steals the soonest-ending voice past the budget.
   */
  private acquireVoice(opts: SfxOptions | undefined, baseGain: number): Voice | null {
    const ctx = this.ctx;
    const sfx = this.sfxGain;
    if (!ctx || !sfx) return null;

    // Reap anything that finished but never fired a source (defensive).
    const now = ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.pending <= 0 && v.endsAt < now) this.releaseVoice(v);
    }

    if (this.voices.length >= MAX_VOICES) {
      let oldest = this.voices[0];
      for (const v of this.voices) if (v.endsAt < oldest.endsAt) oldest = v;
      try {
        oldest.out.gain.cancelScheduledValues(now);
        oldest.out.gain.setValueAtTime(Math.max(oldest.out.gain.value, 0.0001), now);
        oldest.out.gain.exponentialRampToValueAtTime(0.0001, now + 0.008);
      } catch { /* ignore */ }
      oldest.endsAt = now;
      // It keeps its own sources alive until they stop, but is now inaudible and
      // no longer counted.
      const idx = this.voices.indexOf(oldest);
      if (idx >= 0) this.voices.splice(idx, 1);
      oldest.dead = true;
    }

    let g = baseGain;
    let panPos = 0;
    const pos = opts && opts.pos;
    if (pos) {
      const dx = pos.x - this.lx;
      const dy = pos.y - this.ly;
      const dz = pos.z - this.lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      g *= 1 / (1 + d * DIST_K);
      panPos = clamp(dx / PAN_WIDTH, -1, 1) * PAN_MAX;
      if (g < 0.012) return null; // inaudible: don't waste a voice at all
    }
    if (opts && typeof opts.gain === 'number') g *= clamp(opts.gain, 0, 4);

    const out = ctx.createGain();
    out.gain.value = g;

    let pan: StereoPannerNode | null = null;
    if (pos && ctx.createStereoPanner) {
      try {
        pan = ctx.createStereoPanner();
        pan.pan.value = panPos;
        out.connect(pan);
        pan.connect(sfx);
      } catch {
        pan = null;
      }
    }
    if (!pan) out.connect(sfx);

    const voice: Voice = { out, pan, send: null, endsAt: ctx.currentTime + 0.05, pending: 0, dead: false };
    this.voices.push(voice);
    return voice;
  }

  /** Routes a share of the voice into the sfx space unit (shimmer / echo tails). */
  private sendTo(v: Voice, amount: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxFxIn || v.send) return;
    try {
      const s = ctx.createGain();
      s.gain.value = amount;
      (v.pan ? v.pan : v.out).connect(s);
      s.connect(this.sfxFxIn);
      v.send = s;
    } catch { /* ignore */ }
  }

  /**
   * Starts a source, schedules its stop, and guarantees teardown in onended.
   * Up to three extra nodes (filters/gains unique to this source) are disconnected
   * with it, which is what keeps a long session leak-free.
   */
  private fire(
    v: Voice, src: AudioScheduledSourceNode, t: number, end: number,
    n1?: AudioNode, n2?: AudioNode, n3?: AudioNode,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const stopAt = end + 0.03;
    v.pending++;
    if (stopAt > v.endsAt) v.endsAt = stopAt;
    try {
      src.start(t);
      src.stop(stopAt);
    } catch { /* ignore */ }
    src.onended = () => {
      try { src.disconnect(); } catch { /* ignore */ }
      if (n1) { try { n1.disconnect(); } catch { /* ignore */ } }
      if (n2) { try { n2.disconnect(); } catch { /* ignore */ } }
      if (n3) { try { n3.disconnect(); } catch { /* ignore */ } }
      v.pending--;
      if (v.pending <= 0) this.releaseVoice(v);
    };
  }

  // ===============================================================================
  // Envelope helpers
  // ===============================================================================

  /** Percussive envelope: fast attack, exponential decay to silence. */
  private envPerc(p: AudioParam, t: number, attack: number, dur: number, peak: number): number {
    const pk = Math.max(peak, 0.0002);
    try {
      p.setValueAtTime(0.0001, t);
      if (attack > 0.03) p.linearRampToValueAtTime(pk, t + attack);
      else p.exponentialRampToValueAtTime(pk, t + Math.max(attack, 0.0015));
      p.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.02));
    } catch { /* ignore */ }
    return t + Math.max(dur, attack + 0.02);
  }

  /** Sustained envelope for pads, held leads and brass. Returns the end time. */
  private envSus(
    p: AudioParam, t: number, attack: number, hold: number, release: number,
    peak: number, sustain = 0.72,
  ): number {
    const pk = Math.max(peak, 0.0002);
    const decay = Math.min(0.12, hold * 0.4);
    try {
      p.setValueAtTime(0.0001, t);
      p.linearRampToValueAtTime(pk, t + attack);
      p.exponentialRampToValueAtTime(pk * sustain, t + attack + decay);
      p.setValueAtTime(pk * sustain, t + Math.max(hold, attack + decay));
      p.exponentialRampToValueAtTime(0.0001, t + Math.max(hold, attack + decay) + release);
    } catch { /* ignore */ }
    return t + Math.max(hold, attack + decay) + release;
  }

  // ===============================================================================
  // Synthesis primitives — every sound effect is composed from these
  // ===============================================================================

  /**
   * Core tone: one oscillator with an optional pitch glide and a percussive env.
   * blip(f) == tone(f, f) ; sweep(f0, f1) == tone(f0, f1).
   */
  private tone(
    v: Voice, t: number, f0: number, f1: number, dur: number,
    wave: OscillatorType, peak: number, attack = 0.004, detuneCents = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = wave;
      const g = ctx.createGain();
      o.frequency.setValueAtTime(Math.max(f0, 1), t);
      if (Math.abs(f1 - f0) > 0.5) {
        o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur * 0.92);
      }
      o.detune.value = detuneCents + this.scaleCents;
      const end = this.envPerc(g.gain, t, attack, dur, peak);
      o.connect(g);
      g.connect(v.out);
      this.fire(v, o, t, end, g);
    } catch { /* ignore */ }
  }

  /** Tone through its own swept filter — the workhorse for zaps, risers and brass. */
  private toneF(
    v: Voice, t: number, f0: number, f1: number, dur: number, wave: OscillatorType,
    peak: number, filt: BiquadFilterType, cut0: number, cut1: number, q: number,
    attack = 0.004, detuneCents = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = wave;
      o.detune.value = detuneCents + this.scaleCents;
      o.frequency.setValueAtTime(Math.max(f0, 1), t);
      if (Math.abs(f1 - f0) > 0.5) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur * 0.92);

      const bq = ctx.createBiquadFilter();
      bq.type = filt;
      bq.Q.value = q;
      bq.frequency.setValueAtTime(Math.max(cut0, 20), t);
      if (Math.abs(cut1 - cut0) > 1) bq.frequency.exponentialRampToValueAtTime(Math.max(cut1, 20), t + dur * 0.9);

      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, attack, dur, peak);
      o.connect(bq);
      bq.connect(g);
      g.connect(v.out);
      this.fire(v, o, t, end, bq, g);
    } catch { /* ignore */ }
  }

  /** Filtered noise burst — whooshes, air, snares, sparks. */
  private noiseBurst(
    v: Voice, t: number, dur: number, filt: BiquadFilterType, hz0: number, hz1: number,
    q: number, peak: number, attack = 0.003, pink = false,
  ): void {
    const ctx = this.ctx;
    const buf = pink ? this.pinkBuf : this.whiteBuf;
    if (!ctx || !buf) return;
    try {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      // Random start offset so repeated bursts never phase-match.
      const off = Math.random() * Math.max(0.1, buf.duration - dur - 0.05);
      s.playbackRate.value = 1;

      const bq = ctx.createBiquadFilter();
      bq.type = filt;
      bq.Q.value = q;
      bq.frequency.setValueAtTime(Math.max(hz0, 20), t);
      if (Math.abs(hz1 - hz0) > 1) bq.frequency.exponentialRampToValueAtTime(Math.max(hz1, 20), t + dur * 0.95);

      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, attack, dur, peak);
      s.connect(bq);
      bq.connect(g);
      g.connect(v.out);

      s.start(t, off);
      s.stop(end + 0.03);
      v.pending++;
      if (end + 0.03 > v.endsAt) v.endsAt = end + 0.03;
      s.onended = () => {
        try { s.disconnect(); } catch { /* ignore */ }
        try { bq.disconnect(); } catch { /* ignore */ }
        try { g.disconnect(); } catch { /* ignore */ }
        v.pending--;
        if (v.pending <= 0) this.releaseVoice(v);
      };
    } catch { /* ignore */ }
  }

  /**
   * Two-operator FM: a sine carrier whose frequency is modulated by another sine.
   * Cheap and enormously expressive — bells, metal, plops and clonks all live here.
   */
  private fmHit(
    v: Voice, t: number, carrier: number, ratio: number, index: number, dur: number,
    peak: number, attack = 0.002,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const car = ctx.createOscillator();
      car.type = 'sine';
      car.frequency.value = Math.max(carrier, 1);
      car.detune.value = this.scaleCents;

      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = Math.max(carrier * ratio, 1);
      mod.detune.value = this.scaleCents;

      const modGain = ctx.createGain();
      // The modulation index decays faster than the amplitude: classic bell "ping".
      modGain.gain.setValueAtTime(carrier * index, t);
      modGain.gain.exponentialRampToValueAtTime(Math.max(carrier * index * 0.02, 0.5), t + dur * 0.6);
      mod.connect(modGain);
      modGain.connect(car.frequency);

      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, attack, dur, peak);
      car.connect(g);
      g.connect(v.out);

      this.fire(v, car, t, end, g);
      this.fire(v, mod, t, end, modGain);
    } catch { /* ignore */ }
  }

  /** A stack of detuned saws through a lowpass with a filter sweep — brassy stabs. */
  private chordStab(
    v: Voice, t: number, notes: readonly number[], dur: number, peak: number,
    wave: OscillatorType = 'sawtooth', cut0 = 500, cut1 = 3200, attack = 0.012,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 3;
      bq.frequency.setValueAtTime(cut0, t);
      bq.frequency.exponentialRampToValueAtTime(cut1, t + Math.min(0.09, dur * 0.35));
      bq.frequency.exponentialRampToValueAtTime(Math.max(cut0 * 0.8, 200), t + dur);

      const g = ctx.createGain();
      const end = this.envSus(g.gain, t, attack, dur * 0.7, dur * 0.45, peak, 0.62);
      bq.connect(g);
      g.connect(v.out);

      const per = peak > 0 ? 1 / Math.max(1, notes.length) : 1;
      for (let i = 0; i < notes.length; i++) {
        for (let d = 0; d < 2; d++) {
          const o = ctx.createOscillator();
          o.type = wave;
          o.frequency.value = hz(notes[i]);
          o.detune.value = (d === 0 ? -7 : 7) + rnd(-3, 3) + this.scaleCents;
          const og = ctx.createGain();
          og.gain.value = per * 0.5;
          o.connect(og);
          og.connect(bq);
          this.fire(v, o, t, end, og);
        }
      }
      // The filter/env pair belongs to the stab as a whole; the last source frees it.
      const tail = ctx.createOscillator();
      tail.type = 'sine';
      tail.frequency.value = 20;
      const tg = ctx.createGain();
      tg.gain.value = 0.00001;
      tail.connect(tg);
      tg.connect(v.out);
      this.fire(v, tail, t, end, tg, bq, g);
    } catch { /* ignore */ }
  }

  /** Detuned metal partials + a noise transient: crates, armour, robot bonks. */
  private metalClank(v: Voice, t: number, base: number, peak: number): void {
    const partials = [1, 1.42, 1.98, 2.71];
    for (let i = 0; i < partials.length; i++) {
      const f = base * partials[i] * wobble(0.02);
      this.tone(v, t + i * 0.004, f, f * 0.985, 0.16 + 0.09 * (1 - i / partials.length),
        i % 2 === 0 ? 'square' : 'triangle', peak * (0.5 - i * 0.09), 0.002, rnd(-12, 12));
    }
    this.noiseBurst(v, t, 0.09, 'bandpass', 2600 * wobble(0.06), 900, 1.6, peak * 0.7);
  }

  /** Pitch-dropping sine — kick drums, dash thumps, timpani. */
  private subThump(v: Voice, t: number, f0: number, f1: number, dur: number, peak: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(f1, 12), t + dur * 0.55);
      o.detune.value = this.scaleCents;
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.002, dur, peak);
      // A touch of saturation-free "click" so it reads on phone speakers.
      o.connect(g);
      g.connect(v.out);
      this.fire(v, o, t, end, g);
    } catch { /* ignore */ }
  }

  /** Short upward electric zip — the "magnetic" signature of Rivet's board. */
  private zip(v: Voice, t: number, f0: number, f1: number, dur: number, peak: number): void {
    this.toneF(v, t, f0, f1, dur, 'square', peak, 'highpass', 400, 1200, 1, 0.002);
  }

  /** Tone with a vibrato LFO — used for the Sparkies' cartoon "yay!" wobble. */
  private vibTone(
    v: Voice, t: number, f: number, dur: number, peak: number, wave: OscillatorType,
    vibHz: number, vibDepth: number, attack = 0.006,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = wave;
      o.frequency.value = Math.max(f, 1);
      o.detune.value = this.scaleCents;

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = vibHz;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0.0001, t);
      lg.gain.linearRampToValueAtTime(vibDepth, t + dur * 0.5);
      lfo.connect(lg);
      lg.connect(o.frequency);

      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, attack, dur, peak);
      o.connect(g);
      g.connect(v.out);
      this.fire(v, o, t, end, g);
      this.fire(v, lfo, t, end, lg);
    } catch { /* ignore */ }
  }

  // ===============================================================================
  // SFX — public entry point
  // ===============================================================================

  play(name: SfxName, opts?: SfxOptions): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || ctx.state !== 'running') return;
    try {
      // De-duplicate: ten bolts collected on one frame should be one satisfying
      // chime, not a machine-gun of clipped transients.
      const nowMs = ctx.currentTime * 1000;
      const last = this.lastPlayed.get(name);
      if (last !== undefined && nowMs - last < DEDUPE_MS) return;
      this.lastPlayed.set(name, nowMs);

      const v = this.acquireVoice(opts, 1);
      if (!v) return;
      const t = ctx.currentTime + 0.006;
      const p = opts && typeof opts.pitch === 'number' ? clamp(opts.pitch, 0.25, 4) : 1;
      this.render(name, v, t, p);
      if (v.pending <= 0) this.releaseVoice(v);
    } catch { /* never let audio crash the game */ }
  }

  /**
   * The sound design library. Each case layers 2-6 primitives; the comment above it
   * is the design brief it is trying to hit.
   */
  private render(name: SfxName, v: Voice, t: number, p: number): void {
    switch (name) {
      // --- UI -------------------------------------------------------------------
      // Tiny, dry, felt more than heard. Never fatiguing when spammed on a menu.
      case 'uiMove': {
        this.tone(v, t, 900 * p, 780 * p, 0.055, 'triangle', 0.15);
        this.noiseBurst(v, t, 0.02, 'highpass', 4000, 6000, 0.7, 0.06);
        break;
      }
      // Bright two-note "yes" with a sparkle on top.
      case 'uiConfirm': {
        this.tone(v, t, 659 * p, 659 * p, 0.07, 'triangle', 0.2);
        this.tone(v, t + 0.055, 988 * p, 988 * p, 0.14, 'triangle', 0.22);
        this.fmHit(v, t + 0.055, 1976 * p, 2, 1.4, 0.22, 0.09);
        this.sendTo(v, 0.18);
        break;
      }
      // The same gesture, inverted: friendly, not a buzzer.
      case 'uiBack': {
        this.tone(v, t, 620 * p, 620 * p, 0.07, 'triangle', 0.18);
        this.tone(v, t + 0.05, 415 * p, 400 * p, 0.15, 'triangle', 0.18);
        break;
      }
      // Something new is available: a four-note bell arpeggio with a real tail.
      case 'uiUnlock': {
        const arp = [72, 76, 79, 84];
        for (let i = 0; i < arp.length; i++) {
          this.fmHit(v, t + i * 0.075, hz(arp[i]) * p, 3.01, 2.2, 0.55, 0.16);
        }
        this.noiseBurst(v, t, 0.3, 'highpass', 5000, 9000, 0.8, 0.05);
        this.sendTo(v, 0.32);
        break;
      }
      // Mechanical toggle: click + short pluck.
      case 'uiToggle': {
        this.noiseBurst(v, t, 0.025, 'bandpass', 3200, 2000, 3, 0.16);
        this.tone(v, t + 0.005, 520 * p, 500 * p, 0.08, 'square', 0.12);
        break;
      }

      // --- Pickups ---------------------------------------------------------------
      // The most-heard pickup in the game: small, bright, clean over two octaves as
      // the combo pitch climbs. FM keeps it interesting where a sine would be dull.
      case 'bolt': {
        const w = wobble(0.02);
        this.fmHit(v, t, 1180 * p * w, 2, 3.2, 0.11, 0.3);
        this.tone(v, t, 2360 * p * w, 2500 * p, 0.05, 'triangle', 0.07);
        break;
      }
      // Energy cell: richer, a rising 4th with a shimmering tail.
      case 'cell': {
        this.fmHit(v, t, hz(84) * p, 2.01, 2.6, 0.22, 0.24);
        this.fmHit(v, t + 0.085, hz(91) * p, 2.01, 2.2, 0.5, 0.22);
        this.noiseBurst(v, t + 0.08, 0.45, 'highpass', 6000, 9500, 0.9, 0.06);
        this.sendTo(v, 0.35);
        break;
      }
      // THE happiest sound in the game. A major arpeggio sung with a vibrato "yay!",
      // randomised across three starting notes so twenty rescues never feel identical.
      case 'sparkieRescue': {
        const roots = [72, 74, 76];
        const root = roots[(Math.random() * roots.length) | 0];
        const shape = Math.random() < 0.5 ? [0, 4, 7] : [0, 7, 12];
        for (let i = 0; i < shape.length; i++) {
          const f = hz(root + shape[i]) * p * wobble(0.01);
          this.vibTone(v, t + i * 0.07, f, 0.26, 0.2, 'triangle', 7 + Math.random() * 3, 9);
          this.fmHit(v, t + i * 0.07, f * 2, 2, 1.1, 0.18, 0.07);
        }
        // Formant "wobble" on the top note = the little robot cheering.
        this.toneF(v, t + 0.14, hz(root + 12) * p, hz(root + 16) * p, 0.36, 'triangle',
          0.16, 'bandpass', 780, 1500, 6, 0.02);
        this.noiseBurst(v, t + 0.16, 0.3, 'highpass', 6000, 9000, 0.8, 0.05);
        this.sendTo(v, 0.3);
        break;
      }
      // A Sparkie noticing you: two-syllable chirp, randomised every time.
      case 'sparkieChirp': {
        const base = 820 * p * wobble(0.06);
        this.tone(v, t, base, base * 1.6, 0.07, 'triangle', 0.16);
        this.tone(v, t + 0.075, base * 1.4, base * 1.9, 0.09, 'triangle', 0.13);
        break;
      }
      // Health: a warm blooming major third, slow attack, nothing spiky.
      case 'heart': {
        this.tone(v, t, 523 * p, 659 * p, 0.4, 'sine', 0.22, 0.045);
        this.fmHit(v, t + 0.06, 1046 * p, 2, 1.2, 0.5, 0.11);
        this.noiseBurst(v, t + 0.05, 0.35, 'highpass', 4500, 7000, 0.7, 0.04);
        this.sendTo(v, 0.3);
        break;
      }
      // Crate: wood thock + metal debris. Chunky, never violent.
      case 'crateSmash': {
        this.noiseBurst(v, t, 0.26, 'lowpass', 900, 220, 1.1, 0.34, 0.002, true);
        this.subThump(v, t, 130, 52, 0.2, 0.3);
        this.metalClank(v, t + 0.01, 210 * wobble(0.05), 0.3);
        for (let i = 0; i < 3; i++) {
          this.tone(v, t + 0.06 + i * 0.05, rnd(1400, 2600), rnd(900, 1500), 0.07, 'square', 0.07);
        }
        break;
      }

      // --- Movement --------------------------------------------------------------
      // The signature sound of the game. Four layers: a falling filtered whoosh, a
      // punchy sub thump, an upward electric zip and a transient click on the front.
      case 'dash': {
        this.noiseBurst(v, t, 0.38, 'bandpass', 4200 * p, 380, 1.2, 0.32, 0.006, true);
        this.subThump(v, t, 175 * p, 42, 0.24, 0.46);
        this.zip(v, t + 0.02, 420 * p, 2100 * p, 0.17, 0.15);
        this.noiseBurst(v, t, 0.03, 'highpass', 5200, 3000, 0.8, 0.22);
        this.fmHit(v, t + 0.01, 880 * p, 1.5, 1.2, 0.2, 0.08);
        this.sendTo(v, 0.16);
        break;
      }
      // Out of charge: a soft "nope", deliberately gentle. No buzzers for kids.
      case 'dashFail': {
        this.toneF(v, t, 300 * p, 220 * p, 0.16, 'triangle', 0.2, 'lowpass', 1200, 500, 1, 0.006);
        this.toneF(v, t + 0.085, 240 * p, 175 * p, 0.18, 'triangle', 0.16, 'lowpass', 900, 400, 1, 0.006);
        this.noiseBurst(v, t, 0.12, 'lowpass', 700, 300, 1, 0.1, 0.004, true);
        break;
      }
      // Charge restored: a small upward ping you can hear under everything else.
      case 'dashRecharge': {
        this.tone(v, t, 520 * p, 1180 * p, 0.16, 'sine', 0.16);
        this.fmHit(v, t + 0.03, 1568 * p, 3, 1.6, 0.3, 0.13);
        this.sendTo(v, 0.25);
        break;
      }
      // Boost pad: a rising whoosh with a bright open chord riding it.
      case 'boostPad': {
        this.noiseBurst(v, t, 0.45, 'bandpass', 500, 6200, 1.4, 0.26, 0.02, true);
        this.chordStab(v, t + 0.02, [72, 76, 79, 84], 0.5, 0.15, 'sawtooth', 700, 5200, 0.03);
        this.zip(v, t, 300 * p, 2400 * p, 0.32, 0.13);
        this.subThump(v, t, 150, 60, 0.25, 0.3);
        this.sendTo(v, 0.28);
        break;
      }

      // --- Combat ----------------------------------------------------------------
      // Crisp electric arc: resonant noise crack + a falling square blip.
      case 'zap': {
        this.noiseBurst(v, t, 0.13, 'bandpass', 3000 * p, 2200 * p, 12, 0.3);
        this.tone(v, t, 1500 * p, 300 * p, 0.1, 'square', 0.15);
        this.noiseBurst(v, t, 0.03, 'highpass', 6000, 8000, 0.8, 0.14);
        break;
      }
      // Chain lightning: higher, with two decaying repeats so it reads as "spreading".
      case 'zapChain': {
        this.noiseBurst(v, t, 0.11, 'bandpass', 4200 * p, 2600 * p, 14, 0.26);
        this.tone(v, t, 2100 * p, 600 * p, 0.09, 'square', 0.13);
        this.tone(v, t + 0.07, 2600 * p, 900 * p, 0.07, 'square', 0.09);
        this.tone(v, t + 0.14, 3100 * p, 1200 * p, 0.06, 'square', 0.06);
        this.sendTo(v, 0.3);
        break;
      }
      // Contact: a short FM clonk with a noise skin. Reads as "tin robot", not "gore".
      case 'enemyHit': {
        this.fmHit(v, t, 240 * p * wobble(), 1.72, 6, 0.13, 0.32);
        this.noiseBurst(v, t, 0.09, 'bandpass', 1800, 600, 1.6, 0.2);
        this.tone(v, t, 620 * p, 400 * p, 0.06, 'square', 0.1);
        break;
      }
      // Defeat: a friendly pop, a descending sparkle and a confetti chirp.
      case 'enemyDefeat': {
        this.tone(v, t, 300, 950, 0.05, 'sine', 0.3, 0.001);
        this.noiseBurst(v, t, 0.09, 'highpass', 3000, 5000, 0.8, 0.16);
        const spark = [1568, 1319, 1047];
        for (let i = 0; i < spark.length; i++) {
          this.fmHit(v, t + 0.05 + i * 0.055, spark[i] * wobble(0.02), 2.5, 1.8, 0.26, 0.14);
        }
        this.tone(v, t + 0.2, 900, 1600, 0.07, 'triangle', 0.1);
        this.sendTo(v, 0.32);
        break;
      }
      // Enemy swing: a downward filtered saw with air behind it.
      case 'enemyAttack': {
        this.toneF(v, t, 700 * p, 180 * p, 0.28, 'sawtooth', 0.2, 'lowpass', 2200, 500, 4, 0.01);
        this.noiseBurst(v, t, 0.26, 'bandpass', 1200, 400, 1.5, 0.12, 0.01, true);
        break;
      }
      // "I'm about to do something": two polite pulses, rising. Alerting, not scary.
      case 'enemyTelegraph': {
        this.toneF(v, t, 660 * p, 660 * p, 0.1, 'square', 0.16, 'lowpass', 1600, 1200, 2, 0.008);
        this.toneF(v, t + 0.14, 880 * p, 880 * p, 0.12, 'square', 0.16, 'lowpass', 1900, 1400, 2, 0.008);
        break;
      }

      // --- Player state ----------------------------------------------------------
      // Getting hurt should feel like bumping a beach ball: soft bonk + wobble.
      case 'playerHurt': {
        this.vibTone(v, t, 330, 0.3, 0.3, 'sine', 9, 26, 0.008);
        this.toneF(v, t, 420, 260, 0.32, 'triangle', 0.12, 'lowpass', 1400, 500, 1.2, 0.01);
        this.noiseBurst(v, t, 0.13, 'lowpass', 800, 300, 1, 0.12, 0.004, true);
        break;
      }
      // Shield up: a rising filtered shimmer capped by a perfect fifth of bells.
      case 'shieldGain': {
        this.noiseBurst(v, t, 0.42, 'bandpass', 600, 5200, 3, 0.16, 0.03, true);
        this.tone(v, t, 400, 800, 0.35, 'sine', 0.12, 0.03);
        this.fmHit(v, t + 0.1, 784, 2, 1.4, 0.45, 0.14);
        this.fmHit(v, t + 0.16, 1176, 2, 1.2, 0.5, 0.12);
        this.sendTo(v, 0.32);
        break;
      }
      // Shield gone: glassy, descending, with no nasty edge.
      case 'shieldBreak': {
        const notes = [1568, 1245, 988];
        for (let i = 0; i < notes.length; i++) {
          this.fmHit(v, t + i * 0.045, notes[i] * wobble(0.02), 3.4, 4, 0.22, 0.18);
        }
        this.noiseBurst(v, t, 0.22, 'highpass', 4500, 1600, 1.2, 0.18);
        this.sendTo(v, 0.28);
        break;
      }

      // --- Combo / Overdrive -----------------------------------------------------
      // The caller walks `pitch` up the major pentatonic, so chaining pickups plays
      // an actual melody instead of a rising siren.
      case 'comboUp': {
        this.tone(v, t, 523 * p, 523 * p, 0.22, 'triangle', 0.22, 0.003);
        this.fmHit(v, t, 1046 * p, 2, 1.6, 0.3, 0.13);
        this.noiseBurst(v, t, 0.04, 'highpass', 6000, 8000, 0.8, 0.05);
        this.sendTo(v, 0.22);
        break;
      }
      // Combo lost: a small sigh. Muted, brief, no punishment.
      case 'comboBreak': {
        this.toneF(v, t, 440, 370, 0.22, 'triangle', 0.16, 'lowpass', 1300, 600, 1, 0.008);
        this.toneF(v, t + 0.1, 370, 294, 0.24, 'triangle', 0.12, 'lowpass', 1100, 500, 1, 0.008);
        break;
      }
      // "You can pop Overdrive now": two bright bells and a hint of shimmer.
      case 'overdriveReady': {
        this.fmHit(v, t, 1046, 2, 2, 0.4, 0.17);
        this.fmHit(v, t + 0.09, 1568, 2, 2, 0.6, 0.17);
        this.noiseBurst(v, t + 0.05, 0.35, 'highpass', 6000, 9000, 0.8, 0.06);
        this.sendTo(v, 0.4);
        break;
      }
      // GOOSEBUMPS: half a second of riser, then a wide power chord, sub and shimmer.
      case 'overdriveStart': {
        this.toneF(v, t, 110, 1500, 0.55, 'sawtooth', 0.2, 'lowpass', 400, 6000, 6, 0.05);
        this.noiseBurst(v, t, 0.55, 'bandpass', 400, 8000, 1.6, 0.18, 0.1, true);
        this.chordStab(v, t + 0.5, [48, 55, 60, 64, 67, 72], 0.95, 0.3, 'sawtooth', 800, 6500, 0.012);
        this.subThump(v, t + 0.5, 130, 45, 0.45, 0.45);
        this.fmHit(v, t + 0.54, 2093, 2, 2.4, 0.9, 0.13);
        this.fmHit(v, t + 0.62, 3136, 2, 2, 0.8, 0.1);
        this.noiseBurst(v, t + 0.5, 0.6, 'highpass', 7000, 11000, 0.8, 0.09);
        this.sendTo(v, 0.34);
        break;
      }
      // Powering down: same chord, sagging pitch and closing filter.
      case 'overdriveEnd': {
        this.toneF(v, t, 900, 180, 0.6, 'sawtooth', 0.18, 'lowpass', 5000, 400, 3, 0.02);
        this.chordStab(v, t, [60, 64, 67], 0.5, 0.12, 'triangle', 2200, 700, 0.03);
        this.noiseBurst(v, t, 0.5, 'bandpass', 4000, 500, 1.4, 0.1, 0.02, true);
        break;
      }

      // --- Upgrades / portals ----------------------------------------------------
      // A card appears: a warm blooming chord, like a curtain opening.
      case 'upgradeShow': {
        this.chordStab(v, t, [60, 64, 67, 71, 74], 0.9, 0.16, 'triangle', 400, 2600, 0.14);
        this.fmHit(v, t + 0.18, 1319, 2, 1.4, 0.7, 0.1);
        this.noiseBurst(v, t, 0.5, 'highpass', 5000, 8000, 0.7, 0.04);
        this.sendTo(v, 0.36);
        break;
      }
      // Card chosen: mechanism ka-chunk, then a bright confirming chord.
      case 'upgradePick': {
        this.noiseBurst(v, t, 0.035, 'bandpass', 2600, 1400, 4, 0.18);
        this.tone(v, t, 180, 140, 0.07, 'square', 0.14);
        this.chordStab(v, t + 0.04, [60, 67, 72, 76], 0.55, 0.22, 'sawtooth', 700, 4200, 0.012);
        this.fmHit(v, t + 0.1, 1568, 2, 1.8, 0.6, 0.12);
        this.fmHit(v, t + 0.18, 2093, 2, 1.6, 0.5, 0.09);
        this.sendTo(v, 0.3);
        break;
      }
      // Portal opening: slow resonant swirl upward. Magical, patient.
      case 'portalOpen': {
        this.toneF(v, t, 220, 660, 1.1, 'sawtooth', 0.14, 'bandpass', 300, 3000, 8, 0.25);
        this.toneF(v, t + 0.05, 226, 668, 1.05, 'sawtooth', 0.12, 'bandpass', 320, 3200, 8, 0.25);
        this.noiseBurst(v, t, 1.15, 'bandpass', 200, 6000, 5, 0.16, 0.4, true);
        this.fmHit(v, t + 0.55, 1046, 2.5, 2, 0.8, 0.1);
        this.fmHit(v, t + 0.75, 1568, 2.5, 2, 0.9, 0.1);
        this.sendTo(v, 0.42);
        break;
      }
      // Going through: doppler whoosh down, sub, and a zip out the other side.
      case 'portalEnter': {
        this.noiseBurst(v, t, 0.5, 'bandpass', 6000, 300, 1.6, 0.28, 0.02, true);
        this.subThump(v, t, 200, 38, 0.42, 0.42);
        this.zip(v, t + 0.18, 600, 3000, 0.26, 0.14);
        this.fmHit(v, t + 0.2, 1319, 2, 2, 0.7, 0.1);
        this.sendTo(v, 0.36);
        break;
      }

      // --- Boss ------------------------------------------------------------------
      // Cartoon brass stab + timpani. Impressive and silly, never frightening.
      case 'bossIntro': {
        this.chordStab(v, t, [36, 48, 51, 55, 60], 1.1, 0.3, 'sawtooth', 300, 2600, 0.02);
        this.subThump(v, t, 95, 46, 0.6, 0.45);
        this.noiseBurst(v, t, 0.9, 'highpass', 3000, 1200, 0.8, 0.14, 0.005);
        this.chordStab(v, t + 0.6, [32, 44, 48, 51, 56], 1.0, 0.26, 'sawtooth', 300, 2400, 0.02);
        this.subThump(v, t + 0.6, 95, 44, 0.6, 0.4);
        this.sendTo(v, 0.3);
        break;
      }
      // A fist the size of a bus lands: sub, plate clank, dust.
      case 'bossSlam': {
        this.subThump(v, t, 135, 36, 0.5, 0.55);
        this.metalClank(v, t, 175 * wobble(0.04), 0.34);
        this.noiseBurst(v, t, 0.4, 'lowpass', 1800, 200, 1.1, 0.24, 0.003, true);
        for (let i = 0; i < 4; i++) {
          this.tone(v, t + 0.1 + i * 0.06, rnd(900, 1900), rnd(600, 1100), 0.08, 'square', 0.06);
        }
        break;
      }
      // Damaged: a clank plus a cartoon squawk. He's annoyed, not injured.
      case 'bossHurt': {
        this.metalClank(v, t, 300 * p * wobble(0.03), 0.3);
        this.toneF(v, t + 0.02, 520 * p, 220 * p, 0.26, 'sawtooth', 0.18, 'bandpass', 1500, 600, 6, 0.008);
        this.noiseBurst(v, t, 0.12, 'bandpass', 2200, 900, 2, 0.14);
        break;
      }
      // Phase change: two rising stabs and a timpani triplet. "He's getting serious."
      case 'bossPhase': {
        this.chordStab(v, t, [48, 51, 55, 60], 0.55, 0.28, 'sawtooth', 400, 3000, 0.015);
        this.chordStab(v, t + 0.42, [51, 55, 58, 63], 0.9, 0.3, 'sawtooth', 450, 3600, 0.015);
        this.subThump(v, t, 100, 50, 0.25, 0.4);
        this.subThump(v, t + 0.2, 100, 50, 0.25, 0.36);
        this.subThump(v, t + 0.42, 110, 46, 0.55, 0.46);
        this.noiseBurst(v, t + 0.42, 0.8, 'highpass', 3500, 1500, 0.8, 0.14);
        this.sendTo(v, 0.32);
        break;
      }
      // Defeated: comedic wind-down, three descending clanks, then a triumphant
      // major chord and a cascade of sparkles. Pure kids-movie ending.
      case 'bossDefeat': {
        this.toneF(v, t, 600, 80, 1.3, 'sawtooth', 0.2, 'lowpass', 3000, 300, 3, 0.02);
        this.metalClank(v, t + 0.25, 260, 0.24);
        this.metalClank(v, t + 0.55, 200, 0.22);
        this.metalClank(v, t + 0.8, 150, 0.2);
        this.noiseBurst(v, t + 1.0, 0.35, 'lowpass', 1200, 200, 1, 0.2, 0.004, true);
        this.chordStab(v, t + 1.1, [48, 55, 64, 67, 72], 1.3, 0.3, 'sawtooth', 500, 5000, 0.02);
        this.subThump(v, t + 1.1, 120, 45, 0.6, 0.45);
        const cascade = [84, 88, 91, 96, 99];
        for (let i = 0; i < cascade.length; i++) {
          this.fmHit(v, t + 1.16 + i * 0.07, hz(cascade[i]), 2, 2, 0.7, 0.12);
        }
        this.sendTo(v, 0.4);
        break;
      }

      // --- Results ---------------------------------------------------------------
      // A real fanfare: four brass notes with a third underneath, bell doubling, and
      // a cymbal-ish wash. Same C major family as the score.
      case 'victory': {
        const fan: number[][] = [[72, 67], [76, 72], [79, 76], [84, 79, 72]];
        const times = [0, 0.13, 0.26, 0.42];
        for (let i = 0; i < fan.length; i++) {
          const dur = i === fan.length - 1 ? 1.1 : 0.16;
          this.chordStab(v, t + times[i], fan[i], dur, 0.26, 'sawtooth', 600, 4200, 0.012);
          this.fmHit(v, t + times[i], hz(fan[i][0] + 12), 2, 1.8, 0.5, 0.1);
        }
        this.subThump(v, t, 120, 48, 0.3, 0.36);
        this.subThump(v, t + 0.42, 130, 45, 0.5, 0.4);
        this.noiseBurst(v, t + 0.42, 1.1, 'highpass', 4000, 8000, 0.7, 0.11, 0.006);
        this.sendTo(v, 0.34);
        break;
      }
      // Not a punishment: a gentle four-note descent that lands on a warm major
      // chord, so the last thing a seven-year-old hears is "have another go".
      case 'gameOver': {
        const desc = [76, 72, 69, 65];
        for (let i = 0; i < desc.length; i++) {
          this.toneF(v, t + i * 0.17, hz(desc[i]), hz(desc[i]), 0.4, 'triangle', 0.18,
            'lowpass', 2200, 900, 1, 0.02);
        }
        this.chordStab(v, t + 0.68, [53, 60, 65, 69], 1.2, 0.16, 'triangle', 500, 1800, 0.12);
        this.sendTo(v, 0.3);
        break;
      }
      // 3... 2... 1...
      case 'countdown': {
        this.tone(v, t, 660 * p, 660 * p, 0.16, 'triangle', 0.24);
        this.fmHit(v, t, 1320 * p, 2, 1.2, 0.25, 0.11);
        this.sendTo(v, 0.2);
        break;
      }
      // GO! Rising triad with a whoosh underneath.
      case 'countdownGo': {
        const tri = [784, 988, 1175];
        for (let i = 0; i < tri.length; i++) {
          this.tone(v, t + i * 0.045, tri[i], tri[i], 0.28, 'triangle', 0.22);
        }
        this.chordStab(v, t + 0.09, [67, 72, 76, 79], 0.6, 0.22, 'sawtooth', 800, 5000, 0.01);
        this.noiseBurst(v, t, 0.35, 'bandpass', 800, 6000, 1.4, 0.18, 0.02, true);
        this.subThump(v, t + 0.09, 140, 50, 0.3, 0.34);
        this.sendTo(v, 0.28);
        break;
      }
      // Score tally: deliberately tiny; it fires many times a second.
      case 'tallyTick': {
        this.tone(v, t, 2300 * p, 2300 * p, 0.03, 'square', 0.075);
        break;
      }
      // Tally finished: three bells up.
      case 'tallyDone': {
        this.fmHit(v, t, 1046, 2, 1.8, 0.3, 0.16);
        this.fmHit(v, t + 0.07, 1319, 2, 1.8, 0.35, 0.16);
        this.fmHit(v, t + 0.14, 1568, 2, 1.8, 0.7, 0.18);
        this.sendTo(v, 0.35);
        break;
      }
      // A star earned: a five-note sparkle run with a long shimmer.
      case 'star': {
        const run = [79, 84, 88, 91, 96];
        for (let i = 0; i < run.length; i++) {
          this.fmHit(v, t + i * 0.06, hz(run[i]) * p, 2.5, 2.2, 0.6, 0.15);
        }
        this.noiseBurst(v, t + 0.1, 0.6, 'highpass', 7000, 11000, 0.8, 0.07);
        this.sendTo(v, 0.45);
        break;
      }
      default: {
        // Exhaustiveness guard: adding an SfxName without a sound is a type error.
        const missing: never = name;
        void missing;
        break;
      }
    }
  }

  // ===============================================================================
  // MUSIC — voices
  // ===============================================================================
  // These mirror the SFX primitives but write into a lane gain instead of a voice,
  // and clean themselves up in onended exactly the same way.

  /** Start + auto-teardown for a scheduled music source. */
  private mFire(
    src: AudioScheduledSourceNode, t: number, end: number,
    n1?: AudioNode, n2?: AudioNode, n3?: AudioNode,
  ): void {
    try {
      src.start(t);
      src.stop(end + 0.03);
    } catch { /* ignore */ }
    src.onended = () => {
      try { src.disconnect(); } catch { /* ignore */ }
      if (n1) { try { n1.disconnect(); } catch { /* ignore */ } }
      if (n2) { try { n2.disconnect(); } catch { /* ignore */ } }
      if (n3) { try { n3.disconnect(); } catch { /* ignore */ } }
    };
  }

  private mNoise(
    dest: AudioNode, t: number, dur: number, filt: BiquadFilterType,
    hz0: number, hz1: number, q: number, peak: number, pink = false,
  ): void {
    const ctx = this.ctx;
    const buf = pink ? this.pinkBuf : this.whiteBuf;
    if (!ctx || !buf) return;
    try {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      const bq = ctx.createBiquadFilter();
      bq.type = filt;
      bq.Q.value = q;
      bq.frequency.setValueAtTime(Math.max(hz0, 20), t);
      if (Math.abs(hz1 - hz0) > 1) bq.frequency.exponentialRampToValueAtTime(Math.max(hz1, 20), t + dur * 0.95);
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.002, dur, peak);
      s.connect(bq);
      bq.connect(g);
      g.connect(dest);
      s.start(t, Math.random() * Math.max(0.1, buf.duration - dur - 0.05));
      s.stop(end + 0.03);
      s.onended = () => {
        try { s.disconnect(); } catch { /* ignore */ }
        try { bq.disconnect(); } catch { /* ignore */ }
        try { g.disconnect(); } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
  }

  /** pluck: triangle pair, fast decay — the bouncy Sunbeam Scrapyard melody voice. */
  private mPluck(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const f = hz(midi);
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 1.2;
      bq.frequency.setValueAtTime(Math.min(f * 9, 9000), t);
      bq.frequency.exponentialRampToValueAtTime(Math.max(f * 2.2, 220), t + dur * 0.8);
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.004, Math.max(dur * 0.9, 0.1), 0.42 * vel);
      bq.connect(g);
      g.connect(dest);
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = (i === 0 ? -5 : 6) + this.scaleCents;
        o.connect(bq);
        this.mFire(o, t, end, i === 1 ? bq : undefined, i === 1 ? g : undefined);
      }
    } catch { /* ignore */ }
  }

  /** bass: filtered saw + sine sub. Carries the groove on tiny phone speakers. */
  private mBass(dest: AudioNode, t: number, midi: number, dur: number, vel: number, cut: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const f = hz(midi);
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 4;
      bq.frequency.setValueAtTime(cut * 2.2, t);
      bq.frequency.exponentialRampToValueAtTime(cut, t + Math.min(0.12, dur));
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.006, Math.max(dur * 0.92, 0.08), 0.5 * vel);
      bq.connect(g);
      g.connect(dest);

      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = f;
      saw.detune.value = this.scaleCents;
      saw.connect(bq);
      this.mFire(saw, t, end, bq, g);

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = f;
      sub.detune.value = this.scaleCents;
      const sg = ctx.createGain();
      this.envPerc(sg.gain, t, 0.006, Math.max(dur * 0.92, 0.08), 0.4 * vel);
      sub.connect(sg);
      sg.connect(dest);
      this.mFire(sub, t, end, sg);
    } catch { /* ignore */ }
  }

  /** lead: two detuned saws through an envelope-swept lowpass, with vibrato on holds. */
  private mLead(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const f = hz(midi);
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 5;
      bq.frequency.setValueAtTime(Math.min(f * 2, 5000), t);
      bq.frequency.exponentialRampToValueAtTime(Math.min(f * 7, 9000), t + 0.05);
      bq.frequency.exponentialRampToValueAtTime(Math.min(f * 3, 6000), t + dur);
      const g = ctx.createGain();
      const end = this.envSus(g.gain, t, 0.012, Math.max(dur * 0.85, 0.09), 0.09, 0.34 * vel, 0.75);
      bq.connect(g);
      g.connect(dest);
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = (i === 0 ? -8 : 9) + this.scaleCents;
        o.connect(bq);
        this.mFire(o, t, end, i === 1 ? bq : undefined, i === 1 ? g : undefined);
      }
      if (dur > 0.35) {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 5.2;
        const lg = ctx.createGain();
        lg.gain.setValueAtTime(0.0001, t);
        lg.gain.linearRampToValueAtTime(f * 0.008, t + dur * 0.6);
        lfo.connect(lg);
        lg.connect(bq.detune);
        this.mFire(lfo, t, end, lg);
      }
    } catch { /* ignore */ }
  }

  /** pad: slow-attack detuned triangles. Air under the whole arrangement. */
  private mPad(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const f = hz(midi);
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.value = Math.min(f * 6, 4200);
      bq.Q.value = 0.7;
      const g = ctx.createGain();
      const end = this.envSus(g.gain, t, Math.min(0.35, dur * 0.4), dur * 0.85, dur * 0.4, 0.22 * vel, 0.8);
      bq.connect(g);
      g.connect(dest);
      for (let i = 0; i < 2; i++) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = (i === 0 ? -11 : 12) + this.scaleCents;
        o.connect(bq);
        this.mFire(o, t, end, i === 1 ? bq : undefined, i === 1 ? g : undefined);
      }
    } catch { /* ignore */ }
  }

  /** bell: FM sine. Menu melody, Cloudtop sparkle, counter-arpeggios. */
  private mBell(dest: AudioNode, t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const f = hz(midi);
      const car = ctx.createOscillator();
      car.type = 'sine';
      car.frequency.value = f;
      car.detune.value = this.scaleCents;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = f * 3.01;
      mod.detune.value = this.scaleCents;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 1.9, t);
      mg.gain.exponentialRampToValueAtTime(Math.max(f * 0.05, 1), t + Math.max(dur * 0.5, 0.12));
      mod.connect(mg);
      mg.connect(car.frequency);
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.003, Math.max(dur, 0.35), 0.3 * vel);
      car.connect(g);
      g.connect(dest);
      this.mFire(car, t, end, g);
      this.mFire(mod, t, end, mg);
    } catch { /* ignore */ }
  }

  /** brass: detuned saw stack with a fast filter envelope — boss + victory stabs. */
  private mBrass(dest: AudioNode, t: number, notes: readonly number[], dur: number, vel: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 3.5;
      bq.frequency.setValueAtTime(420, t);
      bq.frequency.exponentialRampToValueAtTime(3400, t + 0.05);
      bq.frequency.exponentialRampToValueAtTime(900, t + Math.max(dur, 0.15));
      const g = ctx.createGain();
      const end = this.envSus(g.gain, t, 0.014, Math.max(dur * 0.8, 0.1), 0.12, 0.3 * vel, 0.6);
      bq.connect(g);
      g.connect(dest);
      const per = 1 / Math.max(1, notes.length);
      for (let i = 0; i < notes.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(notes[i]);
        o.detune.value = rnd(-9, 9) + this.scaleCents;
        const og = ctx.createGain();
        og.gain.value = per;
        o.connect(og);
        og.connect(bq);
        const lastOne = i === notes.length - 1;
        this.mFire(o, t, end, og, lastOne ? bq : undefined, lastOne ? g : undefined);
      }
    } catch { /* ignore */ }
  }

  // --- drum kit (all synthesized: no samples anywhere in this file) ---------------

  private mKick(dest: AudioNode, t: number, vel: number, tune: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(tune, t);
      o.frequency.exponentialRampToValueAtTime(tune * 0.33, t + 0.075);
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.002, 0.3, 0.85 * vel);
      o.connect(g);
      g.connect(dest);
      this.mFire(o, t, end, g);
      this.mNoise(dest, t, 0.014, 'highpass', 2600, 2600, 0.7, 0.12 * vel);
    } catch { /* ignore */ }
  }

  private mSnare(dest: AudioNode, t: number, vel: number): void {
    this.mNoise(dest, t, 0.16, 'bandpass', 1900, 1200, 1.1, 0.34 * vel);
    this.mNoise(dest, t, 0.06, 'highpass', 5000, 6000, 0.8, 0.16 * vel);
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
      const g = ctx.createGain();
      const end = this.envPerc(g.gain, t, 0.002, 0.1, 0.2 * vel);
      o.connect(g);
      g.connect(dest);
      this.mFire(o, t, end, g);
    } catch { /* ignore */ }
  }

  private mHat(dest: AudioNode, t: number, vel: number, open: boolean): void {
    this.mNoise(dest, t, open ? 0.24 : 0.045, 'highpass', 7200, 8200, 0.8, 0.18 * vel);
  }

  private mShaker(dest: AudioNode, t: number, vel: number): void {
    this.mNoise(dest, t, 0.055, 'bandpass', 5200, 6400, 1.6, 0.16 * vel, true);
  }

  // ===============================================================================
  // MUSIC — players, scheduler, crossfades
  // ===============================================================================

  /** Seconds per 16th note, including overdrive tempo lift + slow-motion scaling. */
  private stepDur(def: TrackDef): number {
    const mult = (this.overdrive ? 1.03 : 1) * this.timeScale;
    return 60 / (def.bpm * mult) / 4;
  }

  /** The chord sounding at a given step of the chord loop. */
  private chordAt(def: TrackDef, step: number): readonly number[] {
    const s = step % def.chordLoop;
    let best = def.chords[0][1];
    for (let i = 0; i < def.chords.length; i++) {
      if (def.chords[i][0] <= s) best = def.chords[i][1];
      else break;
    }
    return best;
  }

  /** How long the chord starting at `step` lasts, in steps. */
  private chordLen(def: TrackDef, step: number): number {
    const s = step % def.chordLoop;
    for (let i = 0; i < def.chords.length; i++) {
      if (def.chords[i][0] === s) {
        const next = i + 1 < def.chords.length ? def.chords[i + 1][0] : def.chordLoop;
        return next - s;
      }
    }
    return 16;
  }

  private createPlayer(def: TrackDef, startAt: number, fade: number): Player | null {
    const ctx = this.ctx;
    const bus = this.musicGain;
    if (!ctx || !bus) return null;
    try {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + Math.max(fade, 0.01));
      gain.connect(bus);

      const leadFilter = ctx.createBiquadFilter();
      leadFilter.type = 'lowpass';
      leadFilter.Q.value = 0.8;
      leadFilter.frequency.value = def.leadCut * (this.overdrive ? 2.6 : 1);
      leadFilter.connect(gain);

      const lanes: GainNode[] = [];
      for (let i = 0; i < LANE_COUNT; i++) {
        const g = ctx.createGain();
        g.gain.value = i === L_LEAD || i === L_LEADOCT || i === L_ARP ? 0 : 1;
        if (i === L_LEAD || i === L_LEADOCT) g.connect(leadFilter);
        else g.connect(gain);
        lanes.push(g);
      }

      const send = ctx.createGain();
      send.gain.value = this.overdrive ? 0.3 : 0.12;
      gain.connect(send);
      if (this.musicFxIn) send.connect(this.musicFxIn);

      const p: Player = {
        def, gain, lanes, laneTargets: new Float32Array(LANE_COUNT), leadFilter, send,
        step: 0, nextTime: startAt, startAt, stopAt: 0, arpIndex: 0, fadingOut: false,
      };
      p.laneTargets.fill(-1);
      this.players.push(p);
      this.applyLayers(true);
      return p;
    } catch {
      return null;
    }
  }

  private destroyPlayer(p: Player): void {
    try { p.gain.disconnect(); } catch { /* ignore */ }
    try { p.leadFilter.disconnect(); } catch { /* ignore */ }
    try { p.send.disconnect(); } catch { /* ignore */ }
    for (const l of p.lanes) {
      try { l.disconnect(); } catch { /* ignore */ }
    }
  }

  private fadeOutPlayer(p: Player, at: number, fade: number): void {
    if (p.fadingOut) return;
    p.fadingOut = true;
    const g = p.gain.gain;
    try {
      const from = at >= p.startAt + DEFAULT_FADE ? 1 : Math.max(g.value, 0.0001);
      g.cancelScheduledValues(at);
      g.setValueAtTime(from, at);
      g.linearRampToValueAtTime(0.0001, at + Math.max(fade, 0.01));
    } catch { /* ignore */ }
    p.stopAt = at + Math.max(fade, 0.01) + 0.2;
  }

  playMusic(track: MusicTrack, fadeSeconds = DEFAULT_FADE): void {
    if (this.disposed) return;
    const def = TRACKS[track];
    if (!def) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      // Requested before the first user gesture: remember and start on unlock().
      this.pendingTrack = track;
      this.currentTrack = track;
      return;
    }
    if (this.currentTrack === track) {
      let liveSame = false;
      for (const p of this.players) if (!p.fadingOut) liveSame = true;
      if (liveSame) return; // already playing: do nothing (idempotent)
    }
    this.currentTrack = track;
    const fade = Math.max(0, fadeSeconds);
    const now = ctx.currentTime;
    let startAt = now + 0.06;

    // Find the newest non-fading player and align the switch to its next bar line so
    // transitions land musically instead of sounding like a needle scratch.
    let live: Player | null = null;
    for (const p of this.players) if (!p.fadingOut) live = p;
    if (live) {
      const sd = this.stepDur(live.def);
      const toBar = (16 - (live.step % 16)) % 16;
      startAt = Math.max(live.nextTime + toBar * sd, now + 0.06);
      this.fadeOutPlayer(live, startAt, fade);
    }
    for (const p of this.players) if (!p.fadingOut) this.fadeOutPlayer(p, now, Math.min(fade, 0.4));

    this.createPlayer(def, startAt, fade);
    this.startScheduler();
  }

  stopMusic(fadeSeconds = DEFAULT_FADE): void {
    this.currentTrack = null;
    this.pendingTrack = null;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const p of this.players) this.fadeOutPlayer(p, now, Math.max(0.05, fadeSeconds));
  }

  /** 0..1 — called every frame. Only touches AudioParams when it actually moved. */
  setMusicIntensity(v: number): void {
    const iv = clamp01(v);
    this.intensity = iv;
    if (Math.abs(iv - this.lastIntensity) < 0.01) return;
    this.lastIntensity = iv;
    this.applyLayers(false);
  }

  setOverdrive(on: boolean): void {
    if (on === this.overdrive) return;
    this.overdrive = on;
    this.applyLayers(true);
  }

  /**
   * Intensity layering, the heart of the adaptive score:
   *   < 0.25  bass + chords only
   *   ~ 0.30  drums arrive
   *   ~ 0.45  hats + shaker
   *   ~ 0.55  the melody
   *   > 0.80  the counter-arpeggio
   * Overdrive unmutes the octave-doubled lead, opens the lane filter and pushes the
   * shimmer send.
   */
  private applyLayers(force: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const p of this.players) {
      const iv = Math.max(this.intensity, p.def.floor);
      const tgt = p.laneTargets;
      const want = (lane: number, value: number): void => {
        if (!force && Math.abs(tgt[lane] - value) < 0.01) return;
        tgt[lane] = value;
        try { p.lanes[lane].gain.setTargetAtTime(value, t, 0.12); } catch { /* ignore */ }
      };
      want(L_BASS, 1);
      want(L_CHORD, 0.7 + 0.3 * iv);
      want(L_PAD, 1);
      want(L_DRUM, smooth(0.12, 0.32, iv));
      want(L_HAT, smooth(0.3, 0.5, iv));
      want(L_LEAD, smooth(0.42, 0.6, iv));
      want(L_LEADOCT, this.overdrive ? 0.55 : 0);
      want(L_ARP, smooth(0.72, 0.88, iv));
      try {
        p.leadFilter.frequency.setTargetAtTime(p.def.leadCut * (this.overdrive ? 2.6 : 1), t, 0.15);
        p.send.gain.setTargetAtTime(this.overdrive ? 0.3 : 0.12, t, 0.2);
      } catch { /* ignore */ }
    }
  }

  private startScheduler(): void {
    if (this.schedTimer !== null || this.disposed) return;
    this.schedTimer = setInterval(() => this.tick(), SCHED_TICK_MS);
  }

  private stopScheduler(): void {
    if (this.schedTimer !== null) {
      clearInterval(this.schedTimer);
      this.schedTimer = null;
    }
  }

  /**
   * Lookahead scheduler. Every 25ms it schedules every 16th note that falls inside
   * the next 120ms against ctx.currentTime, so playback never drifts and nothing
   * depends on timer jitter.
   */
  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (ctx.state !== 'running') return;
    const horizon = ctx.currentTime + SCHED_HORIZON;
    for (let i = this.players.length - 1; i >= 0; i--) {
      const p = this.players[i];
      if (p.stopAt > 0 && ctx.currentTime > p.stopAt) {
        this.destroyPlayer(p);
        this.players.splice(i, 1);
        continue;
      }
      const sd = this.stepDur(p.def);
      const total = p.def.bars * 16;
      let guard = 0;
      while (p.nextTime < horizon && guard++ < 96) {
        const swingOff = (p.step & 1) === 1 ? p.def.swing * sd : 0;
        try {
          this.scheduleStep(p, p.step, p.nextTime + swingOff, sd);
        } catch { /* one bad note must never stop the music */ }
        p.step = (p.step + 1) % total;
        p.nextTime += sd;
      }
    }
  }

  /** Renders one 16th-note step of one player into the graph. */
  private scheduleStep(p: Player, step: number, when: number, sd: number): void {
    const def = p.def;
    const bar = (step / 16) | 0;
    const inBar = step % 16;
    const lanes = p.lanes;

    // --- harmony: sustained pad on chord changes, rhythmic stabs on the grid ------
    const chordStep = step % def.chordLoop;
    if (def.padLevel > 0) {
      for (let i = 0; i < def.chords.length; i++) {
        if (def.chords[i][0] === chordStep) {
          const notes = def.chords[i][1];
          const dur = this.chordLen(def, chordStep) * sd;
          for (let n = 0; n < notes.length; n++) {
            this.mPad(lanes[L_PAD], when, notes[n], dur, def.padLevel);
          }
          break;
        }
      }
    }
    if (def.stabLevel > 0) {
      const row = def.chordRhythm[bar % def.chordRhythm.length];
      const c = row.charAt(inBar);
      if (c !== '.' && c !== '') {
        const notes = this.chordAt(def, chordStep);
        const vel = def.stabLevel * (c === 'X' ? 1.2 : c === 'g' ? 0.55 : 1);
        if (def.stabVoice === 'brass') {
          this.mBrass(lanes[L_CHORD], when, notes, sd * 2.2, vel);
        } else if (def.stabVoice === 'bell') {
          for (let n = 0; n < notes.length; n++) this.mBell(lanes[L_CHORD], when, notes[n] + 12, sd * 4, vel * 0.5);
        } else {
          for (let n = 0; n < notes.length; n++) this.mPluck(lanes[L_CHORD], when, notes[n], sd * 2, vel * 0.6);
        }
      }
    }

    // --- bass --------------------------------------------------------------------
    const bassStep = step % def.bassLoop;
    for (let i = 0; i < def.bass.length; i++) {
      const n = def.bass[i];
      if (n[0] === bassStep) {
        this.mBass(lanes[L_BASS], when, n[1], n[2] * sd, def.bassLevel * (n[3] ?? 1), def.bassCut);
      }
    }

    // --- melody (+ the overdrive octave double) ----------------------------------
    const melStep = step % def.melodyLoop;
    for (let i = 0; i < def.melody.length; i++) {
      const n = def.melody[i];
      if (n[0] === melStep) {
        const dur = n[2] * sd;
        const vel = def.leadLevel * (n[3] ?? 1);
        if (def.leadVoice === 'bell') this.mBell(lanes[L_LEAD], when, n[1], dur, vel * 1.6);
        else if (def.leadVoice === 'pluck') this.mPluck(lanes[L_LEAD], when, n[1], dur, vel * 1.4);
        else this.mLead(lanes[L_LEAD], when, n[1], dur, vel);
        if (this.overdrive) {
          this.mBell(lanes[L_LEADOCT], when, n[1] + 12, dur * 0.8, vel * 1.1);
        }
      }
    }

    // --- counter-arpeggio (top intensity layer) ----------------------------------
    if (step % def.arpRate === 0) {
      const notes = this.chordAt(def, chordStep);
      const shape = def.arpShape;
      const idx = shape[p.arpIndex % shape.length];
      p.arpIndex++;
      const note = notes[idx % notes.length] + 12 * def.arpOct;
      if (def.arpVoice === 'bell') this.mBell(lanes[L_ARP], when, note, sd * 3, 0.5);
      else this.mPluck(lanes[L_ARP], when, note, sd * 1.6, 0.5);
    }

    // --- drums -------------------------------------------------------------------
    const k = def.kick[bar % def.kick.length].charAt(inBar);
    if (k === 'x' || k === 'X') this.mKick(lanes[L_DRUM], when, def.drumLevel * (k === 'X' ? 1.1 : 1), def.kickTune);
    const s = def.snare[bar % def.snare.length].charAt(inBar);
    if (s === 'x' || s === 'X') this.mSnare(lanes[L_DRUM], when, def.drumLevel * (s === 'X' ? 1.1 : 1));
    else if (s === 'g') this.mSnare(lanes[L_DRUM], when, def.drumLevel * 0.35);
    const h = def.hat[bar % def.hat.length].charAt(inBar);
    if (h === 'x' || h === 'X' || h === 'g') {
      this.mHat(lanes[L_HAT], when, def.drumLevel * (h === 'X' ? 1 : h === 'g' ? 0.4 : 0.7), false);
    } else if (h === 'o' || h === 'O') {
      this.mHat(lanes[L_HAT], when, def.drumLevel * 0.8, true);
    }
    const pc = def.perc[bar % def.perc.length].charAt(inBar);
    if (pc === 'x' || pc === 'X') this.mShaker(lanes[L_HAT], when, def.drumLevel * (pc === 'X' ? 1 : 0.75));
  }

  // ===============================================================================
  // Hoverboard engine — one continuous voice, parameter-driven
  // ===============================================================================

  startHover(): void {
    this.hoverWanted = true;
    if (this.ctx && this.ctx.state === 'running') this.startHoverNodes();
  }

  private startHoverNodes(): void {
    const ctx = this.ctx;
    const sfx = this.sfxGain;
    if (!ctx || !sfx || this.hoverOn || !this.pinkBuf) return;
    try {
      const out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(sfx);

      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 700;
      filt.Q.value = 4;
      filt.connect(out);

      // Two detuned saws = the magnetic motor whine.
      const a = ctx.createOscillator();
      a.type = 'sawtooth';
      a.frequency.value = 90;
      a.connect(filt);
      const b = ctx.createOscillator();
      b.type = 'sawtooth';
      b.frequency.value = 90;
      b.detune.value = 11;
      b.connect(filt);
      // A sine sub gives it body on a phone speaker.
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = 45;
      const subG = ctx.createGain();
      subG.gain.value = 0.5;
      sub.connect(subG);
      subG.connect(filt);

      // Pink noise through a bandpass = the air being pushed underneath.
      const noise = ctx.createBufferSource();
      noise.buffer = this.pinkBuf;
      noise.loop = true;
      const nbp = ctx.createBiquadFilter();
      nbp.type = 'bandpass';
      nbp.frequency.value = 900;
      nbp.Q.value = 0.9;
      const ng = ctx.createGain();
      ng.gain.value = 0.1;
      noise.connect(nbp);
      nbp.connect(ng);
      ng.connect(out);

      // Slow filter wobble so the idle never sounds like a static drone.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 4.7;
      const lg = ctx.createGain();
      lg.gain.value = 90;
      lfo.connect(lg);
      lg.connect(filt.frequency);

      a.start();
      b.start();
      sub.start();
      noise.start();
      lfo.start();

      this.hoverGain = out;
      this.hoverFilter = filt;
      this.hoverSawA = a;
      this.hoverSawB = b;
      this.hoverSub = sub;
      this.hoverNoise = noise;
      this.hoverNoiseBP = nbp;
      this.hoverNoiseGain = ng;
      this.hoverLfo = lfo;
      this.hoverLfoGain = lg;
      this.hoverOn = true;
      this.hoverSpeed = -1;
      this.applyHoverParams(true);
      // subG rides with the sub oscillator; keep a reference alive via the graph.
      this.hoverSub.onended = () => {
        try { subG.disconnect(); } catch { /* ignore */ }
      };
    } catch {
      this.hoverOn = false;
    }
  }

  stopHover(): void {
    this.hoverWanted = false;
    const ctx = this.ctx;
    if (!this.hoverOn || !ctx) return;
    this.hoverOn = false;
    const t = ctx.currentTime;
    const g = this.hoverGain;
    try {
      if (g) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      }
    } catch { /* ignore */ }
    const srcs: (AudioScheduledSourceNode | null)[] = [
      this.hoverSawA, this.hoverSawB, this.hoverSub, this.hoverNoise, this.hoverLfo,
    ];
    const nodes: (AudioNode | null)[] = [
      this.hoverFilter, this.hoverNoiseBP, this.hoverNoiseGain, this.hoverLfoGain, this.hoverGain,
    ];
    for (const s of srcs) {
      if (!s) continue;
      try { s.stop(t + 0.22); } catch { /* ignore */ }
      s.onended = () => {
        try { s.disconnect(); } catch { /* ignore */ }
      };
    }
    setTimeout(() => {
      for (const n of nodes) {
        if (!n) continue;
        try { n.disconnect(); } catch { /* ignore */ }
      }
    }, 400);
    this.hoverSawA = null;
    this.hoverSawB = null;
    this.hoverSub = null;
    this.hoverNoise = null;
    this.hoverLfo = null;
    this.hoverFilter = null;
    this.hoverNoiseBP = null;
    this.hoverNoiseGain = null;
    this.hoverLfoGain = null;
    this.hoverGain = null;
    this.hoverSpeed = -1;
  }

  /** Per-frame. Bails out immediately unless something actually changed. */
  setHoverParams(speed01: number, boosting: boolean): void {
    const s = clamp01(speed01);
    if (Math.abs(s - this.hoverSpeed) < 0.01 && boosting === this.hoverBoost) return;
    this.hoverSpeed = s;
    this.hoverBoost = boosting;
    this.applyHoverParams(false);
  }

  private applyHoverParams(force: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.hoverOn) return;
    if (!force && this.hoverSpeed < 0) return;
    const s = this.hoverSpeed < 0 ? 0 : this.hoverSpeed;
    const boost = this.hoverBoost;
    const t = ctx.currentTime;
    const tc = 0.09;
    const cents = this.scaleCents;
    try {
      const base = (72 + s * 96) * (boost ? 1.22 : 1);
      if (this.hoverSawA) {
        this.hoverSawA.frequency.setTargetAtTime(base, t, tc);
        this.hoverSawA.detune.setTargetAtTime(cents - 6, t, tc);
      }
      if (this.hoverSawB) {
        this.hoverSawB.frequency.setTargetAtTime(base * 1.005, t, tc);
        this.hoverSawB.detune.setTargetAtTime(cents + 11, t, tc);
      }
      if (this.hoverSub) {
        this.hoverSub.frequency.setTargetAtTime(base * 0.5, t, tc);
        this.hoverSub.detune.setTargetAtTime(cents, t, tc);
      }
      if (this.hoverFilter) {
        this.hoverFilter.frequency.setTargetAtTime(340 + s * 2400 + (boost ? 2000 : 0), t, tc);
      }
      if (this.hoverNoiseBP) {
        this.hoverNoiseBP.frequency.setTargetAtTime(700 + s * 2600 + (boost ? 900 : 0), t, tc);
      }
      if (this.hoverNoiseGain) {
        this.hoverNoiseGain.gain.setTargetAtTime(0.05 + s * 0.22 + (boost ? 0.1 : 0), t, tc);
      }
      if (this.hoverGain) {
        this.hoverGain.gain.setTargetAtTime((0.09 + s * 0.11) * (boost ? 1.35 : 1), t, tc);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Shared singleton. Importing this module is side-effect free: no AudioContext is
 * created until the game calls audio.unlock() from a real user gesture.
 */
export const audio = new AudioEngine();
