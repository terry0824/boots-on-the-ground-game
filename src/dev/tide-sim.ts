// Test-only: plays The Tide start to finish with a commander bot in the player's place, for
// balance. It spends what the base earns on squads the way a player at the board would (through
// the script's own orders, to wherever the line needs them most), calls the Lodestar onto the
// worst-pressed line whenever it's charged, and doesn't fight itself: it watches from the
// command view, as `run(…, 'none')` does. It samples the battle as it goes and reports how it
// went: `await game.tide()` on `?test&mission=the-tide&difficulty=1&size=epic`.

import * as THREE from 'three';
import type { Warship } from '../game/warship.ts';
import type { Entity } from '../game/entity.ts';
import type { Mission } from '../game/mission.ts';
import type { Director } from '../game/systems/director.ts';
import type { Treasury } from '../game/systems/economy.ts';
import type { Lines } from '../game/systems/lines.ts';
import type { Offer, Requisition } from '../game/systems/production.ts';
import type { World } from '../game/world.ts';

/** What the bot reads of the script: its private state, by name (this is a test). */
interface TideState {
  apply(order: { side: 'holdouts'; kind: 'requisition'; offer: string; destination: string }): string | null;
  died(e: Entity): void;
  armySupply(team: 'holdouts' | 'crawl'): number;
  supply(kind: string): number;
  target(): number;
  grown(): number;
  board: Offer[];
  treasury: Treasury;
  requisition: Requisition;
  director: Director;
  lines: Lines;
  holdSeconds: number;
  time: number;
  emergencies: number;
  squadsBought: number;
  lowest: number;
  scale: number;
  mining: { workers: Map<unknown, unknown> } | null;
}

export interface TideHost {
  world: World;
  mission: Mission;
  bc: Warship;
  begin(): void;
  step(seconds: number): void;
  toCommand(transition: number, at: THREE.Vector3): void;
}

export interface TideOptions {
  /** Requisition squads with what the base earns, as a player would; off, the army gets only what's free. */
  spend?: boolean;
  /** Call the Lodestar whenever it's charged, onto the worst-pressed line. */
  strike?: boolean;
  /** The army the bot buys, by share of supply, per squad (the board's keys). */
  mix?: Record<string, number>;
  /** Seconds between samples. */
  every?: number;
  /** Stop after this many seconds of battle. */
  seconds?: number;
}

export interface TideSample {
  t: number;
  army: number;
  cap: number;
  swarm: number;
  /** What the director wants on the field. */
  target: number;
  ore: number;
  gas: number;
  riggers: number;
  phase: string;
  broken: number;
}

export interface TideReport {
  size: number;
  outcome: string;
  seconds: number;
  /** The army's lowest, as a share of the 200 it started with; and its highest, in supply. */
  lowest: number;
  peak: number;
  /** Averages over the second half of the hold, when the swarm is at its biggest. */
  late: { army: number; swarm: number; ratio: number };
  emergencies: number;
  squads: number;
  strikes: number;
  /** Seconds with at least one line overrun. */
  brokenSeconds: number;
  ccLowest: number;
  /** Supply lost on each side. */
  lost: { holdouts: number; crawl: number };
  /** Takings from the ore line, and what was spent on squads. */
  mined: number;
  spent: number;
  /**
   * What stopped the bot buying more, as shares of its looks at the board: the cap, money, the
   * production queues, or nothing (it had bought all it could use).
   */
  limits: Record<string, number>;
  samples: TideSample[];
}

/** A player's usual army: Troopers and Grenadiers with Medics, Burners against the Hounds, tanks behind, a Bulwark and Jackknives for the air. */
const MIX: Record<string, number> = { '1': 0.36, '2': 0.2, '3': 0.1, '4': 0.1, '6': 0.12, '8': 0.06, '9': 0.06 };
/** How often the bot looks at the board, seconds. */
const LOOK = 0.5;

export async function runTide(g: TideHost, o: TideOptions = {}): Promise<TideReport> {
  const spend = o.spend ?? true;
  const strike = o.strike ?? true;
  const mix = o.mix ?? MIX;
  const every = o.every ?? 10;
  const m = g.mission;
  const s = m.script as unknown as TideState;
  const w = g.world;
  g.begin();
  g.toCommand(0.01, m.holdfast!.position);

  const lost = { holdouts: 0, crawl: 0 };
  const died = s.died.bind(s);
  s.died = (e: Entity) => {
    if (!e.isBuilding && (e.team === 'holdouts' || e.team === 'crawl')) lost[e.team] += s.supply(e.kind.name);
    died(e);
  };
  const bought: Record<string, number> = {};
  let boughtAll = 0;
  let spent = 0;
  const limits: Record<string, number> = { cap: 0, money: 0, queue: 0, none: 0 };
  const samples: TideSample[] = [];
  let strikes = 0;
  let brokenSeconds = 0;
  let ccLowest = 1;
  let peak = 0;
  const late = { army: 0, swarm: 0, n: 0 };
  let nextSample = 0;
  const start = s.time;

  /** Buys what it can, the squad furthest under its share first, for the base while the swarm's in it; returns what stopped it. */
  const buy = (): string => {
    const cc = m.holdfast;
    const inBase = cc ? w.unitsNear(cc.position.x, cc.position.z, 60).filter((u) => u.team === 'crawl' && u.alive).length : 0;
    const destination = inBase >= 6 ? 'Base' : 'Auto';
    for (let n = 0; n < 12; n++) {
      const keys = Object.keys(mix).sort((a, b) => ((bought[a] ?? 0) / Math.max(1, boughtAll) - mix[a]) - ((bought[b] ?? 0) / Math.max(1, boughtAll) - mix[b]));
      let got = false;
      for (const key of keys) {
        const offer = s.board.find((x) => x.key === key)!;
        if (!s.treasury.afford(offer)) continue;
        if (s.apply({ side: 'holdouts', kind: 'requisition', offer: key, destination })) continue;
        bought[key] = (bought[key] ?? 0) + offer.supply;
        boughtAll += offer.supply;
        spent += offer.ore + offer.gas;
        got = true;
        break;
      }
      if (!got) break;
    }
    // What stops the cheapest squad (the Troopers) now is what's holding the army back.
    const troopers = s.board.find((x) => x.key === '1')!;
    const army = s.armySupply('holdouts');
    if (army + s.requisition.pending + troopers.supply > s.requisition.cap) return 'cap';
    if (!s.treasury.afford(troopers)) return 'money';
    const q = s.requisition.queues.barracks.length;
    return q >= 4 + s.requisition.bays.barracks ? 'queue' : 'none';
  };

  /** The Lodestar, charged, onto wherever the most of the swarm is: in front of a line, at a fallback, or in the base. */
  const callShip = () => {
    if (g.bc.callable()) return;
    let best: THREE.Vector3 | null = null;
    let most = 24;
    const places = s.lines.fronts.flatMap((f) => [s.lines.anchor(f), ...(f.fallback ? [s.lines.anchor(f.fallback)] : [])]);
    if (m.holdfast) places.push(m.holdfast.position.clone());
    for (const a of places) {
      let crawl = 0;
      const c = new THREE.Vector3();
      let n = 0;
      for (const u of w.unitsNear(a.x, a.z, 90)) {
        if (u.team !== 'crawl' || !u.alive) continue;
        crawl += s.supply(u.kind.name);
        c.add(u.position);
        n++;
      }
      if (crawl > most) {
        most = crawl;
        best = c.divideScalar(n);
      }
    }
    if (best && !g.bc.callIn(best)) strikes++;
  };

  let looked = 0;
  while (m.phase !== 'victory' && m.phase !== 'defeat' && (o.seconds === undefined || s.time - start < o.seconds)) {
    g.step(LOOK);
    const t = s.time - start;
    if (spend) limits[buy()]++;
    if (strike) callShip();
    const army = s.armySupply('holdouts');
    const swarm = s.armySupply('crawl');
    peak = Math.max(peak, army);
    if (s.lines.fronts.some((f) => f.broken)) brokenSeconds += LOOK;
    const cc = m.holdfast;
    if (cc) ccLowest = Math.min(ccLowest, cc.alive ? cc.hp / cc.maxHp : 0);
    if (t > s.holdSeconds / 2 && t < s.holdSeconds) {
      late.army += army;
      late.swarm += swarm;
      late.n++;
    }
    if (t >= nextSample) {
      nextSample += every;
      samples.push({
        t: Math.round(t),
        army: Math.round(army),
        cap: s.requisition.cap,
        swarm: Math.round(swarm),
        target: Math.round(s.target()),
        ore: Math.round(s.treasury.ore),
        gas: Math.round(s.treasury.gas),
        riggers: s.mining?.workers.size ?? 0,
        phase: s.director.phase,
        broken: s.lines.fronts.filter((f) => f.broken).length,
      });
    }
    // Let the page breathe now and then.
    if (++looked % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  s.died = died;
  const looks = Object.values(limits).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(limits)) limits[k] = Math.round((limits[k] / looks) * 100) / 100;
  return {
    size: s.scale,
    outcome: m.phase === 'victory' ? 'held' : m.phase === 'defeat' ? 'fell' : 'running',
    seconds: Math.round(s.time - start),
    lowest: Math.round(s.lowest * 100) / 100,
    peak: Math.round(peak),
    late: { army: Math.round(late.army / Math.max(1, late.n)), swarm: Math.round(late.swarm / Math.max(1, late.n)), ratio: Math.round((late.swarm / Math.max(1, late.army)) * 100) / 100 },
    emergencies: s.emergencies,
    squads: s.squadsBought,
    strikes,
    brokenSeconds,
    ccLowest: Math.round(ccLowest * 100) / 100,
    lost: { holdouts: Math.round(lost.holdouts), crawl: Math.round(lost.crawl) },
    mined: Math.round(s.treasury.mined),
    spent: Math.round(spent),
    limits,
    samples,
  };
}
