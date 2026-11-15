import * as THREE from 'three';
import type { Entity, Unit } from '../entity.ts';

/**
 * A leap onto what it's attacking (the later campaign's Leaper strain, its LeaperCharge): when
 * the target is near but out of reach, it springs the rest of the way in an arc, over whatever is
 * in between, and lands in reach of its claws. In the air it plays its model's Jump clip, as the
 * Leaper's actor does; it lands in a puff of dust (RaptorJumpDustModel's JumpLandDust). Its
 * controller waits while it's in the air, through the unit's `morph` (the hook a transformation
 * uses: whatever drives the unit pauses until it's done).
 */

/** How far short of the target's edge it lands, meters: inside its claws' reach. */
const LAND_SHORT = 0.15;

/** When each leaper may leap next (world time). */
const ready = new WeakMap<Unit, number>();
/** Leapers that already put their body back on the ground if they die mid-leap. */
const grounded = new WeakSet<Unit>();

export class Leap {
  private t = 0;
  private readonly from: THREE.Vector3;
  private readonly to: THREE.Vector3;
  private readonly time: number;
  private readonly apex: number;
  private readonly wasCustom: boolean;

  constructor(
    private u: Unit,
    to: THREE.Vector3,
  ) {
    const l = u.kind.leap!;
    const w = u.world;
    this.from = u.position.clone();
    this.to = to.clone().setY(w.terrain.heightAt(to.x, to.z));
    const d = Math.hypot(to.x - u.position.x, to.z - u.position.z);
    this.time = Math.max(0.12, d / l.speed);
    // A shorter leap is a lower one.
    this.apex = l.apex * Math.min(1, d / l.max);
    this.wasCustom = u.customAnimation;
    u.customAnimation = true;
    u.airborne = true;
    u.move.set(0, 0);
    u.face = null;
    u.yaw = Math.atan2(to.x - u.position.x, to.z - u.position.z);
    u.velocity.set((to.x - u.position.x) / this.time, 0, (to.z - u.position.z) / this.time);
    u.visual.play('Jump', { restart: true, fade: 0.1 });
    w.audio.play('leaperJump', { at: u.position, volume: 0.35, limit: 3 });
  }

  /** True while it's in the air. */
  update(dt: number): boolean {
    const u = this.u;
    this.t += dt;
    const k = Math.min(1, this.t / this.time);
    u.move.set(0, 0);
    u.position.lerpVectors(this.from, this.to, k);
    u.position.y = THREE.MathUtils.lerp(this.from.y, this.to.y, k) + this.apex * 4 * k * (1 - k);
    u.syncTransform();
    if (k < 1) return true;
    this.land();
    return false;
  }

  /** Back on its feet where it came down. */
  land() {
    const u = this.u;
    const w = u.world;
    u.morph = null;
    u.airborne = false;
    u.customAnimation = this.wasCustom;
    u.position.y = w.terrain.heightAt(u.position.x, u.position.z);
    u.velocity.set(0, 0, 0);
    u.visual.play('Stand', { fade: 0.12 });
    w.playEffect('jumpLandDust', u.position, null, w.effectScale);
    w.audio.play('leaperLand', { at: u.position, volume: 0.4, limit: 3 });
  }
}

/**
 * Leaps at `t` if `u` can: a kind that leaps, ready, on the ground, and the target on the ground
 * beyond its claws' reach but within the leap's, with somewhere to land beside it. True if it has.
 */
export function leapAt(u: Unit, t: Entity): boolean {
  const l = u.kind.leap;
  const w = u.world;
  if (!l || u.morph || u.airborne || u.flying || t.flying || t.isBuilding || !t.targetable) return false;
  if ((ready.get(u) ?? 0) > w.time) return false;
  const gap = u.gap(t);
  if (gap < l.min || gap > l.max) return false;
  const dx = t.position.x - u.position.x;
  const dz = t.position.z - u.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const short = u.radius + t.radius + LAND_SHORT;
  const to = new THREE.Vector3(t.position.x - (dx / d) * short, 0, t.position.z - (dz / d) * short);
  // The data's TargetIsPathable: nowhere to land, no leap.
  if (!w.walkable(to.x, to.z)) return false;
  ready.set(u, w.time + l.cooldown);
  if (!grounded.has(u)) {
    grounded.add(u);
    // Killed in the air: it falls where it was, not hanging there.
    u.whenDead.push(() => {
      if (u.morph instanceof Leap) u.position.y = w.terrain.heightAt(u.position.x, u.position.z);
    });
  }
  u.morph = new Leap(u, to);
  return true;
}
