import * as THREE from 'three';
import { AssaultBrain, faceTowards, Homing, joinFocus, MedicBrain, sidestep } from '../brains.ts';
import type { Commandable, Controller, Entity, Unit } from '../entity.ts';
import { FlowField } from '../flowfield.ts';
import type { KindName } from '../kinds.ts';
import { walkableNear } from '../script.ts';
import { TankBrain } from '../tank.ts';
import type { World } from '../world.ts';

/**
 * The Tide's lines: the fronts the army holds across the swarm's ways in, each with its ranks
 * of posts, its tanks dug in behind, a fallback closer to the base, and a sergeant's sense of
 * when to push out and when to give ground. Soldiers fight from their posts like soldiers:
 * they step up to get a target in range, stay in the fight while there's one to shoot, and
 * only drift back to the line once it's quiet.
 */

/** A place in a line: where the rank put it (`base`), where it is now the line has moved (`at`), and who holds it. */
export interface Post {
  base: THREE.Vector3;
  at: THREE.Vector3;
  rank: number;
  holder: Unit | null;
}

/** What the commander has told a line: the sergeant's own judgment, hold where it is, push out, or fall back. */
export type Stance = 'auto' | 'hold' | 'advance' | 'fallback';

export interface Front {
  /** Where the line was drawn up, and which way it faces (back along the swarm's route). */
  at: THREE.Vector3;
  out: THREE.Vector3;
  /** Paths from anywhere in the base to the line, for the reinforcements. */
  field: FlowField;
  posts: Post[];
  /** Posts made so far in each rank, for the next one's place. */
  made: number[];
  /** The tanks' places, dug in behind the ranks. */
  tankPosts: Post[];
  /** Which side of the base it holds, for the radio ("the west line"). */
  name: string;
  /** Overrun: the swarm through it, hardly a soldier left standing. */
  broken: boolean;
  /** Where the line re-forms closer to the base once it's overrun (a bunker at its heart). */
  fallback: Front | null;
  /** How far the line stands from where it was drawn up, meters along `out` (back is negative). */
  push: number;
  stance: Stance;
}

/**
 * The ranks, front to back: Burners out ahead (their flames reach a few meters: they meet the
 * charge), the riflemen, the heavier soldiers, Medics last. Depth in meters behind the line.
 */
const RANK_DEPTH = [-4, 0, 12.5, 19];
const PER_ROW = 14;
const FILE_SPACING = 2.6;
const ROW_SPACING = 3.1;
/** How far out of the line a soldier goes to get a target in range. */
const REACH = 10;
/** Who it looks at: enemies this close to it. */
const AGGRO = 46;
/** Seconds it stays where the fight left it before drifting back to its post. */
const SETTLE = 3;
/**
 * How far a line may push out past where it was drawn up (on its own, and when ordered to), and
 * fall back behind it, meters.
 */
const AUTO_PUSH = 25;
const MAX_PUSH = 40;
const MAX_FALLBACK = -30;

function rankOf(kind: KindName): number {
  return kind === 'burner' ? 0 : kind === 'medic' ? 3 : kind === 'grenadier' || kind === 'seer' ? 2 : 1;
}

/**
 * A soldier holding a post in a line: targets the nearest enemy it can hit, steps out up to
 * `REACH` to get it in range, stays in the fight while there's anything to shoot (it doesn't
 * snap back the moment a target falls), and drifts back to its post, facing out, once it's
 * been quiet a while. The commander can move it: it fights from wherever it's put.
 */
export class LineBrain implements Controller, Commandable {
  private target: Entity | null = null;
  private retarget = Math.random() * 0.3;
  private idle = SETTLE;
  private dir = new THREE.Vector2();
  /** A place the commander put it, instead of its post in the line. */
  private own: THREE.Vector3 | null = null;
  private homing = new Homing();

  constructor(
    private u: Unit,
    private post: Post,
    private front: Front,
  ) {}

  command(at: THREE.Vector3) {
    this.own = at.clone();
  }

  update(dt: number) {
    const u = this.u;
    const w = u.world;
    const spot = this.own ?? this.post.at;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target?.targetable) {
      this.retarget = 0.25 + Math.random() * 0.15;
      // Squadmates fire at whatever the player is shooting, when it's in reach.
      const focus = w.focus?.target;
      const range = u.kind.weapon?.range ?? 0;
      if (focus?.targetable && focus.team !== u.team && !focus.isBuilding && u.weaponFor(focus) && u.gap(focus) < range + 10 && (focus === this.target || joinFocus(u, focus))) this.target = focus;
      else this.target = w.nearestTarget(u, AGGRO, (e) => Math.hypot(e.position.x - spot.x, e.position.z - spot.z) < REACH + range + 6);
    }
    const t = this.target;
    const face = Math.atan2(this.front.out.x, this.front.out.z);
    if (t?.targetable) {
      this.idle = 0;
      if (u.inRange(t)) {
        if (!sidestep(u, t, 0.35)) {
          u.move.set(0, 0);
          faceTowards(u, t);
        }
        u.attack(t);
        return;
      }
      // Step up to get it in range, but not past the reach of the line.
      if (Math.hypot(u.position.x - spot.x, u.position.z - spot.z) < REACH) {
        u.face = null;
        u.move.copy(this.dir.set(t.position.x - u.position.x, t.position.z - u.position.z).normalize());
        return;
      }
    }
    // Quiet: hold where the fight left it for a moment, then back to the post (or near enough to
    // it), facing out.
    this.idle += dt;
    const goal = this.idle > SETTLE ? this.homing.toward(u, spot) : null;
    if (goal) {
      const away = Math.hypot(goal.x - u.position.x, goal.z - u.position.z);
      u.move.copy(this.dir.set(goal.x - u.position.x, goal.z - u.position.z).divideScalar(away)).multiplyScalar(away > 8 ? 1 : 0.6);
      u.face = away < 14 ? face : null;
    } else {
      u.move.set(0, 0);
      u.face = face;
    }
  }
}

/** A Medic in a line: heals the worst hurt nearby, and keeps to its post (which the commander may move). */
class LineMedic implements Controller, Commandable {
  private spot: THREE.Vector3;
  private brain: MedicBrain;
  /** Put somewhere by the commander, rather than keeping to its post in the line. */
  private own = false;

  constructor(
    u: Unit,
    private post: Post,
  ) {
    this.spot = post.at.clone();
    this.brain = new MedicBrain(u, null, this.spot);
  }

  command(at: THREE.Vector3) {
    this.own = true;
    this.spot.copy(at);
  }

  update(dt: number) {
    if (!this.own) this.spot.copy(this.post.at);
    this.brain.update(dt);
  }
}

/**
 * Out of the Barracks and up to the line: along the paths to its front (fighting what it meets
 * on the way, if it can), then holding its post there.
 */
export class MarchBrain implements Controller {
  private fight: AssaultBrain | null;
  private dir = new THREE.Vector2();

  constructor(
    private u: Unit,
    private front: Front,
    private post: Post,
    private hold: (u: Unit) => Controller,
  ) {
    this.fight = u.kind.weapon ? new AssaultBrain(u, front.field, front.at) : null;
  }

  release() {
    this.fight?.release();
  }

  update(dt: number) {
    const u = this.u;
    const f = this.front;
    const p = this.post.at;
    if (Math.hypot(u.position.x - f.at.x, u.position.z - f.at.z) < 18 || Math.hypot(u.position.x - p.x, u.position.z - p.z) < 10) {
      u.speedMul = 1;
      u.setController(this.hold(u));
      return;
    }
    // At a run: the line needs them now.
    u.speedMul = 1.2;
    if (this.fight) return this.fight.update(dt);
    u.face = null;
    if (f.field.direction(u.position.x, u.position.z, this.dir) || f.field.escape(u.position.x, u.position.z, this.dir)) u.move.copy(this.dir);
    else u.move.set(p.x - u.position.x, p.z - u.position.z).normalize();
  }
}

export class Lines {
  readonly fronts: Front[] = [];

  constructor(private w: World) {}

  /** A line at `at` facing `out`, with paths to it from anywhere in the base. */
  line(at: THREE.Vector3, out: THREE.Vector3, name: string, obstacles: { x: number; z: number; r: number }[]): Front {
    const terrain = this.w.terrain;
    const field = new FlowField(terrain.size, terrain.pathCell);
    field.setTerrain((x, z) => terrain.walkable(x, z));
    field.compute([{ x: at.x, z: at.z, r: 12 }], obstacles);
    return { at, out, field, posts: [], made: [0, 0, 0, 0], tankPosts: [], name, broken: false, fallback: null, push: 0, stance: 'auto' };
  }

  /** Where the line stands now. */
  anchor(f: Front, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(f.at).addScaledVector(f.out, f.push);
  }

  /**
   * A soldier's place in a line, by rank: a post whose soldier has fallen (the line closes up),
   * or a new one, in ranks of `PER_ROW` across the line, from the middle out.
   */
  postIn(f: Front, kind: KindName): Post {
    const rank = rankOf(kind);
    const free = f.posts.find((p) => p.rank === rank && !p.holder?.alive);
    if (free) return free;
    const side = new THREE.Vector3(-f.out.z, 0, f.out.x);
    const i = f.made[rank]++;
    const row = Math.floor(i / PER_ROW);
    const k = i % PER_ROW;
    const col = (k % 2 ? 1 : -1) * Math.ceil(k / 2) + (row % 2) * 0.5;
    const spacing = rank === 0 ? FILE_SPACING * 1.6 : FILE_SPACING;
    const base = walkableNear(this.w, f.at.clone().addScaledVector(side, col * spacing).addScaledVector(f.out, -RANK_DEPTH[rank] - row * ROW_SPACING), 1.5);
    const post = { base, at: base.clone(), rank, holder: null };
    this.place(f, post);
    f.posts.push(post);
    return post;
  }

  /** How a soldier of `kind` holds its post. */
  holder(kind: KindName, post: Post, f: Front): (u: Unit) => Controller {
    return (u) => (kind === 'medic' ? new LineMedic(u, post) : new LineBrain(u, post, f));
  }

  /** A soldier for the line: at its post, or out of a door and marching there. */
  soldier(kind: KindName, f: Front, door?: THREE.Vector3): Unit {
    const post = this.postIn(f, kind);
    const start = door ?? post.at;
    const yaw = Math.atan2(f.out.x, f.out.z);
    const hold = this.holder(kind, post, f);
    const u = this.w.spawnUnit(kind, start.x, start.z, yaw, (x) => (door ? new MarchBrain(x, f, post, hold) : hold(x)));
    post.holder = u;
    return u;
  }

  /** A free place for a tank behind a line: one whose tank was lost, or a new one. */
  private tankPost(f: Front): Post {
    let post = f.tankPosts.find((p) => !p.holder?.alive);
    if (!post) {
      const side = new THREE.Vector3(-f.out.z, 0, f.out.x);
      const k = f.tankPosts.length;
      const offset = (k % 2 ? 1 : -1) * (6 + Math.floor(k / 2) * 9);
      const base = walkableNear(this.w, f.at.clone().addScaledVector(f.out, -24 - (k % 3) * 3).addScaledVector(side, offset), 3);
      post = { base, at: base.clone(), rank: 4, holder: null };
      f.tankPosts.push(post);
    }
    return post;
  }

  /**
   * A soldier already on the field (set down by a transport, say) takes a place in a line: it
   * gives up any post it held elsewhere, marches to its new one, and holds it. Returns its brain.
   */
  join(u: Unit, f: Front): Controller {
    for (const g of this.fronts) for (const p of [...g.posts, ...g.tankPosts]) if (p.holder === u) p.holder = null;
    if (u.kind.name === 'howitzerMobile') {
      const post = this.tankPost(f);
      post.holder = u;
      const at = post.at.clone();
      return new MarchBrain(u, f, post, (x) => new TankBrain(x, at));
    }
    const post = this.postIn(f, u.kind.name);
    post.holder = u;
    const hold = this.holder(u.kind.name, post, f);
    return Math.hypot(u.position.x - post.at.x, u.position.z - post.at.z) < 12 ? hold(u) : new MarchBrain(u, f, post, hold);
  }

  /** The line (where it holds now) nearest `at`, within `within` meters, if any. */
  nearest(at: THREE.Vector3, within = Infinity): Front | null {
    let best: Front | null = null;
    let bestD = within;
    const a = new THREE.Vector3();
    for (const f of this.fronts) {
      const held = f.broken && f.fallback ? f.fallback : f;
      const d = this.anchor(held, a).distanceTo(at);
      if (d < bestD) {
        bestD = d;
        best = held;
      }
    }
    return best;
  }

  /** A tank behind a line, in the place of one lost or a new one: braced there, or rolling out of the MotorPool to dig in. */
  tank(f: Front, door?: THREE.Vector3): Unit {
    const w = this.w;
    const post = this.tankPost(f);
    const at = post.at;
    const yaw = Math.atan2(f.out.x, f.out.z);
    const p = post;
    post.holder = door
      ? w.spawnUnit('howitzerMobile', door.x, door.z, yaw, (u) => new MarchBrain(u, f, p, (x) => new TankBrain(x, at.clone())))
      : w.spawnUnit('howitzer', at.x, at.z, yaw, (u) => new TankBrain(u, at.clone()));
    return post.holder;
  }

  /**
   * Moves a post with its line (the tanks stay dug in where they are: artillery doesn't chase),
   * and out from under any structure put up on it since: its soldier stands at the wall instead.
   */
  private place(f: Front, p: Post) {
    if (p.rank === 4) return;
    const want = p.base.clone().addScaledVector(f.out, f.push);
    for (const b of this.w.buildings) {
      const dx = want.x - b.position.x;
      const dz = want.z - b.position.z;
      const d = Math.hypot(dx, dz);
      const clear = b.radius + 1.2;
      if (d >= clear) continue;
      // Straight out from its middle (or back from the line, dead center).
      if (d < 0.1) want.set(b.position.x - f.out.x * clear, want.y, b.position.z - f.out.z * clear);
      else want.set(b.position.x + (dx / d) * clear, want.y, b.position.z + (dz / d) * clear);
    }
    if (this.w.walkable(want.x, want.z)) p.at.copy(want).setY(this.w.terrain.heightAt(want.x, want.z));
  }

  /** A structure went up (or came down) near the lines: every post finds its ground again. */
  replace() {
    for (const f of this.fronts) for (const p of f.posts) this.place(f, p);
  }

  /** Soldiers of our side within `r` of a point, by supply. */
  private strength(at: THREE.Vector3, r: number, team: 'holdouts' | 'crawl', supply: (k: KindName) => number, ahead?: THREE.Vector3): number {
    let n = 0;
    for (const u of this.w.unitsNear(at.x, at.z, r)) {
      if (u.team !== team) continue;
      if (ahead && (u.position.x - at.x) * ahead.x + (u.position.z - at.z) * ahead.z < -12) continue;
      n += supply(u.kind.name);
    }
    return n;
  }

  /**
   * The sergeants' judgment, every couple of seconds. In a lull, a line with stragglers in front
   * of it pushes out to clear them; when the swarm builds again it goes back to where it was
   * drawn up, in front of its tanks; swamped, it gives ground toward the base, and takes it back
   * once it can. The commander's stance overrides: hold, push out, fall back.
   */
  update(lull: boolean, supply: (k: KindName) => number) {
    const at = new THREE.Vector3();
    for (const f of this.fronts) {
      this.anchor(f, at);
      const ours = this.strength(at, 45, 'holdouts', supply);
      const theirs = this.strength(at, 75, 'crawl', supply, f.out);
      let want = f.push;
      if (f.stance === 'advance') want = MAX_PUSH;
      else if (f.stance === 'fallback') want = MAX_FALLBACK;
      else if (f.stance === 'auto') {
        if (theirs > ours * 0.9) want = Math.max(MAX_FALLBACK, f.push - 8);
        else if (lull && theirs > 0 && theirs < ours * 0.2) want = Math.min(AUTO_PUSH, f.push + 6);
        else if (!lull && f.push > 0) want = Math.max(0, f.push - 8);
        else if (f.push < 0 && theirs < ours * 0.4) want = Math.min(0, f.push + 6);
      }
      if (want === f.push) continue;
      f.push += THREE.MathUtils.clamp(want - f.push, -10, 8);
      for (const p of f.posts) this.place(f, p);
    }
  }
}
