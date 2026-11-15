import * as THREE from 'three';
import { HeroVisual } from '../../visual.ts';
import { TEAM_COLOR, type World } from '../../world.ts';

/**
 * The swarm's sky, in the cinematic look we're after: Lanterns hanging over the
 * swarm's side of the battlefield, far bigger than the ones that fly the drops, their tentacles
 * trailing almost to the ground, drifting in the haze. Scenery: nothing shoots them and they
 * shoot nothing; they're what the swarm looks like from the line.
 */

/**
 * How high the sun stands over the swarm's side (radians): low, so it glares through the haze;
 * not so low that every big Crawl drags a shadow three times its height toward the line.
 */
export const SUN_ELEVATION = 0.55;
/**
 * The sky's fill light, of the map's: what faces away from the sun goes dark against the haze,
 * but the haze lights the shadows too (darker, a Tusker's lay on the ground like a black
 * cut-out of its blades).
 */
export const SKY_FILL = 0.8;

/** How many, and how much bigger than a unit Lantern (the cinematic look has them several times the size). */
const COUNT = 14;
const SCALE = 3.6;
/** How far from the base they hang, and the gap left under their tentacles (meters). */
const NEAREST = 290;
const FARTHEST = 900;
const CLEARANCE: [number, number] = [6, 45];
/** How far either side of the swarm's routes, radians. */
const SPREAD = 0.75;
/** The two hung nearer, along the opening's view: off its axis (radians) and how far out (meters, past the line). */
const FEATURED = [
  { bearing: -0.2, distance: 330 },
  { bearing: 0.24, distance: 400 },
];
/** Drift, meters a second. */
const DRIFT: [number, number] = [1.2, 3.5];
/**
 * What a Lantern hangs over: the highest ground this far round it (meters), not what's right
 * under it, and never lower than the base's own floor (the map's chasms run 60 m under it, wider
 * than any footprint); it rises or sinks toward that slowly (a share a second), so it sails over a
 * chasm or a valley instead of dropping into it.
 */
const FOOTPRINT = 60;
const SETTLE = 0.35;

interface Hanging {
  v: HeroVisual;
  at: THREE.Vector3;
  heading: number;
  speed: number;
  /** Height above the ground of the model's origin. */
  lift: number;
  bob: number;
  /** The height it hangs at, eased toward the ground it's over. */
  y: number | null;
}

export class LanternSky {
  private hosts: Hanging[] = [];
  private center = new THREE.Vector3();
  /** The lowest a Lantern's ground can be: the base's floor. */
  private floor = -Infinity;

  /**
   * Over the swarm's side: around the bearings from `base` to each of `routes`. Two hang nearer
   * along `featured` (the way the opening's doors face), so the first look out has them close.
   */
  constructor(
    private world: World,
    base: THREE.Vector3,
    routes: THREE.Vector3[],
    featured: THREE.Vector3 | null = null,
  ) {
    const t = world.models.lantern;
    if (!t || !routes.length) return;
    const scale = world.scaleOf('lantern') * SCALE;
    const bottom = t.bounds.min.y * scale;
    const bearings = routes.map((r) => Math.atan2(r.z - base.z, r.x - base.x));
    const ahead = featured ? Math.atan2(featured.z, featured.x) : null;
    for (let i = 0; i < COUNT; i++) {
      const near = ahead !== null && i < FEATURED.length;
      const bearing = near ? ahead + FEATURED[i].bearing : bearings[i % bearings.length] + (Math.random() * 2 - 1) * SPREAD;
      // Near ones few, far ones many: the eye reads depth from the haze swallowing them.
      const d = near ? FEATURED[i].distance : NEAREST + (FARTHEST - NEAREST) * Math.pow(Math.random(), 1.3);
      const at = new THREE.Vector3(base.x + Math.cos(bearing) * d, 0, base.z + Math.sin(bearing) * d);
      const v = new HeroVisual(t.instantiate(TEAM_COLOR.crawl), world.scene);
      v.play('Walk', { timeScale: 0.45 });
      const lift = CLEARANCE[0] + Math.random() * (CLEARANCE[1] - CLEARANCE[0]) - bottom;
      this.hosts.push({ v, at, heading: bearing + Math.PI + (Math.random() - 0.5) * 1.4, speed: DRIFT[0] + Math.random() * (DRIFT[1] - DRIFT[0]), lift, bob: Math.random() * 6.28, y: null });
    }
    this.center.copy(base);
    this.floor = world.terrain.heightAt(base.x, base.z);
    this.update(0);
  }

  update(dt: number) {
    const w = this.world;
    const scale = w.scaleOf('lantern') * SCALE;
    for (const h of this.hosts) {
      h.bob += dt * 0.35;
      // A slow wander about where it hangs, never into the base nor off the far side.
      h.heading += Math.sin(h.bob * 0.6) * 0.04 * dt;
      h.at.x += Math.cos(h.heading) * h.speed * dt;
      h.at.z += Math.sin(h.heading) * h.speed * dt;
      const d = Math.hypot(h.at.x - this.center.x, h.at.z - this.center.z);
      if (d < NEAREST || d > FARTHEST) h.heading = Math.atan2(this.center.z - h.at.z, this.center.x - h.at.x) + (d < NEAREST ? Math.PI : 0) + (Math.random() - 0.5) * 0.6;
      const want = this.over(h.at) + h.lift;
      h.y = h.y === null ? want : h.y + (want - h.y) * (1 - Math.exp(-dt * SETTLE));
      const p = new THREE.Vector3(h.at.x, h.y + Math.sin(h.bob) * 2.5, h.at.z);
      h.v.sync(p, Math.PI / 2 - h.heading, scale);
      h.v.update(dt);
    }
  }

  /** The highest ground under a Lantern's footprint round `at`, or the base's floor. */
  private over(at: THREE.Vector3): number {
    const t = this.world.terrain;
    let top = Math.max(this.floor, t.heightAt(at.x, at.z));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      for (const r of [FOOTPRINT * 0.5, FOOTPRINT]) top = Math.max(top, t.heightAt(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r));
    }
    return top;
  }
}
