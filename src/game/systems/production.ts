import { FASTER, type Stats } from '../stats.ts';
import { dataOf, type Kind, type KindName } from '../kinds.ts';
import type { Treasury } from './economy.ts';

/**
 * Production, for any mode that buys its reinforcements: a catalog of squads, priced from the
 * data (its units' costs and train times), and the queues of the buildings that turn them out.
 * Each kind of producer works on a few squads at once (its bays) and keeps a few more waiting; a
 * building of that kind put up later (construction) adds its own bays. The army is capped at a
 * supply (200 by default).
 */

export type Producer = 'barracks' | 'motorPool' | 'airfield';

/** What a squad is: the board's key and name, where it's built, and what's in it. */
export interface SquadDef {
  /** What orders name it by (a requisition's `offer`). */
  key: string;
  /**
   * The letter that orders it on the board, within its building (picked by 1-3): its train
   * hotkey in the usual RTS layout (the grid layout's where that would be G, the board's own
   * key). `also`: other letters that order it too (M for Troopers).
   */
  hotkey: string;
  also?: string[];
  label: string;
  producer: Producer;
  units: [KindName, number][];
  air?: boolean;
  /** What the whole squad costs, where a mode prices it its own way (The Tide: Unleashed's power is dear); the data's otherwise. */
  cost?: { ore: number; gas: number };
  /** At most this many of its first kind in the field and on order at once (The Tide: Unleashed's one Behemoth). */
  limit?: number;
}

/** A squad the board offers: its definition, and (from the data) what it costs and takes. */
export interface Offer extends SquadDef {
  ore: number;
  gas: number;
  supply: number;
  /** Real seconds to build. */
  seconds: number;
  air: boolean;
}

/** The squads a human base turns out: by building, and the hotkey that trains each in it. */
export const HOLDOUTS_SQUADS: SquadDef[] = [
  { key: '1', hotkey: 'A', also: ['M'], label: 'Troopers', producer: 'barracks', units: [['trooper', 6]] },
  { key: '2', hotkey: 'D', label: 'Grenadiers', producer: 'barracks', units: [['grenadier', 3]] },
  { key: '3', hotkey: 'F', label: 'Burners', producer: 'barracks', units: [['burner', 3]] },
  { key: '4', hotkey: 'E', label: 'Medics', producer: 'barracks', units: [['medic', 2]] },
  { key: '5', hotkey: 'R', label: 'Seers', producer: 'barracks', units: [['seer', 2]] },
  { key: '6', hotkey: 'S', label: 'Howitzer', producer: 'motorPool', units: [['howitzerMobile', 1]] },
  { key: '7', hotkey: 'E', label: 'Torchrunners', producer: 'motorPool', units: [['torchrunner', 3]] },
  { key: '8', hotkey: 'T', label: 'Bulwark', producer: 'motorPool', units: [['bulwark', 1]] },
  { key: '9', hotkey: 'V', label: 'Jackknives', producer: 'airfield', units: [['jackknifeFighter', 2]], air: true },
  { key: '0', hotkey: 'E', label: 'Nightjars', producer: 'airfield', units: [['nightjar', 2]], air: true },
];
/** How much longer a squad takes than one of its units: 1 + this per extra unit. */
const SQUAD_TIME = 0.12;
/** Where the data has no train time (the campaign's Burner and Medic), its producer's usual. */
const DEFAULT_TRAIN = 30;
/** The usual cap on an army. */
export const SUPPLY_CAP = 200;

/** A squad catalog, priced from the data. A squad takes its units' whole cost, and a little less than their whole time (several bays at work). */
export function offers(data: Stats, kinds: Record<KindName, Kind>, squads: SquadDef[] = HOLDOUTS_SQUADS): Offer[] {
  return squads.map((s) => {
    let ore = 0;
    let gas = 0;
    let supply = 0;
    let longest = 0;
    let count = 0;
    for (const [k, n] of s.units) {
      const kind = kinds[k];
      const src = dataOf(data, kind.def) ?? data;
      const c = src.cost(kind.def.dataId);
      ore += c.ore * n;
      gas += c.gas * n;
      supply += c.supply * n;
      longest = Math.max(longest, data.trainTime(kind.def.dataId) ?? src.trainTime(kind.def.dataId) ?? DEFAULT_TRAIN);
      count += n;
    }
    if (s.cost) ({ ore, gas } = s.cost);
    return { ...s, air: !!s.air, ore, gas, supply, seconds: (longest * (1 + SQUAD_TIME * (count - 1))) / FASTER };
  });
}

interface Job {
  offer: Offer;
  left: number;
  destination: string;
}

export interface ProductionRules {
  /** Bays each kind of producer starts with (squads built at once). */
  bays: Record<Producer, number>;
  /** Orders a kind of producer keeps waiting, all told. */
  queue: number;
  /** The army's supply cap. */
  cap: number;
}

export const DEFAULT_PRODUCTION: ProductionRules = { bays: { barracks: 1, motorPool: 1, airfield: 1 }, queue: 5, cap: SUPPLY_CAP };

/** The production queues: each kind of producer works on a few squads at once (its bays) and keeps a few more waiting. */
export class Requisition {
  readonly queues: Record<Producer, Job[]> = { barracks: [], motorPool: [], airfield: [] };
  readonly bays: Record<Producer, number>;
  cap: number;
  private queue: number;

  constructor(rules: Partial<ProductionRules> = {}) {
    const r = { ...DEFAULT_PRODUCTION, ...rules };
    this.bays = { ...r.bays };
    this.cap = r.cap;
    this.queue = r.queue;
  }

  /** A building of a producer's kind was put up (or lost: a negative count): its bays join (or leave) the work. */
  addBays(p: Producer, n: number) {
    this.bays[p] = Math.max(0, this.bays[p] + n);
  }

  /** Supply already ordered and not yet out of the door. */
  get pending(): number {
    let n = 0;
    for (const q of Object.values(this.queues)) for (const j of q) n += j.offer.supply;
    return n;
  }

  /**
   * Why `o` can't be ordered now (paid from `t`, with the army at `supply`), or null: whether it
   * can be paid for, fits under the cap and has room in its building's queue. `fielded` counts
   * what of a limited squad's kind is already out (`limit`).
   */
  check(o: Offer, t: Treasury, supply: number, open: boolean, fielded = 0): string | null {
    if (!open) return 'Its building is gone';
    if (o.limit !== undefined) {
      const kind = o.units[0]?.[0];
      let onOrder = 0;
      for (const q of Object.values(this.queues)) for (const j of q) if (j.offer.units[0]?.[0] === kind) onOrder++;
      if (fielded + onOrder >= o.limit) return o.limit === 1 ? 'Only one at a time' : `${o.limit} at most`;
    }
    if (this.queues[o.producer].length >= this.queue + this.bays[o.producer]) return 'Queue full';
    if (supply + this.pending + o.supply > this.cap) return 'Supply capped';
    return t.short(o);
  }

  /** Orders `o` (see `check`), or says why not. */
  order(o: Offer, destination: string, t: Treasury, supply: number, open: boolean, fielded = 0): string | null {
    const why = this.check(o, t, supply, open, fielded);
    if (why) return why;
    t.spend(o);
    this.queues[o.producer].push({ offer: o, left: o.seconds, destination });
    return null;
  }

  /** Takes back one of a building's orders, built or not yet begun: its offer (for the refund), or null. */
  withdraw(p: Producer, index: number): Offer | null {
    const [j] = this.queues[p].splice(index, 1);
    return j?.offer ?? null;
  }

  /** Cancels a producer's whole queue (its last building gone, and the orders with it); returns them, for a refund. */
  cancel(p: Producer): Offer[] {
    return this.queues[p].splice(0).map((j) => j.offer);
  }

  /** Builds; returns the squads that came out of their doors this frame. A building that's gone builds nothing. */
  update(dt: number, open: (p: Producer) => boolean): Job[] {
    const done: Job[] = [];
    for (const p of Object.keys(this.queues) as Producer[]) {
      const q = this.queues[p];
      if (!q.length || !open(p)) continue;
      for (let i = 0; i < Math.min(this.bays[p], q.length); i++) q[i].left -= dt;
      for (let i = q.length - 1; i >= 0; i--) if (q[i].left <= 0) done.push(...q.splice(i, 1));
    }
    return done;
  }

  /** A building's orders, in order: each one's progress and seconds left, where it's going, and whether a bay is on it yet. */
  jobs(p: Producer): { offer: Offer; progress: number; left: number; destination: string; active: boolean }[] {
    return this.queues[p].map((j, i) => ({ offer: j.offer, progress: 1 - j.left / j.offer.seconds, left: j.left, destination: j.destination, active: i < this.bays[p] }));
  }
}
