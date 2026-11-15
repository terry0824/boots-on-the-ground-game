import * as THREE from 'three';
import type { HeroVisual } from '../visual.ts';
import { FASTER, type Stats } from '../stats.ts';
import type { Building, Controller, Unit } from '../entity.ts';
import { dataOf, type KindName, type Team } from '../kinds.ts';
import type { World } from '../world.ts';
import { walkTo, type Treasury } from './economy.ts';
import type { Producer } from './production.ts';

/**
 * Construction, for any mode that lets the commander build: a catalog of structures (priced from
 * the data's costs and build times), the mode's rules for what may go up and where,
 * and the sites themselves. A worker walks out from the base to each site and the structure rises
 * only while it's at work, as human construction does, through the model's own build stages; a
 * worker lost on the job is replaced, a structure destroyed while going up is lost. When one is
 * finished the mode is told, and gives it its part: guns for a bunker or flak tower, bays for a
 * production building, supply for a storehouse.
 *
 * Placement is checked against the ground (walkable, level enough), what's already there (a gap
 * around every building and site), the tech the structure needs (the building it requires),
 * the mode's own zones and limits, and, when it matters, the enemy's way in: a wall that would
 * leave the swarm no path is refused.
 */

export type StructureRole = 'defense' | 'production' | 'supply' | 'tech';

export interface StructureDef {
  kind: KindName;
  label: string;
  /** The letter that starts placing it on the board's Construction (4): the classic RTS build hotkey. */
  hotkey: string;
  role: StructureRole;
  /** A finished building that must be standing first: its tech requirement. */
  requires?: KindName;
  /** A production building: which queue its bays join, and how many. */
  produces?: { producer: Producer; bays: number };
}

/** The human structures a worker can put up, with their tech requirements. */
export const HOLDOUTS_STRUCTURES: StructureDef[] = [
  { kind: 'bunker', label: 'Bunker', hotkey: 'U', role: 'defense', requires: 'barracks' },
  { kind: 'flakTower', label: 'Flak Tower', hotkey: 'T', role: 'defense', requires: 'workshop' },
  { kind: 'storehouse', label: 'Storehouse', hotkey: 'S', role: 'supply' },
  { kind: 'workshop', label: 'Workshop', hotkey: 'E', role: 'tech' },
  { kind: 'barracks', label: 'Barracks', hotkey: 'B', role: 'production', requires: 'storehouse', produces: { producer: 'barracks', bays: 1 } },
  { kind: 'motorPool', label: 'Motor Pool', hotkey: 'F', role: 'production', requires: 'barracks', produces: { producer: 'motorPool', bays: 1 } },
  { kind: 'airfield', label: 'Airfield', hotkey: 'P', role: 'production', requires: 'motorPool', produces: { producer: 'airfield', bays: 1 } },
];

export interface BuildRules {
  /** What may be built, from the catalog; anything else is known but not offered. */
  allow: KindName[];
  /** At most this many of a kind built by the commander, standing or going up (the map's own don't count). */
  limit: Partial<Record<KindName, number>>;
  /** Sites going up at once (workers out). */
  sites: number;
  /** Clear ground kept between a new structure and anything already standing, meters. */
  gap: number;
  /** Never cut the enemy off from the goal (the swarm would have no way in but through the wall). */
  keepPaths: boolean;
  /** Share of the cost given back when a site is called off before it's finished. */
  refund: number;
}

export const DEFAULT_BUILD: BuildRules = { allow: [], limit: {}, sites: 3, gap: 2, keepPaths: true, refund: 0.75 };

/** How a mode wires construction into itself. */
export interface ConstructionHooks {
  /** Where workers come out of and go back into (the Holdfast). */
  home: () => Building | null;
  /** The mode's own say on where a structure may go: why not, or null. */
  zone?: (at: THREE.Vector3, def: StructureDef) => string | null;
  /** Where the enemy comes from: with `keepPaths`, each must still have a way to the goal. */
  approaches?: () => THREE.Vector3[];
  /** A structure broke ground (its foundation is down, and blocks). */
  started?: (b: Building, def: StructureDef) => void;
  /** A structure was finished. */
  built?: (b: Building, def: StructureDef) => void;
  /** A structure was destroyed while it went up. */
  lost?: (def: StructureDef) => void;
}

/** A structure the board can offer: what it is, what it costs, and why it can't be ordered now (or null). */
export interface StructureOffer {
  def: StructureDef;
  ore: number;
  gas: number;
  /** Real seconds to build, with a worker at it. */
  seconds: number;
  blocked: string | null;
}

/** A structure going up. */
export interface Site {
  def: StructureDef;
  at: THREE.Vector3;
  yaw: number;
  radius: number;
  seconds: number;
  cost: { ore: number; gas: number };
  /** 0..1, while a worker is at it. */
  progress: number;
  building: Building | null;
  builder: Unit | null;
  brain: BuilderBrain | null;
  stage: number;
  /** Seconds to the weld's next shower of sparks. */
  sparkIn: number;
  done: boolean;
}

/**
 * How a structure rises, on the model's own construction clips. They're made to be played in
 * seven stages over the build, the first two holding the whole structure underground, so for
 * over half the build there would be nothing to see; here the rise in Build C Start (it comes up
 * out of the ground) is spread over most of the build, by its progress (a stalled build stalls
 * with it), and Build D Start deploys the rest at the end.
 * Each: the clip, the share of it played, and the progress it's done by.
 */
const STAGES: { clip: string; until: number; rise?: boolean }[] = [
  { clip: 'Build C Start', until: 0.8, rise: true },
  { clip: 'Build D Start', until: 1 },
];
/** Where in Build C Start each model comes up out of the ground (its clip's shares), measured once (`riseOf`). */
const RISES = new WeakMap<object, [number, number]>();

/**
 * The part of a structure's Build C Start in which it comes up out of the ground, as shares of
 * the clip: from when a little of it shows to when it's all but up. Measured on the model's own
 * skinned vertices, since each model rises at its own moment in that clip.
 */
function riseOf(b: Building, clip: string): [number, number] {
  const v = b.visual as HeroVisual;
  const known = RISES.get(v.template);
  if (known) return known;
  const mesh = v.instance?.mesh;
  const length = v.template.clips.get(clip)?.duration ?? 0;
  let window: [number, number] = [0, 1];
  if (mesh && length > 0) {
    const p = new THREE.Vector3();
    const shown: number[] = [];
    const STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      v.resume(clip, (length * i) / STEPS, false);
      v.update(0);
      b.syncTransform();
      v.instance.object.updateMatrixWorld(true);
      mesh.skeleton.update();
      const pos = mesh.geometry.attributes.position;
      let above = 0;
      let n = 0;
      for (let k = 0; k < pos.count; k += 6, n++) {
        mesh.getVertexPosition(k, p).applyMatrix4(mesh.matrixWorld);
        if (p.y > b.position.y + 0.2) above++;
      }
      shown.push(n ? above / n : 0);
    }
    const top = Math.max(...shown);
    const first = shown.findIndex((x) => x > top * 0.04);
    const last = shown.findIndex((x) => x >= top * 0.95);
    if (top > 0.2 && first >= 0 && last > first) window = [Math.max(0, first - 1) / STEPS, last / STEPS];
  }
  RISES.set(v.template, window);
  return window;
}
/** Sparks off the weld while a worker is at it: seconds between bursts. */
const SPARKS = 0.35;
/** A structure breaks ground at this share of its life. */
const FOUNDATION = 0.1;

export class Construction {
  readonly sites: Site[] = [];
  /** What the commander's orders put up (from the moment ground is broken), for the limits. */
  private built = new Set<Building>();

  constructor(
    private world: World,
    private data: Stats,
    readonly team: Team,
    readonly rules: BuildRules,
    private hooks: ConstructionHooks,
    readonly catalog: StructureDef[] = HOLDOUTS_STRUCTURES,
    /** Who builds. */
    private worker: KindName = 'rigger',
  ) {}

  /** A structure's price and time, from the data. */
  price(def: StructureDef): { ore: number; gas: number; seconds: number } {
    const kind = this.world.kinds[def.kind];
    const src = dataOf(this.data, kind.def) ?? this.data;
    const c = src.cost(kind.def.dataId);
    const t = this.data.buildTime(kind.def.dataId) ?? src.buildTime(kind.def.dataId) ?? 30;
    return { ore: c.ore, gas: c.gas, seconds: t / FASTER };
  }

  /** The structures the rules allow, priced, each with why it can't be ordered right now (or null). */
  offers(t: Treasury): StructureOffer[] {
    return this.catalog
      .filter((d) => this.rules.allow.includes(d.kind))
      .map((def) => {
        const p = this.price(def);
        return { def, ...p, blocked: this.standing(def) ?? t.short(p) };
      });
  }

  private def(kind: KindName): StructureDef | undefined {
    return this.catalog.find((d) => d.kind === kind);
  }

  private label(kind: KindName): string {
    return this.def(kind)?.label ?? kind;
  }

  /** "a Barracks", "a Workshop". */
  private a(kind: KindName): string {
    const l = this.label(kind);
    return `${/^[AEIOU]/.test(l) ? 'an' : 'a'} ${l}`;
  }

  /** A finished building of `kind` of ours is standing. */
  private has(kind: KindName): boolean {
    return this.world.buildings.some((b) => b.alive && b.team === this.team && b.kind.name === kind && !this.sites.some((s) => s.building === b && !s.done));
  }

  /** Why `def` can't be ordered anywhere right now (the rules, its tech, the limit, the workers), or null. */
  private standing(def: StructureDef): string | null {
    if (!this.rules.allow.includes(def.kind)) return 'Not in this operation';
    if (def.requires && !this.has(def.requires)) return `Needs ${this.a(def.requires)}`;
    const limit = this.rules.limit[def.kind];
    if (limit !== undefined) {
      for (const b of this.built) if (!b.alive) this.built.delete(b);
      let count = this.sites.filter((s) => !s.done && !s.building && s.def === def).length;
      for (const b of this.built) if (b.kind.name === def.kind) count++;
      if (count >= limit) return `${def.label}s: ${limit} at most`;
    }
    if (this.active().length >= this.rules.sites) return 'Every worker is out building';
    if (!this.hooks.home()?.alive) return 'No workers left';
    return null;
  }

  private active(): Site[] {
    return this.sites.filter((s) => !s.done);
  }

  /** How much ground a structure takes (its blocking radius, as its building will have it). */
  radius(kind: KindName): number {
    return this.world.structureRadius(kind);
  }

  /** Why `kind` can't go up at `at`, or null: its standing, then the ground (`fits`). Cheap enough for every frame. */
  check(kind: KindName, at: THREE.Vector3): string | null {
    const def = this.def(kind);
    if (!def) return 'Unknown structure';
    return this.standing(def) ?? this.fits(def, at);
  }

  /**
   * Why a structure can't stand at `at`, or null, whatever the rules allow: the ground under it
   * (walkable, level enough), what's already there, and the mode's zones. A mode placing its own
   * structures (or an AI commander) uses this, and `findSpot`.
   */
  fits(def: StructureDef, at: THREE.Vector3): string | null {
    const kind = def.kind;
    const w = this.world;
    const t = w.terrain;
    const r = this.radius(kind);
    if (!t.playable(at.x, at.z)) return 'Off the field';
    // Walkable and level enough under the whole footprint.
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = k === 8 ? at.x : at.x + Math.cos(a) * r * 0.85;
      const z = k === 8 ? at.z : at.z + Math.sin(a) * r * 0.85;
      if (!t.walkable(x, z)) return "Can't build there";
      const h = t.heightAt(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > Math.max(1.2, r * 0.2)) return 'The ground is too rough';
    for (const b of w.buildings) {
      if (!b.alive) continue;
      if (Math.hypot(b.position.x - at.x, b.position.z - at.z) < r + b.radius + this.rules.gap) return `Too close to the ${this.label(b.kind.name)}`;
    }
    for (const s of this.active()) {
      if (s.building) continue;
      if (Math.hypot(s.at.x - at.x, s.at.z - at.z) < r + s.radius + this.rules.gap) return 'Something is going up there';
    }
    for (const u of w.unitsNear(at.x, at.z, r + 2)) if (u.immobile && u.team === this.team) return 'Something is dug in there';
    return this.hooks.zone?.(at, def) ?? null;
  }

  /** The nearest spot to `near` (between `from` and `to` meters out) where `kind` fits, or null. */
  findSpot(kind: KindName, near: THREE.Vector3, from: number, to: number): THREE.Vector3 | null {
    const def = this.def(kind);
    if (!def) return null;
    const p = new THREE.Vector3();
    for (let r = from; r <= to; r += 3) {
      const n = Math.max(8, Math.round(r / 2));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r * 0.37;
        p.set(near.x + Math.cos(a) * r, 0, near.z + Math.sin(a) * r);
        if (!this.fits(def, p)) return p.setY(this.world.terrain.heightAt(p.x, p.z)).clone();
      }
    }
    return null;
  }

  /** Which way a structure at `at` faces: away from the base, toward whatever comes. */
  facing(at: THREE.Vector3): number {
    const home = this.hooks.home();
    return home ? Math.atan2(at.x - home.position.x, at.z - home.position.z) : 0;
  }

  /** A finished structure, put up at once (a mode's own base, a scripted build). */
  raise(kind: KindName, at: THREE.Vector3, yaw = this.facing(at)): Building {
    const b = this.world.spawnBuilding(kind, at.x, at.z, yaw, this.team);
    const def = this.def(kind);
    if (def) this.hooks.built?.(b, def);
    return b;
  }

  /** Orders `kind` built at `at`: pays, marks the site, sends a worker. Why not, or null. */
  order(kind: KindName, at: THREE.Vector3, t: Treasury): string | null {
    const def = this.def(kind);
    if (!def) return 'Unknown structure';
    const why = this.check(kind, at);
    if (why) return why;
    const p = this.price(def);
    const short = t.short(p);
    if (short) return short;
    const r = this.radius(kind);
    if (this.rules.keepPaths && this.hooks.approaches && !this.world.pathsOpenWith([{ x: at.x, z: at.z, r }], this.hooks.approaches())) {
      return 'That would wall the swarm out entirely';
    }
    t.spend(p);
    const site: Site = { def, at: at.clone().setY(this.world.terrain.heightAt(at.x, at.z)), yaw: this.facing(at), radius: r, seconds: p.seconds, cost: p, progress: 0, building: null, builder: null, brain: null, stage: -1, sparkIn: 0, done: false };
    this.sites.push(site);
    this.dispatch(site);
    return null;
  }

  /** Calls a site off before it's finished: part of the cost back, the structure gone. */
  cancel(site: Site, t: Treasury) {
    if (site.done) return;
    site.done = true;
    t.earn(Math.floor(site.cost.ore * this.rules.refund), Math.floor(site.cost.gas * this.rules.refund), this.world.time, false);
    if (site.building?.alive) this.world.despawn(site.building);
    this.world.updatePaths();
  }

  private dispatch(site: Site) {
    const home = this.hooks.home();
    if (!home?.alive) return;
    const out = new THREE.Vector3(site.at.x - home.position.x, 0, site.at.z - home.position.z).normalize();
    const door = home.position.clone().addScaledVector(out, home.radius + 3);
    site.builder = this.world.spawnUnit(this.worker, door.x, door.z, Math.atan2(out.x, out.z), (u) => (site.brain = new BuilderBrain(u, site, this.hooks.home)), this.team);
  }

  /** Structures rise while their workers are at them. */
  update(dt: number) {
    const w = this.world;
    for (const s of this.sites) {
      if (s.done) continue;
      if (s.building && !s.building.alive) {
        s.done = true;
        this.hooks.lost?.(s.def);
        continue;
      }
      if (!s.builder?.alive) {
        this.dispatch(s);
        continue;
      }
      if (!s.brain?.working) continue;
      if (!s.building) {
        // Ground broken: the structure starts with a tenth of its life.
        const b = w.spawnBuilding(s.def.kind, s.at.x, s.at.z, s.yaw, this.team);
        b.hp = b.maxHp * FOUNDATION;
        s.building = b;
        this.built.add(b);
        w.updatePaths();
        this.hooks.started?.(b, s.def);
      }
      const b = s.building;
      s.progress = Math.min(1, s.progress + dt / s.seconds);
      b.hp = Math.min(b.maxHp, b.hp + (b.maxHp * (1 - FOUNDATION) * dt) / s.seconds);
      const stage = Math.max(0, STAGES.findIndex((x) => s.progress <= x.until));
      const st = STAGES[stage];
      const start = stage > 0 ? STAGES[stage - 1].until : 0;
      const k = THREE.MathUtils.clamp((s.progress - start) / (st.until - start), 0, 1);
      const length = b.visual.template.clips.get(st.clip)?.duration ?? 0;
      s.stage = stage;
      const [from, to] = st.rise ? riseOf(b, st.clip) : [0, 1];
      if (length > 0) b.visual.resume(st.clip, (from + (to - from) * k) * length, false);
      // The weld: sparks where the worker is at it, and its sound now and then.
      s.sparkIn -= dt;
      if (s.sparkIn <= 0 && s.builder) {
        s.sparkIn = SPARKS * (0.6 + Math.random() * 0.8);
        const from = s.builder.position;
        const at = b.position.clone().lerp(from, 0.55 + Math.random() * 0.25);
        at.y = w.terrain.heightAt(at.x, at.z) + 0.6 + Math.random() * Math.max(1, b.height * k * 0.6);
        w.effects.sparks(at, v.subVectors(from, at).setY(0.6).normalize(), 5, 0xffd8a0);
        if (Math.random() < 0.3) w.audio.play('repair', { at, volume: 0.5, near: 12, limit: 3 });
      }
      if (s.progress >= 1) {
        s.done = true;
        b.visual.play('Stand', { restart: true, fade: 0.3 });
        this.hooks.built?.(b, s.def);
      }
    }
    // Finished sites drop off once their workers are home.
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      if (s.done && !s.builder?.alive) this.sites.splice(i, 1);
    }
  }
}

const v = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

/**
 * A worker sent out to build: out to the site, welding while the structure rises, then home to
 * the base, where it goes back in.
 */
export class BuilderBrain implements Controller {
  private state: 'out' | 'work' | 'home' = 'out';

  constructor(
    private u: Unit,
    private site: { at: THREE.Vector3; radius: number; done: boolean },
    private home: () => Building | null,
  ) {
    u.customAnimation = true;
  }

  /** At the site, building. */
  get working(): boolean {
    return this.state === 'work';
  }

  update() {
    const u = this.u;
    const s = this.site;
    if (this.state === 'out') {
      // The way round whatever's between (the base's buildings, cliffs), to the site's edge.
      const d = Math.hypot(s.at.x - u.position.x, s.at.z - u.position.z);
      if (walkTo(u, s.at, s.radius + 2.5, u.world.pathsTo(s.at, s.radius + 2)) || (u.blocked > 0.6 && d < s.radius + 8)) this.state = 'work';
      return;
    }
    if (this.state === 'work') {
      if (s.done) {
        this.state = 'home';
        return;
      }
      u.move.set(0, 0);
      u.face = Math.atan2(s.at.x - u.position.x, s.at.z - u.position.z);
      u.visual.play('Stand Work');
      if (Math.random() < 0.25) {
        const spot = v.copy(s.at).lerp(u.position, 0.55);
        spot.y = u.position.y + 1.2;
        u.world.effects.sparks(spot, up, 2, 0xffd090);
      }
      return;
    }
    const cc = this.home();
    if (!cc?.alive) {
      u.move.set(0, 0);
      u.visual.play('Stand');
      return;
    }
    const toward = v.set(u.position.x - cc.position.x, 0, u.position.z - cc.position.z).normalize();
    const door = cc.position.clone().addScaledVector(toward, cc.radius + 2);
    if (walkTo(u, door, 3, u.world.pathsTo(cc.position, cc.radius + 4)) || Math.hypot(cc.position.x - u.position.x, cc.position.z - u.position.z) < cc.radius + 5) u.world.despawn(u);
  }
}
