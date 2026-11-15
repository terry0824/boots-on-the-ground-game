import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import type { ModelInstance, ModelTemplate } from '../engine/model.ts';
import { Squad, SquadBrain, CrawlBrain } from './brains.ts';
import { FASTER } from './stats.ts';
import type { Controller, Entity, Unit } from './entity.ts';
import type { IconName } from './icons.ts';
import { RANGE_METERS_PER_CELL, type KindName } from './kinds.ts';
import { walkableNear } from './script.ts';
import { walkTo } from './systems/economy.ts';
import { TankBrain } from './tank.ts';
import { HeroVisual } from './visual.ts';
import { TEAM_COLOR, type World } from './world.ts';

export type CallInId = 'skyscan' | 'mender' | 'dustoff' | 'tank';

export interface CallInDef {
  id: CallInId;
  name: string;
  desc: string;
  icon: IconName;
  /** Rank that unlocks it. */
  rank: number;
  /** Skywatch energy it costs (Skyscan, Mender), or a cooldown in real seconds. */
  energy?: number;
  cooldown?: number;
  /** Marker color. */
  color: number;
}

/**
 * The call-ins: the Skywatch's Skyscan and Mender (paid in its energy, at the data's costs),
 * and the Lodestar's dropships, a Dustoff with a fireteam or a Howitzer.
 */
export const CALL_INS: CallInDef[] = [
  { id: 'skyscan', name: 'Skyscan', desc: 'Reveals the area: every enemy marked, burrowed Crawl flushed out', icon: 'skyscan', rank: 0, energy: 50, color: 0x7cffb0 },
  { id: 'mender', name: 'Mender', desc: 'Dropped from orbit; repairs bunkers, turrets and tanks nearby', icon: 'mender', rank: 1, energy: 50, color: 0xffd060 },
  { id: 'dustoff', name: 'Dustoff: Fireteam', desc: 'Four Troopers dropped where you mark; they follow you', icon: 'dustoff', rank: 2, cooldown: 75, color: 0x6cc8ff },
  { id: 'tank', name: 'Dustoff: Howitzer', desc: 'A Howitzer dropped where you mark; take it with F', icon: 'howitzer', rank: 4, cooldown: 150, color: 0xff9a50 },
];

/** How far a dropship flies in from, meters. */
const APPROACH = 340;
/** Seconds a Dustoff stays over a drop afterwards, healing the wounded below. */
const DUSTOFF_LINGER = 14;
/** How far it looks for the wounded, meters (beyond its heal reach: it drifts over to them). */
const DUSTOFF_SEARCH = 45;
/** A Mender's repair rate, life per real second (about what a Rigger manages on a bunker). */
const REPAIR_RATE = 14;

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();

/**
 * A Dustoff on a drop: flies in to the mark, hovers while its cargo goes down one by one,
 * stays a while to heal the wounded below (the Dustoff's own heal, at the data's rate), then
 * climbs away and leaves the battle.
 */
class DropshipBrain implements Controller {
  private stage: 'inbound' | 'unloading' | 'healing' | 'outbound' = 'inbound';
  private next = 0.6;
  private away = new THREE.Vector3();
  private linger = DUSTOFF_LINGER;
  private idle = 0;
  private patient: Entity | null = null;
  private beam = 0;

  constructor(
    private u: Unit,
    private target: THREE.Vector3,
    private cargo: KindName[],
    private onCargo: (kind: KindName, at: THREE.Vector3) => void,
  ) {
    this.away.copy(u.position);
  }

  /**
   * Who to heal next, around the drop: the worst hurt (the downed first: they're at a sliver),
   * a little less keen on the ones it would have to fly furthest for.
   */
  private wounded(): Entity | null {
    const u = this.u;
    let best: Entity | null = null;
    let bestScore = Infinity;
    for (const e of u.world.unitsNear(this.target.x, this.target.z, DUSTOFF_SEARCH)) {
      if (e === u || e.team !== u.team || !e.targetable || !e.kind.attributes.includes('Biological')) continue;
      const f = e.hp / e.maxHp;
      if (f >= 0.97) continue;
      const score = f + Math.hypot(e.position.x - u.position.x, e.position.z - u.position.z) / 150;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  /** Over the wounded, healing one at a time; gone when the time's up or nobody needs it. */
  private heal(dt: number) {
    const u = this.u;
    const w = u.world;
    this.linger -= dt;
    if (!this.patient?.targetable || this.patient.hp >= this.patient.maxHp) this.patient = this.wounded();
    const p = this.patient;
    const reach = Math.max(w.medicHeal.range, 4 * RANGE_METERS_PER_CELL);
    if (p) {
      this.idle = 0;
      const dx = p.position.x - u.position.x;
      const dz = p.position.z - u.position.z;
      const d = Math.hypot(dx, dz);
      // Drift over them, slowly; heal once in reach.
      u.move.set(dx, dz).multiplyScalar(d > reach * 0.5 ? 0.45 / Math.max(1, d) : 0);
      if (d <= reach) {
        p.hp = Math.min(p.maxHp, p.hp + w.medicHeal.rate * dt);
        this.beam -= dt;
        if (this.beam <= 0) {
          this.beam = 0.08;
          w.effects.tracer(u.center(v1).add(v2.set(0, -1.5, 0)), p.center(v2), 0x9fffc0, 0.08, 0.08);
        }
      }
    } else {
      this.idle += dt;
      u.move.set(0, 0);
    }
    if (this.linger <= 0 || this.idle > 3) {
      this.stage = 'outbound';
      w.audio.play('dustoffEngine', { at: u.position, volume: 0.7, near: 30 });
    }
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    const goal = this.stage === 'outbound' ? this.away : this.target;
    const dx = goal.x - u.position.x;
    const dz = goal.z - u.position.z;
    const d = Math.hypot(dx, dz);
    u.face = null;
    // Afterburners in and out (the Dustoff's own burst of speed), a hover over the drop.
    u.speedMul = this.stage === 'unloading' ? 1 : 2.4;
    if (this.stage === 'inbound') {
      // Ease in over the mark.
      u.move.set(dx, dz).normalize().multiplyScalar(Math.min(1, d / 40));
      if (d < 5) this.stage = 'unloading';
      return;
    }
    if (this.stage === 'unloading') {
      u.move.set(dx, dz).multiplyScalar(0.05);
      this.next -= dt;
      if (this.next <= 0) {
        const kind = this.cargo.shift();
        if (kind) {
          this.next = 0.45;
          const at = walkableNear(w, this.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8)), 2);
          this.onCargo(kind, at);
          w.audio.play('dustoffUnload', { at, volume: 0.8, near: 20 });
          w.effects.smoke(at, 2.5, 0x8a7a68, 1.5);
        } else this.stage = 'healing';
      }
      return;
    }
    if (this.stage === 'healing') return this.heal(dt);
    u.move.set(dx, dz).normalize();
    if (d < 20) w.despawn(u);
  }
}

/**
 * The Skywatch's Mender: it lands, finds the most damaged machine or building nearby
 * that can be repaired, and works on it until its power cell runs out.
 */
class MenderBrain implements Controller {
  private target: Entity | null = null;
  private retarget = 0;
  /** Where it is in its work, as its model plays it: starting, a cycle at a time (a pause between), or packing up. */
  private work: 'off' | 'start' | 'cycle' | 'pause' = 'off';
  private workLeft = 0;

  constructor(
    private u: Unit,
    private home: THREE.Vector3,
    private spare: (e: Entity) => boolean,
  ) {
    u.customAnimation = true;
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.alive || this.target.hp >= this.target.maxHp) {
      this.retarget = 1;
      this.target = null;
      let worst = 0.999;
      for (const e of w.entities) {
        if (!e.alive || e.team !== u.team || e === u || this.spare(e)) continue;
        const machine = e.isBuilding || e.kind.attributes.includes('Mechanical');
        if (!machine || e.kind.name === 'dustoff') continue;
        if (Math.hypot(e.position.x - this.home.x, e.position.z - this.home.z) > 45) continue;
        const f = e.hp / e.maxHp;
        if (f < worst) {
          worst = f;
          this.target = e;
        }
      }
    }
    const t = this.target;
    u.face = null;
    if (!t || u.gap(t) > 2) {
      // Packing up, then off to the next (round the buildings, by the ground's paths).
      if (this.work !== 'off') {
        this.work = 'off';
        u.visual.play('Stand Work End', { loop: false, restart: true });
      }
      if (!t) {
        u.move.set(0, 0);
        if (u.visual.animation !== 'Stand Work End') u.visual.play('Stand');
        return;
      }
      walkTo(u, t.position, t.radius + u.radius + 1.5, w.pathsTo(t.position, t.radius));
      return;
    }
    // At work, as its model plays it: Stand Work Start, then a Stand Work cycle at a time, each
    // with the weld's sound (a pause between), its own sparks flying from the model; the target
    // mended at the repair rate all the while.
    u.move.set(0, 0);
    u.face = Math.atan2(t.position.x - u.position.x, t.position.z - u.position.z);
    t.hp = Math.min(t.maxHp, t.hp + REPAIR_RATE * dt);
    this.workLeft -= dt;
    if (this.work === 'off') {
      this.work = 'start';
      this.workLeft = u.visual.play('Stand Work Start', { loop: false, restart: true }) / FASTER || 0.3;
    } else if (this.workLeft <= 0 && (this.work === 'start' || this.work === 'pause')) {
      this.work = 'cycle';
      this.workLeft = u.visual.play('Stand Work', { loop: false, restart: true, timeScale: FASTER }) / FASTER || 0.6;
      w.audio.play('repair', { at: u.position, volume: 0.6, near: 12, limit: 3 });
    } else if (this.workLeft <= 0 && this.work === 'cycle') {
      this.work = 'pause';
      this.workLeft = (Math.random() * 0.3) / FASTER;
    }
  }
}

/** The Mender's pod at the size of the Mender it carries: the Mender is drawn at 0.85 of its model and the pod at 1. */
const POD_PER_MENDER = 1 / 0.85;
/** Where the pod's own fall starts, in its model at no turn (up and out from where it lands): its heading from the landing. */
const POD_FROM = Math.atan2(-9.87, -9.45);

/**
 * The Mender's call-down: its drop pod falls from orbit along its own animation (Birth: a streak
 * of fire, retro jets, the landing in a burst of dust and smoke) into view, from beyond the mark
 * as the player sees it, to the roar of its drop and its impact; it sits steaming until the
 * Mender comes out (the data's delay after the call), then bursts open (Death) and is gone as
 * the Mender goes to work.
 */
class DropPod {
  done = false;
  private t = 0;
  private stage: 'falling' | 'landed' | 'open' = 'falling';
  private impact = false;
  private visual: HeroVisual;

  constructor(
    private w: World,
    private at: THREE.Vector3,
    /** The heading the pod comes in from (it lands toward the opposite way). */
    from: number,
    private reveal: number,
    private onReveal: () => void,
  ) {
    const t = w.models.dropPod!;
    this.visual = new HeroVisual(t.instantiate(TEAM_COLOR.holdouts, true), w.scene);
    this.visual.play('Birth', { loop: false, fade: 0, timeScale: FASTER });
    // The highest of the ground round it (its site op's), so it never sinks in.
    const s = w.scaleOf('mender') * POD_PER_MENDER;
    let y = -Infinity;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) y = Math.max(y, w.terrain.heightAt(at.x + dx * 0.2 * s, at.z + dz * 0.2 * s));
    this.at = at.clone().setY(y);
    this.visual.sync(this.at, from - POD_FROM, s);
    this.visual.update(0);
    w.audio.play('menderDrop', { at: this.at, volume: 0.9, near: 60 });
  }

  update(dt: number) {
    if (this.done) return;
    this.t += dt;
    const w = this.w;
    // Its impact as it touches down (2.1 s into the fall), felt nearby.
    if (!this.impact && this.t >= 2.1 / FASTER) {
      this.impact = true;
      w.audio.play('menderImpact', { at: this.at, volume: 1, near: 40 });
      const body = w.player;
      if (body && body.position.distanceTo(this.at) < 40) w.effects.shake = Math.max(w.effects.shake, 0.25);
    }
    if (this.stage === 'falling' && this.t >= 3.267 / FASTER) {
      this.stage = 'landed';
      this.visual.play('Stand', { fade: 0, timeScale: FASTER });
    }
    if (this.stage !== 'open' && this.t >= this.reveal) {
      this.stage = 'open';
      this.visual.play('Death', { loop: false, fade: 0, timeScale: FASTER });
      this.onReveal();
    }
    if (this.stage === 'open' && this.t >= this.reveal + 6.333 / FASTER) {
      this.done = true;
      this.visual.dispose();
      return;
    }
    this.visual.update(dt);
  }
}

/** The scanner's ring on the ground, an effect model of its own, for as long as the sweep lasts. */
class SkyscanVisual {
  done = false;
  private t = 0;
  private dying = false;

  constructor(
    private scene: THREE.Scene,
    private instance: ModelInstance | null,
    private duration: number,
  ) {
    if (instance) {
      scene.add(instance.object);
      instance.play('Birth', { loop: false });
    }
  }

  update(dt: number) {
    this.t += dt;
    const i = this.instance;
    if (i) {
      if (this.t > 0.55 && !this.dying && this.t < this.duration - 0.5) i.play('Stand');
      if (this.t >= this.duration - 0.5 && !this.dying) {
        this.dying = true;
        i.play('Death', { loop: false });
      }
      i.update(dt);
    }
    if (this.t >= this.duration) {
      if (i) this.scene.remove(i.object);
      this.done = true;
    }
  }
}

export interface CallInState {
  energy: number;
  energyMax: number;
  items: { def: CallInDef; locked: boolean; ready: boolean; wait: string }[];
  menu: boolean;
  selected: number;
  armed: CallInDef | null;
}

/**
 * Call-ins, Helldivers style: hold T for the menu, flick the mouse toward one, let go, and mark
 * the ground with a click. The Skywatch's energy pays for the sweep and the Mender; the
 * dropships have cooldowns.
 */
export class CallIns {
  energy: number;
  readonly energyMax: number;
  private regen: number;
  private skyscanRadius: number;
  private skyscanDuration: number;
  private menderLife: number;
  /** Real seconds from the call to the Mender coming out of its pod. */
  private menderDelay: number;
  /** Where the player looks from (the camera), for a pod to fall into view. */
  private eye: THREE.Vector3 | null = null;
  private cooldowns = new Map<CallInId, number>();
  menu = false;
  selected = -1;
  armed: CallInDef | null = null;
  /** Where the crosshair meets the ground while marking, or null off the map. */
  readonly mark = new THREE.Vector3();
  markValid = false;
  private aim = new THREE.Vector2();
  private marker: THREE.Group;
  private markerRing: THREE.Mesh;
  private markerBeam: THREE.Mesh;
  private markerT = 0;
  /** Skyscans in effect: everything hostile inside is marked through walls. */
  readonly reveals: { at: THREE.Vector3; radius: number; until: number }[] = [];
  readonly squad: Squad;
  /** Messages for the HUD ("Dustoff inbound"). */
  onMessage: ((text: string, sub: string) => void) | null = null;
  /** The call-ins this mission offers (its rules; all of them by default), in the menu's order. */
  readonly offered: CallInDef[];

  constructor(
    private world: World,
    private rank: () => number,
    data: ReturnType<import('./stats.ts').Stats['orbital']>,
    private skyscanModel: ModelTemplate | null,
    /** The body the player is in (for the fireteam to follow). */
    leader: () => Entity | null,
    /** Buildings the Mender leaves alone (the Forebear artifact). */
    private spare: (e: Entity) => boolean = () => false,
    offered?: CallInId[],
  ) {
    this.offered = offered ? CALL_INS.filter((d) => offered.includes(d.id)) : CALL_INS;
    this.energy = data.energy.start;
    this.energyMax = data.energy.max;
    this.regen = data.energy.regen * FASTER;
    // A sweep reveals in map cells; the battlefield is laid out at 6 m a cell.
    this.skyscanRadius = data.skyscan.radius * 6;
    this.skyscanDuration = data.skyscan.duration / FASTER;
    this.menderLife = data.mender.life / FASTER;
    this.menderDelay = data.mender.delay / FASTER;
    this.squad = new Squad(leader);
    this.marker = new THREE.Group();
    const ring = new THREE.RingGeometry(0.88, 1, 64);
    ring.rotateX(-Math.PI / 2);
    this.markerRing = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.markerBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 120, 12, 1, true),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.markerBeam.position.y = 60;
    this.marker.add(this.markerRing, this.markerBeam);
    this.marker.visible = false;
    world.scene.add(this.marker);
  }

  private cost(def: CallInDef): number {
    return def.energy ?? 0;
  }

  locked(def: CallInDef): boolean {
    return this.rank() < def.rank;
  }

  ready(def: CallInDef): boolean {
    return !this.locked(def) && this.energy >= this.cost(def) && (this.cooldowns.get(def.id) ?? 0) <= 0;
  }

  /** What the HUD shows: the energy, every call-in's state, the menu and what's being marked. */
  state(): CallInState {
    return {
      energy: this.energy,
      energyMax: this.energyMax,
      items: this.offered.map((def) => {
        const cd = this.cooldowns.get(def.id) ?? 0;
        const wait = this.locked(def) ? 'Locked' : cd > 0 ? `${Math.ceil(cd)}s` : def.energy && this.energy < def.energy ? `${def.energy} energy` : 'Ready';
        return { def, locked: this.locked(def), ready: this.ready(def), wait };
      }),
      menu: this.menu,
      selected: this.selected,
      armed: this.armed,
    };
  }

  /**
   * Input, before the player's body reads it: T opens the menu (and takes the mouse for
   * choosing), letting go arms the choice; then a click calls it in and right-click cancels.
   */
  update(dt: number, input: Input, camera: THREE.Camera, body: { holdFire: boolean } | null) {
    const w = this.world;
    this.eye = camera.getWorldPosition(this.eye ?? new THREE.Vector3());
    this.energy = Math.min(this.energyMax, this.energy + this.regen * dt);
    for (const [id, t] of this.cooldowns) this.cooldowns.set(id, Math.max(0, t - dt));
    this.squad.update();

    if (!body) {
      this.menu = false;
      this.armed = null;
      this.marker.visible = false;
      return;
    }
    if (input.down('KeyT') && !this.armed) {
      if (!this.menu) {
        this.menu = true;
        this.aim.set(0, 0);
        this.selected = -1;
      }
      const m = input.consume();
      this.aim.x += m.dx;
      this.aim.y += m.dy;
      if (this.aim.length() > 120) this.aim.setLength(120);
      // Four wedges: up, right, down, left.
      if (this.aim.length() > 18) {
        const a = Math.atan2(this.aim.x, -this.aim.y);
        this.selected = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
      }
      for (let i = 0; i < this.offered.length; i++) if (input.hit(`Digit${i + 1}`)) this.selected = i;
    } else if (this.menu) {
      this.menu = false;
      const def = this.offered[this.selected];
      if (def && this.ready(def)) {
        this.armed = def;
        w.sfx.play('ui.select');
      } else if (def) w.sfx.play('ui.click');
    }

    body.holdFire = !!this.armed || (body.holdFire && input.mouse(0));
    if (!this.armed) {
      this.marker.visible = false;
      return;
    }
    // Where the crosshair meets the ground.
    const origin = camera.getWorldPosition(v1);
    const dir = camera.getWorldDirection(v2);
    const dist = w.terrain.raycast(origin, dir, 600);
    this.markValid = dist !== null && w.terrain.playable(origin.x + dir.x * dist, origin.z + dir.z * dist);
    if (dist !== null) this.mark.copy(origin).addScaledVector(dir, dist);
    this.markerT += dt;
    const def = this.armed;
    const color = new THREE.Color(this.markValid ? def.color : 0xff4a3a);
    (this.markerRing.material as THREE.MeshBasicMaterial).color.copy(color);
    (this.markerBeam.material as THREE.MeshBasicMaterial).color.copy(color);
    const r = def.id === 'skyscan' ? this.skyscanRadius : 8;
    this.markerRing.scale.setScalar(r * (1 + 0.05 * Math.sin(this.markerT * 6)));
    this.marker.position.copy(this.mark).setY(this.mark.y + 0.3);
    this.marker.visible = dist !== null;
    if (input.mouseHit(2) || input.hit('Escape')) {
      this.armed = null;
      this.marker.visible = false;
      return;
    }
    if (input.mouseHit(0) && this.markValid) {
      this.call(def, this.mark.clone());
      this.armed = null;
      this.marker.visible = false;
    }
  }

  /** Calls one in at `at` (the ground), paying for it. */
  call(def: CallInDef, at: THREE.Vector3) {
    if (!this.ready(def)) return;
    this.energy -= this.cost(def);
    if (def.cooldown) this.cooldowns.set(def.id, def.cooldown);
    const w = this.world;
    w.sfx.play('ui.select');
    switch (def.id) {
      case 'skyscan':
        this.skyscan(at);
        break;
      case 'mender':
        this.dropMender(at);
        break;
      case 'dustoff':
        this.dropship(at, ['trooper', 'trooper', 'trooper', 'trooper']);
        this.onMessage?.('DUSTOFF INBOUND', 'A fireteam is on its way to your mark');
        break;
      case 'tank':
        this.dropship(at, ['howitzerMobile']);
        this.onMessage?.('DUSTOFF INBOUND', 'A Howitzer is on its way to your mark');
        break;
    }
  }

  private skyscan(at: THREE.Vector3) {
    const w = this.world;
    this.reveals.push({ at: at.clone(), radius: this.skyscanRadius, until: w.time + this.skyscanDuration });
    w.audio.play('skyscan', { volume: 0.9, bus: 'ui' });
    // The sweep's ring, an effect model of its own, laid on the ground at the sweep's size.
    if (this.skyscanModel) {
      const inst = this.skyscanModel.instantiate(new THREE.Color(0x7cffb0));
      const s = this.skyscanRadius / 5.39;
      inst.object.scale.setScalar(s);
      inst.object.position.copy(at).setY(at.y - 2.92 * s + 1);
      w.timed.push(new SkyscanVisual(w.scene, inst, this.skyscanDuration));
    }
    // Detection: burrowed Crawl inside are flushed out.
    for (const e of w.entities) {
      if (!e.alive || !e.stowed || e.team === 'holdouts' || e.isBuilding) continue;
      if (Math.hypot(e.position.x - at.x, e.position.z - at.z) > this.skyscanRadius) continue;
      e.stowed = false;
      w.effects.smoke(e.position, 1.6, 0x6a5a40, 1.4);
      e.setController(new CrawlBrain(e as Unit));
    }
    this.onMessage?.('SKYSCAN', 'Hostiles in the area are marked');
  }

  private dropMender(at: THREE.Vector3) {
    const w = this.world;
    const spare = this.spare;
    const menderLife = this.menderLife;
    const land = walkableNear(w, at, 2);
    if (w.models.dropPod) {
      // In its pod, from beyond the mark as the player sees it (a little to one side), so it
      // streaks down into view; the Mender out as the pod opens, its power cell running from then.
      const eye = this.eye ?? land;
      const from = Math.atan2(land.x - eye.x, land.z - eye.z) + (Math.random() - 0.5) * 1.4;
      const spawn = () => {
        const mender = w.spawnUnit('mender', land.x, land.z, from + Math.PI, (u) => new MenderBrain(u, land, spare));
        mender.expires = w.time + menderLife;
        w.audio.play('menderReady', { volume: 0.8, bus: 'voice' });
      };
      w.timed.push(new DropPod(w, land, from, this.menderDelay, spawn));
      return;
    }
    // A streak from orbit, then the landing.
    const top = land.clone().add(new THREE.Vector3(30, 220, -20));
    w.effects.tracer(top, land, 0xffe0a0, 0.6, 0.5);
    w.timed.push({
      done: false,
      t: 0,
      update(dt: number) {
        this.t += dt;
        if (this.t < 0.5 || this.done) return;
        this.done = true;
        w.effects.flash(land.clone().setY(land.y + 2), 8, 0xffd090, 0.25, 40);
        w.effects.smoke(land, 4, 0x8a7a68, 2.5);
        w.effects.shake = Math.max(w.effects.shake, 0.15);
        w.sfx.play('explosion.shell', { at: land, volume: 0.4 });
        const mender = w.spawnUnit('mender', land.x, land.z, Math.random() * Math.PI * 2, (u) => new MenderBrain(u, land, spare));
        mender.expires = w.time + menderLife;
      },
    } as { done: boolean; t: number; update(dt: number): void });
  }

  private dropship(mark: THREE.Vector3, cargo: KindName[]) {
    const w = this.world;
    // Down where they can join the player: a mark on a plateau no ramp reaches, in a chasm or on
    // the lava left them stranded there for good. The nearest ground that does, otherwise.
    const at = this.joinable(mark);
    // In from behind the player's lines (the base, where there is one), not over the enemy.
    const base = w.goal?.alive ? w.goal.position : null;
    const away = base && base.distanceTo(at) > 20 ? new THREE.Vector3(base.x - at.x, 0, base.z - at.z).normalize() : new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    const from = at.clone().addScaledVector(away, APPROACH);
    for (let i = 0; i < 30 && !w.terrain.playable(from.x, from.z); i++) from.lerp(at, 0.1);
    const ship = w.spawnUnit('dustoff', from.x, from.z, Math.atan2(at.x - from.x, at.z - from.z), (u) =>
      new DropshipBrain(u, at, [...cargo], (kind, spot) => {
        w.spawnUnit(kind, spot.x, spot.z, u.yaw, (x) => (kind === 'howitzerMobile' ? new TankBrain(x, spot.clone()) : new SquadBrain(x, this.squad)));
        w.effects.flash(spot.clone().setY(spot.y + 1), 3, 0x9fd0ff, 0.15);
      }),
    );
    w.audio.play('dustoffEngine', { at: ship.position, volume: 0.6, near: 40 });
  }

  /** The nearest walkable ground to `mark` from which the player can be walked to (out to 80 m), or the mark. */
  private joinable(mark: THREE.Vector3): THREE.Vector3 {
    const w = this.world;
    const ok = (x: number, z: number) => w.walkable(x, z) && w.reachesPlayer(x, z);
    if (ok(mark.x, mark.z)) return mark.clone();
    for (let r = 4; r <= 80; r += 4) {
      for (let a = 0; a < 16; a++) {
        const x = mark.x + Math.cos((a / 16) * Math.PI * 2) * r;
        const z = mark.z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (ok(x, z)) return new THREE.Vector3(x, w.terrain.heightAt(x, z), z);
      }
    }
    return mark.clone();
  }

  /**
   * Marks on everything a sweep reveals, drawn over the view: a red diamond on each enemy,
   * through walls, while the sweep lasts.
   */
  drawOverlay(g: CanvasRenderingContext2D, camera: THREE.Camera, width: number, height: number) {
    const w = this.world;
    for (let i = this.reveals.length - 1; i >= 0; i--) if (this.reveals[i].until <= w.time) this.reveals.splice(i, 1);
    if (!this.reveals.length) return;
    const ratio = g.canvas.width / width;
    g.save();
    g.scale(ratio, ratio);
    g.strokeStyle = 'rgba(255, 80, 60, 0.95)';
    g.fillStyle = 'rgba(255, 80, 60, 0.25)';
    g.lineWidth = 1.5;
    const p = new THREE.Vector3();
    for (const e of w.entities) {
      if (!e.targetable || e.team === 'holdouts' || e.ignored) continue;
      if (!this.reveals.some((r) => Math.hypot(e.position.x - r.at.x, e.position.z - r.at.z) <= r.radius)) continue;
      e.center(p).project(camera);
      if (p.z > 1 || p.z < -1) continue;
      const x = (p.x * 0.5 + 0.5) * width;
      const y = (-p.y * 0.5 + 0.5) * height;
      const s = THREE.MathUtils.clamp(260 / Math.max(10, camera.position.distanceTo(e.position)), 4, 14);
      g.beginPath();
      g.moveTo(x, y - s);
      g.lineTo(x + s, y);
      g.lineTo(x, y + s);
      g.lineTo(x - s, y);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.restore();
  }
}
