/**
 * Captures the two screenshots referenced by the web app manifest from real
 * gameplay (never mock-ups), at the exact sizes the manifest declares.
 *
 * Run after `npm run build`:  node scripts/capture-screenshots.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public', 'icons');
const PORT = 4330;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('Local:') && res()));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

for (const [name, w, h, stage] of [
  ['screenshot-wide', 1280, 720, 2],
  ['screenshot-narrow', 720, 1280, 0],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.addStyleTag({ content: '*,*::before,*::after{transition-duration:0.001s !important}' });
  await page.waitForFunction(() => window.__rivet?.state() === 'title', null, { timeout: 30000 });
  await page.evaluate((s) => {
    window.__rivet.skipTo(s);
    window.__rivet.autoplay(true);
  }, stage);
  // Let the bot build a combo so the shot shows the game actually being played.
  await sleep(stage === 0 ? 9000 : 14000);
  await page.evaluate(() => window.__rivet.autoplay(false));
  await sleep(120);
  await page.screenshot({ path: resolve(OUT, `${name}.png`) });
  console.log(`  icons/${name}.png  ${w}×${h}`);
  await page.close();
}

await browser.close();
server.kill();
