import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import { shoulderCamera, type Avatar, type AvatarHud, type HudBar, type PlayerStats } from './avatar.ts';
import { view, type CameraPose } from './camera.ts';
import { FASTER } from './stats.ts';
import type { Controller, Entity, Unit } from './entity.ts';
import { canHit, RANGE_METERS_PER_CELL, type KindName, type Weapon } from './kinds.ts';
import { beginMorph, morphFrom, morphOf, morphTo } from './systems/morph.ts';
import { holdOf, type Hold } from './systems/transport.ts';
import { crew } from './tank.ts';
import { WalkerRig } from './walkerrig.ts';
import { shareOf, type World } from './world.ts';

/**
 * Every vehicle and aircraft the player can take besides the Howitzer (tank.ts) and the
 * Warship: a Torchrunner or a Bulwark driven over the ground, a Jackknife, Nightjar, Swift or Dustoff
 * flown at the height its data gives it. One seat for all of them: the stats' own numbers
 * (each unit's speed and turn rate, its weapons) do the rest, so a kind added to `VEHICLES` is
 * drivable with nothing else to write.
 *
 * - It goes where the camera looks (W ahead, S back, A/D to the sides), turning to its travel at
 *   its own turn rate, as Halo's vehicles do.
 * - The left button fires where the crosshair is, as in any shooter. On an enemy one of its
 *   weapons can hit (aimed at, or near enough the crosshair to lock on: ground, air or both, by
 *   the data's targets), it fires the unit's own attack, the one the AI's units fire: the body
 *   swings to face it, and the shot homes in. With nothing to lock on to, a weapon that hits the
 *   ground fires at the spot. In the player's hands the weapons reach half again as far as the
 *   data's (as the Burner's flames do); what a weapon can't do (a Jackknife's torpedoes at the
 *   ground) is said under the crosshair, with what to do instead.
 * - Aircraft fly two and a half times the data's speed for the player (that speed is slow
 *   for their size at story scale), with an afterburner on Shift.
 * - A Dustoff heals instead: the most wounded biological ally under it, as its autocast does.
 *   It carries, too (systems/transport.ts): Q takes aboard the soldiers under it, R sets them
 *   down, one at a time at the data's pace.
 * - A Jackknife lands (Q) as a walker with its gatling, and takes off again (systems/morph.ts), at
 *   its ability's own pace.
 * - Boarded on foot, the soldier rides along and E lets them out; dived into from command, the
 *   vehicle goes back to whatever it was doing when the player leaves (a Jackknife takes the shape
 *   it was in first).
 */

/** A machine's own ability on E, where a mode gives it one (The Tide: Unleashed's Coyote lays Scuttle Mines). */
export interface VehicleSpecial {
  label: string;
  /** Uses it: why it couldn't, or null. */
  use(): string | null;
  /** Its bar on the HUD. */
  bar(): HudBar;
}

export interface VehicleDef {
  label: string;
  /** Flown (at its data's height) rather than driven. */
  air: boolean;
  /** Which of a mission's `drive` rules opens it: a landed Jackknife is still one of the aircraft. */
  seat: 'vehicles' | 'aircraft';
  /** Heals instead of fighting (a Dustoff). */
  heals?: boolean;
  /** What its burst of speed on Shift is called (an afterburner unless it's driven otherwise: a Nightjar's rotors overdrive). */
  boost?: string;
}

/** What the player can take, by kind. A mission's rules say whether ground vehicles, aircraft, or both. */
export const VEHICLES: Partial<Record<KindName, VehicleDef>> = {
  torchrunner: { label: 'Torchrunner', air: false, seat: 'vehicles' },
  bulwark: { label: 'Bulwark', air: false, seat: 'vehicles' },
  jackknifeFighter: { label: 'Jackknife · Fighter Mode', air: true, seat: 'aircraft' },
  jackknifeAssault: { label: 'Jackknife · Assault Mode', air: false, seat: 'aircraft' },
  nightjar: { label: 'Nightjar', air: true, seat: 'aircraft', boost: 'Overdrive' },
  swift: { label: 'Swift', air: true, seat: 'aircraft' },
  frigate: { label: 'Frigate', air: true, seat: 'aircraft' },
  dustoff: { label: 'Dustoff', air: true, seat: 'aircraft', heals: true },
  picket: { label: 'Picket', air: false, seat: 'vehicles' },
  coyote: { label: 'Coyote', air: false, seat: 'vehicles' },
  behemoth: { label: 'Behemoth', air: false, seat: 'vehicles' },
};

/** Whether the player may take `e` under a mission's `drive` rules. */
export function drivable(e: Entity, rules?: { vehicles?: boolean; aircraft?: boolean }): e is Unit {
  if (e.isBuilding) return false;
  const v = VEHICLES[e.kind.name];
  return !!v && !!rules?.[v.seat];
}

/** The Dustoff's heal, from the data. */
export interface HealData {
  /** Life per second (Normal speed). */
  rate: number;
  energyPerLife: number;
  /** Cells. */
  range: number;
}

const SENSITIVITY = 0.002;
/** Lock-on: the cone around the crosshair a target is picked from, and the wider one a lock holds in. */
const LOCK_CONE = Math.cos(THREE.MathUtils.degToRad(10));
const HOLD_CONE = Math.cos(THREE.MathUtils.degToRad(18));
/** How far past its weapon's reach a target can be locked (to close on it). */
const LOCK_BEYOND = 70;
/** Fires once it faces its target this closely, radians. */
const FIRE_ARC = 0.45;
/** The player's weapons reach this much further than the data's ranges. */
const PLAYER_REACH = 1.5;
/** Aircraft the player flies go this much faster than the data's speed; the afterburner more again, for a while. */
const PLAYER_FLIGHT = 2.5;
/**
 * The player's machines as a mode has them: how much further than the data's ranges a ground
 * machine's and an aircraft's weapons reach, and how much faster than the data's speed an
 * aircraft flies (The Tide: Unleashed's reach and fly further).
 */
export interface MachineTuning {
  reach: number;
  airReach: number;
  flight: number;
}
const tuning: MachineTuning = { reach: PLAYER_REACH, airReach: PLAYER_REACH, flight: PLAYER_FLIGHT };

/** Sets the player's machines for a mode (each unset value back to the default). */
export function tuneMachines(t: Partial<MachineTuning> = {}) {
  Object.assign(tuning, { reach: PLAYER_REACH, airReach: PLAYER_REACH, flight: PLAYER_FLIGHT }, t);
}
const AFTERBURNER = { boost: 1.6, seconds: 4, recharge: 9 };
/** Seconds a reason the trigger did nothing stays under the crosshair. */
const DENIED = 1.6;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();

export class VehicleAvatar implements Avatar {
  readonly kind = 'vehicle';
  yaw: number;
  pitch: number;
  distance: number;
  wantsCommand = false;
  holdFire = false;
  /** The enemy (or, for a Dustoff, the ally) the weapons are on. */
  private target: Entity | null = null;
  /** What drove it before the player took it, given back on leaving. */
  private previous: Controller | null;
  /** A walker's legs and upper body, animated apart (walkerrig.ts): it walks on as it fires. */
  private rig: WalkerRig | null = null;
  /** The body the rig was made for: a Jackknife lands on another model, and the rig is made again for it. */
  private rigFor: unknown = null;
  /** The camera's distance, height over the body and lift, eased toward where they're set (see cameraPose). */
  private cam: { distance: number; height: number; lift: number; at: number } | null = null;
  /** Its own ability on E, where the mode gives it one. */
  special: VehicleSpecial | null = null;
  private marker: THREE.Mesh;
  private healing: Unit | null = null;
  private healSound = 0;
  private lastShot = -Infinity;
  /** The camera's distance range, from the body's size (and the kind it was measured for). */
  private near = 6;
  private far = 30;
  private sizedFor: KindName | null = null;
  /** The shape it was in when the player took it: the AI gets it back in that shape. */
  private readonly startKind: KindName;
  /** Setting its cargo down, one at a time. */
  private unloading = false;
  private unloadIn = 0;
  /** Where the crosshair is: the ground or what's there, and the enemy under it (if any). */
  private aimPoint = new THREE.Vector3();
  private aimHit: Entity | null = null;
  /** What's said under the crosshair now, and a refusal that stays a moment after the trigger. */
  private note: string | null = null;
  private denied: { text: string; until: number } | null = null;
  /** The afterburner's fuel, 0..1, and whether it's lit. */
  private fuel = 1;
  private burning = false;
  /** HUD hooks: a hit landed (killed: it died of it); the soldier climbs out. */
  onHit: ((e: Entity, killed: boolean) => void) | null = null;
  onExit: ((passenger: Unit) => void) | null = null;
  keelGunBar: (() => HudBar) | null = null;
  /** Its own ultimate's bar (F), where a mode gives each machine one (`busy` while it's under way). */
  ultimateBar: ((busy?: { value: number; text: string } | null) => HudBar | null) | null = null;
  /** What a soldier set down by this transport does there (the mission's say; by default, holds there). */
  dropBrain: ((u: Unit, at: THREE.Vector3) => Controller | null) | null = null;
  /** F: the Warship called to where the crosshair is, or the machine's own ultimate where a mode gives it one. */
  onCall: ((at: THREE.Vector3) => boolean) | null = null;

  constructor(
    readonly unit: Unit,
    private input: Input,
    private world: World,
    private camera: THREE.PerspectiveCamera,
    readonly stats: PlayerStats,
    readonly passenger: Unit | null,
    private healData: HealData | null = null,
  ) {
    this.startKind = unit.kind.name;
    // Kept, not released: it takes the unit back as it was.
    this.previous = unit.controller;
    unit.controller = null;
    unit.move.set(0, 0);
    unit.face = null;
    world.setHero(unit, true);
    this.rig = WalkerRig.for(unit);
    this.rigFor = unit.visual;
    this.yaw = unit.yaw;
    this.pitch = this.def.air ? -0.38 : -0.16;
    this.size();
    this.distance = THREE.MathUtils.lerp(this.near, this.far, 0.3);
    if (passenger) {
      crew.set(unit, passenger);
      passenger.stowed = true;
    }
    const ring = new THREE.RingGeometry(0.86, 1, 40);
    ring.rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false }));
    this.marker.renderOrder = 6;
    this.marker.visible = false;
    world.scene.add(this.marker);
  }

  get entity(): Entity {
    return this.unit;
  }

  /** What it is now (a Jackknife is one thing in the air and another landed). */
  get def(): VehicleDef {
    const u = this.unit;
    return VEHICLES[u.kind.name] ?? { label: u.kind.def.dataId, air: u.flying, seat: u.flying ? 'aircraft' : 'vehicles' };
  }

  /** Its hold, if it carries. */
  get hold(): Hold | null {
    return holdOf(this.unit);
  }

  /** The camera's range for the body's size, measured again when its shape changes. */
  private size() {
    const u = this.unit;
    if (this.sizedFor === u.kind.name) return;
    this.sizedFor = u.kind.name;
    const size = Math.max(u.radius * 2, u.height);
    this.near = Math.max(6, size * 1.6);
    this.far = Math.max(this.near + 12, size * 5);
    this.distance = THREE.MathUtils.clamp(this.distance ?? this.near, this.near, this.far);
  }

  get position(): THREE.Vector3 {
    return this.unit.position;
  }

  get alive(): boolean {
    return this.unit.alive;
  }

  tick(dt: number) {
    const u = this.unit;
    const input = this.input;
    const { dx, dy, wheel } = input.consume();
    this.yaw -= dx * SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * SENSITIVITY, this.def.air ? -1.25 : -0.9, this.def.air ? 1 : 0.55);
    if (wheel) {
      this.distance += wheel * (this.far - this.near) * 0.12;
      if (this.distance > this.far * 1.04) this.wantsCommand = true;
      this.distance = THREE.MathUtils.clamp(this.distance, this.near, this.far);
    }
    if (input.hit('KeyF') && this.passenger && !u.morph) {
      this.onExit?.(this.passenger);
      return;
    }
    if (this.passenger) this.passenger.position.copy(u.position);
    this.size();
    // E: a Jackknife lands or takes off; a transport takes aboard who's under it; or the machine's
    // own (a Coyote's Scuttle Mines). R: sets them down. Q: the body's ultimate.
    const hold = this.hold;
    if (input.hit('KeyE')) {
      if (morphFrom(u.kind.name) && !u.morph) {
        // The transformation animates the whole model: the walker's halves let go first.
        this.rig?.release();
        this.rig = null;
        this.rigFor = null;
        beginMorph(u);
      }
      else if (hold) this.load(hold);
      else if (this.special) {
        const why = this.special.use();
        if (why) this.denied = { text: why, until: this.world.time + DENIED };
      }
    }
    if (input.hit('KeyQ') && this.onCall) {
      this.aim();
      this.onCall(this.aimPoint.clone());
    }
    if (input.hit('KeyR') && hold?.cargo.length) {
      this.unloading = true;
      this.unloadIn = 0;
    }
    if (hold) this.unload(hold, dt);
    // A transformation done, on the model it's become (a Jackknife landed walks as it fires).
    if (!u.morph && this.rigFor !== u.visual) {
      this.rig?.release();
      this.rig = WalkerRig.for(u);
      this.rigFor = u.visual;
    }
    // Mid-transformation it neither moves nor fires.
    if (u.morph) {
      u.move.set(0, 0);
      this.target = null;
      this.showMarker();
      return;
    }

    // Where the camera looks: W ahead, S back, A/D to the sides.
    const ahead = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const side = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const mx = Math.sin(this.yaw) * ahead - Math.cos(this.yaw) * side;
    const mz = Math.cos(this.yaw) * ahead + Math.sin(this.yaw) * side;
    const len = Math.hypot(mx, mz);
    u.move.set(len > 1 ? mx / len : mx, len > 1 ? mz / len : mz);
    // An aircraft keeps its nose where the player looks and slides any way under it (banking
    // into the slide). A ground machine turns to where it drives, except backing up (S), when it
    // keeps its nose the other way and reverses (a walker steps back, wheels and treads run
    // backwards); left alone it holds its heading.
    if (u.flying) u.face = this.yaw;
    else if (len > 0) u.face = ahead < 0 ? Math.atan2(-mx, -mz) : null;
    else u.face = u.yaw;
    this.fly(dt, len > 0);

    const firing = input.mouse(0) && input.locked && !this.holdFire;
    if (this.def.heals) this.heal(dt);
    else this.fight(firing);
    this.rig?.update(dt);
    this.showMarker();
  }

  /** An aircraft's speed in the player's hands, and its afterburner (Shift, while there's fuel). */
  private fly(dt: number, moving: boolean) {
    const u = this.unit;
    if (!u.flying) {
      u.speedMul = 1;
      this.burning = false;
      return;
    }
    const want = moving && (this.input.down('ShiftLeft') || this.input.down('ShiftRight'));
    this.burning = want && this.fuel > 0;
    if (this.burning) this.fuel = Math.max(0, this.fuel - dt / AFTERBURNER.seconds);
    else if (!want) this.fuel = Math.min(1, this.fuel + dt / AFTERBURNER.recharge);
    u.speedMul = tuning.flight * (this.burning ? AFTERBURNER.boost : 1);
  }

  /** The ground under it, where soldiers board from and are set down. */
  private below(): THREE.Vector3 {
    const p = this.unit.position;
    return new THREE.Vector3(p.x, this.world.terrain.heightAt(p.x, p.z), p.z);
  }

  /** Takes aboard everyone under it who fits, nearest first. */
  private load(hold: Hold) {
    const w = this.world;
    let n = 0;
    for (const s of hold.around(this.below())) if (hold.load(s)) n++;
    if (n) w.audio.play('dustoffUnload', { at: this.unit.position, volume: 0.7 });
    else w.sfx.play('ui.click', { volume: 0.5 });
    this.unloading = false;
  }

  /** Sets the cargo down under it, one at a time at the data's pace, while it's low and over open ground. */
  private unload(hold: Hold, dt: number) {
    if (!this.unloading) return;
    if (!hold.cargo.length) {
      this.unloading = false;
      return;
    }
    this.unloadIn -= dt;
    if (this.unloadIn > 0) return;
    this.unloadIn = hold.spec.unloadSeconds;
    hold.unloadOne(this.below(), this.dropBrain);
  }

  /** The weapon it can hit `e` with, if any (a Jackknife's torpedoes only reach flyers). */
  private weaponAt(e: Entity): Weapon | null {
    const w = this.unit.weaponFor(e);
    return w && canHit(w, e) ? w : null;
  }

  /**
   * What locks on: guided missiles at flyers (a Bulwark's Lances, a Jackknife's Dart torpedoes, a
   * Picket's Seekers), which home on what they're fired at, and a melee strike. Everything
   * else fires where it's aimed.
   */
  private locksOn(w: Weapon | null): boolean {
    return !!w && (w.melee || (w.missile && w.air && !w.ground));
  }

  /** The weapon that fires where the crosshair is: its first that shoots at the ground and isn't a strike. */
  private straight(): Weapon | null {
    return this.weapons().find((w) => w.ground && !w.melee) ?? null;
  }

  /** How far a weapon reaches in the player's hands, meters (edge to edge, as the data's ranges). */
  private reach(w: Weapon): number {
    return (w.playerRange ?? w.range) * (this.unit.flying ? tuning.airReach : tuning.reach);
  }

  /** Its weapons, by name, and what each can hit, for the HUD and its notes. */
  private weapons(): Weapon[] {
    const k = this.unit.kind;
    return [k.weapon, k.antiAir].filter((w): w is Weapon => !!w);
  }

  /** Where the crosshair is: the first thing the line of sight meets (not our own soldiers), and the enemy there. */
  private aim() {
    const u = this.unit;
    const origin = this.camera.getWorldPosition(v1);
    const dir = this.camera.getWorldDirection(v2);
    const hit = this.world.raycast(origin, dir, 2500, (e) => e === u || (e.team === u.team && !e.isBuilding));
    this.aimPoint.copy(hit ? hit.point : v3.copy(origin).addScaledVector(dir, 2500));
    this.aimHit = hit?.entity && hit.entity.team !== u.team && !hit.entity.ignored ? hit.entity : null;
  }

  /**
   * What a weapon that locks on is on: the enemy under the crosshair if one can hit it; else the
   * one nearest the crosshair that one can, or the one it has while that stays near it. Guided
   * missiles lock on to flyers only; at the ground every weapon fires where it's aimed.
   */
  private lock() {
    const u = this.unit;
    if (this.aimHit && this.lockable(this.aimHit)) {
      this.target = this.aimHit;
      return;
    }
    const origin = this.camera.getWorldPosition(v1);
    const dir = this.camera.getWorldDirection(v2);
    const keep = this.target;
    const w0 = keep?.targetable && this.lockable(keep) ? this.weaponAt(keep) : null;
    if (keep && w0) {
      const to = keep.center(v3).sub(origin);
      const d = to.length();
      if (d > 0 && to.dot(dir) / d > HOLD_CONE && u.gap(keep) < this.reach(w0) + LOCK_BEYOND) return;
    }
    let best: Entity | null = null;
    let bestScore = Infinity;
    for (const e of this.world.entities) {
      if (!e.targetable || e.team === u.team || e.ignored || !this.lockable(e)) continue;
      const w = this.weaponAt(e);
      if (!w || u.gap(e) > this.reach(w) + LOCK_BEYOND) continue;
      const to = e.center(v3).sub(origin);
      const d = to.length();
      if (d < 1e-3) continue;
      const cos = to.dot(dir) / d;
      if (cos < LOCK_CONE) continue;
      // Nearest the crosshair first; between two as near it, the closer.
      const score = Math.acos(Math.min(1, cos)) * 60 + d * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    this.target = best;
  }

  /** Whether a weapon that locks on can be put on `e` (a guided missile on a flyer). */
  private lockable(e: Entity): boolean {
    const w = this.weaponAt(e);
    if (!w || !this.locksOn(w)) return false;
    return w.melee || e.flying;
  }

  /** Says why the trigger did nothing, under the crosshair, for a moment (with a click, once a press). */
  private deny(text: string) {
    if (this.input.mouseHit(0)) this.world.sfx.play('ui.click', { volume: 0.5 });
    this.denied = { text, until: this.world.time + DENIED };
  }

  /** What one of its weapons can't do, and what to do instead (a Jackknife can change shape for it). */
  private cannot(e: Entity | null): string {
    const names = this.weapons().map((w) => nameOf(w.id)).join(' and ');
    const flyer = e?.flying ?? false;
    const shape = morphFrom(this.unit.kind.name);
    if (flyer) return `${names}: ground only${shape ? ' · [E] take off to fight flyers' : ''}`;
    return `${names}: flyers only${shape ? ' · [E] land to fight the ground' : ''}`;
  }

  /**
   * The trigger. A weapon that locks on (guided missiles at a flyer, a melee strike) fires the
   * unit's own attack at its target once the body faces it and it's in reach, and the missiles
   * home in. Every other weapon fires where the crosshair is, as a rifle does: the shot follows
   * the aim, and what it meets on its way takes it (a Nightjar's rockets come down wherever on
   * the ground it's aimed, within reach).
   */
  private fight(firing: boolean) {
    const u = this.unit;
    const w = this.world;
    this.aim();
    this.lock();
    const t = this.target;
    const tw = t ? this.weaponAt(t) : null;
    const gun = this.straight();
    // What's said under the crosshair: out of reach, or nothing here that it can hit.
    const aimed = u.position.distanceTo(this.aimPoint) - u.radius;
    if (t && tw && u.gap(t) > this.reach(tw)) this.note = `Out of range · ${Math.round(u.gap(t))} m (reaches ${Math.round(this.reach(tw))} m)`;
    else if (!t && this.aimHit && !this.weaponAt(this.aimHit)) this.note = this.cannot(this.aimHit);
    else if (!t && gun && aimed > this.reach(gun) && aimed < 2000) this.note = `Out of range · ${Math.round(aimed)} m (reaches ${Math.round(this.reach(gun))} m)`;
    else this.note = null;
    if (!firing) return;
    if (t && tw) {
      const toward = Math.atan2(t.position.x - u.position.x, t.position.z - u.position.z);
      u.face = toward;
      if (u.gap(t) > this.reach(tw)) return this.deny(this.note ?? 'Out of range');
      if (Math.abs(angle(toward - u.yaw)) > FIRE_ARC) return;
      if (u.attack(t)) {
        if (u.attackWeapon) this.rig?.fire(u.attackWeapon);
        this.stats.shots++;
        this.lastShot = w.time;
      }
      return;
    }
    // Nothing locked: the gun fires where the crosshair is.
    if (!gun || (this.aimHit && !this.weaponAt(this.aimHit))) return this.deny(this.cannot(this.aimHit));
    const toward = Math.atan2(this.aimPoint.x - u.position.x, this.aimPoint.z - u.position.z);
    u.face = toward;
    if (Math.abs(angle(toward - u.yaw)) > FIRE_ARC || u.cooldown > 0 || u.attacking) return;
    this.fireAt(gun, this.aimPoint);
  }

  /**
   * A weapon fired where the crosshair is, as far as it reaches (the world's `fireAlong`): from
   * each of its barrels where it fires several together (a Bulwark's two cannons, a little apart),
   * drawn as the game draws that weapon.
   */
  private fireAt(weapon: Weapon, point: THREE.Vector3) {
    const u = this.unit;
    const w = this.world;
    u.cooldown = weapon.period / u.attackRate;
    const from = w.muzzle(u, new THREE.Vector3());
    const reach = this.reach(weapon) + u.radius;
    if (this.rig) this.rig.fire(weapon);
    else if (!u.customAnimation) u.playAttack(weapon, false);
    const fx = w.effectsOf(u, weapon);
    const rounds = fx?.rounds ?? 1;
    if (rounds > 1 && fx?.launchFrom?.length) {
      // A round from each barrel in turn over the attack, each its share, each going where the
      // crosshair is as it's fired (a Picket's autocannons: two can find two targets).
      const share: Weapon = { ...weapon, damage: shareOf(weapon.damage, rounds) };
      const gap = weapon.period / u.attackRate / rounds;
      for (let i = 0; i < rounds; i++) {
        const barrel = fx.launchFrom[i % fx.launchFrom.length];
        const fire = () => {
          if (!u.alive || w.player !== u) return;
          if (i > 0) this.aim();
          const muzzle = u.visual.attachment(barrel, new THREE.Vector3()) ?? w.muzzle(u, new THREE.Vector3());
          const hit = w.fireAlong(u, share, muzzle, i > 0 ? this.aimPoint.clone() : point, reach, { barrel, quiet: i > 0 });
          if (hit && !share.missile) {
            this.stats.hits++;
            this.onHit?.(hit, !hit.alive);
          }
        };
        if (i === 0) fire();
        else w.after(i * gap, fire);
      }
      this.stats.shots++;
      this.lastShot = w.time;
      return;
    }
    let hit: Entity | null = null;
    const shots = Math.max(1, weapon.volley ?? 1);
    for (let i = 0; i < shots; i++) {
      // The others spread a little round the aim, as a pair of barrels does.
      const to = i === 0 ? point : v3.copy(point).add(v2.set((Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 2.5));
      hit = w.fireAlong(u, weapon, from, to, reach) ?? hit;
    }
    // An instant round has landed already (a missile's hit is the world's to tell, when it lands).
    if (hit && !weapon.missile) {
      this.stats.hits++;
      this.onHit?.(hit, !hit.alive);
    }
    this.stats.shots++;
    this.lastShot = w.time;
  }

  /**
   * A Dustoff's heal, as its autocast: the most wounded biological ally within reach (the one
   * nearest the crosshair first), life and energy at the data's rates.
   */
  private heal(dt: number) {
    const u = this.unit;
    const w = this.world;
    const h = this.healData;
    this.target = null;
    if (!h) return;
    const reach = h.range * RANGE_METERS_PER_CELL;
    const ok = (e: Entity): e is Unit =>
      !e.isBuilding && e !== u && e.team === u.team && e.targetable && e.hp < e.maxHp && e.kind.attributes.includes('Biological') && Math.hypot(e.position.x - u.position.x, e.position.z - u.position.z) - e.radius < reach;
    let target: Unit | null = this.healing && ok(this.healing) ? this.healing : null;
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
    this.target = target;
    const amount = Math.min(h.rate * FASTER * dt, target.maxHp - target.hp, u.energy / h.energyPerLife);
    target.hp += amount;
    u.energy -= amount * h.energyPerLife;
    const from = u.center(v1);
    const to = target.center(v2);
    w.effects.tracer(from, to, 0x9fffc0, 0.1, dt * 1.5 + 0.02);
    w.effects.flash(to, 0.8, 0x9fffc0, dt * 1.5 + 0.03);
    this.healSound -= dt;
    if (this.healSound <= 0) {
      this.healSound = 0.9;
      w.audio.play('healLoop', { at: u.position, volume: 0.35 });
    }
  }

  /**
   * A ring round what the weapons are on: amber until it's in range, green once it is (the reach
   * the player's machines have, not the data's); green round a Dustoff's patient.
   */
  private showMarker() {
    const t = this.target;
    this.marker.visible = !!t?.targetable;
    if (!t?.targetable) return;
    const w = this.weaponAt(t);
    const ready = this.def.heals || (!!w && this.unit.gap(t) <= this.reach(w));
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(ready ? 0x7cff9a : 0xffb040);
    const y = t.flying ? t.position.y + t.base + 0.2 : this.world.terrain.heightAt(t.position.x, t.position.z) + 0.3;
    this.marker.position.set(t.position.x, y, t.position.z);
    this.marker.scale.setScalar(t.radius + 0.9);
  }

  cameraPose(): CameraPose {
    const u = this.unit;
    // Over an aircraft from well above it, so it rides low in the view and the crosshair is clear
    // of it (aiming down at the ground, it sat right under it).
    const height = (u.flying ? u.base : 0) + u.height * (this.def.air ? 2.2 : 1.2);
    const lift = this.def.air ? 1.5 : 0.8;
    // Eased toward those, and the distance too: a transformation ends on the other shape at once
    // (a Jackknife landed is a walker's height and size, and no longer flying), and the camera jumped.
    const now = this.world.time;
    const cam = (this.cam ??= { distance: this.distance, height, lift, at: now });
    const k = 1 - Math.exp(-3 * Math.max(0, now - cam.at));
    cam.distance += (this.distance - cam.distance) * k;
    cam.height += (height - cam.height) * k;
    cam.lift += (lift - cam.lift) * k;
    cam.at = now;
    return shoulderCamera(this.world, u, this.yaw, this.pitch, { distance: cam.distance, height: cam.height, side: 0, fov: view.fov - 4, lift: cam.lift });
  }

  hud(): AvatarHud {
    const u = this.unit;
    const bars: HudBar[] = [];
    const t = this.target;
    let prompt: string;
    const morphing = morphOf(u);
    const hold = this.hold;
    if (morphing) {
      bars.push({ label: morphing.def.label, value: morphing.progress, text: `${Math.round(morphing.progress * 100)}%`, color: 'linear-gradient(90deg, #5aa8ff, #bfe4ff)' });
      prompt = `${morphing.def.label}…`;
    } else if (this.def.heals) {
      const e = u.kind.energy;
      bars.push({ label: 'Heal', value: e.max > 0 ? u.energy / e.max : 0, text: this.healing ? `Healing · ${Math.ceil(this.healing.hp)} / ${this.healing.maxHp}` : `${Math.floor(u.energy)} energy`, color: 'linear-gradient(90deg, #5ad08a, #c0ffd8)' });
      prompt = 'Heals the most wounded soldier under it · WASD flies where you look';
    } else {
      const weapons = [u.kind.weapon, u.kind.antiAir].filter((w): w is Weapon => !!w);
      for (const w of weapons) {
        const ready = 1 - Math.min(1, u.cooldown / Math.max(0.05, w.period));
        const reach = w.air && w.ground ? 'ground and air' : w.air ? 'air' : 'ground';
        bars.push({ label: `${nameOf(w.id)} · ${reach}`, value: ready, text: ready >= 1 ? `Ready · ${Math.round(this.reach(w))} m` : 'Reloading', color: 'linear-gradient(90deg, #ff9a40, #ffe0a0)' });
      }
      const tw = t ? this.weaponAt(t) : null;
      const homing = weapons.find((w) => this.locksOn(w) && !w.melee);
      const what = t && tw ? `Locked: ${t.name ?? nameOf(t.kind.def.dataId)}` : this.straight() ? `Fires where you aim${homing ? ' · missiles lock on to flyers' : ''}` : 'Locks on to flyers';
      prompt = `${what} · Left button fires · WASD ${this.def.air ? 'flies' : 'drives'} where you look${u.flying ? ` · Shift ${(this.def.boost ?? 'Afterburner').toLowerCase()}` : ''}`;
    }
    if (u.flying && !morphing) bars.push({ label: this.def.boost ?? 'Afterburner', key: 'Shift', value: this.fuel, text: this.burning ? (this.def.boost ? 'On' : 'Burning') : this.fuel >= 1 ? 'Ready' : 'Recharging', color: 'linear-gradient(90deg, #ff7a30, #ffd060)' });
    if (hold) {
      bars.push({ label: 'Cargo', value: hold.used / hold.spec.space, text: `${hold.cargo.length} aboard · ${hold.used}/${hold.spec.space}${this.unloading ? ' · setting down' : ''}`, color: 'linear-gradient(90deg, #5aa8ff, #bfe4ff)' });
      if (!morphing) prompt += ` · [E] Take aboard who's under you${hold.cargo.length ? ' · [R] Set them down' : ''}`;
    }
    const m = morphFrom(u.kind.name);
    if (m && !morphing) prompt += ` · [E] ${m.to === 'jackknifeAssault' ? 'Land (Assault Mode)' : 'Take off (Fighter Mode)'}`;
    if (this.special) {
      bars.push(this.special.bar());
      prompt += ` · [E] ${this.special.label}`;
    }
    if (this.passenger && !morphing) prompt += ' · [F] Climb out';
    return {
      title: morphing ? `Jackknife · ${morphing.def.label}` : this.def.label,
      hp: u.hp,
      maxHp: u.maxHp,
      bars: [...bars, this.ultimateBar?.() ?? null, this.keelGunBar?.() ?? null].filter((b): b is HudBar => !!b),
      crosshair: this.def.heals ? 'heal' : 'cannon',
      spread: 0.01,
      prompt,
      aimNote: this.denied && this.denied.until > this.world.time ? this.denied.text : morphing ? null : this.note,
    };
  }

  /** Seconds since its weapons last fired (for the HUD's hit feedback). */
  get sinceShot(): number {
    return this.world.time - this.lastShot;
  }

  /** The body is gone: what the seat put in the world goes with it. */
  dispose() {
    this.world.scene.remove(this.marker);
  }

  /** Back to what drove it before (where it was going, what it was guarding); the soldier stays aboard as crew. */
  release() {
    this.dispose();
    const u = this.unit;
    this.rig?.release();
    this.rig = null;
    u.speedMul = 1;
    if (!u.alive) return;
    // In the shape the AI had it (a Jackknife it flew takes off again); the transformation runs on its own.
    morphTo(u, this.startKind);
    if (!u.morph) this.world.setHero(u, false);
    u.move.set(0, 0);
    u.face = null;
    u.setController(this.previous);
  }
}

/** An angle brought into -π..π. */
function angle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** "DartTorpedoes" → "Dart Torpedoes". */
function nameOf(id: string): string {
  return id.replace(/([a-z])([A-Z])/g, '$1 $2');
}
