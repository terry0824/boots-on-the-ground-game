import * as THREE from 'three';
import type { Entity, Unit } from '../../entity.ts';
import type { VehicleSpecial } from '../../vehicle.ts';
import type { World } from '../../world.ts';
import { layMine, MINE_RELOAD, MINES } from './mines.ts';

/**
 * What Unleashed's machines do beyond their guns, wherever they're fielded (The Tide: Unleashed,
 * the Practice Range): walkers that stamp out the Crawl at their feet, and Coyotes with their
 * Scuttle Mines.
 */

/**
 * Machines heavy enough to crush what's at their feet (the Squish death), and the
 * Crawl small enough to be crushed: a 20 m walker doesn't step round a Hound. A walker's feet
 * come down in turn, left and right, as it walks, and where the swarm crowds its legs it shifts
 * its weight and stamps anyway; each foot crushes what's around it. Treads crush whatever's
 * under the hull, rolling. For each, as shares of its radius: how far out to the side a foot
 * comes down and how much ground it covers (a walker's feet reach past its body), and seconds
 * between footfalls.
 */
const STOMPERS: Record<string, { foot: number; reach: number; every: number; treads?: boolean }> = {
  bulwark: { foot: 0.7, reach: 0.6, every: 0.8 },
  behemoth: { foot: 0.7, reach: 0.65, every: 1 },
  howitzerMobile: { foot: 0, reach: 0.95, every: 0.1, treads: true },
};
const CRUSHED = new Set(['hound', 'leaper', 'blister', 'mite']);
/** A walker standing among this many small Crawl stamps them anyway. */
const CROWDED = 3;
/** How fast a machine must be going to stamp or roll over what's in its way (m/s). */
const MOVING = 0.6;

/** Bulwarks and the Behemoth stamp out the small Crawl at their feet; tanks on the move roll over them. */
export class Stompers {
  private crushIn = 0;
  /** Each walker's feet: seconds to the next footfall, and which side it's on. */
  private feet = new WeakMap<Entity, { next: number; side: number }>();

  constructor(private w: World) {}

  update(dt: number) {
    this.crushIn -= dt;
    if (this.crushIn > 0) return;
    const step = 0.1 - this.crushIn;
    this.crushIn = 0.1;
    const w = this.w;
    for (const e of w.entities) {
      const s = STOMPERS[e.kind.name];
      if (!s || !e.alive || e.team !== 'holdouts' || !('velocity' in e)) continue;
      const v = (e as Unit).velocity;
      const moving = Math.hypot(v.x, v.z) >= MOVING;
      const small = (x: number, z: number, r: number) => w.unitsNear(x, z, r).filter((u) => u.team === 'crawl' && u.alive && !u.flying && CRUSHED.has(u.kind.name));
      if (s.treads) {
        if (moving) for (const z of small(e.position.x, e.position.z, e.radius * s.reach)) z.takeDamage(z.hp + 100, e, e.position, true, 'Squish');
        continue;
      }
      let feet = this.feet.get(e);
      if (!feet) this.feet.set(e, (feet = { next: 0, side: 1 }));
      feet.next -= step;
      if (feet.next > 0) continue;
      // The next foot to come down, and what's around it. Standing, it comes down only where the
      // swarm crowds it (each foot looked at in turn).
      const f = e.forward(new THREE.Vector3());
      const at = e.position.clone().addScaledVector(f, e.radius * 0.25).add(new THREE.Vector3(f.z, 0, -f.x).multiplyScalar(feet.side * e.radius * s.foot));
      const under = small(at.x, at.z, e.radius * s.reach);
      feet.side = -feet.side;
      if (!moving && under.length < CROWDED) continue;
      feet.next = s.every;
      this.stomp(e, at, under);
    }
  }

  /** A walker's foot coming down at `at`: what's small under it dies, its footprint and dust where it lands. */
  private stomp(e: Entity, at: THREE.Vector3, under: Unit[]) {
    const w = this.w;
    for (const z of under) z.takeDamage(z.hp + 100, e, at, true, 'Squish');
    const f = e.forward(new THREE.Vector3());
    at.y = w.terrain.heightAt(at.x, at.z);
    w.playEffect('bulwarkFootprint', at, at.clone().add(f), e.scale);
    w.effects.smoke(at.clone().setY(at.y + 0.5), e.radius * 0.35, 0x8a7a68, 1.6);
    w.sfx.play('walker.stomp', { at, volume: under.length ? 1 : 0.6 });
    const body = w.player;
    if (body && body.position.distanceTo(at) < e.radius * 4) w.effects.shake = Math.max(w.effects.shake, body === e ? 0.12 : 0.2);
  }
}

/** An AI Coyote lays a mine when ground Crawl are this near (meters), at most this often (seconds). */
const MINE_WHEN = 55;
const MINE_EVERY = 5;

/** Every Coyote gets its mines back over time; the AI's lay theirs in the swarm's way as it comes, the player's on E. */
export class Minelayers {
  /** Each Coyote's Scuttle Mines: how many it carries, when it gets one back, when it may lay the next. */
  private magazines = new WeakMap<Entity, { left: number; reload: number; next: number }>();
  private minesIn = 1;
  private time = 0;

  constructor(private w: World) {}

  private magazine(v: Entity): { left: number; reload: number; next: number } {
    let m = this.magazines.get(v);
    if (!m) this.magazines.set(v, (m = { left: MINES, reload: MINE_RELOAD, next: 0 }));
    return m;
  }

  update(dt: number) {
    this.time += dt;
    this.minesIn -= dt;
    if (this.minesIn > 0) return;
    this.minesIn = 1;
    const w = this.w;
    for (const e of w.entities) {
      if (e.kind.name !== 'coyote' || !e.alive) continue;
      const m = this.magazine(e);
      if (m.left < MINES && (m.reload -= 1) <= 0) {
        m.left++;
        m.reload = MINE_RELOAD;
      }
      if (e === w.player || m.left <= 0 || this.time < m.next) continue;
      if (!w.nearestEnemy(e.team, e.position.x, e.position.z, MINE_WHEN, (z) => !z.flying && !z.isBuilding)) continue;
      layMine(w, e);
      m.left--;
      m.next = this.time + MINE_EVERY;
    }
  }

  /** The player's Coyote lays its mines on E. */
  special(u: Unit): VehicleSpecial | null {
    if (u.kind.name !== 'coyote') return null;
    const m = this.magazine(u);
    return {
      label: 'Scuttle Mine',
      use: () => {
        if (m.left <= 0) return `No mines · one back in ${Math.ceil(m.reload)}s`;
        layMine(this.w, u);
        m.left--;
        return null;
      },
      bar: () => ({ label: 'Scuttle Mines', key: 'E', value: m.left / MINES, text: m.left ? `${m.left} of ${MINES}` : `Next in ${Math.ceil(m.reload)}s`, color: 'linear-gradient(90deg, #ffb040, #ffe8a0)' }),
    };
  }

  /** Every Coyote's magazine full again (the Practice Range's recharge). */
  refill() {
    for (const e of this.w.entities) if (e.kind.name === 'coyote' && e.alive) this.magazine(e).left = MINES;
  }
}
