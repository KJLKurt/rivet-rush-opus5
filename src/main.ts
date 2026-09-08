import './style.css';
import { Game } from './game/Game';
import { UI } from './ui/UI';
import { audio } from './core/Audio';
import { input } from './core/Input';
import { save } from './core/Save';
import { PlaytestBot } from './game/Bot';

/**
 * Boot, main loop and browser lifecycle.
 *
 * The loop is a plain rAF with a clamped delta. Simulation and rendering run
 * at the display's rate rather than a fixed step: the game is forgiving enough
 * that variable-step integration is imperceptible, and matching the refresh
 * rate is what makes a 120Hz phone feel as good as it should.
 */

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootStatus = document.getElementById('boot-status') as HTMLElement;

function progress(pct: number, message?: string): void {
  bootFill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
  if (message) bootStatus.textContent = message;
}

async function main(): Promise<void> {
  progress(8, 'Loading your workshop…');

  // Settings first: quality and volumes must be right before anything is built.
  save.loadMirror();
  void save.load();

  progress(20, 'Building the sky…');
  await nextFrame();

  let game: Game;
  try {
    game = new Game(canvas, {
      onState: (s) => ui.onState(s),
      onHud: (h) => ui.onHud(h),
      onPopup: (text, world, kind) => ui.popup(text, world, kind),
      onToast: (text, iconName, ms) => ui.toast(text, iconName, ms),
      onStageCard: (stage, isNewArea) => ui.stageCardShow(stage, isNewArea),
      onUpgradeOffer: (choices, taken) => ui.showUpgrades(choices, taken),
      onResults: (r) => ui.showResults(r),
      onFlash: (color, ms) => ui.flash(color, ms),
      onHaptic: (p) => ui.haptic(p),
      onHint: (id, text) => ui.hint(id, text),
    });
  } catch (err) {
    showFatal(err);
    return;
  }

  const ui = new UI(uiRoot, game);
  ui.applyBodyClasses();

  progress(48, 'Charging the hoverboard…');
  await nextFrame();

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 220));
  // visualViewport catches the iOS URL-bar collapse, which `resize` misses.
  window.visualViewport?.addEventListener('resize', resize);

  input.attach(canvas);
  // Also let taps on the interface unlock audio, since the title screen's
  // buttons sit above the canvas.
  const unlock = (): void => {
    void audio.unlock().then(() => {
      if (game.state === 'title') audio.playMusic('menu', 1.4);
    });
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  progress(72, 'Waking the Sparkies…');
  await nextFrame();

  await game.init();

  progress(94, 'Ready!');
  await nextFrame();

  const bot = new PlaytestBot(game);
  exposeDevHooks(game, bot);

  // --- lifecycle ---------------------------------------------------------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      audio.suspend();
      game.pause();
      save.flush();
    } else {
      audio.resume();
      last = performance.now();
    }
  });
  window.addEventListener('pagehide', () => save.flush());
  window.addEventListener('blur', () => game.pause());

  // --- main loop ---------------------------------------------------------
  let last = performance.now();
  let acc = 0;
  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (dt <= 0) return;

    // Throttle to ~30fps while hidden so a backgrounded tab costs nothing.
    if (document.hidden) {
      acc += dt;
      if (acc < 0.033) return;
      acc = 0;
    }

    bot.update(dt);
    game.update(dt);
    game.render(dt);
    ui.updateLabels(dt, game.renderer.camera);
  };
  requestAnimationFrame(loop);

  // --- reveal ------------------------------------------------------------
  progress(100);
  await wait(220);
  boot.classList.add('hidden');
  setTimeout(() => boot.remove(), 700);
  ui.showRotateHint();

  function resize(): void {
    const w = window.visualViewport?.width ?? window.innerWidth;
    const h = window.visualViewport?.height ?? window.innerHeight;
    game.resize(w, h);
    ui.onResize();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function showFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  bootStatus.innerHTML =
    `Sorry — this device could not start the 3D view.<br><span style="opacity:.7;font-size:11px">${
      message.replace(/[<>]/g, '')
    }</span>`;
  bootFill.style.background = '#ff4d6d';
  // eslint-disable-next-line no-console
  console.error('[RivetRush] fatal', err);
}

/**
 * A tiny developer surface, deliberately not reachable from the interface.
 * It exists so the game can be driven by an automated playtest from the
 * console or from Playwright without ever showing a debug button to a player.
 */
function exposeDevHooks(game: Game, bot: PlaytestBot): void {
  (window as unknown as Record<string, unknown>).__rivetAudio = audio;
  (window as unknown as Record<string, unknown>).__rivet = {
    game,
    bot,
    play: (daily = false) => game.startRun(daily),
    autoplay: (on = true) => bot.setEnabled(on),
    skipTo: (stageIndex: number) => bot.skipTo(stageIndex),
    state: () => game.state,
    /** Spawns one enemy of any kind — used by the model line-up check. */
    spawnEnemy: (kind: string, x: number, z: number) =>
      game.enemiesRef.spawn(kind as never, x, z),
    freezeCamera: (x: number, y: number, z: number, lx = 0, lz = 0) => {
      const g = game as unknown as { render: (dt: number) => void; __orig?: (dt: number) => void };
      g.__orig ??= g.render.bind(game);
      g.render = (dt: number) => {
        const c = game.renderer.camera;
        c.position.set(x, y, z);
        c.lookAt(lx, 1, lz);
        c.updateMatrixWorld();
        g.__orig!(dt);
      };
    },
    profile: () => save.profile,
  };
}

// --- service worker -------------------------------------------------------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void import('virtual:pwa-register')
      .then(({ registerSW }) => {
        registerSW({
          immediate: true,
          onRegisteredSW(_url, registration) {
            // Check for a new build once an hour while the tab stays open.
            if (registration) setInterval(() => void registration.update(), 3_600_000);
          },
          onOfflineReady() {
            // Nothing loud — the game simply works offline from now on.
            // eslint-disable-next-line no-console
            console.info('[RivetRush] ready to play offline');
          },
        });
      })
      .catch(() => {
        /* PWA registration is a bonus; never let it break the game */
      });
  });
}

void main();
