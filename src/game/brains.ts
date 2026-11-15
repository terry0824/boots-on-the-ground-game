import * as THREE from 'three';
import { FASTER, hitDamage } from './stats.ts';
import type { Building, Controller, Entity, Unit } from './entity.ts';
import { RANGE_METERS_PER_CELL, type Weapon } from './kinds.ts';
import { leapAt } from './systems/leap.ts';
import { HeroVisual } from './visual.ts';
import { ALERT_SECONDS, canHit, type World } from './world.ts';

const AGGRO = 34;
/** How far the swarm runs at whoever shot one of it (it doesn't give up easily). */
const SWARM_LEASH = 160;
/** How far beyond its leash a guard will go to answer fire. */
const GUARD_PURSUIT = 50;
/** How far out ahead of the player a squad looks for the next fight, meters. */
const LOOKAHEAD = 45;
/** A squadmate short of its place runs this much faster (to get out ahead of a walking player, or catch up). */
const CATCH_UP = 1.35;
const dir = new THREE.Vector2();
const v1 = new THREE.Vector3();

export function faceTowards(u: Unit, t: Entity) {
  u.face = Math.atan2(t.position.x - u.position.x, t.position.z - u.position.z);
}

/** Soldiers this close to the player's body join what it shoots (meters). */
const FOCUS_NEAR = 40;
/** How long a soldier's pledge to the player's target counts toward it (seconds). */
const PLEDGE_SECONDS = 1;
const pledged = new WeakMap<Entity, { at: number; damage: number }>();

/**
 * Whether `u` joins the player's target `t`. Only soldiers near the player do, and only as many
 * as it takes: each one that joins pledges an attack's damage to it, and once the pledges would
 * kill it the rest keep their own targets. A Hound the player shot draws a rifle or two, not
 * every rifle in reach while the rest of its pack walks in; a Tusker draws them all.
 */
export function joinFocus(u: Unit, t: Entity): boolean {
  const w = u.world;
  const player = w.player;
  if (!player || Math.hypot(player.position.x - u.position.x, player.position.z - u.position.z) > FOCUS_NEAR) return false;
  const weapon = u.weaponFor(t);
  if (!weapon) return false;
  const p = pledged.get(t);
  const damage = p && w.time - p.at < PLEDGE_SECONDS ? p.damage : 0;
  if (damage >= t.hp) return false;
  pledged.set(t, { at: w.time, damage: damage + hitDamage(weapon.damage, t.kind.attributes, t.kind.armor) });
  return true;
}

/** Whoever drew blood from `u` or its side nearby (World.alarm), while it's fresh and they're there to hit. */
function alerted(u: Unit): Entity | null {
  const a = u.alert;
  const memory = u.team === 'crawl' ? ALERT_SECONDS.swarm : ALERT_SECONDS.squad;
  if (!a || u.world.time - a.at > memory || !a.by.targetable || a.by.team === u.team) return null;
  return a.by;
}

/**
 * A ranged soldier doesn't stand in the open between shots: a few steps aside while the
 * weapon cycles, facing the target, then still again for the shot. Returns whether it moved.
 */
export function sidestep(u: Unit, t: Entity, amount = 0.55): boolean {
  const w = u.kind.weapon;
  if (!w || w.melee || u.immobile || u.flying) return false;
  // Ready again soon: hold still for it.
  if (u.cooldown < w.period * 0.35) return false;
  const dx = t.position.x - u.position.x;
  const dz = t.position.z - u.position.z;
  const d = Math.hypot(dx, dz) || 1;
  // Each soldier picks a side and switches now and then.
  const side = Math.sin(u.world.time * 1.1 + u.id * 1.7) > 0 ? 1 : -1;
  const sx = (-dz / d) * side;
  const sz = (dx / d) * side;
  if (!u.world.walkable(u.position.x + sx * 2.5, u.position.z + sz * 2.5)) return false;
  u.move.set(sx, sz).multiplyScalar(amount);
  u.face = Math.atan2(dx, dz);
  return true;
}

/** How near its spot a unit standing still counts as there: it sets off back only when shoved further off it, meters. */
const AT_SPOT = 5;
/** How near its spot a unit held up by others in the way settles where it is, meters. */
const SETTLE_NEAR = 14;
/** Seconds held up before it settles. */
const SETTLE_BLOCKED = 0.8;

/**
 * A unit going back to its spot, the way an RTS's units arrive rather than fighting their
 * way onto the exact point: one already near enough stays where it is (back on the move only
 * once it has been shoved well off it, and then all the way back); one held up near it by others
 * in the way (a crowd, a Bulwark parked there) stops where it is instead of pushing, and keeps that
 * place for as long as its spot stays where it is; and it never heads into the footprint of
 * something of its own side that it can't push.
 */
export class Homing {
  private going = false;
  private rest: THREE.Vector3 | null = null;
  private readonly restFor = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();

  /** Where to walk to get back to `spot`, or null to stand where it is. */
  toward(u: Unit, spot: THREE.Vector3): THREE.Vector3 | null {
    if (this.rest && this.restFor.distanceToSquared(spot) > 1) this.rest = null;
    const goal = clearOf(u, this.goal.copy(this.rest ?? spot));
    const away = Math.hypot(goal.x - u.position.x, goal.z - u.position.z);
    if (away <= (this.going ? 2 : AT_SPOT)) {
      this.going = false;
      return null;
    }
    if (u.blocked > SETTLE_BLOCKED && away < SETTLE_NEAR) {
      this.rest = u.position.clone();
      this.restFor.copy(spot);
      this.going = false;
      return null;
    }
    this.going = true;
    return goal;
  }
}

/** `goal`, moved out from under anything of `u`'s own side that `u` can't push (a Behemoth standing on it). */
function clearOf(u: Unit, goal: THREE.Vector3): THREE.Vector3 {
  const w = u.world;
  for (const o of w.unitsNear(goal.x, goal.z, u.radius + 20)) {
    if (o === u || o.team !== u.team || o.flying || w.pushPriority(o, u) <= w.pushPriority(u, o)) continue;
    const dx = goal.x - o.position.x;
    const dz = goal.z - o.position.z;
    const min = o.radius + u.radius + 1;
    const d = Math.hypot(dx, dz);
    if (d >= min) continue;
    if (d < 1e-3) goal.x = o.position.x + min;
    else {
      goal.x = o.position.x + (dx / d) * min;
      goal.z = o.position.z + (dz / d) * min;
    }
  }
  return goal;
}

/**
 * Melee closing on a target: not all at its front, but each to its own side of it, so a pack
 * surrounds what it's after (the RTS surround).
 */
function surround(u: Unit, t: Entity, out: THREE.Vector2): THREE.Vector2 {
  const dx = t.position.x - u.position.x;
  const dz = t.position.z - u.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 14 || d < 1e-3) return out.set(dx, dz).normalize();
  const a = Math.atan2(-dx, -dz) + ((u.id * 2.399) % (Math.PI * 2)) * 0.5 - Math.PI / 4;
  const ring = t.radius + u.radius + 0.6;
  return out.set(t.position.x + Math.sin(a) * ring - u.position.x, t.position.z + Math.cos(a) * ring - u.position.z).normalize();
}

/** How much room a marching Crawl keeps from the others around it, meters beyond their sizes. */
const ELBOW_ROOM = 1.4;

/**
 * The swarm on the march: down the paths to the base as a tide rather than a column. It follows
 * the slope of the paths smoothly (the flow field's eight directions file a pack into a single
 * line), eases apart from the others close by, and weaves a little from side to side, so a pack
 * spreads across the ground it crosses and narrows only where the ground does.
 */
export class March {
  private weave = Math.random() * Math.PI * 2;
  private near: Unit[] = [];
  /** How long it has stood wedged where the paths don't reach. */
  private wedged = 0;

  /** `room`: the elbow room it keeps, meters beyond their sizes. */
  constructor(private room = ELBOW_ROOM) {}

  /** The way to go now, into `out`; false where there's no path to follow. */
  step(u: Unit, dt: number, out: THREE.Vector2): boolean {
    const w = u.world;
    const f = w.flow;
    const c = f.cell;
    const x = u.position.x;
    const z = u.position.z;
    // Off the paths (shouldered onto a cliff's edge by the crowd): straight back onto them, and
    // if it's wedged there and can't get off, set back on them.
    if (f.distance(x, z) === Infinity) {
      this.wedged = Math.hypot(u.velocity.x, u.velocity.z) < 0.3 ? this.wedged + dt : 0;
      if (this.wedged > 2 && f.rejoin(x, z, out)) {
        u.position.set(out.x, w.terrain.heightAt(out.x, out.y), out.y);
        this.wedged = 0;
      }
      return f.escape(u.position.x, u.position.z, out);
    }
    this.wedged = 0;
    // Down the slope of the paths, from the distances on either side.
    const e = f.distance(x + c, z);
    const wst = f.distance(x - c, z);
    const n = f.distance(x, z + c);
    const sth = f.distance(x, z - c);
    if (Number.isFinite(e + wst + n + sth)) out.set(wst - e, sth - n);
    else out.set(0, 0);
    if (out.lengthSq() < 1e-6 && !f.direction(x, z, out) && !f.escape(x, z, out)) return false;
    out.normalize();
    // Elbow room, and the weave.
    let sx = 0;
    let sz = 0;
    for (const o of w.unitsNear(x, z, u.radius + 6, this.near)) {
      if (o === u || o.team !== u.team || o.flying) continue;
      const dx = x - o.position.x;
      const dz = z - o.position.z;
      const d = Math.hypot(dx, dz);
      const reach = u.radius + o.radius + this.room;
      if (d < 1e-3 || d > reach) continue;
      const k = (reach - d) / reach;
      sx += (dx / d) * k;
      sz += (dz / d) * k;
    }
    this.weave += dt * 0.6;
    const side = Math.sin(this.weave) * 0.22;
    const mx = out.x + sx * 1.3 - out.y * side;
    const mz = out.y + sz * 1.3 + out.x * side;
    const len = Math.hypot(mx, mz) || 1;
    // Never shouldered off the paths: where the spread would walk it off them (a ledge, a
    // cliff's edge), straight down the path.
    if (f.distance(x + (mx / len) * 3, z + (mz / len) * 3) < Infinity) out.set(mx / len, mz / len);
    return true;
  }
}

/**
 * The swarm: march on the base as a tide (March), peel off toward anything human that comes
 * close, and attack whatever is in reach.
 */
export class CrawlBrain implements Controller {
  private target: Entity | null = null;
  /** Running at someone it may not attack yet (the player's body, with no token free). */
  private approach: Entity | null = null;
  private retarget = Math.random() * 0.4;
  /** Limits what it goes for (a pack with one quarry), or null for anything. */
  only: ((e: Entity) => boolean) | null = null;
  private march = new March();

  constructor(private u: Unit) {}

  release() {
    this.u.world.engagePlayer(this.u, false);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.alive) {
      this.retarget = 0.35 + Math.random() * 0.3;
      // Units first; buildings only once they're close or when they're the goal itself. The
      // player's own body only while an attack token is free.
      const allowed = (e: Entity) => (e !== w.player || w.mayEngagePlayer(u)) && (!this.only || this.only(e));
      // Flyers see further: they're over the fight, not in it.
      const aggro = u.flying ? AGGRO * 1.6 : AGGRO;
      // Shot from beyond sight: the whole pack goes for the shooter.
      const shooter = alerted(u);
      const chase = shooter && canHit(u.kind.weapon, shooter) && u.gap(shooter) < SWARM_LEASH && (!this.only || this.only(shooter)) ? shooter : null;
      this.target =
        w.nearestTarget(u, aggro, (e) => !e.isBuilding && allowed(e)) ??
        w.nearestTarget(u, u.flying ? 40 : 12, allowed) ??
        (chase && allowed(chase) ? chase : null) ??
        (w.goal && u.gap(w.goal) < 30 && canHit(u.kind.weapon, w.goal) ? w.goal : null);
      // The player without a token free: close in anyway, and fight whatever's around them.
      this.approach = !this.target || this.target === w.goal ? chase : null;
      w.engagePlayer(u, !!this.target && this.target === w.player);
    }
    const t = this.target === w.goal && this.approach ? null : this.target;
    u.face = null;
    if (u.flying) return this.fly(t ?? this.approach);
    if (t?.alive) {
      if (u.inRange(t)) {
        if (!sidestep(u, t, 0.35)) {
          u.move.set(0, 0);
          faceTowards(u, t);
        }
        u.attack(t);
        return;
      }
      // Head straight for it (melee to its own side of it) unless a cliff is in the way; then
      // the long way round.
      if (u.kind.weapon?.melee) {
        // One that leaps (the Leaper) springs the last few meters.
        if (u.kind.leap && leapAt(u, t)) return;
        surround(u, t, dir);
        v1.set(u.position.x + dir.x * 4, 0, u.position.z + dir.y * 4);
        w.chase(u, t.position, dir, v1);
      } else w.chase(u, t.position, dir);
      u.move.copy(dir);
      return;
    }
    const a = this.approach;
    if (a?.targetable && Math.hypot(a.position.x - u.position.x, a.position.z - u.position.z) > 6) {
      u.move.copy(w.chase(u, a.position, dir));
      return;
    }
    if (this.march.step(u, dt, dir)) {
      u.move.copy(dir);
    } else if (w.goal) {
      u.move.set(w.goal.position.x - u.position.x, w.goal.position.z - u.position.z).normalize();
    } else {
      u.move.set(0, 0);
    }
  }

  /**
   * In the air there are no paths: straight at the target. Kites keep moving while they
   * fight, swirling around their prey between Bounce Shards (their weapon fires on the move);
   * a Sower hangs at the edge of its range and lets the mites do the work.
   */
  private fly(t: Entity | null) {
    const u = this.u;
    const w = u.world;
    const goal = t?.alive ? t.position : w.goal?.position;
    if (!goal) {
      u.move.set(0, 0);
      return;
    }
    dir.set(goal.x - u.position.x, goal.z - u.position.z);
    const d = dir.length();
    if (d > 1e-3) dir.divideScalar(d);
    const weapon = u.kind.weapon;
    if (!t?.alive || !weapon) {
      u.move.copy(dir);
      return;
    }
    const reach = weapon.range + u.radius + t.radius;
    if (u.inRange(t)) u.attack(t);
    if (u.kind.def.strafe) {
      // Orbit at about two-thirds of the weapon's reach, closing in or drifting out to hold it.
      const radial = THREE.MathUtils.clamp((d - reach * 0.65) / (reach * 0.35), -1, 1);
      const side = u.id % 2 ? 1 : -1;
      u.move.set(dir.x * radial - dir.y * side * 0.9, dir.y * radial + dir.x * side * 0.9).normalize();
      return;
    }
    if (d > reach * 0.9) u.move.copy(dir);
    else {
      u.move.set(0, 0);
      faceTowards(u, t);
    }
  }
}

/**
 * Infantry holding a post: fight what comes into range, chase a little way, return. On the
 * player's side they also fire at whatever the player is shooting; against the player they
 * take an attack token first, so only a few rifles are ever on the player's body at once.
 */
export class GuardBrain implements Controller {
  private target: Entity | null = null;
  /** Moving up on someone it may not fire at yet (the player's body, with no token free). */
  private approach: Entity | null = null;
  private retarget = Math.random() * 0.3;
  private homing = new Homing();

  constructor(
    private u: Unit,
    readonly post: THREE.Vector3,
    private leash = 26,
    private aggro = 44,
    /** How much further it goes after whoever is shooting at it (a line that must hold goes less far). */
    private pursuit = GUARD_PURSUIT,
  ) {}

  release() {
    this.u.world.engagePlayer(this.u, false);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.retarget -= dt;
    // Squadmates fire at whatever the player is shooting, when it's already in reach. They don't
    // walk out for it: what the player picks off at range is often in the middle of a pack, and
    // a soldier who leaves the post for it meets the pack.
    const focus = w.focus?.target;
    if (focus?.targetable && !focus.ignored && !focus.isBuilding && focus.team !== u.team && w.player?.team === u.team && focus !== this.target && u.inRange(focus) && joinFocus(u, focus)) {
      this.target = focus;
      this.retarget = 0.5;
    }
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.3;
      const allowed = (e: Entity) => e !== w.player || w.mayEngagePlayer(u);
      this.target = w.nearestTarget(u, this.aggro, allowed);
      if (this.target && Math.hypot(this.target.position.x - this.post.x, this.target.position.z - this.post.z) > this.leash + 30) {
        this.target = null;
      }
      // Fired on from beyond sight (this soldier or the ones beside it): go and answer it.
      const shooter = alerted(u);
      const inReach = shooter && canHit(u.kind.weapon, shooter) && Math.hypot(shooter.position.x - this.post.x, shooter.position.z - this.post.z) < this.leash + this.pursuit + (u.kind.weapon?.range ?? 0);
      this.approach = null;
      if (!this.target && inReach) {
        if (allowed(shooter)) this.target = shooter;
        else this.approach = shooter;
      }
      w.engagePlayer(u, !!this.target && this.target === w.player);
    }
    // No token on the player yet: move up with the others, to just outside firing range.
    const a = this.approach;
    if (!this.target && a?.targetable && u.gap(a) > (u.kind.weapon?.range ?? 0) * 0.9 && Math.hypot(u.position.x - this.post.x, u.position.z - this.post.z) < this.leash + this.pursuit) {
      u.face = null;
      u.move.copy(w.chase(u, a.position, dir));
      return;
    }
    const t = this.target;
    u.face = null;
    if (t?.alive && u.inRange(t)) {
      if (!sidestep(u, t)) {
        u.move.set(0, 0);
        faceTowards(u, t);
      }
      u.attack(t);
      return;
    }
    // Chasing is on a leash, a longer one while answering fire.
    const leash = alerted(u) === t && t ? this.leash + this.pursuit : this.leash;
    const chase = t?.alive && Math.hypot(u.position.x - this.post.x, u.position.z - this.post.z) < leash;
    const goal = chase ? t.position : this.homing.toward(u, this.post);
    const d = goal ? dir.set(goal.x - u.position.x, goal.z - u.position.z).length() : 0;
    if (goal && d > 2) u.move.copy(dir.divideScalar(d));
    else {
      u.move.set(0, 0);
      if (t?.alive) faceTowards(u, t);
    }
  }
}

/**
 * A bunker garrisoned by four troopers: each fires its coil rifle through the bunker,
 * with the bunker's +1 range.
 */
export class BunkerGuns implements Controller {
  private cooldowns = [0, 0.15, 0.3, 0.45];
  private target: Entity | null = null;
  private retarget = 0;
  readonly weapon: Weapon;
  /** Players inside; AI Troopers man the remaining slots. */
  occupants = 0;

  get hasRoom(): boolean {
    return this.occupants < this.cooldowns.length;
  }

  constructor(
    private b: Building,
    rifle: Weapon,
  ) {
    this.weapon = { ...rifle, range: rifle.range + RANGE_METERS_PER_CELL };
  }

  update(dt: number) {
    const b = this.b;
    const w = b.world;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.alive) {
      this.retarget = 0.3;
      this.target = w.nearestEnemy(b.team, b.position.x, b.position.z, this.weapon.range + b.radius, (e) => canHit(this.weapon, e));
    }
    const t = this.target;
    for (let i = 0; i < this.cooldowns.length - this.occupants; i++) {
      this.cooldowns[i] -= dt;
      if (this.cooldowns[i] > 0 || !t?.alive) continue;
      this.cooldowns[i] = this.weapon.period * (0.9 + Math.random() * 0.2);
      // Fire from the slit facing the target: the model's own where it marks them (World.outlet).
      if (!w.outlet(b, v1, t.position)) {
        v1.set(t.position.x - b.position.x, 0, t.position.z - b.position.z).normalize().multiplyScalar(b.radius * 0.8);
        v1.add(b.position);
        v1.y += b.height * 0.45;
      }
      w.shoot(b, v1, t, this.weapon);
      w.sfx.play('rifle.npc', { at: v1 });
    }
  }
}

/**
 * A turret structure's traverse (720 degrees a second at Normal speed), and the slow spin of an
 * idle Flak Tower's head (45 degrees a second).
 */
const HEAD_TRAVERSE = THREE.MathUtils.degToRad(720) * FASTER;
const HEAD_IDLE_SPIN = THREE.MathUtils.degToRad(45) * FASTER;
/** How far off its target a head may be and still fire, radians. */
const HEAD_ON_TARGET = 0.3;
const q1 = new THREE.Quaternion();

/**
 * A turret structure's head (the Flak Tower's Ref_TurretZ): a pivot slipped in above the
 * rig's turret bone, swung about world up through the bone's own origin. It faces the way the
 * building does at rest.
 */
class TurretHead {
  yaw: number;
  private pivot: THREE.Object3D | null = null;
  private bone: THREE.Bone | null = null;

  constructor(private b: Building) {
    this.yaw = b.yaw;
    const v = b.visual;
    if (!(v instanceof HeroVisual)) return;
    this.bone = v.instance.mesh.skeleton.bones.find((x) => x.userData.sourceName === 'Ref_TurretZ') ?? null;
    if (!this.bone?.parent) return;
    this.pivot = new THREE.Object3D();
    this.bone.parent.add(this.pivot);
    this.pivot.add(this.bone);
  }

  /** Turns toward world yaw `want` at `rate`; returns how far off it still is, radians. */
  turn(want: number, rate: number, dt: number): number {
    const diff = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
    const step = THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
    this.yaw += step;
    return Math.abs(diff - step);
  }

  apply() {
    const p = this.pivot;
    const bone = this.bone;
    if (!p || !bone || !p.parent) return;
    // About world up, through the bone's origin, in the parent's frame.
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(p.parent.getWorldQuaternion(q1).invert()).normalize();
    p.quaternion.setFromAxisAngle(axis, this.yaw - this.b.yaw);
    p.position.copy(bone.position).sub(bone.position.clone().applyQuaternion(p.quaternion));
  }
}

/**
 * A building with a weapon of its own (a Flak Tower): its head swings onto whatever that
 * weapon can hit within range and fires, each attack's missiles a moment apart (the Longbolt's
 * two), playing its own Attack. Idle, the head turns slowly, scanning for targets.
 */
export class TurretBrain implements Controller {
  private target: Entity | null = null;
  private retarget = 0;
  private cooldown = Math.random() * 0.5;
  private volley: { left: number; at: number } | null = null;
  private head: TurretHead;
  /** Seconds until the Attack animation gives way to Stand again. */
  private attacking = 0;

  constructor(private b: Building) {
    this.head = new TurretHead(b);
    this.head.yaw += Math.random() * Math.PI * 2;
  }

  update(dt: number) {
    const b = this.b;
    const w = b.world;
    const weapon = b.kind.weapon;
    if (!weapon) return;
    this.retarget -= dt;
    this.cooldown -= dt;
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.3;
      this.target = w.nearestTarget(b, weapon.range + b.radius);
    }
    const t = this.target;
    const off = t?.targetable ? this.head.turn(Math.atan2(t.position.x - b.position.x, t.position.z - b.position.z), HEAD_TRAVERSE, dt) : this.head.turn(this.head.yaw + 1, HEAD_IDLE_SPIN, dt);
    this.head.apply();
    if (this.attacking > 0 && (this.attacking -= dt) <= 0) b.visual.play('Stand');
    const v = this.volley;
    if (v) {
      v.at -= dt;
      if (v.at <= 0 && t?.targetable) {
        w.fireMissile(b, t, weapon, { ...weapon.damage, hits: 1 });
        const snd = b.kind.def.sounds?.attack;
        if (snd) w.audio.play(snd, { at: b.position, volume: 0.8, limit: 6, near: 14 });
        v.left--;
        v.at = 0.1;
      }
      if (v.left <= 0 || !t?.targetable) this.volley = null;
      return;
    }
    if (this.cooldown > 0 || !t?.targetable || off > HEAD_ON_TARGET) return;
    if (Math.hypot(t.position.x - b.position.x, t.position.z - b.position.z) - t.radius - b.radius > weapon.range) return;
    this.cooldown = weapon.period;
    this.volley = { left: weapon.damage.hits ?? 1, at: 0 };
    this.attacking = b.visual.play('Attack', { loop: false, restart: true }) || 0;
  }
}

/**
 * A squad following the player: the leader leaves a trail of footsteps, and followers walk
 * it around corners and cliffs until they're close, then fan out into a loose formation.
 */
export class Squad {
  readonly trail: THREE.Vector3[] = [];
  readonly members = new Set<Unit>();
  /** Where the squad holds when there's no leader on the ground. */
  rally = new THREE.Vector3();
  /** Which way the leader is going (smoothed, from how they move, not where they look). */
  readonly heading = new THREE.Vector2(0, 1);
  /** The leader is on the move (and the squad pushes on ahead of them). */
  moving = false;
  private lastTime = -1;
  private still = 0;

  constructor(readonly leader: () => Entity | null) {}

  update() {
    const l = this.leader();
    if (!l) return;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(l.position) > 3) {
      this.trail.push(l.position.clone());
      if (this.trail.length > 60) this.trail.shift();
    }
    this.rally.copy(l.position);
    const now = l.world.time;
    if (this.lastTime < 0) this.heading.set(Math.sin(l.yaw), Math.cos(l.yaw));
    const dt = this.lastTime < 0 ? 0 : Math.max(0, now - this.lastTime);
    this.lastTime = now;
    const v = (l as Partial<Unit>).velocity;
    const speed = v ? Math.hypot(v.x, v.z) : 0;
    if (v && speed > 1.2) {
      const k = 1 - Math.exp(-dt * 2.5);
      this.heading.x += (v.x / speed - this.heading.x) * k;
      this.heading.y += (v.z / speed - this.heading.y) * k;
      if (this.heading.lengthSq() < 1e-6) this.heading.set(v.x / speed, v.z / speed);
      this.heading.normalize();
      this.moving = true;
      this.still = 0;
    } else {
      this.still += dt;
      if (this.still > 1.2) this.moving = false;
    }
  }

  /**
   * Followers' slots, the way a shooter's squad moves: a loose line abreast out ahead of the
   * leader in the direction they're going, so the squad meets the fight first; closer in, and
   * to the sides, while the leader holds still. `behind` keeps a slot at the leader's back
   * (the Medic). A slot on bad ground (inside a building, over a cliff edge) closes in toward
   * the leader until it's on open ground the follower can stand on.
   */
  slot(i: number, out: THREE.Vector3, behind = false, close = false): THREE.Vector3 {
    const l = this.leader();
    const base = l ? l.position : this.rally;
    const w = l?.world;
    const hx = this.heading.x;
    const hz = this.heading.y;
    // `close` keeps a slot abreast of the leader rather than out in front (Echo, at the Corporal's side).
    const fwd = behind ? -3 - (i % 3) : close ? 2 + (i % 2) * 2 : this.moving ? 8 + (i % 3) * 3 : 3 + (i % 3) * 1.5;
    const side = (i % 2 ? 1 : -1) * (3.5 + Math.floor(i / 2) * 3.2);
    // (hz, -hx) is the heading's right.
    for (const k of [1, 0.7, 0.45, 0.25]) {
      out.set(base.x + (hx * fwd + hz * side) * k, 0, base.z + (hz * fwd - hx * side) * k);
      if (!w || openGround(w, out.x, out.z, 1.2)) return out;
    }
    return out.set(base.x + hz * side * 0.4, 0, base.z - hx * side * 0.4);
  }
}

/** Ground a unit could stand on: walkable, and clear of buildings by `margin` meters. */
export function openGround(w: World, x: number, z: number, margin: number): boolean {
  if (!w.walkable(x, z)) return false;
  for (const b of w.buildings) if (Math.hypot(b.position.x - x, b.position.z - z) < b.radius + margin) return false;
  return true;
}

/** One of the player's squad: keeps up, fights alongside, focuses the player's target. */
export class SquadBrain implements Controller {
  private target: Entity | null = null;
  private retarget = Math.random() * 0.3;
  private crumb = -1;
  private index: number;
  /** A spot we couldn't get to: hold where we are until the squad moves on from it. */
  private gaveUp: THREE.Vector3 | null = null;

  constructor(
    private u: Unit,
    private squad: Squad,
    /** Abreast of the leader instead of out in front (Echo Squad, at the Corporal's side). */
    private close = false,
  ) {
    squad.members.add(u);
    this.index = squad.members.size - 1;
  }

  release() {
    this.squad.members.delete(this.u);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    const leader = this.squad.leader();
    const anchor = leader?.position ?? this.squad.rally;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.3;
      const reach = (u.kind.weapon?.range ?? 20) + 14;
      // In order: what the player is shooting, when we can get at it; soldiers shooting at us;
      // whatever's out ahead of the leader, where they're headed (the squad sees it first);
      // whoever is firing on the squad from further off; then anything else standing in reach.
      const threat = w.nearestTarget(u, reach, (e) => !e.isBuilding);
      const focus = w.focus?.target;
      const useFocus = focus?.targetable && focus.team !== u.team && !focus.ignored && canHit(u.kind.weapon, focus) && u.gap(focus) < reach + 10 && (!threat || !focus.isBuilding) && (focus === this.target || joinFocus(u, focus));
      const ahead = threat ?? w.nearestTarget(u, LOOKAHEAD, (e) => !e.isBuilding, anchor);
      const shooter = alerted(u);
      const answer = shooter && canHit(u.kind.weapon, shooter) && Math.hypot(shooter.position.x - anchor.x, shooter.position.z - anchor.z) < LOOKAHEAD + 20 ? shooter : null;
      this.target = useFocus ? focus! : (ahead ?? answer ?? w.nearestTarget(u, reach));
    }
    const t = this.target;
    u.face = null;
    const fromAnchor = Math.hypot(u.position.x - anchor.x, u.position.z - anchor.z);
    u.speedMul = 1;
    // Fight from where we are when we can reach; never run off far from the leader to do it.
    if (t?.targetable && u.inRange(t)) {
      if (!sidestep(u, t)) {
        faceTowards(u, t);
        u.move.set(0, 0);
      }
      u.attack(t);
      if (fromAnchor < 30) return;
    }
    // Fallen far behind the player's body: by the ground's own paths to it, round the cliffs and
    // chasms its trail crosses (a body redeployed at the base, an aircraft flown over a ridge),
    // straight at it in the open. Along its trail, a crumb at a time, they walked into the
    // first cliff on the way and stood there.
    const followsPlayer = !!leader && leader === w.player;
    if (followsPlayer && fromAnchor > 26) {
      this.crumb = -1;
      this.gaveUp = null;
      u.speedMul = CATCH_UP;
      w.chase(u, leader.position, dir);
      u.move.copy(dir);
      return;
    }
    // Keep up: along the leader's trail while far; otherwise into the fight ahead, or to our
    // slot out in front.
    const goal = new THREE.Vector3();
    if (fromAnchor > 26 && this.squad.trail.length) {
      if (this.crumb < 0 || this.crumb >= this.squad.trail.length) this.crumb = this.nearestCrumb();
      const c = this.squad.trail[this.crumb];
      if (Math.hypot(u.position.x - c.x, u.position.z - c.z) < 3 && this.crumb < this.squad.trail.length - 1) this.crumb++;
      goal.copy(this.squad.trail[this.crumb]);
    } else {
      this.crumb = -1;
      if (t?.targetable && Math.hypot(t.position.x - anchor.x, t.position.z - anchor.z) < (this.close ? 26 : LOOKAHEAD + 10)) goal.copy(t.position);
      else this.squad.slot(this.index % 12, goal, false, this.close);
    }
    // Pushing against something for a while: stop and hold, rather than run in place, until the
    // place we were trying to reach has moved on.
    if (u.blocked > 1) this.gaveUp = goal.clone();
    if (this.gaveUp && this.gaveUp.distanceTo(goal) < 4) {
      u.move.set(0, 0);
      if (t?.targetable) faceTowards(u, t);
      else if (leader) u.face = leader.yaw;
      return;
    }
    this.gaveUp = null;
    dir.set(goal.x - u.position.x, goal.z - u.position.z);
    const d = dir.length();
    // Short of our place while the squad moves (or fallen well behind): run. A shooter's squad
    // gets out ahead of a walking player, and never trails one for long.
    if (d > 5 && (this.squad.moving || fromAnchor > 14)) u.speedMul = CATCH_UP;
    if (d > 1.5) {
      dir.divideScalar(d);
      const ahead = u.radius + 2;
      if (!w.walkable(u.position.x + dir.x * ahead, u.position.z + dir.y * ahead)) {
        // A cliff or a chasm in the way: round it by the ground's paths to the player, or back
        // along the leader's trail.
        if (followsPlayer) w.chase(u, leader!.position, dir);
        else if (this.squad.trail.length) {
          this.crumb = this.nearestCrumb();
          const c = this.squad.trail[this.crumb];
          dir.set(c.x - u.position.x, c.z - u.position.z).normalize();
        }
      }
      u.move.copy(dir).multiplyScalar(d > 6 ? 1 : 0.6);
    } else {
      u.move.set(0, 0);
      if (t?.targetable) faceTowards(u, t);
      else if (leader) u.face = leader.yaw;
    }
  }

  private nearestCrumb(): number {
    const trail = this.squad.trail;
    let best = trail.length - 1;
    let bestD = Infinity;
    for (let i = 0; i < trail.length; i++) {
      const d = Math.hypot(trail[i].x - this.u.position.x, trail[i].z - this.u.position.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}

/**
 * Advancing on a point: walk the flow field toward it, fighting whatever comes into range on
 * the way, and hold there once arrived. Counter-attacks and Frontline pushes.
 */
export class AssaultBrain implements Controller {
  private target: Entity | null = null;
  private retarget = Math.random() * 0.4;

  constructor(
    private u: Unit,
    public field: import('./flowfield.ts').FlowField,
    public objective: THREE.Vector3,
  ) {}

  release() {
    this.u.world.engagePlayer(this.u, false);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.35 + Math.random() * 0.2;
      const allowed = (e: Entity) => e !== w.player || w.mayEngagePlayer(u);
      this.target = w.nearestTarget(u, (u.kind.weapon?.range ?? 20) + 10, allowed);
      // Fired on from further off: turn aside from the push and answer it.
      const shooter = alerted(u);
      if (!this.target && shooter && allowed(shooter) && canHit(u.kind.weapon, shooter) && u.gap(shooter) < (u.kind.weapon?.range ?? 20) + GUARD_PURSUIT) this.target = shooter;
      w.engagePlayer(u, !!this.target && this.target === w.player);
    }
    const t = this.target;
    u.face = null;
    if (t?.targetable) {
      if (u.inRange(t)) {
        if (!sidestep(u, t)) {
          u.move.set(0, 0);
          faceTowards(u, t);
        }
        u.attack(t);
        return;
      }
      if (u.kind.weapon?.melee || u.gap(t) < (u.kind.weapon?.range ?? 0) + 8 || t === alerted(u)) {
        dir.set(t.position.x - u.position.x, t.position.z - u.position.z).normalize();
        const ahead = u.radius + 3;
        if (w.walkable(u.position.x + dir.x * ahead, u.position.z + dir.y * ahead)) {
          u.move.copy(dir);
          return;
        }
      }
    }
    const dObj = Math.hypot(this.objective.x - u.position.x, this.objective.z - u.position.z);
    if (dObj < 8) {
      u.move.set(0, 0);
      return;
    }
    if (this.field.direction(u.position.x, u.position.z, dir) || this.field.escape(u.position.x, u.position.z, dir)) u.move.copy(dir);
    else u.move.set(this.objective.x - u.position.x, this.objective.z - u.position.z).normalize();
  }
}

/**
 * A Medic with the squad: keeps close behind, and heals the most wounded biological soldier
 * within reach at the data's rate, paying energy for every point of life (the campaign's
 * autocast "heal").
 */
export class MedicBrain implements Controller {
  private patient: Unit | null = null;
  private index: number;

  constructor(
    private u: Unit,
    private squad: Squad | null,
    private post: THREE.Vector3 | null = null,
  ) {
    squad?.members.add(u);
    this.index = squad ? squad.members.size - 1 : 0;
  }

  release() {
    this.squad?.members.delete(this.u);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    const heal = w.medicHeal;
    const reach = heal.range;
    u.face = null;
    // Pick the worst-hurt ally nearby.
    if (!this.patient?.targetable || this.patient.hp >= this.patient.maxHp) {
      this.patient = null;
      let worst = 0.98;
      for (const e of w.unitsNear(u.position.x, u.position.z, 30)) {
        if (e === u || e.team !== u.team || !e.targetable || !e.kind.attributes.includes('Biological')) continue;
        const f = e.hp / e.maxHp;
        if (f < worst) {
          worst = f;
          this.patient = e;
        }
      }
    }
    const p = this.patient;
    if (p && u.energy > 0) {
      const d = Math.hypot(p.position.x - u.position.x, p.position.z - u.position.z) - p.radius - u.radius;
      if (d <= reach) {
        u.move.set(0, 0);
        faceTowards(u, p);
        const amount = Math.min(heal.rate * dt, p.maxHp - p.hp, u.energy / heal.energyPerLife);
        p.hp += amount;
        u.energy -= amount * heal.energyPerLife;
        if (Math.random() < 0.5) {
          const from = w.muzzle(u, new THREE.Vector3());
          w.effects.tracer(from, p.center(new THREE.Vector3()), 0x9fffc0, 0.06, 0.06);
        }
        return;
      }
      dir.set(p.position.x - u.position.x, p.position.z - u.position.z).normalize();
      u.move.copy(dir);
      return;
    }
    // Otherwise stay with the squad, just behind the leader (or the post), running to catch up.
    const goal = new THREE.Vector3();
    const lead = this.squad?.leader();
    u.speedMul = lead && Math.hypot(lead.position.x - u.position.x, lead.position.z - u.position.z) > 14 ? CATCH_UP : 1;
    if (this.squad) this.squad.slot(this.index % 12, goal, true);
    else if (this.post) goal.copy(this.post);
    else goal.copy(u.position);
    dir.set(goal.x - u.position.x, goal.z - u.position.z);
    const d = dir.length();
    if (d > 2) u.move.copy(dir.divideScalar(d)).multiplyScalar(d > 8 ? 1 : 0.6);
    else u.move.set(0, 0);
  }
}
