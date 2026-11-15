import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import type { ModelTemplate } from '../engine/model.ts';
import { ARMS } from './armsview.ts';
import { shoulderCamera, type Avatar, type AvatarHud, type Crosshair, type HudBar, type PlayerStats } from './avatar.ts';
import { BunkerGuns, GuardBrain } from './brains.ts';
import { view, yawPitchPose, type CameraPose } from './camera.ts';
import { classForKind, type ClassDef } from './classes.ts';
import { FASTER, hitDamage, type DamageStats, type JoltStats } from './stats.ts';
import type { Building, Entity, Unit } from './entity.ts';
import { RANGE_METERS_PER_CELL } from './kinds.ts';
import { WarheadStrike } from './warhead.ts';
import type { HeroVisual } from './visual.ts';
import { WEAK_SPOT, canHit, fleshy, type World } from './world.ts';

const headAt = new THREE.Vector3();
const toHead = new THREE.Vector3();

const SENSITIVITY = 0.0022;
const MAX_RANGE = 420;
const MAX_DISTANCE = 14;
/**
 * One RK-4 attack is a burst of rounds filling most of the weapon period (the rifle's own
 * sound for it is a burst of about this length). The attack's damage, after armor, is shared
 * among the rounds, so a burst that all lands deals exactly the game's number, and missed
 * rounds are damage lost: the numbers stay pure and aim still matters.
 */
const BURST_ROUNDS = 6;
const BURST_GAP = 0.08;
/** How far the torso leans with the aim; the arms make up the rest. */
const AIM_BEND = 0.85;
const MAX_BEND = 0.9;
/** How long squadmates keep firing at what you shot. */
const FOCUS_SECONDS = 3;
/** A Breaker round is a heavy slug: it flies flat and fast, straight where you aimed it. */
const GRENADE_SPEED = 190;
/** The Burner's flame cone, half-angle. */
const FLAME_CONE = 0.42;
/**
 * How far the player's flamethrowers reach, meters: a shooter's flamethrower, well past the
 * Kiln's two cells in the game data (the Burners beside you burn at the data's range).
 */
const FLAME_REACH = 18;
/** From the eye, how far under the crosshair the flame runs (rise over run), so it doesn't fill the middle of the view. */
const FLAME_DROP = 0.05;
/** The Vaulter's jet pack: reach, flight time, recharge. */
const JUMP_REACH = 18;
const JUMP_TIME = 0.75;
const JUMP_COOLDOWN = 3;
/** Seconds between Warhead Strikes (the Seer Academy arms a new one). */
/** The blast's outer ring is 8 cells: stand clear of it. */
const MIN_WARHEAD_DISTANCE = 36;

/** The numbers the infantry classes read from the game data. */
export interface InfantryData {
  jolt: JoltStats;
  joltGrenadier: JoltStats;
  heal: { rate: number; energyPerLife: number; range: number };
  shroud: { cost: number; drain: number };
  warhead: { damage: DamageStats; delay: number };
  stagger: { factor: number; duration: number };
}

/**
 * Clips split at the torso, so the legs can walk while the upper body fires. Ready is the
 * weapon held level between shots (the model's Stand Ready, which a unit switches to on an
 * attack order), or Stand where the model has none.
 */
interface Layers {
  upper: Record<'Walk' | 'Stand' | 'Attack' | 'Ready', THREE.AnimationClip>;
  lower: Record<'Walk' | 'Stand', THREE.AnimationClip>;
  spineRoot: number;
  /** A weapon rigged as a bone of its own, outside the torso (the Seer's rifle). */
  weaponRoots: number[];
}

const layerCache = new WeakMap<ModelTemplate, Layers>();

/** The bone the upper body hangs from: named differently in every infantry model. */
function torsoBone(bones: { name: string }[]): number {
  for (const re of [/^BoneSpine01$/i, /^BoneSpineLow$/i, /^BoneBack01$/i, /^Bone Stomach$/i, /spine/i, /stomach/i, /chest/i]) {
    const i = bones.findIndex((b) => re.test(b.name));
    if (i >= 0) return i;
  }
  return -1;
}

function layersFor(t: ModelTemplate): Layers {
  let l = layerCache.get(t);
  if (l) return l;
  const bones = t.data.bones;
  const spineRoot = torsoBone(bones);
  const upper = new Set<number>();
  const under = (i: number, root: number) => {
    for (let p = i; p >= 0; p = bones[p].parent) if (p === root) return true;
    return false;
  };
  // The torso's subtree, plus a weapon rigged as a bone of its own (the Seer's rifle).
  const weaponRoots = bones.map((b, i) => (b.parent < 0 && /rifle|weapon|gun/i.test(b.name) ? i : -1)).filter((i) => i >= 0);
  bones.forEach((_, i) => {
    if ((spineRoot >= 0 && under(i, spineRoot)) || weaponRoots.some((r) => under(i, r))) upper.add(i);
  });
  const clipOf = (name: string) => t.variants(name)[0] ?? t.variants('Stand')[0] ?? [...t.clips.values()][0];
  const split = (name: string, keepUpper: boolean) => {
    const clip = clipOf(name);
    const tracks = clip.tracks.filter((tr) => upper.has(Number(/^b(\d+)\./.exec(tr.name)![1])) === keepUpper);
    return new THREE.AnimationClip(`${name}-${keepUpper ? 'upper' : 'lower'}`, clip.duration, tracks);
  };
  l = {
    upper: { Walk: split('Walk', true), Stand: split('Stand', true), Attack: split('Attack', true), Ready: split('Stand Ready', true) },
    lower: { Walk: split('Walk', false), Stand: split('Stand', false) },
    spineRoot,
    weaponRoots,
  };
  layerCache.set(t, l);
  return l;
}

interface Grenade {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  /** The bunker it was fired from, which it flies out through. */
  from: Building | null;
}

/**
 * The player on foot, as any of the infantry, with the game's numbers and nothing
 * extra: the Trooper's RK-4 and Jolt, the Grenadier's Breaker grenades, the Burner's
 * flamethrowers, the Medic's heal, the Vaulter's pistols and jet pack, the Seer's LR-6,
 * shroud and warhead. The edge is skill, plus leadership: the squad fires at whatever you shoot.
 */
export class TrooperAvatar implements Avatar {
  readonly kind = 'trooper';
  readonly cls: ClassDef;
  yaw = 0;
  pitch = 0;
  /** The mouse is busy elsewhere (marking a call-in): the trigger and the sights stay off. */
  holdFire = false;
  firstPerson = false;
  distance = 6.5;
  ads = 0;
  spread = 0;
  /** Recoil: view offset (radians) that each round adds and that springs back. */
  private kick = 0;
  private kickYaw = 0;
  joltLeft = 0;
  wantsCommand = false;
  /** Mouse movement this frame, for weapon sway. */
  turnX = 0;
  turnY = 0;
  /** The bunker we're fighting from, if any. */
  garrison: Building | null = null;
  /** Where the player stood when they climbed into the bunker. */
  private garrisonDoor = new THREE.Vector3();
  private joltCooldown = 0;
  private cooldown = 0;
  private burstLeft = 0;
  private burstTimer = 0;
  private burstRounds = BURST_ROUNDS;
  private lastShot = -10;
  private hero: HeroVisual;
  private layers: Layers;
  private upperAction: THREE.AnimationAction;
  private lowerAction: THREE.AnimationAction;
  private upperName = 'Stand';
  private lowerName = 'Stand';
  private grenades: Grenade[] = [];
  private flameLeft = 0;
  /** Which nozzle the flame pours from this frame. */
  private flameSide = false;
  private healing: Unit | null = null;
  private healCarry = 0;
  private healSound = 0;
  private jump: { from: THREE.Vector3; to: THREE.Vector3; t: number; peak: number } | null = null;
  private jumpCooldown = 0;
  /** The warhead this Seer is painting, while it falls. */
  warhead: WarheadStrike | null = null;
  /**
   * Sits between the hips and the spine and leans the upper body toward the aim. The bones
   * themselves stay entirely under the animation's control.
   */
  private aimPivot = new THREE.Object3D();
  /**
   * The same lean, about the same point, for a weapon rigged outside the torso (the Seer's
   * rifle hangs from the model's root): without it the rifle stays put as the arms lean.
   */
  private weaponPivot = new THREE.Group();
  /** The upper body holds its weapon ready (fighting; a Seer standing). */
  private ready = false;
  /** HUD and world hooks. */
  /** A hit landed; `mitigated` when armor took most of it. */
  /** A hit landed: `mitigated` when armor took most of it, `weakSpot` when it found a head. */
  onHit: ((e: Entity, killed: boolean, mitigated?: boolean, weakSpot?: boolean) => void) | null = null;
  onShot: (() => void) | null = null;
  onKeelGun: ((target: Entity | null, point: THREE.Vector3) => boolean) | null = null;
  onBoard: ((vehicle: Unit) => void) | null = null;
  /** Which of our ground vehicles E can board (the Howitzer always; others by the mission's rules), and its name. */
  canBoard: (u: Unit) => string | null = (u) => (u.kind.name === 'howitzer' || u.kind.name === 'howitzerMobile' ? 'Howitzer' : null);
  /** A transport overhead with room: E rides it (the hold's to say), and where it's going. */
  canRide: (u: Unit) => string | null = () => null;
  onRide: ((transport: Unit) => void) | null = null;
  /** Life restored to someone else (the Medic), for experience. */
  onHeal: ((amount: number) => void) | null = null;
  onWarhead: ((strike: WarheadStrike) => void) | null = null;
  onWarheadRefused: ((why: string) => void) | null = null;
  /** The ultimate (F): why it can't fire now (still charging), or null; its bar; and that it was spent, for `seconds` of strike. */
  canUltimate: (() => string | null) | null = null;
  onUltimateRefused: ((why: string) => void) | null = null;
  onUltimate: ((seconds: number) => void) | null = null;
  ultimateBar: ((busy?: { value: number; text: string } | null) => HudBar | null) | null = null;
  keelGunBar: (() => HudBar) | null = null;
  /**
   * Every class has its own ultimate on F, and the ship is a call-in of its own (on X): the
   * ultimate's bar and the ship's both show (The Tide: Unleashed).
   */
  ownUltimate = false;
  /** F as the class's own ultimate, cast toward `point` (where the crosshair is): false if it couldn't be. */
  onCast: ((point: THREE.Vector3) => boolean) | null = null;
  /** Where rounds leave the rifle in first person (the viewmodel's muzzle). */
  firstPersonMuzzle: ((out: THREE.Vector3) => THREE.Vector3) | null = null;

  constructor(
    readonly unit: Unit,
    private input: Input,
    private world: World,
    private camera: THREE.PerspectiveCamera,
    private data: InfantryData,
    readonly stats: PlayerStats,
  ) {
    this.cls = classForKind(unit.kind.name);
    unit.setController(null);
    unit.customAnimation = true;
    world.setHero(unit, true);
    this.hero = unit.visual as HeroVisual;
    this.yaw = unit.yaw;
    this.layers = layersFor(this.hero.template);
    if (this.layers.spineRoot >= 0) {
      const spine = this.hero.instance.mesh.skeleton.bones[this.layers.spineRoot];
      // At rest the pivot is an identity transform, so inserting it changes nothing until we aim.
      spine.parent!.add(this.aimPivot);
      this.aimPivot.add(spine);
      const weapons = this.layers.weaponRoots.map((i) => this.hero.instance.mesh.skeleton.bones[i]).filter((b) => !!b?.parent);
      if (weapons.length) {
        // A body taken again keeps its model: an earlier pivot gives way to this one.
        const old = weapons[0].parent!.userData.weaponPivot ? weapons[0].parent! : null;
        this.weaponPivot.matrixAutoUpdate = false;
        this.weaponPivot.userData.weaponPivot = true;
        (old?.parent ?? weapons[0].parent!).add(this.weaponPivot);
        for (const b of weapons) this.weaponPivot.add(b);
        old?.removeFromParent();
      }
    }
    const mixer = this.hero.instance.mixer;
    mixer.stopAllAction();
    this.upperAction = mixer.clipAction(this.layers.upper.Stand).play();
    this.lowerAction = mixer.clipAction(this.layers.lower.Stand).play();
    unit.afterAnimate = () => this.pose();
  }

  get entity(): Entity {
    return this.unit;
  }

  get position(): THREE.Vector3 {
    return this.unit.position;
  }

  get alive(): boolean {
    return this.unit.alive;
  }

  get weapon() {
    return this.unit.kind.weapon;
  }

  private get jolt(): JoltStats {
    return this.cls.id === 'grenadier' ? this.data.joltGrenadier : this.data.jolt;
  }

  /** The Trooper looks down the story-mode RK-4; the Burner and the Seer see their own arms (armsview.ts). */
  get canFirstPerson(): boolean {
    return this.cls.id === 'trooper' || this.cls.id in ARMS;
  }

  tick(dt: number) {
    const u = this.unit;
    const input = this.input;
    const { dx, dy, wheel } = input.consume();
    this.turnX = dx;
    this.turnY = dy;
    const zoom = this.cls.fire === 'rifle' ? 1 - this.ads * 0.75 : 1 - this.ads * 0.45;
    this.yaw -= dx * SENSITIVITY * zoom;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * SENSITIVITY * zoom, -1.25, 1.25);
    if (wheel > 0 && this.firstPerson) this.firstPerson = false;
    else if (wheel) {
      this.distance += wheel * 0.8;
      // Pull out past the shoulder camera's limit and rise into command.
      if (this.distance > MAX_DISTANCE + 0.5) this.wantsCommand = true;
      this.distance = THREE.MathUtils.clamp(this.distance, 2.6, MAX_DISTANCE);
    }
    if (input.hit('KeyV') && !this.garrison && this.canFirstPerson) this.firstPerson = !this.firstPerson;

    if (this.garrison && !this.garrison.alive) this.leaveBunker();
    if (input.hit('KeyF')) this.interact();

    // Movement relative to where the camera looks.
    const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const r = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    u.move.set(sin * f - cos * r, cos * f + sin * r);
    if (u.move.lengthSq() > 1) u.move.normalize();
    // In a bunker, or holding a warhead's laser on target, you stay put.
    if (this.garrison || (this.warhead && !this.warhead.done)) u.move.set(0, 0);

    this.abilities(dt);

    const aiming = input.mouse(2) && !this.holdFire;
    this.ads = THREE.MathUtils.damp(this.ads, aiming ? 1 : 0, 14, dt);
    const firing = input.mouse(0) && input.locked && !this.holdFire;
    const moving = u.move.lengthSq() > 0.01;
    this.spread = Math.max(this.baseSpread(moving), this.spread - dt * 0.09);
    this.kick *= Math.exp(-dt * 16);
    this.kickYaw *= Math.exp(-dt * 16);

    // Face the crosshair while fighting, otherwise the way we're running. A Seer stands with its
    // rifle raised to the sky: it holds it ready instead, and the first round waits for the pose.
    const fighting = firing || aiming || this.world.time - this.lastShot < 0.8 || this.firstPerson;
    this.ready = fighting || (this.cls.id === 'seer' && !moving);
    if (firing) this.snapReady();

    this.fire(firing, dt);
    this.updateGrenades(dt);
    this.updateJump(dt);

    u.face = fighting || !moving ? this.yaw : null;
    if (!fighting && moving) u.face = Math.atan2(u.move.x, u.move.y);

    this.animate(moving);
  }

  /**
   * Shift, E and Q, by class: the Jolt on Shift (the key most shooters run on), the shroud and
   * the jet pack on Shift or E; the ultimate on Q (the Keel Gun, the warhead, the body's own).
   */
  private abilities(dt: number) {
    const u = this.unit;
    const input = this.input;
    const shiftKey = input.hit('ShiftLeft') || input.hit('ShiftRight');
    const shift = shiftKey || input.hit('KeyE');
    this.joltCooldown = Math.max(0, this.joltCooldown - dt);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    if (this.cls.shift === 'jolt' && shiftKey && this.joltCooldown <= 0 && u.hp > this.jolt.lifeCost) {
      // Jolt: the data's duration, speed and attack-speed multipliers, and life cost.
      u.takeDamage(this.jolt.lifeCost, null, null);
      this.joltLeft = this.jolt.duration / FASTER;
      this.joltCooldown = this.jolt.cooldown / FASTER;
      this.world.audio.play('jolt', { volume: 0.9 });
      // A word from those whose voices the game has here (not a Burner's).
      if (this.cls.id === 'grenadier' || this.cls.id === 'trooper') this.world.audio.play(this.cls.id === 'grenadier' ? 'grenadierReady' : 'trooperYes', { volume: 0.8, limit: 1 });
    }
    this.joltLeft = Math.max(0, this.joltLeft - dt);
    u.speedMul = this.joltLeft > 0 ? this.jolt.moveSpeed : 1;
    u.attackSpeedMul = this.joltLeft > 0 ? this.jolt.attackSpeed : 1;

    if (this.cls.shift === 'shroud') {
      const c = this.data.shroud;
      if (shift) {
        if (u.shrouded) this.setShroud(false);
        else if (u.energy >= c.cost) {
          u.energy -= c.cost;
          this.setShroud(true);
        }
      }
      if (u.shrouded) {
        u.energy -= c.drain * FASTER * dt;
        if (u.energy <= 0) {
          u.energy = 0;
          this.setShroud(false);
        }
      }
    }
    // The jet pack on Space, the jump key (the class's E and Shift are its jet pack too).
    const leap = input.hit('Space') || shift;
    if (this.cls.shift === 'jump' && leap && this.jumpCooldown <= 0 && !this.jump && !this.garrison) this.startJump();

    if (input.hit('KeyQ') && this.ownUltimate && this.cls.id !== 'seer' && this.onCast) {
      // The class's own ultimate, toward where the crosshair is (or straight ahead, at the sky).
      const { origin, dir } = this.aimRay();
      const hit = this.world.raycast(origin, dir, 900, (e) => e === u || e.team === u.team);
      this.onCast(hit ? hit.point : origin.clone().addScaledVector(dir, 30));
    } else if (input.hit('KeyQ')) {
      const { origin, dir } = this.aimRay();
      const hit = this.world.raycast(origin, dir, 900, (e) => e === u || e.team === u.team);
      const why = hit ? (this.canUltimate?.() ?? null) : null;
      if (why) this.onUltimateRefused?.(why);
      else if (hit && this.cls.id === 'seer') this.callWarhead(hit.point);
      // A strike called on the ground beside an enemy locks onto it: the gunners can see what
      // you meant.
      else if (hit && this.onKeelGun) this.onKeelGun(hit.entity ?? this.nearestHostile(hit.point, 12), hit.point);
    }
  }

  private setShroud(on: boolean) {
    const u = this.unit;
    u.shrouded = on;
    this.world.audio.play(on ? 'shroudOn' : 'shroudOff', { volume: 0.8 });
    // A shimmer: the body goes nearly transparent.
    this.hero.instance.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const saved = m.userData.shroudSaved as { t: boolean; o: number; d: boolean } | undefined;
        if (on) {
          if (!saved) m.userData.shroudSaved = { t: m.transparent, o: m.opacity, d: m.depthWrite };
          m.transparent = true;
          m.opacity = 0.16;
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

  /** The Seer paints a target; the warhead falls while the laser holds. */
  private callWarhead(point: THREE.Vector3) {
    if (this.warhead && !this.warhead.done) return;
    const u = this.unit;
    const d = Math.hypot(point.x - u.position.x, point.z - u.position.z);
    // Outside the blast and inside the laser's reach.
    if (d > 200 || d < MIN_WARHEAD_DISTANCE) {
      this.world.audio.play('shroudOff', { volume: 0.5 });
      this.onWarheadRefused?.(d < MIN_WARHEAD_DISTANCE ? 'Too close: you would be inside the blast' : 'Out of range');
      return;
    }
    const n = this.data.warhead;
    this.warhead = new WarheadStrike(this.world, point.clone(), n.damage, n.delay / FASTER, u, u.position.clone());
    // The laser from the rifle as it shows: the one in the view in first person.
    this.warhead.origin = (out) => (this.firstPerson && this.firstPersonMuzzle ? this.firstPersonMuzzle(out) : this.world.muzzle(u, out));
    this.world.timed.push(this.warhead);
    this.onUltimate?.(this.warhead.delay + 2);
    this.onWarhead?.(this.warhead);
  }

  /** The Vaulter's jet pack: a leap to the farthest open ground ahead, cliffs no object. */
  private startJump() {
    const u = this.unit;
    const w = this.world;
    const dir = u.move.lengthSq() > 0.01 ? new THREE.Vector2(u.move.x, u.move.y).normalize() : new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
    let best: THREE.Vector3 | null = null;
    for (let d = JUMP_REACH; d >= 5; d -= 1.5) {
      const x = u.position.x + dir.x * d;
      const z = u.position.z + dir.y * d;
      if (!w.walkable(x, z)) continue;
      const y = w.terrain.heightAt(x, z);
      if (Math.abs(y - u.position.y) > 22) continue;
      best = new THREE.Vector3(x, y, z);
      break;
    }
    if (!best) return;
    this.jump = { from: u.position.clone(), to: best, t: 0, peak: Math.max(4, Math.abs(best.y - u.position.y) + 3.5) };
    u.airborne = true;
    this.jumpCooldown = JUMP_COOLDOWN;
    w.audio.play('jetLaunch', { at: u.position, volume: 0.9 });
  }

  private updateJump(dt: number) {
    const j = this.jump;
    if (!j) return;
    const u = this.unit;
    j.t = Math.min(1, j.t + dt / JUMP_TIME);
    u.position.lerpVectors(j.from, j.to, j.t);
    u.position.y = THREE.MathUtils.lerp(j.from.y, j.to.y, j.t) + Math.sin(Math.PI * j.t) * j.peak;
    u.velocity.set(0, 0, 0);
    this.world.effects.jet(u.center(new THREE.Vector3()));
    if (j.t >= 1) {
      this.jump = null;
      u.airborne = false;
      this.world.audio.play('jetLand', { at: u.position, volume: 0.8 });
      this.world.effects.smoke(u.position, 1.5, 0x9a8a72, 1.2);
    }
  }

  /** E: garrison a bunker or board a vehicle, whichever is closest; or leave the bunker. */
  private interact() {
    if (this.garrison) {
      this.leaveBunker();
      return;
    }
    const near = this.nearbyInteraction();
    if (!near) return;
    if (near.isBuilding) this.enterBunker(near as Building);
    else if (near.flying) this.onRide?.(near as Unit);
    else this.onBoard?.(near as Unit);
  }

  private nearestHostile(p: THREE.Vector3, r: number): Entity | null {
    let best: Entity | null = null;
    let bestD = r;
    for (const e of this.world.entities) {
      if (!e.targetable || e.team === this.unit.team) continue;
      const d = Math.hypot(e.position.x - p.x, e.position.z - p.z) - e.radius;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private nearbyInteraction(): Entity | null {
    const u = this.unit;
    let best: Entity | null = null;
    let bestD = 4;
    for (const e of this.world.entities) {
      if (!e.targetable || e.team !== u.team || e === u) continue;
      const bunker = e.isBuilding && e.kind.name === 'bunker' && (e.controller as BunkerGuns | null)?.hasRoom;
      const vehicle = !e.isBuilding && !e.flying && !!this.canBoard(e as Unit);
      // A transport hovering low enough overhead: within a few meters of right above.
      const ride = !e.isBuilding && e.flying && !!this.canRide(e as Unit);
      if (!bunker && !vehicle && !ride) continue;
      const d = Math.hypot(e.position.x - u.position.x, e.position.z - u.position.z) - (ride ? 6 : e.radius + u.radius);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private enterBunker(b: Building) {
    const guns = b.controller as BunkerGuns;
    if (!guns?.hasRoom) return;
    guns.occupants++;
    this.garrisonDoor.copy(this.unit.position);
    this.garrison = b;
    this.unit.stowed = true;
    this.firstPerson = false;
    this.world.audio.play('trooperYes', { volume: 0.8, limit: 1 });
  }

  private leaveBunker() {
    const b = this.garrison;
    if (!b) return;
    const guns = b.controller as BunkerGuns | null;
    if (guns) guns.occupants = Math.max(0, guns.occupants - 1);
    this.garrison = null;
    this.unit.stowed = false;
    // Out the way you came in; failing that, the nearest open ground around the bunker, toward
    // the base.
    const exit = this.exitPoint(b);
    this.unit.position.set(exit.x, this.world.terrain.heightAt(exit.x, exit.z), exit.z);
    this.unit.velocity.set(0, 0, 0);
  }

  /** Open, walkable ground beside a bunker to step out onto. */
  private exitPoint(b: Building): THREE.Vector3 {
    const w = this.world;
    const u = this.unit;
    const free = (x: number, z: number) => {
      if (!w.walkable(x, z) || !w.terrain.walkable(x, z)) return false;
      for (const o of w.buildings) if (Math.hypot(o.position.x - x, o.position.z - z) < o.radius + u.radius + 0.3) return false;
      return true;
    };
    const door = this.garrisonDoor;
    if (Math.hypot(door.x - b.position.x, door.z - b.position.z) < b.radius + 8 && free(door.x, door.z)) return door.clone();
    const toward = w.goal ? Math.atan2(w.goal.position.x - b.position.x, w.goal.position.z - b.position.z) : 0;
    for (const extra of [1.2, 2.5, 4, 6, 9]) {
      const r = b.radius + u.radius + extra;
      for (let i = 0; i < 16; i++) {
        // Alternate either side of the way to the base, nearest first.
        const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
        const a = toward + (step * Math.PI) / 8;
        const x = b.position.x + Math.sin(a) * r;
        const z = b.position.z + Math.cos(a) * r;
        if (free(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    return door.clone();
  }

  /**
   * Whether a round from `origin` along `dir` passes through `e`'s head: within a head's width of
   * its model's Ref_Head point. From behind or the side, the body is in the way less often than
   * you'd think; head-on, it's the shot that drops a Hound with one burst.
   */
  private weakSpot(e: Entity, origin: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (e.isBuilding || !e.visual.attachment('Ref_Head', headAt)) return false;
    toHead.subVectors(headAt, origin);
    const along = toHead.dot(dir);
    if (along <= 0) return false;
    return toHead.addScaledVector(dir, -along).length() < Math.max(0.2, e.height * 0.16);
  }

  private baseSpread(moving: boolean): number {
    if (this.cls.fire === 'rifle') return THREE.MathUtils.lerp(moving ? 0.03 : 0.012, moving ? 0.004 : 0.0003, this.ads);
    if (this.cls.fire === 'pistols') return THREE.MathUtils.lerp(moving ? 0.03 : 0.016, moving ? 0.012 : 0.006, this.ads);
    return THREE.MathUtils.lerp(moving ? 0.02 : 0.01, moving ? 0.007 : 0.002, this.ads);
  }

  /** Point and direction the crosshair looks along. */
  aimRay(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    return { origin: this.camera.getWorldPosition(new THREE.Vector3()), dir: this.camera.getWorldDirection(new THREE.Vector3()) };
  }

  /** The primary weapon, by class, held down on the left button. */
  private fire(firing: boolean, dt: number) {
    const u = this.unit;
    const w = this.weapon;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cls.fire === 'heal') {
      this.heal(firing, dt);
      return;
    }
    if (!w) return;
    // One attack per weapon period, exactly as the data times it. Every weapon fires from a
    // bunker's slit (Grenadiers and the campaign's Burners garrison too).
    if (firing && this.cooldown <= 0 && !this.jump) {
      this.cooldown = w.period / u.attackRate;
      switch (this.cls.fire) {
        case 'burst':
          this.burstRounds = BURST_ROUNDS;
          this.burstLeft = BURST_ROUNDS;
          this.burstTimer = 0;
          this.world.sfx.play('rifle.attack');
          break;
        case 'pistols':
          // Two pistols, one round each (the data's two damage periods).
          this.burstRounds = 2;
          this.burstLeft = 2;
          this.burstTimer = 0;
          this.world.audio.play('vaulterLaunch', { volume: 0.7, bus: 'weapons', pitch: 0.5 });
          break;
        case 'rifle':
          this.burstRounds = 1;
          this.burstLeft = 1;
          this.burstTimer = 0;
          this.world.audio.play('seerLaunch', { volume: 0.9, bus: 'weapons', pitch: 0.4 });
          break;
        case 'grenade':
          this.launchGrenade();
          break;
        case 'flame':
          this.flameAttack();
          break;
      }
    }
    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      const gap = this.cls.fire === 'pistols' ? 0.12 : BURST_GAP;
      while (this.burstLeft > 0 && this.burstTimer <= 0) {
        this.fireRound(1 / this.burstRounds, this.burstLeft % 2 === 0 ? 'Ref_Weapon Right' : 'Ref_Weapon Left');
        this.burstLeft--;
        this.burstTimer += gap / u.attackRate;
      }
    }
    // Flames keep pouring out for a moment after each attack, and all the while the trigger is
    // held (the burn lands once a weapon period, as the data has it; the fire doesn't stutter).
    if (this.cls.fire === 'flame' && firing && !this.jump && this.world.time - this.lastShot < w.period * 1.5) this.flameLeft = Math.max(this.flameLeft, 0.1);
    if (this.flameLeft > 0) {
      this.flameLeft -= dt;
      const muzzle = new THREE.Vector3();
      // From both nozzles in turn (the Kiln flamethrowers, one on each arm).
      this.flameSide = !this.flameSide;
      if (this.garrison) this.slit(this.aimFlat(), muzzle);
      else if (this.firstPerson && this.firstPersonMuzzle) this.firstPersonMuzzle(muzzle);
      else if (!u.visual.attachment(this.flameSide ? 'Ref_Weapon Right' : 'Ref_Weapon Left', muzzle)) this.world.muzzle(u, muzzle);
      // A stream out to the reach, the same from the eye and from behind the shoulder, and hotter
      // jolted. From the eye it starts a little out from the nozzle, smaller, and runs a little
      // under the crosshair, or it fills the middle of the view; from behind it billows wider as
      // it goes, or the Burner's own back hides it. Thin and evenly laid, so it reads as fire
      // and the enemy shows through it: thick, it stacked into a white glare round the nozzle.
      const dir = this.aimFlat();
      const hot = this.joltLeft > 0 ? 1.2 : 1;
      if (this.garrison) this.world.effects.flame(muzzle, dir, (w.range + 1) * 0.6);
      else if (this.firstPerson) {
        // From the nozzle to just under where the crosshair points (above the ground).
        const { origin, dir: ray } = this.aimRay();
        const at = origin.addScaledVector(ray, FLAME_REACH * 0.85);
        at.y = Math.max(at.y - FLAME_DROP * FLAME_REACH, this.world.terrain.heightAt(at.x, at.z) + 0.5);
        this.world.effects.flameStream(muzzle, at.sub(muzzle).normalize(), FLAME_REACH, { scale: 0.65 * hot, strength: 0.3 * hot, clear: 2, count: 12, even: true });
      } else {
        // From behind the shoulder, at the crosshair: from the nozzle to where it points.
        const { origin, dir: ray } = this.aimRay();
        const at = origin.addScaledVector(ray, origin.distanceTo(u.position) + FLAME_REACH * 0.85);
        const toward = at.sub(muzzle);
        toward.y = THREE.MathUtils.clamp(toward.y / Math.max(1e-3, toward.length()), -0.35, 0.35) * toward.length();
        this.world.effects.flameStream(muzzle, toward.normalize(), FLAME_REACH, { scale: 1.05 * hot, strength: 0.5 * hot, count: 18, even: true });
      }
    }
  }

  /** The aim direction, kept close to level (the flame and grenades go where you face). */
  private aimFlat(): THREE.Vector3 {
    const { dir } = this.aimRay();
    dir.y = THREE.MathUtils.clamp(dir.y, -0.35, 0.35);
    return dir.normalize();
  }

  /** One round of an attack, carrying `share` of its damage. */
  private fireRound(share: number, side: string) {
    const w = this.world;
    const u = this.unit;
    const weapon = this.weapon!;
    this.lastShot = w.time;
    const { origin, dir } = this.aimRay();
    const a = Math.random() * Math.PI * 2;
    const s = Math.random() * this.spread;
    const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.cos(a) * s).addScaledVector(up, Math.sin(a) * s).normalize();
    // Rounds pass between friendly troops; buildings and the enemy stop them (flyers only if
    // the weapon can shoot up: the Vaulter's pistols can't).
    const passThrough = (e: Entity) => e === u || e === this.garrison || (e.team === u.team && !e.isBuilding) || (e.team !== u.team && !canHit(weapon, e));
    const camHit = w.raycast(origin, dir, MAX_RANGE, passThrough);
    const aim = camHit ? camHit.point : origin.clone().addScaledVector(dir, MAX_RANGE);

    // The round flies from the weapon to that point.
    const muzzle = new THREE.Vector3();
    if (this.garrison) muzzle.copy(origin).addScaledVector(dir, 1.2);
    else if (this.firstPerson && this.firstPersonMuzzle) this.firstPersonMuzzle(muzzle);
    else if (this.cls.fire !== 'pistols' || !u.visual.attachment(side, muzzle)) w.muzzle(u, muzzle);
    const shot = aim.clone().sub(muzzle);
    const len = shot.length();
    shot.divideScalar(len);
    const hit = w.raycast(muzzle, shot, len + 0.5, passThrough);
    const end = hit ? hit.point : aim;

    const sniper = this.cls.fire === 'rifle';
    // No lines from the player's own rounds (the weapons' own effects have none): the flash at
    // the muzzle, the flame cards of the rifle's own atlas laid along the barrel with a flash of
    // light, and the round where it lands.
    if (!this.firstPerson && !this.garrison) {
      const pistol = this.cls.fire === 'pistols';
      w.effects.muzzleFlash(muzzle, shot, sniper ? 1.3 : pistol ? 0.5 : 0.85, { jet: pistol, light: sniper ? 9 : 6, life: sniper ? 0.07 : 0.05 });
      w.launch(u, muzzle, end);
    } else if (this.firstPerson) w.effects.light(muzzle.addScaledVector(shot, 1.5), 0xffc070, sniper ? 4 : 2.5, 0.05);
    this.onShot?.();

    this.stats.shots++;
    if (hit?.entity) {
      const e = hit.entity;
      if (e.team !== u.team) {
        const wasAlive = e.alive;
        // This round's share of the attack (armor applies once per attack, as in the game), and
        // more if it found the head.
        const dealt = hitDamage(weapon.damage, e.kind.attributes, e.kind.armor);
        const weak = this.weakSpot(e, muzzle, shot);
        e.takeDamage(dealt * share * (weak ? WEAK_SPOT : 1), u, undefined, false, weapon.damage.death);
        this.stats.hits++;
        this.onHit?.(e, wasAlive && !e.alive, dealt < weapon.damage.amount * (weapon.damage.hits ?? 1) * 0.7, weak);
        if (e.alive) w.focus = { target: e, until: w.time + FOCUS_SECONDS };
      }
      // The weapon's own impact and the reaction of what it hit (blood, sparks off plate).
      if (!w.impact(u, hit.point, e, muzzle)) {
        if (e.isBuilding) w.effects.sparks(hit.point, hit.normal, 5);
        else w.effects.ichor(hit.point, shot.clone().negate(), sniper ? 10 : 6, e.kind.def.hitColor);
      }
      w.sfx.play(fleshy(e) ? 'impact.flesh' : 'impact.metal', { at: hit.point });
    } else if (hit) {
      if (!w.impact(u, hit.point, null, muzzle)) {
        w.effects.sparks(hit.point, hit.normal, 3, 0xffd8a0);
        w.effects.smoke(hit.point, 0.35, 0xb09070, 0.8);
      }
      w.sfx.play('impact.ground', { at: hit.point });
    }
    if (this.cls.fire === 'burst') w.sfx.play('rifle.round');
    else w.sfx.play('rifle.round', { volume: sniper ? 1.2 : 0.8, rate: sniper ? 0.7 : 1.15 });
    // The score and the wind dip under your own gun.
    w.audio.duck(sniper ? 0.5 : 0.28, sniper ? 0.6 : 0.3);
    // Recoil: the view kicks up and a little sideways, then settles back.
    const kick = sniper ? 0.03 : this.cls.fire === 'pistols' ? 0.01 : 0.006;
    this.kick += kick * (1 - this.ads * 0.5);
    this.kickYaw += (Math.random() - 0.5) * kick * 0.8;

    this.spread = Math.min(0.05, this.spread + (sniper ? 0.02 : 0.0012));
    this.pitch = Math.min(1.25, this.pitch + 0.0005 * (1 - this.ads * 0.5));
    w.effects.shake = Math.max(w.effects.shake, sniper ? 0.08 : 0.03);
  }

  /**
   * Where a garrisoned soldier's fire leaves the bunker: its slit on the side facing `dir`,
   * at the height the bunker's own guns fire from.
   */
  private slit(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const b = this.garrison!;
    const flat = new THREE.Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-6) flat.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    out.copy(b.position).addScaledVector(flat.normalize(), b.radius * 0.95);
    out.y += b.height * 0.45;
    return out;
  }

  /** A Breaker grenade: fired from the launcher toward the crosshair. */
  private launchGrenade() {
    const u = this.unit;
    const w = this.world;
    this.lastShot = w.time;
    const { origin, dir } = this.aimRay();
    const weapon = this.weapon!;
    const hit = w.raycast(origin, dir, MAX_RANGE, (e) => e === u || e === this.garrison || (e.team === u.team && !e.isBuilding) || (e.team !== u.team && !canHit(weapon, e)));
    const aim = hit ? hit.point : origin.clone().addScaledVector(dir, 120);
    const side = Math.random() < 0.5 ? 'Ref_Weapon Right' : 'Ref_Weapon Left';
    const from = new THREE.Vector3();
    if (this.garrison) this.slit(dir, from);
    else if (this.firstPerson && this.firstPersonMuzzle) this.firstPersonMuzzle(from);
    else if (!u.visual.attachment(side, from)) w.muzzle(u, from);
    const vel = aim.clone().sub(from).normalize().multiplyScalar(GRENADE_SPEED);
    this.grenades.push({ pos: from, vel, life: 1.5, from: this.garrison });
    w.effects.flash(from, 0.9, 0xffb060, 0.05, 8);
    w.sfx.play('grenade.npc', { at: from, volume: 1.2 });
    this.onShot?.();
    this.stats.shots++;
    this.kick += 0.012;
    w.effects.shake = Math.max(w.effects.shake, 0.06);
  }

  private updateGrenades(dt: number) {
    const w = this.world;
    const u = this.unit;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.life -= dt;
      const next = g.pos.clone().addScaledVector(g.vel, dt);
      const step = next.clone().sub(g.pos);
      const len = step.length();
      const hit = w.raycast(g.pos, step.divideScalar(len), len + 0.2, (e) => e === u || e === g.from || (e.team === u.team && !e.isBuilding) || (e.team !== u.team && !canHit(this.weapon, e)));
      // A hot streak behind the slug, and a thin smoke trail.
      w.effects.tracer(g.pos, hit ? hit.point : next, 0xffc27a, 0.09, 0.05);
      if (Math.random() < 0.5) w.effects.smoke(g.pos, 0.25, 0x9a9088, 0.45);
      if (hit || g.life <= 0) {
        const at = hit ? hit.point : g.pos;
        this.grenades.splice(i, 1);
        w.effects.explosion(at, 0.9);
        w.sfx.play('grenade.impact', { at });
        const e = hit?.entity;
        if (e && e.team !== u.team) {
          const weapon = this.weapon!;
          const wasAlive = e.alive;
          const dealt = hitDamage(weapon.damage, e.kind.attributes, e.kind.armor);
          e.takeDamage(dealt, u, at, false, weapon.damage.death);
          this.stats.hits++;
          // Stagger Rounds.
          if (!e.isBuilding && e.alive) (e as Unit).slow(this.data.stagger.factor, this.data.stagger.duration / FASTER);
          this.onHit?.(e, wasAlive && !e.alive, false);
          if (e.alive) w.focus = { target: e, until: w.time + FOCUS_SECONDS };
        }
        continue;
      }
      g.pos.copy(next);
    }
  }

  /** The Burner's Kiln flamethrowers: everything in the cone in front of you burns. */
  private flameAttack() {
    const u = this.unit;
    const w = this.world;
    const weapon = this.weapon!;
    this.lastShot = w.time;
    this.flameLeft = 0.45;
    w.audio.play('burnerLaunch', { at: u.position, volume: 0.9, bus: 'weapons' });
    const dir = this.aimFlat();
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    // From a bunker the cone starts at the slit, a cell further out (a garrison's range bonus).
    const base = this.garrison ? this.slit(dir, new THREE.Vector3()) : u.position;
    const reach = this.garrison ? weapon.range + RANGE_METERS_PER_CELL + 1.5 : Math.max(FLAME_REACH, weapon.range + u.radius + 1.5);
    let any = false;
    for (const e of w.unitsNear(base.x, base.z, reach + 3)) {
      if (!e.targetable || e.team === u.team || !canHit(weapon, e)) continue;
      const to = new THREE.Vector3(e.position.x - base.x, 0, e.position.z - base.z);
      const d = to.length() - e.radius;
      if (d > reach) continue;
      if (to.normalize().dot(flat) < Math.cos(FLAME_CONE)) continue;
      const wasAlive = e.alive;
      e.hit(weapon.damage, u);
      any = true;
      this.onHit?.(e, wasAlive && !e.alive, false);
      if (e.alive) w.focus = { target: e, until: w.time + FOCUS_SECONDS };
    }
    for (const b of w.buildings) {
      if (b.team === u.team || b.ignored) continue;
      const to = new THREE.Vector3(b.position.x - base.x, 0, b.position.z - base.z);
      const d = to.length() - b.radius;
      if (d <= reach && to.normalize().dot(flat) > 0.3) {
        b.hit(weapon.damage, u);
        any = true;
      }
    }
    this.stats.shots++;
    if (any) this.stats.hits++;
    this.onShot?.();
  }

  /**
   * The Medic's heal: the ally under the crosshair while the button is held, otherwise the
   * most wounded within reach, as the game's autocast does. Life and energy at the data's rates.
   */
  private heal(holding: boolean, dt: number) {
    const u = this.unit;
    const w = this.world;
    const h = this.data.heal;
    const reach = h.range * RANGE_METERS_PER_CELL;
    const ok = (e: Entity | null | undefined): e is Unit =>
      !!e &&
      !e.isBuilding &&
      e !== u &&
      e.team === u.team &&
      e.targetable &&
      e.hp < e.maxHp &&
      e.kind.attributes.includes('Biological') &&
      Math.hypot(e.position.x - u.position.x, e.position.z - u.position.z) - e.radius < reach;
    let target: Unit | null = null;
    if (holding) {
      const { origin, dir } = this.aimRay();
      const hit = w.raycast(origin, dir, 60, (e) => e === u || e.team !== u.team || e.isBuilding);
      if (ok(hit?.entity)) target = hit!.entity as Unit;
    }
    if (!target) {
      let worst = 1;
      for (const e of w.unitsNear(u.position.x, u.position.z, reach + 2)) {
        if (!ok(e)) continue;
        const f = e.hp / e.maxHp;
        if (f < worst) {
          worst = f;
          target = e;
        }
      }
    }
    if (!target || u.energy <= 0) {
      this.healing = null;
      return;
    }
    if (target !== this.healing) w.audio.play('healStart', { at: u.position, volume: 0.6 });
    this.healing = target;
    const amount = Math.min(h.rate * FASTER * dt, target.maxHp - target.hp, u.energy / h.energyPerLife);
    target.hp += amount;
    u.energy -= amount * h.energyPerLife;
    this.healCarry += amount;
    if (this.healCarry >= 10) {
      this.onHeal?.(this.healCarry);
      this.healCarry = 0;
    }
    this.lastShot = w.time;
    const from = new THREE.Vector3();
    // From the gauntlet: in first person the arms' own, where the eye sees it.
    if (this.firstPerson && this.firstPersonMuzzle) this.firstPersonMuzzle(from);
    else if (!u.visual.attachment('Ref_Weapon', from)) w.muzzle(u, from);
    const to = target.center(new THREE.Vector3());
    w.effects.tracer(from, to, 0x9fffc0, 0.08, dt * 1.5 + 0.02);
    w.effects.flash(to, 0.8, 0x9fffc0, dt * 1.5 + 0.03);
    this.healSound -= dt;
    if (this.healSound <= 0) {
      this.healSound = 0.9;
      w.audio.play('healLoop', { at: u.position, volume: 0.35 });
    }
  }

  private animate(moving: boolean) {
    const u = this.unit;
    const speed = Math.hypot(u.velocity.x, u.velocity.z);
    const walkRate = u.walkRate(speed);
    // Walking backwards plays the cycle in reverse.
    const forward = Math.sin(u.yaw) * u.velocity.x + Math.cos(u.yaw) * u.velocity.z;
    const lower = (moving && speed > 0.6) || this.jump ? 'Walk' : 'Stand';
    this.lowerAction = this.swap(this.lowerAction, this.layers.lower[lower], lower !== this.lowerName);
    this.lowerName = lower;
    this.lowerAction.timeScale = lower === 'Walk' ? (forward < -0.5 ? -walkRate : walkRate) || 1 : 1;

    const firingNow = this.world.time - this.lastShot < 0.25;
    const upper = firingNow ? 'Attack' : this.ready ? 'Ready' : lower;
    this.upperAction = this.swap(this.upperAction, this.layers.upper[upper], upper !== this.upperName);
    this.upperName = upper;
    const period = this.weapon?.period ?? 1;
    this.upperAction.timeScale = upper === 'Attack' ? (this.upperAction.getClip().duration / period) * u.attackRate : upper === 'Ready' ? 1 : this.lowerAction.timeScale;
  }

  /**
   * The weapon up at once as the trigger's pulled, ahead of the round: it leaves the muzzle
   * where the firing pose holds it, not where the last pose had it (a Seer's idle rifle points
   * at the sky). The fade that would have brought it up is skipped.
   */
  private snapReady() {
    if (this.upperName === 'Ready' || this.upperName === 'Attack') return;
    const mixer = this.hero.instance.mixer;
    for (const clip of Object.values(this.layers.upper)) mixer.existingAction(clip)?.stop();
    this.upperAction = mixer.clipAction(this.layers.upper.Ready).reset().play();
    this.upperName = 'Ready';
    mixer.update(0);
    this.pose();
    this.hero.instance.object.updateMatrixWorld(true);
  }

  private swap(current: THREE.AnimationAction, clip: THREE.AnimationClip, changed: boolean): THREE.AnimationAction {
    if (!changed) return current;
    const next = this.hero.instance.mixer.clipAction(clip);
    next.reset().play();
    next.crossFadeFrom(current, 0.15, false);
    return next;
  }

  /**
   * After sampling the animation: lean the upper body toward the aim, about the hips.
   *
   * The lean is set from scratch every frame on our own pivot rather than added onto the
   * animated spine bones. Three.js's mixer only rewrites a bone when its animated value
   * changes, so anything stacked onto a bone held still by the clip (the Trooper's Attack holds
   * his spine) would compound frame after frame and spin the torso.
   */
  private pose() {
    if (this.layers.spineRoot >= 0 && this.aimPivot.parent) {
      const right = new THREE.Vector3(-Math.cos(this.unit.yaw), 0, Math.sin(this.unit.yaw));
      const bend = THREE.MathUtils.clamp(this.pitch * AIM_BEND, -MAX_BEND, MAX_BEND);
      const turn = new THREE.Quaternion().setFromAxisAngle(right, bend);
      const hips = this.aimPivot.parent.getWorldQuaternion(new THREE.Quaternion());
      // The world-space lean, expressed in the hips' frame.
      this.aimPivot.quaternion.copy(hips).invert().multiply(turn).multiply(hips);
      const holder = this.weaponPivot.parent;
      if (holder) {
        // The weapon turned as the torso is, about the hips, in its own parent's frame.
        const frame = holder.getWorldQuaternion(new THREE.Quaternion());
        const lean = frame.clone().invert().multiply(turn).multiply(frame);
        const hip = holder.worldToLocal(this.aimPivot.getWorldPosition(new THREE.Vector3()));
        this.weaponPivot.matrix
          .makeTranslation(hip.x, hip.y, hip.z)
          .multiply(new THREE.Matrix4().makeRotationFromQuaternion(lean))
          .multiply(new THREE.Matrix4().makeTranslation(-hip.x, -hip.y, -hip.z));
        this.weaponPivot.matrixWorldNeedsUpdate = true;
      }
    }
    // In first person (and inside a bunker) the body is hidden; the viewmodel stands in for it.
    this.hero.instance.object.visible = !this.firstPerson && !this.garrison;
  }

  cameraPose(): CameraPose {
    const scope = this.cls.fire === 'rifle';
    const fov = THREE.MathUtils.lerp(view.fov, view.fov * (scope ? 0.22 : 0.57), this.ads) + (this.joltLeft > 0 ? 4 : 0);
    const u = this.unit;
    const yaw = this.yaw + this.kickYaw;
    const pitch = this.pitch + this.kick;
    if (this.garrison) {
      // Behind the firing slit facing the aim.
      const b = this.garrison;
      const p = b.position.clone();
      p.x += Math.sin(this.yaw) * b.radius * 0.95;
      p.z += Math.cos(this.yaw) * b.radius * 0.95;
      p.y += b.height * 0.42;
      return yawPitchPose(p, yaw, pitch, fov);
    }
    if (this.firstPerson) {
      const head = this.hero.attachment('Ref_Head', new THREE.Vector3()) ?? u.center(new THREE.Vector3());
      head.x += Math.sin(this.yaw) * 0.25;
      head.z += Math.cos(this.yaw) * 0.25;
      head.y += 0.05;
      return yawPitchPose(head, yaw, pitch, fov);
    }
    // Over the shoulder, further out for a bulkier soldier (a Burner's back would hide its own flame).
    const shoulder = Math.max(0.95, u.radius * 1.5);
    return shoulderCamera(this.world, u, yaw, pitch, {
      distance: THREE.MathUtils.lerp(this.distance, scope ? 1.2 : 1.9, this.ads),
      height: u.base + u.height * 0.86,
      side: THREE.MathUtils.lerp(shoulder, shoulder * 0.8, this.ads),
      fov,
    });
  }

  hud(): AvatarHud {
    const u = this.unit;
    const bars: HudBar[] = [];
    if (this.cls.shift === 'jolt') {
      const s = this.jolt;
      bars.push({
        label: 'Jolt',
        key: 'Shift',
        value: this.joltLeft / (s.duration / FASTER),
        text: this.joltLeft > 0 ? `${this.joltLeft.toFixed(1)}s` : `Ready · −${s.lifeCost} life`,
        color: 'linear-gradient(90deg, #ff6a3a, #ffc14a)',
      });
    }
    if (u.kind.energy.max > 0) {
      bars.push({
        label: u.shrouded ? 'Energy · cloaked' : 'Energy',
        key: this.cls.shift === 'shroud' ? 'E' : undefined,
        value: u.energy / u.kind.energy.max,
        text: `${Math.floor(u.energy)} / ${u.kind.energy.max}`,
        color: 'linear-gradient(90deg, #6a4aff, #c7b4ff)',
      });
    }
    if (this.cls.shift === 'jump') {
      bars.push({
        label: 'Jet pack',
        key: 'Space',
        value: 1 - this.jumpCooldown / JUMP_COOLDOWN,
        text: this.jumpCooldown > 0 ? `${this.jumpCooldown.toFixed(1)}s` : 'Ready',
        color: 'linear-gradient(90deg, #4ab0ff, #b4e4ff)',
      });
    }
    if (this.cls.id === 'seer') {
      const live = !!this.warhead && !this.warhead.done;
      const bar = this.ultimateBar?.(live ? { value: 1 - this.warhead!.remaining / this.warhead!.delay, text: `Impact in ${this.warhead!.remaining.toFixed(1)}s · hold position` } : null);
      if (bar) bars.push(bar);
    } else if (this.ownUltimate) {
      const bar = this.ultimateBar?.();
      if (bar) bars.push(bar);
    }
    if (this.keelGunBar && (this.cls.id !== 'seer' || this.ownUltimate)) bars.push(this.keelGunBar());
    let prompt: string | null = null;
    if (this.garrison) prompt = '[F] Leave the bunker';
    else {
      const near = this.nearbyInteraction();
      if (near) prompt = near.isBuilding ? `[F] Garrison bunker (${(near.controller as BunkerGuns).occupants}/4)` : near.flying ? `[F] Board the Dustoff · ${this.canRide(near as Unit)}` : `[F] Take the ${this.canBoard(near as Unit)}`;
    }
    if (this.healing) prompt = `Healing · ${Math.ceil(this.healing.hp)} / ${this.healing.maxHp}`;
    // A flyer under the crosshair that this weapon can't reach (a ground-only weapon).
    if (!prompt && this.weapon && !this.weapon.air) {
      const { origin, dir } = this.aimRay();
      const seen = this.world.raycast(origin, dir, MAX_RANGE, (e) => e === u || e.team === u.team);
      if (seen?.entity?.flying) prompt = `${this.cls.name} weapons can't hit air · Troopers and Seers can`;
    }
    const crosshair: Crosshair = this.cls.fire === 'rifle' && this.ads > 0.6 ? 'scope' : this.cls.fire === 'heal' ? 'heal' : this.cls.fire === 'flame' || this.cls.fire === 'grenade' ? 'cannon' : 'rifle';
    return {
      title: this.garrison ? `${this.cls.name} · in Bunker` : `${this.cls.name} · ${this.cls.role}`,
      hp: u.hp,
      maxHp: u.maxHp,
      bars,
      crosshair,
      spread: this.spread,
      prompt,
      slit: !!this.garrison,
    };
  }

  /** Hands the soldier back to the AI, holding where it stands. */
  release() {
    if (this.garrison) this.leaveBunker();
    if (this.unit.shrouded) this.setShroud(false);
    this.jump = null;
    const u = this.unit;
    u.airborne = false;
    u.afterAnimate = null;
    u.customAnimation = false;
    u.speedMul = u.attackSpeedMul = 1;
    if (u.alive) {
      this.world.setHero(u, false);
      u.setController(new GuardBrain(u, u.position.clone()));
    }
  }
}
