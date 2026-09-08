import * as THREE from 'three';
import { GameRenderer } from '../render/Renderer';
import { CameraRig } from '../render/CameraRig';
import { Sky } from '../render/Sky';
import { Fx } from '../render/Fx';
import { THEMES, PAL } from '../render/Palette';
import { createDistantIsland } from '../render/models/Props';
import { Arena } from './Arena';
import { Player } from './Player';
import { RivetModel } from '../render/models/Rivet';
import { Collectibles, SparkiePods, Crates, Enemies } from './Entities';
import type { CollectEvent, EnemyHitEvent, EnemyAttackEvent } from './Entities';
import { BossFight } from './BossFight';
import { CFG } from './Config';
import { ALL_STAGES, isAreaStart } from './Stages';
import type { StageDef } from './Stages';
import { baseStats, rollUpgradeChoices, getUpgrade } from './Upgrades';
import type { PlayerStats, Upgrade, UpgradeId } from './Upgrades';
import { evaluateProgress, dailyModifiers, starsFor } from './Progression';
import type { RunSummary, Achievement, Cosmetic, DailyModifier } from './Progression';
import { audio } from '../core/Audio';
import { input } from '../core/Input';
import { save } from '../core/Save';
import {
  clamp01, damp, makeRandom, hashString, localDateKey,
} from '../core/Util';

/**
 * The orchestrator: owns the scene, drives every system, and decides what the
 * player is currently doing. Everything the interface needs is pushed out
 * through {@link GameHooks} so the DOM layer never reaches into gameplay.
 */

export type GameState =
  | 'boot' | 'title' | 'stageIntro' | 'playing' | 'paused'
  | 'stageClear' | 'upgrade' | 'bossIntro' | 'results';

export interface HudData {
  score: number;
  combo: number;
  comboTier: number;
  multiplier: number;
  comboProgress: number;
  hearts: number;
  maxHearts: number;
  shields: number;
  maxShields: number;
  dashCharges: number;
  dashMax: number;
  dashProgress: number;
  overdrive: number;
  overdriveActive: boolean;
  overdriveReady: boolean;
  sparkiesRescued: number;
  sparkiesTotal: number;
  cellsCollected: number;
  cellsTotal: number;
  stageIndex: number;
  stageTitle: string;
  areaName: string;
  portalOpen: boolean;
  bossHealth: number | null;
  bossPhase: number;
  /** Screen-space direction to the current objective, or null when on screen. */
  guide: { x: number; y: number; angle: number; kind: 'pod' | 'portal' | 'boss' } | null;
  fps: number;
}

export interface ResultsData {
  score: number;
  bestScore: number;
  newBest: boolean;
  bestCombo: number;
  stars: number;
  won: boolean;
  stagesCleared: number;
  sparkies: number;
  enemies: number;
  timeSeconds: number;
  hitsTaken: number;
  achievements: Achievement[];
  cosmetics: Cosmetic[];
  daily: boolean;
}

export interface GameHooks {
  onState: (state: GameState) => void;
  onHud: (hud: HudData) => void;
  onPopup: (text: string, world: THREE.Vector3, kind: 'score' | 'combo' | 'heal' | 'warn' | 'big') => void;
  onToast: (text: string, icon?: string, ms?: number) => void;
  onStageCard: (stage: StageDef, isNewArea: boolean) => void;
  onUpgradeOffer: (choices: Upgrade[], taken: Record<string, number>) => void;
  onResults: (results: ResultsData) => void;
  onFlash: (color: string, ms: number) => void;
  onHaptic: (pattern: number | number[]) => void;
  /** Tutorial prompts, driven purely by what the player has and hasn't done. */
  onHint: (id: string | null, text?: string) => void;
}

interface RunState {
  stageIndex: number;
  score: number;
  combo: number;
  comboTimer: number;
  bestCombo: number;
  sparkies: number;
  bolts: number;
  cells: number;
  enemies: number;
  dashes: number;
  overdrives: number;
  crates: number;
  hitsTaken: number;
  stageHits: number;
  perfectStages: number;
  stageTime: number;
  totalTime: number;
  taken: Record<string, number>;
  daily: boolean;
  seed: number;
}

const SCRATCH_V3 = new THREE.Vector3();

export class Game {
  readonly renderer: GameRenderer;
  readonly rig: CameraRig;
  readonly sky = new Sky();
  readonly fx: Fx;

  private hooks: GameHooks;
  private scene: THREE.Scene;

  state: GameState = 'boot';
  private arena: Arena | null = null;
  private player: Player | null = null;
  private stats: PlayerStats = baseStats();
  private collectibles = new Collectibles();
  private pods = new SparkiePods();
  private crates = new Crates();
  private enemies = new Enemies();
  private boss: BossFight | null = null;
  private portal: THREE.Object3D | null = null;

  private run: RunState = this.freshRun(false);
  private stage: StageDef = ALL_STAGES[0]!;
  private waveQueue: Array<{ kind: Parameters<Enemies['spawn']>[0]; at: number; remaining: number; gap: number; next: number }> = [];
  private obstacles: Array<{ x: number; z: number; r: number }> = [];
  private staticObstacles: Array<{ x: number; z: number; r: number }> = [];
  private portalOpen = false;
  private portalPulse = 0;

  private timeScale = 1;
  private hitstop = 0;
  private slowmo = 1;
  private elapsed = 0;
  private transitionTimer = 0;
  private pendingUpgrades: Upgrade[] = [];
  private collectBuffer: CollectEvent[] = [];
  private enemyHitBuffer: EnemyHitEvent[] = [];
  private attackBuffer: EnemyAttackEvent[] = [];
  private rescueBuffer: Array<{ x: number; z: number }> = [];
  private smashBuffer: Array<{ x: number; z: number }> = [];
  private helperBuffer: Array<{ x: number; z: number; r: number }> = [];

  private hud: HudData = {
    score: 0, combo: 0, comboTier: 0, multiplier: 1, comboProgress: 0,
    hearts: 3, maxHearts: 3, shields: 0, maxShields: 0,
    dashCharges: 2, dashMax: 2, dashProgress: 0,
    overdrive: 0, overdriveActive: false, overdriveReady: false,
    sparkiesRescued: 0, sparkiesTotal: 0, cellsCollected: 0, cellsTotal: 0,
    stageIndex: 0, stageTitle: '', areaName: '', portalOpen: false,
    bossHealth: null, bossPhase: 1, guide: null, fps: 60,
  };
  private displayScore = 0;

  /** Tutorial bookkeeping — pure observation of what the player has done. */
  private tutorial = {
    moved: false, collected: false, rescued: false, dashed: false,
    usedOverdrive: false, sawPortal: false, hintTimer: 0, currentHint: '' as string | null,
  };

  private dailyMods: DailyModifier[] = [];
  /** Decorative island + idling Rivet shown behind the title screen. */
  private titleArena: Arena | null = null;
  private titleRivet: RivetModel | null = null;
  private vents: Array<{ x: number; z: number; period: number; offset: number; active: boolean }> = [];
  private zapArcs: Array<{ from: THREE.Vector3; to: THREE.Vector3; life: number; mesh: THREE.Mesh }> = [];
  private zapPool: THREE.Mesh[] = [];
  private zapRoot = new THREE.Group();

  /** Set by the automated playtest bot; overrides human input when present. */
  botInput: { x: number; y: number; dash: boolean; overdrive: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, hooks: GameHooks) {
    this.hooks = hooks;
    this.renderer = new GameRenderer(canvas);
    this.scene = this.renderer.scene;
    this.rig = new CameraRig(this.renderer.camera);
    this.fx = new Fx(1);

    this.scene.add(this.sky.root);
    this.scene.add(this.fx.root);
    this.scene.add(this.collectibles.root);
    this.scene.add(this.pods.root);
    this.scene.add(this.crates.root);
    this.scene.add(this.enemies.root);
    this.scene.add(this.zapRoot);

    this.renderer.onContextLost = () => {
      if (this.state === 'playing') this.pause();
    };
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  async init(): Promise<void> {
    const settings = save.profile.settings;
    this.renderer.setQuality(settings.quality);
    this.applySettings();

    this.renderer.applyTheme(THEMES.scrapyard!, true);
    this.sky.applyTheme(THEMES.scrapyard!);
    await this.sky.buildDistantIslands((seed) => createDistantIsland(seed, 'scrapyard'), 9);

    this.sky.onLightning = () => {
      if (this.state === 'playing') this.rig.addTrauma(0.12);
    };

    this.buildTitleScene();
    this.setState('title');
  }

  /**
   * The title screen used to be an empty sky. Reusing the real arena generator
   * for a decorative island — with Rivet idling on it — costs one extra scene
   * build at boot and makes the first thing the player ever sees look like the
   * game rather than a menu over a gradient.
   */
  private buildTitleScene(): void {
    this.clearTitleScene();
    // Seeded from the date, so the title island quietly changes each day.
    const seed = hashString(`title-${localDateKey()}`);
    const arena = new Arena(ALL_STAGES[0]!, seed);
    this.scene.add(arena.root);
    this.titleArena = arena;

    for (const b of arena.layout.bolts) this.collectibles.spawn('bolt', b.x, b.z, b.y);
    for (const p of arena.layout.pods) this.pods.spawn(p.x, p.z);

    const rivet = new RivetModel(save.profile.equipped.board);
    rivet.root.scale.setScalar(1.25);
    rivet.root.position.set(0, CFG.player.hoverHeight, 2);
    this.scene.add(rivet.root);
    this.titleRivet = rivet;
  }

  private clearTitleScene(): void {
    if (this.titleArena) {
      this.scene.remove(this.titleArena.root);
      this.titleArena.dispose();
      this.titleArena = null;
    }
    if (this.titleRivet) {
      this.scene.remove(this.titleRivet.root);
      this.titleRivet.dispose();
      this.titleRivet = null;
    }
    this.collectibles.clear();
    this.pods.clear();
  }

  applySettings(): void {
    const s = save.profile.settings;
    audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    this.rig.shakeScale = s.reducedMotion ? 0 : s.screenShake;
    this.fx.setIntensity(s.reducedMotion ? 0.45 : 1);
    this.sky.setReducedMotion(s.reducedMotion);
    if (s.quality !== 'auto') this.renderer.setQuality(s.quality);
    else this.renderer.setQuality('auto');
  }

  resize(w: number, h: number): void {
    this.renderer.resize(w, h);
    this.rig.setBaseFov(this.renderer.camera.fov);
    this.rig.setPortrait(h > w);
    this.fx.setPixelScale(h * Math.min(window.devicePixelRatio || 1, 2), this.renderer.camera.fov);
  }

  private setState(s: GameState): void {
    this.state = s;
    input.gameplayEnabled = s === 'playing';
    this.hooks.onState(s);
  }

  private freshRun(daily: boolean): RunState {
    const seed = daily ? hashString(localDateKey()) : (Math.random() * 0xffffffff) >>> 0;
    return {
      stageIndex: 0, score: 0, combo: 0, comboTimer: 0, bestCombo: 0,
      sparkies: 0, bolts: 0, cells: 0, enemies: 0, dashes: 0, overdrives: 0, crates: 0,
      hitsTaken: 0, stageHits: 0, perfectStages: 0,
      stageTime: 0, totalTime: 0, taken: {}, daily, seed,
    };
  }

  // =========================================================================
  // run flow
  // =========================================================================

  startRun(daily = false): void {
    this.clearTitleScene();
    this.run = this.freshRun(daily);
    this.stats = baseStats();
    this.dailyMods = daily ? dailyModifiers(this.run.seed) : [];
    for (const mod of this.dailyMods) this.applyDailyModifier(mod.id);

    save.update((p) => {
      p.runsStarted += 1;
      if (daily) p.daily.played += 1;
    });

    this.player?.dispose();
    const equipped = save.profile.equipped;
    this.player = new Player(this.stats, equipped.board, equipped.trail);
    this.scene.add(this.player.model.root);
    this.scene.add(this.player.trail.mesh);
    this.player.onDashRecharged = () => audio.play('dashRecharge', { gain: 0.35 });
    this.player.onFence = (x, z) => {
      if (Math.random() < 0.25) {
        this.fx.burst('glow', x, 0.9, z, {
          count: 4, color: PAL.energy, speed: 4, size: 0.3, life: 0.25,
        });
      }
    };

    this.displayScore = 0;
    this.loadStage(0);
  }

  private applyDailyModifier(id: string): void {
    switch (id) {
      case 'speedy':
        this.stats.maxSpeed *= 1.18;
        break;
      case 'magnet':
        this.stats.magnetRadius *= 2.4;
        break;
      case 'glass':
        this.stats.maxHearts = 1;
        this.stats.scoreMultiplier *= 2;
        break;
      case 'swarm':
        this.stats.scoreMultiplier *= 1.35;
        break;
      case 'dashy':
        this.stats.dashRecharge = 0.12;
        this.stats.dashCharges += 1;
        break;
      case 'overdrive':
        this.stats.overdriveGain *= 2;
        break;
      case 'tiny':
        this.stats.boltValue = Math.round(this.stats.boltValue * 0.7);
        break;
    }
  }

  private loadStage(index: number): void {
    this.teardownStage();
    this.run.stageIndex = index;
    this.run.stageTime = 0;
    this.run.stageHits = 0;
    this.stage = ALL_STAGES[index]!;
    const stage = this.stage;

    const rngSeed = (this.run.seed + index * 7919) >>> 0;
    const rng = makeRandom(rngSeed);

    this.arena = new Arena(stage, rngSeed);
    this.scene.add(this.arena.root);
    this.staticObstacles = [...this.arena.layout.obstacles];

    const theme = THEMES[stage.area]!;
    this.renderer.applyTheme(theme, index === 0);
    this.sky.applyTheme(theme);
    if (index === 0 || isAreaStart(index)) {
      void this.sky.buildDistantIslands((seed) => createDistantIsland(seed, stage.area), 9);
    }

    // Populate the arena.
    const boltCount = this.dailyMods.some((m) => m.id === 'tiny') ? 2 : 1;
    for (const b of this.arena.layout.bolts) {
      for (let i = 0; i < boltCount; i++) {
        this.collectibles.spawn('bolt', b.x + (i ? 0.5 : 0), b.z + (i ? 0.5 : 0), b.y);
      }
    }
    for (const c of this.arena.layout.cells) this.collectibles.spawn('cell', c.x, c.z, 1.0);
    for (const p of this.arena.layout.pods) this.pods.spawn(p.x, p.z);
    for (const c of this.arena.layout.crates) this.crates.spawn(c.x, c.z);
    // Repair hearts in the back half of the run. A child who is one hit from
    // the end of a seven-minute run should have something to reach for.
    for (let i = 0; i < (stage.hearts ?? 0); i++) {
      const a = rng() * 6.28;
      const d = stage.radius * (0.35 + rng() * 0.45);
      this.collectibles.spawn('heart', Math.cos(a) * d, Math.sin(a) * d, 1.0);
    }
    this.vents = this.arena.layout.vents.map((v) => ({ ...v, active: false }));

    // Enemy waves.
    const swarm = this.dailyMods.some((m) => m.id === 'swarm');
    this.waveQueue = stage.waves.map((w) => ({
      kind: w.kind,
      at: w.at,
      remaining: w.count + (swarm ? 1 : 0),
      gap: w.trickle ?? 0,
      next: w.at,
    }));

    // Boss stage.
    if (stage.area === 'finale') {
      this.boss = new BossFight();
      this.scene.add(this.boss.root);
      this.boss.begin();
      this.boss.onSpawnMinions = (count) => {
        for (let i = 0; i < count; i++) {
          const a = rng() * 6.28;
          const d = 8 + rng() * 8;
          this.enemies.spawn('buzzbot', Math.cos(a) * d, Math.sin(a) * d);
        }
        audio.play('enemyAttack', { gain: 0.8 });
      };
      this.boss.onDamagePlayer = (x, z, force) => this.damagePlayer(x, z, force);
      this.boss.onReward = (x, z, heart) => {
        this.collectibles.burst(x, 1.4, z, heart ? 8 : 5);
        if (heart) {
          this.collectibles.spawn('heart', x, z, 1.2);
          this.hooks.onToast('Repair kit!', 'heart', 2000);
        }
      };
      this.boss.onEvent = (e) => this.onBossEvent(e);
    } else {
      this.portal = this.arena.addPortal(stage.area);
      this.portal.visible = false;
    }
    this.portalOpen = false;

    const spawn = this.arena.layout.spawn;
    this.player!.resetForStage(spawn.x, spawn.z);
    this.player!.refreshStats();
    this.rig.snapTo(spawn.x, spawn.z);
    this.rig.setZoomOut(stage.area === 'finale' ? 0.85 : 0);

    this.hud.stageIndex = index;
    this.hud.stageTitle = stage.title;
    this.hud.areaName = stage.areaName;
    this.hud.sparkiesTotal = this.pods.total;
    this.hud.cellsTotal = stage.cells;
    this.hud.cellsCollected = 0;

    if (stage.area === 'finale') {
      this.setState('bossIntro');
      this.transitionTimer = 0;
      audio.playMusic('boss', 1.4);
    } else {
      this.setState('stageIntro');
      this.transitionTimer = 0;
      this.hooks.onStageCard(stage, isAreaStart(index));
      audio.playMusic(stage.music, 1.2);
    }
  }

  private teardownStage(): void {
    this.collectibles.clear();
    this.pods.clear();
    this.crates.clear();
    this.enemies.clear();
    this.fx.clear();
    for (const arc of this.zapArcs) {
      arc.mesh.visible = false;
      this.zapPool.push(arc.mesh);
    }
    this.zapArcs.length = 0;
    if (this.arena) {
      this.scene.remove(this.arena.root);
      this.arena.dispose();
      this.arena = null;
    }
    if (this.boss) {
      this.scene.remove(this.boss.root);
      this.boss.dispose();
      this.boss = null;
    }
    this.portal = null;
  }

  // =========================================================================
  // main update
  // =========================================================================

  update(rawDt: number): void {
    const dt = Math.min(rawDt, 1 / 15); // never simulate a huge step
    this.elapsed += dt;
    input.update(dt);

    // Global time manipulation: hitstop freezes, slow-mo eases.
    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      this.timeScale = 0.02;
    } else {
      this.timeScale = damp(this.timeScale, this.slowmo, 12, dt);
    }
    const gdt = dt * this.timeScale;

    switch (this.state) {
      case 'title':
        this.updateTitle(dt);
        break;
      case 'stageIntro':
        this.transitionTimer += dt;
        this.updateWorld(gdt * 0.35, false);
        if (this.transitionTimer > 1.35) {
          this.setState('playing');
          audio.startHover();
        }
        break;
      case 'bossIntro':
        this.updateBossIntro(dt);
        break;
      case 'playing':
        this.updatePlaying(gdt, dt);
        break;
      case 'stageClear':
        this.transitionTimer += dt;
        this.updateWorld(gdt, false);
        if (this.transitionTimer > 1.6) this.offerUpgrade();
        break;
      case 'paused':
      case 'upgrade':
      case 'results':
        this.updateWorld(0, false);
        break;
      default:
        break;
    }

    this.sky.update(dt, this.renderer.camera.position.x, this.renderer.camera.position.z);
    this.fx.update(gdt, this.renderer.camera);
    this.updateZapArcs(gdt);
    this.hud.fps = this.renderer.fps;
    this.hooks.onHud(this.hud);
  }

  render(dt: number): void {
    this.renderer.render(dt);
  }

  /** Slow orbit around the showcase island, with Rivet idling on his board. */
  private updateTitle(dt: number): void {
    const t = this.elapsed * 0.11;
    const cam = this.renderer.camera;
    cam.position.set(Math.sin(t) * 36, 14 + Math.sin(t * 0.7) * 2.5, Math.cos(t) * 36);
    cam.lookAt(0, 2.2, 0);
    this.renderer.centreShadows(0, 0);

    this.titleArena?.update(dt, 0, 0);
    this.collectibles.update(dt, 0, 0, 0, this.fx, this.collectBuffer);
    this.collectBuffer.length = 0;
    this.pods.update(dt, 0, 2, 0);

    const rivet = this.titleRivet;
    if (rivet) {
      // He drifts in a lazy circle and always faces the way he's travelling.
      // A wide orbit keeps him out from behind the centred menu column, so he
      // is actually visible doing his idle rather than hidden by the buttons.
      const a = this.elapsed * 0.28;
      const r = 14;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      rivet.root.position.set(x, CFG.player.hoverHeight + Math.sin(this.elapsed * 1.4) * 0.06, z);
      rivet.root.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a)) + Math.PI;
      rivet.update(dt, {
        speed: 4, speed01: 0.32, turn: 1.6, dash: 0, hurt: 0, overdrive: 0, pose: 'ride',
      });
      if (Math.random() < dt * 14) {
        this.fx.emitOne('smoke', x, 0.2, z, 0, 0.5, 0, 0xdfe9ff, 0.3, 0.5, 0.3, 3);
      }
    }
  }

  private updateBossIntro(dt: number): void {
    this.transitionTimer += dt;
    const t = this.transitionTimer;
    const boss = this.boss;
    if (!boss) return;

    // 0.0–3.2s: slow orbit reveal. 1.2s: it wakes up. 3.2s: fight begins.
    this.rig.cinematicOrbit(0, -6, clamp01(t / 3.2), 19, 6.5);
    if (t > 1.2 && t < 1.26) {
      boss.startWake();
      this.rig.addTrauma(0.5);
      this.hooks.onFlash('#fff2d6', 220);
    }
    boss.playerX = this.player!.position.x;
    boss.playerZ = this.player!.position.z;
    boss.update(dt, this.fx);
    this.arena?.update(dt, 0, 0);
    this.renderer.centreShadows(0, -3);
    if (t > 3.3) {
      this.setState('playing');
      this.rig.snapTo(this.player!.position.x, this.player!.position.z);
      audio.startHover();
      this.hooks.onToast('Dash the glowing core!', 'dash', 2600);
    }
  }

  private updatePlaying(gdt: number, realDt: number): void {
    const player = this.player!;
    const arena = this.arena!;

    if (input.consume('pause')) {
      this.pause();
      return;
    }

    // --- input ------------------------------------------------------------
    let inX = input.moveX;
    let inZ = input.moveY;
    let mag = input.moveMag;
    let wantDash = input.consume('dash');
    let wantOverdrive = input.consume('overdrive');
    if (this.botInput) {
      inX = this.botInput.x;
      inZ = this.botInput.y;
      mag = Math.min(1, Math.hypot(inX, inZ));
      wantDash = this.botInput.dash;
      wantOverdrive = this.botInput.overdrive;
    }
    if (mag > 0.2) this.tutorial.moved = true;

    // --- run timers -------------------------------------------------------
    this.run.stageTime += gdt;
    this.run.totalTime += gdt;
    if (this.run.comboTimer > 0) {
      this.run.comboTimer -= gdt;
      if (this.run.comboTimer <= 0 && this.run.combo > 0) {
        if (this.run.combo >= 8) audio.play('comboBreak', { gain: 0.4 });
        this.run.combo = 0;
      }
    }

    // --- actions ----------------------------------------------------------
    if (wantDash) {
      const result = player.tryDash(inX, inZ);
      if (result === 'ok') this.onDash();
      else if (result === 'noCharge') audio.play('dashFail', { gain: 0.5 });
    }
    if (wantOverdrive && player.activateOverdrive()) this.onOverdriveStart();
    if (player.overdriveActive && player.overdriveTimer <= 0.001) this.onOverdriveEnd();

    // --- obstacles --------------------------------------------------------
    this.obstacles.length = 0;
    for (const o of this.staticObstacles) this.obstacles.push(o);
    this.crates.colliders(this.obstacles);

    // --- player -----------------------------------------------------------
    const arenaRadius = this.stage.area === 'finale' ? CFG.boss.arenaRadius : arena.layout.radius;
    player.update(gdt, inX, inZ, mag, arenaRadius, this.obstacles, this.fx, this.renderer.camera);

    // Boss vacuum drags the player toward the machine.
    if (this.boss && this.boss.vacuumPull > 0) {
      const bp = this.boss.bossPosition;
      const dx = bp.x - player.position.x;
      const dz = bp.z - player.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const pull = this.boss.vacuumPull * gdt;
      player.position.x += (dx / d) * pull * 0.06;
      player.position.z += (dz / d) * pull * 0.06;
    }

    // --- world ------------------------------------------------------------
    this.updateWorld(gdt, true);
    this.spawnWaves();
    this.updateHazards(gdt);
    this.updateZap(gdt);
    this.resolveEvents(gdt);
    this.checkObjectives();

    // --- camera -----------------------------------------------------------
    this.rig.setZoomOut(
      (this.stage.area === 'finale' ? 0.85 : 0) + player.speed01 * 0.12 + player.overdriveBlend * 0.1,
    );
    this.rig.setRoll(-player.velocity.x * 0.0035);
    this.rig.update(player.position.x, player.position.z, player.velocity.x, player.velocity.z, realDt);
    this.renderer.centreShadows(player.position.x, player.position.z);

    // --- grade ------------------------------------------------------------
    const dash01 = player.dashTimer / CFG.dash.duration;
    this.renderer.setSpeedLines(dash01 * 1.7 + player.overdriveBlend * 0.55 + player.speed01 * 0.22);
    this.renderer.setBloomBoost(player.overdriveBlend * 0.5 + dash01 * 0.25);
    this.renderer.setVignette(0.3 + player.overdriveBlend * 0.14 + (player.invuln > 0 ? 0.16 : 0));
    if (player.overdriveBlend > 0.02) {
      this.renderer.setWash(PAL.overdrive, player.overdriveBlend * 0.09);
    } else {
      this.renderer.setWash(0xffffff, 0);
    }

    // --- audio ------------------------------------------------------------
    audio.setListener(player.position.x, 1, player.position.z);
    audio.setHoverParams(player.speed01, player.dashTimer > 0 || player.overdriveActive);
    const tier = this.comboTier();
    audio.setMusicIntensity(clamp01(0.25 + tier * 0.12 + player.speed01 * 0.2));

    // --- tutorial ---------------------------------------------------------
    this.updateTutorial(realDt);

    // --- death ------------------------------------------------------------
    if (player.dead) this.endRun(false);

    this.refreshHud();
  }

  /** Everything that keeps animating even while gameplay is frozen. */
  private updateWorld(gdt: number, interactive: boolean): void {
    const player = this.player;
    if (!player) return;
    const px = player.position.x;
    const pz = player.position.z;

    this.arena?.update(gdt, px, pz);

    if (interactive) {
      this.helperBuffer.length = 0;
      if (this.stats.sparkieHelpers > 0) {
        this.pods.helperPositions(this.stats.sparkieHelpers, this.helperBuffer, 4.4);
      }
      this.collectibles.helpers = this.helperBuffer;
      this.collectBuffer.length = 0;
      this.collectibles.update(gdt, px, pz, player.magnetRadius, this.fx, this.collectBuffer);
    } else {
      this.collectibles.update(gdt, px, pz, 0, this.fx, this.collectBuffer);
    }

    this.pods.update(gdt, px, pz, player.velocity.length());
    this.crates.update(gdt, px, pz);

    if (interactive) {
      this.attackBuffer.length = 0;
      this.enemies.update(
        gdt, px, pz, CFG.player.radius,
        this.stage.area === 'finale' ? CFG.boss.arenaRadius : (this.arena?.layout.radius ?? 26),
        this.obstacles, this.fx, this.attackBuffer,
        (kind, x, z) => {
          audio.play('enemyTelegraph', { pos: { x, y: 1, z }, gain: kind === 'bomblet' ? 0.7 : 0.5 });
        },
      );
    }

    if (this.boss) {
      this.boss.playerX = px;
      this.boss.playerZ = pz;
      this.boss.update(gdt, this.fx);
    }

    this.updatePortal(gdt);
  }

  // =========================================================================
  // systems
  // =========================================================================

  private spawnWaves(): void {
    const t = this.run.stageTime;
    const radius = this.arena?.layout.radius ?? 26;
    for (const wave of this.waveQueue) {
      while (wave.remaining > 0 && t >= wave.next) {
        const a = Math.random() * 6.28;
        const d = radius * (0.55 + Math.random() * 0.35);
        const x = Math.cos(a) * d;
        const z = Math.sin(a) * d;
        this.enemies.spawn(wave.kind, x, z);
        this.fx.burst('glow', x, CFG.enemies[wave.kind].hover, z, {
          count: 12, color: PAL.droneShell, speed: 6, size: 0.4, life: 0.4,
        });
        this.fx.shockwave(x, 0.06, z, 0.3, 3, 0.35, PAL.droneShell, 0.6);
        audio.play('enemyAttack', { pos: { x, y: 1, z }, gain: 0.35, pitch: 1.3 });
        wave.remaining -= 1;
        wave.next = wave.gap > 0 ? t + wave.gap : t;
        if (wave.gap <= 0) break;
      }
    }
  }

  private updateHazards(gdt: number): void {
    const player = this.player!;
    const arena = this.arena;
    if (!arena) return;
    const px = player.position.x;
    const pz = player.position.z;

    // Spinning blades: a simple radial band the player must not sit inside.
    for (const fan of arena.layout.fans) {
      const d = Math.hypot(px - fan.x, pz - fan.z);
      if (d < fan.radius * 0.92 && d > 0.35) {
        this.damagePlayer(fan.x, fan.z, 10);
      }
    }

    // Steam vents: fire on a timer, with a visible warning puff first.
    for (const vent of this.vents) {
      const phase = (this.run.stageTime + vent.offset) % vent.period;
      const firing = phase > vent.period - 0.75;
      const warning = phase > vent.period - 1.35 && !firing;
      if (warning && Math.random() < gdt * 26) {
        this.fx.emitOne('smoke', vent.x + (Math.random() - 0.5), 0.3, vent.z + (Math.random() - 0.5),
          0, 1.4, 0, 0xdfe6f5, 0.4, 0.5, 0.4, 1.5, -1);
      }
      if (firing) {
        if (!vent.active) {
          vent.active = true;
          audio.play('enemyAttack', { pos: { x: vent.x, y: 1, z: vent.z }, gain: 0.4, pitch: 0.7 });
          this.fx.shockwave(vent.x, 0.1, vent.z, 0.4, 2.4, 0.3, PAL.hazard, 0.7);
        }
        if (Math.random() < gdt * 90) {
          this.fx.emitOne('smoke', vent.x + (Math.random() - 0.5) * 0.9, 0.3,
            vent.z + (Math.random() - 0.5) * 0.9,
            (Math.random() - 0.5) * 2, 7 + Math.random() * 4, (Math.random() - 0.5) * 2,
            0xffffff, 0.7, 0.7, 0.7, 1.2, -2);
        }
        if (Math.hypot(px - vent.x, pz - vent.z) < 1.5) this.damagePlayer(vent.x, vent.z, 11);
      } else {
        vent.active = false;
      }
    }

    // Moving energy barriers.
    for (let i = 0; i < arena.layout.barriers.length; i++) {
      const def = arena.layout.barriers[i]!;
      arena.barrierPosition(i, _barrierPos);
      const dx = px - _barrierPos.x;
      const dz = pz - _barrierPos.z;
      const cosA = Math.cos(def.angle);
      const sinA = Math.sin(def.angle);
      const along = dx * cosA + dz * sinA;
      const perp = -dx * sinA + dz * cosA;
      if (Math.abs(along) < def.width * 0.5 && Math.abs(perp) < 0.7) {
        this.damagePlayer(_barrierPos.x, _barrierPos.z, 12);
      }
    }

    // Boost pads.
    for (const pad of arena.layout.pads) {
      if (Math.hypot(px - pad.x, pz - pad.z) < 1.5) {
        if (player.applyBoostPad(pad.angle)) {
          audio.play('boostPad', { pos: { x: pad.x, y: 0.5, z: pad.z } });
          this.rig.addPunch(0.3);
          this.rig.addFovPunch(6);
          this.fx.shockwave(pad.x, 0.1, pad.z, 0.5, 4.5, 0.35, PAL.energy, 0.9);
          this.fx.burst('glow', pad.x, 0.4, pad.z, {
            count: 16, color: PAL.energy, speed: 8, size: 0.4, life: 0.4, upBias: 0.6,
          });
          this.hooks.onHaptic(12);
        }
      }
    }

    // Boss body contact — but never while it is staggered with its core open.
    // That window is the player's reward for dodging; charging in to dash the
    // core must not cost a heart every time.
    if (this.boss && !this.boss.defeated && !this.boss.coreExposed) {
      const bp = this.boss.bossPosition;
      if (Math.hypot(px - bp.x, pz - bp.z) < this.boss.bodyRadius + CFG.player.radius) {
        this.damagePlayer(bp.x, bp.z, 12);
      }
    }
  }

  /** Auto-attack: finds a target, fires, chains. The player never aims. */
  private updateZap(gdt: number): void {
    const player = this.player!;
    if (player.zapTimer > 0) return;
    const interval = this.stats.zapInterval * (player.overdriveActive ? CFG.overdrive.zapIntervalScale : 1);

    const target = this.enemies.nearest(player.position.x, player.position.z, CFG.zap.range);
    if (!target) {
      // Chip the boss core with the zap tool too, so the auto-attack is never
      // useless — it just isn't the fast way to win.
      if (this.boss && this.boss.coreExposed) {
        const cp = this.boss.model.corePosition;
        if (Math.hypot(cp.x - player.position.x, cp.z - player.position.z) < CFG.zap.range + 3) {
          player.zapTimer = interval;
          const dmg = CFG.boss.coreDamagePerZap * this.stats.zapDamage *
            (player.overdriveActive ? 1 + CFG.overdrive.zapDamageBonus : 1);
          this.spawnZapArc(player.model.toolPosition, cp);
          this.boss.damage(dmg, this.fx, false);
          audio.play('zap', { gain: 0.45, pitch: 0.9 + Math.random() * 0.2 });
        }
      }
      return;
    }

    player.zapTimer = interval;
    const damage = this.stats.zapDamage + (player.overdriveActive ? CFG.overdrive.zapDamageBonus : 0);

    this.enemyHitBuffer.length = 0;
    SCRATCH_V3.set(target.x, target.y, target.z);
    this.spawnZapArc(player.model.toolPosition, SCRATCH_V3);
    this.enemies.damageEnemy(target, damage, false, this.enemyHitBuffer, this.fx);
    audio.play('zap', {
      pos: { x: target.x, y: target.y, z: target.z },
      pitch: 0.92 + Math.random() * 0.18,
    });
    player.model.lookToward(target.x - player.position.x, target.z - player.position.z, player.facing);

    // Chains.
    let chainFrom = target;
    for (let c = 0; c < this.stats.zapChains; c++) {
      const next = this.enemies.nearest(chainFrom.x, chainFrom.z, CFG.zap.chainRange, chainFrom.model);
      if (!next) break;
      _chainA.set(chainFrom.x, chainFrom.y, chainFrom.z);
      _chainB.set(next.x, next.y, next.z);
      this.spawnZapArc(_chainA, _chainB);
      this.enemies.damageEnemy(next, damage, false, this.enemyHitBuffer, this.fx);
      audio.play('zapChain', { pos: { x: next.x, y: next.y, z: next.z }, gain: 0.5, pitch: 1.1 + c * 0.1 });
      chainFrom = next;
    }

    this.processEnemyHits();
    void gdt;
  }

  private spawnZapArc(from: THREE.Vector3, to: THREE.Vector3): void {
    let mesh = this.zapPool.pop();
    if (!mesh) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: PAL.cellHot, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        toneMapped: false, fog: false,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 12;
      this.zapRoot.add(mesh);
    }
    mesh.visible = true;
    this.zapArcs.push({
      from: from.clone(), to: to.clone(), life: 0.13, mesh,
    });
    this.fx.burst('spark', to.x, to.y, to.z, {
      count: 5, color: PAL.cellHot, speed: 6, size: 0.24, life: 0.2,
    });
  }

  /**
   * Draws each electric arc as a quad stretched between two points and rolled
   * to face the camera. Built from an explicit basis (along the arc, across it,
   * facing the viewer) — chaining lookAt/quaternion tweaks the way an earlier
   * pass did produced garbage orientations and arena-length streaks.
   */
  private updateZapArcs(gdt: number): void {
    const cam = this.renderer.camera;
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    for (let i = this.zapArcs.length - 1; i >= 0; i--) {
      const arc = this.zapArcs[i]!;
      arc.life -= gdt;
      if (arc.life <= 0) {
        arc.mesh.visible = false;
        this.zapPool.push(arc.mesh);
        this.zapArcs.splice(i, 1);
        continue;
      }
      _mid.copy(arc.from).add(arc.to).multiplyScalar(0.5);
      _up.copy(arc.to).sub(arc.from);
      const len = _up.length();
      if (len < 1e-4) {
        arc.mesh.visible = false;
        continue;
      }
      _up.divideScalar(len);
      _toCam.copy(_camPos).sub(_mid).normalize();
      _right.crossVectors(_up, _toCam);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _right.normalize();
      _fwd.crossVectors(_right, _up).normalize();

      const t = arc.life / 0.13;
      const width = 0.05 + t * 0.16;
      _basis.makeBasis(_right, _up, _fwd);
      arc.mesh.quaternion.setFromRotationMatrix(_basis);
      arc.mesh.position.copy(_mid);
      arc.mesh.scale.set(width, len, 1);
      arc.mesh.visible = true;
      (arc.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
  }

  // =========================================================================
  // events
  // =========================================================================

  private onDash(): void {
    const player = this.player!;
    this.run.dashes += 1;
    this.tutorial.dashed = true;
    audio.play('dash', { pitch: 0.95 + Math.random() * 0.12 });
    this.hitstop = CFG.dash.hitstop;
    this.rig.addPunch(0.55, 8);
    this.rig.addFovPunch(9);
    this.rig.addTrauma(0.16);
    this.hooks.onHaptic(18);

    const x = player.position.x;
    const z = player.position.z;
    const radius = this.stats.dashShockRadius;

    this.fx.shockwave(x, 0.12, z, 0.6, radius * 2.1, 0.34, PAL.energy, 0.95);
    this.fx.burst('glow', x, 0.5, z, {
      count: 22, color: PAL.energy, color2: PAL.cellHot,
      speed: 11, size: 0.5, life: 0.36, drag: 4,
    });

    // Smash crates and stun/damage drones caught in the wake.
    this.smashBuffer.length = 0;
    this.crates.smash(x, z, radius, this.smashBuffer);
    for (const c of this.smashBuffer) this.onCrateSmashed(c.x, c.z);

    this.enemyHitBuffer.length = 0;
    this.enemies.damageAt(x, z, radius, CFG.dash.contactDamage, true, this.enemyHitBuffer, this.fx);
    this.processEnemyHits();

    // Dashing pops open Sparkie pods too — the "one verb solves everything"
    // rule that keeps the controls simple.
    this.rescueBuffer.length = 0;
    this.pods.tryRescue(x, z, radius * 0.75, this.rescueBuffer);
    for (const r of this.rescueBuffer) this.onSparkieRescued(r.x, r.z);

    // Boss core.
    if (this.boss && this.boss.coreExposed) {
      const cp = this.boss.model.corePosition;
      if (Math.hypot(cp.x - x, cp.z - z) < 5.5) {
        if (this.boss.damage(CFG.boss.coreDamagePerDash, this.fx, true)) {
          this.hitstop = 0.1;
          this.rig.addTrauma(0.5);
          this.hooks.onFlash('#7ef7ff', 130);
          audio.play('bossHurt');
          this.hooks.onPopup('CRUNCH!', cp, 'big');
        }
      }
    }
  }

  private onOverdriveStart(): void {
    this.run.overdrives += 1;
    this.tutorial.usedOverdrive = true;
    audio.play('overdriveStart');
    audio.setOverdrive(true);
    this.rig.addTrauma(0.5);
    this.rig.addFovPunch(-12);
    this.hooks.onFlash('#ffd447', 320);
    this.hooks.onHaptic([30, 40, 30]);
    this.hooks.onToast('OVERDRIVE!', 'star', 1600);
    const p = this.player!.position;
    this.fx.shockwave(p.x, 0.2, p.z, 1, 22, 0.7, PAL.overdrive, 1);
    this.fx.burst('glow', p.x, 1, p.z, {
      count: 60, color: PAL.overdrive, color2: PAL.overdriveHot,
      speed: 15, size: 0.7, life: 0.9, drag: 2.2,
    });
  }

  private onOverdriveEnd(): void {
    audio.play('overdriveEnd', { gain: 0.7 });
    audio.setOverdrive(false);
  }

  private onCrateSmashed(x: number, z: number): void {
    this.run.crates += 1;
    audio.play('crateSmash', { pos: { x, y: 0.5, z }, pitch: 0.9 + Math.random() * 0.25 });
    this.collectibles.burst(x, 0.7, z, 3 + Math.floor(Math.random() * 3));
    this.fx.burst('smoke', x, 0.5, z, {
      count: 10, color: 0xd9a25f, speed: 5, size: 0.5, endSize: 0.9, life: 0.5, upBias: 0.4,
    });
    this.fx.burst('spark', x, 0.5, z, {
      count: 12, color: PAL.woodLight, color2: PAL.bolt,
      speed: 8, size: 0.3, life: 0.6, gravity: 20, bounce: 0.4,
    });
    this.addScore(CFG.score.crate, x, 1, z, false);
  }

  private onSparkieRescued(x: number, z: number): void {
    this.run.sparkies += 1;
    this.tutorial.rescued = true;
    audio.play('sparkieRescue', { pos: { x, y: 1, z } });
    this.bumpCombo();
    this.player!.addOverdrive(CFG.overdrive.gainPerSparkie, this.comboTier());
    this.rig.addPunch(0.22);
    this.rig.addTrauma(0.1);
    this.hooks.onHaptic(20);
    this.fx.shockwave(x, 0.1, z, 0.5, 7, 0.5, PAL.sparkieGlow, 0.9);
    this.fx.burst('glow', x, 1, z, {
      count: 34, color: PAL.sparkieGlow, color2: PAL.overdriveHot,
      speed: 9, size: 0.55, life: 0.7, upBias: 0.5, drag: 2.4,
    });
    _popupPos.set(x, 1.8, z);
    this.addScore(CFG.score.sparkie, x, 1.8, z, true, 'RESCUED!');
  }

  private processEnemyHits(): void {
    for (const hit of this.enemyHitBuffer) {
      if (hit.shieldBroken) {
        audio.play('shieldBreak', { pos: { x: hit.x, y: hit.y, z: hit.z } });
        this.rig.addTrauma(0.18);
        continue;
      }
      if (hit.killed) {
        this.run.enemies += 1;
        audio.play('enemyDefeat', { pos: { x: hit.x, y: hit.y, z: hit.z } });
        this.bumpCombo();
        this.player!.addOverdrive(CFG.overdrive.gainPerEnemy, this.comboTier());
        this.rig.addTrauma(0.14);
        this.hitstop = Math.max(this.hitstop, 0.03);
        this.addScore(CFG.score.enemy, hit.x, hit.y + 0.8, hit.z, true);
        // Defeated drones drop a couple of bolts — every kill feeds the combo.
        this.collectibles.burst(hit.x, hit.y, hit.z, 2);
      } else {
        audio.play('enemyHit', {
          pos: { x: hit.x, y: hit.y, z: hit.z }, gain: 0.6,
          pitch: 0.95 + Math.random() * 0.2,
        });
      }
    }
    this.enemyHitBuffer.length = 0;
  }

  private resolveEvents(gdt: number): void {
    const player = this.player!;

    // --- pickups ----------------------------------------------------------
    for (const c of this.collectBuffer) {
      if (c.kind === 'bolt') {
        this.run.bolts += 1;
        this.bumpCombo();
        player.addOverdrive(CFG.overdrive.gainPerBolt, this.comboTier());
        const tier = this.comboTier();
        audio.play('bolt', { pitch: 1 + Math.min(tier, 7) * 0.09, gain: 0.55 });
        this.addScore(this.stats.boltValue, c.x, c.y + 0.4, c.z, false);
        this.tutorial.collected = true;
      } else if (c.kind === 'cell') {
        this.run.cells += 1;
        this.hud.cellsCollected += 1;
        this.bumpCombo();
        player.addOverdrive(CFG.overdrive.gainPerCell, this.comboTier());
        audio.play('cell', { pos: { x: c.x, y: c.y, z: c.z } });
        this.rig.addPunch(0.18);
        this.fx.shockwave(c.x, c.y, c.z, 0.4, 5, 0.4, PAL.cell, 0.9, true);
        this.fx.burst('glow', c.x, c.y, c.z, {
          count: 24, color: PAL.cell, color2: PAL.cellHot, speed: 8, size: 0.5, life: 0.5,
        });
        this.addScore(CFG.score.cell, c.x, c.y + 0.8, c.z, true);
      } else {
        if (player.heal(1)) {
          audio.play('heart', { pos: { x: c.x, y: c.y, z: c.z } });
          _popupPos.set(c.x, c.y + 0.8, c.z);
          this.hooks.onPopup('+1', _popupPos, 'heal');
          this.hooks.onFlash('#ff6f91', 180);
        } else {
          this.addScore(500, c.x, c.y + 0.8, c.z, true);
        }
      }
    }
    this.collectBuffer.length = 0;

    // --- rescues (proximity, not just dash) -------------------------------
    this.rescueBuffer.length = 0;
    this.pods.tryRescue(player.position.x, player.position.z, 1.9, this.rescueBuffer);
    for (const r of this.rescueBuffer) this.onSparkieRescued(r.x, r.z);

    // --- enemy attacks ----------------------------------------------------
    for (const atk of this.attackBuffer) {
      if (atk.radius === -1) {
        // Zapper beam: resolve the line against the player.
        const info = this.enemies.beamInfo(atk.x, atk.z);
        if (info && Enemies.beamHitsPoint(
          atk.x, atk.z, info.dx, info.dz, info.range,
          player.position.x, player.position.z, CFG.player.radius + 0.55,
        )) {
          this.damagePlayer(atk.x, atk.z, 11);
        }
      } else if (atk.radius > 0) {
        if (Math.hypot(player.position.x - atk.x, player.position.z - atk.z) < atk.radius) {
          this.damagePlayer(atk.x, atk.z, 12);
        }
      } else {
        this.damagePlayer(atk.x, atk.z, 9);
      }
    }
    this.attackBuffer.length = 0;
    void gdt;
  }

  private damagePlayer(x: number, z: number, force: number): void {
    const player = this.player!;
    const info = player.takeHit(x, z, force);
    if (!info) return;

    this.run.stageHits += 1;
    this.run.hitsTaken += 1;
    this.run.combo = 0;
    this.run.comboTimer = 0;

    if (info.blockedByShield) {
      audio.play('shieldBreak');
      this.hooks.onFlash('#8ad7ff', 200);
      this.fx.shockwave(player.position.x, 1, player.position.z, 0.5, 6, 0.4, PAL.shield, 1, true);
      this.hooks.onToast('Shield used!', 'shield', 1200);
    } else {
      audio.play('playerHurt');
      this.hooks.onFlash('#ff4d6d', 260);
      this.fx.burst('glow', player.position.x, 0.9, player.position.z, {
        count: 18, color: PAL.danger, speed: 8, size: 0.5, life: 0.45,
      });
    }
    this.hitstop = CFG.health.hitstop;
    this.rig.addTrauma(info.blockedByShield ? 0.35 : 0.65);
    this.rig.addFovPunch(-8);
    this.hooks.onHaptic(info.blockedByShield ? 30 : [40, 60, 40]);
    player.model.flashWhite(1);
  }

  // =========================================================================
  // scoring
  // =========================================================================

  private comboTier(): number {
    const c = this.run.combo;
    const th = CFG.combo.thresholds;
    let tier = 0;
    for (let i = th.length - 1; i >= 0; i--) {
      if (c >= th[i]!) {
        tier = i;
        break;
      }
    }
    return tier;
  }

  private bumpCombo(): void {
    const before = this.comboTier();
    this.run.combo += 1;
    this.run.comboTimer = this.stats.comboWindow;
    if (this.run.combo > this.run.bestCombo) this.run.bestCombo = this.run.combo;
    const after = this.comboTier();
    if (after > before) {
      audio.play('comboUp', { pitch: 1 + after * 0.11 });
      this.rig.addPunch(0.16);
      this.hooks.onHaptic(14);
      const p = this.player!.position;
      _popupPos.set(p.x, 2.4, p.z);
      this.hooks.onPopup(`x${CFG.combo.tiers[after]!}`, _popupPos, 'combo');
      this.fx.burst('glow', p.x, 1.4, p.z, {
        count: 20, color: PAL.overdrive, color2: PAL.overdriveHot,
        speed: 7, size: 0.45, life: 0.5, upBias: 0.7,
      });
      if (after >= 4) this.hooks.onFlash('#ffd447', 140);
    }
  }

  private addScore(base: number, x: number, y: number, z: number, popup: boolean, label?: string): void {
    const tier = this.comboTier();
    const mult = CFG.combo.tiers[tier]! * this.stats.scoreMultiplier *
      (this.player!.overdriveActive ? CFG.overdrive.scoreScale : 1);
    const gained = Math.round(base * mult);
    this.run.score += gained;
    if (popup) {
      _popupPos.set(x, y, z);
      this.hooks.onPopup(label ?? `+${gained}`, _popupPos, label ? 'big' : 'score');
    }
  }

  // =========================================================================
  // objectives & flow
  // =========================================================================

  private checkObjectives(): void {
    if (this.boss) {
      if (this.boss.defeated && this.state === 'playing') {
        this.transitionTimer += 0;
        this.onBossDefeated();
      }
      return;
    }

    const allRescued = this.pods.remaining === 0;
    if (allRescued && !this.portalOpen) {
      this.portalOpen = true;
      this.portal!.visible = true;
      audio.play('portalOpen');
      this.hooks.onToast('Exit open!', 'portal', 2200);
      this.hooks.onFlash('#53f2ff', 200);
      const p = this.arena!.layout.portal;
      this.fx.shockwave(p.x, 0.15, p.z, 1, 16, 0.7, PAL.energy, 1);
      this.fx.burst('glow', p.x, 2, p.z, {
        count: 40, color: PAL.energy, color2: PAL.cellHot,
        speed: 10, size: 0.6, life: 0.9, upBias: 0.4,
      });
      this.pods.cheer();
    }

    if (this.portalOpen) {
      const p = this.arena!.layout.portal;
      const player = this.player!;
      if (Math.hypot(player.position.x - p.x, player.position.z - p.z) < 2.4) {
        this.completeStage();
      }
    }
  }

  private updatePortal(gdt: number): void {
    if (!this.portal || !this.portalOpen) return;
    this.portalPulse += gdt;
    const disc = this.portal.userData.disc as THREE.Mesh | undefined;
    const arms = this.portal.userData.arms as THREE.Object3D | undefined;
    const ring = this.portal.userData.ring as THREE.Mesh | undefined;
    const glow = this.portal.userData.glow as THREE.Mesh | undefined;
    if (disc) {
      disc.rotation.z += gdt * 1.6;
      const mat = disc.material as THREE.MeshBasicMaterial;
      if (mat.map) {
        mat.map.offset.x = this.portalPulse * 0.25;
        mat.map.offset.y = this.portalPulse * 0.12;
      }
      mat.opacity = 0.6 + Math.sin(this.portalPulse * 4) * 0.2;
    }
    if (arms) arms.rotation.y += gdt * 1.1;
    if (ring) ring.scale.setScalar(1 + Math.sin(this.portalPulse * 3) * 0.05);
    if (glow) {
      (glow.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(this.portalPulse * 3) * 0.12;
      glow.scale.setScalar(1 + Math.sin(this.portalPulse * 2) * 0.1);
    }
    if (Math.random() < gdt * 24) {
      const p = this.arena!.layout.portal;
      const a = Math.random() * 6.28;
      this.fx.emitOne('glow', p.x + Math.cos(a) * 1.4, 2.1 + (Math.random() - 0.5) * 2.4,
        p.z + Math.sin(a) * 1.4,
        -Math.cos(a) * 2, 0.6, -Math.sin(a) * 2,
        PAL.energy, 0.34, 0.6, 0.9, 1.5);
    }
  }

  private completeStage(): void {
    audio.play('portalEnter');
    audio.stopHover();
    this.setState('stageClear');
    this.transitionTimer = 0;
    this.hooks.onFlash('#ffffff', 400);
    this.rig.addTrauma(0.3);

    // Stage bonuses.
    const par = this.stage.par;
    const remaining = Math.max(0, par - this.run.stageTime);
    const timeBonus = Math.round(remaining * CFG.score.timeBonusPerSecond);
    this.run.score += CFG.score.stageClear + timeBonus;
    if (this.run.stageHits === 0) {
      this.run.perfectStages += 1;
      this.run.score += CFG.score.noHitStage;
      this.hooks.onToast('Perfect stage!', 'star', 2400);
    }
    this.pods.cheer();
    const p = this.player!.position;
    this.fx.burst('glow', p.x, 1.5, p.z, {
      count: 50, color: PAL.energy, color2: PAL.overdriveHot,
      speed: 13, size: 0.6, life: 1, upBias: 0.5,
    });
  }

  private offerUpgrade(): void {
    const rng = makeRandom((this.run.seed + this.run.stageIndex * 131) >>> 0);
    this.pendingUpgrades = rollUpgradeChoices(this.run.taken, rng, 3);
    if (this.pendingUpgrades.length === 0) {
      this.nextStage();
      return;
    }
    this.setState('upgrade');
    audio.setMuffle(0.75);
    audio.play('upgradeShow');
    this.hooks.onUpgradeOffer(this.pendingUpgrades, this.run.taken);
  }

  /** Called by the UI when the player taps an upgrade card. */
  pickUpgrade(id: UpgradeId): void {
    if (this.state !== 'upgrade') return;
    const upgrade = getUpgrade(id);
    upgrade.apply(this.stats);
    this.run.taken[id] = (this.run.taken[id] ?? 0) + 1;
    if (id === 'heart') this.player!.hearts = this.stats.maxHearts;
    this.player!.refreshStats();
    audio.play('upgradePick');
    audio.setMuffle(0);
    this.hooks.onHaptic(25);
    this.nextStage();
  }

  private nextStage(): void {
    const next = this.run.stageIndex + 1;
    if (next >= ALL_STAGES.length) {
      this.endRun(true);
      return;
    }
    this.loadStage(next);
  }

  private onBossEvent(e: string): void {
    switch (e) {
      case 'intro':
        audio.play('bossIntro');
        break;
      case 'slam':
        audio.play('bossSlam');
        this.rig.addTrauma(0.75);
        this.hitstop = 0.06;
        this.hooks.onHaptic([50, 30, 50]);
        break;
      case 'stagger':
        audio.play('bossPhase', { gain: 0.55, pitch: 1.3 });
        this.hooks.onToast('Dash the core!', 'dash', 1800);
        break;
      case 'phase2':
        audio.play('bossPhase');
        this.hooks.onFlash('#ff8a3d', 320);
        this.rig.addTrauma(0.6);
        this.hooks.onToast('It is getting angry!', 'warn', 2200);
        this.sky.strike(1);
        break;
      case 'phase3':
        audio.play('bossPhase', { pitch: 0.85 });
        this.hooks.onFlash('#ff5ec4', 380);
        this.rig.addTrauma(0.8);
        this.hooks.onToast('Last push!', 'warn', 2200);
        this.sky.strike(1.2);
        break;
      case 'sweepStart':
        audio.play('enemyAttack', { gain: 0.9, pitch: 0.7 });
        break;
      case 'vacuum':
        audio.play('enemyTelegraph', { gain: 0.9, pitch: 0.6 });
        break;
      default:
        break;
    }
  }

  private bossDefeatHandled = false;

  private onBossDefeated(): void {
    if (this.bossDefeatHandled) return;
    this.bossDefeatHandled = true;
    audio.play('bossDefeat');
    audio.stopHover();
    this.rig.addTrauma(1);
    this.hooks.onFlash('#ffffff', 700);
    this.run.score += CFG.score.bossDefeat;
    this.enemyHitBuffer.length = 0;
    this.enemies.vaporiseAll(this.fx, this.enemyHitBuffer);
    this.enemyHitBuffer.length = 0;
    this.setState('stageClear');
    this.transitionTimer = -2.4; // let the celebration play before the results
    this.pods.cheer();

    // Confetti + a shower of rescued Sparkies streaming out of the hatch.
    const bp = this.boss!.bossPosition;
    for (let i = 0; i < 5; i++) {
      window.setTimeout(() => {
        this.fx.burst('glow', bp.x + (Math.random() - 0.5) * 6, 3 + Math.random() * 4, bp.z, {
          count: 40, color: PAL.overdrive, color2: PAL.sparkieGlow,
          speed: 14, size: 0.6, life: 1.4, gravity: 6, drag: 1.2,
        });
        audio.play('star', { pitch: 1 + i * 0.12 });
      }, i * 260);
    }
  }

  // =========================================================================
  // end of run
  // =========================================================================

  private endRun(won: boolean): void {
    audio.stopHover();
    audio.setOverdrive(false);
    audio.setMuffle(0.5);
    input.gameplayEnabled = false;

    const summary: RunSummary = {
      score: this.run.score,
      bestCombo: this.run.bestCombo,
      sparkies: this.run.sparkies,
      bolts: this.run.bolts,
      cells: this.run.cells,
      enemies: this.run.enemies,
      dashes: this.run.dashes,
      overdrives: this.run.overdrives,
      crates: this.run.crates,
      stagesCleared: won ? ALL_STAGES.length : this.run.stageIndex,
      won,
      timeSeconds: this.run.totalTime,
      hitsTaken: this.run.hitsTaken,
      perfectStages: this.run.perfectStages,
      daily: this.run.daily,
    };
    if (won) summary.score += this.run.hitsTaken === 0 ? CFG.score.flawlessRun : 0;

    const profile = save.profile;
    const prevBest = profile.bestScore;
    const unlocks = evaluateProgress(profile, summary);

    save.update((p) => {
      p.bestScore = Math.max(p.bestScore, summary.score);
      p.bestCombo = Math.max(p.bestCombo, summary.bestCombo);
      p.totalSparkies += summary.sparkies;
      p.totalBolts += summary.bolts;
      p.totalCells += summary.cells;
      p.totalDashes += summary.dashes;
      p.totalEnemies += summary.enemies;
      p.totalOverdrives += summary.overdrives;
      if (won) {
        p.runsCompleted += 1;
        if (p.bestRunTime === null || summary.timeSeconds < p.bestRunTime) {
          p.bestRunTime = summary.timeSeconds;
        }
        if (summary.hitsTaken === 0) p.noHitRuns += 1;
      }
      if (summary.daily) {
        p.daily.bestScore = Math.max(p.daily.bestScore, summary.score);
        if (won) p.daily.completed = true;
      }
      p.highScores.push({
        score: summary.score,
        date: localDateKey(),
        stage: won ? 'Complete' : ALL_STAGES[this.run.stageIndex]!.title,
        won,
      });
      p.highScores.sort((a, b) => b.score - a.score);
      p.highScores = p.highScores.slice(0, 8);
      p.tutorialSeen = true;
    });
    save.flush();

    audio.playMusic(won ? 'victory' : 'menu', 1.0);
    audio.play(won ? 'victory' : 'gameOver');

    this.setState('results');
    this.hooks.onResults({
      score: summary.score,
      bestScore: profile.bestScore,
      newBest: summary.score > prevBest && summary.score > 0,
      bestCombo: summary.bestCombo,
      stars: starsFor(summary),
      won,
      stagesCleared: summary.stagesCleared,
      sparkies: summary.sparkies,
      enemies: summary.enemies,
      timeSeconds: summary.timeSeconds,
      hitsTaken: summary.hitsTaken,
      achievements: unlocks.achievements,
      cosmetics: unlocks.cosmetics,
      daily: summary.daily,
    });
  }

  // =========================================================================
  // pause / resume / abandon
  // =========================================================================

  pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    audio.setMuffle(1);
    audio.stopHover();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    audio.setMuffle(0);
    audio.startHover();
    input.clearBuffers();
    this.setState('playing');
  }

  /** Quit to the title screen mid-run. */
  abandon(): void {
    audio.stopHover();
    audio.setMuffle(0);
    audio.setOverdrive(false);
    this.teardownStage();
    if (this.player) {
      this.scene.remove(this.player.model.root);
      this.scene.remove(this.player.trail.mesh);
      this.player.dispose();
      this.player = null;
    }
    this.bossDefeatHandled = false;
    this.buildTitleScene();
    this.setState('title');
    audio.playMusic('menu', 1.2);
  }

  returnToTitle(): void {
    this.abandon();
  }

  retry(): void {
    this.bossDefeatHandled = false;
    const daily = this.run.daily;
    this.teardownStage();
    if (this.player) {
      this.scene.remove(this.player.model.root);
      this.scene.remove(this.player.trail.mesh);
      this.player.dispose();
      this.player = null;
    }
    audio.setMuffle(0);
    this.startRun(daily);
  }

  // =========================================================================
  // hud & tutorial
  // =========================================================================

  private refreshHud(): void {
    const player = this.player!;
    const h = this.hud;
    const tier = this.comboTier();

    this.displayScore = this.displayScore < this.run.score
      ? Math.min(this.run.score, this.displayScore + Math.max(7, (this.run.score - this.displayScore) * 0.22))
      : this.run.score;

    h.score = Math.round(this.displayScore);
    h.combo = this.run.combo;
    h.comboTier = tier;
    h.multiplier = CFG.combo.tiers[tier]!;
    h.comboProgress = this.run.comboTimer > 0 ? clamp01(this.run.comboTimer / this.stats.comboWindow) : 0;
    h.hearts = player.hearts;
    h.maxHearts = this.stats.maxHearts;
    h.shields = player.shields;
    h.maxShields = player.shieldMax;
    h.dashCharges = player.dashCharge;
    h.dashMax = this.stats.dashCharges;
    h.dashProgress = player.dashCharge >= this.stats.dashCharges
      ? 1
      : clamp01(player.dashCooldownAccum / this.stats.dashRecharge);
    h.overdrive = player.overdriveActive
      ? clamp01(player.overdriveTimer / this.stats.overdriveDuration)
      : clamp01(player.overdriveMeter / CFG.overdrive.max);
    h.overdriveActive = player.overdriveActive;
    h.overdriveReady = player.overdriveReady;
    h.sparkiesRescued = this.pods.total - this.pods.remaining;
    h.sparkiesTotal = this.pods.total;
    h.portalOpen = this.portalOpen;
    h.bossHealth = this.boss ? this.boss.healthFraction : null;
    h.bossPhase = this.boss ? this.boss.phase : 1;
    h.guide = this.computeGuide();
  }

  /**
   * Off-screen objective arrow. Only appears when the thing the player needs
   * is genuinely not visible, so it never nags.
   */
  private computeGuide(): HudData['guide'] {
    const player = this.player!;
    let target: { x: number; z: number } | null = null;
    let kind: 'pod' | 'portal' | 'boss' = 'pod';

    if (this.boss) {
      if (!this.boss.coreExposed) return null;
      const cp = this.boss.model.corePosition;
      target = { x: cp.x, z: cp.z };
      kind = 'boss';
    } else if (this.portalOpen) {
      target = this.arena!.layout.portal;
      kind = 'portal';
    } else {
      target = this.pods.nearestPod(player.position.x, player.position.z);
      kind = 'pod';
    }
    if (!target) return null;

    _guideVec.set(target.x, 1, target.z).project(this.renderer.camera);
    const onScreen = Math.abs(_guideVec.x) < 0.82 && Math.abs(_guideVec.y) < 0.78 && _guideVec.z < 1;
    if (onScreen) return null;

    // Clamp to the screen edge and point outward.
    let x = _guideVec.x;
    let y = _guideVec.y;
    if (_guideVec.z > 1) {
      x = -x;
      y = -y;
    }
    const len = Math.max(Math.abs(x), Math.abs(y)) || 1;
    x = (x / len) * 0.84;
    y = (y / len) * 0.8;
    return {
      x: (x * 0.5 + 0.5) * 100,
      y: (-y * 0.5 + 0.5) * 100,
      angle: Math.atan2(-y, x),
      kind,
    };
  }

  /**
   * Tutorial: no text dump, no gated steps. It watches what the player has
   * done and only speaks up if they seem stuck, then shuts up permanently once
   * they've done the thing.
   */
  private updateTutorial(dt: number): void {
    if (save.profile.tutorialSeen && this.run.stageIndex > 0) {
      if (this.tutorial.currentHint) {
        this.tutorial.currentHint = null;
        this.hooks.onHint(null);
      }
      return;
    }
    const t = this.tutorial;
    t.hintTimer += dt;

    let hint: string | null = null;
    let text = '';
    if (!t.moved && t.hintTimer > 1.2) {
      hint = 'move';
      text = 'Slide to move';
    } else if (!t.collected && t.hintTimer > 3.5) {
      hint = 'collect';
      text = 'Grab the bolts!';
    } else if (!t.rescued && this.pods.remaining > 0 && t.hintTimer > 8) {
      hint = 'rescue';
      text = 'Touch a pod to free a Sparkie';
    } else if (!t.dashed && t.hintTimer > 14) {
      hint = 'dash';
      text = 'Tap DASH to zoom!';
    } else if (this.player!.overdriveReady && !t.usedOverdrive) {
      hint = 'overdrive';
      text = 'Overdrive is ready!';
    } else if (this.portalOpen && !t.sawPortal) {
      t.sawPortal = true;
      hint = 'portal';
      text = 'Ride into the gate!';
    }

    if (hint !== t.currentHint) {
      t.currentHint = hint;
      this.hooks.onHint(hint, text);
    }
  }

  // =========================================================================
  // misc
  // =========================================================================

  get currentStage(): StageDef {
    return this.stage;
  }

  get stageCount(): number {
    return ALL_STAGES.length;
  }

  get playerRef(): Player | null {
    return this.player;
  }

  get enemiesRef(): Enemies {
    return this.enemies;
  }

  get podsRef(): SparkiePods {
    return this.pods;
  }

  get collectiblesRef(): Collectibles {
    return this.collectibles;
  }

  get bossRef(): BossFight | null {
    return this.boss;
  }

  get arenaRef(): Arena | null {
    return this.arena;
  }

  get runRef(): RunState {
    return this.run;
  }

  get dailyModifiers(): DailyModifier[] {
    return this.dailyMods;
  }

  /**
   * Ground hazards the player is expected to route around, as simple circles.
   * Used by the playtest bot; the human equivalent is just looking at them.
   */
  collectHazards(out: Array<{ x: number; z: number; r: number }>): void {
    const arena = this.arena;
    if (!arena) return;
    for (const fan of arena.layout.fans) out.push({ x: fan.x, z: fan.z, r: fan.radius + 1.1 });
    for (const vent of this.vents) {
      const phase = (this.run.stageTime + vent.offset) % vent.period;
      if (phase > vent.period - 1.6) out.push({ x: vent.x, z: vent.z, r: 2.6 });
    }
    for (let i = 0; i < arena.layout.barriers.length; i++) {
      const def = arena.layout.barriers[i]!;
      arena.barrierPosition(i, _barrierPos);
      // Approximate the wall with three circles along its length.
      for (let k = -1; k <= 1; k++) {
        out.push({
          x: _barrierPos.x + Math.cos(def.angle) * def.width * 0.32 * k,
          z: _barrierPos.z + Math.sin(def.angle) * def.width * 0.32 * k,
          r: 2.1,
        });
      }
    }
  }

  /** Equip a cosmetic mid-session. */
  equip(kind: 'trail' | 'board', id: string): void {
    if (kind === 'trail') {
      save.update((p) => {
        p.equipped.trail = id;
      });
      this.player?.setTrail(id);
    } else {
      save.update((p) => {
        p.equipped.board = id;
      });
      this.player?.model.setBoardSkin(id);
    }
  }

  dispose(): void {
    this.clearTitleScene();
    this.teardownStage();
    this.player?.dispose();
    this.fx.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}

const _popupPos = new THREE.Vector3();
const _guideVec = new THREE.Vector3();
const _barrierPos = { x: 0, z: 0 };
const _chainA = new THREE.Vector3();
const _chainB = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _basis = new THREE.Matrix4();
