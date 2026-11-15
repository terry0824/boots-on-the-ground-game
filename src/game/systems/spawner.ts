import * as THREE from 'three';
import { March, CrawlBrain } from '../brains.ts';
import type { Controller, Unit } from '../entity.ts';
import type { KindName } from '../kinds.ts';
import { walkableNear } from '../script.ts';
import type { World } from '../world.ts';

/**
 * An enemy force that comes in packs, for any mode that has one: how strong it should be on the
 * field over the operation (a curve over its share of the time, scaled by difficulty), what it
 * sends at each stage (a mix by share of supply), and the packs themselves, spawned down one of
 * the map's routes (fliers out of its skies) and handed the brains the mode gives them. When to
 * send is the mode's business (its director); what and where is this.
 */

export interface ForceRules {
  /** Supply wanted on the field over the operation: [share of the time, supply], in order. */
  curve: [number, number][];
  /** The curve's scale by difficulty level. */
  scale: number[];
  /** What it sends, by share of its supply, from a share of the time on. */
  mix: { from: number; mix: [KindName, number][] }[];
}

/** The supply `rules` wants on the field at share `t` of the operation, at difficulty `level`. */
export function strengthAt(rules: ForceRules, t: number, level: number): number {
  const c = rules.curve;
  let v = c[c.length - 1][1];
  for (let i = 1; i < c.length; i++) {
    const [t1, v1] = c[i];
    const [t0, v0] = c[i - 1];
    if (t <= t1) {
      v = v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
      break;
    }
  }
  return v * (rules.scale[level] ?? 1);
}

/** The mix `rules` sends at share `t` of the operation. */
export function mixAt(rules: ForceRules, t: number): [KindName, number][] {
  let m = rules.mix[0].mix;
  for (const x of rules.mix) if (t >= x.from) m = x.mix;
  return m;
}

/** Where a pack comes from, and the brain each of it gets. */
export interface PackSource {
  /** The map's ways in on the ground, and where its fliers come from. */
  routes: THREE.Vector3[];
  skies: THREE.Vector3[];
  /** Its brain, by what it is and where it came in. */
  brain: (u: Unit, flying: boolean, at: THREE.Vector3) => Controller;
  /** Which way it faces as it comes in. */
  toward: (flying: boolean, at: THREE.Vector3) => THREE.Vector3;
}

export class Spawner {
  constructor(
    private world: World,
    /** A kind's supply (a Hound's half). */
    private supplyOf: (k: KindName) => number,
  ) {}

  /**
   * Units worth `supply`, drawn from `mix` (shares of supply), down one route (or any), packed
   * as tight as their numbers allow. Returns what came.
   */
  send(supply: number, mix: [KindName, number][], source: PackSource, route?: number): Unit[] {
    const w = this.world;
    const out: Unit[] = [];
    const spread = THREE.MathUtils.clamp(Math.sqrt(supply) * 5, 24, 60);
    const weights = mix.map(([k, share]) => [k, share / (this.supplyOf(k) || 1)] as const);
    const total = weights.reduce((a, [, x]) => a + x, 0);
    let left = supply;
    for (let guard = 0; left > 0.25 && guard < 900; guard++) {
      let r = Math.random() * total;
      let kind = weights[0][0];
      for (const [k, weight] of weights) {
        r -= weight;
        if (r <= 0) {
          kind = k;
          break;
        }
      }
      const flying = w.kinds[kind].flying > 0;
      const i = route ?? Math.floor(Math.random() * 1e6);
      const from = flying ? source.skies[i % source.skies.length] : source.routes[i % source.routes.length];
      const p = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, 0, (Math.random() - 0.5) * spread));
      const pos = flying ? p : walkableNear(w, p, 3);
      const toward = source.toward(flying, pos);
      out.push(w.spawnUnit(kind, pos.x, pos.z, Math.atan2(toward.x - pos.x, toward.z - pos.z), (u) => source.brain(u, flying, pos)));
      left -= this.supplyOf(kind) || 1;
    }
    return out;
  }
}

/** A pack marches as a tide until anything of the other side is this close (or it's shot at), then fights. */
const ENGAGE = 40;
/** The Tide's packs keep the elbow room they always have had on its open ground (meters beyond their sizes). */
const ELBOW_ROOM = 2.4;

/** The swarm's own brain for a fight; a Blister's goes for soldiers, not buildings (its burst is for a line). */
export function swarmBrain(u: Unit): CrawlBrain {
  const b = new CrawlBrain(u);
  if (u.kind.name === 'blister') b.only = (e) => !e.isBuilding;
  return b;
}

/**
 * The swarm on its way in: marching down the paths to the base as a tide (March), with no eye
 * for anything until it's within reach of something human, or shot at; then the swarm's own
 * brain takes over for the fight.
 */
export class SurgeBrain implements Controller {
  private look = Math.random() * 0.4;
  private dir = new THREE.Vector2();
  private march = new March(ELBOW_ROOM);

  constructor(private u: Unit) {}

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.look -= dt;
    if (this.look <= 0) {
      this.look = 0.4;
      const shot = u.alert && w.time - u.alert.at < 3;
      if (shot || w.nearestEnemy(u.team, u.position.x, u.position.z, ENGAGE)) {
        u.setController(swarmBrain(u));
        return;
      }
    }
    if (this.march.step(u, dt, this.dir)) u.move.copy(this.dir);
    else u.move.set(0, 0);
    u.face = null;
  }
}
