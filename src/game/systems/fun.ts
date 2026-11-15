import type { PlayerStats } from '../avatar.ts';
import type { Entity } from '../entity.ts';

/**
 * A fun meter (docs/the-tide-unleashed.md, section 8): the three things a hold should be, stress,
 * a sense of achievement and a smooth flow, as numbers the game logs while it's played, each
 * checked against a band. The bands are a first guess, to be fitted to the runs that felt best.
 *
 * - Stress: the director's own intensity (Left 4 Dead's), how often it peaks, how outnumbered the
 *   army looks, close calls.
 * - Achievement: the player's kills a minute in each body, power moments (a burst of kills, a big
 *   one brought down, a line retaken), the player's share of the kills, how close the win was.
 * - Flow: time in a body with something to shoot, time out of one, how soon after a spawn the
 *   first shot comes, deaths that weren't fair (from full life in a moment), frame time.
 */

/** A burst of kills within this many seconds, of at least this many, is a power moment. */
const BURST = { seconds: 2, kills: 8 };
/** Crawl whose death is a power moment of its own. */
const BIG = new Set(['tusker', 'sower', 'lantern']);
/** Intensity at or over this is a peak; a peak this long counts. */
const PEAK = 0.75;
const PEAK_SECONDS = 5;
/** A death within this many seconds of full life wasn't the player's fault. */
const UNFAIR_SECONDS = 2;

export interface FunState {
  /** The director's intensity, 0..1. */
  intensity: number;
  /** The player's body, or null between bodies. */
  body: Entity | null;
  /** Something the body can hit is within its reach. */
  engaged: boolean;
  /** The armies, in supply. */
  swarm: number;
  army: number;
  /** The Holdfast's life, as a share. */
  base: number;
  brokenLines: number;
  /** The share of the hold gone. */
  progress: number;
}

interface Band {
  /** What it measures, for the report. */
  label: string;
  value: number;
  lo: number;
  hi: number;
  /** As the report shows it. */
  unit?: string;
}

export interface FunReport {
  minutes: number;
  stress: Band[];
  achievement: Band[];
  flow: Band[];
  /** Each part's score (0..1: 1 inside every band) and the whole. */
  scores: { stress: number; achievement: number; flow: number; fun: number };
  /** Kills a minute by body. */
  bodies: Record<string, { minutes: number; kills: number; engaged: number }>;
  moments: { at: number; what: string }[];
}

/** 1 inside the band, falling to 0 at twice the band's width outside it. */
function scoreOf(b: Band): number {
  const width = Math.max(1e-6, b.hi - b.lo);
  const out = b.value < b.lo ? b.lo - b.value : b.value > b.hi ? b.value - b.hi : 0;
  return Math.max(0, 1 - out / (2 * width));
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export class FunMeter {
  private t = 0;
  private sampleIn = 0;
  private intensity: number[] = [];
  private peaks = 0;
  private peakFor = 0;
  private lastPeak = 0;
  private longestCalm = 0;
  private pressure: number[] = [];
  private closeCalls = 0;
  private lowBase = false;
  private broken = 0;
  private kills: number[] = [];
  private bigKills = 0;
  private moments: { at: number; what: string }[] = [];
  private lastMoment = -Infinity;
  private bodies = new Map<string, { minutes: number; kills: number; engaged: number }>();
  private body: Entity | null = null;
  private outOfBody = 0;
  private spawnedAt = 0;
  private shotsAtSpawn = 0;
  private toAction: number[] = [];
  private fullLifeAt = 0;
  private deaths = 0;
  private unfair = 0;
  private teamKills = 0;
  private frames: number[] = [];
  private won: boolean | null = null;
  private baseAtEnd = 1;

  constructor(private stats: PlayerStats) {}

  update(dt: number, s: FunState) {
    this.t += dt;
    // The body: a new one is a spawn; none is time out of the fight.
    if (s.body !== this.body) {
      this.body = s.body;
      if (s.body) {
        this.spawnedAt = this.t;
        this.shotsAtSpawn = this.stats.shots;
        this.fullLifeAt = this.t;
      }
    }
    if (!s.body) this.outOfBody += dt;
    else {
      const b = this.bodyOf(s.body.kind.name);
      b.minutes += dt / 60;
      if (s.engaged) b.engaged += dt / 60;
      if (s.body.hp >= s.body.maxHp * 0.98) this.fullLifeAt = this.t;
      if (this.spawnedAt >= 0 && this.stats.shots > this.shotsAtSpawn) {
        this.toAction.push(this.t - this.spawnedAt);
        this.spawnedAt = -1;
      }
    }
    // Stress, once a second.
    this.sampleIn -= dt;
    if (this.sampleIn > 0) return;
    this.sampleIn = 1;
    this.intensity.push(s.intensity);
    if (s.intensity >= PEAK) {
      this.peakFor += 1;
      if (this.peakFor === PEAK_SECONDS) {
        this.peaks++;
        this.longestCalm = Math.max(this.longestCalm, this.t - this.lastPeak);
        this.lastPeak = this.t;
      }
    } else this.peakFor = 0;
    if (s.progress > 0.5 && s.army > 0) this.pressure.push(s.swarm / s.army);
    const low = s.base < 0.6;
    if (low && !this.lowBase) this.closeCalls++;
    this.lowBase = low;
    if (s.brokenLines < this.broken) {
      this.closeCalls++;
      this.moment('A line retaken');
    }
    this.broken = s.brokenLines;
    this.baseAtEnd = s.base;
  }

  private bodyOf(kind: string) {
    let b = this.bodies.get(kind);
    if (!b) this.bodies.set(kind, (b = { minutes: 0, kills: 0, engaged: 0 }));
    return b;
  }

  private moment(what: string) {
    // One moment at a time: a burst that keeps going is one burst.
    if (this.t - this.lastMoment < BURST.seconds) return;
    this.lastMoment = this.t;
    this.moments.push({ at: Math.round(this.t), what });
  }

  /** The player killed `e`. */
  kill(e: Entity) {
    this.kills.push(this.t);
    if (this.body) this.bodyOf(this.body.kind.name).kills++;
    while (this.kills.length && this.t - this.kills[0] > BURST.seconds) this.kills.shift();
    if (this.kills.length >= BURST.kills) this.moment(`${this.kills.length} kills in ${BURST.seconds} s`);
    if (BIG.has(e.kind.name)) {
      this.bigKills++;
      this.moment(`Brought down a${/^[aeiou]/i.test(e.kind.name) ? 'n' : ''} ${e.kind.name.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
    }
  }

  /** Anyone on the player's side killed something: the share that was the player's. */
  teamKill() {
    this.teamKills++;
  }

  /** The player's body went down. */
  death() {
    this.deaths++;
    if (this.t - this.fullLifeAt < UNFAIR_SECONDS) this.unfair++;
  }

  /** A rendered frame took `ms`. */
  frame(ms: number) {
    this.frames.push(ms);
    if (this.frames.length > 20000) this.frames.splice(0, 10000);
  }

  end(won: boolean) {
    this.won = won;
  }

  report(): FunReport {
    const minutes = this.t / 60;
    const k = this.stats.kills;
    const intensity = mean(this.intensity);
    const share = (x: number) => x / Math.max(1, this.intensity.length);
    const atPeak = share(this.intensity.filter((i) => i >= PEAK).length);
    const calm = share(this.intensity.filter((i) => i <= 0.3).length);
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const bodies: FunReport['bodies'] = {};
    for (const [name, b] of this.bodies) bodies[name] = { minutes: +b.minutes.toFixed(1), kills: b.kills, engaged: +(b.engaged / Math.max(1e-6, b.minutes)).toFixed(2) };
    const alive = [...this.bodies.values()].reduce((a, b) => a + b.minutes, 0);
    const engaged = [...this.bodies.values()].reduce((a, b) => a + b.engaged, 0) / Math.max(1e-6, alive);
    const worstBody = Math.min(1, ...[...this.bodies.values()].filter((b) => b.minutes > 0.5).map((b) => b.engaged / b.minutes));
    const stress: Band[] = [
      { label: 'Mean intensity', value: intensity, lo: 0.45, hi: 0.6 },
      { label: 'Time at peak', value: atPeak, lo: 0.15, hi: 0.3, unit: '%' },
      { label: 'Time calm', value: calm, lo: 0.15, hi: 0.25, unit: '%' },
      { label: 'Peaks a 14-minute hold', value: (this.peaks / Math.max(1e-6, minutes)) * 14, lo: 5, hi: 8 },
      { label: 'Longest wait for a peak', value: Math.max(this.longestCalm, this.t - this.lastPeak), lo: 30, hi: 150, unit: 's' },
      { label: 'Crawl to army, second half', value: mean(this.pressure), lo: 1.3, hi: 2 },
      { label: 'Close calls', value: this.closeCalls, lo: 1, hi: 3 },
    ];
    const achievement: Band[] = [
      { label: 'Kills a minute', value: k / Math.max(1e-6, minutes), lo: 25, hi: 100 },
      { label: 'Power moments a minute', value: this.moments.length / Math.max(1e-6, minutes), lo: 1, hi: 2 },
      { label: 'Big Crawl brought down', value: this.bigKills, lo: 3, hi: 20 },
      { label: 'Share of the kills', value: k / Math.max(1, this.teamKills), lo: 0.15, hi: 0.35, unit: '%' },
      ...(this.won === null ? [] : [{ label: 'Holdfast left at the end', value: this.won ? this.baseAtEnd : 0, lo: 0.3, hi: 0.8, unit: '%' }]),
    ];
    const flow: Band[] = [
      { label: 'Time with a target in reach', value: engaged, lo: 0.7, hi: 1, unit: '%' },
      { label: 'Time out of a body', value: this.outOfBody / Math.max(1e-6, this.t), lo: 0, hi: 0.1, unit: '%' },
      { label: 'Spawn to first shot (median)', value: [...this.toAction].sort((a, b) => a - b)[Math.floor(this.toAction.length / 2)] ?? 0, lo: 0, hi: 8, unit: 's' },
      { label: 'Deaths that weren’t fair', value: this.unfair / Math.max(1, this.deaths), lo: 0, hi: 0.15, unit: '%' },
      ...(sorted.length ? [{ label: 'Frame time, 95th percentile', value: p95, lo: 0, hi: 16.7, unit: 'ms' }] : []),
      ...(this.bodies.size > 1 ? [{ label: 'Least-engaged body', value: worstBody, lo: 0.6, hi: 1, unit: '%' }] : []),
    ];
    const part = (b: Band[]) => (b.length ? b.reduce((a, x) => a + scoreOf(x), 0) / b.length : 0);
    const scores = { stress: part(stress), achievement: part(achievement), flow: part(flow), fun: 0 };
    scores.fun = 0.35 * scores.stress + 0.35 * scores.achievement + 0.3 * scores.flow;
    return { minutes: +minutes.toFixed(1), stress, achievement, flow, scores, bodies, moments: this.moments };
  }
}

/** The report as lines for the console or a debrief. */
export function describe(r: FunReport): string[] {
  const fmt = (b: Band) => {
    const v = b.unit === '%' ? `${Math.round(b.value * 100)}%` : b.unit ? `${b.value.toFixed(b.value < 10 ? 1 : 0)} ${b.unit}` : b.value.toFixed(b.value < 10 ? 2 : 0);
    const band = b.unit === '%' ? `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%` : `${b.lo}–${b.hi}${b.unit && b.unit !== '%' ? ' ' + b.unit : ''}`;
    return `${scoreOf(b) >= 1 ? '✓' : '·'} ${b.label}: ${v} (band ${band})`;
  };
  const pct = (x: number) => `${Math.round(x * 100)}`;
  return [
    `Fun ${pct(r.scores.fun)} · stress ${pct(r.scores.stress)} · achievement ${pct(r.scores.achievement)} · flow ${pct(r.scores.flow)} (${r.minutes} min)`,
    'Stress', ...r.stress.map(fmt),
    'Achievement', ...r.achievement.map(fmt),
    'Flow', ...r.flow.map(fmt),
    `Bodies: ${Object.entries(r.bodies).map(([k, b]) => `${k} ${b.minutes} min, ${b.kills} kills, engaged ${Math.round(b.engaged * 100)}%`).join('; ')}`,
  ];
}
