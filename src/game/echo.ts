import * as THREE from 'three';
import type { Input } from '../engine/input.ts';
import { MedicBrain, openGround, Squad, SquadBrain } from './brains.ts';
import type { Building, Controller, Entity, Unit } from './entity.ts';
import type { KindName } from './kinds.ts';
import type { PortraitName } from './portrait.ts';
import type { Radio } from './script.ts';
import { TankBrain } from './tank.ts';
import type { World } from './world.ts';

/**
 * Echo Squad: the four Holdouts the player fights beside through the campaign, by name. They
 * follow the player's body, go down instead of dying (a squadmate or Doc can get them back up
 * before they bleed out), and a squadmate who bleeds out stays dead for the rest of the
 * campaign. The squad's survival is the measure of a mission as much as the kill count is.
 */

export type EchoId = 'rourke' | 'vey' | 'marrow' | 'briggs';

export interface EchoMember {
  id: EchoId;
  /** Rank and full name: the squad panel and the debrief's roll call. */
  name: string;
  /** What the squad calls them, and what floats over their heads. */
  short: string;
  role: string;
  kind: KindName;
  portrait: PortraitName;
}

export const ECHO: readonly EchoMember[] = [
  { id: 'rourke', name: 'Sgt. Dana Rourke', short: 'Rourke', role: 'Squad leader', kind: 'trooper', portrait: 'trooper2' },
  { id: 'vey', name: 'Pvt. Tomas Vey', short: 'Vey', role: 'Rifleman', kind: 'trooper', portrait: 'rookie' },
  { id: 'marrow', name: '"Doc" Ilsa Marrow', short: 'Doc', role: 'Medic', kind: 'medic', portrait: 'medic' },
  { id: 'briggs', name: 'Cpl. Ruben Briggs', short: 'Briggs', role: 'Howitzer', kind: 'howitzerMobile', portrait: 'tank' },
];

export function echoMember(id: EchoId): EchoMember {
  return ECHO.find((m) => m.id === id)!;
}

/** Seconds a downed squadmate lasts before they're gone. */
export const BLEED_OUT = 45;
/** Seconds of holding E beside them to get them back up. */
const REVIVE_SECONDS = 2.4;
/** Doc's own work on a downed squadmate takes longer: she has to get there, and it's real surgery. */
const DOC_REVIVE_SECONDS = 5.5;
/** How far Doc will run to a downed squadmate. */
const DOC_REACH = 70;
/** How close a helper must be, meters from their edge. */
const REVIVE_RANGE = 2.6;
/** Life they get up with. */
const UP_LIFE = 0.35;
/** Squadmates this close pile into the bunker the player takes. */
const BUNKER_CALL = 28;
/** Seconds of quiet the squad leaves on the radio after a call about one of them. */
const CHATTER_GAP = 9;

export type EchoState = 'up' | 'down' | 'kia';

export interface EchoSlot {
  readonly def: EchoMember;
  unit: Unit;
  state: EchoState;
  /** Seconds left to get them up, while down. */
  bleed: number;
  /** Getting them up, 0..1. */
  revive: number;
  /** Times they went down this mission. */
  downs: number;
  /** The controller they fight with (re-made if anything replaces it). */
  brain: Controller;
  /** Makes a fresh one. */
  make: (u: Unit) => Controller;
  /** 0 standing .. 1 flat on the ground. */
  lie: number;
}

/** A downed soldier: still, ignored by the enemy, waiting for help. */
class DownedBrain implements Controller {
  constructor(private u: Unit) {}
  update() {
    this.u.move.set(0, 0);
    this.u.face = this.u.yaw;
  }
}

/** Doc, running to a downed squadmate and kneeling over them. */
class ReviveBrain implements Controller {
  constructor(
    private u: Unit,
    readonly patient: Unit,
  ) {}
  update() {
    const u = this.u;
    const p = this.patient;
    const dx = p.position.x - u.position.x;
    const dz = p.position.z - u.position.z;
    const gap = Math.hypot(dx, dz) - u.radius - p.radius;
    u.face = null;
    if (gap > REVIVE_RANGE * 0.6) u.move.set(dx, dz).normalize();
    else {
      u.move.set(0, 0);
      u.face = Math.atan2(dx, dz);
    }
  }
}

/** What the squad says when something happens to one of them; lines by who's still talking. */
const DOWN_LINES: Record<EchoId, string[]> = {
  rourke: ["Sarge is down! Somebody get to Rourke!", "Rourke's hit! Get the Sergeant up!"],
  vey: ["Vey's down! Corporal, get to him!", "They got the kid! Vey's down!"],
  marrow: ["Doc's down! Who's gonna patch up the medic?", "Doc's hit! Get her up, Corporal!"],
  briggs: ["Briggs is dead in the water! Somebody get that tank running!", "The tank's disabled! Briggs needs a hand!"],
};
/** Getting back up: thanking the Corporal, or Doc. */
const UP_LINES: Record<EchoId, [string, string]> = {
  rourke: ['On my feet. Thanks, Corporal. Back to it.', 'On my feet. Thanks, Doc. Back to it.'],
  vey: ["I'm okay. I'm okay! Thanks, Corporal.", "I'm okay! Thanks, Doc. I owe you."],
  marrow: ["Up. Thanks, Corporal. Who's bleeding? Besides me.", "Up. Who's bleeding? Besides me."],
  briggs: ['She runs! Briggs is back in business!', "She runs! Doc, you're a miracle."],
};
const DOC_ON_IT: Record<EchoId, string> = {
  rourke: "I've got the Sergeant! Cover me!",
  vey: "Hang on, Vey, I'm coming! Cover me!",
  marrow: '',
  briggs: "I'm a medic, not a mechanic! ...Fine. Cover me!",
};
const LOST_LINES: Record<EchoId, string> = {
  rourke: "Rourke's gone. ...Echo, on me. We finish this.",
  vey: "Vey's gone. He was nineteen. ...Keep moving.",
  marrow: "We lost Doc. God help whoever gets hit next.",
  briggs: "Briggs went down with his tank. Never would leave her.",
};

const tmp = new THREE.Vector3();

export class EchoSquad {
  readonly slots: EchoSlot[] = [];
  /** Who Doc is working on, if anyone. */
  private docPatient: EchoSlot | null = null;
  /** The squad they follow the player with, while they're holding somewhere else instead. */
  private following: Squad | null = null;
  /** The bunker the squad piled into with the player, and who's inside. */
  private bunker: Building | null = null;
  private inside: EchoSlot[] = [];
  /** Echo's own bunker in a defense, and who's in it. */
  private post: Building | null = null;
  private posted: EchoSlot[] = [];
  /** No more squad chatter (getting up, Doc on the way) before this; a squadmate going down waits less. */
  private quietUntil = 0;
  /** Revives the player did themselves this mission. */
  revives = 0;
  /** The player's body went down in a squadmate (it doesn't die: the signal drops instead). */
  onPlayerDown: ((u: Unit) => void) | null = null;
  /** Experience for getting someone up. */
  onRevive: ((s: EchoSlot, byPlayer: boolean) => void) | null = null;

  constructor(
    private world: World,
    private radio: Radio,
    /** Who they follow: the player's body (through the mission's squad), or a post they hold. */
    public squad: Squad,
  ) {}

  /** Whether `u` is one of Echo. */
  slotOf(u: Entity | null): EchoSlot | undefined {
    return u ? this.slots.find((s) => s.unit === u) : undefined;
  }

  /**
   * Puts members on the ground around `at`, following the squad (Briggs's tank holds `tankPost`
   * when given, braced there; otherwise it rolls with the squad). With `hold`, the infantry hold
   * that spot instead of following the player: a defense, where the player moves between
   * bunkers and bodies faster than anyone could follow.
   */
  deploy(ids: EchoId[], at: THREE.Vector3, tankPost: THREE.Vector3 | null = null, hold: THREE.Vector3 | null = null) {
    const w = this.world;
    if (hold) {
      this.squad = new Squad(() => null);
      this.squad.rally.copy(hold);
    }
    ids.forEach((id, i) => {
      const def = echoMember(id);
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2;
      const spot = def.kind === 'howitzerMobile' && tankPost ? tankPost : at.clone().add(new THREE.Vector3(Math.cos(a) * 4, 0, Math.sin(a) * 4));
      const p = w.walkable(spot.x, spot.z) ? spot : at;
      const make =
        def.kind === 'medic'
          ? (u: Unit) => new MedicBrain(u, this.squad)
          : def.kind === 'howitzerMobile'
            ? (u: Unit) => new TankBrain(u, tankPost ? tankPost.clone() : u.position.clone())
            : (u: Unit) => new SquadBrain(u, this.squad, true);
      let brain!: Controller;
      const unit = w.spawnUnit(def.kind, p.x, p.z, 0, (u) => (brain = make(u)));
      this.adopt(def, unit, brain, make);
    });
  }

  /** Takes a unit the mission placed itself into the squad. */
  adopt(def: EchoMember, unit: Unit, brain: Controller, make: (u: Unit) => Controller) {
    unit.minHp = 1;
    unit.name = def.short;
    this.slots.push({ def, unit, state: 'up', bleed: 0, revive: 0, downs: 0, brain, make, lie: 0 });
  }

  /** Who came through, for the debrief and the campaign. */
  roll(): { id: EchoId; name: string; state: EchoState; downs: number }[] {
    return this.slots.map((s) => ({ id: s.def.id, name: s.def.name, state: s.state, downs: s.downs }));
  }

  /** Someone in the squad who isn't `not` and can still talk, for the radio. */
  private voice(not: EchoSlot): EchoSlot | null {
    const order: EchoId[] = ['rourke', 'marrow', 'vey', 'briggs'];
    for (const id of order) {
      const s = this.slots.find((x) => x.def.id === id);
      if (s && s !== not && s.state === 'up') return s;
    }
    return null;
  }

  private say(not: EchoSlot, line: string, seconds = 2.8) {
    const v = this.voice(not);
    if (v) this.radio.say(v.def.name, v.def.portrait, line, seconds);
  }

  /**
   * The squad's calls about each other, kept from flooding the radio in a long fight: `urgent`
   * (someone down) waits a little, the rest (thanks, Doc on the way) wait for real quiet.
   */
  private chatter(urgent: boolean): boolean {
    const t = this.world.time;
    if (t < this.quietUntil - (urgent ? CHATTER_GAP * 0.75 : 0)) return false;
    this.quietUntil = t + CHATTER_GAP;
    return true;
  }

  private goDown(s: EchoSlot) {
    const u = s.unit;
    s.state = 'down';
    s.bleed = BLEED_OUT;
    s.revive = 0;
    s.downs++;
    u.ignored = true;
    if (this.world.player === u) this.onPlayerDown?.(u);
    u.setController(new DownedBrain(u));
    // A soldier lies still, breathing; a tank just sits there, smoking.
    if (u.kind.attributes.includes('Biological')) {
      u.customAnimation = true;
      u.visual.play('Stand', { loop: true, timeScale: 0.3 });
    }
    const lines = DOWN_LINES[s.def.id];
    if (this.chatter(true)) this.say(s, lines[s.downs % lines.length], 2.6);
    this.world.sfx.play('ui.hurt', { at: u.position, volume: 0.8 });
  }

  /** Everyone downed within `radius` of `at` gets up at once (a Medic's Triage): how many. */
  reviveNear(at: THREE.Vector3, radius: number): number {
    let n = 0;
    for (const s of this.slots) {
      if (s.state !== 'down' || s.unit.position.distanceTo(at) > radius) continue;
      this.getUp(s, true);
      n++;
    }
    return n;
  }

  private getUp(s: EchoSlot, byPlayer: boolean) {
    const u = s.unit;
    s.state = 'up';
    s.revive = 0;
    u.hp = Math.max(u.hp, u.maxHp * UP_LIFE);
    u.ignored = false;
    u.customAnimation = false;
    s.brain = s.make(u);
    u.setController(s.brain);
    if (byPlayer) this.revives++;
    if (this.chatter(false)) this.radio.say(s.def.name, s.def.portrait, UP_LINES[s.def.id][byPlayer ? 0 : 1], 2.6);
    this.onRevive?.(s, byPlayer);
  }

  private lose(s: EchoSlot) {
    const u = s.unit;
    s.state = 'kia';
    u.minHp = 0;
    u.ignored = false;
    u.customAnimation = false;
    s.lie = 0;
    u.visual.lie = 0;
    if (u.alive) u.takeDamage(u.hp + 1, null, null);
    this.say(s, LOST_LINES[s.def.id], 3.4);
  }

  /**
   * Per frame, before the player's body reads the keyboard: who's down, who's getting up, and
   * the player's own hands on a downed squadmate (holding E). `body` is the player's body on
   * foot, if it is on foot.
   */
  update(dt: number, input: Input, body: Unit | null, garrison: Building | null = null): { prompt: string; progress: number } | null {
    const w = this.world;
    this.garrison(garrison);
    let help: EchoSlot | null = null;
    let helpGap = Infinity;
    for (const s of this.slots) {
      const u = s.unit;
      if (s.state === 'kia') continue;
      if (!u.alive) {
        s.state = 'kia';
        continue;
      }
      if (s.state === 'up') {
        if (u.hp <= u.minHp + 0.01) this.goDown(s);
        else if (u.controller !== s.brain && w.player !== u) {
          // Let go of by the player (or anything else): back to the squad.
          s.brain = s.make(u);
          u.setController(s.brain);
        }
      } else {
        s.bleed -= dt;
        // Heals don't lift someone off the ground: that takes hands. A Medic kneeling over a
        // soldier (any Medic: they go to the worst hurt on their own), a Mender at a tank, or Doc.
        u.hp = Math.min(u.hp, u.minHp);
        if (this.tended(s)) s.revive += dt / DOC_REVIVE_SECONDS;
        if (s.revive >= 1) this.getUp(s, false);
        else if (s.bleed <= 0) this.lose(s);
        else if (body && body !== u) {
          const gap = Math.hypot(body.position.x - u.position.x, body.position.z - u.position.z) - u.radius - body.radius;
          if (gap < REVIVE_RANGE && gap < helpGap) {
            help = s;
            helpGap = gap;
          }
        }
      }
      // Down onto their back, or up again; a disabled tank smokes.
      const biological = u.kind.attributes.includes('Biological');
      if (s.state === 'down' && !biological && Math.random() < dt * 4) w.effects.smoke(u.center(tmp), 1.2, 0x2a2622, 2.5);
      const want = s.state === 'down' && biological ? 1 : 0;
      s.lie = THREE.MathUtils.clamp(s.lie + (want > s.lie ? dt * 2.2 : -dt * 3), 0, 1);
      u.visual.lie = s.lie;
    }
    this.doc();
    // The player's hands: E held beside a downed squadmate gets them up, and the key doesn't
    // reach the body (no bunker, no tank) while it's busy.
    if (!help) return null;
    if (input.down('KeyF')) {
      input.swallow('KeyF');
      help.revive += dt / REVIVE_SECONDS;
      if (help.revive >= 1) {
        this.getUp(help, true);
        return null;
      }
    }
    const verb = help.def.kind === 'howitzerMobile' ? 'Get the tank running' : `Get ${help.def.short} up`;
    return { prompt: `[Hold F] ${verb} · ${Math.ceil(help.bleed)}s`, progress: help.revive };
  }

  /**
   * The player in a bunker: the squadmates close by pile in with them, out of the swarm's
   * reach (the bunker's guns are manned either way). Out again by the door when the player
   * leaves, or when the bunker falls.
   */
  private garrison(b: Building | null) {
    // Echo's own post bunker (a defense): out into the open when it falls.
    if (this.post && !this.post.alive) {
      this.eject(this.post, this.posted);
      this.posted = [];
      this.post = null;
    }
    if (b === this.bunker && (!b || b.alive)) return;
    const was = this.bunker;
    if (was) {
      this.eject(was, this.inside);
      this.inside = [];
    }
    this.bunker = b && b.alive ? b : null;
    if (!this.bunker) return;
    for (const s of this.slots) {
      const u = s.unit;
      if (s.state !== 'up' || u === this.world.player || u.stowed || s.def.kind === 'howitzerMobile' || s === this.docPatient) continue;
      if (Math.hypot(u.position.x - this.bunker.position.x, u.position.z - this.bunker.position.z) > BUNKER_CALL) continue;
      u.stowed = true;
      this.inside.push(s);
    }
  }

  /** Squadmates out of a bunker, around its edge toward wherever the player is. */
  private eject(b: Building, who: EchoSlot[]) {
    const n = who.length;
    const from = this.world.player?.position ?? b.position;
    const base = Math.atan2(from.x - b.position.x, from.z - b.position.z);
    who.forEach((s, i) => {
      const u = s.unit;
      if (!u.alive) return;
      u.stowed = false;
      for (let k = 0; k < 16; k++) {
        const a = base + (i - (n - 1) / 2) * 0.5 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.4;
        const r = b.radius + u.radius + 1.2 + Math.floor(k / 8) * 2;
        const x = b.position.x + Math.sin(a) * r;
        const z = b.position.z + Math.cos(a) * r;
        if (openGround(this.world, x, z, u.radius + 0.2) || k === 15) {
          u.position.set(x, this.world.terrain.heightAt(x, z), z);
          break;
        }
      }
      u.velocity.set(0, 0, 0);
    });
  }

  /**
   * Holds the infantry at `at` instead of following the player (Fenmoor's nights, behind the
   * walls), or with null sends them back to the player's side.
   */
  holdAt(at: THREE.Vector3 | null) {
    if (!at === !this.following) return;
    if (at) {
      this.following = this.squad;
      this.squad = new Squad(() => null);
      this.squad.rally.copy(at);
    } else {
      this.squad = this.following!;
      this.following = null;
    }
    for (const s of this.slots) {
      if (s.state !== 'up' || s.def.kind === 'howitzerMobile' || s === this.docPatient || s.unit === this.world.player) continue;
      s.brain = s.make(s.unit);
      s.unit.setController(s.brain);
    }
    const r = this.slots.find((s) => s.def.id === 'rourke' && s.state === 'up') ?? this.slots.find((s) => s.state === 'up');
    if (r) this.radio.say(r.def.name, r.def.portrait, at ? "Echo, back to the walls! Corporal, you too, if you've got any sense." : 'Sun is up. Echo, on the Corporal.', 3);
  }

  /**
   * In a defense, the squad's infantry man a bunker by the base's heart, out of the swarm's
   * reach until it falls (its guns fire either way).
   */
  shelter(b: Building) {
    this.post = b;
    // Their post is the bunker now: out of it, they hold just behind it (on the side of the
    // spot they were holding).
    if (!this.squad.leader()) {
      const back = new THREE.Vector3(this.squad.rally.x - b.position.x, 0, this.squad.rally.z - b.position.z);
      if (back.lengthSq() < 1) back.set(1, 0, 0);
      this.squad.rally.copy(b.position).addScaledVector(back.normalize(), b.radius + 5);
    }
    for (const s of this.slots) {
      if (s.def.kind === 'howitzerMobile' || s.state !== 'up') continue;
      s.unit.stowed = true;
      this.posted.push(s);
    }
  }

  /**
   * Doc runs to whoever of Echo is down (the nearest, within reach) and works on them; she's
   * slower than the player's hands, and exposed while she does it.
   */
  private doc() {
    const doc = this.slots.find((s) => s.def.id === 'marrow');
    if (!doc || doc.state !== 'up' || doc.unit === this.world.player) {
      this.docPatient = null;
      return;
    }
    const u = doc.unit;
    let p = this.docPatient;
    if (p && p.state !== 'down') {
      p = this.docPatient = null;
      doc.brain = doc.make(u);
      u.setController(doc.brain);
    }
    // Back into the squad's bunker once the work's done.
    if (!p && this.post?.alive && !u.stowed && !this.posted.includes(doc) && u.position.distanceTo(this.post.position) < this.post.radius + 8) {
      u.stowed = true;
      this.posted.push(doc);
    }
    if (!p) {
      let best: EchoSlot | null = null;
      let bestD = DOC_REACH;
      for (const s of this.slots) {
        if (s === doc || s.state !== 'down') continue;
        const d = s.unit.position.distanceTo(u.position);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best) return;
      // Out of the bunker and into the open, if that's where she is.
      const shelter = this.posted.includes(doc) ? this.post : this.inside.includes(doc) ? this.bunker : null;
      if (shelter) {
        this.posted = this.posted.filter((x) => x !== doc);
        this.inside = this.inside.filter((x) => x !== doc);
        this.eject(shelter, [doc]);
      } else if (u.stowed) return;
      p = this.docPatient = best;
      doc.brain = new ReviveBrain(u, best.unit);
      u.setController(doc.brain);
      // Her answer to the call (it may follow it straight away).
      if (DOC_ON_IT[best.def.id] && this.chatter(true)) this.radio.say(doc.def.name, doc.def.portrait, DOC_ON_IT[best.def.id], 2.4);
    }
  }

  /** Whether someone other than the player is working on a downed squadmate. */
  private tended(s: EchoSlot): boolean {
    const u = s.unit;
    const doc = this.slots.find((x) => x.def.id === 'marrow');
    const biological = u.kind.attributes.includes('Biological');
    for (const o of this.world.unitsNear(u.position.x, u.position.z, 16)) {
      if (o === u || o.team !== u.team || o === this.world.player || this.slotOf(o)?.state === 'down') continue;
      const dustoff = biological && o.kind.name === 'dustoff';
      const helper = dustoff || (doc?.unit === o && doc.state === 'up') || (biological ? o.kind.name === 'medic' : o.kind.name === 'mender');
      if (!helper) continue;
      // A Dustoff heals from overhead, its beam's length away.
      const reach = dustoff ? 14 : REVIVE_RANGE + 1.5;
      if (Math.hypot(o.position.x - u.position.x, o.position.z - u.position.z) - o.radius - u.radius < reach) return true;
    }
    return false;
  }

  /**
   * Names over their heads, with their life; a downed one in red with the seconds left, pinned
   * to the screen's edge when they're out of view so the player can find them.
   */
  drawOverlay(g: CanvasRenderingContext2D, camera: THREE.Camera, width: number, height: number) {
    if (!this.slots.length) return;
    const ratio = g.canvas.width / width;
    g.save();
    g.scale(ratio, ratio);
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    const t = this.world.time;
    for (const [b, who] of [[this.post, this.posted], [this.bunker, this.inside]] as [Building | null, EchoSlot[]][]) {
      if (!b?.alive || !who.length || who.every((x) => !x.unit.stowed)) continue;
      tmp.copy(b.position);
      tmp.y += b.height + 1.5;
      const dist = camera.position.distanceTo(tmp);
      tmp.project(camera);
      if (tmp.z > 1 || dist > 260) continue;
      const x = (tmp.x * 0.5 + 0.5) * width;
      const y = (-tmp.y * 0.5 + 0.5) * height;
      g.globalAlpha = THREE.MathUtils.clamp(1.4 - dist / 220, 0.4, 1);
      g.font = '600 11px "Rajdhani", "Segoe UI", sans-serif';
      const label = `ECHO · ${who.map((x) => x.def.short.toUpperCase()).join(' ')}`;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(label, x + 1, y + 1);
      g.fillStyle = '#8fe3ff';
      g.fillText(label, x, y);
    }
    for (const s of this.slots) {
      const u = s.unit;
      if (s.state === 'kia' || !u.alive || u === this.world.player || u.stowed) continue;
      tmp.copy(u.position);
      tmp.y += s.state === 'down' ? 0.9 : u.height + 0.55;
      const dist = camera.position.distanceTo(tmp);
      tmp.project(camera);
      const behind = tmp.z > 1;
      let x = (tmp.x * 0.5 + 0.5) * width;
      let y = (-tmp.y * 0.5 + 0.5) * height;
      const off = behind || x < 0 || x > width || y < 0 || y > height;
      if (off && s.state !== 'down') continue;
      if (dist > 140 && s.state !== 'down') continue;
      if (off) {
        // Pinned to the edge, toward them.
        let dx = x - width / 2;
        let dy = y - height / 2;
        if (behind) {
          dx = -dx;
          dy = -dy;
        }
        const k = Math.min((width / 2 - 40) / Math.max(1e-3, Math.abs(dx)), (height / 2 - 40) / Math.max(1e-3, Math.abs(dy)));
        x = width / 2 + dx * k;
        y = height / 2 + dy * k;
      }
      const down = s.state === 'down';
      const alpha = down ? 0.65 + 0.35 * Math.sin(t * 6) : THREE.MathUtils.clamp(1.3 - dist / 120, 0.35, 1);
      g.globalAlpha = alpha;
      g.font = '600 12px "Rajdhani", "Segoe UI", sans-serif';
      const label = down ? `▼ ${s.def.short.toUpperCase()} ${Math.ceil(s.bleed)}` : s.def.short.toUpperCase();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(label, x + 1, y - 5);
      g.fillStyle = down ? '#ff5a4a' : '#8fe3ff';
      g.fillText(label, x, y - 6);
      if (!down) {
        const f = THREE.MathUtils.clamp(u.hp / u.maxHp, 0, 1);
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(x - 17, y - 3, 34, 3);
        g.fillStyle = f > 0.5 ? '#8fe3ff' : f > 0.25 ? '#ffd24a' : '#ff5a4a';
        g.fillRect(x - 17, y - 3, 34 * f, 3);
      } else if (s.revive > 0) {
        g.strokeStyle = '#8fe3ff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y + 8, 7, -Math.PI / 2, -Math.PI / 2 + s.revive * Math.PI * 2);
        g.stroke();
      }
    }
    g.restore();
  }

  /** The squad panel's rows. */
  panel(): { name: string; role: string; state: EchoState; hp: number; bleed: number }[] {
    return this.slots.map((s) => ({
      name: s.def.short,
      role: s.unit.stowed && s.state === 'up' ? 'In the bunker' : s.def.role,
      state: s.state,
      hp: s.state === 'up' ? THREE.MathUtils.clamp(s.unit.hp / s.unit.maxHp, 0, 1) : 0,
      bleed: s.state === 'down' ? Math.ceil(s.bleed) : 0,
    }));
  }
}
