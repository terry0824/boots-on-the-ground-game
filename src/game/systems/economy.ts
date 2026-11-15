import * as THREE from 'three';
import type { Stats } from '../stats.ts';
import type { Building, Controller, Entity, Unit } from '../entity.ts';
import type { FlowField } from '../flowfield.ts';
import { dataOf, type Kind } from '../kinds.ts';

/**
 * A base's economy, for any mode that has one: what it holds (a treasury of ore and gas),
 * what it earns (workers on its ore fields and refineries, and bounties on the player's own
 * kills and assists, a share of what the enemy cost), and the workers that earn it. Spending is
 * the business of production and construction.
 */

/** The player's bounties: shares of a kill's cost for a kill and for an assist. */
export const BOUNTY = { kill: 0.5, assist: 0.15 };

export class Treasury {
  ore = 0;
  gas = 0;
  /** Lifetime takings, for the debrief: from the ore line, and from the player's own fighting. */
  mined = 0;
  bounty = 0;
  /** A minute's takings, for the "+N a minute" beside the count. */
  private recent: { at: number; amount: number }[] = [];

  earn(ore: number, gas: number, now: number, fromPlayer: boolean) {
    this.ore += ore;
    this.gas += gas;
    if (fromPlayer) this.bounty += ore + gas;
    else this.mined += ore + gas;
    this.recent.push({ at: now, amount: ore + gas });
  }

  rate(now: number): number {
    while (this.recent.length && now - this.recent[0].at > 60) this.recent.shift();
    return this.recent.reduce((a, r) => a + r.amount, 0);
  }

  afford(o: { ore: number; gas: number }): boolean {
    return this.ore >= o.ore && this.gas >= o.gas;
  }

  spend(o: { ore: number; gas: number }) {
    this.ore -= o.ore;
    this.gas -= o.gas;
  }

  /** Why `o` can't be paid for, or null. */
  short(o: { ore: number; gas: number }): string | null {
    if (this.afford(o)) return null;
    return o.gas > this.gas ? 'Not enough gas' : 'Not enough ore';
  }
}

/**
 * What a kill of `kind` pays the player, as a share of its cost (the Hound's half a pair's),
 * times `multiplier` (a bounty streak's).
 */
export function bounty(data: Stats, kind: Kind, assist: boolean, multiplier = 1, shares = BOUNTY): { ore: number; gas: number } {
  const src = dataOf(data, kind.def) ?? data;
  const c = src.cost(kind.def.dataId);
  const k = (assist ? shares.assist : shares.kill) * multiplier;
  // A Hound's cost is for the pair its egg hatches (a Leaper's too: the same egg, another strain).
  const each = kind.name === 'hound' || kind.name === 'leaper' ? 0.5 : 1;
  return { ore: Math.round(c.ore * each * k), gas: Math.round(c.gas * each * k) };
}

const step = new THREE.Vector2();

/**
 * Walks a worker toward `to`, animating; true once it's within `stop`. With `paths` (the world's
 * `pathsTo`), it goes the way round the cliffs and buildings; without, straight (an ore line
 * beside its Holdfast).
 */
export function walkTo(u: Unit, to: THREE.Vector3, stop: number, paths?: FlowField | null): boolean {
  const dx = to.x - u.position.x;
  const dz = to.z - u.position.z;
  const d = Math.hypot(dx, dz);
  if (d <= stop) return true;
  u.face = null;
  if (paths && (paths.direction(u.position.x, u.position.z, step) || paths.escape(u.position.x, u.position.z, step))) u.move.copy(step);
  else u.move.set(dx / d, dz / d);
  u.visual.play('Walk', { timeScale: u.walkRate(Math.hypot(u.velocity.x, u.velocity.z) + 0.1) });
  return false;
}

/** Seconds a worker spends working a field before it carries the load home. */
const MINE_SECONDS = 2.4;
/** A worker's repair rate, life per real second (as the Mender call-in's), and what it will walk over to fix. */
const REPAIR_RATE = 14;
const REPAIR_REACH = 25;
const NEEDS_REPAIR = 0.75;

/**
 * A worker (an Rigger) on the ore line (or a refinery): out to its field, a couple of seconds at
 * it, back to the Holdfast with the load, and out again. Between trips it welds whatever of
 * ours nearby is damaged (a building, a tank) while no Crawl are on it.
 */
export class MinerBrain implements Controller {
  private state: 'out' | 'work' | 'home' | 'repair' = 'out';
  private t = 0;
  private look = Math.random() * 2;
  private patient: Entity | null = null;

  /** `reach`: how close it works the field from (a refinery's edge; a crystal it can walk up to). */
  constructor(
    private u: Unit,
    private field: THREE.Vector3,
    private home: () => Building | null,
    private load: number,
    private deliver: (amount: number) => void,
    private reach = 3,
  ) {
    u.customAnimation = true;
  }

  private walk(to: THREE.Vector3, stop: number): boolean {
    return walkTo(this.u, to, stop);
  }

  /** Something of ours nearby that needs welding, with no Crawl on it. */
  private needing(): Entity | null {
    const u = this.u;
    const w = u.world;
    let worst: Entity | null = null;
    let f = NEEDS_REPAIR;
    for (const e of w.entities) {
      if (!e.alive || e.team !== u.team || e === u || !(e.isBuilding || e.kind.attributes.includes('Mechanical')) || e.kind.name === 'mender' || e.kind.name === 'rigger') continue;
      if (Math.hypot(e.position.x - u.position.x, e.position.z - u.position.z) > REPAIR_REACH + e.radius) continue;
      const share = e.hp / e.maxHp;
      if (share < f && !w.nearestEnemy(u.team, e.position.x, e.position.z, 15)) {
        f = share;
        worst = e;
      }
    }
    return worst;
  }

  update(dt: number) {
    const u = this.u;
    const cc = this.home();
    if (!cc?.alive) {
      u.move.set(0, 0);
      u.visual.play('Stand');
      return;
    }
    this.look -= dt;
    if (this.look <= 0 && this.state !== 'repair') {
      this.look = 2;
      this.patient = this.needing();
      if (this.patient) this.state = 'repair';
    }
    if (this.state === 'repair') {
      const p = this.patient;
      if (!p?.alive || p.hp >= p.maxHp || u.world.nearestEnemy(u.team, p.position.x, p.position.z, 12)) {
        this.state = 'out';
        this.patient = null;
        return;
      }
      if (this.walk(p.position, p.radius + 2.5)) {
        u.move.set(0, 0);
        u.face = Math.atan2(p.position.x - u.position.x, p.position.z - u.position.z);
        u.visual.play('Stand Work');
        p.hp = Math.min(p.maxHp, p.hp + REPAIR_RATE * dt);
        if (Math.random() < 0.3) {
          const spot = p.position.clone().setY(p.position.y + p.height * 0.4).lerp(u.position, 0.5);
          u.world.effects.sparks(spot, new THREE.Vector3(0, 1, 0), 2, 0xffd090);
        }
      }
      return;
    }
    if (this.state === 'out') {
      if (this.walk(this.field, this.reach) || (this.u.blocked > 0.6 && Math.hypot(this.field.x - u.position.x, this.field.z - u.position.z) < this.reach + 6)) {
        this.state = 'work';
        this.t = MINE_SECONDS;
      }
    } else if (this.state === 'work') {
      u.move.set(0, 0);
      u.face = Math.atan2(this.field.x - u.position.x, this.field.z - u.position.z);
      u.visual.play('Stand Work');
      this.t -= dt;
      if (this.t <= 0) this.state = 'home';
    } else {
      // To the edge of the Holdfast nearest the field.
      const toward = new THREE.Vector3(this.field.x - cc.position.x, 0, this.field.z - cc.position.z).normalize();
      const drop = cc.position.clone().addScaledVector(toward, cc.radius + 2);
      if (this.walk(drop, 3)) {
        this.deliver(this.load);
        this.state = 'out';
      }
    }
  }
}
