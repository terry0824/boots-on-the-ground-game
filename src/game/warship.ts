import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import type { ModelInstance, ModelTemplate } from '../engine/model.ts';
import type { EffectModel } from '../engine/fxmodel.ts';
import { Emitters, particles, type BoneSource } from '../engine/particles.ts';
import type { Avatar, AvatarHud, HudBar, PlayerStats } from './avatar.ts';
import { lookAtPose, type CameraPose } from './camera.ts';
import { FASTER, hitDamage, type DamageStats, type KeelGunStats } from './stats.ts';
import type { Entity } from './entity.ts';
import type { Kind, Weapon } from './kinds.ts';
import { TEAM_COLOR, type World } from './world.ts';

const v = new THREE.Vector3();
const ORBIT_RADIUS = 340;
/** High enough that the command camera (up to 340 m) always passes under the 264 m-tall hull. */
const ALTITUDE = 480;
/**
 * A 560-meter ship needs room to work: its batteries reach the ground from orbit (the data's
 * range is 6 cells at gameplay scale) and it cruises far faster than its gameplay speed, the
 * same way every range and speed here scales with the size of the thing that has it.
 */
const BATTERY_REACH = 520;
/**
 * Left to itself the ship guards: it fires on the swarm once it reaches the base perimeter
 * (the world's `perimeter` around the Holdfast), or around the station the commander
 * gave it. The approaches are the ground forces' fight; a captain at the helm can reach anything.
 */
const STATION_RADIUS = 200;
const CRUISE_SPEED = 32;
const TURN_RATE = 0.2;
/**
 * The data's Keel Gun cooldown (100 game seconds, 71 real) is built for a match, not a
 * five-minute stand; the fleet keeps a cannon in rotation about four times as often.
 */
const COOLDOWN_SHARE = 1 / 3.6;
/** Snap Jump: four seconds to spool, then the ship is somewhere else. */
const JUMP_SPOOL = 4;
const JUMP_COOLDOWN = 100 / FASTER;

/**
 * The Warship as a call-in (a mission's rules): how long it fights over the mark, how long
 * it recharges once it pulls out, how many of its batteries fire at once (each at the data's
 * rate, each on a target of its own), and how far round the mark they reach.
 */
export interface StrikeRules {
  seconds: number;
  recharge: number;
  /** Batteries firing at once, each at the data's rate, each on a target of its own. */
  batteries: number;
  radius: number;
  /**
   * Each bolt's damage as a multiple of the data's (the ATS's 8, the ATA's 5): the ship is drawn
   * at its story size, some forty times its gameplay model, and its guns with it.
   */
  damage: number;
  /**
   * Seconds into the battle before it can first be called (The Tide: Unleashed holds it back a
   * while). Unset, it's ready from the start; either way, again a recharge after each strike.
   */
  first?: number;
  /** Only the player's call brings it: not even the swarm in the base does (Unleashed, where it's the player's to spend). */
  manual?: boolean;
}

/**
 * A strike's Snap Jump: the ship stretching into hyperspace as it fades, the moment it's gone,
 * and snapping back out of it over the mark.
 */
const STRIKE_JUMP = { spool: 1.8, transit: 0.6, arrive: 0.9 };
/** How far the hull stretches along its heading going into and out of hyperspace. */
const STRETCH = 3.2;
/**
 * Where it waits between strikes: this far behind the base, away from where the enemy comes. In
 * sight on the horizon, and plainly too far to do anything without jumping in.
 */
const POST_DISTANCE = 2000;
/** How fast it flies home after a strike, and how quickly it comes round to do it. */
const RETURN_SPEED = 90;
const RETURN_TURN = 0.4;
/** A Keel Gun at the start of a strike, at the toughest thing there with at least this much life. */
const KEEL_GUN_WORTHY = 200;
/**
 * A strike's battery bolts, as the battery's own effects draw them: its missile, a short bolt of
 * the game's laser texture with the missile model's glowing head, from a hardpoint on the hull
 * down to its target (about a second from 480 m up), and its impact model where it lands. Sized
 * for the ship's scale: a bolt a hull's length at gameplay scale reads as a dash here.
 */
const BOLT = { speed: 520, length: 16, width: 2.4, head: 3, glow: 2.6 };

type StrikeStage = 'spool' | 'transit' | 'arrive' | 'engage' | 'leave';

/**
 * The Warship over the colony: 560 meters, 550 life and armor 3. On its own it holds
 * station and its laser batteries pick at the swarm; with a captain it goes where it's sent.
 */
export class Warship implements BoneSource {
  readonly model: ModelInstance;
  /** The hull's emitters: engine glows (harder under way), retro-thrusters, the Keel Gun's sparks. */
  private emitters: Emitters | null;
  private posed = false;
  /** Ground speed last frame, m/s, and a one-shot animation playing out (a stop, a shot) before the next. */
  private speed = 0;
  private lastPosition = new THREE.Vector3();
  private oneShot = 0;
  readonly position = new THREE.Vector3();
  heading = 0;
  hp: number;
  /** Seconds until the Keel Gun can fire again. */
  cooldownLeft = 0;
  readonly cooldown: number;
  readonly prep: number;
  jumpLeft = 0;
  controlled = false;
  /** Where the captain is pointing the batteries; null leaves them to pick their own targets. */
  focusPoint: THREE.Vector3 | null = null;
  /** How far around the focus point the batteries look (a mission may widen it: The Tide's cover over its base). */
  focusRadius = 40;
  /** Where the commander has sent the ship; it circles there. Null circles the base. */
  station: THREE.Vector3 | null = null;
  /**
   * Batteries silent unless a captain or a call-in directs them: over a town, an orbiting
   * capital ship picking off infantry would end every fight before it started.
   */
  holdFire = false;
  throttle = 0;
  climb = 0;
  private angle = -2.2;
  private batteryCooldown = 0;
  private charge: { target: Entity | null; point: THREE.Vector3; left: number; source: Entity | null } | null = null;
  private jump: { to: THREE.Vector3; left: number } | null = null;
  private target: Entity | null = null;
  /**
   * Where the ship waits between strikes: behind the base, away from where the enemy comes from
   * (a mission sets it; one that calls the ship in without saying gets one away from the map's
   * middle). Null: it circles the base, as the campaign has it.
   */
  post: THREE.Vector3 | null = null;
  /** The mission's rules for calling the ship in (X); null: Q fires the Keel Gun, as in the campaign. */
  strikeRules: StrikeRules | null = null;
  /** The key that calls it in (X where it's a call-in; Q, the ultimate, where its Keel Gun is). */
  callKey = 'Q';
  /** A strike under way: its stage, the seconds left in it, the mark, and whether its Keel Gun has fired. */
  private strike: { stage: StrikeStage; left: number; at: THREE.Vector3; keelGun: boolean } | null = null;
  /** Seconds until it can be called in again (counting once it pulls out). */
  rechargeLeft = 0;
  /** Each battery's seconds to its next bolt, and what it's on. */
  private batteryLeft: number[] = [];
  private batteryOn: (Entity | null)[] = [];
  /** Damage on its way to each target in bolts still falling: a battery moves on once it's enough. */
  private incoming = new Map<Entity, number>();
  private around: Entity[] = [];
  private lookIn = 0;
  /** The hull's battery hardpoints (its Ref_Weapon attachments), where bolts leave from. */
  private hardpoints: THREE.Bone[];
  private readonly baseScale: number;
  /** Going into or out of hyperspace: the hull's stretch along its heading. */
  private stretch = 1;
  /** A strike has begun or ended, for the HUD and the radio. */
  onStrike: ((what: 'called' | 'arrived' | 'leaving' | 'home') => void) | null = null;
  /** How its bolts look: the game's laser texture, and the missile model riding each (its glowing head). */
  boltLook: { texture: THREE.Texture | null; head: ModelTemplate | null } = { texture: null, head: null };
  /** Kill and hit hooks. */
  onFire: ((target: Entity | null) => void) | null = null;
  onBatteryHit: ((e: Entity, killed: boolean) => void) | null = null;
  /** Called just before a battery bolt lands, so the captain gets credit for what it kills. */
  onBatteryStrike: ((e: Entity) => void) | null = null;

  constructor(
    private world: World,
    template: ModelTemplate,
    readonly stats: KeelGunStats,
    readonly kind: Kind,
  ) {
    // Its own effects uniform: it dissolves into hyperspace and back.
    this.model = template.instantiate(TEAM_COLOR.holdouts, true);
    this.baseScale = world.scaleOf('warship');
    this.model.object.scale.setScalar(this.baseScale);
    this.hardpoints = template.data.attachments.filter((a) => /^Ref_Weapon/i.test(a.name)).map((a) => this.model.mesh.skeleton.bones[a.bone]).filter((b) => !!b);
    // Seen across the battlefield from where it waits (a kilometer and more off), the ground's
    // haze would swallow it: its own materials (an instance of its own) leave the fog out.
    this.model.object.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        (m as THREE.Material & { fog?: boolean }).fog = false;
        m.needsUpdate = true;
      }
    });
    this.model.play('Stand');
    this.cooldown = (stats.cooldown / FASTER) * COOLDOWN_SHARE;
    this.prep = stats.prep / FASTER;
    this.hp = kind.maxHp;
    world.scene.add(this.model.object);
    this.emitters = particles.has(template) ? new Emitters(template) : null;
    this.position.set(Math.cos(this.angle) * ORBIT_RADIUS, ALTITUDE, Math.sin(this.angle) * ORBIT_RADIUS);
    this.heading = Math.atan2(-Math.sin(this.angle), Math.cos(this.angle));
    this.place();
    this.lastPosition.copy(this.position);
  }

  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null {
    const bone = this.model.mesh.skeleton.bones[index];
    if (!bone) return null;
    if (!this.posed) {
      this.model.object.updateMatrixWorld(true);
      this.posed = true;
    }
    return out.copy(bone.matrixWorld);
  }

  /**
   * The ship's own animations: Walk under way (the engines burn brighter), Walk End coming to
   * a stop (the retro-thrusters fire), Spell A while the Keel Gun charges (sparks at the bow),
   * Spell A End after it fires.
   */
  private animate(dt: number) {
    this.speed = dt > 0 ? Math.hypot(this.position.x - this.lastPosition.x, this.position.z - this.lastPosition.z) / dt : this.speed;
    this.lastPosition.copy(this.position);
    this.oneShot = Math.max(0, this.oneShot - dt);
    const m = this.model;
    if (this.charge) m.play('Spell A');
    else if (m.animation === 'Spell A') this.oneShot = m.play('Spell A End', { loop: false })?.getClip().duration ?? 0;
    else if (this.oneShot > 0) return;
    else if (this.speed > 6) m.play('Walk');
    else if (m.animation === 'Walk') this.oneShot = m.play('Walk End', { loop: false })?.getClip().duration ?? 0;
    else m.play('Stand');
  }

  /** The base it guards: the Holdfast. */
  private home(): THREE.Vector3 {
    const g = this.world.goal;
    return g ? new THREE.Vector3(g.position.x, 0, g.position.z) : new THREE.Vector3();
  }

  get charging(): number {
    return this.charge ? this.charge.left : 0;
  }

  get jumping(): number {
    return this.jump ? this.jump.left : 0;
  }

  /** Where the Keel Gun beam leaves the ship: its bow. */
  bow(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(240).add(this.position).setY(this.position.y - 25);
  }

  /** Seconds until the Keel Gun fires, while it charges; null otherwise. */
  get keelGunLeft(): number | null {
    return this.charge ? this.charge.left : null;
  }

  /** Locks the Keel Gun onto a target (or a point on the ground); false if it isn't ready. */
  request(target: Entity | null, point: THREE.Vector3, source: Entity | null): boolean {
    if (this.cooldownLeft > 0 || this.charge) return false;
    this.charge = { target, point: point.clone(), left: this.prep, source };
    this.world.sfx.play('bc.keelGunCharge');
    this.world.audio.play('warshipVoice', { volume: 0.9, bus: 'voice' });
    return true;
  }

  /** Snap Jump: spool for four seconds, then warp to `to` (staying at altitude). */
  beginJump(to: THREE.Vector3): boolean {
    if (this.jumpLeft > 0 || this.jump) return false;
    this.jump = { to: new THREE.Vector3(to.x, this.position.y, to.z), left: JUMP_SPOOL };
    this.world.audio.play('warshipVoice', { volume: 0.9, bus: 'voice' });
    this.world.sfx.play('bc.jump');
    return true;
  }

  private place() {
    const o = this.model.object;
    o.position.copy(this.position);
    o.rotation.y = this.heading;
    o.scale.set(this.baseScale, this.baseScale, this.baseScale * this.stretch);
  }

  /** On a strike (from the jump until it's on its way home). */
  get striking(): boolean {
    return !!this.strike && this.strike.stage !== 'leave';
  }

  /** Why it can't be called in now, or null. */
  callable(): string | null {
    if (!this.strikeRules) return 'Not in this operation';
    if (this.controlled) return 'You have the helm';
    if (this.strike) return this.strike.stage === 'leave' ? 'Pulling out' : 'Already inbound';
    if (this.rechargeLeft > 0) return `Recharging · ${clock(this.rechargeLeft)}`;
    return null;
  }

  /**
   * Called in over `at`: a Snap Jump there, its batteries on everything round the mark for the
   * rules' seconds (and a Keel Gun at the toughest thing there), then home to its post to recharge.
   * Why not, or null.
   */
  callIn(at: THREE.Vector3): string | null {
    const why = this.callable();
    if (why) return why;
    this.strike = { stage: 'spool', left: STRIKE_JUMP.spool, at: new THREE.Vector3(at.x, 0, at.z), keelGun: false };
    this.world.sfx.play('bc.jumpOut');
    this.world.audio.play('warshipVoice', { volume: 0.9, bus: 'voice' });
    this.onStrike?.('called');
    return null;
  }

  /** The captain took the helm mid-strike: the strike's off (and the recharge on, if it got there). */
  private abortStrike() {
    const s = this.strike;
    if (!s) return;
    if (s.stage === 'engage' || s.stage === 'arrive') this.rechargeLeft = this.strikeRules?.recharge ?? 0;
    this.strike = null;
    this.stretch = 1;
    this.model.fx.z = 0;
    this.model.object.visible = true;
  }

  /** Puts the ship at its post at once (a mission's start), rather than flying there. */
  settle() {
    const p = this.postAt();
    this.position.set(p.x, ALTITUDE, p.z);
    const h = this.home();
    this.heading = Math.atan2(h.x - p.x, h.z - p.z);
    this.place();
    this.lastPosition.copy(this.position);
  }

  /** Where it waits: the mission's post, or one behind the base away from the map's middle. */
  private postAt(): THREE.Vector3 {
    if (!this.post) {
      const h = this.home();
      const away = new THREE.Vector3(h.x, 0, h.z);
      if (away.lengthSq() < 1) away.set(0, 0, -1);
      this.post = h.addScaledVector(away.normalize(), POST_DISTANCE);
    }
    return this.post;
  }

  /** Over the mark, a little toward its post (so the hull hangs behind the fight), bow to the enemy. */
  private over(at: THREE.Vector3): THREE.Vector3 {
    const back = this.postAt().clone().sub(at).setY(0);
    const d = back.length();
    return new THREE.Vector3(at.x, ALTITUDE, at.z).addScaledVector(d > 1 ? back.divideScalar(d) : back, Math.min(80, d));
  }

  /** Turns the hull toward `yaw` at `rate` radians a second. */
  private turn(yaw: number, rate: number, dt: number) {
    let d = yaw - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  /** Waiting at its post: a slow drift on a small circle, its bow toward the base. */
  private keepPost(dt: number) {
    const p = this.postAt();
    this.angle += dt * 0.04;
    const want = new THREE.Vector3(p.x + Math.cos(this.angle) * 40, ALTITUDE, p.z + Math.sin(this.angle) * 40);
    const d = this.position.distanceTo(want);
    // Gently there, never faster than it flies (it may be far off, where a captain left it).
    const step = Math.min(d * (1 - Math.exp(-dt * 0.25)), RETURN_SPEED * dt);
    if (d > 1e-3) this.position.lerp(want, step / d);
    const h = this.home();
    const far = d > 200;
    this.turn(far ? Math.atan2(want.x - this.position.x, want.z - this.position.z) : Math.atan2(h.x - this.position.x, h.z - this.position.z), far ? RETURN_TURN : TURN_RATE, dt);
  }

  /** A strike, stage by stage. */
  private updateStrike(dt: number) {
    const s = this.strike!;
    const w = this.world;
    s.left -= dt;
    const o = this.model.object;
    switch (s.stage) {
      case 'spool': {
        // Into hyperspace: the hull glows, stretches along its heading, and fades out.
        const k = THREE.MathUtils.clamp(1 - s.left / STRIKE_JUMP.spool, 0, 1);
        const late = THREE.MathUtils.clamp((k - 0.55) / 0.45, 0, 1);
        this.stretch = 1 + (STRETCH - 1) * late * late;
        this.model.fx.z = late * 0.95;
        if (Math.random() < 0.6) w.effects.flash(this.position, 80 + k * 220, 0x9ad0ff, 0.12, 0, true);
        if (s.left <= 0) {
          w.effects.flash(this.position, 420, 0xd8f0ff, 0.45, 0, true);
          o.visible = false;
          s.stage = 'transit';
          s.left = STRIKE_JUMP.transit;
        }
        return;
      }
      case 'transit':
        if (s.left > 0) return;
        // Out of hyperspace over the mark: stretched, and snapping back as it arrives.
        this.position.copy(this.over(s.at));
        this.heading = Math.atan2(s.at.x - this.postAt().x, s.at.z - this.postAt().z);
        o.visible = true;
        this.stretch = STRETCH;
        this.model.fx.z = 0.9;
        w.effects.flash(this.position, 520, 0xe8f6ff, 0.6, 0, true);
        w.effects.shake = Math.max(w.effects.shake, 0.5);
        w.sfx.play('bc.jumpIn');
        s.stage = 'arrive';
        s.left = STRIKE_JUMP.arrive;
        this.onStrike?.('arrived');
        return;
      case 'arrive': {
        const k = THREE.MathUtils.clamp(1 - s.left / STRIKE_JUMP.arrive, 0, 1);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        this.stretch = STRETCH + (1 - STRETCH) * e;
        this.model.fx.z = 0.9 * (1 - e);
        if (s.left <= 0) {
          this.stretch = 1;
          this.model.fx.z = 0;
          s.stage = 'engage';
          s.left = this.strikeRules!.seconds;
        }
        return;
      }
      case 'engage': {
        // Hanging over the fight, drifting a little.
        this.angle += dt * 0.05;
        const c = this.over(s.at);
        const want = c.add(new THREE.Vector3(Math.cos(this.angle) * 25, 0, Math.sin(this.angle) * 25));
        this.position.lerp(want, 1 - Math.exp(-dt * 0.4));
        // The Keel Gun first, at the toughest thing there.
        if (!s.keelGun && s.left < this.strikeRules!.seconds - 1.2) {
          s.keelGun = true;
          let big: Entity | null = null;
          for (const e of this.inReach(s.at, this.strikeRules!.radius)) if (e.maxHp >= KEEL_GUN_WORTHY && (!big || e.maxHp > big.maxHp)) big = e;
          if (big) this.request(big, big.center(new THREE.Vector3()), null);
        }
        if (s.left <= 0) {
          s.stage = 'leave';
          this.rechargeLeft = this.strikeRules!.recharge;
          this.batteryOn.fill(null);
          this.incoming.clear();
          this.onStrike?.('leaving');
        }
        return;
      }
      case 'leave': {
        // Home to its post, under way: it comes round and flies off.
        const p = this.postAt();
        const to = new THREE.Vector3(p.x - this.position.x, 0, p.z - this.position.z);
        const d = to.length();
        if (d < 60) {
          this.strike = null;
          this.onStrike?.('home');
          return;
        }
        this.turn(Math.atan2(to.x, to.z), RETURN_TURN, dt);
        this.position.addScaledVector(to.divideScalar(d), Math.min(d, RETURN_SPEED * dt));
        this.position.y += (ALTITUDE - this.position.y) * (1 - Math.exp(-dt));
        return;
      }
    }
  }

  /** Enemies round `at` within `radius` (ground and air alike). */
  private inReach(at: THREE.Vector3, radius: number): Entity[] {
    return this.world.unitsNear(at.x, at.z, radius, []).filter((e) => e.team !== 'holdouts' && e.targetable && !e.ignored);
  }

  /**
   * A strike's batteries: each at the data's rate (the ATS's at the ground, the ATA's at flyers),
   * each on a target of its own, spreading over everything round the mark; bolts from hardpoints
   * all along the hull.
   */
  private strikeBatteries(dt: number) {
    const s = this.strike;
    const r = this.strikeRules;
    if (!s || !r || s.stage !== 'engage') return;
    this.lookIn -= dt;
    if (this.lookIn <= 0) {
      this.lookIn = 0.3;
      let found = this.inReach(s.at, r.radius);
      // Nothing at the mark: whatever's nearest it, a little further out.
      if (!found.length) found = this.inReach(s.at, r.radius * 1.8);
      this.around = found.sort((a, b) => Math.hypot(a.position.x - s.at.x, a.position.z - s.at.z) - Math.hypot(b.position.x - s.at.x, b.position.z - s.at.z));
    }
    // A target already has what will kill it in bolts still falling: the next one.
    const doomed = (e: Entity) => (this.incoming.get(e) ?? 0) >= e.hp;
    for (let i = 0; i < r.batteries; i++) {
      this.batteryLeft[i] = (this.batteryLeft[i] ?? Math.random() * 0.2) - dt;
      if (this.batteryLeft[i] > 0) continue;
      let t = this.batteryOn[i];
      if (!t?.targetable || doomed(t) || Math.hypot(t.position.x - s.at.x, t.position.z - s.at.z) > r.radius * 1.9) {
        t =
          this.around.find((e) => e.targetable && !doomed(e) && !this.batteryOn.includes(e)) ??
          this.around.find((e) => e.targetable && !doomed(e)) ??
          null;
        this.batteryOn[i] = t;
      }
      if (!t) {
        this.batteryLeft[i] = 0.15;
        continue;
      }
      const battery = t.flying ? (this.kind.antiAir ?? this.kind.weapon!) : this.kind.weapon!;
      this.batteryLeft[i] = battery.period * (0.85 + Math.random() * 0.3);
      this.bolt(t, battery, i, undefined, r.damage);
    }
  }

  /**
   * A battery bolt from hardpoint `i` (picked at random among the hull's, so bolts leave from
   * all along it) to `t`: the laser bolt flying with the missile's glowing head, and the battery's
   * impact model, its damage and its sound as it lands.
   */
  private bolt(t: Entity, battery: Weapon, i: number, landing?: (e: Entity, wasAlive: boolean) => (() => void) | void, scale = 1) {
    const w = this.world;
    // The bolt's damage (a strike's batteries hit harder: the rules' multiple), and what it'll do
    // to this target after its armor, counted against it until it lands.
    const damage: DamageStats = scale === 1 ? battery.damage : { ...battery.damage, amount: battery.damage.amount * scale, bonus: Object.fromEntries(Object.entries(battery.damage.bonus).map(([k, v]) => [k, v * scale])) };
    const expected = hitDamage(damage, t.kind.attributes, t.kind.armor);
    const incoming = this.incoming;
    incoming.set(t, (incoming.get(t) ?? 0) + expected);
    const from = this.hardpoint(i + Math.floor(Math.random() * this.hardpoints.length), new THREE.Vector3());
    const to = t.center(new THREE.Vector3());
    to.x += (Math.random() - 0.5) * t.radius * 0.6;
    to.z += (Math.random() - 0.5) * t.radius * 0.6;
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    const look = this.boltLook;
    if (look.texture) w.effects.bolt(from, to, look.texture, BOLT.width, BOLT.length, BOLT.speed, 0xffffff, BOLT.glow);
    else w.effects.bullet(from, to, 0xff9a3a, BOLT.width * 0.5, BOLT.speed, BOLT.length);
    // The missile model rides the bolt for its glowing head.
    const head: EffectModel | null = look.head ? w.fx.carry(look.head, from, dir.clone().multiplyScalar(BOLT.speed), w.effectScale * BOLT.head) : null;
    w.sfx.play(t.flying ? 'bc.battery' : 'bc.ground', { at: from });
    const impact = this.kind.def.effects?.impact;
    const total = from.distanceTo(to) / BOLT.speed;
    let flown = 0;
    w.timed.push({
      done: false,
      update(dt: number) {
        flown += dt;
        head?.moveTo(v.copy(from).addScaledVector(dir, Math.min(flown, total) * BOLT.speed), dir);
        if (flown < total || this.done) return;
        this.done = true;
        head?.stop();
        // The battery's impact model (the kind's `effects.impact`), at the infantry's effect scale and half again.
        if (impact) w.playEffect(impact, to, from, w.effectScale * 1.5);
        else w.effects.flash(to, 3, 0xffc070, 0.08, 0, true);
        const left = (incoming.get(t) ?? 0) - expected;
        if (left > 0.01) incoming.set(t, left);
        else incoming.delete(t);
        if (!t.targetable) return;
        const after = landing?.(t, t.alive);
        t.hit(damage, null);
        after?.();
      },
    });
  }

  /** Where a battery hardpoint is now (the hull's Ref_Weapon attachments), or a spot along the hull. */
  private hardpoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.hardpoints.length;
    if (n) {
      if (!this.posed) {
        this.model.object.updateMatrixWorld(true);
        this.posed = true;
      }
      return this.hardpoints[i % n].getWorldPosition(out);
    }
    const along = (Math.random() - 0.5) * 380;
    return out.set(this.position.x + Math.sin(this.heading) * along, this.position.y - 30, this.position.z + Math.cos(this.heading) * along);
  }

  update(dt: number) {
    if (this.controlled) {
      if (this.strike) this.abortStrike();
      // The captain's helm: throttle, heading and altitude.
      const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
      this.position.addScaledVector(fwd, this.throttle * CRUISE_SPEED * dt);
      this.position.y = THREE.MathUtils.clamp(this.position.y + this.climb * 40 * dt, 300, 700);
    } else if (this.strike) {
      this.updateStrike(dt);
    } else if (this.strikeRules) {
      this.keepPost(dt);
    } else {
      // Station keeping: a slow circuit around the base, or wherever the commander sent it.
      const c = this.station ?? this.home();
      const radius = this.station ? 160 : ORBIT_RADIUS;
      const r = Math.hypot(this.position.x - c.x, this.position.z - c.z);
      this.angle = Math.atan2(this.position.z - c.z, this.position.x - c.x) + (dt * 8) / Math.max(r, 1);
      const want = new THREE.Vector3(c.x + Math.cos(this.angle) * radius, ALTITUDE, c.z + Math.sin(this.angle) * radius);
      this.position.lerp(want, 1 - Math.exp(-dt * 0.15));
      const tangent = Math.atan2(-Math.sin(this.angle), Math.cos(this.angle));
      let d = tangent - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += THREE.MathUtils.clamp(d, -TURN_RATE * dt, TURN_RATE * dt);
    }
    this.place();
    this.animate(dt);
    this.model.update(dt);
    this.posed = false;
    if (this.emitters && this.model.object.visible) this.emitters.update(dt, this.model.clip, this.model.time, this.model.looping, this);
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    this.jumpLeft = Math.max(0, this.jumpLeft - dt);
    // The recharge runs once it's pulled out of a strike.
    if (!this.striking) this.rechargeLeft = Math.max(0, this.rechargeLeft - dt);
    this.updateJump(dt);
    this.updateBatteries(dt);
    this.strikeBatteries(dt);
    this.updateKeelGun(dt);
  }

  /** ATS Laser Batteries: one bolt every weapon period at the best target within reach. */
  private updateBatteries(dt: number) {
    const w = this.world;
    const weapon = this.kind.weapon!;
    this.batteryCooldown -= dt;
    if (this.batteryCooldown > 0 || this.jump) return;
    // A call-in's batteries fire on its strikes (strikeBatteries), not between them.
    if (this.strikeRules && !this.controlled) return;
    const ground = new THREE.Vector3(this.position.x, 0, this.position.z);
    // Where to look for targets, and how far from there.
    let near = ground;
    let radius = BATTERY_REACH;
    if (this.focusPoint) {
      near = this.focusPoint;
      radius = this.focusRadius;
    } else if (!this.controlled && this.holdFire) {
      return;
    } else if (!this.controlled) {
      near = this.station ?? this.home();
      radius = this.station ? STATION_RADIUS : this.world.perimeter;
    }
    const t0 = this.target;
    if (!t0?.targetable || Math.hypot(t0.position.x - near.x, t0.position.z - near.z) > radius) {
      this.target = w.nearestEnemy('holdouts', near.x, near.z, radius);
    }
    const t = this.target;
    if (!t?.targetable || Math.hypot(t.position.x - ground.x, t.position.z - ground.z) > BATTERY_REACH) return;
    // Flyers draw the ATA batteries, everything else the ATS.
    const battery = t.flying ? (this.kind.antiAir ?? weapon) : weapon;
    this.batteryCooldown = battery.period;
    // A captain gets the credit for what a bolt kills, as it lands.
    const captain = this.controlled;
    this.bolt(t, battery, Math.floor(Math.random() * 64), (e, wasAlive) => {
      if (!captain) return;
      this.onBatteryStrike?.(e);
      return () => this.onBatteryHit?.(e, wasAlive && !e.alive);
    });
  }

  private updateJump(dt: number) {
    const j = this.jump;
    if (!j) return;
    j.left -= dt;
    if (Math.random() < 0.5) this.world.effects.flash(this.position, 120 + Math.random() * 80, 0x9ad0ff, 0.15, 0, true);
    if (j.left > 0) return;
    const w = this.world;
    w.effects.flash(this.position, 400, 0xbfe4ff, 0.4, 0, true);
    this.position.copy(j.to);
    w.effects.flash(this.position, 400, 0xbfe4ff, 0.6, 0, true);
    w.effects.shake = Math.max(w.effects.shake, 0.4);
    this.jump = null;
    this.jumpLeft = JUMP_COOLDOWN;
  }

  private updateKeelGun(dt: number) {
    const c = this.charge;
    if (!c) return;
    if (c.target?.alive) c.target.center(c.point);
    c.left -= dt;
    // A glow gathers at the bow while the cannon charges.
    const bow = this.bow(new THREE.Vector3());
    if (Math.random() < 0.6) this.world.effects.flash(bow, 18 + (1 - c.left / this.prep) * 30, 0xffa850, 0.1, 0, true);
    if (c.left > 0) return;

    this.charge = null;
    this.cooldownLeft = this.cooldown;
    const w = this.world;
    // A layered column of light: wide orange halo, hot inner glow, white core.
    w.effects.tracer(bow, c.point, 0xff7a20, 18, 1.0);
    w.effects.tracer(bow, c.point, 0xffb050, 8, 0.85);
    w.effects.tracer(bow, c.point, 0xfff2dc, 2.6, 0.7);
    w.effects.flash(bow, 90, 0xffc070, 0.45, 0, true);
    w.effects.flash(c.point, 40, 0xffb060, 0.5, 400, true);
    w.effects.explosion(c.point, 9);
    w.effects.shake += 0.8;
    w.sfx.play('bc.keelGunFire');
    w.sfx.play('explosion.shell', { at: c.point, volume: 1.4 });
    if (c.target?.alive) c.target.hit(this.stats.damage, c.source, 1, undefined, true);
    this.onFire?.(c.target);
  }

  /** The call-in on the HUD of whoever can call it (F): ready, inbound, on station, recharging. */
  callBar(): HudBar {
    const r = this.strikeRules;
    if (!r) return this.keelGunBar();
    {
      const s = this.strike;
      const text = !s
        ? this.rechargeLeft > 0
          ? `Recharging · ${clock(this.rechargeLeft)}`
          : 'Ready · calls it to your mark'
        : s.stage === 'spool' || s.stage === 'transit' || s.stage === 'arrive'
          ? 'Snap Jump…'
          : s.stage === 'engage'
            ? `On station · ${Math.ceil(s.left)}s`
            : 'Pulling out';
      const value = s?.stage === 'engage' ? s.left / r.seconds : s ? 1 : 1 - this.rechargeLeft / Math.max(r.recharge, r.first ?? 0);
      return { label: 'Lodestar', key: this.callKey, value, text, color: 'linear-gradient(90deg, #5aa8ff, #ffe0a0)' };
    }
  }

  keelGunBar(): HudBar {
    const ready = this.cooldownLeft <= 0 && !this.charge;
    return {
      label: 'Keel Gun',
      key: 'Q',
      value: 1 - this.cooldownLeft / this.cooldown,
      text: this.charge ? `Charging ${this.charge.left.toFixed(1)}s` : ready ? 'Ready' : `${Math.ceil(this.cooldownLeft)}s`,
      color: 'linear-gradient(90deg, #ff9a40, #ffe0a0)',
    };
  }
}

const SENSITIVITY = 0.0018;
/**
 * The chase camera orbits a point off the ship's right side, slightly above the hull, so the
 * line of sight down to the ground passes beside the ship rather than through it (the hull is
 * 560 m long; from straight behind it hides everything it is shooting at).
 */
const CAMERA_SIDE = 0.42;
const CAMERA_LIFT = 0.1;

/**
 * The player as the Warship's captain. The ship is slow to turn and enormous; the game
 * is where to put it and what to point it at: the batteries follow your mark, the Keel Gun
 * deletes one thing, and Snap Jump takes the ship anywhere on the map after four seconds.
 */
export class WarshipAvatar implements Avatar {
  readonly kind = 'warship';
  readonly entity = null;
  yaw: number;
  /** Looking well down by default: the batteries reach 520 m and the ship flies at 480. */
  pitch = -0.9;
  distance = 700;
  wantsCommand = false;
  holdFire = false;
  /** The ultimate (F, the Keel Gun): why it can't fire now, or null; that it was spent; its bar. */
  canUltimate: (() => string | null) | null = null;
  onUltimateRefused: ((why: string) => void) | null = null;
  onUltimate: ((seconds: number) => void) | null = null;
  ultimateBar: ((busy?: { value: number; text: string } | null) => HudBar | null) | null = null;
  private aimPoint = new THREE.Vector3();
  private aimEntity: Entity | null = null;

  constructor(
    readonly ship: Warship,
    private input: Input,
    private world: World,
    private camera: THREE.PerspectiveCamera,
    readonly stats: PlayerStats,
  ) {
    ship.controlled = true;
    this.yaw = ship.heading;
  }

  get position(): THREE.Vector3 {
    return this.ship.position;
  }

  get alive(): boolean {
    return this.ship.hp > 0;
  }

  tick(dt: number) {
    const ship = this.ship;
    const input = this.input;
    const { dx, dy, wheel } = input.consume();
    this.yaw -= dx * SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * SENSITIVITY, -1.4, -0.1);
    if (wheel) {
      this.distance += wheel * 70;
      if (this.distance > 1350) this.wantsCommand = true;
      this.distance = THREE.MathUtils.clamp(this.distance, 450, 1300);
    }
    ship.throttle = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 0.5 : 0);
    const steer = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    ship.heading += steer * TURN_RATE * dt;
    ship.climb = (input.down('Space') ? 1 : 0) - (input.down('ControlLeft') || input.down('KeyC') ? 1 : 0);

    // Where the captain is looking on the ground.
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const hit = this.world.raycast(origin, dir, 4000, (e) => e.team === 'holdouts');
    this.aimPoint.copy(hit ? hit.point : origin.addScaledVector(dir, 1500));
    this.aimEntity = hit?.entity ?? this.world.nearestEnemy('holdouts', this.aimPoint.x, this.aimPoint.z, 25);
    ship.focusPoint = input.mouse(0) && input.locked && !this.holdFire ? this.aimPoint.clone() : null;
    if (input.hit('KeyQ')) {
      const why = this.canUltimate?.() ?? null;
      if (why) this.onUltimateRefused?.(why);
      else if (ship.request(this.aimEntity, this.aimEntity ? this.aimEntity.center(new THREE.Vector3()) : this.aimPoint, null)) this.onUltimate?.(ship.prep + 3);
    }
    if (input.hit('KeyT')) ship.beginJump(this.aimPoint);
  }

  cameraPose(): CameraPose {
    // Over the ship's right shoulder: the hull sits to the left, the target below and ahead.
    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const pos = this.ship.position.clone().addScaledVector(fwd, -this.distance).addScaledVector(right, this.distance * CAMERA_SIDE);
    pos.y += this.distance * CAMERA_LIFT;
    const ground = this.world.terrain.heightAt(pos.x, pos.z) + 20;
    if (pos.y < ground) pos.y = ground;
    return lookAtPose(pos, pos.clone().add(fwd), 55);
  }

  hud(): AvatarHud {
    const ship = this.ship;
    const jumpReady = ship.jumpLeft <= 0 && !ship.jumping;
    return {
      title: 'Warship',
      hp: ship.hp,
      maxHp: ship.kind.maxHp,
      bars: [
        (ship.keelGunLeft !== null ? this.ultimateBar?.({ value: 1 - ship.keelGunLeft / ship.prep, text: `Charging ${ship.keelGunLeft.toFixed(1)}s` }) : this.ultimateBar?.()) ?? ship.keelGunBar(),
        {
          label: 'Snap Jump',
          key: 'T',
          value: 1 - ship.jumpLeft / JUMP_COOLDOWN,
          text: ship.jumping ? `Jumping in ${ship.jumping.toFixed(1)}s` : jumpReady ? 'Ready' : `${Math.ceil(ship.jumpLeft)}s`,
          color: 'linear-gradient(90deg, #5aa8ff, #bfe4ff)',
        },
      ],
      crosshair: 'battery',
      spread: 0.02,
      prompt: 'Left button directs the batteries · Q Keel Gun · T Snap Jump · W/S throttle · A/D turn · Space/C altitude',
    };
  }

  /**
   * Contact pips. From 500 m up a Hound is about a pixel, so the ship's sensors mark every
   * contact in view: small for the swarm, larger for anything big.
   */
  drawOverlay(g: CanvasRenderingContext2D, width: number, height: number) {
    const v = new THREE.Vector3();
    g.fillStyle = 'rgba(255, 72, 48, 0.9)';
    for (const e of this.world.entities) {
      if (e.team === 'holdouts' || e.ignored || !e.targetable) continue;
      e.center(v).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const s = e.radius > 2.5 ? 9 : e.radius > 0.9 ? 6 : 4;
      g.fillRect(((v.x + 1) / 2) * width - s / 2, ((1 - v.y) / 2) * height - s / 2, s, s);
    }
  }

  release() {
    this.ship.controlled = false;
    this.ship.focusPoint = null;
    this.ship.throttle = 0;
    this.ship.climb = 0;
  }
}

/** Seconds as m:ss past a minute ("2:30"), as seconds below it ("45s"). */
function clock(seconds: number): string {
  const t = Math.ceil(seconds);
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`;
}
