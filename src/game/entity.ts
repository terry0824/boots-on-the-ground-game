import * as THREE from 'three';
import { hitDamage, type DeathType } from './stats.ts';
import { canHit, type Kind, type Team, type Weapon } from './kinds.ts';
import type { Visual } from './visual.ts';
import type { World } from './world.ts';

export interface Controller {
  update(dt: number): void;
  /** Called when the controller is replaced (the player leaving a unit, for example). */
  release?(): void;
}

/**
 * A controller that takes the commander's orders as a place to fight from, keeping its own way
 * of fighting, instead of being replaced by a plain guard (The Tide's line soldiers).
 */
export interface Commandable {
  command(at: THREE.Vector3): void;
}

export function isCommandable(c: Controller | null): c is Controller & Commandable {
  return !!c && typeof (c as Partial<Commandable>).command === 'function';
}

const v3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
/** The most a machine leans with the ground (radians): steeper than this is a cliff's edge, not a slope. */
const MAX_LEAN = 0.45;
/** How fast its lean follows the ground (a share a second): it settles onto a slope rather than snapping. */
const LEAN_RATE = 8;
const hitDir = new THREE.Vector3();

export abstract class Entity {
  private static nextId = 1;
  readonly id = Entity.nextId++;
  readonly position = new THREE.Vector3();
  /** Radians; 0 faces +Z. */
  yaw = 0;
  hp: number;
  alive = true;
  /** Inside a bunker or vehicle: not drawn, not simulated, not targetable. */
  stowed = false;
  /** Left alone by AI targeting (a target on a firing range). */
  ignored = false;
  /** Life it can't be brought below (heroes who fight on wounded: Harlan). 0 for mortals. */
  minHp = 0;
  /** A name of its own (a squadmate, a hero), for the kill feed. */
  name: string | null = null;
  /**
   * The last enemy that drew blood from this unit or its own side close by, and when: an AI
   * answers fire from beyond its sight with this (see World.alarm).
   */
  alert: { by: Entity; at: number } | null = null;
  /** When this one last raised the alarm (it does so at most a couple of times a second). */
  alarmedAt = -Infinity;
  /** Personal Shroud: invisible to enemies' targeting. */
  shrouded = false;
  /**
   * A boost for a while (a Trooper's Super Jolt, a Swift's phantom run): until when (world time),
   * its attack and move rates (each the more of it and the unit's own), and the share of each
   * blow it still takes.
   */
  boost: { until: number; attack: number; move: number; taken: number } | null = null;
  /** The boost, while it lasts. */
  get boosted(): { until: number; attack: number; move: number; taken: number } | null {
    return this.boost && this.boost.until > this.world.time ? this.boost : null;
  }
  /** In the air on a jet pack (or changing height mid-transformation): its controller places it, not the ground. */
  airborne = false;
  /** Called when it dies, whatever killed it (a transport's cargo goes down with it). */
  readonly whenDead: ((source: Entity | null) => void)[] = [];
  /** Whose side it's on: the kind's own, unless spawned for another (Directorate Troopers). */
  team: Team;
  lastHurt = -Infinity;
  /** How the last blow it took kills (the damage effect's death type): its death model follows it. */
  deathType: DeathType = 'Normal';
  /** Hit and collision cylinder, meters. */
  radius = 1;
  height = 2;
  /** Where the cylinder starts above the unit's position: a flyer's body hangs around its origin. */
  base = 0;
  controller: Controller | null = null;
  /** Runs after the animation is sampled each frame, for procedural touches like aiming. */
  afterAnimate: (() => void) | null = null;
  /** Each missile it fires as it leaves, from where (a walker's torso kicks with its Lances: walkerrig.ts). */
  onLaunch: ((from: THREE.Vector3) => void) | null = null;
  abstract readonly isBuilding: boolean;

  constructor(
    readonly world: World,
    /** Mutable: transforming units (Braced Mode) switch kinds. */
    public kind: Kind,
    public visual: Visual,
    readonly scale: number,
  ) {
    this.hp = kind.maxHp;
    this.team = kind.def.team;
    const size = visual.template.bounds.getSize(v3).multiplyScalar(scale);
    this.height = size.y;
    this.radius = Math.max(size.x, size.z) * 0.36;
    if (kind.flying) this.base = visual.template.bounds.min.y * scale;
    else if (kind.hover) this.base = (kind.hover + visual.template.bounds.min.y) * scale;
  }

  /** In the air: only anti-air weapons reach it. */
  get flying(): boolean {
    return this.kind.flying > 0;
  }

  /**
   * Meters above the ground it flies at: the data's height in its own model's scale. The game's own models are
   * made at their full size (their scale about 1), so the data's height, set for StarCraft II's smaller models,
   * would leave a big flyer's underside in the ground (a Lantern's tendrils hang 14 m below it): one of those
   * flies with that height clear under its lowest point instead.
   */
  get altitude(): number {
    const height = this.kind.flying * this.scale;
    if (!this.visual.template.path.startsWith('glb:')) return height;
    return Math.max(height, height - this.base);
  }

  /** Meters above the ground a ground unit's model is drawn (see `Kind.hover`: a Vaulter on its jets). */
  get hover(): number {
    return this.kind.hover * this.scale;
  }

  get maxHp(): number {
    return this.kind.maxHp;
  }

  get targetable(): boolean {
    return this.alive && !this.stowed;
  }

  /** Its size again from the model it's drawn with (a transformation changed its shape). */
  refit(template = this.visual.template) {
    const size = template.bounds.getSize(v3).multiplyScalar(this.scale);
    this.height = size.y;
    this.radius = Math.max(size.x, size.z) * 0.36;
    this.base = this.kind.flying ? template.bounds.min.y * this.scale : this.kind.hover ? (this.kind.hover + template.bounds.min.y) * this.scale : 0;
  }

  /** Center of mass, for aiming. */
  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + this.base + this.height * 0.5);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /**
   * Applies a weapon's damage by the stats' rules: bonus by attribute, minus armor.
   * `spell` for abilities (the Keel Gun, a warhead, the artifact's Aurora), which some defenses treat
   * differently.
   */
  hit(damage: Parameters<typeof hitDamage>[0], source: Entity | null, fraction = 1, from?: THREE.Vector3, spell = false) {
    this.takeDamage(hitDamage(damage, this.kind.attributes, this.kind.armor, fraction), source, from, spell, damage.death);
  }

  /**
   * `from` is where the blow came from (an explosion's center), defaulting to the source;
   * null means no blow at all (a Jolt's life cost) and no flinch. `death` is how the blow
   * kills, if it does (see DeathType).
   */
  takeDamage(amount: number, source: Entity | null, from?: THREE.Vector3 | null, spell = false, death: DeathType = 'Normal') {
    if (!this.alive) return;
    this.deathType = death;
    // The shooter's scale: the player's body hits harder than the game's numbers, and what
    // reaches the player hits harder by difficulty (see PLAYER_DAMAGE in world.ts).
    const player = this.world.player;
    if (source && source === player && source.team !== this.team && !spell) amount *= this.world.playerDamageScale(source);
    // (A Jolt's cost, with no blow behind it, is the same at every difficulty.)
    if (this === player && from !== null && source?.team !== this.team) amount *= this.world.incomingDamage;
    // Whoever did it gets noticed, by this one and its side around it.
    if (source && source.team !== this.team && source.alive) this.world.alarm(this, source);
    // A boost that toughens it (Super Jolt).
    if (from !== null && this.boosted) amount *= this.boosted.taken;
    // Damage responses that blunt it (Calyx's force shield caps a weapon's hit at 6).
    for (const r of this.kind.damageResponses) {
      if (spell ? !r.spell : !r.weapon) continue;
      if (r.fatal && amount < this.hp) continue;
      if (r.chance < 1 && Math.random() >= r.chance) continue;
      if (!source || source.team !== this.team ? !r.enemy : !r.friendly) continue;
      if (amount >= r.minimum) amount = Math.max(0, Math.min(amount, r.clampMax) * r.fraction);
    }
    this.hp -= amount;
    this.lastHurt = this.world.time;
    if (!this.isBuilding && from !== null) {
      // Flinch away from the blow: a rifle round rocks a Hound, barely a Tusker.
      const o = from ?? source?.position;
      if (o) hitDir.set(this.position.x - o.x, 0, this.position.z - o.z);
      if (!o || hitDir.lengthSq() < 1e-6) hitDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      hitDir.normalize();
      this.visual.hit(hitDir, Math.min(1.6, amount / 8 / Math.max(0.5, this.radius)));
    } else if (from !== null) {
      // A building doesn't flinch; it flashes.
      this.visual.flash(Math.min(1.6, amount / 8 / Math.max(0.5, this.radius)));
    }
    this.world.events.damaged?.(this, amount, source);
    if (this.minHp > 0 && this.hp < this.minHp) this.hp = this.minHp;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(source);
    }
  }

  die(source: Entity | null) {
    this.alive = false;
    this.world.entityDied(this, source);
  }

  /** Replaces the controller, letting the old one clean up. */
  setController(c: Controller | null) {
    this.controller?.release?.();
    this.controller = c;
  }

  syncTransform() {
    const h = this.hover;
    this.visual.sync(h ? v3.copy(this.position).setY(this.position.y + h) : this.position, this.yaw, this.scale);
  }

  update(dt: number) {
    this.visual.update(dt);
    this.afterAnimate?.();
  }
}

/** A long structure's footprint is a row of circles once it's this many times longer than wide. */
const LONG_SHAPE = 1.6;
/** Their radius, as a share of its half-width: the solid core, not what sticks out of it. */
const SHAPE_CORE = 0.6;

/** A circle of ground a building blocks. */
export interface Blocker {
  x: number;
  z: number;
  r: number;
}

export class Building extends Entity {
  readonly isBuilding = true;
  private smokeTimer = 0;
  private circle: Blocker[] | null = null;
  private shape: Blocker[] | null = null;

  constructor(world: World, kind: Kind, visual: Visual, scale: number) {
    super(world, kind, visual, scale);
    // Buildings are boxy; their hit and blocking circle reaches a bit further than a unit's.
    this.radius *= 1.25;
    visual.play('Stand');
  }

  /** It was moved: the ground it blocks is laid again where it stands now (both shapes keep where they were laid). */
  moved() {
    this.circle = null;
    this.shape = null;
  }

  /** The ground it blocks as one circle (its hit circle). */
  blocking(): Blocker[] {
    return (this.circle ??= [{ x: this.position.x, z: this.position.z, r: this.radius }]);
  }

  /**
   * The ground it blocks, following its shape: one circle for most, but a row of narrower ones
   * down a long, thin structure (a rubble barricade), so the open ground either side of it stays
   * open. From the model's plan (its data is Z-up: its X and Y), its Y running along (sin yaw, cos yaw).
   */
  footprint(): Blocker[] {
    if (this.shape) return this.shape;
    const b = this.visual.template.data.bounds;
    const hx = Math.max(-b.min[0], b.max[0]) * this.scale;
    const hy = Math.max(-b.min[1], b.max[1]) * this.scale;
    const long = Math.max(hx, hy);
    const short = Math.min(hx, hy);
    if (long < short * LONG_SHAPE) return (this.shape = this.blocking());
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const [ax, az] = hy >= hx ? [s, c] : [c, -s];
    const r = short * SHAPE_CORE;
    const reach = long - r;
    const n = Math.ceil((2 * reach) / r) + 1;
    this.shape = [];
    for (let i = 0; i < n; i++) {
      const t = -reach + (2 * reach * i) / (n - 1);
      this.shape.push({ x: this.position.x + ax * t, z: this.position.z + az * t, r });
    }
    return this.shape;
  }

  update(dt: number) {
    this.controller?.update(dt);
    super.update(dt);
    const damaged = 1 - this.hp / this.maxHp;
    if (this.alive && damaged > 0.33) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.25 / damaged;
        v3.set((Math.random() - 0.5) * this.radius, this.height * (0.4 + Math.random() * 0.5), (Math.random() - 0.5) * this.radius).add(this.position);
        this.world.effects.smoke(v3, this.radius * 0.25, damaged > 0.66 ? 0x2a2420 : 0x5a5048, 3);
        if (damaged > 0.66 && Math.random() < 0.3) this.world.effects.flash(v3, this.radius * 0.3, 0xff7a30, 0.4);
      }
    }
  }
}

export class Unit extends Entity {
  readonly isBuilding = false;
  readonly velocity = new THREE.Vector3();
  /** Movement the controller wants this frame: world XZ direction, length 0..1. */
  readonly move = new THREE.Vector2();
  /** Facing the controller wants; null faces the direction of travel. */
  face: number | null = null;
  speedMul = 1;
  attackSpeedMul = 1;
  /** Seconds until the weapon is ready. */
  cooldown = 0;
  /** Seconds until the current attack's damage point, or -1. */
  private pendingHit = -1;
  private attackTarget: Entity | null = null;
  /** The weapon the attack under way is made with (an anti-air one at a flyer). */
  attackWeapon: Weapon | null = null;
  /** What the attack under way is aimed at (null between attacks). */
  get attacking(): Entity | null {
    return this.attackTarget;
  }
  /** Seconds the attack animation holds before walking or standing can take over. */
  private animLock = 0;
  /** The player's controllers animate their unit themselves. */
  customAnimation = false;
  /** Rooted in place (a braced tank). */
  immobile = false;
  /** Casters' energy (Medic, Seer). */
  energy: number;
  /** Stagger Rounds and the like: slowed until this world time. */
  slowUntil = -Infinity;
  slowFactor = 1;
  /** Timed life (a Mite's): dies at this world time. */
  expires = Infinity;
  /** Already burst (a Blister): its death doesn't burst it again. */
  burst = false;
  /**
   * Seconds this unit has been trying to move and getting nowhere (against a wall, a building,
   * a cliff, a crowd). Controllers use it to stop pushing and find another way.
   */
  blocked = 0;
  /**
   * Until when it's on its way somewhere the player sent it (world time): its own side moves
   * aside for it, as for the player's own body.
   */
  orderedUntil = 0;
  /**
   * A transformation under way (a Jackknife landing: systems/morph.ts). It runs whoever drives the
   * unit (the AI, the player, nobody), and the controller waits while it does.
   */
  morph: { update(dt: number): boolean } | null = null;

  constructor(world: World, kind: Kind, visual: Visual, scale: number) {
    super(world, kind, visual, scale);
    this.energy = kind.energy.start;
    visual.play('Stand');
  }

  get speed(): number {
    if (this.immobile) return 0;
    const slow = this.world.time < this.slowUntil ? this.slowFactor : 1;
    return this.kind.speed * Math.max(this.speedMul, this.boosted?.move ?? 0) * slow;
  }

  /** How fast it attacks: its own rate (a Jolt's), or a boost's where that's more. */
  get attackRate(): number {
    return Math.max(this.attackSpeedMul, this.boosted?.attack ?? 0);
  }

  /**
   * Slows the unit (Stagger Rounds) for `seconds`. Not a Massive one: the shells' slow excludes
   * them, so a Tusker or a Bulwark walks on.
   */
  slow(factor: number, seconds: number) {
    if (this.kind.attributes.includes('Massive')) return;
    this.slowFactor = Math.min(this.world.time < this.slowUntil ? this.slowFactor : 1, factor);
    this.slowUntil = Math.max(this.slowUntil, this.world.time + seconds);
  }

  /**
   * Playback rate of the Walk animation at `speed` m/s, the way the game sets it: speed over
   * the unit's walk animation speed, in this model's scale, so feet don't slide. An original
   * model's own stride (its template's walkSpeed) stands in for the unit's.
   */
  walkRate(speed: number): number {
    const own = this.visual.template.walkSpeed;
    if (own) return speed / (own * this.scale);
    const w = this.kind.walkAnim;
    return w > 0 ? speed / (w * this.scale) : speed / (this.kind.def.walkAnimSpeed ?? 4);
  }

  /**
   * Rolls its treads (where the model has them): `ahead` meters of forward travel, and a turn of
   * `turn` radians, which runs the treads opposite ways (a growing yaw is a turn to the left; the
   * left tread is on the model's +X).
   */
  rollTreads(ahead: number, turn: number) {
    const sideways = turn * this.radius * 0.6;
    this.visual.treadLeft += (ahead - sideways) / this.scale;
    this.visual.treadRight += (ahead + sideways) / this.scale;
  }

  /** Distance between edges, for range checks. */
  gap(other: Entity): number {
    return Math.hypot(other.position.x - this.position.x, other.position.z - this.position.z) - this.radius - other.radius;
  }

  /** The weapon it fights `target` with: its own, or its anti-air one at a flyer its own can't reach (a Bulwark's Lances). */
  weaponFor(target: Entity): Weapon | null {
    const w = this.kind.weapon;
    if (w && canHit(w, target)) return w;
    const aa = this.kind.antiAir;
    return aa && canHit(aa, target) ? aa : w;
  }

  inRange(target: Entity): boolean {
    const w = this.weaponFor(target);
    return !!w && this.gap(target) <= w.range;
  }

  /** Starts an attack on `target` if the weapon is ready; damage lands at the damage point. */
  attack(target: Entity): boolean {
    const w = this.weaponFor(target);
    if (!w || this.cooldown > 0 || this.pendingHit >= 0) return false;
    this.attackWeapon = w;
    this.attackTarget = target;
    this.pendingHit = w.damagePoint / this.attackRate;
    this.cooldown = w.period / this.attackRate;
    if (!this.customAnimation) this.playAttack(w);
    return true;
  }

  /**
   * The body's animation for an attack with `w` (its `KindEffects.anim`: "Attack", a Picket's
   * Seekers their "Spell", a Bulwark's Lances nothing), from where its recoil lands with the
   * shot, sped up to fit the attack. Held over the walk while it plays, unless not `hold` (a
   * machine the player drives walks on).
   */
  playAttack(w: Weapon, hold = true) {
    const fx = this.world.effectsOf(this, w);
    const anim = fx?.anim === undefined ? 'Attack' : fx.anim;
    if (!anim) return;
    const at = fx?.animAt ?? 0;
    const length = this.visual.play(anim, { restart: true, loop: false, fade: at > 0 ? 0 : 0.08 });
    if (length <= 0) return;
    if (at > 0) this.visual.resume(anim, Math.min(at, length), false);
    const left = Math.max(0.05, length - at);
    const rate = Math.max(1, left / Math.max(0.2, this.cooldown));
    this.visual.setTimeScale(rate);
    if (hold) this.animLock = Math.min(this.cooldown, left / rate);
  }

  update(dt: number) {
    if (this.world.time >= this.expires) {
      this.die(null);
      return;
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.pendingHit >= 0) {
      this.pendingHit -= dt;
      if (this.pendingHit < 0) {
        const t = this.attackTarget;
        if (t?.targetable) this.world.resolveAttack(this, t);
        this.attackTarget = null;
      }
    }
    if (this.kind.regen > 0 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + this.kind.regen * dt);
    if (this.kind.energy.max > 0) this.energy = Math.min(this.kind.energy.max, this.energy + this.kind.energy.regen * dt);

    if (!this.morph?.update(dt)) this.controller?.update(dt);
    const lastYaw = this.yaw;
    this.world.moveUnit(this, dt);
    // Treads (where the model has them) roll with the ground: forward travel, plus opposite
    // directions on each side when turning.
    const along = this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw);
    let turn = this.yaw - lastYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    this.rollTreads(along * dt, turn);
    // Wheels (where the model has them) turn with the distance driven, either way.
    this.visual.wheel += this.walkRate(along) * dt;

    if (!this.customAnimation) {
      this.animLock -= dt;
      const moving = Math.hypot(this.velocity.x, this.velocity.z);
      if (this.animLock <= 0) {
        // Backing up, the player's machine plays its walk backwards (a walker stepping back).
        const back = this === this.world.player && !this.flying && along < -0.5;
        if (moving > 0.6) this.visual.play('Walk', { timeScale: (back ? -1 : 1) * this.walkRate(moving) });
        else this.visual.play('Stand');
      }
    }
    if (this.kind.def.tilt && !this.flying) this.followGround(dt);
    else if (this.lean) {
      this.lean = null;
      this.visual.ground.identity();
    }
    this.syncTransform();
    super.update(dt);
  }

  /**
   * A tracked or wheeled machine on the ground under its footprint (see `KindDef.tilt`): the plane
   * through the ground ahead, behind and to either side of it, which it leans to (eased), and
   * how far that plane stands over the ground at its center, where it's drawn (a hollow under it
   * doesn't drop it in).
   */
  private lean: { normal: THREE.Vector3; lift: number } | null = null;

  private followGround(dt: number) {
    const t = this.world.terrain;
    const f = this.forward(new THREE.Vector3());
    const r = new THREE.Vector3(f.z, 0, -f.x);
    const L = this.radius * 0.75;
    const W = this.radius * 0.6;
    const p = this.position;
    const hF = t.heightAt(p.x + f.x * L, p.z + f.z * L);
    const hB = t.heightAt(p.x - f.x * L, p.z - f.z * L);
    const hR = t.heightAt(p.x + r.x * W, p.z + r.z * W);
    const hL = t.heightAt(p.x - r.x * W, p.z - r.z * W);
    const normal = UP.clone().addScaledVector(f, -(hF - hB) / (2 * L)).addScaledVector(r, -(hR - hL) / (2 * W)).normalize();
    // Past a cliff's edge the slope is the cliff's: lean no further.
    const angle = normal.angleTo(UP);
    if (angle > MAX_LEAN) normal.lerp(UP, 1 - MAX_LEAN / angle).normalize();
    const lift = Math.max(0, (hF + hB + hR + hL) / 4 - t.heightAt(p.x, p.z));
    if (!this.lean) this.lean = { normal, lift };
    else {
      const k = 1 - Math.exp(-dt * LEAN_RATE);
      this.lean.normal.lerp(normal, k).normalize();
      this.lean.lift += (lift - this.lean.lift) * k;
    }
    this.visual.ground.setFromUnitVectors(UP, this.lean.normal);
  }

  syncTransform() {
    if (!this.lean) return super.syncTransform();
    this.visual.sync(v3.copy(this.position).setY(this.position.y + this.lean.lift), this.yaw, this.scale);
  }
}
