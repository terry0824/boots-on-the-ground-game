/**
 * The player's persistent record, kept in the browser: callsign, rank and experience,
 * credits, Armory upgrades, mission results and medals, and settings. Everything a reload or
 * a new mission needs to carry over.
 */

export interface Settings {
  sensitivity: number;
  invertY: boolean;
  fov: number;
  volume: { master: number; music: number; sfx: number; voice: number; ambience: number };
  /** The graphics preset: 0 low, 1 medium, 2 high, 3 ultra, 4 custom (the details as set). */
  quality: number;
  /** The graphics details (a preset sets them all). */
  graphics: Graphics;
  subtitles: boolean;
  /** Hit markers in shapes and colors that don't rely on red. */
  colorblind: boolean;
}

/**
 * Graphics details, each a level: shadows 0 off (soft ground shadows only), 1 low, 2 medium,
 * 3 high (the shadow map's resolution and reach); particles 0 low, 1 medium, 2 high (how much of
 * each emitter is drawn, and how far off); effects 0 off, 1 on (bloom, grade, multisampling);
 * resolution 0 three quarters, 1 one pixel per screen pixel, 2 and 3 more on high-density
 * screens.
 */
export interface Graphics {
  shadows: number;
  particles: number;
  effects: number;
  resolution: number;
}

export const QUALITY_PRESETS = ['Low', 'Medium', 'High', 'Ultra'] as const;

/** What each preset sets. */
export const PRESETS: Graphics[] = [
  { shadows: 0, particles: 0, effects: 0, resolution: 0 },
  { shadows: 1, particles: 1, effects: 1, resolution: 1 },
  { shadows: 2, particles: 2, effects: 1, resolution: 2 },
  { shadows: 3, particles: 2, effects: 1, resolution: 3 },
];

export interface MissionRecord {
  completed: boolean;
  /** Best rating, 0-3 stars. */
  stars: number;
  bestTime: number | null;
  bonus: string[];
  /** Hardest difficulty won on (0 casual .. 3 brutal), -1 if never. */
  difficulty: number;
  medals: string[];
}

export interface Profile {
  version: 1;
  callsign: string;
  xp: number;
  credits: number;
  /** Armory upgrades bought, by id, with their level. */
  upgrades: Record<string, number>;
  missions: Record<string, MissionRecord>;
  stats: { kills: number; deaths: number; shots: number; hits: number; missions: number; playSeconds: number };
  /** Best wave reached in Last Stand. */
  lastStandBest: number;
  /** The class the player deploys as. */
  loadout: string;
  settings: Settings;
  /** Echo Squad's fallen: each squadmate lost, by the mission they fell in (see echo.ts). */
  echo: Record<string, string>;
}

export const RANKS = [
  { name: 'Private', xp: 0 },
  { name: 'Private First Class', xp: 600 },
  { name: 'Corporal', xp: 1600 },
  { name: 'Sergeant', xp: 3600 },
  { name: 'Staff Sergeant', xp: 6500 },
  { name: 'Lieutenant', xp: 10500 },
  { name: 'Captain', xp: 16000 },
  { name: 'Major', xp: 24000 },
  { name: 'Commander', xp: 36000 },
] as const;

export const DIFFICULTIES = ['Casual', 'Normal', 'Hard', 'Brutal'] as const;

/** Automated test runs keep their own profile, so they never touch the player's. */
const KEY = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test') ? 'botg.profile.test' : 'botg.profile.v1';

export function defaultSettings(): Settings {
  return {
    sensitivity: 1,
    invertY: false,
    fov: 74,
    volume: { master: 0.9, music: 0.8, sfx: 1, voice: 1, ambience: 0.8 },
    quality: 2,
    graphics: { ...PRESETS[2] },
    subtitles: true,
    colorblind: false,
  };
}

function fresh(): Profile {
  return {
    version: 1,
    callsign: 'Holdout',
    xp: 0,
    credits: 0,
    upgrades: {},
    missions: {},
    stats: { kills: 0, deaths: 0, shots: 0, hits: 0, missions: 0, playSeconds: 0 },
    lastStandBest: 0,
    loadout: 'trooper',
    settings: defaultSettings(),
    echo: {},
  };
}

/** Loads the profile; a fresh one if there's none, it's unreadable, or storage is blocked. */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const p = JSON.parse(raw) as Profile;
    if (p.version !== 1) return fresh();
    // Fill in fields added since the profile was saved.
    const base = fresh();
    const settings = { ...base.settings, ...p.settings, volume: { ...base.settings.volume, ...p.settings?.volume } };
    // Saved before the details existed: the preset it had sets them.
    if (!p.settings?.graphics) settings.graphics = { ...PRESETS[Math.min(settings.quality, PRESETS.length - 1)] };
    return { ...base, ...p, settings, stats: { ...base.stats, ...p.stats }, echo: { ...p.echo } };
  } catch {
    return fresh();
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage blocked (private window): progress lasts for this session only.
  }
}

/** Rank index for an experience total. */
export function rankOf(xp: number): number {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].xp) r = i;
  return r;
}

/** Progress (0..1) from the current rank to the next. */
export function rankProgress(xp: number): number {
  const r = rankOf(xp);
  if (r >= RANKS.length - 1) return 1;
  return (xp - RANKS[r].xp) / (RANKS[r + 1].xp - RANKS[r].xp);
}

export function record(p: Profile, mission: string): MissionRecord {
  return (p.missions[mission] ??= { completed: false, stars: 0, bestTime: null, bonus: [], difficulty: -1, medals: [] });
}
