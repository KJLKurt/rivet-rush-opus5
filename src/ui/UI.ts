import * as THREE from 'three';
import { icon } from './Icons';
import type { Game, GameState, HudData, ResultsData } from '../game/Game';
import type { DeployableKind } from '../render/models/Deployables';
import type { Upgrade } from '../game/Upgrades';
import type { StageDef } from '../game/Stages';
import { ACHIEVEMENTS, COSMETICS, cosmeticsOfKind, dailyModifiers } from '../game/Progression';
import { save, DEFAULT_SETTINGS } from '../core/Save';
import type { QualityLevel, CameraSetting } from '../core/Save';
import { audio } from '../core/Audio';
import { input } from '../core/Input';
import { formatScore, formatTime, clamp01, hashString, localDateKey } from '../core/Util';

/**
 * The DOM interface layer.
 *
 * Everything the player reads or taps lives here; it never touches gameplay
 * state directly, only the {@link Game} public API. Screens are plain elements
 * toggled with a `.show` class so transitions are pure CSS and cost nothing.
 *
 * Two rules drove the design:
 *  1. Minimal reading. Every control is an icon first and a word second, and no
 *     screen has more than a handful of choices.
 *  2. Nothing important is only a colour. Hearts empty *and* shrink, the dash
 *     button greys *and* loses its pips, the objective chip changes its icon
 *     when complete.
 */

const $ = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

interface PopLabel {
  el: HTMLElement;
  world: THREE.Vector3;
  life: number;
}

export class UI {
  private root: HTMLElement;
  private game: Game;

  // Screens
  private title!: HTMLElement;
  private hud!: HTMLElement;
  private pause!: HTMLElement;
  private upgrade!: HTMLElement;
  private results!: HTMLElement;
  private settings!: HTMLElement;
  private collection!: HTMLElement;
  private stageCard!: HTMLElement;
  private rotate!: HTMLElement;

  // HUD bits
  private scoreEl!: HTMLElement;
  private comboEl!: HTMLElement;
  private comboBar!: HTMLElement;
  private heartsEl!: HTMLElement;
  private objectiveEl!: HTMLElement;
  private bossBar!: HTMLElement;
  private bossFill!: HTMLElement;
  private bossPhaseEl!: HTMLElement;
  private dashBtn!: HTMLElement;
  private dashPips!: HTMLElement;
  private odBtn!: HTMLElement;
  private odMeter!: HTMLElement;
  private stick!: HTMLElement;
  private stickKnob!: HTMLElement;
  private guideEl!: HTMLElement;
  private labels!: HTMLElement;
  private toasts!: HTMLElement;
  private hintEl!: HTMLElement;
  private flashEl!: HTMLElement;
  private fpsEl!: HTMLElement;
  private swarmTop!: HTMLElement;
  private waveChip!: HTMLElement;
  private padFill!: HTMLElement;
  private bankEl!: HTMLElement;
  private itemBar!: HTMLElement;
  private lastBank = -1;
  private lastWave = -1;

  private itemKinds: DeployableKind[] = [];
  private pops: PopLabel[] = [];
  private popPool: HTMLElement[] = [];
  private lastScore = 0;
  private lastHearts = -1;
  private lastComboTier = -1;
  private lastState: GameState = 'boot';
  private installPrompt: BeforeInstallPromptEventLike | null = null;

  constructor(root: HTMLElement, game: Game) {
    this.root = root;
    this.game = game;
    this.build();
    this.bindGlobal();
  }

  // =======================================================================
  // construction
  // =======================================================================

  private build(): void {
    this.root.innerHTML = '';
    this.buildHud();
    this.buildTitle();
    this.buildStageCard();
    this.buildUpgrade();
    this.buildPause();
    this.buildResults();
    this.buildSettings();
    this.buildCollection();

    this.rotate = $(`
      <div id="rotate">
        <div>
          ${icon('hand', 66)}
          <h2 class="title-lg">Turn your phone</h2>
          <p class="subtle">Rivet Rush plays best sideways.</p>
          <button class="btn ghost" data-act="dismiss-rotate" style="margin-top:14px">Play anyway</button>
        </div>
      </div>
    `);
    this.root.appendChild(this.rotate);
  }

  private buildHud(): void {
    this.hud = $(`
      <div id="hud">
        <div class="hud-tl">
          <div class="hearts" role="status" aria-label="Health"></div>
        </div>
        <div class="hud-tc">
          <div class="score-wrap">
            <div class="score">0</div>
            <div class="combo"><span class="cx">x1</span><span class="cn">0</span></div>
            <div class="combo-bar"><i></i></div>
          </div>
        </div>
        <div class="hud-tr">
          <div class="objective">${icon('sparkie', 20)}<span>0/0</span></div>
          <button class="pause-btn" data-act="pause" aria-label="Pause">${icon('pause', 22)}</button>
        </div>

        <div class="boss-bar">
          <div class="label"><span>THE GREAT SCRAPBOT</span><span class="phase">PHASE 1</span></div>
          <div class="track">
            <div class="fill" style="width:100%"></div>
            <div class="pips"><span></span><span></span><span></span></div>
          </div>
        </div>

        <div class="stick"></div>
        <div class="stick-knob"></div>

        <div class="od-meter"></div>
        <div class="dash-pips"></div>
        <button class="dash-btn" data-act="dash" aria-label="Dash">${icon('dash', 44)}<span>DASH</span></button>
        <button class="od-btn" data-act="overdrive" aria-label="Overdrive">${icon('star', 40)}</button>

        <div class="swarm-top">
          <div class="wave-chip"><span class="wave-label">WAVE 1</span><span class="wave-sub"></span></div>
          <div class="pad-bar">
            <div class="pad-label">${icon('home', 16)}<span>REPAIR PAD</span></div>
            <div class="pad-track"><div class="pad-fill"></div></div>
          </div>
        </div>
        <div class="bank"><span class="bank-icon">${icon('coin', 22)}</span><span class="bank-n">0</span></div>
        <div class="item-bar"></div>

        <div class="guide"><i class="arrow"></i></div>
        <div class="fps subtle hidden" style="position:absolute;left:12px;bottom:8px"></div>
      </div>
    `);
    this.root.appendChild(this.hud);

    this.scoreEl = this.hud.querySelector('.score')!;
    this.comboEl = this.hud.querySelector('.combo')!;
    this.comboBar = this.hud.querySelector('.combo-bar')!;
    this.heartsEl = this.hud.querySelector('.hearts')!;
    this.objectiveEl = this.hud.querySelector('.objective')!;
    this.bossBar = this.hud.querySelector('.boss-bar')!;
    this.bossFill = this.hud.querySelector('.boss-bar .fill')!;
    this.bossPhaseEl = this.hud.querySelector('.boss-bar .phase')!;
    this.dashBtn = this.hud.querySelector('.dash-btn')!;
    this.dashPips = this.hud.querySelector('.dash-pips')!;
    this.odBtn = this.hud.querySelector('.od-btn')!;
    this.odMeter = this.hud.querySelector('.od-meter')!;
    this.stick = this.hud.querySelector('.stick')!;
    this.stickKnob = this.hud.querySelector('.stick-knob')!;
    this.guideEl = this.hud.querySelector('.guide')!;
    this.fpsEl = this.hud.querySelector('.fps')!;
    this.swarmTop = this.hud.querySelector('.swarm-top')!;
    this.waveChip = this.hud.querySelector('.wave-chip')!;
    this.padFill = this.hud.querySelector('.pad-fill')!;
    this.bankEl = this.hud.querySelector('.bank')!;
    this.itemBar = this.hud.querySelector('.item-bar')!;

    this.labels = $(`<div id="labels"></div>`);
    this.toasts = $(`<div id="toasts"></div>`);
    this.hintEl = $(`<div id="hint">${icon('info', 20)}<span></span></div>`);
    this.flashEl = $(`<div id="flash"></div>`);
    this.root.appendChild(this.labels);
    this.root.appendChild(this.toasts);
    this.root.appendChild(this.hintEl);
    this.root.appendChild(this.flashEl);
  }

  private buildTitle(): void {
    this.title = $(`
      <div class="screen" id="title-screen">
        <div class="title-top">
          <button class="btn round ghost" data-act="settings" aria-label="Settings">${icon('settings', 24)}</button>
          <button class="btn round ghost" data-act="collection" aria-label="Collection">${icon('medal', 24)}</button>
        </div>

        <div class="logo">
          <h1>RIVET<br>RUSH</h1>
          <h2>SKY SALVAGE</h2>
        </div>

        <div class="title-actions">
          <div class="best-chip">${icon('trophy', 18)}<span class="best">Best 0</span></div>
          <div class="mode-row">
            <button class="mode-btn story" data-act="play">${icon('play', 24)} ADVENTURE<small>Rescue &amp; boss</small></button>
            <button class="mode-btn swarm" data-act="swarm">${icon('drone', 22)} SWARM<small>Hold the pad</small></button>
          </div>
          <div class="title-row">
            <button class="btn ghost" data-act="daily">${icon('calendar', 20)} Daily</button>
            <button class="btn ghost hidden" data-act="install">${icon('install', 20)} Install</button>
          </div>
          <div class="daily-mods hidden"></div>
        </div>
      </div>
    `);
    this.root.appendChild(this.title);
  }

  private buildStageCard(): void {
    this.stageCard = $(`
      <div id="stage-card">
        <div class="stage-card-inner">
          <h2 class="stage-area"></h2>
          <p class="stage-name"></p>
          <div class="stage-hint"></div>
        </div>
      </div>
    `);
    this.root.appendChild(this.stageCard);
  }

  private buildUpgrade(): void {
    this.upgrade = $(`
      <div class="screen dim" id="upgrade-screen">
        <h2 class="title-lg up-title">PICK AN UPGRADE</h2>
        <div class="cards"></div>
      </div>
    `);
    this.root.appendChild(this.upgrade);
  }

  private buildPause(): void {
    this.pause = $(`
      <div class="screen dim" id="pause-screen">
        <div class="panel sheet" style="width:min(400px,92vw)">
          <div class="sheet-head"><h2>PAUSED</h2></div>
          <div class="sheet-body" style="display:flex;flex-direction:column;gap:10px">
            <button class="btn primary" data-act="resume">${icon('play', 24)} RESUME</button>
            <button class="btn ghost" data-act="settings">${icon('settings', 20)} Settings</button>
            <button class="btn danger" data-act="quit">${icon('home', 20)} Quit run</button>
          </div>
        </div>
      </div>
    `);
    this.root.appendChild(this.pause);
  }

  private buildResults(): void {
    this.results = $(`
      <div class="screen dim" id="results-screen">
        <div class="panel results-inner">
          <div class="results-scroll">
            <h2 class="title-lg outcome">RUN COMPLETE</h2>
            <div class="stars">${icon('star', 52)}${icon('star', 52)}${icon('star', 52)}</div>
            <div class="big-score">0</div>
            <div class="best-line subtle"></div>
            <div class="stat-grid"></div>
            <div class="unlock-list"></div>
          </div>
          <div class="results-actions">
            <button class="btn primary" data-act="again">${icon('refresh', 22)} PLAY AGAIN</button>
            <button class="btn ghost" data-act="home">${icon('home', 20)} Home</button>
          </div>
        </div>
      </div>
    `);
    this.root.appendChild(this.results);
  }

  private buildSettings(): void {
    this.settings = $(`
      <div class="screen dim" id="settings-screen">
        <div class="panel sheet">
          <div class="sheet-head">
            <button class="btn round ghost" data-act="close-settings" aria-label="Back">${icon('back', 22)}</button>
            <h2>SETTINGS</h2>
          </div>
          <div class="sheet-body"></div>
        </div>
      </div>
    `);
    this.root.appendChild(this.settings);
    this.renderSettings();
  }

  private buildCollection(): void {
    this.collection = $(`
      <div class="screen dim" id="collection-screen">
        <div class="panel sheet">
          <div class="sheet-head">
            <button class="btn round ghost" data-act="close-collection" aria-label="Back">${icon('back', 22)}</button>
            <h2>COLLECTION</h2>
          </div>
          <div class="tabs">
            <button class="tab active" data-tab="trails">${icon('brush', 16)} Trails</button>
            <button class="tab" data-tab="boards">${icon('dash', 16)} Boards</button>
            <button class="tab" data-tab="awards">${icon('medal', 16)} Awards</button>
          </div>
          <div class="sheet-body"></div>
        </div>
      </div>
    `);
    this.root.appendChild(this.collection);
  }

  // =======================================================================
  // events
  // =======================================================================

  private bindGlobal(): void {
    this.root.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act],[data-tab],[data-pick],[data-equip]');
      if (!el) return;
      // Dash / overdrive are handled as raw input so they feel instant; the
      // rest are click-style actions.
      const act = el.getAttribute('data-act');
      if (act === 'dash' || act === 'overdrive') {
        e.preventDefault();
        return;
      }
    });

    this.root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const actEl = target.closest('[data-act]');
      if (actEl) {
        const act = actEl.getAttribute('data-act')!;
        this.handleAction(act, actEl as HTMLElement);
        return;
      }
      const tab = target.closest('[data-tab]');
      if (tab) {
        this.setCollectionTab(tab.getAttribute('data-tab')!);
        return;
      }
      const pick = target.closest('[data-pick]');
      if (pick) {
        audio.play('uiConfirm');
        this.game.pickUpgrade(pick.getAttribute('data-pick') as never);
        return;
      }
      const equip = target.closest('[data-equip]');
      if (equip && !equip.classList.contains('locked')) {
        const [kind, id] = equip.getAttribute('data-equip')!.split('|');
        audio.play('uiConfirm');
        this.game.equip(kind as 'trail' | 'board', id!);
        this.renderCollection();
      }
    });

    // The dash / overdrive buttons feed the input system directly so they
    // share the same buffering and multi-touch handling as the rest.
    const bindHold = (el: HTMLElement, key: 'dash' | 'overdrive'): void => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        input.injectPress(key);
        if (key === 'dash') el.classList.add('pressed');
      });
      const release = (): void => el.classList.remove('pressed');
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
    };
    bindHold(this.dashBtn, 'dash');
    bindHold(this.odBtn, 'overdrive');

    // Item bar: one tap builds the gadget where Rivet is standing. Deliberately
    // pointerdown rather than click, so it feels as immediate as the dash.
    this.itemBar.addEventListener('pointerdown', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-item]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this.game.placeGadget(btn.getAttribute('data-item') as DeployableKind);
    });
    // Number keys 1-5 on desktop.
    window.addEventListener('keydown', (e) => {
      if (this.lastState !== 'playing') return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 5) return;
      const kinds = this.itemKinds;
      const kind = kinds[n - 1];
      if (kind) this.game.placeGadget(kind);
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as unknown as BeforeInstallPromptEventLike;
      this.title.querySelector('[data-act="install"]')?.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      this.title.querySelector('[data-act="install"]')?.classList.add('hidden');
    });
  }

  private handleAction(act: string, el: HTMLElement): void {
    switch (act) {
      case 'play':
        audio.play('uiConfirm');
        this.game.startRun(false);
        break;
      case 'swarm':
        audio.play('uiConfirm');
        this.game.startSwarm();
        break;
      case 'daily':
        audio.play('uiConfirm');
        this.game.startRun(true);
        break;
      case 'pause':
        audio.play('uiBack');
        this.game.pause();
        break;
      case 'resume':
        audio.play('uiConfirm');
        this.game.resume();
        break;
      case 'quit':
        audio.play('uiBack');
        this.game.abandon();
        break;
      case 'again':
        audio.play('uiConfirm');
        this.game.retry();
        break;
      case 'home':
        audio.play('uiBack');
        this.game.returnToTitle();
        break;
      case 'settings':
        audio.play('uiMove');
        this.settings.classList.add('show');
        this.renderSettings();
        break;
      case 'close-settings':
        audio.play('uiBack');
        this.settings.classList.remove('show');
        break;
      case 'collection':
        audio.play('uiMove');
        this.collection.classList.add('show');
        this.renderCollection();
        break;
      case 'close-collection':
        audio.play('uiBack');
        this.collection.classList.remove('show');
        break;
      case 'dismiss-rotate':
        this.rotate.style.display = 'none';
        break;
      case 'install':
        void this.installPrompt?.prompt();
        el.classList.add('hidden');
        break;
      case 'reset':
        if (el.dataset.confirm === '1') {
          save.resetProgress();
          this.game.applySettings();
          this.renderSettings();
          this.toast('Progress reset', 'refresh');
        } else {
          el.dataset.confirm = '1';
          el.textContent = 'Tap again to confirm';
          setTimeout(() => {
            el.dataset.confirm = '0';
            el.innerHTML = `${icon('trash', 18)} Reset progress`;
          }, 3200);
        }
        break;
      default:
        break;
    }
  }

  // =======================================================================
  // state routing
  // =======================================================================

  onState(state: GameState): void {
    this.lastState = state;
    const show = (el: HTMLElement, on: boolean): void => {
      el.classList.toggle('show', on);
    };

    show(this.title, state === 'title');
    show(this.pause, state === 'paused');
    show(this.upgrade, state === 'upgrade');
    show(this.results, state === 'results');
    this.hud.classList.toggle(
      'show',
      state === 'playing' || state === 'stageIntro' || state === 'paused' ||
      state === 'stageClear' || state === 'bossIntro',
    );

    if (state === 'title') {
      this.settings.classList.remove('show');
      this.collection.classList.remove('show');
      this.refreshTitle();
      this.hintEl.classList.remove('show');
      this.clearPops();
    }
    if (state !== 'playing') this.hintEl.classList.remove('show');
    if (state === 'playing') this.rotate.style.display = 'none';
  }

  private refreshTitle(): void {
    const p = save.profile;
    const best = this.title.querySelector('.best')!;
    best.textContent = `Best ${formatScore(p.bestScore)}`;

    const mods = dailyModifiers(hashString(localDateKey()));
    const wrap = this.title.querySelector('.daily-mods') as HTMLElement;
    wrap.classList.remove('hidden');
    wrap.innerHTML = `<span class="subtle" style="align-self:center">Today:</span>` +
      mods.map((m) => `<span class="daily-mod">${icon(m.icon, 16)}${m.name}</span>`).join('');

    const dailyBtn = this.title.querySelector('[data-act="daily"]') as HTMLElement;
    dailyBtn.innerHTML = p.daily.completed
      ? `${icon('check', 20)} Daily ✓`
      : `${icon('calendar', 20)} Daily`;
  }

  // =======================================================================
  // HUD
  // =======================================================================

  onHud(h: HudData): void {
    // Score, with a punch each time it jumps.
    if (h.score !== this.lastScore) {
      this.scoreEl.textContent = formatScore(h.score);
      if (h.score - this.lastScore > 40) {
        this.scoreEl.classList.remove('bump');
        void this.scoreEl.offsetWidth;
        this.scoreEl.classList.add('bump');
      }
      this.lastScore = h.score;
    }

    // Combo.
    const comboOn = h.combo >= 2;
    this.comboEl.classList.toggle('show', comboOn);
    this.comboBar.classList.toggle('show', comboOn);
    if (comboOn) {
      (this.comboEl.querySelector('.cx') as HTMLElement).textContent = `x${h.multiplier}`;
      (this.comboEl.querySelector('.cn') as HTMLElement).textContent = `${h.combo}`;
      (this.comboBar.firstElementChild as HTMLElement).style.width = `${h.comboProgress * 100}%`;
      if (h.comboTier !== this.lastComboTier) {
        this.comboEl.classList.remove('tier-up');
        void this.comboEl.offsetWidth;
        this.comboEl.classList.add('tier-up');
        this.lastComboTier = h.comboTier;
      }
    } else {
      this.lastComboTier = -1;
    }

    // Hearts + shields. Shields render as extra cyan hearts before the reds.
    const totalPips = h.maxHearts + h.maxShields;
    if (this.heartsEl.childElementCount !== totalPips) {
      this.heartsEl.innerHTML = '';
      for (let i = 0; i < totalPips; i++) {
        this.heartsEl.appendChild($(`<div class="heart">${icon('heart', 30)}</div>`));
      }
      this.lastHearts = -1;
    }
    const pips = this.heartsEl.children;
    for (let i = 0; i < pips.length; i++) {
      const el = pips[i] as HTMLElement;
      const isShield = i >= h.maxHearts;
      const filled = isShield ? i - h.maxHearts < h.shields : i < h.hearts;
      el.classList.toggle('shield', isShield);
      el.classList.toggle('empty', !filled);
      if (isShield) el.innerHTML = icon(filled ? 'shield' : 'shield', 30);
    }
    if (this.lastHearts >= 0 && h.hearts < this.lastHearts) {
      const lost = pips[h.hearts] as HTMLElement | undefined;
      if (lost) {
        lost.classList.remove('pop');
        void lost.offsetWidth;
        lost.classList.add('pop');
      }
    }
    this.lastHearts = h.hearts;

    // Objective chip.
    const done = h.sparkiesRescued >= h.sparkiesTotal && h.sparkiesTotal > 0;
    this.objectiveEl.classList.toggle('hidden', h.mode === 'swarm');
    this.objectiveEl.classList.toggle('done', done);
    if (h.bossHealth === null) {
      this.objectiveEl.innerHTML =
        (done ? icon('portal', 20) : icon('sparkie', 20)) +
        `<span>${done ? 'GO!' : `${h.sparkiesRescued}/${h.sparkiesTotal}`}</span>`;
    } else {
      this.objectiveEl.innerHTML = icon('warn', 20) + `<span>BOSS</span>`;
    }

    // Dash pips.
    if (this.dashPips.childElementCount !== h.dashMax) {
      this.dashPips.innerHTML = '';
      for (let i = 0; i < h.dashMax; i++) {
        this.dashPips.appendChild($(`<i class="dash-pip"></i>`));
      }
    }
    for (let i = 0; i < this.dashPips.childElementCount; i++) {
      const pip = this.dashPips.children[i] as HTMLElement;
      const full = i < h.dashCharges;
      const charging = i === h.dashCharges && h.dashCharges < h.dashMax;
      pip.classList.toggle('full', full || h.overdriveActive);
      pip.classList.toggle('charging', charging && !h.overdriveActive);
      if (charging) pip.style.setProperty('--p', `${h.dashProgress * 100}%`);
    }
    this.dashBtn.classList.toggle('empty', h.dashCharges < 1 && !h.overdriveActive);

    // Overdrive.
    this.odMeter.style.setProperty('--od', `${h.overdrive * 100}`);
    this.odMeter.classList.toggle('active', h.overdriveActive);
    const showOd = h.overdriveReady && !h.overdriveActive;
    if (this.odBtn.classList.contains('show') !== showOd) {
      this.odBtn.classList.toggle('show', showOd);
      if (showOd) audio.play('overdriveReady', { gain: 0.7 });
      input.setOverdriveButton(showOd ? this.odBtn.getBoundingClientRect() : null, showOd);
    }

    // Boss bar.
    const showBoss = h.bossHealth !== null;
    this.bossBar.classList.toggle('show', showBoss);
    if (showBoss) {
      this.bossFill.style.width = `${clamp01(h.bossHealth!) * 100}%`;
      this.bossPhaseEl.textContent = `PHASE ${h.bossPhase}`;
    }

    // Joystick visualisation.
    const j = input.joystick;
    this.stick.classList.toggle('show', j.active);
    this.stickKnob.classList.toggle('show', j.active);
    if (j.active) {
      this.stick.style.transform = `translate(${j.baseX}px, ${j.baseY}px)`;
      this.stickKnob.style.transform = `translate(${j.knobX}px, ${j.knobY}px)`;
    }

    // Objective guide arrow.
    if (h.guide) {
      this.guideEl.classList.add('show');
      this.guideEl.classList.toggle('boss', h.guide.kind === 'boss');
      this.guideEl.style.left = `${h.guide.x}%`;
      this.guideEl.style.top = `${h.guide.y}%`;
      (this.guideEl.firstElementChild as HTMLElement).style.transform =
        `rotate(${-h.guide.angle - Math.PI / 2}rad)`;
    } else {
      this.guideEl.classList.remove('show');
    }

    // --- Swarm mode --------------------------------------------------------
    const sw = h.swarm;
    const swarmOn = h.mode === 'swarm' && sw !== null;
    this.swarmTop.classList.toggle('show', swarmOn);
    this.bankEl.classList.toggle('show', swarmOn);
    this.itemBar.classList.toggle('show', swarmOn);
    if (sw) {
      if (this.itemBar.childElementCount !== sw.items.length) {
        this.itemKinds = sw.items.map((i) => i.kind);
        this.itemBar.innerHTML = sw.items
          .map((it, n) => `
            <button class="item" data-item="${it.kind}" style="--tint:${it.colour}">
              <span class="item-key">${n + 1}</span>
              ${icon(it.icon, 26)}
              <span class="item-name">${escapeHtml(it.name)}</span>
              <span class="item-cost">${icon('coin', 12)}${it.cost}</span>
            </button>`)
          .join('');
      }
      for (let i = 0; i < this.itemBar.childElementCount; i++) {
        const el = this.itemBar.children[i] as HTMLElement;
        const item = sw.items[i]!;
        el.classList.toggle('afford', item.afford);
        el.classList.toggle('blocked', !sw.canPlaceHere);
      }

      if (sw.bank !== this.lastBank) {
        (this.bankEl.querySelector('.bank-n') as HTMLElement).textContent = formatScore(sw.bank);
        if (sw.bank > this.lastBank) {
          this.bankEl.classList.remove('bump');
          void this.bankEl.offsetWidth;
          this.bankEl.classList.add('bump');
        }
        this.lastBank = sw.bank;
      }

      const building = sw.phase === 'build';
      this.waveChip.classList.toggle('building', building);
      (this.waveChip.querySelector('.wave-label') as HTMLElement).textContent =
        building ? `WAVE ${sw.wave + 1}` : `WAVE ${sw.wave}`;
      (this.waveChip.querySelector('.wave-sub') as HTMLElement).textContent =
        building ? `builds in ${Math.ceil(sw.buildLeft)}s` : `${sw.remaining} left`;
      if (sw.wave !== this.lastWave) {
        this.waveChip.classList.remove('tier-up');
        void this.waveChip.offsetWidth;
        this.waveChip.classList.add('tier-up');
        this.lastWave = sw.wave;
      }

      const padFrac = clamp01(sw.padHealth / sw.padMax);
      this.padFill.style.width = `${padFrac * 100}%`;
      this.padFill.classList.toggle('warn', padFrac < 0.6);
      this.padFill.classList.toggle('crit', padFrac < 0.3);
    }

    if (save.profile.settings.showFps) {
      this.fpsEl.classList.remove('hidden');
      this.fpsEl.textContent = `${Math.round(h.fps)} fps · ${this.game.renderer.quality}`;
    } else {
      this.fpsEl.classList.add('hidden');
    }
  }

  // =======================================================================
  // floating labels
  // =======================================================================

  popup(text: string, world: THREE.Vector3, kind: string): void {
    let el = this.popPool.pop();
    if (!el) {
      el = document.createElement('div');
      this.labels.appendChild(el);
    }
    el.className = `pop ${kind}`;
    el.textContent = text;
    el.style.opacity = '1';
    el.style.display = '';
    // Restart the animation.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.pops.push({ el, world: world.clone(), life: 0.9 });
    // Hard cap so a huge combo can't flood the DOM.
    if (this.pops.length > 26) {
      const oldest = this.pops.shift()!;
      oldest.el.style.display = 'none';
      this.popPool.push(oldest.el);
    }
  }

  /** Projects each live label to screen space. Called once per rendered frame. */
  updateLabels(dt: number, camera: THREE.Camera): void {
    if (this.pops.length === 0) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.el.style.display = 'none';
        this.popPool.push(p.el);
        this.pops.splice(i, 1);
        continue;
      }
      _proj.copy(p.world).project(camera);
      if (_proj.z > 1) {
        p.el.style.display = 'none';
        continue;
      }
      p.el.style.display = '';
      p.el.style.left = `${(_proj.x * 0.5 + 0.5) * w}px`;
      p.el.style.top = `${(-_proj.y * 0.5 + 0.5) * h}px`;
    }
  }

  private clearPops(): void {
    for (const p of this.pops) {
      p.el.style.display = 'none';
      this.popPool.push(p.el);
    }
    this.pops.length = 0;
  }

  // =======================================================================
  // toasts / hints / flash
  // =======================================================================

  toast(text: string, iconName = 'info', ms = 2000): void {
    const el = $(`<div class="toast">${icon(iconName, 20)}<span>${escapeHtml(text)}</span></div>`);
    this.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, ms);
    // Never let toasts stack more than three deep.
    while (this.toasts.childElementCount > 3) this.toasts.firstElementChild!.remove();
  }

  hint(id: string | null, text?: string): void {
    if (!id || !text) {
      this.hintEl.classList.remove('show');
      return;
    }
    const iconName = id === 'dash' ? 'dash'
      : id === 'move' ? 'hand'
      : id === 'collect' ? 'coin'
      : id === 'rescue' ? 'sparkie'
      : id === 'overdrive' ? 'star'
      : 'portal';
    this.hintEl.innerHTML = `${icon(iconName, 22)}<span>${escapeHtml(text)}</span>`;
    this.hintEl.classList.add('show');
  }

  flash(color: string, ms: number): void {
    if (save.profile.settings.reducedMotion) ms = Math.min(ms, 140);
    const el = this.flashEl;
    el.style.transition = 'none';
    el.style.background = color;
    el.style.opacity = '0.5';
    void el.offsetWidth;
    el.style.transition = `opacity ${ms}ms ease-out`;
    el.style.opacity = '0';
  }

  stageCardShow(stage: StageDef, isNewArea: boolean): void {
    const inner = this.stageCard.querySelector('.stage-card-inner') as HTMLElement;
    (inner.querySelector('.stage-area') as HTMLElement).textContent =
      isNewArea ? stage.areaName.toUpperCase() : stage.title.toUpperCase();
    (inner.querySelector('.stage-name') as HTMLElement).textContent =
      isNewArea ? stage.title : stage.areaName;
    (inner.querySelector('.stage-hint') as HTMLElement).innerHTML =
      `${icon('info', 20)}<span>${escapeHtml(stage.hint)}</span>`;
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';
    this.stageCard.classList.add('show');
    setTimeout(() => this.stageCard.classList.remove('show'), 1900);
  }

  // =======================================================================
  // upgrade cards
  // =======================================================================

  showUpgrades(choices: Upgrade[], taken: Record<string, number>): void {
    const wrap = this.upgrade.querySelector('.cards') as HTMLElement;
    wrap.innerHTML = choices
      .map((u) => {
        const have = taken[u.id] ?? 0;
        const stacks = Array.from({ length: u.maxStacks }, (_, i) =>
          `<i class="${i < have + 1 ? 'on' : ''}"></i>`).join('');
        return `
          <button class="card" data-pick="${u.id}">
            <div class="card-icon" style="background:linear-gradient(180deg,${u.color},${shade(u.color, -22)})">
              ${icon(u.icon, 40)}
            </div>
            <h3>${escapeHtml(u.name)}</h3>
            <p>${escapeHtml(u.desc)}</p>
            <div class="stacks">${stacks}</div>
          </button>`;
      })
      .join('');
  }

  // =======================================================================
  // results
  // =======================================================================

  showResults(r: ResultsData): void {
    const el = this.results;
    (el.querySelector('.outcome') as HTMLElement).textContent = r.won
      ? (r.daily ? 'DAILY COMPLETE!' : 'YOU DID IT!')
      : 'GOOD RUN!';

    const stars = el.querySelectorAll('.stars .ic');
    stars.forEach((s, i) => {
      s.classList.remove('on');
      if (i < r.stars) {
        setTimeout(() => s.classList.add('on'), 260 + i * 240);
        setTimeout(() => audio.play('star', { pitch: 1 + i * 0.16 }), 260 + i * 240);
      }
    });

    // Count the score up rather than just printing it.
    const scoreEl = el.querySelector('.big-score') as HTMLElement;
    this.tallyScore(scoreEl, r.score);

    (el.querySelector('.best-line') as HTMLElement).innerHTML = r.newBest
      ? `<span class="new-best">NEW BEST!</span>`
      : `Best ${formatScore(r.bestScore)}`;

    const stats: Array<[string, string]> = [
      [formatScore(r.sparkies), 'SPARKIES'],
      [`x${r.bestCombo}`, 'BEST COMBO'],
      [formatScore(r.enemies), 'DRONES'],
      [formatTime(r.timeSeconds), 'TIME'],
    ];
    (el.querySelector('.stat-grid') as HTMLElement).innerHTML = stats
      .map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
      .join('');

    const unlocks = [
      ...r.achievements.map((a) => ({ icon: a.icon, name: a.name, desc: a.desc })),
      ...r.cosmetics.map((c) => ({ icon: 'brush', name: c.name, desc: `New ${c.kind} unlocked!` })),
    ];
    (el.querySelector('.unlock-list') as HTMLElement).innerHTML = unlocks
      .map((u, i) => `
        <div class="unlock" style="animation-delay:${0.5 + i * 0.14}s">
          ${icon(u.icon, 26)}
          <div><b>${escapeHtml(u.name)}</b><span>${escapeHtml(u.desc)}</span></div>
        </div>`)
      .join('');
    if (unlocks.length > 0) {
      unlocks.forEach((_, i) =>
        setTimeout(() => audio.play('uiUnlock', { pitch: 1 + i * 0.1 }), 520 + i * 150));
    }
  }

  private tallyTimer: number | null = null;

  private tallyScore(el: HTMLElement, target: number): void {
    if (this.tallyTimer !== null) clearInterval(this.tallyTimer);
    let shown = 0;
    const start = performance.now();
    const dur = Math.min(1500, 420 + target * 0.01);
    let tick = 0;
    this.tallyTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / dur);
      shown = Math.round(target * (1 - Math.pow(1 - t, 3)));
      el.textContent = formatScore(shown);
      if (++tick % 2 === 0) audio.play('tallyTick', { gain: 0.2, pitch: 1 + t * 0.6 });
      if (t >= 1) {
        clearInterval(this.tallyTimer!);
        this.tallyTimer = null;
        el.textContent = formatScore(target);
        audio.play('tallyDone');
      }
    }, 32);
  }

  // =======================================================================
  // settings
  // =======================================================================

  private renderSettings(): void {
    const s = save.profile.settings;
    const body = this.settings.querySelector('.sheet-body') as HTMLElement;

    const slider = (key: keyof typeof s, label: string, iconName: string): string => `
      <div class="row">
        <div class="row-label">${icon(iconName, 22)}${label}</div>
        <input type="range" min="0" max="100" value="${Math.round((s[key] as number) * 100)}"
          data-set="${key}" aria-label="${label}">
      </div>`;

    const toggle = (key: keyof typeof s, label: string, iconName: string): string => `
      <div class="row">
        <div class="row-label">${icon(iconName, 22)}${label}</div>
        <button class="switch ${s[key] ? 'on' : ''}" data-toggle="${key}"
          role="switch" aria-checked="${!!s[key]}" aria-label="${label}"></button>
      </div>`;

    body.innerHTML = `
      ${slider('master', 'Volume', 'sound')}
      ${slider('music', 'Music', 'music')}
      ${slider('sfx', 'Sounds', 'fx')}
      ${slider('screenShake', 'Screen shake', 'wave')}
      ${toggle('reducedMotion', 'Calm mode', 'eye')}
      ${toggle('haptics', 'Vibration', 'wave')}
      ${toggle('leftHanded', 'Left-handed', 'hand')}
      ${toggle('bigUI', 'Bigger buttons', 'install')}
      ${toggle('showFps', 'Show FPS', 'info')}
      <div class="row">
        <div class="row-label">${icon('eye', 22)}Camera</div>
        <div class="seg" data-seg="camera">
          ${([['chase', 'CLOSE'], ['wide', 'WIDE']] as const)
            .map(([v, l]) => `<button class="${s.camera === v ? 'on' : ''}" data-cam="${v}">${l}</button>`)
            .join('')}
        </div>
      </div>
      <div class="row">
        <div class="row-label">${icon('settings', 22)}Graphics</div>
        <div class="seg" data-seg="quality">
          ${(['auto', 'low', 'medium', 'high'] as const)
            .map((q) => `<button class="${s.quality === q ? 'on' : ''}" data-q="${q}">${q.toUpperCase()}</button>`)
            .join('')}
        </div>
      </div>
      <div class="row" style="justify-content:center;padding-top:18px">
        <button class="btn danger" data-act="reset" data-confirm="0">${icon('trash', 18)} Reset progress</button>
      </div>
      <p class="subtle" style="text-align:center;margin:10px 0 0;line-height:1.5">
        No account needed. Everything is saved on this device only.
      </p>
    `;

    body.querySelectorAll('input[type=range]').forEach((rangeEl) => {
      const el = rangeEl as HTMLInputElement;
      el.addEventListener('input', () => {
        const key = el.dataset.set as keyof typeof s;
        save.update((p) => {
          (p.settings[key] as unknown as number) = Number(el.value) / 100;
        });
        this.game.applySettings();
      });
      el.addEventListener('change', () => audio.play('uiMove', { gain: 0.4 }));
    });

    body.querySelectorAll('[data-toggle]').forEach((btnEl) => {
      const el = btnEl as HTMLElement;
      el.addEventListener('click', () => {
        const key = el.dataset.toggle as keyof typeof s;
        const next = !s[key];
        save.update((p) => {
          (p.settings[key] as unknown as boolean) = next;
        });
        el.classList.toggle('on', next);
        el.setAttribute('aria-checked', String(next));
        audio.play('uiToggle');
        this.game.applySettings();
        this.applyBodyClasses();
      });
    });

    body.querySelectorAll('[data-cam]').forEach((btnEl) => {
      const el = btnEl as HTMLElement;
      el.addEventListener('click', () => {
        const cam = el.dataset.cam as CameraSetting;
        save.update((p) => {
          p.settings.camera = cam;
        });
        body.querySelectorAll('[data-cam]').forEach((o) => o.classList.remove('on'));
        el.classList.add('on');
        audio.play('uiConfirm');
        this.game.applySettings();
      });
    });

    body.querySelectorAll('[data-q]').forEach((btnEl) => {
      const el = btnEl as HTMLElement;
      el.addEventListener('click', () => {
        const q = el.dataset.q as QualityLevel;
        save.update((p) => {
          p.settings.quality = q;
        });
        body.querySelectorAll('[data-q]').forEach((o) => o.classList.remove('on'));
        el.classList.add('on');
        audio.play('uiConfirm');
        this.game.applySettings();
      });
    });

    this.applyBodyClasses();
  }

  applyBodyClasses(): void {
    const s = save.profile.settings;
    document.body.classList.toggle('lefty', s.leftHanded);
    document.body.classList.toggle('big-ui', s.bigUI);
  }

  // =======================================================================
  // collection
  // =======================================================================

  private collectionTab = 'trails';

  private setCollectionTab(tab: string): void {
    this.collectionTab = tab;
    audio.play('uiMove');
    this.collection.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    this.renderCollection();
  }

  private renderCollection(): void {
    const body = this.collection.querySelector('.sheet-body') as HTMLElement;
    const p = save.profile;

    if (this.collectionTab === 'awards') {
      const done = Object.keys(p.achievements).length;
      body.innerHTML =
        `<p class="subtle" style="text-align:center;margin:0 0 12px">${done} / ${ACHIEVEMENTS.length} earned</p>` +
        ACHIEVEMENTS.map((a) => {
          const got = p.achievements[a.id] !== undefined;
          return `
            <div class="ach ${got ? 'done' : ''}">
              ${icon(got ? a.icon : 'lock', 28)}
              <div><b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.desc)}</span></div>
              ${got ? icon('check', 22) : ''}
            </div>`;
        }).join('');
      return;
    }

    const kind = this.collectionTab === 'boards' ? 'board' : 'trail';
    const equipped = kind === 'board' ? p.equipped.board : p.equipped.trail;
    const list = cosmeticsOfKind(kind);
    body.innerHTML = `<div class="grid">` + list.map((c) => {
      const id = c.id.split(':')[1]!;
      const owned = p.unlocked.includes(c.id);
      const on = owned && id === equipped;
      return `
        <button class="swatch ${on ? 'on' : ''} ${owned ? '' : 'locked'}"
          ${owned ? `data-equip="${kind}|${id}"` : ''} title="${escapeHtml(c.how)}">
          <span class="dot" style="background:#${c.swatch.toString(16).padStart(6, '0')};color:#${c.swatch.toString(16).padStart(6, '0')}"></span>
          <span>${owned ? escapeHtml(c.name) : escapeHtml(c.how)}</span>
          ${owned ? '' : icon('lock', 14)}
        </button>`;
    }).join('') + `</div>`;
    void COSMETICS;
  }

  // =======================================================================
  // misc
  // =======================================================================

  showRotateHint(): void {
    const portrait = window.innerHeight > window.innerWidth;
    const small = Math.min(window.innerWidth, window.innerHeight) < 500;
    const shouldShow = portrait && small && this.lastState === 'title';
    this.rotate.style.display = shouldShow ? 'grid' : 'none';
  }

  haptic(pattern: number | number[]): void {
    if (!save.profile.settings.haptics) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* unsupported */
    }
  }

  /** Refresh cached button geometry after a resize. */
  onResize(): void {
    const showOd = this.odBtn.classList.contains('show');
    input.setOverdriveButton(showOd ? this.odBtn.getBoundingClientRect() : null, showOd);
    this.showRotateHint();
  }
}

interface BeforeInstallPromptEventLike {
  prompt: () => Promise<void>;
}

const _proj = new THREE.Vector3();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Lightens/darkens a hex colour string for card gradients. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

void DEFAULT_SETTINGS;
