import * as THREE from 'three';
import type { Audio } from '../engine/audio.ts';
import { Crowd } from '../engine/crowd.ts';
import type { Effects } from '../engine/effects.ts';
import { EffectModels, type EffectModel } from '../engine/fxmodel.ts';
import type { DeathPlan, ModelInstance, ModelTemplate } from '../engine/model.ts';
import { particles } from '../engine/particles.ts';
import type { Ground } from '../engine/terrain.ts';
import { Building, Entity, Unit, type Blocker, type Controller } from './entity.ts';
import { FlowField } from './flowfield.ts';
import type { DamageStats, DeathType } from './stats.ts';
import { canHit, type DeathVariant, type Kind, type KindName, type Team, type Weapon, type KindDef } from './kinds.ts';
import type { ModelName, SoundName } from '../content/assetnames.ts';
import { loreScale, SCALE_AS } from './scale.ts';
import { Sfx, type CueName } from './sfx.ts';
import { AirHeight } from './systems/airheight.ts';
import { MissileBodies } from './systems/missiles.ts';
import { CrowdVisual, HeroVisual, type Visual } from './visual.ts';

export const TEAM_COLOR: Record<Team, THREE.Color> = {
  holdouts: new THREE.Color(0x1e64ff),
  crawl: new THREE.Color(0x8a2be0),
  directorate: new THREE.Color(0xc41e1e),
};

/**
 * How many times a Trooper's attack tokens a body of the player's draws (where a mode scales
 * them): as many more melee attackers as its edge has room for, a Trooper's being this wide
 * (meters, its radius); more ranged ones the bigger it is; and an aircraft, over everything,
 * three times a Trooper's.
 */
const TOKEN_RADIUS = 0.7;
function tokenScale(body: Entity): { melee: number; ranged: number } {
  const k = Math.max(1, body.radius / TOKEN_RADIUS);
  return { melee: Math.min(k, 6), ranged: body.flying ? 3 : Math.min(1 + (k - 1) / 2, 4) };
}
/** A body this wide (its radius, meters) slides round buildings it walks into (see `moveUnit`). */
const SLIDE_RADIUS = 4.5;
/** How far around its target a volley's other shots look for theirs, meters (further among flyers, which keep apart). */
const VOLLEY_SPREAD = 9;
const VOLLEY_SPREAD_AIR = 22;
/** How long a flamethrower's burst pours along its line (a Torchrunner's), seconds. */
const FLAME_BURST = 0.5;
/** How far the player's aircraft banks sliding sideways at full speed, radians. */
const SLIDE_BANK = 0.4;
/**
 * Animations baked for crowds: the ones the simulation plays (Jump: the Leaper's leap; Burrow
 * and Unburrow: a Scuttle Mine going under and coming up to run, which without them stood on the
 * ground in plain sight until something set it off; Spell: a Picket's Seekers; Stand Work: a
 * Mender's or a Rigger's repairs, without which they walked on the spot).
 */
const CROWD_CLIPS = /^((Stand|Walk|Attack|Spell|Morph Start|Morph End|Jump|Jump Start|Jump End|Burrow|Unburrow|Stand Work|Stand Work Start|Stand Work End)( \d+)?|Death( [A-Za-z]+)?( \d+)?)$/;
/** A death animation's name, with its type ("Death Fire") and variant number ("Death 02"). */
const DEATH_CLIP = /^Death( [A-Za-z]+)?( \d+)?$/;
/** The sound laid over a death by how the blow killed (where the unit has one for it). */
const DEATH_CUES: Partial<Record<DeathType, CueName>> = { Fire: 'death.fire', Disintegrate: 'death.acid', Eviscerate: 'death.eviscerate', Silentkill: 'death.silent' };

/**
 * The death animation a model plays for a death type: its "Death Fire" or "Death Silentkill"
 * if it has one, else its plain Death, else whatever death it has (an acid death model names
 * its animations "Death Fire").
 */
function variantModels(v: DeathVariant | undefined): readonly ModelName[] {
  return v?.model === undefined ? [] : typeof v.model === 'string' ? [v.model] : v.model;
}

function deathClip(t: ModelTemplate, type: DeathType): string {
  if (type !== 'Normal' && t.variants(`Death ${type}`).length) return `Death ${type}`;
  if (t.variants('Death').length) return 'Death';
  const any = [...t.clips.keys()].find((n) => DEATH_CLIP.test(n));
  return any ? any.replace(/ \d+$/, '') : 'Death';
}
const CROWD_CAPACITY: Partial<Record<ModelName, number>> = {
  hound: 2000,
  houndDeath: 2000,
  quillback: 500,
  quillbackDeath: 500,
  shellback: 500,
  shellbackDeath: 500,
  trooper: 500,
  trooperDeath: 500,
  blister: 300,
  blisterDeath: 300,
  kite: 200,
  turnedColonist: 600,
  turnedColonistDeath: 600,
  turnedTrooper: 400,
  turnedTrooperDeath: 400,
  leaper: 600,
  leaperDeath: 600,
};

export interface WorldEvents {
  damaged?(e: Entity, amount: number, source: Entity | null): void;
  killed?(e: Entity, source: Entity | null): void;
  /** A unit born mid-battle (a Mite from a Sower's strike), for whoever gives it orders. */
  spawned?(u: Unit, parent: Entity): void;
}

export interface RayHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  entity: Entity | null;
}

interface Projectile {
  /** Its glow, and where it is. */
  sprite: THREE.Sprite;
  /** The missile's own model riding it (its glow and trail), where it shows. */
  model: EffectModel | null;
  velocity: THREE.Vector3;
  speed: number;
  target: Entity;
  source: Entity;
  weapon: Weapon;
  /** This leg's damage: a Bounce Shard weakens with each jump. */
  damage: DamageStats;
  /** Who it has already hit, so a bounce moves on. */
  struck: Entity[];
  life: number;
  color: THREE.Color;
  /** How hard it steers after its target, per second (0: it flies where it was aimed). */
  homing: number;
  /** At the player's body: aimed rather than guided, so it hits only what it passes through. */
  atPlayer: boolean;
  /** Where an aimed missile was sent: past the player when the shot went wide. */
  aim: THREE.Vector3 | null;
  /** Lobbed (the data's throw): an arc from where it left to where it lands, over `duration` seconds. */
  lob: { from: THREE.Vector3; to: THREE.Vector3; t: number; duration: number; apex: number } | null;
  /**
   * Flung (`KindDef.fling`): thrown out along `out` from `from`, then diving onto `to`, over
   * `duration` seconds, wobbling `wave` meters to the side as the data's mover makes it weave.
   */
  fling: { from: THREE.Vector3; out: THREE.Vector3; to: THREE.Vector3; t: number; duration: number; wave: number; side: THREE.Vector3 } | null;
  /** The creature flying, where a missile is one (a Mite). */
  body: HeroVisual | null;
  /** The missile's own body (its model's mesh), where it has one. */
  mesh: ModelInstance | null;
}

/** Seconds a flung Mite plays its Birth before it curls into its Spell (the timer its missile's data sets). */
const FLING_BIRTH = 0.375;

interface Corpse {
  visual: CrowdVisual | HeroVisual;
  position: THREE.Vector3;
  yaw: number;
  scale: number;
  age: number;
  /** Seconds until it's gone. */
  life: number;
  /** Its last seconds, in which it settles into the ground and breaks up. */
  fade: number;
  /** Where its death animation is at each age (see corpseClock). */
  clock: (age: number) => number;
  /** Whether its death animation burns the body away itself, at the end. */
  burns: boolean;
  /**
   * A flyer's wreck coming down: its velocity, and how far above the ground its model stops (the
   * part of the fall its death animation makes itself).
   */
  fall?: { velocity: THREE.Vector3; carried: number };
  /**
   * A flyer that dies lower than its death animation's own fall (a 32 m Sower's sags 71 m;
   * it flies at 40): it starts where it was and is held up only as far as that fall would take
   * it under the ground, so it comes to rest on it. Lifted there at once, it jumped up as it died.
   */
  sag?: { from: number; above: number; curve: DropCurve; scale: number };
}

/** How far a death animation has dropped the body (model units) by each of `times` (seconds into it). */
interface DropCurve {
  times: number[];
  drops: number[];
  total: number;
}

/** A share of a blow: 1/`n` of its damage and of each bonus, as a round of `n` (armor still counts against each). */
export function shareOf(d: DamageStats, n: number): DamageStats {
  return {
    ...d,
    amount: d.amount / n,
    bonus: Object.fromEntries(Object.entries(d.bonus).map(([a, v]) => [a, v / n])),
    structure: d.structure === undefined ? undefined : d.structure / n,
  };
}

function dropAt(c: DropCurve, t: number): number {
  const { times, drops } = c;
  if (t <= times[0]) return drops[0];
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) return drops[i - 1] + ((drops[i] - drops[i - 1]) * (t - times[i - 1])) / Math.max(1e-6, times[i] - times[i - 1]);
  }
  return drops[drops.length - 1];
}

/**
 * Where a death animation is at each moment of a corpse's `life` seconds. A death model is made
 * to play its animation through and go at its end, having burned the body away in its last
 * seconds; a corpse here lasts as long as the mission wants. So the fall and the burn-away play
 * at their own pace, and the still stretch between them (the body lying where it fell) is drawn
 * out or cut short to fit, skipped outright if need be. A life too short for even the fall and
 * the burn loses the end.
 */
export function corpseClock(plan: DeathPlan, life: number): (age: number) => number {
  const span = Math.max(0, plan.burn - plan.settled);
  const room = Math.max(0, life - (plan.duration - span));
  return (age) => {
    if (age <= plan.settled || span === 0) return age;
    if (age < plan.settled + room) return plan.settled + ((age - plan.settled) * span) / room;
    return plan.burn + (age - plan.settled - room);
  };
}

const CORPSE_TIME = 9;
/** What a death animation's own burn-away leaves (bones, a pool) breaks up over this, at the very end. */
const BURNT_FADE = 0.4;
/** A falling wreck's gravity, m/s²: a little heavier than life, so it drops rather than floats. */
const WRECK_GRAVITY = 26;
const CORPSE_FADE = 2.5;
/** A building's wreck lasts longer than a body: the battle moves on around it. */
const WRECK_TIME = 45;
const GRID = 8;
/** Paths to places (`pathsTo`) kept at once, and the least seconds between remaking one. */
const PLACE_PATHS = 8;
const PATHS_REFRESH = 2;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();

/**
 * The weapon attachments a model of the game's own fires from (World.outlet): every one it has, for a building that
 * fires each way from the one facing its target (a Bunker's slits); and the set it fires from in turn, Ref_Weapon
 * where it has one, else whichever set stands farthest forward in its Stand: its left and right pair, its numbered
 * ones, or another (a Flak Tower's numbered tubes ahead of its pods' middles, a Shellback's mouth ahead of its
 * numbered vents, the Kite's tail sling).
 */
function weaponOutlets(template: ModelTemplate): { all: string[]; turn: string[] } {
  const all = template.data.attachments.map((a) => a.name).filter((n) => /^Ref_Weapon\b/i.test(n) && template.standing(n));
  const main = all.find((n) => n.toLowerCase() === 'ref_weapon');
  if (main) return { all, turn: [main] };
  const sets = [all.filter((n) => / (left|right)$/i.test(n)), all.filter((n) => / \d+$/.test(n))];
  sets.push(all.filter((n) => !sets.some((g) => g.includes(n))));
  let turn: string[] = [];
  let ahead = -Infinity;
  for (const set of sets) {
    if (!set.length) continue;
    const z = set.reduce((sum, n) => sum + template.standing(n)!.z, 0) / set.length;
    if (z > ahead) [ahead, turn] = [z, [...set].sort()];
  }
  return { all, turn };
}
/** How much bigger than the infantry's a unit's weapon effects may grow (`effectScaleOf`): a Frigate's are four times and more. */
const EFFECT_GROWTH = 4.5;
/** One of a weapon's guns (`launch`'s own: its callers pass the shared ones in). */
const gun = new THREE.Vector3();
const seg = new THREE.Vector3();

/** Distance from `p` to the segment from `a` to `b` (a missile's path over one frame). */
function segmentDistance(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): number {
  seg.subVectors(b, a);
  const len2 = seg.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(((p.x - a.x) * seg.x + (p.y - a.y) * seg.y + (p.z - a.z) * seg.z) / len2, 0, 1) : 0;
  return Math.hypot(a.x + seg.x * t - p.x, a.y + seg.y * t - p.y, a.z + seg.z * t - p.z);
}

/**
 * Whether a weapon can shoot at something, by its target filters: flyers only with anti-air,
 * ground units only with a weapon that shoots down, buildings unless it excludes them.
 */
export { canHit } from './kinds.ts';

/** Rounds into flesh or into armor plate: by the target's attributes, as its stats tag them. */
export function fleshy(e: Entity): boolean {
  return !e.isBuilding && e.kind.attributes.includes('Biological') && !e.kind.attributes.includes('Mechanical');
}

/**
 * The shooter's damage scale. The game's numbers are an RTS's: a lone Trooper needs six
 * bursts, three seconds of steady fire, for one Hound, because Troopers win by the dozen. In
 * your hands that reads as a peashooter, so the body you're in hits harder: three and a half
 * times for infantry (two bursts for a Hound, one to the head), twice for a tank. The rest of
 * the battle, your squad and theirs, keeps the game's own numbers.
 */
export const PLAYER_DAMAGE = { infantry: 3.5, vehicle: 2 };
/** A round that finds a weak spot (a head) hits this much harder. */
export const WEAK_SPOT = 1.75;
/** How far the news of a hit carries among the victim's side, meters. */
export const ALARM_RADIUS = { swarm: 34, squad: 30 };
/** Seconds an alert keeps an AI after whoever drew blood (the swarm holds a grudge longer). */
export const ALERT_SECONDS = { squad: 10, swarm: 25 };

export class World {
  time = 0;
  readonly entities: Entity[] = [];
  readonly events: WorldEvents = {};
  readonly flow: FlowField;
  /** Paths to the player's body, for whatever is after it and finds a cliff in the way. */
  private playerFlow: FlowField | null = null;
  /** Paths to places units have been sent (`pathsTo`), the most recently asked for last. */
  private placePaths = new Map<string, { field: FlowField; version: number; made: number }>();
  /** Bumped whenever a building goes up or comes down: paths made before it are out of date. */
  private buildingsVersion = 0;
  private playerFlowAt = new THREE.Vector3(Infinity, 0, 0);
  private playerFlowTime = -Infinity;
  /** Units that a cliff turned aside, and until when they keep to the paths before trying straight again. */
  private detours = new WeakMap<Unit, number>();
  /** The target the player is shooting at: nearby friendly squads focus it. */
  focus: { target: Entity; until: number } | null = null;
  /** The player's edge over the game's numbers (PLAYER_DAMAGE; a mode may set its own). */
  playerDamage = PLAYER_DAMAGE;
  /** Story sizes a mode draws some models at instead of scale.ts's (meters; set before anything is spawned). */
  sizes: Partial<Record<ModelName, number>> = {};
  private projectiles: Projectile[] = [];
  private corpses: Corpse[] = [];
  /** How far each death clip drops the body over its length, model units (flyers'). */
  private drops = new Map<string, DropCurve>();
  /** Each shooter's place in its weapon's launch cycle (`KindEffects.launchCycle`). */
  private cycles = new WeakMap<Entity, number>();
  /** Per model of the game's own: the weapon attachments its shots leave from, in turn (`outlet`). */
  private outlets = new WeakMap<ModelTemplate, { all: string[]; turn: string[] }>();
  private grid = new Map<number, Unit[]>();
  private scales = new Map<ModelName, number>();
  private crowds = new Map<string, Crowd>();
  /** Each plain death model's other deaths (a burning, an acid one), from the kinds. */
  private deathVariants = new Map<ModelTemplate, ModelTemplate[]>();
  /** Crowds to bake a few at a time: the other deaths of a death model first seen mid-battle. */
  private bakeQueue: { template: ModelTemplate; team: Team }[] = [];
  private capacity = new Map<ModelTemplate, number>();
  private standing: Building[] = [];
  private scratch: Unit[] = [];
  private alarmScratch: Unit[] = [];
  private glow: THREE.Texture;
  /** Where the swarm is headed: the Holdfast. */
  goal: Entity | null = null;
  /** Seconds (Normal speed) a Howitzer takes to transform, from the ability data. */
  braceTime = 4.04;
  /** The body the player is in, if any. */
  player: Entity | null = null;
  /** Radius of the base's perimeter around the goal, meters. */
  perimeter = 135;
  /** Seconds a body lies where it fell (a mission may keep its dead longer: The Tide's field fills with them). */
  corpseTime = CORPSE_TIME;
  /**
   * Buildings block the ground in their own shape (a barricade, a row of circles down its
   * length) rather than one circle each. Opt-in: missions balanced around the circles keep them.
   */
  shapedFootprints = false;
  /** The last seconds of a body's life, in which it sinks into the ground and breaks up. */
  corpseFade = CORPSE_FADE;
  /**
   * Attack tokens: how many Crawl may go for the player's own body at once, melee and ranged.
   * The swarm is endless; the pressure on one rifle is tuned (difficulty sets these).
   */
  playerTokens = { melee: 4, ranged: 3 };
  /** The tokens grow with the body's size (`MissionRules.tokensBySize`): see `tokenScale`. */
  tokensBySize = false;
  private onPlayer = new Set<Unit>();
  readonly sfx: Sfx;
  /** How hard enemy hits on the player's body land, by difficulty (Normal: a quarter harder). */
  incomingDamage = 1.25;
  /** The Medic's heal for the AI: life per real second, energy per life, reach in meters. */
  medicHeal = { rate: 12.6, energyPerLife: 0.33, range: 8.8 };
  /** Things that play out over time on the battlefield: warheads in flight. */
  readonly timed: { update(dt: number): void; done: boolean }[] = [];
  /** The effect models playing: impacts, launch flashes, the reactions of what was hit. */
  readonly fx = new EffectModels();

  constructor(
    readonly scene: THREE.Scene,
    readonly terrain: Ground,
    readonly effects: Effects,
    readonly audio: Audio,
    readonly kinds: Record<KindName, Kind>,
    readonly models: Record<ModelName, ModelTemplate>,
    readonly mapRadius: number,
  ) {
    this.sfx = new Sfx(audio);
    this.flow = new FlowField(terrain.size, terrain.pathCell);
    this.flow.setTerrain((x, z) => terrain.walkable(x, z));
    for (const [name, template] of Object.entries(models) as [ModelName, ModelTemplate][]) {
      // A death by fire or acid is as common as the plain one where a weapon kills that way.
      const plain = name.replace(/(Fire|Acid|Blast|Eviscerate)\d*$/, '') as ModelName;
      this.capacity.set(template, CROWD_CAPACITY[name] ?? CROWD_CAPACITY[plain] ?? 160);
    }
    for (const kind of Object.values(kinds)) {
      const plain = kind.def.deathModel && models[kind.def.deathModel];
      if (!plain || !kind.def.deaths) continue;
      const list = this.deathVariants.get(plain) ?? [];
      for (const v of Object.values(kind.def.deaths)) for (const m of variantModels(v)) if (models[m] && !list.includes(models[m])) list.push(models[m]);
      this.deathVariants.set(plain, list);
    }
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.glow = new THREE.CanvasTexture(c);
  }

  scaleOf(model: ModelName): number {
    let s = this.scales.get(model);
    if (s === undefined) {
      // Death and transformation models are sized like the unit they belong to (a burning
      // Trooper's like a Trooper).
      const base = (SCALE_AS[model] ?? model.replace(/(Braced)?(Death|Morph)(Fire|Acid|Blast|Eviscerate)?\d*$/, '')) as ModelName;
      s = loreScale(base, this.models[base] ?? this.models[model], this.sizes[base]);
      this.scales.set(model, s);
    }
    return s;
  }

  /** A model standing in the world for show (an ore field): no unit, nothing to fight. */
  spawnProp(name: ModelName, x: number, z: number, yaw = 0): Visual | null {
    const t = this.models[name];
    if (!t) return null;
    const v = new HeroVisual(t.instantiate(TEAM_COLOR.holdouts), this.scene);
    v.play('Stand');
    v.update(0);
    v.sync(new THREE.Vector3(x, this.terrain.heightAt(x, z), z), yaw, this.scaleOf(name));
    return v;
  }

  /** The instanced crowd for a model and team, baked on first use. */
  crowd(template: ModelTemplate, team: Team): Crowd {
    const key = `${template.path}|${team}`;
    let c = this.crowds.get(key);
    if (!c) {
      c = new Crowd(template, TEAM_COLOR[team], this.capacity.get(template) ?? 160, CROWD_CLIPS);
      // How each death plays out (a few milliseconds a clip), measured now rather than at the
      // first death of the battle.
      for (const name of template.clips.keys()) if (DEATH_CLIP.test(name)) template.deathPlan(name);
      this.crowds.set(key, c);
      // Its other deaths (burning, acid...) come a frame at a time, or at once while prewarming.
      for (const v of this.deathVariants.get(template) ?? []) this.bakeQueue.push({ template: v, team });
      this.scene.add(c.mesh);
    }
    return c;
  }

  /** Bakes crowds ahead of time so the first wave doesn't hitch. */
  prewarm(names: ModelName[], team: Team) {
    for (const n of names) if (this.models[n]) this.crowd(this.models[n], team);
    this.bakeQueued(Infinity);
  }

  /** Bakes up to `count` queued crowds (variant deaths). */
  private bakeQueued(count: number) {
    for (let i = 0; i < count && this.bakeQueue.length; i++) {
      const { template, team } = this.bakeQueue.shift()!;
      this.crowd(template, team);
    }
  }

  /**
   * Switches a unit between a crowd instance and a full skeleton (for the unit the player is
   * controlling), carrying its current animation over.
   */
  setHero(e: Entity, hero: boolean, template = e.visual.template) {
    const was = e.visual;
    if ((was instanceof HeroVisual) === hero && template === was.template) return;
    const name = was.animation || 'Stand';
    const time = was.time;
    // A one-shot animation (a brace transformation) stays one-shot in the new visual: resumed as
    // a loop, a tank would transform over and over.
    const loop = was.looping;
    was.dispose();
    let next: Visual;
    if (hero) {
      next = new HeroVisual(template.instantiate(TEAM_COLOR[e.team], true), this.scene);
      next.resume(name, time, loop);
    } else {
      const cv = new CrowdVisual(this.crowd(template, e.team));
      cv.resume(name, time, loop);
      next = cv;
    }
    // Treads and wheels where they'd rolled to, or they'd jump as control changes hands.
    next.treadLeft = was.treadLeft;
    next.treadRight = was.treadRight;
    next.wheel = was.wheel;
    next.ground.copy(was.ground);
    e.visual = next;
    e.syncTransform();
  }

  /**
   * Changes an entity's side (a captured base's bunkers and turrets): it's redrawn in the new
   * team's color.
   */
  setTeam(e: Entity, team: Team) {
    if (e.team === team) return;
    e.team = team;
    const was = e.visual;
    const template = was.template;
    const name = was.animation || 'Stand';
    const time = was.time;
    const loop = was.looping;
    const hero = was instanceof HeroVisual;
    was.dispose();
    let next: Visual;
    if (hero) {
      next = new HeroVisual(template.instantiate(TEAM_COLOR[team], true), this.scene);
      next.resume(name, time, loop);
    } else {
      const cv = new CrowdVisual(this.crowd(template, team));
      cv.resume(name, time, loop);
      next = cv;
    }
    e.visual = next;
    e.syncTransform();
  }

  spawnUnit(name: KindName, x: number, z: number, yaw = 0, controller?: (u: Unit) => Controller, team: Team = this.kinds[name].def.team): Unit {
    const kind = this.kinds[name];
    const template = this.models[kind.def.model];
    const crowd = this.crowd(template, team);
    // A crowd with every slot taken (a swarm past what it was sized for): drawn on its own instead.
    const visual = crowd.full ? new HeroVisual(template.instantiate(TEAM_COLOR[team]), this.scene) : new CrowdVisual(crowd);
    const unit = new Unit(this, kind, visual, this.scaleOf(kind.def.model));
    unit.team = team;
    unit.position.set(x, this.terrain.heightAt(x, z) + unit.altitude, z);
    unit.yaw = yaw;
    if (controller) unit.controller = controller(unit);
    unit.syncTransform();
    this.entities.push(unit);
    return unit;
  }

  spawnBuilding(name: KindName, x: number, z: number, yaw = 0, team: Team = this.kinds[name].def.team): Building {
    const kind = this.kinds[name];
    // Materials of its own, so its hit flash is its own.
    const visual = new HeroVisual(this.models[kind.def.model].instantiate(TEAM_COLOR[team], true), this.scene);
    const b = new Building(this, kind, visual, this.scaleOf(kind.def.model));
    b.team = team;
    b.position.set(x, this.terrain.heightAt(x, z), z);
    b.yaw = yaw;
    b.syncTransform();
    this.entities.push(b);
    this.standing.push(b);
    this.buildingsVersion++;
    return b;
  }

  /** Moves a standing building (a script laying out its base), so the paths round it are laid again. */
  moveBuilding(b: Building, x: number, z: number) {
    b.position.set(x, this.terrain.heightAt(x, z), z);
    b.syncTransform();
    b.moved();
    this.buildingsVersion++;
  }

  /** Standing buildings (kept up to date as they fall). */
  get buildings(): Building[] {
    return this.standing;
  }

  /** Whether `u` may take one of the player's attack tokens (or already holds one). */
  mayEngagePlayer(u: Unit): boolean {
    if (this.onPlayer.has(u)) return true;
    let melee = 0;
    let ranged = 0;
    for (const a of this.onPlayer) {
      if (!a.alive) this.onPlayer.delete(a);
      else if (a.kind.weapon?.melee) melee++;
      else ranged++;
    }
    const k = this.tokensBySize && this.player ? tokenScale(this.player) : null;
    return u.kind.weapon?.melee ? melee < this.playerTokens.melee * (k?.melee ?? 1) : ranged < this.playerTokens.ranged * (k?.ranged ?? 1);
  }

  /** Records whether `u` is going for the player's body. */
  engagePlayer(u: Unit, on: boolean) {
    if (on) this.onPlayer.add(u);
    else this.onPlayer.delete(u);
  }

  /** Recomputes the swarm's paths toward the goal around standing buildings. */
  updatePaths() {
    const goal = this.goal;
    if (!goal) return;
    this.flow.compute(
      [{ x: goal.position.x, z: goal.position.z, r: goal.radius + 6 }],
      this.standing.filter((b) => b !== goal).flatMap((b) => this.blockers(b)),
    );
  }

  /** The circles of ground a building blocks. */
  blockers(b: Building): Blocker[] {
    return this.shapedFootprints ? b.footprint() : b.blocking();
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / GRID) + 512) * 1024 + (Math.floor(z / GRID) + 512);
  }

  /** Living, targetable units within `r` of a point. */
  unitsNear(x: number, z: number, r: number, out: Unit[] = []): Unit[] {
    out.length = 0;
    const span = Math.ceil(r / GRID);
    const cx = Math.floor(x / GRID);
    const cz = Math.floor(z / GRID);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const cell = this.grid.get((cx + i + 512) * 1024 + (cz + j + 512));
        if (!cell) continue;
        for (const u of cell) {
          if (u.alive && (u.position.x - x) ** 2 + (u.position.z - z) ** 2 <= (r + u.radius) ** 2) out.push(u);
        }
      }
    }
    return out;
  }

  /** The closest living enemy of `team` within `r`, units and buildings alike. */
  nearestEnemy(team: Team, x: number, z: number, r: number, filter?: (e: Entity) => boolean): Entity | null {
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const u of this.unitsNear(x, z, r, this.scratch)) {
      if (u.team === team || u.ignored || u.shrouded || (filter && !filter(u))) continue;
      const d = Math.hypot(u.position.x - x, u.position.z - z) - u.radius;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    for (const b of this.standing) {
      if (b.team === team || b.ignored || (filter && !filter(b))) continue;
      const d = Math.hypot(b.position.x - x, b.position.z - z) - b.radius;
      if (d < r && d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** The closest enemy `u`'s weapon can hit, within `r` of it (or of `at`). */
  nearestTarget(u: Entity, r: number, filter?: (e: Entity) => boolean, at: { x: number; z: number } = u.position): Entity | null {
    const w = u.kind.weapon;
    const aa = u.kind.antiAir;
    return this.nearestEnemy(u.team, at.x, at.z, r, (e) => (canHit(w, e) || (!!aa && canHit(aa, e))) && (!filter || filter(e)));
  }

  /**
   * Someone was hit: they and their own side around them learn where it came from. A pack of
   * Crawl turns on whoever shoots one of them, soldiers answer fire from beyond their sight.
   * (Its own scratch list: it runs from inside damage, which may be inside a search already.)
   */
  alarm(victim: Entity, source: Entity) {
    if (this.time - victim.alarmedAt < 0.4) return;
    victim.alarmedAt = this.time;
    victim.alert = { by: source, at: this.time };
    const r = victim.team === 'crawl' ? ALARM_RADIUS.swarm : ALARM_RADIUS.squad;
    for (const u of this.unitsNear(victim.position.x, victim.position.z, r, this.alarmScratch)) {
      if (u !== victim && u.team === victim.team) u.alert = { by: source, at: this.time };
    }
  }

  /** How much harder the player's body hits than the game's numbers (see PLAYER_DAMAGE). */
  playerDamageScale(body: Entity): number {
    // A machine (a tank, a Bulwark, a Jackknife) hits as the tank does; infantry harder.
    const vehicle = body.kind.attributes.includes('Mechanical') && !body.kind.attributes.includes('Biological');
    return vehicle ? this.playerDamage.vehicle : this.playerDamage.infantry;
  }

  walkable(x: number, z: number): boolean {
    return this.flow.distance(x, z) < Infinity || this.terrain.walkable(x, z);
  }

  /**
   * Which way `u` should go to reach `target`: straight at it while the ground allows; around
   * a cliff by the paths when it doesn't (to the player's body by paths of its own, kept up to
   * date as the player moves; to anything else by the swarm's paths toward the goal).
   */
  chase(u: Unit, target: THREE.Vector3, out: THREE.Vector2, aim = target): THREE.Vector2 {
    out.set(aim.x - u.position.x, aim.z - u.position.z);
    const d = out.length();
    if (d < 1e-3) return out.set(0, 0);
    out.divideScalar(d);
    // After the player's body: its own paths whenever the way round is clearly longer than the
    // straight line (a cliff between), straight at it in the open.
    const p0 = this.player;
    if (p0 && Math.hypot(target.x - p0.position.x, target.z - p0.position.z) < 3) {
      const f = this.pathsToPlayer();
      const path = f.distance(u.position.x, u.position.z) * this.terrain.pathCell;
      const straight = Math.hypot(target.x - u.position.x, target.z - u.position.z);
      if (path < Infinity && path > straight * 1.25 + 8 && f.direction(u.position.x, u.position.z, out)) return out;
    }
    const ahead = u.radius + 3;
    // Straight at it, unless a cliff stopped it lately: then the paths for a while, or it would
    // step along the edge and straight back at it, over and over.
    const detour = (this.detours.get(u) ?? 0) > this.time;
    if (!detour && this.walkable(u.position.x + out.x * ahead, u.position.z + out.y * ahead)) return out;
    if (!detour) this.detours.set(u, this.time + 2.5);
    const p = this.player;
    if (p && Math.hypot(target.x - p.position.x, target.z - p.position.z) < 3) {
      if (this.pathsToPlayer().direction(u.position.x, u.position.z, out)) return out;
    }
    this.flow.direction(u.position.x, u.position.z, out);
    return out;
  }

  /**
   * Whether the player's body can be walked to from (`x`, `z`) (by the ground's paths, round
   * cliffs and buildings): a drop there can join them. True with no body to reach.
   */
  reachesPlayer(x: number, z: number): boolean {
    if (!this.player) return true;
    return this.pathsToPlayer().distance(x, z) < Infinity;
  }

  private pathsToPlayer(): FlowField {
    const p = this.player!;
    if (!this.playerFlow) {
      this.playerFlow = new FlowField(this.terrain.size, this.terrain.pathCell);
      this.playerFlow.setTerrain((x, z) => this.terrain.walkable(x, z));
    }
    // Recomputed when the player has moved on, at most a couple of times a second.
    if (this.time - this.playerFlowTime > 1.5 && this.playerFlowAt.distanceTo(p.position) > 10) {
      this.playerFlowTime = this.time;
      this.playerFlowAt.copy(p.position);
      this.playerFlow.compute(
        [{ x: p.position.x, z: p.position.z, r: 6 }],
        this.standing.flatMap((b) => this.blockers(b)),
      );
    }
    return this.playerFlow;
  }

  /**
   * How hard `u` holds its ground against `other` (`Kind.push`). Among its own side the player
   * comes first: the player's own body, then what the player has sent somewhere, on its way
   * there (a unit on an order pushes through idle ones).
   */
  pushPriority(u: Entity, other: Entity): number {
    let p = u.kind.push;
    if (u.team === other.team) {
      if (u === this.player) p += 10;
      else if (u instanceof Unit && u.orderedUntil > this.time && (u.move.x !== 0 || u.move.y !== 0)) p += 1;
    }
    return p;
  }

  /** Moves a unit by its controller's intent: acceleration, turning, crowding, cliffs, buildings. */
  moveUnit(u: Unit, dt: number) {
    // A jet pack in flight: its controller carries it over whatever is below.
    if (u.airborne) return;
    if (u.flying) return this.fly(u, dt);
    const wantX = u.move.x * u.speed;
    const wantZ = u.move.y * u.speed;
    const k = 1 - Math.exp(-dt * 12);
    u.velocity.x += (wantX - u.velocity.x) * k;
    u.velocity.z += (wantZ - u.velocity.z) * k;

    const startX = u.position.x;
    const startZ = u.position.z;
    let nx = startX + u.velocity.x * dt;
    let nz = startZ + u.velocity.z * dt;

    // Units shoulder each other aside by push priority: one never gives way to a lower one (a
    // Behemoth to the Troopers round its feet), always to a higher one, and between equals the
    // bigger pushes harder and the one standing still makes way for the one going somewhere.
    // Rooted units don't budge.
    if (!u.immobile) {
      const going = wantX !== 0 || wantZ !== 0;
      for (const o of this.unitsNear(nx, nz, u.radius + 4, this.scratch)) {
        if (o === u) continue;
        const dx = nx - o.position.x;
        const dz = nz - o.position.z;
        const min = u.radius + o.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const mine = this.pushPriority(u, o);
          const theirs = this.pushPriority(o, u);
          if (!o.immobile && theirs < mine) continue;
          let weight = o.immobile || theirs > mine ? 1 : o.radius / (u.radius + o.radius);
          if (!o.immobile && theirs === mine && o instanceof Unit) {
            const theyGo = o.move.x !== 0 || o.move.y !== 0;
            if (!going && theyGo) weight = Math.max(weight, 0.8);
            else if (going && !theyGo) weight *= 0.5;
          }
          const push = (min - d) * weight;
          nx += (dx / d) * push * Math.min(1, dt * 20);
          nz += (dz / d) * push * Math.min(1, dt * 20);
        }
      }
    }
    for (const b of this.standing) {
      for (const f of this.blockers(b)) {
        const dx = nx - f.x;
        const dz = nz - f.z;
        const min = u.radius + f.r;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 1;
          nx = f.x + (dx / d) * min;
          nz = f.z + (dz / d) * min;
          // A body too wide for the paths (laid for soldiers) slides round what it's up against,
          // the way it was going, rather than standing pushing into it.
          if (u.radius >= SLIDE_RADIUS && (wantX || wantZ)) {
            const tx = -dz / d;
            const tz = dx / d;
            const along = wantX * tx + wantZ * tz;
            const side = Math.abs(along) > 0.1 ? Math.sign(along) : u.id % 2 ? 1 : -1;
            nx += tx * side * u.speed * dt;
            nz += tz * side * u.speed * dt;
          }
        }
      }
    }
    // Cliffs: slide along them instead of walking up. A unit that finds itself on ground it
    // couldn't walk onto (stepped out of a bunker onto a ledge, shoved by a building, placed by a
    // map) may walk off it, or it would be stuck there for good.
    if (!this.walkable(nx, nz) && this.walkable(startX, startZ)) {
      if (this.walkable(nx, startZ)) nz = startZ;
      else if (this.walkable(startX, nz)) nx = startX;
      else {
        nx = startX;
        nz = startZ;
      }
    }
    u.position.set(nx, this.terrain.heightAt(nx, nz), nz);
    if (dt > 0) {
      // What actually happened, after crowds, buildings and cliffs: a unit held against a wall
      // stands still rather than running in place.
      const ax = (nx - startX) / dt;
      const az = (nz - startZ) / dt;
      const wanted = Math.hypot(wantX, wantZ);
      const got = Math.hypot(ax, az);
      u.blocked = wanted > 0.5 && got < wanted * 0.25 ? u.blocked + dt : 0;
      u.velocity.x = ax;
      u.velocity.z = az;
    }

    const speed = Math.hypot(u.velocity.x, u.velocity.z);
    const want = u.face ?? (speed > 0.4 ? Math.atan2(u.velocity.x, u.velocity.z) : u.yaw);
    let diff = want - u.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turn = (u.kind.def.turnRate ?? 12) * dt;
    u.yaw += Math.abs(diff) < turn ? diff : Math.sign(diff) * turn;
    u.yaw = Math.atan2(Math.sin(u.yaw), Math.cos(u.yaw));
  }

  /**
   * Flyers go straight over cliffs and rooftops at their height, easing apart from each other,
   * carrying momentum through turns and banking into them.
   */
  private fly(u: Unit, dt: number) {
    const wantX = u.move.x * u.speed;
    const wantZ = u.move.y * u.speed;
    const k = 1 - Math.exp(-dt * 2.5);
    u.velocity.x += (wantX - u.velocity.x) * k;
    u.velocity.z += (wantZ - u.velocity.z) * k;
    let nx = u.position.x + u.velocity.x * dt;
    let nz = u.position.z + u.velocity.z * dt;
    for (const o of this.unitsNear(nx, nz, u.radius + 8, this.scratch)) {
      if (o === u || !o.flying) continue;
      const dx = nx - o.position.x;
      const dz = nz - o.position.z;
      const min = u.radius + o.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5 * Math.min(1, dt * 5);
        nx += (dx / d) * push;
        nz += (dz / d) * push;
      }
    }
    // Kept over the playable map (but free to fly in from beyond its edge).
    if (!this.terrain.playable(nx, nz) && this.terrain.playable(u.position.x, u.position.z)) {
      nx = u.position.x;
      nz = u.position.z;
      u.velocity.x *= 0.5;
      u.velocity.z *= 0.5;
    }
    // Over the air height (a smoothed copy of the ground, `AirHeight`), ahead as well as below:
    // it rises before a cliff rather than into it and glides over a gully rather than dropping
    // into it. Never lower over a sharp rise than most of its altitude; and over the rooftops.
    const air = this.airHeight;
    const ax = nx + u.velocity.x * 1.5;
    const az = nz + u.velocity.z * 1.5;
    const surface = Math.max(air.at(nx, nz), air.at(ax, az));
    const ground = Math.max(this.terrain.heightAt(nx, nz), this.terrain.heightAt(ax, az));
    const bob = Math.sin(this.time * 1.7 + u.id * 1.3) * u.altitude * 0.04;
    let lift = Math.max(surface + u.altitude, ground + u.altitude * 0.6) + bob;
    for (const b of this.standing) {
      const r = b.radius + u.radius;
      if ((b.position.x - ax) ** 2 + (b.position.z - az) ** 2 < r * r || (b.position.x - nx) ** 2 + (b.position.z - nz) ** 2 < r * r) {
        lift = Math.max(lift, b.position.y + b.height + 2 - u.base);
      }
    }
    // Eased toward it, as a mover restores its height: no sudden climb or drop.
    const y = u.position.y + (lift - u.position.y) * (1 - Math.exp(-dt * 1.2));
    u.position.set(nx, y, nz);

    const speed = Math.hypot(u.velocity.x, u.velocity.z);
    const want = u.face ?? (speed > 0.4 ? Math.atan2(u.velocity.x, u.velocity.z) : u.yaw);
    let diff = want - u.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turn = (u.kind.def.turnRate ?? 4) * dt;
    const step = Math.abs(diff) < turn ? diff : Math.sign(diff) * turn;
    u.yaw = Math.atan2(Math.sin(u.yaw + step), Math.cos(u.yaw + step));
    // Bank with the turn, more at speed; the player's aircraft, whose nose follows the aim while
    // it slides any way, banks into the slide too (its right side down sliding right).
    let bank = (-step / Math.max(dt, 1e-4)) * 0.25 * Math.min(1, speed / 4);
    if (u === this.player && u.speed > 0) bank += ((-u.velocity.x * Math.cos(u.yaw) + u.velocity.z * Math.sin(u.yaw)) / u.speed) * SLIDE_BANK;
    bank = THREE.MathUtils.clamp(bank, -0.55, 0.55);
    u.visual.bank += (bank - u.visual.bank) * (1 - Math.exp(-dt * 4));
  }

  /**
   * Volatile Burst: the Blister bursts where it is, hitting everything of the enemy's around
   * it (80 to buildings), whether it reached them or was shot down on the way.
   */
  burst(u: Unit) {
    if (u.burst) return;
    u.burst = true;
    const w = u.kind.weapon!;
    const at = u.center(new THREE.Vector3());
    const r = w.splash[0]?.radius ?? 8;
    for (const o of [...this.unitsNear(at.x, at.z, r)]) {
      if (o === u || o.team === u.team || !canHit(w, o)) continue;
      o.hit(w.damage, u, 1, at);
    }
    for (const b of [...this.standing]) {
      if (b.team === u.team || !canHit(w, b)) continue;
      if (Math.hypot(b.position.x - at.x, b.position.z - at.z) - b.radius <= r) b.hit(w.damage, u, 1, at);
    }
    this.effects.acidBurst(at, r);
    this.effects.shake += 0.15;
  }

  /**
   * Plays an effect model at `at`, its front turned toward `toward` (a random heading if null);
   * `follow`, where it's carried to each frame as it plays (see `EffectModel.follow`).
   */
  playEffect(name: ModelName | undefined, at: THREE.Vector3, toward: THREE.Vector3 | null, scale: number, follow: EffectModel['follow'] = null) {
    const t = name && this.models[name];
    if (!t) return;
    const yaw = toward ? Math.atan2(toward.x - at.x, toward.z - at.z) : Math.random() * Math.PI * 2;
    this.fx.play(t, at, yaw, scale, follow);
  }

  /**
   * Meters per model unit for effects in the open, at the infantry's size (a Trooper's): what
   * nothing in particular fired (a mine going off, dust where something lands).
   */
  get effectScale(): number {
    return this.scaleOf('trooper');
  }

  /**
   * Meters per model unit for the effects of what `source` fires (its launch, its missile in
   * flight, its impact): a weapon's models are made against the unit's own, so they grow with
   * it, a Bulwark's Lances half again a Trooper's and a Behemoth's shells larger still. A
   * building's keep the infantry's (a turret's missile shouldn't land like a building falling).
   */
  effectScaleOf(source: Entity | null): number {
    const base = this.effectScale;
    if (!source || source.isBuilding) return base;
    return THREE.MathUtils.clamp(this.scaleOf(source.kind.def.model), base, base * EFFECT_GROWTH);
  }

  /**
   * The effect models `source` fires `weapon` with: its anti-air weapon's own, where it has them
   * (a Picket's Seeker missiles, not its autocannons' shells), its kind's otherwise.
   */
  effectsOf(source: Entity, weapon?: Weapon | null): KindDef['effects'] {
    const def = source.kind.def;
    return weapon && weapon === source.kind.antiAir && def.airEffects ? def.airEffects : def.effects;
  }

  /**
   * The size a weapon's missile is drawn at, meters a model unit: its body (`KindEffects
   * .missileScale` times its shooter's effects), and its glow and trail, which grow no more than
   * twice (a Lance's flare at three times its size was a sun).
   */
  missileScale(source: Entity, weapon: Weapon | null | undefined): { body: number; trail: number } {
    const fx = this.effectsOf(source, weapon);
    const base = this.effectScaleOf(source) * (fx?.scale ?? 1);
    const k = fx?.missileScale ?? 1;
    return { body: base * k, trail: base * Math.min(k, 2) };
  }

  /** Calls `fn` `seconds` from now (in game time: it waits out a pause). */
  after(seconds: number, fn: () => void) {
    let t = 0;
    this.timed.push({
      done: false,
      update(dt: number) {
        t += dt;
        if (t < seconds) return;
        this.done = true;
        fn();
      },
    });
  }

  /** Where `source`'s next missile leaves: the next of `cycle`'s attachments in turn (its own count), or ahead of its middle. */
  launchPoint(source: Entity, cycle: string[] | undefined): THREE.Vector3 {
    const out = new THREE.Vector3();
    if (cycle?.length) {
      const i = this.cycles.get(source) ?? 0;
      this.cycles.set(source, i + 1);
      if (source.visual.attachment(cycle[i % cycle.length], out)) return out;
    }
    if (this.outlet(source, out)) return out;
    return source.center(out).addScaledVector(source.forward(v2), source.radius);
  }

  /**
   * Where a shot leaves one of the game's own models: its weapon attachments, the next of them in turn (a
   * launcher's tubes, a pair of launchers left and right), or for a building with several (a Bunker's slits) the
   * one facing `toward`. Null for StarCraft II's models, which keep the game's older rule (their attachments
   * don't all mark where a shot leaves), and for a model with none. `advance` false: the one the last shot left
   * from (what follows a muzzle frame by frame, a launch flash, mustn't move the turn on).
   */
  outlet(source: Entity, out: THREE.Vector3, toward?: THREE.Vector3, advance = true): THREE.Vector3 | null {
    const template = source.visual.template;
    if (!template.path.startsWith('glb:')) return null;
    let outlets = this.outlets.get(template);
    if (!outlets) {
      outlets = weaponOutlets(template);
      this.outlets.set(template, outlets);
    }
    const names = toward ? outlets.all : outlets.turn;
    if (!names.length) return null;
    if (toward && names.length > 1) {
      const dx = toward.x - source.position.x;
      const dz = toward.z - source.position.z;
      let best = -Infinity;
      let pick = names[0];
      for (const n of names) {
        if (!source.visual.attachment(n, v3)) continue;
        const ox = v3.x - source.position.x;
        const oz = v3.z - source.position.z;
        const facing = (ox * dx + oz * dz) / (Math.hypot(ox, oz) * Math.hypot(dx, dz) || 1);
        if (facing > best) [best, pick] = [facing, n];
      }
      return source.visual.attachment(pick, out);
    }
    const next = this.cycles.get(source) ?? 0;
    if (advance) this.cycles.set(source, next + 1);
    const i = advance ? next : Math.max(0, next - 1);
    return source.visual.attachment(names[i % names.length], out);
  }

  /** Where a shot leaves as it's fired: as `muzzle`, but taking the next of a model's weapon outlets in turn. */
  private fireFrom(u: Entity, out: THREE.Vector3): THREE.Vector3 {
    if (u.visual.attachment('Ref_Weapon', out) || this.outlet(u, out)) return out;
    return this.muzzle(u, out);
  }

  /**
   * A weapon landing at `at` (fired from `from`), with its own impact model and the reaction of
   * what it struck: blood from flesh, sparks off plate. False if the weapon has no impact model.
   */
  impact(source: Entity, at: THREE.Vector3, target: Entity | null, from: THREE.Vector3, weapon?: Weapon | null): boolean {
    const fx = this.effectsOf(source, weapon);
    if (!fx?.impact) return false;
    const scale = this.effectScaleOf(source) * (fx.scale ?? 1);
    this.playEffect(fx.impact, at, from, scale);
    if (target && fleshy(target)) {
      if (fx.bleeds) this.playEffect('bloodImpact', at, from, scale);
    } else if (target) this.playEffect('metalImpact', at, from, scale);
    return true;
  }

  /**
   * A weapon's launch flash at the muzzle (at each of its guns, where it fires several at once),
   * aimed at `toward`, staying on the gun as the machine moves on.
   */
  launch(source: Entity, from: THREE.Vector3, toward: THREE.Vector3, weapon?: Weapon | null, only?: string) {
    const fx = this.effectsOf(source, weapon);
    if (!fx?.launch) return;
    const scale = source.isBuilding ? this.scaleOf(source.kind.def.model) : this.effectScaleOf(source);
    const on = (at: THREE.Vector3) => (source.alive ? at : null);
    let fired = false;
    // One barrel of the several, where a round leaves only that one (a Picket's, in turn).
    for (const name of only ? [only] : (fx.launchFrom ?? [])) {
      if (!source.visual.attachment(name, gun)) continue;
      this.playEffect(fx.launch, gun, toward, scale, source.isBuilding ? null : (out) => on(source.visual.attachment(name, out) ?? this.muzzle(source, out)));
      fired = true;
    }
    if (fired) return;
    // Where it came from relative to the muzzle: kept, so a launch off a wing stays on the wing.
    const off = from.clone().sub(this.muzzle(source, new THREE.Vector3()));
    this.playEffect(fx.launch, from, toward, scale, source.isBuilding ? null : (out) => on(this.muzzle(source, out).add(off)));
  }

  /** An attack reaches its damage point: melee strikes, missiles launch, rifles and cannons hit. */
  resolveAttack(attacker: Unit, target: Entity) {
    const w = attacker.attackWeapon ?? attacker.kind.weapon!;
    if (attacker.kind.def.suicide) {
      this.burst(attacker);
      attacker.die(null);
      return;
    }
    if (w.melee) {
      if (attacker.gap(target) > w.range + 1.5) return;
      target.hit(w.damage, attacker);
      // Cleave (the Tusker's Tusk Blades): a share of the blow to what's round the attacker,
      // in the arcs in front of it, as its search has it (centered on the attacker, extended by
      // each one's size), each one once, however many of the arcs it's in (the data stacks list
      // them twice over).
      const struck = new Set<Entity>([target]);
      const fwd = attacker.forward(v2);
      for (const s of w.splash) {
        for (const o of this.unitsNear(attacker.position.x, attacker.position.z, s.radius + 4)) {
          if (struck.has(o) || o.team === attacker.team || !canHit(w, o)) continue;
          const dx = o.position.x - attacker.position.x;
          const dz = o.position.z - attacker.position.z;
          const d = Math.hypot(dx, dz);
          if (d > s.radius + o.radius) continue;
          if (s.arc < 360 && d > 1e-3 && Math.acos(THREE.MathUtils.clamp((dx * fwd.x + dz * fwd.z) / d, -1, 1)) > THREE.MathUtils.degToRad(s.arc / 2)) continue;
          struck.add(o);
          o.hit(w.damage, attacker, s.fraction);
        }
      }
      if (!this.impact(attacker, target.center(v1), target, attacker.position, w)) this.effects.ichor(target.center(v1), attacker.forward(v2), 4, target.kind.def.hitColor);
      // A melee strike's own launch model plays on the striker.
      const fx = this.effectsOf(attacker, w);
      if (fx?.launch) this.playEffect(fx.launch, attacker.center(v1), target.position, this.effectScaleOf(attacker) * (fx.scale ?? 1));
      const cue = this.attackCue(attacker, w);
      const sounds = this.weaponSounds(attacker, w);
      if (cue) this.sfx.play(cue, { at: attacker.position });
      else if (sounds.attack) this.audio.play(sounds.attack, { at: attacker.position, volume: 0.6, limit: 6, pitch: 1, near: 8 });
      if (sounds.impact) this.audio.play(sounds.impact, { at: target.position, volume: 0.6, limit: 6, near: 8 });
      return;
    }
    const fx = this.effectsOf(attacker, w);
    if (w.missile && (fx?.burst?.length || fx?.launchCycle?.length)) {
      // Each missile from its own tube in turn, at its own moment (a Picket's two Seekers, a
      // Bulwark's four Lances): one at each target of a volley, or the attack's hits as missiles
      // of their own.
      const targets = [target, ...this.volley(attacker, target, w)];
      const hits = w.damage.hits ?? 1;
      const count = targets.length > 1 ? targets.length : Math.max(1, Math.min(hits, fx.burst?.length ?? hits));
      const damage = targets.length > 1 ? w.damage : { ...w.damage, hits: hits / count };
      for (let i = 0; i < count; i++) {
        const t = targets[i % targets.length];
        const go = () => {
          if (!attacker.alive || !t.targetable) return;
          this.launchMissile(attacker, this.launchPoint(attacker, fx.launchCycle), t, w, damage, []);
          if (i > 0) return;
          const cue = this.attackCue(attacker, w);
          const sample = this.weaponSounds(attacker, w).attack;
          if (cue) this.sfx.play(cue, { at: attacker.position });
          else if (sample) this.audio.play(sample, { at: attacker.position, volume: 0.7, limit: 6, pitch: 1, near: 10 });
        };
        const at = fx.burst?.length ? fx.burst[i % fx.burst.length] : 0;
        if (at > 0) this.after(at, go);
        else go();
      }
      return;
    }
    if (w.missile) {
      const from = this.outlet(attacker, new THREE.Vector3()) ?? attacker.center(new THREE.Vector3()).addScaledVector(attacker.forward(v2), attacker.radius);
      this.launchMissile(attacker, from, target, w, w.damage, []);
      // A volley's other missiles leave a little apart, for what's around the target.
      for (const t of this.volley(attacker, target, w)) {
        const off = new THREE.Vector3((Math.random() - 0.5) * attacker.radius, Math.random() * attacker.radius * 0.3, (Math.random() - 0.5) * attacker.radius);
        this.launchMissile(attacker, from.clone().add(off), t, w, w.damage, []);
      }
      const cue = this.attackCue(attacker, w);
      const sample = this.weaponSounds(attacker, w).attack;
      if (cue) this.sfx.play(cue, { at: attacker.position });
      else if (sample) this.audio.play(sample, { at: attacker.position, volume: 0.7, limit: 6, pitch: 1, near: 10 });
      return;
    }
    // Instant: coil rifles and the Anvil Shock Cannon. A flame burns on along its line, through
    // the target and out to its reach (a Torchrunner's).
    const rounds = fx?.rounds ?? 1;
    if (rounds > 1 && fx?.launchFrom?.length) {
      // A round from each barrel in turn, spread over the attack, each its share (a Picket's).
      const share: Weapon = { ...w, damage: shareOf(w.damage, rounds) };
      const gap = w.period / attacker.attackRate / rounds;
      for (let i = 0; i < rounds; i++) {
        const barrel = fx.launchFrom[i % fx.launchFrom.length];
        const fire = () => {
          if (!attacker.alive || !target.targetable) return;
          const from = attacker.visual.attachment(barrel, new THREE.Vector3()) ?? this.muzzle(attacker, new THREE.Vector3());
          this.shoot(attacker, from, target, share, i > 0, barrel);
        };
        if (i === 0) fire();
        else this.after(i * gap, fire);
      }
      return;
    }
    this.shoot(attacker, this.fireFrom(attacker, v1), target, w);
    for (const t of this.volley(attacker, target, w)) this.shoot(attacker, this.muzzle(attacker, v1), t, w, true);
    if (w.line) {
      const from = this.muzzle(attacker, new THREE.Vector3());
      const dir = new THREE.Vector3(target.position.x - from.x, 0, target.position.z - from.z).normalize();
      this.burnAlong(attacker, w, from, dir, w.range + attacker.radius + target.radius, target);
    }
  }

  /**
   * The cue an attack with `w` plays: an anti-air weapon's own where it has one (a Bulwark's
   * Lances), none where it has a sample of its own instead (a Picket's Seeker missiles), the
   * kind's otherwise.
   */
  private attackCue(source: Entity, w: Weapon | null | undefined): CueName | undefined {
    const def = source.kind.def;
    if (w && w === source.kind.antiAir && (def.airCues || def.airSounds)) return def.airCues?.attack;
    return def.cues?.attack;
  }

  /** The samples an attack with `w` makes, as the sound data assigns them: an anti-air weapon's own where it has them, the kind's otherwise. */
  private weaponSounds(source: Entity, w: Weapon | null | undefined): { attack?: SoundName; impact?: SoundName } {
    const def = source.kind.def;
    const air = w && w === source.kind.antiAir ? def.airSounds : undefined;
    return { attack: air?.attack ?? def.sounds?.attack, impact: air?.impact ?? def.sounds?.impact };
  }

  /**
   * A volley's other shots (`Weapon.volley`): the enemies nearest its target that the weapon can
   * hit, one each; where there aren't enough, the target again.
   */
  private volley(attacker: Entity, target: Entity, w: Weapon): Entity[] {
    const extra = (w.volley ?? 1) - 1;
    if (extra <= 0) return [];
    // Where the weapon names how many it spreads over (`Weapon.targets`), its shots take turns
    // among that many; otherwise each goes to an enemy of its own.
    const others = w.targets ? w.targets - 1 : extra;
    const spread = target.flying ? VOLLEY_SPREAD_AIR : VOLLEY_SPREAD;
    const near: Entity[] = [...this.unitsNear(target.position.x, target.position.z, spread)]
      .filter((e) => e !== target && e.alive && e.targetable && e.team !== attacker.team && canHit(w, e) && e.flying === target.flying)
      .sort((a, b) => a.position.distanceToSquared(target.position) - b.position.distanceToSquared(target.position))
      .slice(0, others);
    if (!w.targets) {
      while (near.length < extra) near.push(target);
      return near;
    }
    const round = [target, ...near];
    return Array.from({ length: extra }, (_, i) => round[(i + 1) % round.length]);
  }

  /**
   * A flame that burns along a line (`Weapon.line`: the Torchrunner's Wide Flamer): what's
   * on the ground within its width of the line from `from` along `dir`, out to `length`, takes the
   * weapon's blow (`struck`, what it was fired at, has had its own); and the fire pours along the
   * line for a moment, following the shooter. Returns what it burned.
   */
  burnAlong(source: Entity, w: Weapon, from: THREE.Vector3, dir: THREE.Vector3, length: number, struck: Entity | null = null): Entity[] {
    const width = w.line ?? 0;
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const mid = from.clone().addScaledVector(flat, length / 2);
    const burned: Entity[] = [];
    const burn = (e: Entity) => {
      if (e === source || e === struck || !e.alive || !e.targetable || e.team === source.team || e.flying || !canHit(w, e)) return;
      const ox = e.position.x - from.x;
      const oz = e.position.z - from.z;
      const along = ox * flat.x + oz * flat.z;
      if (along < -e.radius || along > length + e.radius) return;
      if (Math.abs(ox * flat.z - oz * flat.x) > width + e.radius) return;
      e.hit(w.damage, source, 1, from);
      burned.push(e);
    };
    for (const e of this.unitsNear(mid.x, mid.z, length / 2 + width + 6)) burn(e);
    for (const b of this.buildings) burn(b);
    this.flameBurst(source, flat, length);
    return burned;
  }

  /** A flamethrower's burst along `dir` for `length` meters, poured from the shooter's weapon as it moves (drawn near the camera only). */
  flameBurst(source: Entity, dir: THREE.Vector3, length: number) {
    if (!particles.near(source.position, 1)) return;
    const d = dir.clone();
    const at = new THREE.Vector3();
    const scale = Math.min(2.5, this.effectScaleOf(source) * 0.7);
    let t = 0;
    const fx = this.effects;
    const world = this;
    this.timed.push({
      done: false,
      update(dt: number) {
        t += dt;
        if (!source.alive || t > FLAME_BURST) {
          this.done = true;
          return;
        }
        fx.flameStream(world.muzzle(source, at), d, length, { scale, count: 14 });
      },
    });
  }

  /**
   * How likely an AI's rifle burst is to land on the player's own body. An RTS's shots never
   * miss; a shooter's enemies have to, or nothing would survive standing in the open.
   * Distance and the player's movement make them miss more (jolted sprinting most of all).
   */
  private playerHitChance(source: Entity, target: Entity): number {
    const d = Math.hypot(source.position.x - target.position.x, source.position.z - target.position.z);
    const v = target instanceof Unit ? Math.hypot(target.velocity.x, target.velocity.z) : 0;
    const moving = Math.min(1, v / 7);
    return THREE.MathUtils.clamp(0.88 - d / 110 - moving * 0.3, 0.22, 0.9);
  }

  /** Whether something solid (the ground, a building) stands between a shooter and the player. */
  private coverBetween(from: THREE.Vector3, target: Entity, source: Entity): THREE.Vector3 | null {
    const to = target.center(v3);
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 2) return null;
    dir.divideScalar(len);
    const hit = this.raycast(from, dir, len - target.radius - 0.3, (e) => e === source || e === target || !e.isBuilding);
    return hit ? hit.point : null;
  }

  /** An instant shot: a burst of tracers, or a shell bursting with splash. */
  shoot(source: Entity, from: THREE.Vector3, target: Entity, w: Weapon, quiet = false, barrel?: string) {
    const to = target.center(new THREE.Vector3());
    to.x += (Math.random() - 0.5) * target.radius;
    to.y += (Math.random() - 0.3) * target.height * 0.5;
    // A volley's other shots are heard in the first one's.
    const sounds = this.weaponSounds(source, w);
    const snd = quiet ? undefined : sounds.attack;
    const cue = quiet ? undefined : this.attackCue(source, w);
    if (target === this.player && !w.splash.length) {
      // Cover stops rounds; open ground lets some go wide, cracking past.
      const cover = this.coverBetween(from, target, source);
      const miss = !cover && Math.random() > this.playerHitChance(source, target);
      if (cover || miss) {
        const end = cover ?? to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.2) * 1.6, (Math.random() - 0.5) * 3)).sub(from).multiplyScalar(1.6).add(from);
        this.effects.bullet(from, end, 0xffe0a0, 0.04);
        this.effects.flash(from, 0.9, 0xffd890, 0.05);
        if (cue) this.sfx.play(cue, { at: from });
        else if (snd) this.audio.play(snd, { at: from, volume: 0.5, limit: 8, spacing: 0.03 });
        if (cover) {
          this.effects.sparks(cover, v2.subVectors(from, cover).normalize(), 4, 0xffd8a0);
          this.sfx.play('impact.cover', { at: cover });
        } else this.sfx.play('bullet.whiz', { at: target.center(v2) });
        return;
      }
    }
    if (w.splash.length) {
      // Its own launch model at the muzzle where it has one (a stock flash and smoke where not),
      // and its own impact where it lands.
      if (!this.effectsOf(source, w)?.launch) {
        this.effects.flash(from, 5, 0xffd090, 0.1, 60);
        this.effects.smoke(from, 2, 0x8a8070, 1.5);
      }
      this.launch(source, from, to, w, barrel);
      this.explode(to, w, source, false, sounds.impact, { from });
      if (cue) this.sfx.play(cue, { at: from });
      else if (snd) this.audio.play(snd, { at: from, volume: 1, near: 25, limit: 4 });
      return;
    }
    this.effects.bullet(from, to, 0xffe0a0, 0.04);
    this.effects.flash(from, 0.9, 0xffd890, 0.05);
    this.launch(source, from, to, w, barrel);
    target.hit(w.damage, source);
    if (!this.impact(source, to, target, from, w)) this.effects.ichor(to, v3.subVectors(from, to).normalize(), 3, target.kind.def.hitColor);
    if (cue) this.sfx.play(cue, { at: from });
    else if (snd) this.audio.play(snd, { at: from, volume: 0.5, limit: 8, spacing: 0.03 });
    if (sounds.impact) this.audio.play(sounds.impact, { at: to, volume: 0.6, limit: 6, spacing: 0.03 });
    else if (source.kind.def.effects?.impact === 'trooperImpact') this.sfx.play('impact.burst', { at: to });
    else if (Math.random() < 0.35) this.sfx.play(fleshy(target) ? 'hit.flesh' : 'hit.metal', { at: to, volume: 0.8 });
  }

  /**
   * A weapon's splash going off at `at`: damage in rings, each ring dealing its fraction (Anvil
   * Shock Cannon: 100/50/25%), and how it looks and sounds. It looks like the weapon's own impact
   * model (fired `from`; `drawn` where the caller has played it already), and a stock burst only
   * where the weapon has none. With `friendlyFire`, the source's own side is caught too, as by a
   * braced tank's shells.
   */
  explode(at: THREE.Vector3, w: Weapon, source: Entity, friendlyFire = false, sound?: SoundName, opts: { from?: THREE.Vector3; drawn?: boolean; struck?: Entity | null } = {}): { hit: Entity[]; killed: Entity[] } {
    const outer = w.splash.reduce((a, r) => Math.max(a, r.radius), 1);
    const { hit, killed } = this.splash(at, w, w.damage, source, opts.struck ?? null, friendlyFire);
    if (!opts.drawn && !this.impact(source, at, null, opts.from ?? source.position, w)) this.effects.explosion(at, outer * 0.5);
    else this.effects.light(v1.copy(at).setY(at.y + outer * 0.3), 0xffb060, 30 * outer, 0.18);
    this.effects.stain(at, outer * 1.1, 0x1a140f, 0.8, 45);
    // The weapon's own impact (a braced tank's shell landing) where it has one; a stock
    // shell burst otherwise.
    if (sound) this.audio.play(sound, { at, volume: 1.1, near: 25, limit: 6, delay: true, reverb: 0.45 });
    else this.sfx.play('explosion.shell', { at });
    return { hit, killed };
  }

  /**
   * A weapon's splash at `at`, in rings each dealing its fraction of `damage` (the Anvil Shock
   * Cannon: 100/50/25%), to what the weapon can hit (flyers for a missile at flyers). `struck`
   * has already taken the blow. With `friendlyFire`, the source's own side is caught too, as by
   * a braced tank's shells.
   */
  splash(at: THREE.Vector3, w: Weapon, damage: DamageStats, source: Entity, struck: Entity | null = null, friendlyFire = false): { hit: Entity[]; killed: Entity[] } {
    const rings = [...w.splash].sort((a, b) => a.radius - b.radius);
    const hitSet = new Set<Entity>();
    const killed: Entity[] = [];
    for (const ring of rings) {
      for (const u of this.unitsNear(at.x, at.z, ring.radius)) {
        if (u === source || u === struck || hitSet.has(u) || (!friendlyFire && u.team === source.team) || !canHit(w, u)) continue;
        if (u.flying && Math.abs(u.center(v3).y - at.y) > ring.radius + u.radius) continue;
        hitSet.add(u);
        u.hit(damage, source, ring.fraction, at);
        if (!u.alive) killed.push(u);
      }
      // The enemy's buildings too, where the weapon can hit them, by how near the blast is to
      // their walls (a search reaches by the size of what it finds): a braced tank's shells and
      // a Behemoth's cannons did nothing to a building they were fired at. Never one's own, even
      // where the splash catches one's own soldiers: a braced shell into the swarm at a bunker
      // line would wreck the bunkers.
      for (const b of this.standing) {
        if (b === struck || hitSet.has(b) || !b.alive || b.team === source.team || !canHit(w, b)) continue;
        if (Math.hypot(b.position.x - at.x, b.position.z - at.z) - b.radius > ring.radius) continue;
        hitSet.add(b);
        b.hit(damage, source, ring.fraction, at);
        if (!b.alive) killed.push(b);
      }
    }
    return { hit: [...hitSet], killed };
  }

  /**
   * The player's free fire with a machine, as a shooter's guns fire: `weapon` from `from` at
   * where the crosshair is (`to`), as far as it reaches, and whatever the shot meets on its way
   * takes it (a weapon that can't hit flyers passes under them). An instant one lands at once; a
   * missile flies to where it was sent and hits what was there if it still is. Splash where the
   * weapon has it. What it hit, if anything.
   */
  fireAlong(source: Unit, weapon: Weapon, from: THREE.Vector3, to: THREE.Vector3, reach: number, opts: { barrel?: string; quiet?: boolean } = {}): Entity | null {
    const dir = new THREE.Vector3().subVectors(to, from);
    const d = dir.length();
    if (d < 1e-3) return null;
    dir.divideScalar(d);
    const max = Math.min(d + 1, reach);
    const hit = this.raycast(from, dir, max, (e) => e === source || (e.team === source.team && !e.isBuilding) || !canHit(weapon, e));
    const end = hit ? hit.point.clone() : from.clone().addScaledVector(dir, max);
    const struck = hit?.entity && hit.entity.team !== source.team && hit.entity.targetable ? hit.entity : null;
    if (weapon.missile) {
      this.shootAt(source, weapon, from, end, struck, false, opts);
      return struck;
    }
    // Instant: the round is there as it's fired. A flame burns on along its line, out to its reach.
    this.shootAt(source, weapon, from, end, struck, !hit, opts);
    if (weapon.line) this.burnAlong(source, weapon, from, dir, reach, struck);
    return struck;
  }

  /**
   * A weapon fired at a spot rather than at an enemy (the player's free fire), drawn as the game
   * draws that weapon: its launch model at the muzzle, its missile's own model in flight (where
   * it has one; an instant round shows nothing between), and its impact model, sound and splash
   * where it lands. `aimed`: what the shot was fired at, which takes it if it's still where the
   * shot lands; otherwise only the splash does damage. `spent`: an instant round that met nothing
   * in its reach (it lands nowhere).
   */
  shootAt(source: Entity, weapon: Weapon, from: THREE.Vector3, to: THREE.Vector3, aimed: Entity | null = null, spent = false, opts: { barrel?: string; quiet?: boolean } = {}) {
    const def = source.kind.def;
    const fx = this.effectsOf(source, weapon);
    this.launch(source, from, to, weapon, opts.barrel);
    const land = () => {
      if (spent) return;
      const c = aimed?.targetable ? aimed.center(v3) : null;
      const struck = aimed && c && Math.hypot(c.x - to.x, c.z - to.z) < aimed.radius + 1.5 && Math.abs(c.y - to.y) < aimed.height + 2 ? aimed : null;
      if (struck) struck.hit(weapon.damage, source);
      if (weapon.splash.length) this.explode(to, weapon, source, false, sounds.impact, { from, struck });
      else {
        if (!this.impact(source, to, struck, from, weapon)) {
          if (struck) this.effects.ichor(to, v2.subVectors(from, to).normalize(), 4, struck.kind.def.hitColor);
          else {
            this.effects.sparks(to, v2.subVectors(from, to).normalize(), 6);
            this.effects.smoke(to, 0.8, 0xb09070, 0.8);
          }
        }
        if (sounds.impact) this.audio.play(sounds.impact, { at: to, volume: 0.7, limit: 6 });
      }
    };
    const sounds = this.weaponSounds(source, weapon);
    // A round after the first is heard in the first's burst (a Picket's autocannons).
    const cue = opts.quiet ? undefined : this.attackCue(source, weapon);
    if (cue) this.sfx.play(cue, { at: from });
    else if (sounds.attack && !opts.quiet) this.audio.play(sounds.attack, { at: from, volume: 0.7, limit: 6 });
    if (!weapon.missile) return land();
    const speed = def.missileSpeed ?? weapon.flight?.speed ?? 60;
    const dir = new THREE.Vector3().subVectors(to, from);
    const total = dir.length() / speed;
    dir.normalize();
    const named = fx?.missile ? this.models[fx.missile] : undefined;
    const sized = this.missileScale(source, weapon);
    const model = named?.data.emitters.length ? this.fx.carry(named, from, dir.clone().multiplyScalar(speed), sized.trail) : null;
    const bodies = this.missileBodies;
    const mesh = named ? bodies.take(named, TEAM_COLOR[source.team], sized.body) : null;
    const color = def.missileColor ?? 0xffffff;
    const pos = from.clone();
    const velocity = dir.clone().multiplyScalar(speed);
    let flown = 0;
    const effects = this.effects;
    this.timed.push({
      done: false,
      update(dt: number) {
        if (this.done) return;
        flown = Math.min(total, flown + dt);
        pos.copy(from).addScaledVector(dir, flown * speed);
        model?.moveTo(pos, dir);
        if (mesh) bodies.place(mesh, pos, velocity, dt);
        // One with no model of its own glows as it goes, as the world's missiles do.
        if (!model && !mesh && Math.random() < 0.7) effects.flash(pos, 0.45, color, 0.12, 0, true);
        if (flown < total) return;
        this.done = true;
        model?.stop();
        if (mesh) bodies.give(mesh);
        land();
      },
    });
  }

  /** Where shots leave a unit: its weapon attachment, or chest height in front of it. */
  muzzle(u: Entity, out: THREE.Vector3): THREE.Vector3 {
    if (u.visual.attachment('Ref_Weapon', out)) return out;
    if (this.outlet(u, out, undefined, false)) return out;
    u.forward(out).multiplyScalar(u.radius * 1.2).add(u.position);
    out.y += u.height * 0.6;
    return out;
  }

  /** A missile from `source` at `target`: from its weapon attachment (a turret's launcher), carrying `damage`. */
  fireMissile(source: Entity, target: Entity, weapon: Weapon, damage = weapon.damage) {
    const from = this.fireFrom(source, new THREE.Vector3());
    this.launchMissile(source, from, target, weapon, damage, []);
  }

  /**
   * A missile, flying as the data's mover says (`weapon.flight`): guided missiles go straight in
   * at their speed and home, lobbed ones arc. Against the AI it lands, as an RTS's do. At
   * the player it's aimed, not guided: where they'll be if they keep going, give or take, and a
   * fast one that the shooter's aim sends wide goes past. Change direction, or be far off or in
   * cover, and it misses.
   */
  private launchMissile(source: Entity, from: THREE.Vector3, target: Entity, weapon: Weapon, damage: DamageStats, struck: Entity[]) {
    source.onLaunch?.(from);
    const def = source.kind.def;
    const fx = this.effectsOf(source, weapon);
    const color = new THREE.Color(def.missileColor ?? 0xffffff);
    // A missile model is carried for its emitters (the glow and the trail they leave), and its mesh
    // flies as its body (`missileBodies`); a glow stands in where it has neither.
    const named = fx?.missile ? this.models[fx.missile] : undefined;
    const template = named?.data.emitters.length ? named : undefined;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: template ? 0.6 : 1 }),
    );
    sprite.scale.setScalar((def.missileSize ?? 0.8) * (template ? 0.6 : 1));
    sprite.position.copy(from);
    this.scene.add(sprite);
    const speed = def.missileSpeed ?? weapon.flight?.speed ?? 40;
    let homing = def.missileHoming ?? 8;
    const aim = target.center(new THREE.Vector3());
    const atPlayer = target === this.player;
    let wide: THREE.Vector3 | null = null;
    if (atPlayer) {
      if (target instanceof Unit) aim.addScaledVector(target.velocity, (from.distanceTo(aim) / speed) * (0.45 + Math.random() * 0.5));
      homing = Math.min(homing, def.missileHoming ?? 0.5);
      // A fast missile is a rifle shot: the shooter's aim decides it, as it does a rifle's.
      if (speed > 90 && Math.random() > this.playerHitChance(source, target)) {
        wide = aim.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3.4, (Math.random() - 0.25) * 1.8, (Math.random() - 0.5) * 3.4));
        homing = 0;
      }
    }
    const goal = wide ?? aim;
    const velocity = goal.clone().sub(from).normalize().multiplyScalar(speed);
    let lob: Projectile['lob'] = null;
    if ((weapon.flight?.lob ?? def.missileLob) && !target.flying) {
      // Up and over a ground target. At a flyer it flies straight, homing (a Jackknife's torpedoes).
      const d = Math.hypot(goal.x - from.x, goal.z - from.z);
      const apex = 3 + d * 0.22;
      lob = { from: from.clone(), to: goal.clone(), t: 0, duration: Math.max(0.3, d / speed), apex };
    }
    const sized = this.missileScale(source, weapon);
    const model = template ? this.fx.carry(template, from, velocity, sized.trail) : null;
    const mesh = named && !def.fling ? this.missileBodies.take(named, TEAM_COLOR[source.team], sized.body) : null;
    if (mesh) {
      // Its body and its emitters are all its model shows: no glow besides.
      this.missileBodies.place(mesh, from, velocity, 0);
      sprite.visible = false;
    }
    let fling: Projectile['fling'] = null;
    let body: HeroVisual | null = null;
    if (def.fling && this.models[def.fling.model]) {
      // From the side whose turn it is, out and forward and up, then down onto the target.
      const side = (this.flingSide.get(source) ?? 1) * -1;
      this.flingSide.set(source, side);
      const f = def.fling;
      const s = source.scale;
      const yaw = source.yaw;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      // The model data's axes (x left, y back, z up) into the world's, turned to the facing.
      const toWorld = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x * cos - y * sin, z, -x * sin - y * cos);
      const start = toWorld(side * f.from[0] * s, f.from[1] * s, f.from[2] * s, new THREE.Vector3()).add(source.position);
      const out = toWorld(side * f.throw[0], f.throw[1], f.throw[2], new THREE.Vector3()).normalize();
      const d = start.distanceTo(goal);
      sprite.visible = false;
      sprite.position.copy(start);
      fling = {
        from: start,
        out: out.multiplyScalar(Math.max(4, d * 0.4)),
        to: goal.clone(),
        t: 0,
        duration: THREE.MathUtils.clamp(d / speed, 0.8, 2.2),
        wave: (Math.random() < 0.5 ? -1 : 1) * Math.min(1.5, d * 0.03),
        side: new THREE.Vector3(cos, 0, -sin),
      };
      body = this.flingBody(def.fling.model, source.team);
      body.play('Birth', { restart: true, fade: 0 });
      body.sync(start, yaw, this.scaleOf(def.fling.model));
      lob = null;
    }
    // The launch at the muzzle (a bounce's next leg leaves from the last target, not a muzzle).
    if (!struck.length) this.launch(source, fling?.from ?? from, goal, weapon);
    this.projectiles.push({ sprite, model, velocity, speed, target, source, weapon, damage, struck, life: 4, color, homing, atPlayer, aim: wide, lob, fling, body, mesh });
  }

  private air: AirHeight | null = null;
  /** The height flyers fly over (the map's air height), built for the ground the first time it's asked for. */
  get airHeight(): AirHeight {
    if (this.air?.ground !== this.terrain) this.air = new AirHeight(this.terrain);
    return this.air;
  }

  private bodies: MissileBodies | null = null;
  /** Missiles' own bodies in flight. */
  get missileBodies(): MissileBodies {
    return (this.bodies ??= new MissileBodies(this.scene));
  }

  /** Which side each flinger throws from next. */
  private flingSide = new WeakMap<Entity, number>();
  /** Flung creatures' models, waiting to be thrown again. */
  private flingPool = new Map<string, HeroVisual[]>();

  private flingBody(model: ModelName, team: Team): HeroVisual {
    const pool = this.flingPool.get(model) ?? [];
    this.flingPool.set(model, pool);
    const body = pool.pop() ?? new HeroVisual(this.models[model].instantiate(TEAM_COLOR[team]), this.scene);
    body.instance.object.visible = true;
    body.pitch = 0;
    return body;
  }

  private shelveBody(p: Projectile) {
    const body = p.body;
    if (!body) return;
    body.instance.object.visible = false;
    this.flingPool.get(p.source.kind.def.fling?.model ?? '')?.push(body);
  }

  /** A missile that hit nothing comes down where it was going: its impact, and anything it carries (a Mite still lands). */
  private missileMiss(p: Projectile, at: THREE.Vector3) {
    if (!this.impact(p.source, at, null, p.source.position, p.weapon)) this.effects.flash(at, 1.2, p.color.getHex(), 0.08);
    if (p.weapon.splash.length) this.splash(at, p.weapon, p.damage, p.source);
    const spawn = p.source.kind.impactSpawn;
    if (spawn && this.terrain.walkable(at.x, at.z)) {
      const b = this.spawnUnit(spawn.kind, at.x, at.z, Math.random() * Math.PI * 2, undefined, p.source.team);
      b.expires = this.time + spawn.life;
      this.events.spawned?.(b, p.source);
    }
  }

  /** A missile arrives: its damage, then whatever it carries on to (a bounce) or leaves behind (Mites). */
  private missileImpact(p: Projectile) {
    const at = p.sprite.position;
    if (p.target.targetable) {
      // Splash where its data has one (a Bulwark's Lances, 2 m), the target in its first ring.
      if (p.weapon.splash.length) {
        p.target.hit(p.damage, p.source);
        this.splash(at, p.weapon, p.damage, p.source, p.target);
      } else p.target.hit(p.damage, p.source);
      if (!this.impact(p.source, at, p.target, p.source.position, p.weapon)) this.effects.ichor(at, v3.set(0, 1, 0), 10, p.color.getHex(), 0.8);
      const imp = this.weaponSounds(p.source, p.weapon).impact;
      if (imp) this.audio.play(imp, { at, volume: 0.8, limit: 6 });
      const next = p.damage.bounce;
      if (next && p.source.alive) {
        const struck = [...p.struck, p.target];
        const t = this.nearestTarget(p.source, p.weapon.bounceRange, (e) => !struck.includes(e) && !e.isBuilding, p.target.position);
        if (t) this.launchMissile(p.source, at.clone(), t, p.weapon, next.damage, struck);
      }
    }
    const spawn = p.source.kind.impactSpawn;
    if (spawn) {
      // The Mite lands and goes for whatever is nearest, for a few seconds.
      const x = at.x + (Math.random() - 0.5) * 2;
      const z = at.z + (Math.random() - 0.5) * 2;
      if (this.terrain.walkable(x, z)) {
        const b = this.spawnUnit(spawn.kind, x, z, Math.random() * Math.PI * 2, undefined, p.source.team);
        b.expires = this.time + spawn.life;
        this.events.spawned?.(b, p.source);
      }
      this.effects.ichor(v3.set(x, this.terrain.heightAt(x, z) + 0.5, z), v2.set(0, 1, 0), 12, 0x9a7a1c, 1);
    }
  }

  /** Nearest thing a ray hits: units and buildings (as cylinders) or the ground. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignore?: Entity | ((e: Entity) => boolean)): RayHit | null {
    let best: RayHit | null = null;
    const skip = typeof ignore === 'function' ? ignore : (e: Entity) => e === ignore;
    for (const e of this.entities) {
      if (!e.targetable || skip(e)) continue;
      const ox = origin.x - e.position.x;
      const oz = origin.z - e.position.z;
      const a = dir.x * dir.x + dir.z * dir.z;
      const b = 2 * (ox * dir.x + oz * dir.z);
      const c = ox * ox + oz * oz - e.radius * e.radius;
      if (c < 0) continue; // the ray starts inside it
      let t = -1;
      let normal: THREE.Vector3 | null = null;
      if (a > 1e-9) {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const t0 = (-b - Math.sqrt(disc)) / (2 * a);
          const y = origin.y + dir.y * t0;
          const bottom = e.position.y + e.base;
          if (t0 > 0 && y >= bottom && y <= bottom + e.height) {
            t = t0;
            normal = new THREE.Vector3(ox + dir.x * t0, 0, oz + dir.z * t0).normalize();
          }
        }
      }
      if (t < 0 && dir.y < 0) {
        const tc = (e.position.y + e.base + e.height - origin.y) / dir.y;
        const hx = ox + dir.x * tc;
        const hz = oz + dir.z * tc;
        if (tc > 0 && hx * hx + hz * hz <= e.radius * e.radius) {
          t = tc;
          normal = new THREE.Vector3(0, 1, 0);
        }
      }
      if (t > 0 && t <= maxDist && (!best || t < best.distance)) {
        best = { distance: t, point: origin.clone().addScaledVector(dir, t), normal: normal!, entity: e };
      }
    }
    const tg = this.terrain.raycast(origin, dir, best ? best.distance : maxDist);
    if (tg !== null && (!best || tg < best.distance)) {
      const p = origin.clone().addScaledVector(dir, tg);
      best = { distance: tg, point: p, normal: new THREE.Vector3(0, 1, 0), entity: null };
    }
    return best;
  }

  /** Takes something off the field without a death (a dropship leaving the battle, a site called off). */
  despawn(e: Entity) {
    if (!e.alive) return;
    e.alive = false;
    e.setController(null);
    e.visual.dispose();
    if (e.isBuilding) {
      this.standing = this.standing.filter((b) => b !== e);
      this.buildingsVersion++;
    }
  }

  /**
   * Paths from anywhere to a place (a building site, a rally point, home), around the cliffs and
   * the buildings standing. Kept for whoever else is sent near the same place, and made again
   * once a building has gone up or come down since (a couple of seconds apart at most: a field
   * takes a dozen milliseconds or so on a big map).
   */
  pathsTo(at: { x: number; z: number }, r: number): FlowField {
    const key = `${Math.round(at.x / 4)},${Math.round(at.z / 4)},${Math.round(r)}`;
    let entry = this.placePaths.get(key);
    if (!entry || (entry.version !== this.buildingsVersion && this.time - entry.made > PATHS_REFRESH)) {
      const field = entry?.field ?? new FlowField(this.terrain.size, this.terrain.pathCell);
      if (!entry) field.setTerrain((x, z) => this.terrain.walkable(x, z));
      field.compute([{ x: at.x, z: at.z, r }], this.standing.flatMap((b) => this.blockers(b)));
      entry = { field, version: this.buildingsVersion, made: this.time };
    }
    // Most recently asked for last; the oldest dropped past a handful.
    this.placePaths.delete(key);
    this.placePaths.set(key, entry);
    if (this.placePaths.size > PLACE_PATHS) this.placePaths.delete(this.placePaths.keys().next().value!);
    return entry.field;
  }

  /** The blocking radius a structure of `name` will have, as its Building works it out (for placing one before it exists). */
  structureRadius(name: KindName): number {
    const kind = this.kinds[name];
    const t = this.models[kind.def.model];
    if (!t) return 4;
    const size = t.bounds.getSize(v1).multiplyScalar(this.scaleOf(kind.def.model));
    return Math.max(size.x, size.z) * 0.36 * 1.25;
  }

  /**
   * Whether, with these circles blocked as well, every one of `from` still has a way to the goal
   * (a trial of the paths, for a wall about to go up). True with no goal or nowhere to check.
   */
  pathsOpenWith(extra: Blocker[], from: THREE.Vector3[]): boolean {
    const goal = this.goal;
    if (!goal || !from.length) return true;
    const trial = new FlowField(this.terrain.size, this.terrain.pathCell);
    trial.setTerrain((x, z) => this.terrain.walkable(x, z));
    trial.compute(
      [{ x: goal.position.x, z: goal.position.z, r: goal.radius + 6 }],
      [...this.standing.filter((b) => b !== goal).flatMap((b) => this.blockers(b)), ...extra],
    );
    return from.every((p) => Number.isFinite(trial.distance(p.x, p.z)));
  }

  entityDied(e: Entity, source: Entity | null) {
    for (const f of e.whenDead) f(source);
    if (e instanceof Unit && e.kind.burstOnDeath) this.burst(e);
    this.events.killed?.(e, source);
    e.setController(null);
    e.visual.dispose();
    // How the blow killed it (flames burn, acid dissolves): its own death model and sound for
    // that, where it has them. A sniper's quiet kill makes only its own sound.
    const variant = e.kind.def.deaths?.[e.deathType];
    const typed = variant?.sound ? DEATH_CUES[e.deathType] : undefined;
    const cue = e.kind.def.cues?.death;
    const snd = e.kind.def.sounds?.death;
    if (e.deathType !== 'Silentkill' || !typed) {
      if (cue) this.sfx.play(cue, { at: e.position });
      else if (snd) this.audio.play(snd, { at: e.position, volume: 0.9, limit: 5 });
    }
    if (typed) this.sfx.play(typed, { at: e.position });
    const options = variantModels(variant).filter((m) => this.models[m]);
    const deathModel = options.length ? options[Math.floor(Math.random() * options.length)] : e.kind.def.deathModel;
    if (e.isBuilding) {
      this.standing = this.standing.filter((b) => b !== e);
      this.buildingsVersion++;
      const wreck = deathModel && this.models[deathModel];
      if (wreck) {
        // The structure's own collapse (fire, smoke, flying plates), and the wreck it leaves.
        const visual = new HeroVisual(wreck.instantiate(TEAM_COLOR[e.team], true), this.scene);
        visual.play(deathClip(wreck, e.deathType), { loop: false });
        const plan = wreck.deathPlan(visual.variant);
        const corpse: Corpse = {
          visual,
          position: e.position.clone(),
          yaw: e.yaw,
          scale: this.scaleOf(deathModel),
          age: 0,
          life: WRECK_TIME,
          fade: CORPSE_FADE,
          clock: corpseClock(plan, WRECK_TIME),
          burns: plan.burn < plan.duration,
        };
        visual.sync(corpse.position, corpse.yaw, corpse.scale);
        this.corpses.push(corpse);
      } else this.effects.explosion(e.center(v1), e.radius * 0.6);
      this.effects.stain(e.position, e.radius * 2.6, 0x15100c, 0.9, 90);
      this.effects.shake += 0.6;
      this.updatePaths();
      return;
    }
    // Most death models carry their own effects (blood, guts, pools, smoke, debris);
    // the hand-made ones stand in where they don't.
    const own = deathModel && this.models[deathModel] ? this.models[deathModel].data.emitters : [];
    const mech = e.kind.def.hitColor === 0x555555;
    if (!own.length) {
      this.effects.ichor(e.center(v1), v2.set(0, 1, 0), 18, e.kind.def.hitColor, 1.4);
      // Crawl burst: chunks fly. Machines leave scorch.
      if (!mech) this.effects.gibs(e.center(v1), e.kind.def.hitColor ?? 0x7a8a22, Math.max(0.6, e.radius * 0.9), e.radius > 2 ? 22 : 9);
    }
    // A stain where it fell, unless the model pools its own blood on the ground.
    if (!own.some((em) => em.type === 5)) {
      const ground = v3.copy(e.position).setY(this.terrain.heightAt(e.position.x, e.position.z));
      this.effects.stain(ground, Math.max(1.6, e.radius * 3.2), mech ? 0x15100c : e.kind.def.hitColor ?? 0x6a5a20, mech ? 0.9 : 0.75, 40);
    }
    // Too many dying at once for the death model's crowd: the body goes without one.
    if (deathModel && this.models[deathModel] && !this.crowd(this.models[deathModel], e.team).full) {
      const visual = new CrowdVisual(this.crowd(this.models[deathModel], e.team));
      visual.play(deathClip(this.models[deathModel], e.deathType), { loop: false });
      const scale = this.scaleOf(deathModel);
      const plan = this.models[deathModel].deathPlan(visual.variant);
      const corpse: Corpse = {
        visual,
        // Where its body was drawn (a Vaulter's, up on its jets).
        position: e.position.clone().setY(e.position.y + (e instanceof Unit ? e.hover : 0)),
        yaw: e.yaw,
        scale,
        age: 0,
        life: this.corpseTime,
        fade: Math.min(this.corpseFade, this.corpseTime),
        clock: corpseClock(plan, this.corpseTime),
        burns: plan.burn < plan.duration,
      };
      // A flyer dies where it flew. Most of their death models play where they're put (a
      // Kite bursts, a Lantern deflates), a few drop part of the way themselves (a Sower
      // sags, a Bilewing sinks): the wreck falls the rest, carried on by its momentum.
      if (e instanceof Unit && e.flying) {
        const curve = this.deathDrop(deathModel, visual.variant);
        const carried = curve.total * scale;
        const above = corpse.position.y - this.terrain.heightAt(corpse.position.x, corpse.position.z);
        if (above > carried) corpse.fall = { velocity: new THREE.Vector3(e.velocity.x * 0.7, 0, e.velocity.z * 0.7), carried };
        else corpse.sag = { from: corpse.position.y, above, curve, scale };
      }
      visual.sync(corpse.position, corpse.yaw, corpse.scale);
      this.corpses.push(corpse);
    }
  }

  /**
   * How far a death clip drops the body (its bones, on average, from its first frame) over its
   * length, in model units; measured once per clip (`clip`, or the model's first death clip).
   */
  private deathDrop(name: ModelName, clip?: string): DropCurve {
    const t = this.models[name];
    const which = clip && t.clips.has(clip) ? clip : ([...t.clips.keys()].find((n) => /^death/i.test(n)) ?? [...t.clips.keys()][0]);
    const key = `${name}|${which}`;
    const known = this.drops.get(key);
    if (known) return known;
    const inst = t.instantiate(TEAM_COLOR.crawl);
    const action = which ? inst.play(which, { loop: false, restart: true }) : null;
    const length = action?.getClip().duration ?? 0;
    const height = (time: number) => {
      inst.mixer.setTime(time);
      inst.object.updateMatrixWorld(true);
      const bones = inst.mesh.skeleton.bones;
      let y = 0;
      for (const b of bones) y += b.getWorldPosition(v1).y;
      return y / Math.max(1, bones.length);
    };
    const curve: DropCurve = { times: [0], drops: [0], total: 0 };
    if (length > 0) {
      const start = height(0.01);
      for (let i = 1; i <= 24; i++) {
        const time = (length * 0.98 * i) / 24;
        curve.times.push(time);
        curve.drops.push(Math.max(0, start - height(time)));
      }
      curve.total = curve.drops[curve.drops.length - 1];
    }
    this.drops.set(key, curve);
    return curve;
  }

  update(dt: number) {
    this.time += dt;
    this.bakeQueued(1);
    this.grid.clear();
    for (const e of this.entities) {
      if (!(e instanceof Unit) || !e.targetable) continue;
      const key = this.cellKey(e.position.x, e.position.z);
      let cell = this.grid.get(key);
      if (!cell) this.grid.set(key, (cell = []));
      cell.push(e);
    }
    if (this.focus && (this.focus.until < this.time || !this.focus.target.targetable)) this.focus = null;

    for (const e of this.entities) {
      if (!e.alive) continue;
      if (e.stowed) {
        // Out of sight while stowed: in a bunker, aboard a vehicle, burrowed.
        if (e.visual.dissolve !== 1) {
          e.visual.dissolve = 1;
          e.visual.update(0);
        }
        continue;
      }
      if (e.visual.dissolve === 1) e.visual.dissolve = 0;
      e.update(dt);
    }
    for (let i = this.entities.length - 1; i >= 0; i--) if (!this.entities[i].alive) this.entities.splice(i, 1);
    for (let i = this.timed.length - 1; i >= 0; i--) {
      this.timed[i].update(dt);
      if (this.timed[i].done) this.timed.splice(i, 1);
    }

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const pos = p.sprite.position;
      const last = v3.copy(pos);
      const center = p.target.center(v1);
      if (p.fling) {
        // Flung: out along the throw, then curving down onto where the target is now (or where it
        // was, at the player), quickening as the guidance takes over.
        const f = p.fling;
        if (!p.atPlayer && p.target.targetable) f.to.copy(center);
        f.t = Math.min(f.duration, f.t + dt);
        const u = f.t / f.duration;
        const k = Math.pow(u, 1.35);
        const a = 1 - k;
        // A cubic from the side, through the throw, to above the target, to the target.
        pos.copy(f.from).multiplyScalar(a * a * a);
        pos.addScaledVector(v2.copy(f.from).add(f.out), 3 * a * a * k);
        pos.addScaledVector(v2.copy(f.to).setY(f.to.y + f.out.length() * 0.6), 3 * a * k * k);
        pos.addScaledVector(f.to, k * k * k);
        pos.addScaledVector(f.side, f.wave * Math.sin(u * Math.PI * 3) * (1 - u));
        p.velocity.subVectors(pos, last).divideScalar(Math.max(dt, 1e-4));
        const body = p.body;
        if (body) {
          if (f.t >= FLING_BIRTH && f.t - dt < FLING_BIRTH) body.play('Spell', { loop: true, restart: true, fade: 0.1 });
          const flat = Math.hypot(p.velocity.x, p.velocity.z);
          if (flat > 0.01) body.sync(pos, Math.atan2(p.velocity.x, p.velocity.z), body.instance.object.scale.x);
          else body.sync(pos, p.source.yaw, body.instance.object.scale.x);
          body.pitch = Math.atan2(-p.velocity.y, Math.max(flat, 0.01)) * 0.8;
          body.update(dt);
        }
      } else if (p.lob) {
        // Lobbed: up and over, landing where the target is now (or where it was, at the player).
        const l = p.lob;
        if (!p.atPlayer && p.target.targetable) l.to.copy(center);
        l.t = Math.min(l.duration, l.t + dt);
        const u = l.t / l.duration;
        pos.lerpVectors(l.from, l.to, u);
        pos.y += l.apex * 4 * u * (1 - u);
        p.velocity.subVectors(pos, last).divideScalar(Math.max(dt, 1e-4));
      } else {
        // Guided missiles home in, but turn at a finite rate; an aimed one flies on.
        if (p.homing > 0) {
          const want = v2.subVectors(p.aim ?? center, pos).normalize().multiplyScalar(p.speed);
          p.velocity.lerp(want, Math.min(1, dt * p.homing));
        }
        pos.addScaledVector(p.velocity, dt);
      }
      p.model?.moveTo(pos, p.velocity);
      if (p.mesh) this.missileBodies.place(p.mesh, pos, p.velocity, dt);
      // Fast ones without a body of their own streak, as a needle does; slow ones without a model
      // glow as they go.
      if (p.speed > 150 && !p.mesh) this.effects.tracer(last, pos, p.color.getHex(), 0.07, 0.05);
      else if (!p.model && !p.body && !p.mesh && Math.random() < 0.7) this.effects.flash(pos, 0.45, p.color.getHex(), 0.12, 0, true);
      // Arrived: at its target (guided, lobbed), through the player's body (aimed), or into the ground.
      const toTarget = pos.distanceTo(center);
      const reach = p.atPlayer ? p.target.radius + 0.55 : Math.max(1, p.target.radius);
      // Over the frame's whole path: a fast missile covers several meters a frame.
      const through = toTarget < reach + p.speed * dt && segmentDistance(last, pos, center) < reach;
      const landed = p.lob ? p.lob.t >= p.lob.duration : p.fling ? p.fling.t >= p.fling.duration : false;
      const ground = this.terrain.heightAt(pos.x, pos.z);
      let done = false;
      if (p.target.targetable && (p.lob || p.fling ? landed && toTarget < reach * 2.5 : through && !(p.atPlayer && p.aim))) {
        this.missileImpact(p);
        done = true;
      } else if (pos.y <= ground + 0.15 || landed) {
        this.missileMiss(p, pos.setY(Math.max(pos.y, ground + 0.1)));
        done = true;
      } else if (p.life <= 0 || (!p.atPlayer && !p.target.targetable)) done = true;
      if (done) {
        p.model?.stop();
        if (p.mesh) this.missileBodies.give(p.mesh);
        this.shelveBody(p);
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.age += dt;
      if (c.fall) {
        // A flyer's wreck coming down, drifting on what was left of its speed.
        const f = c.fall;
        f.velocity.y -= WRECK_GRAVITY * dt;
        f.velocity.x *= Math.exp(-dt * 0.8);
        f.velocity.z *= Math.exp(-dt * 0.8);
        c.position.addScaledVector(f.velocity, dt);
        const floor = this.terrain.heightAt(c.position.x, c.position.z) + f.carried;
        if (c.position.y <= floor) {
          c.position.y = floor;
          c.fall = undefined;
          const ground = v2.set(c.position.x, floor - f.carried, c.position.z);
          this.effects.smoke(ground, 1.2 * c.scale, 0x4a4038, 1.6);
        }
        c.visual.sync(c.position, c.yaw, c.scale);
      }
      if (c.sag) {
        // Held up as far as the death's own fall would take it under the ground, no further.
        const s = c.sag;
        c.position.y = s.from + Math.max(0, dropAt(s.curve, c.clock(c.age)) * s.scale - s.above);
        c.visual.sync(c.position, c.yaw, c.scale);
      }
      if (dt > 0) c.visual.setTimeScale(Math.max(0, (c.clock(c.age) - c.visual.time) / dt));
      // A body its death animation doesn't burn away settles into the sand and breaks up rather
      // than popping out (as deep however quick the fade); what a burn-away leaves breaks up quickly.
      const fade = c.burns ? Math.min(BURNT_FADE, c.fade) : c.fade;
      if (c.age > c.life - fade) {
        if (!c.burns) c.visual.sink += dt * 0.25 * c.scale * (CORPSE_FADE / c.fade);
        c.visual.dissolve = Math.min(1, (c.age - (c.life - fade)) / fade);
      }
      c.visual.update(dt);
      if (c.age > c.life) {
        c.visual.dispose();
        this.corpses.splice(i, 1);
      }
    }
    this.fx.update(dt);
    for (const crowd of this.crowds.values()) crowd.commit();
    this.effects.update(dt);
  }
}
