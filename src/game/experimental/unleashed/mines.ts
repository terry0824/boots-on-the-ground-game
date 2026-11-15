import * as THREE from 'three';
import type { Controller, Entity, Unit } from '../../entity.ts';
import type { World } from '../../world.ts';

/**
 * Scuttle Mines, as the classic Coyote lays them: a mine burrows where it's dropped, out
 * of the swarm's sight; when ground Crawl come near, it unburrows, runs at the nearest (at the
 * data's speed, faster than a Hound) and bursts. Each Coyote carries three and gets one back
 * every so often (the campaign's refilling magazine).
 */

/** Seconds a dropped mine takes to burrow, before it's armed. */
const ARM_SECONDS = 1.2;
/** How near ground Crawl set it off, meters. */
const TRIGGER = 13;
/** How near it bursts, meters beyond the target's size. */
const CONTACT = 1.2;
/** Seconds it chases before it gives up and bursts where it is. */
const CHASE_SECONDS = 4;
/** A Coyote's mines, and the seconds it takes to get one back. */
export const MINES = 3;
export const MINE_RELOAD = 25;

export class ScuttleMineBrain implements Controller {
  private state: 'arming' | 'burrowed' | 'seeking' = 'arming';
  private t = 0;
  private look = 0;
  private target: Entity | null = null;

  /** `owner`: who laid it, credited with what it kills while it lives. */
  constructor(
    private u: Unit,
    private owner: Entity | null,
  ) {
    u.ignored = true;
    u.customAnimation = true;
    u.visual.play('Burrow', { loop: false });
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.t += dt;
    u.move.set(0, 0);
    if (this.state === 'arming') {
      if (this.t >= ARM_SECONDS) {
        this.state = 'burrowed';
        w.audio.play('scuttleMineBurrow', { at: u.position, volume: 0.5, limit: 4 });
      }
      return;
    }
    if (this.state === 'burrowed') {
      this.look -= dt;
      if (this.look > 0) return;
      this.look = 0.2;
      const z = w.nearestEnemy(u.team, u.position.x, u.position.z, TRIGGER, (e) => !e.flying && !e.isBuilding);
      if (!z) return;
      this.state = 'seeking';
      this.target = z;
      this.t = 0;
      u.ignored = false;
      u.visual.play('Unburrow', { loop: false });
      w.audio.play('scuttleMineSeek', { at: u.position, volume: 0.7, limit: 4 });
      return;
    }
    let t = this.target;
    if (!t?.targetable) t = this.target = w.nearestEnemy(u.team, u.position.x, u.position.z, TRIGGER, (e) => !e.flying && !e.isBuilding);
    if (!t || this.t > CHASE_SECONDS || u.gap(t) <= CONTACT) {
      this.burst(w);
      return;
    }
    u.move.set(t.position.x - u.position.x, t.position.z - u.position.z).normalize();
    if (this.t > 0.35) u.visual.play('Walk');
  }

  private burst(w: World) {
    const u = this.u;
    const weapon = u.kind.weapon;
    const at = u.center(new THREE.Vector3());
    // The mine's own burst (scuttleMineExplosion) and its sound (humanExplosionSmall).
    if (weapon) w.explode(at, weapon, this.owner?.alive ? this.owner : u, false, 'humanExplosionSmall', { drawn: true });
    w.playEffect('scuttleMineExplosion', at, null, w.effectScale * 2);
    u.die(null);
  }
}

/** Lays a mine from `coyote`, just behind it (the Coyote keeps moving): the new mine's unit. */
export function layMine(w: World, coyote: Entity): Unit {
  const back = coyote.forward(new THREE.Vector3()).multiplyScalar(-(coyote.radius + 1.5));
  return layMineAt(w, coyote, coyote.position.clone().add(back));
}

/** Lays one of `coyote`'s mines at `at`: the new mine's unit. */
export function layMineAt(w: World, coyote: Entity, at: THREE.Vector3): Unit {
  const mine = w.spawnUnit('scuttleMine', at.x, at.z, coyote.yaw, (m) => new ScuttleMineBrain(m, coyote), coyote.team);
  w.audio.play('scuttleMinePlace', { at, volume: 0.7, limit: 4 });
  return mine;
}
