import * as THREE from 'three';
import type { Ground } from '../engine/terrain.ts';
import type { Warship } from './warship.ts';
import { lookAtPose, type CameraPose } from './camera.ts';
import type { Entity } from './entity.ts';
import type { Layout } from './layout.ts';
import type { World } from './world.ts';

type Shot = 'orbit' | 'lane' | 'swarm' | 'ship';

const SEQUENCE: Shot[] = ['orbit', 'lane', 'swarm', 'ship', 'lane', 'swarm', 'orbit', 'lane', 'ship', 'swarm'];
/**
 * How quickly the camera follows where a shot wants it, seconds (a camera operator's ease):
 * enough to take out a frame's jitter on the steady shots; much more on the swarm, whose
 * subject runs, scatters and dies.
 */
const EASE: Record<Shot, number> = { orbit: 0.25, lane: 0.25, ship: 0.25, swarm: 0.9 };
/** The swarm shot's subject: one pack, followed by its middle, at no more than a run. */
const PACK = { radius: 28, size: 40, least: 4, follow: 1.2, maxSpeed: 14 };
const v = new THREE.Vector3();
const w2 = new THREE.Vector3();

/**
 * The menu's camera: the battle behind the menus, shot like a trailer. Slow orbits of the
 * base, a low dolly behind a bunker down its lane, a tracking shot on the swarm, the
 * Warship against the sky, cut together every few seconds. Within a shot it moves the
 * way a camera operator would, easing after its subject; it only jumps on a cut.
 */
export class Attract {
  private index = -1;
  private t = 0;
  private duration = 0;
  private shot: Shot = 'orbit';
  private lane = 0;
  private angle = Math.random() * Math.PI * 2;
  /** The swarm shot's pack, and where its middle is (eased). */
  private pack: Entity[] = [];
  private focus = new THREE.Vector3();
  /** Where the camera is and looks, eased toward the shot's own. */
  private eye = new THREE.Vector3();
  private look = new THREE.Vector3();
  /** A cut happened this frame (the caller can flash a fade). */
  cut = false;

  constructor(
    private world: World,
    private layout: Layout,
    private ground: Ground,
    private ship: Warship,
  ) {}

  private next() {
    this.index = (this.index + 1) % SEQUENCE.length;
    this.shot = SEQUENCE[this.index];
    this.t = 0;
    this.duration = this.shot === 'orbit' ? 13 : this.shot === 'ship' ? 9 : 10;
    this.angle += 1.7 + Math.random();
    if (this.shot === 'lane') this.lane = (this.lane + 1) % this.layout.lanes.length;
    if (this.shot === 'swarm' && !this.pickPack(null)) {
      this.shot = 'lane';
      this.lane = (this.lane + 1) % this.layout.lanes.length;
    }
    this.cut = true;
  }

  private crawl(): Entity[] {
    return this.world.entities.filter((e) => e.team !== 'holdouts' && e.targetable && !e.flying);
  }

  /**
   * Picks the pack to follow: the Crawl nearest the base (or nearest `near`) and the others
   * around it. False when there's no pack worth a shot.
   */
  private pickPack(near: THREE.Vector3 | null): boolean {
    const from = near ?? this.world.goal?.position;
    if (!from) return false;
    const crawl = this.crawl();
    if (crawl.length < 6) return false;
    let lead = crawl[0];
    for (const e of crawl) if (e.position.distanceToSquared(from) < lead.position.distanceToSquared(from)) lead = e;
    const pack = crawl.filter((e) => e.position.distanceTo(lead.position) < PACK.radius);
    if (pack.length < PACK.least) return false;
    pack.sort((a, b) => a.position.distanceToSquared(lead.position) - b.position.distanceToSquared(lead.position));
    this.pack = pack.slice(0, PACK.size);
    if (!near) this.middle(this.focus);
    return true;
  }

  /** The middle of what's left of the pack: the median on each axis, so stragglers don't drag it. */
  private middle(out: THREE.Vector3): boolean {
    this.pack = this.pack.filter((e) => e.targetable);
    if (this.pack.length < PACK.least && !this.pickPack(this.focus)) return false;
    const xs = this.pack.map((e) => e.position.x).sort((a, b) => a - b);
    const zs = this.pack.map((e) => e.position.z).sort((a, b) => a - b);
    const m = this.pack.length >> 1;
    out.set(xs[m], 0, zs[m]);
    return true;
  }

  private above(p: THREE.Vector3, clearance: number): THREE.Vector3 {
    p.y = Math.max(p.y, this.ground.heightAt(p.x, p.z) + clearance);
    return p;
  }

  /** The shot's own camera position (`v`) and target (`w2`) this moment, before easing. */
  private aim(dt: number): number {
    const cc = this.world.goal?.position ?? new THREE.Vector3();
    const t = this.t;
    switch (this.shot) {
      case 'orbit': {
        const a = this.angle + t * 0.045;
        v.set(cc.x + Math.sin(a) * 175, cc.y + 72 - t * 1.2, cc.z + Math.cos(a) * 175);
        this.above(v, 20);
        w2.copy(cc);
        w2.y += 8;
        return 48;
      }
      case 'lane': {
        const lane = this.layout.lanes[this.lane];
        const b = lane.bunker ? new THREE.Vector3(lane.bunker.x, 0, lane.bunker.z) : lane.posts[0]?.clone() ?? cc.clone();
        b.y = this.ground.heightAt(b.x, b.z);
        const out = new THREE.Vector3(lane.spawn.x - b.x, 0, lane.spawn.z - b.z).normalize();
        const side = new THREE.Vector3(-out.z, 0, out.x);
        // Behind and beside the bunker, dollying slowly toward it.
        v.copy(b).addScaledVector(out, -34 + t * 1.4).addScaledVector(side, 13);
        v.y = b.y + 6.5;
        this.above(v, 4);
        w2.copy(b).addScaledVector(out, 60);
        w2.y = this.ground.heightAt(w2.x, w2.z) + 3;
        return 52;
      }
      case 'swarm': {
        // The pack's middle, followed at no more than a run, and the camera circling it.
        const target = new THREE.Vector3();
        if (this.middle(target)) {
          const step = target.sub(this.focus).multiplyScalar(1 - Math.exp(-dt / PACK.follow));
          const most = PACK.maxSpeed * dt;
          if (step.length() > most) step.setLength(most);
          this.focus.add(step);
        }
        const a = this.angle + t * 0.08;
        v.set(this.focus.x + Math.sin(a) * 42, 0, this.focus.z + Math.cos(a) * 42);
        // Above the higher of the ground here and under the pack, so a slope doesn't tip it.
        const floor = Math.max(this.ground.heightAt(v.x, v.z), this.ground.heightAt(this.focus.x, this.focus.z));
        v.y = floor + 14;
        w2.copy(this.focus);
        w2.y = this.ground.heightAt(w2.x, w2.z) + 2;
        return 50;
      }
      case 'ship': {
        const s = this.ship.position;
        const a = this.angle + t * 0.03;
        // Below and off to the side of the hull, looking up past it at the sky.
        v.set(s.x + Math.sin(a) * 150, s.y - 70 + t * 3, s.z + Math.cos(a) * 150);
        w2.copy(s);
        return 46;
      }
    }
  }

  pose(dt: number): CameraPose {
    this.cut = false;
    this.t += dt;
    if (this.index < 0 || this.t > this.duration) this.next();
    const fov = this.aim(dt);
    if (this.cut) {
      this.eye.copy(v);
      this.look.copy(w2);
    } else {
      const k = 1 - Math.exp(-dt / EASE[this.shot]);
      this.eye.lerp(v, k);
      this.look.lerp(w2, k);
      // Eased or not, never into the ground.
      this.above(this.eye, this.shot === 'lane' ? 3 : 6);
    }
    return lookAtPose(this.eye, this.look, fov);
  }
}
