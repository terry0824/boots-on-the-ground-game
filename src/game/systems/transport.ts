import * as THREE from 'three';
import { GuardBrain } from '../brains.ts';
import { FASTER, type Stats } from '../stats.ts';
import type { Controller, Entity, Unit } from '../entity.ts';
import { dataOf, RANGE_METERS_PER_CELL, type KindName } from '../kinds.ts';
import { walkableNear } from '../script.ts';

/**
 * Transports, for any mode: a Dustoff's hold. Soldiers board by their cargo size (a Trooper 1, a
 * Grenadier or Burner 2, a Howitzer 4, a Bulwark 8) up to the hold's space (8), get off one at a
 * time at its unload period, and die with it if it's shot down (its `cargoDeath`), all as the data
 * has it. While aboard they're out of the fight: not drawn, not targeted, carried along.
 *
 * A run (`TransportBrain`) is a transport's job for the AI: out to a pickup, hovering while
 * whoever is there boards, then on to the drop, and home. An evacuation is a run with a pickup;
 * a drop is one that starts loaded. The player can fly a Dustoff and do the same by hand
 * (vehicle.ts), and ride in one someone else flies (ride.ts).
 */

export interface HoldSpec {
  /** Cargo space. */
  space: number;
  /** Real seconds between soldiers set down. */
  unloadSeconds: number;
  /** Its cargo dies with it. */
  cargoDeath: boolean;
  /** How far round the ground under it soldiers board from, meters. */
  reach: number;
}

/** Which kinds carry, and the ability their hold comes from. */
const TRANSPORTS: Partial<Record<KindName, string>> = { dustoff: 'DustoffTransport' };

let data: Stats | null = null;

/** The game data holds and cargo sizes come from (set once at load). */
export function useTransportData(d: Stats) {
  data = d;
}

/** A hold's numbers, from its ability's data. */
export function holdSpec(ability = 'DustoffTransport'): HoldSpec {
  const t = data?.transport(ability) ?? { space: 8, unloadPeriod: 1, cargoDeath: true, searchRadius: 4 };
  return { space: t.space, unloadSeconds: t.unloadPeriod / FASTER, cargoDeath: t.cargoDeath, reach: Math.max(8, t.searchRadius * RANGE_METERS_PER_CELL) };
}

/** How much of a hold `e` takes: 0 if it can't be carried (a building, a flyer, a braced tank). */
export function cargoSize(e: Entity): number {
  if (e.isBuilding || e.flying || !data) return 0;
  const src = dataOf(data, e.kind.def) ?? data;
  return src.cargoSize(e.kind.def.dataId);
}

/** Whether `u` is a transport. */
export function isTransport(u: Entity): u is Unit {
  return !u.isBuilding && !!TRANSPORTS[u.kind.name];
}

const holds = new WeakMap<Unit, Hold>();

/** A transport's hold (made the first time it's asked for); null for anything that isn't one. */
export function holdOf(u: Unit): Hold | null {
  if (!isTransport(u)) return null;
  let h = holds.get(u);
  if (!h) {
    h = new Hold(u, holdSpec(TRANSPORTS[u.kind.name]));
    holds.set(u, h);
  }
  return h;
}

const v1 = new THREE.Vector3();

/** What's aboard a transport: who boarded, what drove them before, carried along and lost with it. */
export class Hold {
  readonly cargo: Unit[] = [];
  /** What drove each before it boarded: it gets it back on the ground, unless it's given another. */
  private brains = new Map<Unit, Controller | null>();
  /** For the world's timed list: the hold is done once its transport is gone. */
  done = false;

  constructor(
    readonly carrier: Unit,
    readonly spec: HoldSpec,
  ) {
    carrier.whenDead.push(() => this.lost());
    carrier.world.timed.push(this);
  }

  get used(): number {
    return this.cargo.reduce((a, u) => a + cargoSize(u), 0);
  }

  get free(): number {
    return this.spec.space - this.used;
  }

  /** Whether `u` can board now: one of ours, on its feet, small enough for what's left. */
  fits(u: Unit): boolean {
    const size = cargoSize(u);
    return size > 0 && size <= this.free && u.alive && !u.stowed && !u.immobile && !u.morph && u !== this.carrier && u.team === this.carrier.team;
  }

  /** Takes `u` aboard. */
  load(u: Unit): boolean {
    if (!this.fits(u)) return false;
    // Kept, not released: it's what it goes back to doing.
    this.brains.set(u, u.controller);
    u.controller = null;
    u.stowed = true;
    u.move.set(0, 0);
    u.velocity.set(0, 0, 0);
    this.cargo.push(u);
    const w = u.world;
    w.effects.flash(u.center(v1), 1.2, 0x9fd0ff, 0.12);
    return true;
  }

  /** Soldiers round `at` who could board (as `who` allows), nearest first. The player's own body boards only when they choose to. */
  around(at: THREE.Vector3, reach = this.spec.reach, who?: (u: Unit) => boolean): Unit[] {
    const w = this.carrier.world;
    const out = w.unitsNear(at.x, at.z, reach, []).filter((u) => u !== w.player && this.fits(u) && (!who || who(u)));
    return out.sort((a, b) => a.position.distanceToSquared(at) - b.position.distanceToSquared(at));
  }

  /** Puts the first aboard down on open ground near `at`, with `brain` (or what drove it before; or guarding where it's put). */
  unloadOne(at: THREE.Vector3, brain?: ((u: Unit, at: THREE.Vector3) => Controller | null) | null): Unit | null {
    const u = this.cargo.shift();
    if (!u) return null;
    const w = u.world;
    const spot = walkableNear(w, v1.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 7, 0, (Math.random() - 0.5) * 7)), 2);
    u.position.set(spot.x, w.terrain.heightAt(spot.x, spot.z), spot.z);
    u.velocity.set(0, 0, 0);
    u.stowed = false;
    const before = this.brains.get(u) ?? null;
    this.brains.delete(u);
    // The player's own body is theirs again the moment it's down: no brain to give it.
    const given = u === w.player ? null : (brain?.(u, spot.clone()) ?? null);
    if (given) before?.release?.();
    // Whoever had no brain aboard (and isn't the player's body) holds where it was put.
    u.controller = given ?? before ?? (u === w.player ? null : new GuardBrain(u, spot.clone(), 20, 44));
    w.audio.play('dustoffUnload', { at: spot, volume: 0.8, near: 20 });
    w.effects.smoke(spot, 2.2, 0x8a7a68, 1.2);
    return u;
  }

  /** Each frame (the world runs it): the cargo rides along; a transport gone without being shot down sets its cargo down where it is. */
  update() {
    const c = this.carrier;
    if (!c.alive) return this.lost();
    for (const u of this.cargo) u.position.copy(c.position);
  }

  /** The transport is gone: shot down, its cargo with it (where its hold has `cargoDeath`); otherwise set down below. */
  private lost() {
    if (this.done) return;
    this.done = true;
    const c = this.carrier;
    const below = c.position.clone().setY(c.world.terrain.heightAt(c.position.x, c.position.z));
    while (this.cargo.length) {
      const u = this.cargo[0];
      if (this.spec.cargoDeath && c.hp <= 0) {
        this.cargo.shift();
        this.brains.delete(u);
        u.stowed = false;
        u.position.copy(below);
        if (u.alive) u.takeDamage(u.hp + 1, null);
      } else this.unloadOne(below);
    }
  }
}

/** A transport's job: where it picks up (if anywhere), where it sets down, and where it goes after. */
export interface Run {
  /** Where it picks up, who may board (all of ours who fit, by default), and how long it waits for them. */
  pickup?: { at: THREE.Vector3; who?: (u: Unit) => boolean; wait: number };
  /** Where it sets them down, and the brain each gets there (what drove it before, by default). */
  drop: { at: THREE.Vector3; brain?: (u: Unit, at: THREE.Vector3) => Controller | null };
  /** Where it goes afterwards (and leaves the battle, there), or null to stay over the drop. */
  home: THREE.Vector3 | null;
  /** A soldier boarded. */
  onBoard?: (u: Unit) => void;
  /** The run is over (home, or done over the drop). */
  onDone?: () => void;
}

/** Afterburners on the way in and out (the Dustoff's own burst of speed). */
const BURN = 2.2;
/** Seconds between soldiers boarding at a pickup. */
const BOARD_EVERY = 0.25;

/**
 * A transport on a run: out to the pickup on afterburners, hovering there while whoever is under
 * it boards (one every quarter second, until it's full, nobody's left, or its wait is up), then
 * to the drop, setting them down one by one at the data's pace, and home.
 */
export class TransportBrain implements Controller {
  stage: 'out' | 'loading' | 'carrying' | 'unloading' | 'home' | 'done';
  private wait = 0;
  private next = 0;
  readonly hold: Hold;

  constructor(
    private u: Unit,
    private run: Run,
  ) {
    this.hold = holdOf(u)!;
    this.stage = run.pickup ? 'out' : 'carrying';
    this.wait = run.pickup?.wait ?? 0;
  }

  private finish(): 'done' {
    this.run.onDone?.();
    return 'done';
  }

  /** Flies toward `to`, easing in over the last stretch; true once over it. */
  private fly(to: THREE.Vector3, burn: boolean): boolean {
    const u = this.u;
    const dx = to.x - u.position.x;
    const dz = to.z - u.position.z;
    const d = Math.hypot(dx, dz);
    u.face = null;
    u.speedMul = burn && d > 40 ? BURN : 1;
    if (d < 4) {
      u.move.set(dx, dz).multiplyScalar(0.05);
      return true;
    }
    u.move.set(dx / d, dz / d).multiplyScalar(Math.min(1, d / 30));
    return false;
  }

  update(dt: number) {
    const u = this.u;
    const run = this.run;
    const hold = this.hold;
    switch (this.stage) {
      case 'out':
        if (this.fly(run.pickup!.at, true)) this.stage = 'loading';
        return;
      case 'loading': {
        this.fly(run.pickup!.at, false);
        this.wait -= dt;
        this.next -= dt;
        if (this.next <= 0) {
          this.next = BOARD_EVERY;
          const who = hold.around(run.pickup!.at, hold.spec.reach, run.pickup!.who)[0];
          if (who && hold.load(who)) run.onBoard?.(who);
          else if (hold.cargo.length && !hold.around(run.pickup!.at, hold.spec.reach * 1.6, run.pickup!.who).length) this.wait = Math.min(this.wait, 0.5);
        }
        if (this.wait <= 0 || hold.free <= 0) this.stage = hold.cargo.length ? 'carrying' : run.home ? 'home' : this.finish();
        return;
      }
      case 'carrying':
        if (this.fly(run.drop.at, true)) {
          this.stage = 'unloading';
          this.next = 0.3;
        }
        return;
      case 'unloading':
        this.fly(run.drop.at, false);
        this.next -= dt;
        if (this.next <= 0) {
          this.next = hold.spec.unloadSeconds;
          if (!hold.unloadOne(run.drop.at, run.drop.brain)) this.stage = run.home ? 'home' : this.finish();
        }
        return;
      case 'home':
        if (this.fly(run.home!, true)) {
          this.stage = this.finish();
          u.world.despawn(u);
        }
        return;
      case 'done':
        u.move.set(0, 0);
        return;
    }
  }
}
