/**
 * Automated playtest harness.
 *
 * Boots the production build in headless Chromium (with WebGL via SwiftShader),
 * drives a full run using the in-game bot, captures screenshots at key moments,
 * and fails loudly on any console error, page error or failed request.
 *
 * Usage:
 *   node scripts/playtest.mjs                 full run, desktop viewport
 *   node scripts/playtest.mjs --shots         also write screenshots
 *   node scripts/playtest.mjs --device=phone  landscape phone viewport
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SHOTS = resolve(ROOT, 'playtest-shots');

const args = process.argv.slice(2);
const wantShots = args.includes('--shots');
const deviceArg = (args.find((a) => a.startsWith('--device=')) ?? '').split('=')[1] ?? 'desktop';
const runSeconds = Number((args.find((a) => a.startsWith('--seconds=')) ?? '').split('=')[1] ?? 240);

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, isMobile: false },
  phone: { width: 844, height: 390, isMobile: true },
  portrait: { width: 390, height: 844, isMobile: true },
  tablet: { width: 1180, height: 820, isMobile: true },
};

const PORT = 4319;

function startServer() {
  const proc = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('preview server did not start')), 25000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Local:')) {
        clearTimeout(timer);
        res(proc);
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`preview exited with ${code}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (wantShots) mkdirSync(SHOTS, { recursive: true });
  console.log(`▶ starting preview server on :${PORT}`);
  const server = await startServer();

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const vp = VIEWPORTS[deviceArg] ?? VIEWPORTS.desktop;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    hasTouch: vp.isMobile,
    isMobile: false,
  });
  const page = await context.newPage();

  const errors = [];
  const warnings = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warnings.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`));
  page.on('requestfailed', (req) => {
    const f = req.failure();
    if (f && !f.errorText.includes('ERR_ABORTED')) {
      errors.push(`requestfailed: ${req.url()} — ${f.errorText}`);
    }
  });

  const shot = async (name) => {
    if (!wantShots) return;
    await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
    console.log(`  📷 ${name}.png`);
  };

  console.log('▶ loading game…');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 45000 });

  // Headless Chromium stalls CSS *transitions* in a page it never composites,
  // which leaves screenshots showing half-faded UI. Keyframe animations are
  // left alone so entrances and pops still get exercised.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition-duration:0.001s !important;transition-delay:0s !important}',
  });
  await page.waitForFunction(() => Boolean(window.__rivet), null, { timeout: 45000 });
  await page.waitForFunction(() => window.__rivet.state() === 'title', null, { timeout: 45000 });
  console.log('  ✓ reached title screen');
  await sleep(1200);
  await shot('01-title');

  // WebGL sanity: make sure we're really rendering, not showing a black canvas.
  const glInfo = await page.evaluate(() => {
    const c = document.getElementById('game');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? { ok: true, renderer: gl.getParameter(gl.VERSION) } : { ok: false };
  });
  if (!glInfo.ok) throw new Error('no WebGL context');
  console.log(`  ✓ WebGL: ${glInfo.renderer}`);

  // --- settings + collection screens ------------------------------------
  await page.click('[data-act="settings"]');
  await sleep(500);
  await shot('02-settings');
  await page.click('[data-act="close-settings"]');
  await sleep(300);
  await page.click('[data-act="collection"]');
  await sleep(500);
  await shot('03-collection');
  await page.click('[data-tab="awards"]');
  await sleep(400);
  await shot('04-awards');
  await page.click('[data-act="close-collection"]');
  await sleep(300);

  // --- start a run and hand over to the bot ------------------------------
  console.log('▶ starting a run with the playtest bot…');
  await page.evaluate(() => {
    window.__rivet.play(false);
    window.__rivet.autoplay(true);
  });
  await sleep(2600);
  await shot('05-stage1');

  const timeline = [];
  const deadline = Date.now() + runSeconds * 1000;
  let lastStage = -1;
  let sawUpgrade = false;
  let sawBoss = false;
  let finished = false;
  let lastFps = 0;

  while (Date.now() < deadline) {
    await sleep(1000);
    const snap = await page.evaluate(() => {
      const g = window.__rivet.game;
      const r = window.__rivet.game.runRef;
      return {
        state: window.__rivet.state(),
        stage: r.stageIndex,
        score: r.score,
        combo: r.bestCombo,
        sparkies: r.sparkies,
        hits: r.hitsTaken,
        fps: Math.round(g.renderer.fps),
        quality: g.renderer.quality,
        particles: g.fx.liveParticles,
        boss: g.bossRef ? Math.round(g.bossRef.healthFraction * 100) : null,
      };
    });
    lastFps = snap.fps;

    if (snap.stage !== lastStage) {
      lastStage = snap.stage;
      timeline.push({ t: Math.round((runSeconds * 1000 - (deadline - Date.now())) / 1000), ...snap });
      console.log(
        `  stage ${snap.stage} · score ${snap.score} · combo x${snap.combo} · ` +
        `sparkies ${snap.sparkies} · hits ${snap.hits} · ${snap.fps}fps (${snap.quality})`,
      );
      if (snap.stage >= 1 && snap.stage <= 5) await shot(`06-stage${snap.stage + 1}`);
    }
    if (snap.state === 'upgrade' && !sawUpgrade) {
      sawUpgrade = true;
      await shot('07-upgrade');
      console.log('  ✓ upgrade screen reached');
    }
    if (snap.boss !== null && !sawBoss) {
      sawBoss = true;
      await sleep(1500);
      await shot('08-boss');
      console.log('  ✓ boss fight reached');
    }
    if (snap.state === 'results') {
      finished = true;
      await sleep(2200);
      await shot('09-results');
      const final = await page.evaluate(() => {
        const el = document.querySelector('#results-screen .outcome');
        return { outcome: el ? el.textContent : '?', profile: window.__rivet.profile() };
      });
      console.log(`  ✓ run ended: ${final.outcome}`);
      console.log(
        `    best score ${final.profile.bestScore} · best combo ${final.profile.bestCombo} · ` +
        `achievements ${Object.keys(final.profile.achievements).length}`,
      );
      break;
    }
  }

  // --- pause / resume ----------------------------------------------------
  if (!finished) {
    console.log('▶ testing pause / resume…');
    await page.evaluate(() => window.__rivet.autoplay(false));
    await page.evaluate(() => window.__rivet.game.pause());
    await sleep(500);
    const paused = await page.evaluate(() => window.__rivet.state());
    console.log(`  ${paused === 'paused' ? '✓' : '✗'} pause → ${paused}`);
    await shot('10-pause');
    await page.click('[data-act="resume"]');
    await sleep(400);
    const resumed = await page.evaluate(() => window.__rivet.state());
    console.log(`  ${resumed === 'playing' ? '✓' : '✗'} resume → ${resumed}`);
  }

  // --- persistence -------------------------------------------------------
  console.log('▶ testing persistence across reload…');
  const before = await page.evaluate(() => {
    window.__rivet.game.abandon();
    return window.__rivet.profile().runsStarted;
  });
  await sleep(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__rivet), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__rivet.state() === 'title', null, { timeout: 30000 });
  const after = await page.evaluate(() => window.__rivet.profile().runsStarted);
  console.log(`  ${after >= before ? '✓' : '✗'} runsStarted persisted: ${before} → ${after}`);

  // --- camera modes ------------------------------------------------------
  console.log('▶ testing camera modes…');
  for (const cam of ['chase', 'wide', 'follow', 'fpv']) {
    await page.evaluate((c) => {
      const p = window.__rivet.profile();
      p.settings.camera = c;
      window.__rivet.game.applySettings();
      window.__rivet.game.abandon();
    }, cam);
    await sleep(400);
    await page.evaluate(() => {
      window.__rivet.skipTo(1);
      window.__rivet.autoplay(true);
    });
    await page.waitForFunction(() => window.__rivet.state() === 'playing', null, { timeout: 40000 });
    await sleep(6000);
    const info = await page.evaluate(() => {
      const g = window.__rivet.game;
      const pl = g.playerRef;
      const v = pl.model.root.position.clone().project(g.renderer.camera);
      return {
        onScreen: Math.abs(v.x) < 1.1 && v.y > -1.6 && v.y < 1.1 && v.z < 1,
        y: Math.round((-v.y * 0.5 + 0.5) * 100),
        moved: Math.hypot(pl.position.x, pl.position.z) > 0.5,
      };
    });
    // First person deliberately hides the avatar, so only check it is playing.
    const ok = cam === 'fpv' ? info.moved : info.onScreen && info.moved;
    console.log(`  ${ok ? '✓' : '✗'} ${cam.padEnd(7)} player at ${info.y}% screen, moving: ${info.moved}`);
    if (!ok) errors.push(`camera ${cam}: player not framed/moving`);
    await page.evaluate(() => window.__rivet.autoplay(false));
  }
  await page.evaluate(() => {
    const p = window.__rivet.profile();
    p.settings.camera = 'chase';
    window.__rivet.game.applySettings();
    window.__rivet.game.abandon();
  });
  await sleep(500);

  // --- responsive sweep --------------------------------------------------
  console.log('▶ testing viewports…');
  for (const [name, v] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await sleep(700);
    const ok = await page.evaluate(() => {
      const c = document.getElementById('game');
      const noHScroll = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const fills = Math.abs(c.getBoundingClientRect().width - window.innerWidth) < 2;
      return c.width > 0 && c.height > 0 && noHScroll && fills;
    });
    console.log(`  ${ok ? '✓' : '✗'} ${name} ${v.width}×${v.height}`);
    if (wantShots && name !== 'desktop') {
      await page.evaluate(() => {
        window.__rivet.play(false);
        window.__rivet.autoplay(true);
      });
      await sleep(3200);
      await page.screenshot({ path: resolve(SHOTS, `11-viewport-${name}.png`) });
      await page.evaluate(() => {
        window.__rivet.autoplay(false);
        window.__rivet.game.abandon();
      });
      await sleep(400);
    }
  }
  await page.setViewportSize({ width: vp.width, height: vp.height });

  // --- offline -----------------------------------------------------------
  console.log('▶ testing offline (service worker)…');
  await sleep(1500);
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'load', timeout: 20000 });
    await page.waitForFunction(() => Boolean(window.__rivet), null, { timeout: 25000 });
    console.log('  ✓ game loaded with the network offline');
    await shot('12-offline');
  } catch (e) {
    console.log(`  ✗ offline load failed: ${e.message}`);
    errors.push(`offline: ${e.message}`);
  }
  await context.setOffline(false);

  // --- report ------------------------------------------------------------
  console.log('\n──────── report ────────');
  console.log(`fps (last sample): ${lastFps}`);
  console.log(`stages seen: ${timeline.map((t) => t.stage).join(' → ')}`);
  console.log(`upgrade screen: ${sawUpgrade ? 'yes' : 'no'}`);
  console.log(`boss reached:   ${sawBoss ? 'yes' : 'no'}`);
  console.log(`run finished:   ${finished ? 'yes' : 'no'}`);

  const realErrors = errors.filter(
    (e) => !e.includes('favicon') && !e.includes('Download the React'),
  );
  if (realErrors.length) {
    console.log(`\n❌ ${realErrors.length} console/page error(s):`);
    for (const e of realErrors.slice(0, 20)) console.log(`   • ${e.slice(0, 400)}`);
  } else {
    console.log('\n✅ no console or page errors');
  }
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    for (const w of [...new Set(warnings)].slice(0, 10)) console.log(`   • ${w.slice(0, 240)}`);
  }

  writeFileSync(
    resolve(ROOT, 'playtest-report.json'),
    JSON.stringify({ timeline, errors: realErrors, warnings: [...new Set(warnings)], finished, sawBoss }, null, 2),
  );

  await browser.close();
  server.kill();
  process.exit(realErrors.length ? 1 : 0);
}

main().catch((err) => {
  console.error('playtest failed:', err);
  process.exit(1);
});
