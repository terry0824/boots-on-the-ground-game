import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import { shoulderCamera, type Avatar, type AvatarHud, type HudBar, type PlayerStats } from './avatar.ts';
import { view, type CameraPose } from './camera.ts';
import { FASTER } from './stats.ts';
import type { Controller, Entity, Unit } from './entity.ts';
import { HeroVisual } from './visual.ts';
import type { World } from './world.ts';

const SENSITIVITY = 0.002;
/**
 * Turret yaw rates, radians per second: a Howitzer's (720 degrees a second) and a braced
 * one's (360), at Normal speed, converted to Faster.
 */
const TURRET_TURN = { tank: THREE.MathUtils.degToRad(720) * FASTER, braced: THREE.MathUtils.degToRad(360) * FASTER };
const SHELL_FLIGHT = 0.55; // seconds from the muzzle to the impact
/** How long the reticle flashes when a shell is fired, seconds. */
const RETICLE_FLASH = 0.22;

type Mode = 'tank' | 'bracing' | 'braced' | 'unbracing';
interface TankState {
  mode: Mode;
  left: number;
}

const states = new WeakMap<Unit, TankState>();
const m4 = new THREE.Matrix4();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
/** The Trooper riding in a tank the player boarded; it dies with the tank. */
export const crew = new WeakMap<Unit, Unit>();

export function tankMode(u: Unit): Mode {
  return states.get(u)?.mode ?? (u.kind.name === 'howitzer' ? 'braced' : 'tank');
}

export function isTank(e: Entity): boolean {
  return !e.isBuilding && (e.kind.name === 'howitzer' || e.kind.name === 'howitzerMobile');
}

function braceSeconds(w: World): number {
  return w.braceTime / FASTER;
}

/**
 * A tank on a new rig (the AI's, or a driver's) in its mode, on the transformation rig
 * (`howitzerMorph`): at rest, the end of "Morph Start" is Braced Mode, the end of "Morph End"
 * Drive Mode. Mid-transformation (a driver climbed in or out), the transformation carries on from
 * where it was, at the pace that ends it on time. One rig for both, so transforming never swaps
 * models.
 */
export function restPose(u: Unit) {
  u.customAnimation = true;
  const s = states.get(u);
  if (s && (s.mode === 'bracing' || s.mode === 'unbracing')) {
    const t = braceSeconds(u.world);
    const clip = s.mode === 'bracing' ? 'Morph Start' : 'Morph End';
    const length = u.visual.play(clip, { loop: false, restart: true });
    u.visual.resume(clip, length * THREE.MathUtils.clamp(1 - s.left / t, 0, 1), false);
    u.visual.setTimeScale(length / t);
    return;
  }
  u.visual.resume(tankMode(u) === 'braced' ? 'Morph Start' : 'Morph End', 1e3, false);
}

/** Starts the transformation into Braced Mode: rooted, playing the rig's "Morph Start". */
export function beginBrace(u: Unit, w: World) {
  if (tankMode(u) !== 'tank') return;
  const t = braceSeconds(w);
  states.set(u, { mode: 'bracing', left: t });
  u.immobile = true;
  u.customAnimation = true;
  u.move.set(0, 0);
  w.setHero(u, u.visual instanceof HeroVisual, w.models.howitzerMorph);
  const length = u.visual.play('Morph Start', { loop: false, restart: true });
  u.visual.setTimeScale(length / t);
  w.audio.play('braceMorph', { at: u.position, volume: 0.9 });
}

/** Starts the transformation back into Drive Mode. */
export function beginUnbrace(u: Unit, w: World) {
  if (tankMode(u) !== 'braced') return;
  const t = braceSeconds(w);
  states.set(u, { mode: 'unbracing', left: t });
  w.setHero(u, u.visual instanceof HeroVisual, w.models.howitzerMorph);
  const length = u.visual.play('Morph End', { loop: false, restart: true });
  u.visual.setTimeScale(length / t);
  w.audio.play('unbraceMorph', { at: u.position, volume: 0.9 });
}

/** Advances a transformation; at the end the tank becomes the other kind of unit. */
export function updateTransform(u: Unit, w: World, dt: number) {
  const s = states.get(u);
  if (!s || (s.mode !== 'bracing' && s.mode !== 'unbracing')) return;
  s.left -= dt;
  if (s.left > 0) return;
  const hpFraction = u.hp / u.maxHp;
  if (s.mode === 'bracing') {
    s.mode = 'braced';
    u.kind = w.kinds.howitzer;
  } else {
    // The rig holds the end of "Morph End": Drive Mode.
    s.mode = 'tank';
    u.kind = w.kinds.howitzerMobile;
    u.immobile = false;
  }
  u.hp = hpFraction * u.maxHp;
}

/**
 * A tank's turret: a pivot slipped in above the rig's turret bone, swung about world up through
 * the bone's own origin, at the turret's traverse rate. The hull stays where it is.
 */
export class Turret {
  private pivot = new THREE.Object3D();
  private bone: THREE.Bone | null = null;
  /** The cannon's muzzle (Ref_Weapon), under the turret: the barrel runs from the turret to it. */
  private muzzle: THREE.Bone | null = null;
  private rigFor: HeroVisual | null = null;

  constructor(public yaw: number) {}

  /** Turns toward `want` (world yaw) at the data's rate for `u`'s mode; returns how far off it still is, radians. */
  turn(want: number, dt: number, u: Unit): number {
    let diff = want - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const rate = tankMode(u) === 'tank' ? TURRET_TURN.tank : TURRET_TURN.braced;
    const step = THREE.MathUtils.clamp(diff, -rate * dt, rate * dt);
    this.yaw += step;
    return Math.abs(diff - step);
  }

  /**
   * Poses the turret of `u`'s rig (it needs a full skeleton) so the barrel points along the
   * turret's yaw. The pose's own barrel direction is measured first, not assumed: the
   * transformation swings the turret round, and a braced tank's cannon rests over its tail.
   * With `follow` off (mid-transformation) the animation turns the turret, and the turret's yaw
   * follows it.
   */
  apply(u: Unit, follow = true) {
    const visual = u.visual;
    if (!(visual instanceof HeroVisual)) return;
    if (this.rigFor !== visual) {
      // A new rig: find its turret and muzzle, and insert the pivot.
      const bones = visual.instance.mesh.skeleton.bones;
      this.bone = bones.find((b) => b.userData.sourceName === 'Ref_TurretZ') ?? bones.find((b) => b.userData.sourceName === 'Bone_Turret_Base') ?? null;
      this.muzzle = bones.find((b) => b.userData.sourceName === 'Ref_Weapon') ?? null;
      // One pivot per rig, whoever drives the turret (the AI, then the player, then the AI).
      const held = this.bone?.parent?.userData.turretPivot ? this.bone.parent : null;
      this.pivot = held ?? new THREE.Object3D();
      if (!held && this.bone?.parent) {
        this.pivot.userData.turretPivot = true;
        this.bone.parent.add(this.pivot);
        this.pivot.add(this.bone);
      }
      this.rigFor = visual;
    }
    const bone = this.bone;
    const parent = this.pivot.parent;
    if (!bone || !parent) return;
    // Where the pose alone points the barrel, relative to the hull.
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    let rest = 0;
    if (this.muzzle) {
      this.pivot.updateMatrixWorld(true);
      const toHull = m4.copy(visual.instance.object.matrixWorld).invert();
      const a = bone.getWorldPosition(va).applyMatrix4(toHull);
      const b = this.muzzle.getWorldPosition(vb).applyMatrix4(toHull);
      if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-4) rest = Math.atan2(b.x - a.x, b.z - a.z);
    }
    if (!follow) {
      this.yaw = u.yaw + rest;
      return;
    }
    // Rotate about world up, through the turret bone's origin, expressed in the parent's frame.
    const parentQ = parent.getWorldQuaternion(new THREE.Quaternion());
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQ.clone().invert()).normalize();
    const r = new THREE.Quaternion().setFromAxisAngle(axis, this.yaw - u.yaw - rest);
    const p = bone.position.clone();
    this.pivot.quaternion.copy(r);
    this.pivot.position.copy(p).sub(p.clone().applyQuaternion(r));
  }
}

/**
 * AI for a Howitzer: drive to a position, brace up when the enemy comes within brace range,
 * and shell what it can reach; unbrace to move again. The turret tracks targets; the hull only
 * turns to drive, and a braced hull doesn't turn at all (it's dug in).
 */
export class TankBrain implements Controller {
  private target: Entity | null = null;
  private retarget = 0;
  private turret: Turret;

  constructor(
    private u: Unit,
    public post: THREE.Vector3,
  ) {
    // A full skeleton, so the turret can turn on its own.
    u.world.setHero(u, true);
    if (tankMode(u) === 'braced') u.immobile = true;
    restPose(u);
    this.turret = new Turret(u.yaw);
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    updateTransform(u, w, dt);
    const mode = tankMode(u);
    u.move.set(0, 0);
    u.face = mode === 'tank' ? null : u.yaw;
    if (mode === 'bracing' || mode === 'unbracing') return this.turret.apply(u, false);

    // A post it can't reach (inside a building, across a cliff): it settles where it got to.
    if (u.blocked > 3) this.post.copy(u.position);
    const away = Math.hypot(this.post.x - u.position.x, this.post.z - u.position.z);
    if (away > 6) {
      if (mode === 'braced') return beginUnbrace(u, w);
      u.move.set(this.post.x - u.position.x, this.post.z - u.position.z).normalize();
    }

    const weapon = u.kind.weapon!;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.targetable || !u.inRange(this.target)) {
      this.retarget = 0.5;
      this.target = w.nearestTarget(u, weapon.range + 4, (e) => u.gap(e) > weapon.minRange);
    }
    // At its post, a tank braces up as soon as anything comes within brace range.
    if (mode === 'tank' && away <= 6) {
      const braceRange = w.kinds.howitzer.weapon!.range;
      if (w.nearestEnemy(u.team, u.position.x, u.position.z, braceRange, (e) => !e.flying)) return beginBrace(u, w);
    }
    const t = this.target;
    const want = t?.targetable ? Math.atan2(t.position.x - u.position.x, t.position.z - u.position.z) : u.yaw;
    const off = this.turret.turn(want, dt, u);
    // Fire once the gun is on target.
    if (t?.targetable && u.inRange(t) && off < 0.15) u.attack(t);
    this.turret.apply(u);
  }
}

interface Shell {
  at: THREE.Vector3;
  left: number;
}

/**
 * The player as a Howitzer. Drive Mode: drive with WASD, turret on the mouse, 90mm cannons.
 * Braced Mode (Q): rooted, an artillery reticle on the ground, Anvil shells whose splash hits
 * your own side too. Its range is longer than its sight: it needs spotters.
 */
export class TankAvatar implements Avatar {
  readonly kind = 'tank';
  yaw: number;
  pitch = -0.12;
  distance = 13;
  wantsCommand = false;
  holdFire = false;
  private turret: Turret;
  private shells: Shell[] = [];
  private reticle: THREE.Mesh;
  /** Seconds left of the reticle's flash after a shell is fired. */
  private fired = 0;
  private aimPoint = new THREE.Vector3();
  private aimValid = false;
  /** HUD hooks. */
  /** A hit landed; `mitigated` when armor took most of it. */
  onHit: ((e: Entity, killed: boolean, mitigated?: boolean, weakSpot?: boolean) => void) | null = null;
  onExit: ((passenger: Unit) => void) | null = null;
  keelGunBar: (() => HudBar) | null = null;
  /** Its own ultimate's bar (F), where a mode gives each body one. */
  ultimateBar: (() => HudBar | null) | null = null;
  /** F: the Warship called to where the crosshair is, or the tank's own ultimate where a mode gives it one. */
  onCall: ((at: THREE.Vector3) => boolean) | null = null;

  constructor(
    readonly unit: Unit,
    private input: Input,
    private world: World,
    private camera: THREE.PerspectiveCamera,
    readonly stats: PlayerStats,
    readonly passenger: Unit | null,
  ) {
    unit.setController(null);
    world.setHero(unit, true);
    restPose(unit);
    this.yaw = unit.yaw;
    this.turret = new Turret(unit.yaw);
    if (passenger) {
      crew.set(unit, passenger);
      passenger.stowed = true;
    }
    const ring = new THREE.RingGeometry(0.85, 1, 48);
    ring.rotateX(-Math.PI / 2);
    this.reticle = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0x7cff9a, transparent: true, opacity: 0.8, depthWrite: false }));
    this.reticle.visible = false;
    world.scene.add(this.reticle);
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

  private get mode(): Mode {
    return tankMode(this.unit);
  }

  tick(dt: number) {
    const u = this.unit;
    const w = this.world;
    const input = this.input;
    this.fired = Math.max(0, this.fired - dt);
    const { dx, dy, wheel } = input.consume();
    this.yaw -= dx * SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * SENSITIVITY, -1.1, 0.6);
    if (wheel) {
      this.distance += wheel * 1.5;
      if (this.distance > 31) this.wantsCommand = true;
      this.distance = THREE.MathUtils.clamp(this.distance, 8, 30);
    }
    if (input.hit('KeyF') && this.passenger) {
      this.onExit?.(this.passenger);
      return;
    }
    if (input.hit('KeyQ') && this.onCall) this.onCall(this.aimPoint.clone());
    if (input.hit('KeyE')) {
      if (this.mode === 'tank') beginBrace(u, w);
      else if (this.mode === 'braced') beginUnbrace(u, w);
    }
    updateTransform(u, w, dt);
    if (this.passenger) this.passenger.position.copy(u.position);

    // Hull: throttle and steering, in Drive Mode only.
    u.move.set(0, 0);
    if (this.mode === 'tank') {
      const throttle = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 0.6 : 0);
      const steer = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
      const turned = steer * (u.kind.def.turnRate ?? 1.6) * dt;
      u.yaw += turned;
      // Steering turns the hull before the world moves it, where its treads would read the turn:
      // they roll it here (opposite ways), so turning in place runs them.
      u.rollTreads(0, turned);
      u.move.set(Math.sin(u.yaw) * throttle, Math.cos(u.yaw) * throttle);
    }
    u.face = u.yaw;

    // Turret follows the aim at its own pace.
    this.turret.turn(this.yaw, dt, this.unit);

    this.aim();
    const weapon = u.kind.weapon!;
    u.cooldown = Math.max(0, u.cooldown);
    if (input.mouse(0) && input.locked && !this.holdFire && u.cooldown <= 0 && (this.mode === 'tank' || this.mode === 'braced')) {
      if (this.mode === 'tank') this.fireCannons();
      else if (this.aimValid) this.fireShell();
      u.cooldown = weapon.period;
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.left -= dt;
      if (s.left <= 0) {
        w.playEffect(w.kinds.howitzer.def.effects?.impact, s.at, u.position, w.effectScaleOf(u));
        const { hit, killed } = w.explode(s.at, w.kinds.howitzer.weapon!, u, true, undefined, { drawn: true });
        const enemies = hit.filter((e) => e.team !== u.team);
        const kills = killed.filter((e) => e.team !== u.team).length;
        if (enemies.length) {
          this.stats.hits++;
          this.onHit?.(enemies[0], kills > 0);
        }
        w.effects.shake = Math.max(w.effects.shake, 0.25);
        this.shells.splice(i, 1);
      }
    }
    this.turret.apply(u, this.mode === 'tank' || this.mode === 'braced');
  }

  /** Where the crosshair meets the ground or a target; for Braced Mode, whether it's in range. */
  private aim() {
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const hit = this.world.raycast(origin, dir, 2000, (e) => e === this.unit || (e.team === this.unit.team && !e.isBuilding));
    this.aimPoint.copy(hit ? hit.point : origin.addScaledVector(dir, 2000));
    const u = this.unit;
    const braced = this.mode === 'braced';
    const weapon = this.world.kinds.howitzer.weapon!;
    const d = Math.hypot(this.aimPoint.x - u.position.x, this.aimPoint.z - u.position.z) - u.radius;
    this.aimValid = !!hit && d >= weapon.minRange && d <= (weapon.playerRange ?? weapon.range);
    this.reticle.visible = braced || this.mode === 'bracing';
    if (this.reticle.visible) {
      const outer = Math.max(...weapon.splash.map((s) => s.radius));
      this.reticle.position.copy(this.aimPoint).setY(this.world.terrain.heightAt(this.aimPoint.x, this.aimPoint.z) + 0.3);
      this.reticle.scale.setScalar(outer);
      // A shell away: the ring flashes light yellow for a moment, so the shot is felt as it's fired.
      const flash = this.fired > 0;
      (this.reticle.material as THREE.MeshBasicMaterial).color.setHex(flash ? 0xfff3a0 : this.aimValid && braced ? 0x7cff9a : 0xff5a4a);
      this.reticle.scale.setScalar(outer * (1 + this.fired * 0.5));
    }
  }

  private muzzle(out: THREE.Vector3): THREE.Vector3 {
    return this.unit.visual.attachment('Ref_Weapon', out) ?? this.unit.center(out);
  }

  private fireCannons() {
    const w = this.world;
    const u = this.unit;
    const weapon = u.kind.weapon!;
    const from = this.muzzle(new THREE.Vector3());
    const dir = this.aimPoint.clone().sub(from).normalize();
    const reach = weapon.playerRange ?? weapon.range;
    const hit = w.raycast(from, dir, reach + u.radius + 2, (e) => e === u || (e.team === u.team && !e.isBuilding));
    const end = hit ? hit.point : from.clone().addScaledVector(dir, reach);
    // The 90mm's flash from the muzzle and its launch model; no lines (its own effects draw none).
    w.effects.muzzleFlash(from, dir, 3.2, { light: 30, life: 0.06 });
    w.launch(u, from, end);
    w.sfx.play('tank.cannon', { at: from });
    this.stats.shots++;
    if (hit?.entity && hit.entity.team !== u.team) {
      const e = hit.entity;
      const wasAlive = e.alive;
      e.hit(weapon.damage, u);
      this.stats.hits++;
      this.onHit?.(e, wasAlive && !e.alive);
      if (!w.impact(u, hit.point, e, from)) w.effects.ichor(hit.point, dir.clone().negate(), 8, e.kind.def.hitColor);
      // The shell's own burst (the kind's impact sound).
      w.audio.play(u.kind.def.sounds?.impact ?? 'tankShellSmall', { at: hit.point, volume: 0.9, near: 15, limit: 4 });
    } else if (hit) {
      if (!w.impact(u, hit.point, null, from)) {
        w.effects.sparks(hit.point, hit.normal, 8);
        w.effects.smoke(hit.point, 1.2, 0xb09070, 1.2);
      }
      w.sfx.play('impact.ground', { at: hit.point, volume: 1.4 });
    }
  }

  private fireShell() {
    const w = this.world;
    const from = this.muzzle(new THREE.Vector3());
    w.effects.flash(from, 6, 0xffd090, 0.12, 80);
    w.effects.smoke(from, 2.5, 0x8a8070, 1.5);
    // Its launch model and nothing between (a braced shell's own effects draw no line).
    w.playEffect(w.kinds.howitzer.def.effects?.launch, from, this.aimPoint, w.scaleOf('howitzer'));
    this.fired = RETICLE_FLASH;
    w.sfx.play('tank.brace', { at: from });
    w.effects.shake = Math.max(w.effects.shake, 0.35);
    this.stats.shots++;
    this.shells.push({ at: this.aimPoint.clone(), left: SHELL_FLIGHT });
  }

  cameraPose(): CameraPose {
    const u = this.unit;
    const braced = this.mode !== 'tank';
    return shoulderCamera(this.world, u, this.yaw, this.pitch, {
      distance: this.distance * (braced ? 1.5 : 1),
      height: u.height * (braced ? 2.2 : 1.4),
      side: 0,
      fov: braced ? view.fov - 12 : view.fov - 4,
      lift: braced ? 4 : 1.5,
    });
  }

  hud(): AvatarHud {
    const u = this.unit;
    const mode = this.mode;
    const weapon = u.kind.weapon!;
    const ready = 1 - Math.min(1, u.cooldown / weapon.period);
    const title = { tank: 'Howitzer · Drive Mode', bracing: 'Howitzer · sieging up', braced: 'Howitzer · Braced Mode', unbracing: 'Howitzer · unsieging' }[mode];
    const bars: HudBar[] = [
      {
        label: mode === 'tank' ? '90mm Cannons' : 'Anvil Shock Cannon',
        value: ready,
        text: mode === 'braced' && !this.aimValid ? 'Out of range' : ready >= 1 ? 'Ready' : 'Reloading',
        color: 'linear-gradient(90deg, #ff9a40, #ffe0a0)',
      },
    ];
    const own = this.ultimateBar?.();
    if (own) bars.push(own);
    if (this.keelGunBar) bars.push(this.keelGunBar());
    const prompts = [mode === 'tank' ? '[E] Braced Mode' : mode === 'braced' ? '[E] Drive Mode' : 'Transforming…'];
    if (this.passenger) prompts.push('[F] Climb out');
    return {
      title,
      hp: u.hp,
      maxHp: u.maxHp,
      bars,
      crosshair: mode === 'tank' ? 'cannon' : 'artillery',
      spread: 0.004,
      prompt: prompts.join(' · '),
    };
  }

  dispose() {
    this.world.scene.remove(this.reticle);
  }

  /** Hands the tank back to the AI where it stands; a boarded Trooper stays aboard as crew. */
  release() {
    this.dispose();
    const u = this.unit;
    if (!u.alive) return;
    this.world.setHero(u, false);
    u.setController(new TankBrain(u, u.position.clone()));
  }
}
