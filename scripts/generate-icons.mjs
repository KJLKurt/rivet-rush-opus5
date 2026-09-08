/**
 * Generates every PWA icon from code — no image files are checked in and no
 * art is downloaded. The artwork is Rivet's face: ears, bandit mask, big eyes
 * and his welding goggles pushed up on his forehead. It's drawn with plain
 * canvas primitives so it stays crisp at 48px and at 512px.
 *
 * Run: `node scripts/generate-icons.mjs` (also runs automatically on build).
 */

import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const PAL = {
  bgTop: '#3b4bb0',
  bgBot: '#141a4a',
  furLight: '#c3cde6',
  furMid: '#8b97ba',
  furDark: '#5b6588',
  mask: '#242a45',
  muzzle: '#f6efe0',
  nose: '#2e2a42',
  ear: '#ff8a6b',
  gold: '#ffbe3c',
  goldDeep: '#f08b23',
  cyan: '#53f2ff',
  white: '#ffffff',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipse(ctx, cx, cy, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
  ctx.closePath();
}

/**
 * @param size      pixel dimensions
 * @param maskable  true = keep all art inside the 80% safe circle and fill the
 *                  full bleed with background, per the maskable icon spec
 */
function drawIcon(size, maskable) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const S = size;

  // --- background ---------------------------------------------------------
  const grad = ctx.createLinearGradient(0, 0, S * 0.3, S);
  grad.addColorStop(0, PAL.bgTop);
  grad.addColorStop(1, PAL.bgBot);
  ctx.fillStyle = grad;
  if (maskable) {
    ctx.fillRect(0, 0, S, S);
  } else {
    roundRect(ctx, 0, 0, S, S, S * 0.22);
    ctx.fill();
  }

  // Soft light bloom behind the character.
  const glow = ctx.createRadialGradient(S * 0.5, S * 0.46, 0, S * 0.5, S * 0.46, S * 0.5);
  glow.addColorStop(0, 'rgba(120,180,255,0.42)');
  glow.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);

  // Three sky-streak accents in the corners — echoes the hoverboard trail.
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = PAL.cyan;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = S * (0.018 - i * 0.004);
    ctx.beginPath();
    const y = S * (0.16 + i * 0.07);
    ctx.moveTo(S * 0.06, y);
    ctx.lineTo(S * (0.3 - i * 0.05), y);
    ctx.stroke();
  }
  ctx.restore();

  // The whole face is drawn in a normalised space then scaled, so the maskable
  // variant is just a smaller scale factor.
  ctx.save();
  // Content spans roughly x ∈ [-128, 128], y ∈ [-150, 95] in these units, so
  // the scale factors below keep the ears and goggles clear of the edge, and
  // keep the maskable variant inside the 80% safe circle.
  ctx.translate(S * 0.5, S * 0.545);
  const k = S * (maskable ? 0.0020 : 0.0027);
  ctx.scale(k, k);

  // --- ears ---------------------------------------------------------------
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * 86, -92);
    ctx.rotate(sx * 0.28);
    ctx.fillStyle = PAL.furMid;
    ellipse(ctx, 0, 0, 42, 50);
    ctx.fill();
    ctx.fillStyle = PAL.ear;
    ellipse(ctx, 0, 6, 22, 27);
    ctx.fill();
    ctx.restore();
  }

  // --- head ---------------------------------------------------------------
  ctx.fillStyle = PAL.furMid;
  roundRect(ctx, -118, -108, 236, 212, 82);
  ctx.fill();
  // Lighter cheek highlight, so the head isn't a flat blob.
  ctx.fillStyle = PAL.furLight;
  ellipse(ctx, 0, 34, 92, 62);
  ctx.fill();

  // --- bandit mask --------------------------------------------------------
  ctx.fillStyle = PAL.mask;
  roundRect(ctx, -112, -46, 224, 76, 34);
  ctx.fill();
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * 78, 6);
    ctx.rotate(sx * 0.16);
    roundRect(ctx, -26, -50, 52, 104, 24);
    ctx.fill();
    ctx.restore();
  }

  // --- eyes ---------------------------------------------------------------
  for (const sx of [-1, 1]) {
    ctx.fillStyle = PAL.white;
    ellipse(ctx, sx * 52, -8, 32, 36);
    ctx.fill();
    ctx.fillStyle = PAL.nose;
    ellipse(ctx, sx * 56, -4, 17, 21);
    ctx.fill();
    ctx.fillStyle = PAL.white;
    ellipse(ctx, sx * 62, -14, 7, 8);
    ctx.fill();
  }

  // --- muzzle + nose ------------------------------------------------------
  ctx.fillStyle = PAL.muzzle;
  roundRect(ctx, -46, 34, 92, 60, 30);
  ctx.fill();
  ctx.fillStyle = PAL.nose;
  roundRect(ctx, -19, 40, 38, 26, 13);
  ctx.fill();
  ctx.strokeStyle = PAL.nose;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 66);
  ctx.lineTo(0, 80);
  ctx.moveTo(0, 80);
  ctx.quadraticCurveTo(-16, 90, -26, 78);
  ctx.moveTo(0, 80);
  ctx.quadraticCurveTo(16, 90, 26, 78);
  ctx.stroke();

  // --- goggles on the forehead -------------------------------------------
  ctx.save();
  ctx.translate(0, -104);
  ctx.strokeStyle = PAL.mask;
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.moveTo(-116, 14);
  ctx.quadraticCurveTo(0, -34, 116, 14);
  ctx.stroke();
  for (const sx of [-1, 1]) {
    ctx.fillStyle = PAL.gold;
    ellipse(ctx, sx * 52, -2, 38, 34);
    ctx.fill();
    ctx.fillStyle = PAL.cyan;
    ellipse(ctx, sx * 52, -2, 24, 21);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ellipse(ctx, sx * 52 - 8, -9, 9, 7, -0.5);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();

  // --- gold bolt badge ----------------------------------------------------
  // Sits bottom-right on the standard icon; omitted on maskable so nothing
  // important can be clipped by an aggressive platform mask.
  if (!maskable) {
    ctx.save();
    ctx.translate(S * 0.775, S * 0.78);
    const b = S * 0.145;
    const badge = ctx.createLinearGradient(-b, -b, b, b);
    badge.addColorStop(0, PAL.gold);
    badge.addColorStop(1, PAL.goldDeep);
    ctx.fillStyle = badge;
    ctx.beginPath();
    ctx.arc(0, 0, b, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PAL.bgBot;
    ctx.beginPath();
    const p = [[0.16, -0.72], [-0.42, 0.1], [-0.06, 0.1], [-0.26, 0.72], [0.44, -0.16], [0.04, -0.16]];
    ctx.moveTo(p[0][0] * b, p[0][1] * b);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * b, p[i][1] * b);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  return canvas;
}

function save(name, canvas) {
  writeFileSync(resolve(OUT, name), canvas.toBuffer('image/png'));
  console.log(`  icons/${name}  ${canvas.width}×${canvas.height}`);
}

console.log('Generating app icons…');
save('icon-192.png', drawIcon(192, false));
save('icon-512.png', drawIcon(512, false));
save('maskable-192.png', drawIcon(192, true));
save('maskable-512.png', drawIcon(512, true));
save('apple-touch-icon.png', drawIcon(180, false));
save('icon-32.png', drawIcon(32, false));

// A tiny SVG favicon: the bolt mark alone, which is all that's legible at 16px.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b4bb0"/><stop offset="1" stop-color="#141a4a"/>
    </linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd447"/><stop offset="1" stop-color="#f08b23"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#b)"/>
  <path d="M36.5 6 16 33.5h13L27 58l21-28H34.5z" fill="url(#g)"/>
</svg>
`;
writeFileSync(resolve(OUT, 'favicon.svg'), favicon, 'utf8');
console.log('  icons/favicon.svg');
console.log('Done.');
