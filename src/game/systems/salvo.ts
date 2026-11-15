import * as THREE from 'three';
import type { DeathType } from '../stats.ts';
import { Unit } from '../entity.ts';
import type { Weapon } from '../kinds.ts';
import type { ModelName, SoundName } from '../../content/assetnames.ts';
import type { CueName } from '../sfx.ts';
import { TEAM_COLOR, type World } from '../world.ts';

/**
 * The machines' own ultimates (The Tide: Unleashed, on F), fired with their own weapons' models
 * and sounds:
 * - A Bulwark's (a Behemoth's) Lance storm: its shoulder pods empty in a stream over a 45° fan in
 *   front of it, from 20 to 50 m beyond its feet, the strikes sweeping across the fan from one
 *   side to the other. The Lances' own missile, launch and impact.
 * - A Nightjar's carpet bombing: its Strafe Rockets in a stream down a strip along its heading,
 *   each blast the campaign's own carpet bomb (the rockets' impact model and sound, which it
 *   lays four in a row).
 */

export interface SalvoSpec {
  /** Real seconds between launches. */
  every: number;
  amount: number;
  /** Damage on top against an attribute (Armored), as a weapon's. */
  bonus?: Record<string, number>;
  /** What it does to whatever it hits, beside the damage: slowed to `[share, seconds]` (Stagger Rounds). */
  slow?: [number, number];
  /** How a kill by it dies (Fire burns). */
  death?: DeathType;
  /** [meters, fraction] rings. */
  splash: [number, number][];
  missile: ModelName;
  launch?: ModelName;
  impact: ModelName;
  cue: CueName;
  sound: SoundName;
  /** Meters a second. */
  speed: number;
  /** How high the arc rises, as a share of the distance. */
  arc: number;
}

const STORM = { fan: THREE.MathUtils.degToRad(45), near: 20, far: 50 };
const BULWARK_STORM: SalvoSpec = {
  every: 0.075,
  amount: 70,
  splash: [
    [3, 1],
    [5, 0.5],
  ],
  missile: 'bulwarkMissile',
  launch: 'bulwarkShoulderMissileLaunch',
  impact: 'bulwarkChestMissileImpact',
  cue: 'bulwark.lance',
  sound: 'humanExplosionSmall',
  speed: 55,
  arc: 0.35,
};
/** The Behemoth's pods: more of them, and heavier. */
const BEHEMOTH_STORM: SalvoSpec = {
  ...BULWARK_STORM,
  every: 0.06,
  amount: 110,
  splash: [
    [4, 1],
    [7, 0.5],
  ],
  impact: 'behemothShoulderMissileImpact',
  cue: 'behemoth.missiles',
};
const STORM_SHOTS = { bulwark: 24, behemoth: 36 };

const CARPET = { shots: 22, start: 10, spacing: 3.2, wander: 1.5 };
const NIGHTJAR_CARPET: SalvoSpec = {
  every: 0.07,
  amount: 70,
  splash: [
    [3, 1],
    [5, 0.5],
  ],
  missile: 'nightjarMissile',
  impact: 'nightjarMissileImpact',
  cue: 'nightjar.rockets',
  sound: 'nightjarImpact',
  speed: 75,
  arc: 0.04,
};

const UP = new THREE.Vector3(0, 1, 0);

/** A Bulwark's or a Behemoth's Lance storm, at `heading` (radians, as a unit's yaw). Seconds it lasts. */
export function lanceStorm(w: World, u: Unit, heading: number): number {
  const behemoth = u.kind.name === 'behemoth';
  const spec = behemoth ? BEHEMOTH_STORM : BULWARK_STORM;
  const n = behemoth ? STORM_SHOTS.behemoth : STORM_SHOTS.bulwark;
  const near = u.radius + STORM.near;
  const far = u.radius + STORM.far;
  const marks: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    // Across the fan from one side to the other, and over its depth in a scatter that leaves no gaps.
    const k = n > 1 ? i / (n - 1) : 0.5;
    const a = heading + STORM.fan * (k - 0.5) + (Math.random() - 0.5) * 0.04;
    const r = near + (far - near) * ((i * 0.618034 + 0.31) % 1) + (Math.random() - 0.5) * 3;
    const x = u.position.x + Math.sin(a) * r;
    const z = u.position.z + Math.cos(a) * r;
    marks.push(new THREE.Vector3(x, w.terrain.heightAt(x, z), z));
  }
  // From the shoulder pods, one side and then the other.
  const from = (i: number, out: THREE.Vector3) => {
    const side = i % 2 ? 1 : -1;
    const s = Math.sin(u.yaw);
    const c = Math.cos(u.yaw);
    return u.center(out).addScaledVector(UP, u.height * 0.3).add(new THREE.Vector3(c * side * u.radius * 0.45, 0, -s * side * u.radius * 0.45));
  };
  return salvo(w, u, spec, marks, from);
}

/** A Nightjar's carpet bombing, down a strip along `heading` from just ahead of it. Seconds it lasts. */
export function carpetBomb(w: World, u: Unit, heading: number): number {
  const marks: THREE.Vector3[] = [];
  const dx = Math.sin(heading);
  const dz = Math.cos(heading);
  for (let i = 0; i < CARPET.shots; i++) {
    const along = CARPET.start + i * CARPET.spacing;
    const across = (Math.random() - 0.5) * 2 * CARPET.wander;
    const x = u.position.x + dx * along + dz * across;
    const z = u.position.z + dz * along - dx * across;
    marks.push(new THREE.Vector3(x, w.terrain.heightAt(x, z), z));
  }
  // From under its wings, wherever it has flown to by then.
  const from = (i: number, out: THREE.Vector3) => {
    const side = i % 2 ? 1 : -1;
    return out.copy(u.position).add(new THREE.Vector3(Math.cos(u.yaw) * side * u.radius * 0.3, -u.height * 0.2, -Math.sin(u.yaw) * side * u.radius * 0.3));
  };
  return salvo(w, u, NIGHTJAR_CARPET, marks, from);
}

/**
 * Fires a missile at each mark in turn, `spec.every` apart, from wherever `from` says the
 * launcher is at that moment: each in an arc, drawn with its missile's own body and trail, and
 * bursting with its own impact model and sound, its splash taking what's there.
 */
export function salvo(w: World, u: Unit, spec: SalvoSpec, marks: THREE.Vector3[], from: (i: number, out: THREE.Vector3) => THREE.Vector3): number {
  const base = u.kind.antiAir ?? u.kind.weapon!;
  const weapon: Weapon = {
    ...base,
    id: `${base.id}Salvo`,
    melee: false,
    missile: true,
    air: false,
    ground: true,
    structures: true,
    // One missile, one hit: not the launcher's attack over again (a Bulwark's Lances strike four
    // times an attack; a storm's each once).
    damage: { ...base.damage, amount: spec.amount, bonus: spec.bonus ?? {}, splash: [], death: spec.death ?? base.damage.death, hits: 1 },
    splash: spec.splash.map(([radius, fraction]) => ({ radius, fraction, arc: 360 })),
  };
  // Drawn at the launcher's own missile size (a Bulwark's Lances, three times).
  const sized = w.missileScale(u, base);
  let t = 0;
  let next = 0;
  w.timed.push({
    done: false,
    update(dt: number) {
      t += dt;
      while (next < marks.length && t >= next * spec.every) {
        if (!u.alive) {
          this.done = true;
          return;
        }
        launch(w, u, spec, weapon, from(next, new THREE.Vector3()), marks[next], sized);
        next++;
      }
      if (next >= marks.length) this.done = true;
    },
  });
  const longest = Math.max(...marks.map((m) => m.distanceTo(u.position))) / spec.speed;
  return marks.length * spec.every + longest + 1;
}

function launch(w: World, u: Unit, spec: SalvoSpec, weapon: Weapon, start: THREE.Vector3, to: THREE.Vector3, sized: { body: number; trail: number }) {
  const scale = w.effectScaleOf(u);
  const d = start.distanceTo(to);
  const duration = Math.max(0.25, d / spec.speed);
  const rise = d * spec.arc;
  const p1 = start.clone().addScaledVector(UP, rise).lerp(to, 0.25);
  const p2 = to.clone().addScaledVector(UP, rise * 0.7);
  const template = w.models[spec.missile];
  const velocity = new THREE.Vector3().subVectors(p1, start).normalize().multiplyScalar(spec.speed);
  const trail = template?.data.emitters.length ? w.fx.carry(template, start, velocity, sized.trail) : null;
  const body = template ? w.missileBodies.take(template, TEAM_COLOR[u.team], sized.body) : null;
  if (spec.launch) w.playEffect(spec.launch, start, p1, scale);
  w.sfx.play(spec.cue, { at: start });
  const pos = start.clone();
  const last = new THREE.Vector3();
  let t = 0;
  w.timed.push({
    done: false,
    update(dt: number) {
      if (this.done) return;
      t = Math.min(duration, t + dt);
      // Quickening down the arc, as a missile under power does.
      const k = Math.pow(t / duration, 1.2);
      const a = 1 - k;
      last.copy(pos);
      pos
        .copy(start)
        .multiplyScalar(a * a * a)
        .addScaledVector(p1, 3 * a * a * k)
        .addScaledVector(p2, 3 * a * k * k)
        .addScaledVector(to, k * k * k);
      if (dt > 0) velocity.subVectors(pos, last).divideScalar(dt);
      trail?.moveTo(pos, velocity);
      if (body) w.missileBodies.place(body, pos, velocity, dt);
      if (t < duration) return;
      this.done = true;
      trail?.stop();
      if (body) w.missileBodies.give(body);
      // The blast: its own impact model and sound, a scorch, a moment's light, and its splash.
      const outer = spec.splash.reduce((m, [r]) => Math.max(m, r), 1);
      const { hit } = w.splash(to, weapon, weapon.damage, u);
      if (spec.slow) for (const e of hit) if (e instanceof Unit && e.alive) e.slow(spec.slow[0], spec.slow[1]);
      w.playEffect(spec.impact, to, start, scale);
      w.audio.play(spec.sound, { at: to, volume: 1, near: 25, limit: 8, delay: true, reverb: 0.4 });
      w.effects.stain(to, outer * 0.9, 0x1a140f, 0.7, 40);
      w.effects.light(new THREE.Vector3(to.x, to.y + 2, to.z), 0xffb060, 20 * outer, 0.15);
    },
  });
}
