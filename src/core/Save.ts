import { localDateKey } from './Util';

/**
 * Local-only persistence. No account, no server, no personal data — the entire
 * profile is a single JSON blob written to IndexedDB (durable, survives cache
 * pressure better than localStorage) and mirrored to localStorage so the first
 * frame can read settings synchronously without waiting on an async open.
 */

const DB_NAME = 'rivet-rush';
const DB_VERSION = 1;
const STORE = 'profile';
const KEY = 'main';
const MIRROR = 'rivet-rush:profile';
const PROFILE_VERSION = 1;

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  /** Cuts camera shake, screen flashes and heavy particle bursts. */
  reducedMotion: boolean;
  /** 0 = off, 1 = full. Independent from reducedMotion so players can tune it. */
  screenShake: number;
  haptics: boolean;
  quality: QualityLevel;
  showFps: boolean;
  /** Mirrors the touch layout for left-handed players. */
  leftHanded: boolean;
  /** Extra-large HUD text and controls. */
  bigUI: boolean;
}

export interface HighScore {
  score: number;
  date: string;
  stage: string;
  won: boolean;
}

export interface Profile {
  version: number;
  settings: Settings;
  bestScore: number;
  bestCombo: number;
  bestRunTime: number | null;
  runsStarted: number;
  runsCompleted: number;
  totalSparkies: number;
  totalBolts: number;
  totalCells: number;
  totalDashes: number;
  totalEnemies: number;
  totalOverdrives: number;
  noHitRuns: number;
  /** achievement id -> epoch ms it was earned. */
  achievements: Record<string, number>;
  /** cosmetic/unlock ids the player owns. */
  unlocked: string[];
  equipped: { trail: string; board: string };
  daily: { date: string; bestScore: number; completed: boolean; played: number };
  tutorialSeen: boolean;
  seenIntro: boolean;
  highScores: HighScore[];
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.85,
  music: 0.6,
  sfx: 0.9,
  reducedMotion: false,
  screenShake: 1,
  haptics: true,
  quality: 'auto',
  showFps: false,
  leftHanded: false,
  bigUI: false,
};

export function defaultProfile(): Profile {
  return {
    version: PROFILE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    bestScore: 0,
    bestCombo: 0,
    bestRunTime: null,
    runsStarted: 0,
    runsCompleted: 0,
    totalSparkies: 0,
    totalBolts: 0,
    totalCells: 0,
    totalDashes: 0,
    totalEnemies: 0,
    totalOverdrives: 0,
    noHitRuns: 0,
    achievements: {},
    unlocked: ['trail:cyan', 'board:classic'],
    equipped: { trail: 'cyan', board: 'classic' },
    daily: { date: '', bestScore: 0, completed: false, played: 0 },
    tutorialSeen: false,
    seenIntro: false,
    highScores: [],
  };
}

/** Fills in anything a newer build added without wiping an old profile. */
function migrate(raw: unknown): Profile {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Partial<Profile>;
  const merged: Profile = {
    ...base,
    ...p,
    version: PROFILE_VERSION,
    settings: { ...base.settings, ...(p.settings ?? {}) },
    equipped: { ...base.equipped, ...(p.equipped ?? {}) },
    daily: { ...base.daily, ...(p.daily ?? {}) },
    achievements: { ...(p.achievements ?? {}) },
    unlocked: Array.isArray(p.unlocked) ? [...new Set([...base.unlocked, ...p.unlocked])] : base.unlocked,
    highScores: Array.isArray(p.highScores) ? p.highScores.slice(0, 8) : [],
  };
  // Clamp anything a hand-edited profile could break.
  const s = merged.settings;
  s.master = clampNum(s.master, 0, 1, base.settings.master);
  s.music = clampNum(s.music, 0, 1, base.settings.music);
  s.sfx = clampNum(s.sfx, 0, 1, base.settings.sfx);
  s.screenShake = clampNum(s.screenShake, 0, 1, base.settings.screenShake);
  if (!['auto', 'low', 'medium', 'high'].includes(s.quality)) s.quality = 'auto';
  return merged;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      // Private-mode Safari can hang here; don't let it stall the boot.
      setTimeout(() => resolve(req.readyState === 'done' ? req.result ?? null : null), 1500);
    } catch {
      resolve(null);
    }
  });
}

export class SaveStore {
  profile: Profile = defaultProfile();
  private db: IDBDatabase | null = null;
  private writeTimer: number | null = null;
  private ready = false;

  /** Synchronous best-effort read so the very first frame has real settings. */
  loadMirror(): Profile {
    try {
      const raw = localStorage.getItem(MIRROR);
      if (raw) this.profile = migrate(JSON.parse(raw));
    } catch {
      /* storage blocked — run with defaults */
    }
    this.rolloverDaily();
    return this.profile;
  }

  async load(): Promise<Profile> {
    this.loadMirror();
    this.db = await openDb();
    if (this.db) {
      const fromDb = await new Promise<unknown>((resolve) => {
        try {
          const tx = this.db!.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).get(KEY);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (fromDb) {
        const dbProfile = migrate(fromDb);
        // Prefer whichever store has more progress; they only diverge if one
        // of the two was evicted.
        if (dbProfile.runsStarted >= this.profile.runsStarted) this.profile = dbProfile;
      }
    }
    this.ready = true;
    this.rolloverDaily();
    this.save();
    return this.profile;
  }

  /** Resets the daily-challenge record when the local date changes. */
  private rolloverDaily(): void {
    const today = localDateKey();
    if (this.profile.daily.date !== today) {
      this.profile.daily = { date: today, bestScore: 0, completed: false, played: 0 };
    }
  }

  /** Debounced write-through to both stores. */
  save(): void {
    try {
      localStorage.setItem(MIRROR, JSON.stringify(this.profile));
    } catch {
      /* quota or private mode — IndexedDB may still work */
    }
    if (!this.ready || !this.db) return;
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 350) as unknown as number;
  }

  /** Immediate write — used on pagehide so nothing is lost when tabbing away. */
  flush(): void {
    try {
      localStorage.setItem(MIRROR, JSON.stringify(this.profile));
    } catch {
      /* ignore */
    }
    if (!this.db) return;
    try {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(JSON.parse(JSON.stringify(this.profile)), KEY);
    } catch {
      /* ignore */
    }
  }

  update(fn: (p: Profile) => void): void {
    fn(this.profile);
    this.save();
  }

  resetProgress(): void {
    const settings = { ...this.profile.settings };
    this.profile = defaultProfile();
    this.profile.settings = settings;
    this.flush();
  }
}

export const save = new SaveStore();
