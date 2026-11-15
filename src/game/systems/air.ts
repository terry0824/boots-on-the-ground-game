import * as THREE from 'three';
import { faceTowards, CrawlBrain } from '../brains.ts';
import type { Controller, Entity, Unit } from '../entity.ts';
import type { KindName } from '../kinds.ts';
import type { Front } from './lines.ts';

/**
 * The air war over the lines: the Airfield's wings over their stations, the enemy's fliers raiding
 * the lines, and Lanterns dropping Hounds behind them.
 */

/** How far from its station a wing goes after a target, meters. */
const WING_REACH = 70;

/**
 * An Airfield wing: over its station (a line, or the player), it goes after whatever its weapons
 * can hit nearby: a Jackknife's torpedoes at flyers, a Nightjar's rockets at the ground. It swirls
 * around its target while it fights, the way an RTS's air does, then returns to station.
 */
export class AirWingBrain implements Controller {
  private target: Entity | null = null;
  private retarget = Math.random() * 0.4;
  private dir = new THREE.Vector2();
  private side: number;

  constructor(
    private u: Unit,
    /** Where it holds: a point over a line, or the player's body. */
    private station: () => THREE.Vector3,
  ) {
    this.side = u.id % 2 ? 1 : -1;
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    const home = this.station();
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.4 + Math.random() * 0.3;
      this.target = w.nearestTarget(u, WING_REACH, (e) => Math.hypot(e.position.x - home.x, e.position.z - home.z) < WING_REACH);
    }
    const t = this.target;
    u.face = null;
    if (t?.targetable) {
      const weapon = u.weaponFor(t);
      const reach = (weapon?.range ?? 20) + u.radius + t.radius;
      const dx = t.position.x - u.position.x;
      const dz = t.position.z - u.position.z;
      const d = Math.hypot(dx, dz) || 1;
      if (u.inRange(t)) u.attack(t);
      // Hold at about two-thirds of its reach, circling.
      const radial = THREE.MathUtils.clamp((d - reach * 0.65) / (reach * 0.35), -1, 1);
      u.move.set((dx / d) * radial - (dz / d) * this.side * 0.8, (dz / d) * radial + (dx / d) * this.side * 0.8).normalize();
      if (d < reach * 0.4) faceTowards(u, t);
      return;
    }
    // On station: a slow orbit.
    const dx = home.x - u.position.x;
    const dz = home.z - u.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 18) u.move.copy(this.dir.set(dx / d, dz / d));
    else u.move.set(-dz / Math.max(d, 1) * this.side * 0.5, dx / Math.max(d, 1) * this.side * 0.5);
  }
}

/**
 * A Lantern on a drop: in from the edge of the map to a point behind the lines, its cargo of
 * Hounds down one by one, then back the way it came. Shot down on the way, it drops what it
 * carries where it falls.
 */
export class LanternDropBrain implements Controller {
  private stage: 'inbound' | 'unloading' | 'outbound' = 'inbound';
  private next = 0;
  private from: THREE.Vector3;

  constructor(
    private u: Unit,
    private target: THREE.Vector3,
    private cargo: KindName[],
    private onCargo: (kind: KindName, at: THREE.Vector3) => void,
  ) {
    this.from = u.position.clone();
  }

  /** Whatever it still carries comes down where it falls. */
  release() {
    if (this.u.alive || !this.cargo.length) return;
    for (const k of this.cargo.splice(0)) this.onCargo(k, this.u.position);
  }

  update(dt: number) {
    const u = this.u;
    u.face = null;
    if (this.stage === 'inbound') {
      const dx = this.target.x - u.position.x;
      const dz = this.target.z - u.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 5) this.stage = 'unloading';
      else u.move.set(dx / d, dz / d);
      return;
    }
    if (this.stage === 'unloading') {
      u.move.set(0, 0);
      this.next -= dt;
      if (this.next <= 0 && this.cargo.length) {
        this.next = 0.22;
        this.onCargo(this.cargo.pop()!, u.position);
      }
      if (!this.cargo.length) this.stage = 'outbound';
      return;
    }
    const dx = this.from.x - u.position.x;
    const dz = this.from.z - u.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 10) u.world.despawn(u);
    else u.move.set(dx / d, dz / d);
  }
}

/** A Hound just dropped: straight into whatever's nearest. */
export function dropped(u: Unit): Controller {
  return new CrawlBrain(u);
}

/**
 * The swarm's fliers: over the lines rather than around them, and on to the base only once the
 * line beneath has fallen. Over the line, the swarm's own brain fights. Bilewings go for
 * whatever of ours flies.
 */
export class RaidBrain implements Controller {
  private swarm: CrawlBrain;
  private over = false;

  constructor(
    private u: Unit,
    private front: Front,
  ) {
    this.swarm = new CrawlBrain(u);
  }

  release() {
    this.swarm.release();
  }

  update(dt: number) {
    const u = this.u;
    const at = this.front.at;
    if (!this.over && !this.front.broken) {
      const d = Math.hypot(at.x - u.position.x, at.z - u.position.z);
      if (d > 35 && !u.world.nearestTarget(u, 60)) {
        u.face = null;
        u.move.set((at.x - u.position.x) / d, (at.z - u.position.z) / d);
        return;
      }
      this.over = true;
    }
    this.swarm.update(dt);
  }
}
