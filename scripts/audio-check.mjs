/**
 * Verifies the synthesized audio actually produces sound.
 *
 * Splices an AnalyserNode in front of the AudioContext destination before the
 * game loads, then triggers every sound effect and every music track and
 * measures peak RMS. A silent or broken voice shows up as a flat zero.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('Local:') && res()));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

// Tap the analyser in before any game code runs.
await page.addInitScript(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest && dest instanceof AudioDestinationNode && !window.__an) {
      const an = this.context.createAnalyser();
      an.fftSize = 2048;
      orig.call(an, dest);
      window.__an = an;
      window.__buf = new Float32Array(an.fftSize);
      return orig.call(this, an, ...rest);
    }
    return orig.call(this, dest, ...rest);
  };
  window.__rms = () => {
    if (!window.__an) return -1;
    window.__an.getFloatTimeDomainData(window.__buf);
    let s = 0;
    for (const v of window.__buf) s += v * v;
    return Math.sqrt(s / window.__buf.length);
  };
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rivet, null, { timeout: 40000 });
await page.mouse.click(450, 300);            // real gesture, then explicit unlock
await page.evaluate(async () => {
  const { audio } = await import('/assets/' + [...document.querySelectorAll('script[type=module]')]
    .map((s) => s.src).join(''));
}).catch(() => {});
await page.evaluate(() => window.__rivet.game && void 0);
await sleep(600);

const ctxState = await page.evaluate(() => window.__an ? window.__an.context.state : 'no-analyser');
console.log(`AudioContext: ${ctxState}   analyser tapped: ${ctxState !== 'no-analyser'}`);
if (ctxState === 'no-analyser') { await browser.close(); server.kill(); process.exit(1); }

/** Peak RMS observed over `ms` while running `fn`. */
async function peak(fn, ms) {
  await page.evaluate(fn);
  let best = 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    best = Math.max(best, await page.evaluate(() => window.__rms()));
    await sleep(16);
  }
  return best;
}

const SFX = ['uiMove','uiConfirm','uiBack','uiUnlock','uiToggle','bolt','cell','sparkieRescue',
  'sparkieChirp','heart','crateSmash','dash','dashFail','dashRecharge','boostPad','zap','zapChain',
  'enemyHit','enemyDefeat','enemyAttack','enemyTelegraph','playerHurt','shieldGain','shieldBreak',
  'comboUp','comboBreak','overdriveReady','overdriveStart','overdriveEnd','upgradeShow','upgradePick',
  'portalOpen','portalEnter','bossIntro','bossSlam','bossHurt','bossPhase','bossDefeat','victory',
  'gameOver','countdown','countdownGo','tallyTick','tallyDone','star'];

console.log('\n--- sound effects (peak RMS) ---');
const silent = [];
for (const name of SFX) {
  const r = await peak(`() => window.__rivetAudio.play(${JSON.stringify(name)}, { gain: 1 })`, 420);
  if (r < 0.0015) silent.push(name);
  process.stdout.write(`${name}:${r.toFixed(4)}  `);
}
console.log();

console.log('\n--- music tracks (peak RMS over 4s) ---');
const quietTracks = [];
for (const t of ['menu','area1','area2','area3','boss','victory']) {
  await page.evaluate((tr) => {
    window.__rivetAudio.setMusicIntensity(1);
    window.__rivetAudio.playMusic(tr, 0.05);
  }, t);
  let best = 0;
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    best = Math.max(best, await page.evaluate(() => window.__rms()));
    await sleep(16);
  }
  console.log(`  ${t.padEnd(8)} peak RMS ${best.toFixed(4)} ${best < 0.002 ? '  <-- SILENT' : ''}`);
  if (best < 0.002) quietTracks.push(t);
}
await page.evaluate(() => window.__rivetAudio.stopMusic(0.2));

console.log('\n──────── audio report ────────');
console.log(`sound effects tested: ${SFX.length}`);
console.log(silent.length ? `SILENT effects (${silent.length}): ${silent.join(', ')}` : 'all effects produced audible output');
console.log(quietTracks.length ? `SILENT tracks: ${quietTracks.join(', ')}` : 'all six music tracks produced audible output');

await browser.close();
server.kill();
process.exit(silent.length || quietTracks.length ? 1 : 0);
