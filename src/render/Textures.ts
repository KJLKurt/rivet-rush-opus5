/**
 * Rivet Rush — procedural texture library.
 *
 * Every texture in the game is drawn at runtime on a 2D canvas and wrapped in a
 * `THREE.CanvasTexture`, so the shipped bundle contains zero image assets. Each
 * texture is generated at most once and cached by key; call `disposeTextures()`
 * on teardown.
 *
 * Art rules baked in here:
 *  - nothing is a flat fill — everything has a gradient, a bevel and a little
 *    value noise so it reads as "designed" rather than "programmer art";
 *  - tiling maps are authored to wrap seamlessly (details near an edge are
 *    re-drawn on the opposite side);
 *  - hazards always carry the black/amber chevron pattern as a colour-blind-safe
 *    danger cue.
 *
 * Sizes are mobile-sane: 512 only for the big workhorse surfaces, 128–256 for
 * everything else.
 */

import * as THREE from 'three';
import { PAL } from './Palette';

export type TextureKey =
  // --- tiling surfaces -------------------------------------------------------
  | 'metalPanel'
  | 'metalPlate'
  | 'rustPanel'
  | 'hazardStripe'
  | 'grassTop'
  | 'rockSide'
  | 'circuit'
  | 'gridGlow'
  | 'woodPlank'
  // --- sprites / masks -------------------------------------------------------
  | 'cloudSprite'
  | 'glowSprite'
  | 'sparkSprite'
  | 'ringSprite'
  | 'smokeSprite'
  | 'shadowBlob'
  // --- data ------------------------------------------------------------------
  | 'noise'
  | 'toonRamp3'
  | 'toonRamp4'
  | 'toonRampSoft';

/** Every key, handy for pre-warming during the loading screen. */
export const TEXTURE_KEYS: readonly TextureKey[] = [
  'metalPanel', 'metalPlate', 'rustPanel', 'hazardStripe', 'grassTop', 'rockSide',
  'circuit', 'gridGlow', 'woodPlank', 'cloudSprite', 'glowSprite', 'sparkSprite',
  'ringSprite', 'smokeSprite', 'shadowBlob', 'noise', 'toonRamp3', 'toonRamp4',
  'toonRampSoft',
] as const;

const TAU = Math.PI * 2;
const ANISOTROPY = 4;

const cache = new Map<TextureKey, THREE.Texture>();
const tiledCache = new Map<string, THREE.Texture>();

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32) so textures rebuild identically. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function css(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

function mixHex(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Lighten (amt > 0) toward white, darken (amt < 0) toward a cool ink navy. */
function shade(hex: number, amt: number): number {
  return amt >= 0 ? mixHex(hex, 0xffffff, amt) : mixHex(hex, 0x161a2e, -amt);
}

interface Layer {
  c: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  s: number;
}

function layer(width: number, height = width): Layer {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (!g) throw new Error('Rivet Rush: 2D canvas context unavailable');
  return { c, g, s: width };
}

/**
 * Runs `draw` nine times (offset by ±size) so anything drawn near an edge also
 * appears on the opposite side — this is what makes the tiling maps seamless.
 */
function tiled(g: CanvasRenderingContext2D, size: number, draw: () => void): void {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      g.save();
      g.translate(ox * size, oy * size);
      draw();
      g.restore();
    }
  }
}

/** Cheap organic mottling: a tiny random grid, bilinear-upscaled and blended. */
function softNoise(
  g: CanvasRenderingContext2D,
  size: number,
  cells: number,
  seed: number,
  alpha: number,
  mode: GlobalCompositeOperation = 'overlay',
  tint: number = 0xffffff,
): void {
  const n = Math.max(3, Math.round(cells));
  const small = layer(n + 1);
  const r = rng(seed);
  const vals = new Float32Array((n + 1) * (n + 1));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) vals[y * (n + 1) + x] = r();
  }
  // duplicate the first row/column onto the last so the upscale wraps
  for (let i = 0; i < n; i++) {
    vals[i * (n + 1) + n] = vals[i * (n + 1)];
    vals[n * (n + 1) + i] = vals[i];
  }
  vals[n * (n + 1) + n] = vals[0];

  const img = small.g.createImageData(n + 1, n + 1);
  const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    img.data[i * 4 + 0] = Math.round(tr * v);
    img.data[i * 4 + 1] = Math.round(tg * v);
    img.data[i * 4 + 2] = Math.round(tb * v);
    img.data[i * 4 + 3] = 255;
  }
  small.g.putImageData(img, 0, 0);

  const scale = size / n;
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = mode;
  g.imageSmoothingEnabled = true;
  g.drawImage(small.c, -scale * 0.5, -scale * 0.5, size + scale, size + scale);
  g.restore();
}

/** A domed metal rivet with a highlight and a contact shadow. */
function rivet(g: CanvasRenderingContext2D, x: number, y: number, r: number, base: number): void {
  g.save();
  g.beginPath();
  g.arc(x + r * 0.16, y + r * 0.2, r * 1.06, 0, TAU);
  g.fillStyle = css(shade(base, -0.45), 0.55);
  g.fill();

  const grd = g.createRadialGradient(x - r * 0.36, y - r * 0.38, r * 0.12, x, y, r);
  grd.addColorStop(0, css(shade(base, 0.62)));
  grd.addColorStop(0.45, css(shade(base, 0.12)));
  grd.addColorStop(1, css(shade(base, -0.3)));
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = grd;
  g.fill();

  g.beginPath();
  g.arc(x - r * 0.3, y - r * 0.32, r * 0.26, 0, TAU);
  g.fillStyle = css(0xffffff, 0.45);
  g.fill();
  g.restore();
}

function roundRectPath(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** Bevelled inset panel: light on the top-left lip, shadow on the bottom-right. */
function bevelPanel(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, base: number,
): void {
  const grd = g.createLinearGradient(x, y, x + w * 0.35, y + h);
  grd.addColorStop(0, css(shade(base, 0.16)));
  grd.addColorStop(0.55, css(base));
  grd.addColorStop(1, css(shade(base, -0.12)));
  roundRectPath(g, x, y, w, h, r);
  g.fillStyle = grd;
  g.fill();

  g.save();
  roundRectPath(g, x, y, w, h, r);
  g.clip();
  g.lineWidth = 3;
  g.strokeStyle = css(0xffffff, 0.3);
  roundRectPath(g, x + 1.5, y + 1.5, w - 3, h - 3, r);
  g.stroke();
  g.strokeStyle = css(shade(base, -0.6), 0.4);
  roundRectPath(g, x + 3.5, y + 4.5, w - 3, h - 3, r);
  g.stroke();
  g.restore();
}

/** Faint hairline scratches, wrapped so they tile. */
function scratches(
  g: CanvasRenderingContext2D, size: number, count: number, seed: number, light: number,
): void {
  const r = rng(seed);
  g.save();
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = r() * size;
    const y = r() * size;
    const len = 8 + r() * size * 0.22;
    const ang = (r() - 0.5) * 0.9 + (r() < 0.5 ? 0 : Math.PI * 0.5);
    const a = 0.04 + r() * 0.1;
    const dark = r() < 0.5;
    tiled(g, size, () => {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.lineWidth = 0.6 + r() * 1.1;
      g.strokeStyle = dark ? css(shade(light, -0.75), a) : css(0xffffff, a * 0.9);
      g.stroke();
    });
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// tiling surfaces
// ---------------------------------------------------------------------------

/** Brushed panel plate with corner rivets, a soft bevel and faint scratches. */
function buildMetalPanel(tint: number = PAL.metalMid, seed = 7): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);

  const base = g.createLinearGradient(0, 0, S * 0.25, S);
  base.addColorStop(0, css(shade(tint, 0.2)));
  base.addColorStop(0.5, css(tint));
  base.addColorStop(1, css(shade(tint, -0.16)));
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);

  // brushed horizontal grain
  const r = rng(seed);
  g.save();
  for (let i = 0; i < 260; i++) {
    const y = r() * S;
    g.fillStyle = r() < 0.5 ? css(0xffffff, 0.03 + r() * 0.05) : css(shade(tint, -0.7), 0.03 + r() * 0.05);
    g.fillRect(0, y, S, 0.6 + r() * 1.6);
  }
  g.restore();

  softNoise(g, S, 40, seed + 11, 0.3, 'overlay');
  softNoise(g, S, 7, seed + 23, 0.22, 'soft-light');

  // four bevelled sub-plates with a seam cross through the middle
  const pad = 10;
  const half = S / 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      bevelPanel(g, i * half + pad, j * half + pad, half - pad * 2, half - pad * 2, 18, tint);
    }
  }

  // seam shadows (drawn on the tile edges too, so the tile reads continuously)
  g.save();
  g.strokeStyle = css(shade(tint, -0.62), 0.75);
  g.lineWidth = 5;
  tiled(g, S, () => {
    g.beginPath();
    g.moveTo(half, 0); g.lineTo(half, S);
    g.moveTo(0, half); g.lineTo(S, half);
    g.moveTo(0, 0); g.lineTo(S, 0);
    g.moveTo(0, 0); g.lineTo(0, S);
    g.stroke();
  });
  g.strokeStyle = css(0xffffff, 0.22);
  g.lineWidth = 2;
  tiled(g, S, () => {
    g.beginPath();
    g.moveTo(half + 3.5, 0); g.lineTo(half + 3.5, S);
    g.moveTo(0, half + 3.5); g.lineTo(S, half + 3.5);
    g.moveTo(3.5, 0); g.lineTo(3.5, S);
    g.moveTo(0, 3.5); g.lineTo(S, 3.5);
    g.stroke();
  });
  g.restore();

  // rivets in every sub-plate corner
  const inset = 30;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const x0 = i * half, y0 = j * half;
      const pts: Array<[number, number]> = [
        [x0 + inset, y0 + inset],
        [x0 + half - inset, y0 + inset],
        [x0 + inset, y0 + half - inset],
        [x0 + half - inset, y0 + half - inset],
      ];
      for (const p of pts) tiled(g, S, () => rivet(g, p[0], p[1], 7.5, tint));
    }
  }

  scratches(g, S, 42, seed + 5, tint);
  return c;
}

/** Chunky diamond-tread checkerplate — used for platform tops and catwalks. */
function buildMetalPlate(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);
  const tint = PAL.metalMid;

  const base = g.createLinearGradient(0, 0, S * 0.3, S);
  base.addColorStop(0, css(shade(tint, 0.24)));
  base.addColorStop(1, css(shade(tint, -0.2)));
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  softNoise(g, S, 48, 91, 0.32, 'overlay');
  softNoise(g, S, 6, 92, 0.2, 'soft-light');

  const cell = S / 4; // 128 — tiles perfectly
  const drawTread = (cx: number, cy: number, ang: number): void => {
    tiled(g, S, () => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      // drop shadow
      g.save();
      g.translate(3, 4);
      roundRectPath(g, -34, -8, 68, 16, 8);
      g.fillStyle = css(shade(tint, -0.62), 0.5);
      g.fill();
      g.restore();
      // bar with a top-lit gradient
      const grd = g.createLinearGradient(0, -9, 0, 9);
      grd.addColorStop(0, css(shade(tint, 0.5)));
      grd.addColorStop(0.5, css(shade(tint, 0.12)));
      grd.addColorStop(1, css(shade(tint, -0.24)));
      roundRectPath(g, -34, -8, 68, 16, 8);
      g.fillStyle = grd;
      g.fill();
      g.strokeStyle = css(0xffffff, 0.3);
      g.lineWidth = 1.5;
      roundRectPath(g, -33, -7, 66, 8, 5);
      g.stroke();
      g.restore();
    });
  };

  for (let iy = 0; iy < 4; iy++) {
    for (let ix = 0; ix < 4; ix++) {
      const cx = ix * cell + cell * 0.5;
      const cy = iy * cell + cell * 0.5;
      const ang = ((ix + iy) % 2 === 0 ? 1 : -1) * Math.PI * 0.25;
      drawTread(cx - cell * 0.22, cy - cell * 0.22, ang);
      drawTread(cx + cell * 0.22, cy + cell * 0.22, ang);
    }
  }

  // plate seams
  g.save();
  g.strokeStyle = css(shade(tint, -0.55), 0.6);
  g.lineWidth = 4;
  tiled(g, S, () => {
    g.strokeRect(0, 0, S, S);
  });
  g.restore();

  scratches(g, S, 30, 44, tint);
  return c;
}

/** Warm, oxidised variant of the panel plate — the Sunbeam Scrapyard workhorse. */
function buildRustPanel(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);
  g.drawImage(buildMetalPanel(mixHex(PAL.metalMid, PAL.rockLight, 0.35), 31), 0, 0);

  // patchy oxidised blotches
  const r = rng(404);
  const rustA = mixHex(PAL.rockDark, PAL.hazard, 0.35);
  const rustB = mixHex(PAL.rockLight, PAL.hazard, 0.3);
  for (let i = 0; i < 26; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 18 + r() * 74;
    const col = r() < 0.5 ? rustA : rustB;
    tiled(g, S, () => {
      const grd = g.createRadialGradient(x, y, rad * 0.1, x, y, rad);
      grd.addColorStop(0, css(col, 0.62));
      grd.addColorStop(0.6, css(col, 0.32));
      grd.addColorStop(1, css(col, 0));
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fillStyle = grd;
      g.fill();
    });
  }
  // crusty speckle inside the blotches
  softNoise(g, S, 90, 77, 0.34, 'overlay', mixHex(rustA, 0xffffff, 0.3));
  softNoise(g, S, 9, 78, 0.26, 'multiply', 0xffe6c8);

  for (let i = 0; i < 70; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 1 + r() * 3.4;
    tiled(g, S, () => {
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fillStyle = css(shade(rustA, -0.35), 0.35 + r() * 0.3);
      g.fill();
    });
  }
  return c;
}

/** Bold amber / near-black diagonal hazard chevrons — the danger cue. */
function buildHazardStripe(): HTMLCanvasElement {
  const S = 256;
  const period = 128; // divides S so the diagonal pattern tiles
  const { c, g } = layer(S);

  g.fillStyle = css(PAL.hazardDark);
  g.fillRect(0, 0, S, S);
  softNoise(g, S, 32, 5, 0.22, 'overlay');

  const band = (c0: number, w: number, fill: string): void => {
    g.beginPath();
    g.moveTo(c0, 0);
    g.lineTo(c0 + w, 0);
    g.lineTo(c0 + w - 2 * S, 2 * S);
    g.lineTo(c0 - 2 * S, 2 * S);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };

  for (let k = -2; k <= 3; k++) {
    const c0 = k * period;
    band(c0, period * 0.5, css(PAL.hazard));
    band(c0, 9, css(shade(PAL.hazard, 0.5)));            // lit leading edge
    band(c0 + period * 0.5 - 9, 9, css(shade(PAL.hazard, -0.4)));  // shadowed trailing edge
    band(c0 + period * 0.5, 7, css(shade(PAL.hazardDark, 0.35), 0.8));
  }

  softNoise(g, S, 26, 17, 0.24, 'overlay');
  scratches(g, S, 16, 19, PAL.hazard);

  // grimy vignette so it doesn't look like flat vinyl
  const vg = g.createLinearGradient(0, 0, S, S);
  vg.addColorStop(0, css(0xffffff, 0.1));
  vg.addColorStop(0.5, css(0xffffff, 0));
  vg.addColorStop(1, css(0x000000, 0.14));
  g.fillStyle = vg;
  g.fillRect(0, 0, S, S);
  return c;
}

/** Stylized top-down grass for Cloudtop Gardens: layered tones, blades, flowers. */
function buildGrassTop(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);

  g.fillStyle = css(PAL.leafMid);
  g.fillRect(0, 0, S, S);
  softNoise(g, S, 5, 3, 0.55, 'overlay', mixHex(PAL.leafLight, 0xffffff, 0.3));
  softNoise(g, S, 11, 4, 0.4, 'soft-light');
  softNoise(g, S, 26, 6, 0.22, 'overlay');

  const r = rng(1234);
  // broad tone patches
  for (let i = 0; i < 16; i++) {
    const x = r() * S, y = r() * S, rad = 40 + r() * 90;
    const col = r() < 0.5 ? PAL.leafDark : PAL.leafLight;
    tiled(g, S, () => {
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, css(col, 0.3));
      grd.addColorStop(1, css(col, 0));
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fillStyle = grd;
      g.fill();
    });
  }

  // blades: little tapered strokes, lighter at the tip
  g.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const x = r() * S, y = r() * S;
    const len = 5 + r() * 13;
    const ang = -Math.PI * 0.5 + (r() - 0.5) * 1.5;
    const light = r();
    const col = light < 0.55 ? mixHex(PAL.leafLight, 0xffffff, 0.15) : PAL.leafDark;
    const lw = 1.2 + r() * 2.2;
    tiled(g, S, () => {
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(ang) * len * 0.6, y + Math.sin(ang) * len * 0.6,
        x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.lineWidth = lw;
      g.strokeStyle = css(col, 0.4 + r() * 0.45);
      g.stroke();
    });
  }

  // a few flower dots for colour pop
  for (let i = 0; i < 22; i++) {
    const x = r() * S, y = r() * S;
    const rad = 3 + r() * 3.5;
    const petalCol = r() < 0.6 ? PAL.petal : mixHex(PAL.bolt, 0xffffff, 0.25);
    tiled(g, S, () => {
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * TAU + i;
        g.beginPath();
        g.arc(x + Math.cos(a) * rad * 0.9, y + Math.sin(a) * rad * 0.9, rad * 0.72, 0, TAU);
        g.fillStyle = css(petalCol, 0.95);
        g.fill();
      }
      g.beginPath();
      g.arc(x, y, rad * 0.55, 0, TAU);
      g.fillStyle = css(mixHex(PAL.bolt, 0xffffff, 0.4));
      g.fill();
    });
  }

  softNoise(g, S, 60, 8, 0.16, 'overlay');
  return c;
}

/** Chunky stylized rock strata — the underside of every floating island. */
function buildRockSide(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);
  const r = rng(88);

  g.fillStyle = css(PAL.rockDark);
  g.fillRect(0, 0, S, S);

  const bands = 7;
  // periodic wobble so the left and right edges line up
  const wave = (x: number, k: number): number => {
    const t = (x / S) * TAU;
    return Math.sin(t * 2 + k * 1.7) * 9 + Math.sin(t * 3 + k * 3.1) * 5 + Math.sin(t * 5 + k) * 3;
  };

  for (let b = 0; b < bands; b++) {
    const y0 = (b / bands) * S;
    const y1 = ((b + 1) / bands) * S;
    const t = b / (bands - 1);
    const col = mixHex(PAL.rockLight, PAL.rockDark, 0.15 + t * 0.75 + (r() - 0.5) * 0.16);
    g.beginPath();
    g.moveTo(0, y0 + (b === 0 ? 0 : wave(0, b)));
    for (let x = 0; x <= S; x += 8) {
      g.lineTo(x, y0 + (b === 0 ? 0 : wave(x, b)));
    }
    g.lineTo(S, y1 + (b === bands - 1 ? 0 : wave(S, b + 1)));
    for (let x = S; x >= 0; x -= 8) {
      g.lineTo(x, y1 + (b === bands - 1 ? 0 : wave(x, b + 1)));
    }
    g.closePath();
    const grd = g.createLinearGradient(0, y0, 0, y1);
    grd.addColorStop(0, css(shade(col, 0.22)));
    grd.addColorStop(0.35, css(col));
    grd.addColorStop(1, css(shade(col, -0.22)));
    g.fillStyle = grd;
    g.fill();

    // lit lip along the top of each stratum
    g.beginPath();
    g.moveTo(0, y0 + (b === 0 ? 0 : wave(0, b)));
    for (let x = 0; x <= S; x += 8) g.lineTo(x, y0 + (b === 0 ? 0 : wave(x, b)));
    g.lineWidth = 4;
    g.strokeStyle = css(shade(col, 0.45), 0.55);
    g.stroke();
  }

  // chunky facet cracks
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S;
    const len = 20 + r() * 60;
    const ang = Math.PI * 0.5 + (r() - 0.5) * 1.1;
    tiled(g, S, () => {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.lineWidth = 1.5 + r() * 2.5;
      g.strokeStyle = css(shade(PAL.rockDark, -0.45), 0.35);
      g.stroke();
    });
  }

  softNoise(g, S, 34, 9, 0.3, 'overlay');
  softNoise(g, S, 8, 10, 0.24, 'soft-light');
  return c;
}

/** Glowing circuit traces on dark plate — Stormworks seams and consoles. */
function buildCircuit(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);
  const plate = mixHex(PAL.metalDark, PAL.hazardDark, 0.55);

  const bg = g.createLinearGradient(0, 0, S * 0.4, S);
  bg.addColorStop(0, css(shade(plate, 0.16)));
  bg.addColorStop(1, css(shade(plate, -0.25)));
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  softNoise(g, S, 44, 21, 0.28, 'overlay');
  softNoise(g, S, 7, 22, 0.2, 'soft-light');

  const grid = 32;
  const r = rng(2024);
  const glow = PAL.energy;

  const trace = (pts: Array<[number, number]>, width: number, alpha: number): void => {
    tiled(g, S, () => {
      g.save();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.shadowColor = css(glow, 0.9);
      g.shadowBlur = 10;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.lineWidth = width;
      g.strokeStyle = css(mixHex(glow, 0xffffff, 0.35), alpha);
      g.stroke();
      g.restore();
    });
  };

  // dark trace channels first, then the glowing conductor on top
  for (let t = 0; t < 14; t++) {
    let x = Math.floor(r() * (S / grid)) * grid;
    let y = Math.floor(r() * (S / grid)) * grid;
    const pts: Array<[number, number]> = [[x, y]];
    const steps = 3 + Math.floor(r() * 5);
    for (let s = 0; s < steps; s++) {
      const horiz = s % 2 === 0;
      const d = (1 + Math.floor(r() * 3)) * grid * (r() < 0.5 ? -1 : 1);
      if (horiz) x += d; else y += d;
      pts.push([x, y]);
    }
    tiled(g, S, () => {
      g.save();
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.lineWidth = 9;
      g.strokeStyle = css(shade(plate, -0.55), 0.85);
      g.stroke();
      g.restore();
    });
    trace(pts, 3.5, 0.95);

    // solder pads at both ends
    for (const p of [pts[0], pts[pts.length - 1]]) {
      tiled(g, S, () => {
        g.save();
        g.shadowColor = css(glow, 0.9);
        g.shadowBlur = 12;
        g.beginPath();
        g.arc(p[0], p[1], 6, 0, TAU);
        g.fillStyle = css(mixHex(glow, 0xffffff, 0.5));
        g.fill();
        g.restore();
        g.beginPath();
        g.arc(p[0], p[1], 9.5, 0, TAU);
        g.lineWidth = 2;
        g.strokeStyle = css(shade(plate, 0.35), 0.7);
        g.stroke();
      });
    }
  }

  // a couple of chips / connectors for scale
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(r() * 14) * grid;
    const y = Math.floor(r() * 14) * grid;
    const w = grid * (1 + Math.floor(r() * 2));
    const h = grid;
    tiled(g, S, () => {
      bevelPanel(g, x, y, w, h, 6, shade(plate, 0.1));
      g.fillStyle = css(glow, 0.55);
      for (let k = 0; k < 4; k++) g.fillRect(x + 5 + k * (w - 10) / 3.4, y + h - 5, 4, 4);
    });
  }
  return c;
}

/** Subtle emissive tech grid — energy barriers, portal discs, HUD-ish surfaces. */
function buildGridGlow(): HTMLCanvasElement {
  const S = 256;
  const { c, g } = layer(S);
  g.fillStyle = css(shade(PAL.hazardDark, -0.35));
  g.fillRect(0, 0, S, S);

  const step = S / 8;
  g.save();
  g.shadowColor = css(PAL.energy, 0.8);
  g.shadowBlur = 6;
  for (let i = 0; i <= 8; i++) {
    const p = i * step;
    g.strokeStyle = css(PAL.energy, i % 2 === 0 ? 0.5 : 0.24);
    g.lineWidth = i % 2 === 0 ? 2.4 : 1.2;
    g.beginPath();
    g.moveTo(p, 0); g.lineTo(p, S);
    g.moveTo(0, p); g.lineTo(S, p);
    g.stroke();
  }
  g.restore();

  // brighter nodes at the major intersections
  for (let i = 0; i <= 8; i += 2) {
    for (let j = 0; j <= 8; j += 2) {
      const x = i * step, y = j * step;
      const grd = g.createRadialGradient(x, y, 0, x, y, step * 0.5);
      grd.addColorStop(0, css(mixHex(PAL.energy, 0xffffff, 0.6), 0.9));
      grd.addColorStop(1, css(PAL.energy, 0));
      g.beginPath();
      g.arc(x, y, step * 0.5, 0, TAU);
      g.fillStyle = grd;
      g.fill();
    }
  }
  softNoise(g, S, 32, 12, 0.2, 'overlay');
  return c;
}

/** Warm cartoon planks with grain, knots and end bolts. */
function buildWoodPlank(): HTMLCanvasElement {
  const S = 512;
  const { c, g } = layer(S);
  const r = rng(66);
  const planks = 4;
  const ph = S / planks;

  g.fillStyle = css(shade(PAL.woodDark, -0.4));
  g.fillRect(0, 0, S, S);

  for (let p = 0; p < planks; p++) {
    const y = p * ph;
    const tone = mixHex(PAL.woodLight, PAL.woodDark, 0.18 + r() * 0.45);
    const grd = g.createLinearGradient(0, y + 3, 0, y + ph - 3);
    grd.addColorStop(0, css(shade(tone, 0.2)));
    grd.addColorStop(0.45, css(tone));
    grd.addColorStop(1, css(shade(tone, -0.22)));
    roundRectPath(g, 2, y + 3, S - 4, ph - 6, 7);
    g.fillStyle = grd;
    g.fill();

    // grain
    g.save();
    roundRectPath(g, 2, y + 3, S - 4, ph - 6, 7);
    g.clip();
    for (let i = 0; i < 14; i++) {
      const gy = y + 6 + r() * (ph - 12);
      const amp = 1.5 + r() * 4;
      g.beginPath();
      g.moveTo(0, gy);
      for (let x = 0; x <= S; x += 16) {
        g.lineTo(x, gy + Math.sin((x / S) * TAU * (1 + Math.floor(r() * 2)) + i) * amp);
      }
      g.lineWidth = 0.8 + r() * 2;
      g.strokeStyle = r() < 0.6 ? css(shade(tone, -0.35), 0.35) : css(shade(tone, 0.35), 0.28);
      g.stroke();
    }
    // knot
    if (r() < 0.7) {
      const kx = 40 + r() * (S - 80);
      const ky = y + ph * 0.5;
      for (let k = 4; k > 0; k--) {
        g.beginPath();
        g.ellipse(kx, ky, k * 3.4, k * 2.2, 0.4, 0, TAU);
        g.strokeStyle = css(shade(tone, -0.4), 0.4);
        g.lineWidth = 1.6;
        g.stroke();
      }
    }
    g.restore();

    // lit top lip + shadowed gap
    g.beginPath();
    g.moveTo(4, y + 4.5); g.lineTo(S - 4, y + 4.5);
    g.strokeStyle = css(0xffffff, 0.22);
    g.lineWidth = 2;
    g.stroke();

    for (const bx of [26, S - 26]) rivet(g, bx, y + ph * 0.5, 7, mixHex(PAL.metalMid, PAL.woodDark, 0.25));
  }

  softNoise(g, S, 50, 13, 0.24, 'overlay');
  softNoise(g, S, 8, 14, 0.2, 'soft-light');
  return c;
}

// ---------------------------------------------------------------------------
// sprites
// ---------------------------------------------------------------------------

/** Lumpy alpha puff — the base shape for clouds and smoke. */
function puff(
  S: number, seed: number, lobes: number, spread: number, softness: number, tint: number,
): Layer {
  const l = layer(S);
  const { g } = l;
  const r = rng(seed);
  const cx = S * 0.5, cy = S * 0.5;
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + r() * 0.5;
    const dist = i === 0 ? 0 : (0.1 + r() * spread) * S * 0.5;
    const x = cx + Math.cos(a) * dist;
    const y = cy + Math.sin(a) * dist * 0.72;
    const rad = S * (0.16 + r() * 0.16);
    const grd = g.createRadialGradient(x, y, rad * softness, x, y, rad);
    grd.addColorStop(0, css(tint, 0.95));
    grd.addColorStop(0.55, css(tint, 0.6));
    grd.addColorStop(1, css(tint, 0));
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fillStyle = grd;
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  return l;
}

/** Soft billboard cloud: lumpy silhouette, warm top, cool underside. */
function buildCloudSprite(): HTMLCanvasElement {
  const S = 256;
  const { c, g } = layer(S);
  const base = puff(S, 314, 9, 0.62, 0.35, 0xffffff);
  g.drawImage(base.c, 0, 0);

  // break the silhouette so it never reads as a blurred circle
  const r = rng(315);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) {
    const a = r() * TAU;
    const d = S * (0.3 + r() * 0.22);
    const x = S * 0.5 + Math.cos(a) * d;
    const y = S * 0.5 + Math.sin(a) * d * 0.8;
    const rad = S * (0.1 + r() * 0.14);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(0,0,0,0.9)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fillStyle = grd;
    g.fill();
  }

  // shade the underside a touch of sky blue
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, S * 0.32, 0, S);
  sh.addColorStop(0, css(0xffffff, 0));
  sh.addColorStop(1, css(0xbcd6f2, 0.55));
  g.fillStyle = sh;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** Irregular grey-white smoke puff. */
function buildSmokeSprite(): HTMLCanvasElement {
  const S = 128;
  const { c, g } = layer(S);
  g.drawImage(puff(S, 909, 7, 0.5, 0.05, 0xffffff).c, 0, 0);

  const r = rng(910);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 12; i++) {
    const x = r() * S, y = r() * S;
    const rad = S * (0.05 + r() * 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(0,0,0,${0.25 + r() * 0.4})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fillStyle = grd;
    g.fill();
  }
  // fade the rim so it never shows a hard edge
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(0.75, 'rgba(0,0,0,0.85)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** White-core radial glow for additive particles and lights. */
function buildGlowSprite(): HTMLCanvasElement {
  const S = 128;
  const { c, g } = layer(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.92)');
  grd.addColorStop(0.28, 'rgba(255,255,255,0.5)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.05)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return c;
}

/** Four-point star spark for impacts and bolt pickups. */
function buildSparkSprite(): HTMLCanvasElement {
  const S = 128;
  const { c, g } = layer(S);
  const cx = S / 2, cy = S / 2;
  g.globalCompositeOperation = 'lighter';

  const star = (len: number, wide: number, rot: number, alpha: number): void => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    for (let i = 0; i < 4; i++) {
      g.rotate(Math.PI / 2);
      const grd = g.createLinearGradient(0, 0, len, 0);
      grd.addColorStop(0, `rgba(255,255,255,${alpha})`);
      grd.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.45})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(len * 0.35, -wide);
      g.lineTo(len, 0);
      g.lineTo(len * 0.35, wide);
      g.closePath();
      g.fillStyle = grd;
      g.fill();
    }
    g.restore();
  };

  star(S * 0.48, S * 0.055, 0, 1);
  star(S * 0.26, S * 0.035, Math.PI / 4, 0.7);

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.14);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.beginPath();
  g.arc(cx, cy, S * 0.14, 0, TAU);
  g.fillStyle = core;
  g.fill();
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** Soft additive ring — shockwaves, telegraph circles, portal halo. */
function buildRingSprite(): HTMLCanvasElement {
  const S = 256;
  const { c, g } = layer(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.46, 'rgba(255,255,255,0.03)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.28)');
  grd.addColorStop(0.76, 'rgba(255,255,255,1)');
  grd.addColorStop(0.86, 'rgba(255,255,255,0.34)');
  grd.addColorStop(0.95, 'rgba(255,255,255,0.06)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return c;
}

/** Soft dark blob used for the cheap fake contact shadows under every actor. */
function buildShadowBlob(): HTMLCanvasElement {
  const S = 128;
  const { c, g } = layer(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.0, css(0x121629, 0.62));
  grd.addColorStop(0.42, css(0x121629, 0.45));
  grd.addColorStop(0.72, css(0x121629, 0.16));
  grd.addColorStop(1.0, css(0x121629, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return c;
}

/** Small tileable grayscale value noise for detail / shader use. */
function buildNoise(): HTMLCanvasElement {
  const S = 128;
  const { c, g } = layer(S);
  const cells = 16;
  const r = rng(4242);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = r();

  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const sample = (u: number, v: number, freq: number): number => {
    const x = u * freq, y = v * freq;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const xa = ((x0 % cells) + cells) % cells, xb = (xa + 1) % cells;
    const ya = ((y0 % cells) + cells) % cells, yb = (ya + 1) % cells;
    const v00 = lattice[ya * cells + xa], v10 = lattice[ya * cells + xb];
    const v01 = lattice[yb * cells + xa], v11 = lattice[yb * cells + xb];
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };

  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let n = sample(u, v, 4) * 0.55 + sample(u, v, 8) * 0.3 + sample(u, v, 16) * 0.15;
      n = Math.max(0, Math.min(1, n));
      const i = (y * S + x) * 4;
      const b = Math.round(n * 255);
      img.data[i] = b; img.data[i + 1] = b; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// toon gradient ramps (1 x N)
// ---------------------------------------------------------------------------

function buildRamp(steps: number[]): HTMLCanvasElement {
  const { c, g } = layer(steps.length, 1);
  for (let i = 0; i < steps.length; i++) {
    const v = Math.round(Math.max(0, Math.min(1, steps[i])) * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(i, 0, 1, 1);
  }
  return c;
}

function buildSoftRamp(): HTMLCanvasElement {
  const N = 64;
  const { c, g } = layer(N, 1);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // flat shadow, quick soft terminator, flat lit side — stylized but smooth
    const k = t < 0.34 ? 0 : t > 0.68 ? 1 : (t - 0.34) / 0.34;
    const s = k * k * (3 - 2 * k);
    const v = Math.round((0.42 + 0.58 * s) * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(i, 0, 1, 1);
  }
  return c;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

const SPRITE_KEYS: ReadonlySet<string> = new Set([
  'cloudSprite', 'glowSprite', 'sparkSprite', 'ringSprite', 'smokeSprite', 'shadowBlob',
]);
const RAMP_KEYS: ReadonlySet<string> = new Set(['toonRamp3', 'toonRamp4', 'toonRampSoft']);

function build(key: TextureKey): HTMLCanvasElement {
  switch (key) {
    case 'metalPanel': return buildMetalPanel();
    case 'metalPlate': return buildMetalPlate();
    case 'rustPanel': return buildRustPanel();
    case 'hazardStripe': return buildHazardStripe();
    case 'grassTop': return buildGrassTop();
    case 'rockSide': return buildRockSide();
    case 'circuit': return buildCircuit();
    case 'gridGlow': return buildGridGlow();
    case 'woodPlank': return buildWoodPlank();
    case 'cloudSprite': return buildCloudSprite();
    case 'glowSprite': return buildGlowSprite();
    case 'sparkSprite': return buildSparkSprite();
    case 'ringSprite': return buildRingSprite();
    case 'smokeSprite': return buildSmokeSprite();
    case 'shadowBlob': return buildShadowBlob();
    case 'noise': return buildNoise();
    case 'toonRamp3': return buildRamp([0.42, 0.74, 1.0]);
    case 'toonRamp4': return buildRamp([0.34, 0.6, 0.83, 1.0]);
    case 'toonRampSoft': return buildSoftRamp();
  }
}

/**
 * Returns the (cached) texture for `key`, generating it on first use.
 * Never dispose the returned texture directly — use `disposeTextures()`.
 */
export function getTexture(key: TextureKey): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;

  const tex = new THREE.CanvasTexture(build(key));
  tex.name = key;

  if (RAMP_KEYS.has(key)) {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    const hard = key !== 'toonRampSoft';
    tex.minFilter = hard ? THREE.NearestFilter : THREE.LinearFilter;
    tex.magFilter = hard ? THREE.NearestFilter : THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
  } else if (SPRITE_KEYS.has(key)) {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = ANISOTROPY;
    tex.colorSpace = THREE.SRGBColorSpace;
  } else if (key === 'noise') {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
  } else {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = ANISOTROPY;
    tex.colorSpace = THREE.SRGBColorSpace;
  }

  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/**
 * A cached clone of a tiling texture with `repeat` baked in. Clones share the
 * same GPU upload as the original, so this is cheap — use it instead of mutating
 * `getTexture(...)`.repeat, which would affect every other user of that map.
 */
export function getTextureTiled(key: TextureKey, repeatX: number, repeatY = repeatX): THREE.Texture {
  const rx = Math.round(repeatX * 100) / 100;
  const ry = Math.round(repeatY * 100) / 100;
  const id = `${key}|${rx}|${ry}`;
  const hit = tiledCache.get(id);
  if (hit) return hit;

  const src = getTexture(key);
  const tex = src.clone();
  tex.name = id;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry);
  tex.needsUpdate = true;
  tiledCache.set(id, tex);
  return tex;
}

/** Frees every generated texture. Safe to call more than once. */
export function disposeTextures(): void {
  for (const t of tiledCache.values()) t.dispose();
  tiledCache.clear();
  for (const t of cache.values()) {
    const img = t.image as HTMLCanvasElement | undefined;
    if (img && typeof img === 'object' && 'width' in img) {
      img.width = 1;
      img.height = 1;
    }
    t.dispose();
  }
  cache.clear();
}
