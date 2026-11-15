import type { HudBar } from './avatar.ts';
import type { KindName } from './kinds.ts';

/**
 * What a body's Q calls: the Lodestar's Keel Gun, a Seer's Warhead Strike, and where a mode
 * gives each body its own (The Tide: Unleashed), the rest (systems/ultimates.ts).
 */
export type UltimateId =
  | 'keelGun'
  | 'warhead'
  | 'superJolt'
  | 'stagger'
  | 'napalm'
  | 'triage'
  | 'clusterbomb'
  | 'creep'
  | 'igniter'
  | 'scatter'
  | 'volleylock'
  | 'minefield'
  | 'phantom'
  | 'missileStorm'
  | 'evacuation'
  | 'storm'
  | 'carpet';

/**
 * Points each takes to charge: the score's own points (a Hound is worth 10, a Quillback 25,
 * an Tusker 150; assists, heals and objectives pay too). A Keel Gun is a couple of minutes of
 * steady fighting, a warhead rather more.
 */
export const ULTIMATE_COST: Record<UltimateId, number> = {
  keelGun: 700,
  warhead: 1000,
  superJolt: 600,
  stagger: 650,
  napalm: 650,
  triage: 700,
  clusterbomb: 350,
  creep: 800,
  igniter: 650,
  scatter: 700,
  volleylock: 700,
  minefield: 600,
  phantom: 650,
  missileStorm: 750,
  evacuation: 500,
  storm: 900,
  carpet: 750,
};
/** Each body's own ultimate, where a mode gives each one (systems/ultimates.ts; the Seer's warhead, trooper.ts). */
export const UNIT_ULTIMATES: Partial<Record<KindName, UltimateId>> = {
  trooper: 'superJolt',
  grenadier: 'stagger',
  burner: 'napalm',
  medic: 'triage',
  seer: 'warhead',
  vaulter: 'clusterbomb',
  howitzer: 'creep',
  howitzerMobile: 'creep',
  torchrunner: 'igniter',
  jackknifeFighter: 'scatter',
  jackknifeAssault: 'scatter',
  picket: 'volleylock',
  coyote: 'minefield',
  swift: 'phantom',
  frigate: 'missileStorm',
  dustoff: 'evacuation',
  bulwark: 'storm',
  behemoth: 'storm',
  nightjar: 'carpet',
};

/** Points a second for being in a body at all: a Keel Gun in about twelve minutes on its own. */
const TRICKLE = 1;
/** Seconds a fast charge takes, from empty (the Practice Range). */
const FAST_SECONDS = 10;

/**
 * How the charge comes: by fighting, as everywhere but the Practice Range; there, `fast` (full in
 * ten seconds) or `instant` (full again as soon as what the last one set going is over).
 */
export type Charging = 'normal' | 'fast' | 'instant';
/** What a new body keeps of the charge. */
export const CARRY = 0.5;

const ORANGE = 'linear-gradient(90deg, #ff9a40, #ffe0a0)';
const RED = 'linear-gradient(90deg, #ff3a2a, #ffb04a)';
const GREEN = 'linear-gradient(90deg, #5ad08a, #c0ffd8)';
const BLUE = 'linear-gradient(90deg, #5aa8ff, #bfe4ff)';
export const LOOK: Record<UltimateId, { label: string; ready: string; color: string }> = {
  keelGun: { label: 'Keel Gun', ready: 'Ready', color: ORANGE },
  warhead: { label: 'Warhead Strike', ready: 'Armed', color: RED },
  superJolt: { label: 'Super Jolt', ready: 'Ready · Troopers near you, 12 s', color: RED },
  stagger: { label: 'Stagger Barrage', ready: 'Ready · 12 grenades ahead', color: ORANGE },
  napalm: { label: 'Napalm Wall', ready: 'Ready · a wall of fire ahead', color: RED },
  triage: { label: 'Triage', ready: 'Ready · heals everyone near you', color: GREEN },
  clusterbomb: { label: 'Clusterbomb', ready: 'Ready · five charges ahead', color: ORANGE },
  creep: { label: 'Creeping Barrage', ready: 'Ready · sieged: eight shells', color: ORANGE },
  igniter: { label: 'Wildfire Run', ready: 'Ready · a trail of fire for 6 s', color: RED },
  scatter: { label: 'Scatter Missiles', ready: 'Ready · every flyer in reach', color: BLUE },
  volleylock: { label: 'Volley Lock', ready: 'Ready · Seekers at eight flyers', color: BLUE },
  minefield: { label: 'Minefield', ready: 'Ready · six Spider Mines round you', color: ORANGE },
  phantom: { label: 'Phantom Run', ready: 'Ready · cloak, double fire, 8 s', color: BLUE },
  missileStorm: { label: 'Missile Storm', ready: 'Ready · 30 rockets at flyers', color: BLUE },
  evacuation: { label: 'Evacuation', ready: 'Ready · takes the wounded aboard', color: GREEN },
  storm: { label: 'Lance Storm', ready: 'Ready · a missile fan ahead', color: ORANGE },
  carpet: { label: 'Carpet Bombing', ready: 'Ready · bombs along your path', color: RED },
};

/**
 * The ultimate (Q), as a shooter's ultimate rather than a cooldown: the body's call-in charges
 * from the points the player earns fighting (kills, assists, heals, objectives) and a slow
 * trickle, and is spent whole. What the strike itself kills earns nothing. Charge doesn't
 * travel freely between bodies, or it could be banked as a Trooper and spent as a Seer: a new
 * body (a redeploy, taking over another unit) starts with half, and a death costs half (the
 * body after it doesn't halve it again). The same soldier into a vehicle and back out keeps it.
 */
export class Ultimate {
  points = 0;
  /** What each costs here. */
  readonly costs: Record<UltimateId, number> = { ...ULTIMATE_COST };
  /** What the body the player is in calls, or null for a body that has none. */
  id: UltimateId | null = null;
  /** Until when points earned don't count (its own strike's kills). */
  private lockedUntil = -Infinity;
  /** A death has already taken its half from the body that follows. */
  private afterDeath = false;
  private last: object | null = null;
  /** How it charges (`Charging`). Past `normal`, a new body keeps all of it. */
  charging: Charging = 'normal';

  get cost(): number {
    return this.id ? this.costs[this.id] : Infinity;
  }

  /** 0..1, how charged. */
  get fraction(): number {
    return this.id ? Math.min(1, this.points / this.cost) : 0;
  }

  get ready(): boolean {
    return !!this.id && this.points >= this.cost;
  }

  earn(points: number, time: number) {
    if (!this.id || time < this.lockedUntil) return;
    this.points = Math.min(this.cost, this.points + points);
  }

  /** Charged in full (a drill that teaches it). */
  fill() {
    if (this.id) this.points = this.cost;
  }

  /** The trickle, while the player is in a body (or the Practice Range's quick charge, once the last one is over). */
  update(dt: number, time: number) {
    if (this.charging === 'normal' || !this.id || time < this.lockedUntil) this.earn(TRICKLE * dt, time);
    else if (this.charging === 'instant') this.points = this.cost;
    else this.points = Math.min(this.cost, this.points + (this.cost / FAST_SECONDS) * dt);
  }

  /**
   * The player is in `body` now, whose Q calls `id`. Half the charge comes along, unless it's
   * the body they were just in, `keep` (the same soldier into a vehicle or out of it), or a
   * death already took its half.
   */
  enter(body: object, id: UltimateId | null, keep = false) {
    if (!keep && !this.afterDeath && body !== this.last && this.charging === 'normal') this.points *= CARRY;
    // On the range, a new body's charge isn't held back by what the last one set going.
    if (body !== this.last && this.charging !== 'normal') this.lockedUntil = -Infinity;
    this.afterDeath = false;
    this.last = body;
    this.id = id;
    if (id) this.points = Math.min(this.points, this.costs[id]);
  }

  died() {
    if (!this.afterDeath && this.charging === 'normal') this.points *= CARRY;
    this.afterDeath = true;
    this.last = null;
  }

  /** Why F can't fire now, or null. */
  refusal(): string | null {
    if (!this.id) return 'Nothing to call';
    return this.ready ? null : `Charging · ${Math.floor(this.fraction * 100)}%`;
  }

  /** Spent: the charge is gone, and what the strike kills over the next `seconds` earns nothing. */
  spend(time: number, seconds: number) {
    this.points = 0;
    this.lockedUntil = time + seconds;
  }

  /** The HUD's bar for it; `busy` overrides it while the strike is under way. */
  bar(busy?: { value: number; text: string } | null): HudBar | null {
    if (!this.id) return null;
    const look = LOOK[this.id];
    if (busy) return { label: look.label, key: 'Q', value: busy.value, text: busy.text, color: look.color };
    return { label: look.label, key: 'Q', value: this.fraction, text: this.ready ? look.ready : `Charging · ${Math.floor(this.fraction * 100)}%`, color: look.color };
  }
}
