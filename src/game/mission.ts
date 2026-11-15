import * as THREE from 'three';
import type { Layout } from './layout.ts';
import { BunkerGuns, GuardBrain, CrawlBrain } from './brains.ts';
import { TankBrain } from './tank.ts';
import type { Building, Entity, Unit } from './entity.ts';
import type { KindName } from './kinds.ts';
import { BATTLE_SIZES, endlessWave, type BattleSize, type Difficulty, type MissionDef, type Wave } from './missions.ts';
import { Beacon, beside, copies, Radio, type MissionScript } from './script.ts';
import type { CapturePoint } from './capture.ts';
import type { World } from './world.ts';

/** How many of survival's waves the menus' backdrop goes round. */
const BACKDROP_WAVES = 6;

/** The map: a raised human base on Calder with three ramps down to the badlands. */
export const MAP = {
  size: 900,
  segments: 225,
  radius: 330,
  plateau: { radius: 122, height: 9 },
  ramps: [Math.PI / 2, (Math.PI * 7) / 6, (Math.PI * 11) / 6],
  rampHalfWidth: 15,
};

function smooth(t: number) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

function hash(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, z: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), u),
    THREE.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), u),
    v,
  );
}

/** How far a point is from the nearest ramp's center line, in meters (sideways). */
function rampOffset(x: number, z: number): number {
  let best = Infinity;
  for (const a of MAP.ramps) {
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const along = x * dx + z * dz;
    if (along < 0) continue;
    best = Math.min(best, Math.abs(-x * dz + z * dx));
  }
  return best;
}

/** Rock mesas scattered over the lowground, for cover and to break up the swarm's paths. */
const MESAS = Array.from({ length: 14 }, (_, i) => {
  const a = i * 2.39996 + 0.4;
  const r = 175 + ((i * 53) % 110);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r: 9 + ((i * 7) % 9), h: 7 + ((i * 3) % 6) };
}).filter((m) => rampOffset(m.x, m.z) > 32);

export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const { radius, height } = MAP.plateau;
  const ramp = smooth(1 - (rampOffset(x, z) - MAP.rampHalfWidth) / 6);
  // Cliff around the plateau; on a ramp the drop is spread over 60 m instead of 10.
  const cliff = 1 - smooth((r - radius) / 10);
  const slope = 1 - smooth((r - (radius - 12)) / 64);
  let h = height * THREE.MathUtils.lerp(cliff, slope, ramp);
  // Rolling badlands.
  const outside = smooth((r - radius - 20) / 40);
  h += outside * (noise(x / 45, z / 45) * 4 + noise(x / 13, z / 13) * 1.2 - 2.4);
  for (const m of MESAS) {
    const d = Math.hypot(x - m.x, z - m.z);
    h += m.h * (1 - smooth((d - m.r) / 6));
  }
  // Mountains ring the map: the far land's range, broken into a ragged ridgeline with crags
  // close in. The fine relief fades out before the map's edge, where the far land takes over
  // exactly, so from the air there's no seam (the edge is 450 m out, the fade done by 445).
  const a = Math.atan2(z, x);
  const foot = MAP.radius - 8 + noise(Math.cos(a) * 4 + 20, Math.sin(a) * 4 + 20) * 30;
  const rise = smooth((r - foot) / 80);
  const detail = 1 - smooth((r - 385) / 60);
  h = THREE.MathUtils.lerp(h, farHeight(x, z), Math.pow(rise, 1.5));
  h += detail * (Math.pow(rise, 1.5) * 70 * (noise(x / 70 + 5, z / 70 + 5) - 0.35) + rise * (noise(x / 16, z / 16) - 0.5) * 18);
  return h;
}

/**
 * The land beyond the map, at low detail: the range carries on for a few hundred meters and
 * then falls away to open dunes. Only long wavelengths, so a coarse mesh can follow it closely.
 */
export function farHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const range = smooth((r - 300) / 140) * (1 - smooth((r - 750) / 700));
  const peaks = 40 + 70 * noise(x / 400 + 5, z / 400 + 5);
  const dunes = 26 * noise(x / 650 + 9, z / 650 + 3) + 10 * noise(x / 300 + 2, z / 300 + 8) - 14;
  return range * peaks + dunes * (1 - range * 0.5);
}

/** Where base plating is laid: the plateau, more of it near the center. */
export function baseMask(x: number, z: number): number {
  const r = Math.hypot(x, z);
  return smooth((MAP.plateau.radius - 8 - r) / 30) * (0.45 + 0.55 * smooth((70 - r) / 30));
}

export type Phase = 'briefing' | 'countdown' | 'wave' | 'victory' | 'defeat';

interface Reinforcement {
  at: number;
  post: THREE.Vector3;
}

/** Status of each objective, for the HUD and the debrief. */
export type ObjectiveStatus = 'active' | 'done' | 'failed';

/**
 * A defense mission: protect the Holdfast through every wave of the swarm (or, in
 * survival, for as long as you can). Waves come from the mission's definition, scaled by
 * difficulty; bonus objectives are tracked as the fight goes.
 */
/** The share of each wave that masses on one approach, by difficulty level. */
const MAIN_PUSH = [0.4, 0.55, 0.65, 0.75];
/** About how many of a wave come out of a lane together. */
const PACK_SIZE = 20;

export class Mission {
  phase: Phase = 'briefing';
  wave = 0;
  totalWaves: number;
  /** The menus' backdrop: the waves go round and round (`backdrop`). */
  private looping = false;
  countdown = 0;
  /** Seconds since the first wave began. */
  elapsed = 0;
  readonly status = new Map<string, ObjectiveStatus>();
  /** How it ended, in a line, for the debrief. */
  outcome = '';
  /** Progress shown beside an objective ("3/6"), by objective id. */
  readonly progress = new Map<string, string>();
  /** Hidden objectives the script has revealed. */
  readonly revealed = new Set<string>();
  /** Player kills, fed in by the game for the kill objective. */
  playerKills = 0;
  bunkersLost = 0;
  ccLowest = 1;
  /** The base's Holdfast; null in missions without a base. */
  holdfast: Building | null = null;
  barracks: Building[] = [];
  private spawnQueue: { kind: KindName; at: number; side: number }[] = [];
  private reinforcements: Reinforcement[] = [];
  private crawl = new Set<Unit>();
  private alertCooldown = 0;
  /** Extra range for the bunkers' guns (Long Sights), meters. */
  bunkerBonus = 0;
  /** A mission-wide meter across the top (the artifact's charge), when the script keeps one. */
  meter: { label: string; value: number; text: string; ticks?: number[] } | null = null;
  /** A boss on the field (the Voice of the Crawl): her life across the top. */
  boss: { name: string; sub: string; unit: Entity } | null = null;
  /** What the base bar is called, and the line when it falls. */
  baseName = 'HOLDFAST';
  baseLost = 'The Holdfast has fallen.';
  /** Points to capture and hold (PlanetSide style), when the mission has any. */
  readonly points: CapturePoint[] = [];
  /** The mission's own logic (training drills, an assault's objectives); null for plain defense. */
  script: MissionScript | null = null;
  /** Radio traffic: transmissions play one at a time. */
  readonly radio = new Radio();
  /** Where the player should go, shown in the world and on the HUD. */
  waypoint: { position: THREE.Vector3; label: string } | null = null;
  private beacon: Beacon;
  /** HUD hooks. */
  onMessage: ((text: string, sub?: string, seconds?: number) => void) | null = null;
  /** An objective asking for attention, with a hint (First Muster's reminders). */
  onNudge: ((hint: string) => void) | null = null;
  /** A wave is announced; `big` when it brings something large (Tuskers). */
  onWave: ((wave: number, big: boolean) => void) | null = null;

  constructor(
    readonly world: World,
    readonly layout: Layout,
    readonly def: MissionDef,
    readonly difficulty: Difficulty,
    /** The battle's size, for a mission that offers sizes (Standard otherwise). */
    readonly size: BattleSize = BATTLE_SIZES[0],
  ) {
    this.totalWaves = def.kind === 'survival' ? Infinity : (def.waves?.length ?? 0);
    for (const o of def.objectives) this.status.set(o.id, 'active');
    world.playerTokens = { ...difficulty.tokens };
    world.incomingDamage = difficulty.incoming;
    this.beacon = new Beacon(world.scene);
  }

  /** Points the player somewhere (or nowhere): a beacon in the world and a marker on the HUD. */
  setWaypoint(position: THREE.Vector3 | null, label = '', radius = 4) {
    this.waypoint = position ? { position: position.clone(), label } : null;
    this.beacon.show(position, radius);
  }

  /** Ends the mission in victory, completing whatever's still open that should be. */
  win(sub: string) {
    if (this.phase === 'victory' || this.phase === 'defeat') return;
    this.phase = 'victory';
    this.outcome = sub;
    for (const o of this.def.objectives) if ((!o.bonus || o.keep) && this.status.get(o.id) === 'active') this.status.set(o.id, 'done');
    this.setWaypoint(null);
    this.onMessage?.('VICTORY', sub);
  }

  lose(sub: string) {
    if (this.phase === 'victory' || this.phase === 'defeat') return;
    this.phase = 'defeat';
    this.outcome = sub;
    for (const o of this.def.objectives) if (this.status.get(o.id) === 'active') this.status.set(o.id, 'failed');
    this.setWaypoint(null);
    this.onMessage?.('DEFEAT', sub);
  }

  /**
   * The menus' battle behind them: survival's waves, the first few over and over (it mustn't grow
   * without end while the menus stay open), and a Holdfast that doesn't fall, so it never goes still.
   */
  backdrop() {
    this.looping = true;
    this.totalWaves = Infinity;
    if (this.holdfast) this.holdfast.minHp = 1;
  }

  /** Wave `n` at this difficulty. */
  private waveAt(n: number): Wave {
    const base = this.looping ? endlessWave(n % BACKDROP_WAVES) : this.def.kind === 'survival' ? endlessWave(n) : (this.def.waves?.[n] ?? {});
    const out: Wave = {};
    for (const [k, v] of Object.entries(base) as [keyof Wave, number][]) out[k] = Math.max(1, Math.round(v * this.difficulty.waveScale));
    return out;
  }

  setup() {
    if (this.script?.setup) {
      this.script.setup();
      return;
    }
    const w = this.world;
    const L = this.layout;
    const cc = L.holdfast;
    this.holdfast = w.spawnBuilding('holdfast', cc.x, cc.z, cc.yaw);
    w.goal = this.holdfast;
    w.perimeter = L.perimeter;
    this.barracks = L.barracks.map((b) => w.spawnBuilding('barracks', b.x, b.z, b.yaw));
    for (const d of L.depots) w.spawnBuilding('storehouse', d.x, d.z, d.yaw);

    const rifle = w.kinds.trooper.weapon!;
    let guards = 0;
    for (const lane of L.lanes) {
      // A bunker at the head of each approach, a braced tank behind it, and a squad of Troopers.
      if (lane.bunker) {
        const bunker = w.spawnBuilding('bunker', lane.bunker.x, lane.bunker.z, lane.bunker.yaw);
        bunker.controller = new BunkerGuns(bunker, { ...rifle, range: rifle.range + this.bunkerBonus });
      }
      if (lane.tank) {
        const face = Math.atan2(lane.spawn.x - lane.tank.x, lane.spawn.z - lane.tank.z);
        w.spawnUnit('howitzer', lane.tank.x, lane.tank.z, face, (u) => new TankBrain(u, u.position.clone()));
      }
      // The lane's squad, bigger at higher difficulties (beside the map's own posts).
      for (const post of lane.posts) {
        const n = copies(this.difficulty.allies, guards++);
        for (let k = 0; k < n; k++) this.spawnGuard(k === 0 ? post.clone() : beside(w, post));
      }
    }
    // Tanks in reserve by the Holdfast, in Drive Mode: take one and drive it where it's needed.
    for (const t of L.reserveTanks) w.spawnUnit('howitzerMobile', t.x, t.z, t.yaw, (u) => new TankBrain(u, u.position.clone()));
    w.updatePaths();
  }

  private spawnGuard(post: THREE.Vector3) {
    const w = this.world;
    const from = this.respawnPoint();
    const yaw = Math.atan2(post.x - from.x, post.z - from.z);
    const u = w.spawnUnit('trooper', from.x, from.z, yaw, (unit) => new GuardBrain(unit, post));
    (u as Unit & { post?: THREE.Vector3 }).post = post;
  }

  /** A walkable point near `center`, within `spread` meters. */
  private spawnPoint(center: THREE.Vector3, spread: number): THREE.Vector3 {
    const w = this.world;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      if (w.walkable(x, z)) return new THREE.Vector3(x, 0, z);
    }
    return center.clone();
  }

  /** In front of the nearest standing Barracks, or the Holdfast if none are left. */
  respawnPoint(): THREE.Vector3 {
    const scripted = this.script?.respawnPoint?.();
    if (scripted) return scripted.clone();
    const b = this.barracks.find((x) => x.alive) ?? this.holdfast;
    const out = new THREE.Vector3();
    if (!b) return out.set(this.layout.holdfast.x, 0, this.layout.holdfast.z);
    b.forward(out).multiplyScalar(b.radius + 4).add(b.position);
    out.x += (Math.random() - 0.5) * 6;
    out.z += (Math.random() - 0.5) * 6;
    return out;
  }

  start() {
    if (this.script) {
      this.phase = 'wave';
      this.script.start();
      return;
    }
    this.phase = 'countdown';
    this.countdown = 12;
    this.onMessage?.(this.def.title.toUpperCase(), 'The Crawl is coming up the ramps. Keep it off the Holdfast.');
    this.world.audio.play('transmission', { volume: 0.9 });
  }

  /** Called when any entity dies. */
  entityDied(e: Entity) {
    this.script?.died?.(e);
    if (e === this.holdfast) {
      this.lose(this.baseLost);
      return;
    }
    const post = (e as Entity & { post?: THREE.Vector3 }).post;
    if (post && e.team === 'holdouts') this.reinforcements.push({ at: this.world.time + this.difficulty.reinforce, post });
    if (e.kind.name === 'bunker') {
      this.bunkersLost++;
      if (this.status.has('bunkers')) this.status.set('bunkers', 'failed');
    }
    this.crawl.delete(e as Unit);
  }

  /** A friendly took damage: the adjutant reports attacks on the base. */
  holdoutsDamaged(e: Entity) {
    if (this.alertCooldown > 0) return;
    if (e.isBuilding) {
      this.world.audio.play('baseUnderAttack', { volume: 0.9 });
      this.alertCooldown = 25;
    }
  }

  /** The player's kills the kills objective asks for. */
  get killsWanted(): number {
    return this.def.objectives.find((o) => o.id === 'kills')?.count ?? 120;
  }

  get enemiesLeft(): number {
    return this.crawl.size + this.spawnQueue.length;
  }

  private queueWave(n: number) {
    const wave = this.waveAt(n);
    const t = this.world.time;
    const total = Object.values(wave).reduce((a, b) => a + b, 0);
    // Big waves pour in faster, but the ridge only lets so many through: about half a minute
    // for most waves, a full minute of brace for the swarm at the end.
    const gap = Math.min(0.18, Math.max(28, total * 0.1) / total);
    // The swarm masses on one approach (more of it the harder the difficulty) and spreads the
    // rest: one bunker takes the brunt and may break, and where the player stands matters.
    const lanes = this.layout.lanes;
    const main = Math.floor(Math.random() * lanes.length);
    const focus = MAIN_PUSH[this.difficulty.level] ?? 0.55;
    const byLane: KindName[][] = lanes.map(() => []);
    for (const [kind, count] of Object.entries(wave) as [KindName, number][]) {
      for (let k = 0; k < count; k++) {
        const side = lanes.length > 1 && Math.random() < focus ? main : Math.floor(Math.random() * lanes.length);
        byLane[side].push(kind);
      }
    }
    // It comes in packs, not a trickle: each bursts out of its lane's spawn together, spread over
    // the ground there, and the packs follow each other through the wave's time. A trickle would
    // walk down the paths in single file.
    const window = total * gap;
    byLane.forEach((kinds, side) => {
      for (let k = kinds.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [kinds[k], kinds[j]] = [kinds[j], kinds[k]];
      }
      const packs = Math.max(1, Math.round(kinds.length / PACK_SIZE));
      for (let p = 0; p < packs; p++) {
        const at = t + (packs > 1 ? (p / (packs - 1)) * window : Math.random() * 2) + Math.random() * 1.5;
        for (const kind of kinds.slice(Math.round((p * kinds.length) / packs), Math.round(((p + 1) * kinds.length) / packs))) {
          this.spawnQueue.push({ kind, at: at + Math.random() * 0.5, side });
        }
      }
    });
    this.spawnQueue.sort((a, b) => a.at - b.at);
    const big = wave.tusker ? ' — TUSKER DETECTED' : '';
    const of = Number.isFinite(this.totalWaves) ? ` / ${this.totalWaves}` : '';
    const push = lanes[main].bunker;
    const where = lanes.length > 1 && push ? ' · the main push is marked' : '';
    this.onMessage?.(`WAVE ${n + 1}${of}`, `${Object.values(wave).reduce((a, b) => a + b, 0)} hostiles inbound${where}${big}`);
    // The bunker that will take the brunt, marked for the player (a defense has no other waypoint).
    if (!this.script && lanes.length > 1 && push) this.setWaypoint(new THREE.Vector3(push.x, this.world.terrain.heightAt(push.x, push.z), push.z), 'Main push', 10);
    this.onWave?.(n, !!wave.tusker);
    if (wave.tusker) this.world.audio.play('tuskerRoar', { volume: 1 });
  }

  update(dt: number) {
    const w = this.world;
    this.alertCooldown -= dt;
    this.radio.update(dt);
    this.beacon.update(dt);
    for (const p of this.points) p.update(dt);
    if (this.phase === 'wave' || (this.phase === 'countdown' && this.wave > 0)) this.elapsed += dt;
    const cc = this.holdfast;
    if (cc) this.ccLowest = Math.min(this.ccLowest, cc.hp / cc.maxHp);
    if (this.status.has('healthy') && this.ccLowest < 0.5) this.status.set('healthy', 'failed');
    if (this.status.get('kills') === 'active' && this.playerKills >= this.killsWanted) this.status.set('kills', 'done');
    for (let i = this.reinforcements.length - 1; i >= 0; i--) {
      if (this.reinforcements[i].at <= w.time && this.phase !== 'defeat') {
        this.spawnGuard(this.reinforcements[i].post);
        this.reinforcements.splice(i, 1);
      }
    }
    if (this.script) {
      if (this.phase === 'wave') this.script.update(dt);
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'wave';
        this.queueWave(this.wave);
      }
    } else if (this.phase === 'wave') {
      while (this.spawnQueue.length && this.spawnQueue[0].at <= w.time) {
        const s = this.spawnQueue.shift()!;
        const lane = this.layout.lanes[s.side % this.layout.lanes.length];
        const at = this.spawnPoint(lane.spawn, lane.spawnSpread);
        const toward = this.holdfast?.position ?? lane.spawn;
        const u = w.spawnUnit(s.kind, at.x, at.z, Math.atan2(toward.x - at.x, toward.z - at.z), (unit) => new CrawlBrain(unit));
        this.crawl.add(u);
      }
      if (!this.spawnQueue.length && this.crawl.size === 0) {
        this.wave++;
        if (this.wave >= this.totalWaves) {
          this.win('The line held. Calder stands.');
        } else {
          this.phase = 'countdown';
          this.countdown = 15;
          // Riggers patch up whatever is still standing between waves.
          for (const b of w.buildings) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.3);
          this.onMessage?.('WAVE CLEARED', `Riggers patching up the defenses · next wave in ${this.countdown} seconds`);
          if (!this.script) this.setWaypoint(null);
        }
      }
    }
  }
}
