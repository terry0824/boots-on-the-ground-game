import * as THREE from 'three';
import type { JoltStats } from '../stats.ts';
import { Unit, type Entity } from '../entity.ts';
import { layMineAt } from '../experimental/unleashed/mines.ts';
import type { Weapon } from '../kinds.ts';
import { tankMode } from '../tank.ts';
import type { UltimateId } from '../ultimate.ts';
import { HeroVisual } from '../visual.ts';
import { TEAM_COLOR, type World } from '../world.ts';
import { carpetBomb, lanceStorm, salvo, type SalvoSpec } from './salvo.ts';
import { holdOf } from './transport.ts';

/**
 * Each body's own ultimate (The Tide: Unleashed, on F), from the unit's own weapons, models and
 * sounds wherever the content has them. The Seer's warhead lives with the Seer (trooper.ts), the
 * Bulwark's and the Nightjar's salvos in salvo.ts; the Warship's Keel Gun with the ship.
 */

export interface CastContext {
  world: World;
  unit: Unit;
  /** Where the player faces now (a unit's yaw: 0 is +Z), for the whole of an ultimate that lasts. */
  heading: () => number;
  /** Where the crosshair meets the ground or what's on it. */
  aim: THREE.Vector3;
  /** The Jolt's numbers (Super Jolt's are over them). */
  jolt: JoltStats;
  /** Downed squadmates within `radius` of `at` get up: how many. */
  revive?: (at: THREE.Vector3, radius: number) => number;
}

/** Casts `id`: how many seconds it lasts (what it kills meanwhile charges nothing back), or why it can't. */
export function cast(id: UltimateId, c: CastContext): number | string {
  switch (id) {
    case 'superJolt':
      return superJolt(c);
    case 'stagger':
      return staggerBarrage(c);
    case 'napalm':
      return napalmWall(c);
    case 'triage':
      return triage(c);
    case 'clusterbomb':
      return clusterbomb(c);
    case 'creep':
      return creepingBarrage(c);
    case 'igniter':
      return wildfire(c);
    case 'scatter':
      return scatter(c);
    case 'volleylock':
      return volleyLock(c);
    case 'minefield':
      return minefield(c);
    case 'phantom':
      return phantomRun(c);
    case 'missileStorm':
      return missileStorm(c);
    case 'evacuation':
      return evacuation(c);
    case 'storm':
      return lanceStorm(c.world, c.unit, c.heading());
    case 'carpet':
      return carpetBomb(c.world, c.unit, c.heading());
    default:
      return 'Not this body’s';
  }
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();

/** Enemies of `u` round a point: on the ground only, or flyers only, or both. */
function enemies(w: World, u: Unit, at: THREE.Vector3, radius: number, plane: 'ground' | 'air' | 'both' = 'ground'): Entity[] {
  return [...w.unitsNear(at.x, at.z, radius)].filter(
    (e) => e.alive && e.targetable && !e.ignored && e.team !== u.team && (plane === 'both' || (plane === 'air') === e.flying),
  );
}

/** Runs `tick` every `every` seconds for `seconds` (and `done` at the end), on the world's clock. */
function every(w: World, period: number, seconds: number, tick: (t: number) => void, done?: () => void) {
  let t = 0;
  let next = 0;
  w.timed.push({
    done: false,
    update(dt: number) {
      t += dt;
      while (next <= t && next <= seconds) {
        tick(next);
        next += period;
      }
      if (t >= seconds) {
        this.done = true;
        done?.();
      }
    },
  });
}

const UPWARD = new THREE.Vector3(0, 1, 0);

/**
 * A fire effect model burning at `at` until it's stopped: its looping Stand, carried in place
 * with its front along `dir`. The Burner's flame shoots along its front (up, a flame standing
 * up); the Torchrunner's burst splashes back from its front, low (its front along the way the
 * Torchrunner is going, the fire licking back down its path).
 */
function burn(w: World, model: 'burnerFireSprite' | 'torchrunnerBeamImpact', at: THREE.Vector3, dir: THREE.Vector3, scale: number): ReturnType<World['fx']['carry']> {
  const t = w.models[model];
  return t ? w.fx.carry(t, at, dir, scale) : null;
}

/** Distance from a point to a segment on the ground plane. */
function toSegment(px: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.z) * dz) / l2));
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

const ground = (w: World, x: number, z: number) => new THREE.Vector3(x, w.terrain.heightAt(x, z), z);

/**
 * Trooper: Super Jolt. Every Trooper within 25 m (the player too) fires half again as fast as a
 * Jolt makes it, runs as fast as one, and takes half of every blow, for 12 s, at no cost in
 * life.
 */
function superJolt(c: CastContext): number | string {
  const { world: w, unit: u, jolt } = c;
  const until = w.time + 12;
  let n = 0;
  // The caster too (the player's own body isn't among the units round it).
  for (const e of new Set([u, ...w.unitsNear(u.position.x, u.position.z, 25)])) {
    if (!e.alive || e.team !== u.team || e.kind.name !== 'trooper') continue;
    e.boost = { until, attack: jolt.attackSpeed * 1.5, move: jolt.moveSpeed, taken: 0.5 };
    e.visual.flash(0.8);
    n++;
  }
  w.audio.play('jolt', { at: u.position, volume: 1 });
  w.audio.play('trooperAttack', { volume: 0.8, bus: 'voice' });
  return n ? 12 : 'No Troopers near you';
}

/** Grenadier: twelve Breaker grenades in a fan where it faces, each a Stagger Shell (slowed by half for 4 s). */
const STAGGER: SalvoSpec = {
  every: 0.09,
  amount: 50,
  bonus: { Armored: 50 },
  slow: [0.5, 4],
  splash: [
    [3.5, 1],
    [5, 0.5],
  ],
  missile: 'grenadierMissile',
  launch: 'grenadierLaunch',
  impact: 'humanSmallBlast',
  cue: 'grenade.npc',
  sound: 'grenadierImpact',
  speed: 45,
  arc: 0.35,
};
const BARRAGE = 12;
function staggerBarrage(c: CastContext): number {
  const { world: w, unit: u } = c;
  const heading = c.heading();
  const marks: THREE.Vector3[] = [];
  for (let i = 0; i < BARRAGE; i++) {
    const a = heading + THREE.MathUtils.degToRad(40) * (i / (BARRAGE - 1) - 0.5);
    const r = 14 + (i % 3) * 10 + Math.random() * 4;
    marks.push(ground(w, u.position.x + Math.sin(a) * r, u.position.z + Math.cos(a) * r));
  }
  return salvo(w, u, STAGGER, marks, (_, out) => w.muzzle(u, out));
}

/** Burner: a 26 m wall of fire across its path 16 m ahead, burning for 8 s (the Burner's own flame along it). */
function napalmWall(c: CastContext): number {
  const { world: w, unit: u } = c;
  const heading = c.heading();
  const mid = ground(w, u.position.x + Math.sin(heading) * 16, u.position.z + Math.cos(heading) * 16);
  const across = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
  const a = mid.clone().addScaledVector(across, -13);
  const b = mid.clone().addScaledVector(across, 13);
  // The Burner's own flame, burning in a row along it for as long as it lasts.
  const scale = w.effectScaleOf(u) * 2.4;
  const flames: (ReturnType<World['fx']['carry']>)[] = [];
  for (let i = 0; i <= 17; i++) {
    const p = a.clone().lerp(b, i / 17);
    p.y = w.terrain.heightAt(p.x, p.z);
    if (i % 2 === 0) w.effects.stain(p, 3.5, 0x140c08, 0.85, 40);
    flames.push(burn(w, 'burnerFireSprite', p, UPWARD, scale));
  }
  every(
    w,
    0.25,
    8,
    (t) => {
      if (Math.floor(t * 4) % 3 === 0) w.audio.play('burnerLaunch', { at: mid, volume: 0.7, limit: 3 });
      for (const e of enemies(w, u, mid, 16)) {
        if (toSegment(e.position.x, e.position.z, a, b) > 2.5 + e.radius) continue;
        e.takeDamage(12, u, e.position, true, 'Fire');
      }
    },
    () => flames.forEach((f) => f?.stop()),
  );
  return 8;
}

/** Medic: everyone of ours within 20 m healed to full over 3 s; the downed get up. */
function triage(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  const patients = [...new Set([u, ...w.unitsNear(u.position.x, u.position.z, 20)])].filter((e) => e.alive && e.team === u.team && e.kind.attributes.includes('Biological'));
  const raised = c.revive?.(u.position, 20) ?? 0;
  w.audio.play('healStart', { at: u.position, volume: 0.9 });
  every(w, 0.1, 3, () => {
    for (const p of patients) {
      if (!p.alive) continue;
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp / 3) * 0.1);
      w.effects.tracer(u.center(v1), p.center(v2), 0x9fffc0, 0.08, 0.12);
    }
  });
  return patients.some((p) => p.hp < p.maxHp) || raised ? 3 : 'No one near you is hurt';
}

/**
 * Vaulter: five charges thrown in a spread where it faces (the campaign's Clusterbomb:
 * magneticMine, thrown as magneticMineMissile). They land, and a second later
 * go off: 70 within 4 m, everything there thrown back.
 */
function clusterbomb(c: CastContext): number {
  const { world: w, unit: u } = c;
  const heading = c.heading();
  const from = u.center(new THREE.Vector3());
  const scale = w.effectScaleOf(u);
  w.audio.play('d8Voice', { volume: 0.9, bus: 'voice' });
  w.playEffect('humanSmallBlast', from, from.clone().add(u.forward(v1)), scale);
  for (let i = 0; i < 5; i++) {
    const a = heading + THREE.MathUtils.degToRad(36) * (i / 4 - 0.5);
    const r = 9 + Math.random() * 10;
    const to = ground(w, u.position.x + Math.sin(a) * r, u.position.z + Math.cos(a) * r);
    throwCharge(w, u, from, to, 0.5 + i * 0.06, scale);
  }
  return 3;
}

function throwCharge(w: World, u: Unit, from: THREE.Vector3, to: THREE.Vector3, flight: number, scale: number) {
  const missile = w.models.magneticMineMissile;
  const body = missile ? w.missileBodies.take(missile, new THREE.Color(1, 1, 1), scale) : null;
  const pos = from.clone();
  const last = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let t = 0;
  let charge: HeroVisual | null = null;
  let fuse = 1;
  w.timed.push({
    done: false,
    update(dt: number) {
      if (t < flight) {
        t = Math.min(flight, t + dt);
        const k = t / flight;
        last.copy(pos);
        pos.lerpVectors(from, to, k);
        pos.y += 5 * 4 * k * (1 - k);
        if (dt > 0) velocity.subVectors(pos, last).divideScalar(dt);
        if (body) w.missileBodies.place(body, pos, velocity, dt);
        if (t < flight) return;
        // Down: the charge on the ground, its arming flash.
        if (body) w.missileBodies.give(body);
        w.playEffect('vaulterJumpLandDown', to, null, scale);
        const mine = w.models.magneticMine;
        if (mine) {
          charge = new HeroVisual(mine.instantiate(new THREE.Color(0.3, 0.5, 1)), w.scene);
          charge.play('Stand');
          charge.sync(to, Math.random() * Math.PI * 2, scale);
        }
        return;
      }
      fuse -= dt;
      charge?.update(dt);
      if (fuse > 0) return;
      this.done = true;
      charge?.dispose();
      // It goes off: the blast, and what's there thrown back from it.
      w.playEffect('humanSmallBlast', to, null, scale * 1.6);
      w.audio.play('d8Explode', { at: to, volume: 1.2, near: 20, limit: 5, delay: true });
      w.effects.stain(to, 4, 0x1a140f, 0.8, 40);
      w.effects.light(new THREE.Vector3(to.x, to.y + 2, to.z), 0xffb060, 60, 0.15);
      for (const e of enemies(w, u, to, 4 + 2)) {
        const d = Math.hypot(e.position.x - to.x, e.position.z - to.z);
        if (d > 4 + e.radius) continue;
        e.takeDamage(70, u, to);
        if (e instanceof Unit && e.alive && e.radius < 2.5) shove(w, e, to, 5);
      }
    },
  });
}

/** Throws `e` back from `from` by `meters` over a quarter second (as far as there's ground). */
function shove(w: World, e: Unit, from: THREE.Vector3, meters: number) {
  const dir = new THREE.Vector3(e.position.x - from.x, 0, e.position.z - from.z);
  if (dir.lengthSq() < 1e-4) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
  dir.normalize();
  let left = meters;
  w.timed.push({
    done: false,
    update(dt: number) {
      const step = Math.min(left, meters * 4 * dt);
      left -= step;
      const x = e.position.x + dir.x * step;
      const z = e.position.z + dir.z * step;
      if (e.alive && w.walkable(x, z)) {
        e.position.x = x;
        e.position.z = z;
        e.position.y = w.terrain.heightAt(x, z);
      }
      if (left <= 1e-3 || !e.alive) this.done = true;
    },
  });
}

/** Howitzer, braced: eight shells walking out from the mark, a braced shell each. */
function creepingBarrage(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  if (tankMode(u) !== 'braced') return 'Siege up first · [E]';
  const weapon = u.kind.weapon!;
  const out = new THREE.Vector3(c.aim.x - u.position.x, 0, c.aim.z - u.position.z);
  if (out.lengthSq() < 1) out.set(Math.sin(c.heading()), 0, Math.cos(c.heading()));
  out.normalize();
  const fx = u.kind.def.effects;
  const scale = w.effectScaleOf(u);
  every(w, 0.3, 2.1, (t) => {
    const i = Math.round(t / 0.3);
    const at = ground(w, c.aim.x + out.x * i * 7, c.aim.z + out.z * i * 7);
    const muzzle = w.muzzle(u, new THREE.Vector3());
    w.playEffect(fx?.launch, muzzle, at, w.scaleOf(u.kind.def.model));
    w.sfx.play('tank.brace', { at: muzzle });
    // The shell lands half a second on.
    let flight = 0.5;
    w.timed.push({
      done: false,
      update(dt: number) {
        flight -= dt;
        if (flight > 0) return;
        this.done = true;
        w.playEffect(fx?.impact, at, muzzle, scale);
        w.explode(at, weapon, u, false, u.kind.def.sounds?.impact, { drawn: true });
        w.effects.shake = Math.max(w.effects.shake, 0.3);
      },
    });
  });
  return 3;
}

/**
 * Torchrunner: for 6 s its path burns behind it, as wide as it and more, each patch for 4 s: its own
 * flame (torchrunnerBeamImpact, its flamethrower's burst on what it hits), licking back down the
 * path. (A blue flame, tried for it, read as something else than fire.)
 */
function wildfire(c: CastContext): number {
  const { world: w, unit: u } = c;
  const patches: { at: THREE.Vector3; until: number; flame: ReturnType<World['fx']['carry']> }[] = [];
  const scale = w.effectScaleOf(u);
  // As wide as the Torchrunner and a little more: what it shoulders aside still burns.
  const wide = u.radius + 2;
  every(w, 0.15, 6, () => {
    if (!u.alive) return;
    const at = ground(w, u.position.x, u.position.z);
    const last = patches[patches.length - 1];
    if (!last || last.at.distanceTo(at) > 2.5) {
      const going = new THREE.Vector3(Math.sin(u.yaw), 0, Math.cos(u.yaw));
      patches.push({ at, until: w.time + 4, flame: burn(w, 'torchrunnerBeamImpact', at, going, scale * 3) });
      w.effects.stain(at, 3, 0x140c08, 0.8, 30);
    }
  });
  every(w, 0.25, 10, () => {
    for (const p of patches) {
      if (p.until < w.time) {
        p.flame?.stop();
        p.flame = null;
        continue;
      }
      for (const e of enemies(w, u, p.at, wide + 1)) {
        if (Math.hypot(e.position.x - p.at.x, e.position.z - p.at.z) > wide + e.radius) continue;
        e.takeDamage(8, u, p.at, true, 'Fire');
      }
    }
  }, () => patches.forEach((p) => p.flame?.stop()));
  w.audio.play('torchrunnerAttack', { at: u.position, volume: 1 });
  return 10;
}

/** Fires `weapon` at each target in turn, `every` seconds apart, from `u`'s weapon attachment. */
function volley(w: World, u: Unit, targets: Entity[], weapon: Weapon, gap: number) {
  every(w, gap, gap * targets.length, (t) => {
    const target = targets[Math.min(targets.length - 1, Math.round(t / gap))];
    if (u.alive && target?.alive && target.targetable) w.fireMissile(u, target, weapon);
  });
}

/** The flyers within `reach`, nearest first. */
function flyers(w: World, u: Unit, reach: number): Entity[] {
  return enemies(w, u, u.position, reach, 'air').sort((a, b) => a.position.distanceToSquared(u.position) - b.position.distanceToSquared(u.position));
}

/** Jackknife, in the air: a Dart torpedo at every flyer within 75 m, each bursting 3 m round it (the campaign's Scatter Missiles). */
function scatter(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  if (!u.flying) return 'In the air only · [E] take off';
  const targets = flyers(w, u, 75).slice(0, 16);
  if (!targets.length) return 'No flyers in reach';
  const base = u.kind.weapon!;
  volley(w, u, targets, { ...base, splash: [{ radius: 3, fraction: 1, arc: 360 }] }, 0.06);
  w.sfx.play('jackknife.dart', { at: u.position });
  return 2;
}

/** Picket: Seeker missiles at up to eight flyers at once, two apiece (the campaign's Volley Lock Weapons System). */
function volleyLock(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  const targets = flyers(w, u, 70).slice(0, 8);
  if (!targets.length) return 'No flyers in reach';
  volley(w, u, [...targets, ...targets], u.kind.antiAir ?? u.kind.weapon!, 0.07);
  return 2;
}

/** Coyote: six Scuttle Mines in a ring round it, at once (the campaign's upgraded mines). */
function minefield(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  let laid = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + u.yaw;
    const at = ground(w, u.position.x + Math.sin(a) * 7, u.position.z + Math.cos(a) * 7);
    if (!w.walkable(at.x, at.z)) continue;
    layMineAt(w, u, at);
    laid++;
  }
  return laid ? 1 : 'No ground round you to mine';
}


/** Swift: shrouded (nothing can lock on to it) and its lasers twice as fast, for 8 s. */
function phantomRun(c: CastContext): number {
  const { world: w, unit: u } = c;
  u.shrouded = true;
  u.boost = { until: w.time + 8, attack: 2, move: 1, taken: 1 };
  shimmer(u, true);
  w.audio.play('shroudOn', { at: u.position, volume: 0.9 });
  every(w, 8, 8, () => {}, () => {
    u.shrouded = false;
    shimmer(u, false);
    w.audio.play('shroudOff', { at: u.position, volume: 0.9 });
  });
  return 8;
}

/** A shrouded body shimmers: nearly transparent (as the Seer's shroud, trooper.ts). */
function shimmer(u: Unit, on: boolean) {
  const visual = u.visual;
  if (!(visual instanceof HeroVisual)) return;
  visual.instance.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const saved = m.userData.shroudSaved as { t: boolean; o: number; d: boolean } | undefined;
      if (on) {
        if (!saved) m.userData.shroudSaved = { t: m.transparent, o: m.opacity, d: m.depthWrite };
        m.transparent = true;
        m.opacity = 0.2;
        m.depthWrite = false;
      } else if (saved) {
        m.transparent = saved.t;
        m.opacity = saved.o;
        m.depthWrite = saved.d;
        m.userData.shroudSaved = undefined;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * Frigate: Missile Storm. Forty rockets in a second and a half, fanned out across the sky ahead
 * (a hundred degrees wide, low to high), each flying out on its own bearing before it turns onto a
 * flyer in front of the Frigate (taking turns among them) and bursts round it with the weapon's
 * splash: a wall of air defense, not a stream. The Frigate's own rocket (its weapon's
 * grenadierMissile), launch and impact.
 */
const STORM = { rockets: 40, every: 0.035, fan: THREE.MathUtils.degToRad(100), out: 26, speed: 95, reach: 110, ahead: THREE.MathUtils.degToRad(75), damage: 40, light: 20 };
function missileStorm(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  const heading = c.heading();
  const front = (e: Entity) => Math.abs(Math.atan2(Math.sin(Math.atan2(e.position.x - u.position.x, e.position.z - u.position.z) - heading), Math.cos(Math.atan2(e.position.x - u.position.x, e.position.z - u.position.z) - heading))) < STORM.ahead;
  const targets = flyers(w, u, STORM.reach).filter(front).slice(0, 12);
  if (!targets.length) return 'No flyers ahead';
  // Heavier than a volley's rockets: the storm is the Frigate's whole load at once.
  const base = u.kind.weapon!;
  const weapon: Weapon = { ...base, damage: { ...base.damage, amount: STORM.damage, bonus: { Light: STORM.light } } };
  every(w, STORM.every, STORM.every * (STORM.rockets - 1), (t) => {
    if (!u.alive) return;
    const i = Math.round(t / STORM.every);
    // Spread evenly over the fan and from low to high, in an order that keeps it filling in everywhere.
    const across = ((i * 0.618034) % 1) - 0.5;
    const rise = THREE.MathUtils.degToRad(-6 + ((i * 0.381966 + 0.2) % 1) * 34);
    const yaw = heading + across * STORM.fan;
    const out = new THREE.Vector3(Math.sin(yaw) * Math.cos(rise), Math.sin(rise), Math.cos(yaw) * Math.cos(rise));
    rocket(w, u, weapon, w.muzzle(u, new THREE.Vector3()), out, targets[i % targets.length]);
  });
  w.sfx.play('frigate.missiles', { at: u.position });
  return 2;
}

/** One of the storm's rockets: out along `out`, then onto `target`, bursting where it meets it (or where it was, if it's gone). */
function rocket(w: World, u: Unit, weapon: Weapon, from: THREE.Vector3, out: THREE.Vector3, target: Entity) {
  const scale = w.effectScaleOf(u);
  const look = w.effectsOf(u, weapon);
  const template = look?.missile ? w.models[look.missile] : undefined;
  const p1 = from.clone().addScaledVector(out, STORM.out);
  const end = target.center(new THREE.Vector3());
  const duration = (STORM.out + p1.distanceTo(end)) / STORM.speed;
  const velocity = out.clone().multiplyScalar(STORM.speed);
  const trail = template?.data.emitters.length ? w.fx.carry(template, from, velocity, scale) : null;
  const body = template ? w.missileBodies.take(template, TEAM_COLOR[u.team], scale) : null;
  if (look?.launch) w.playEffect(look.launch, from, p1, scale);
  const pos = from.clone();
  const last = new THREE.Vector3();
  let t = 0;
  w.timed.push({
    done: false,
    update(dt: number) {
      t = Math.min(duration, t + dt);
      if (target.alive && target.targetable) target.center(end);
      const k = t / duration;
      const a = 1 - k;
      last.copy(pos);
      pos.copy(from).multiplyScalar(a * a).addScaledVector(p1, 2 * a * k).addScaledVector(end, k * k);
      if (dt > 0) velocity.subVectors(pos, last).divideScalar(dt);
      trail?.moveTo(pos, velocity);
      if (body) w.missileBodies.place(body, pos, velocity, dt);
      if (t < duration) return;
      this.done = true;
      trail?.stop();
      if (body) w.missileBodies.give(body);
      w.splash(pos, weapon, weapon.damage, u);
      if (look?.impact) w.playEffect(look.impact, pos, from, scale);
      const sound = u.kind.def.sounds?.impact;
      if (sound) w.audio.play(sound, { at: pos, volume: 0.7, near: 20, limit: 6, delay: true });
    },
  });
}

/** Dustoff: every wounded soldier within 25 m aboard at once (as many as fit), healed aboard for 10 s. */
function evacuation(c: CastContext): number | string {
  const { world: w, unit: u } = c;
  const hold = holdOf(u);
  if (!hold) return 'Nothing to carry them in';
  const below = ground(w, u.position.x, u.position.z);
  const wounded = hold.around(below, 25, (s) => s.hp < s.maxHp * 0.97).filter((s) => s.kind.attributes.includes('Biological'));
  let n = 0;
  for (const s of wounded) if (hold.load(s)) n++;
  if (!n) return 'No wounded in reach';
  w.audio.play('dustoffUnload', { at: u.position, volume: 0.8 });
  every(w, 0.25, 10, () => {
    for (const s of hold.cargo) s.hp = Math.min(s.maxHp, s.hp + s.maxHp * 0.25 * 0.25);
  });
  return 10;
}

