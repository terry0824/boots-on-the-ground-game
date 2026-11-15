import * as THREE from 'three';
import type { EchoId } from './echo.ts';
import type { Input } from '../engine/input.ts';
import type { Avatar, PlayerStats } from './avatar.ts';
import type { Warship } from './warship.ts';
import type { Controller, Entity, Unit } from './entity.ts';
import type { KindName } from './kinds.ts';
import type { Charging, UltimateId } from './ultimate.ts';
import type { VehicleSpecial } from './vehicle.ts';
import type { Mission } from './mission.ts';
import type { PortraitName } from './portrait.ts';
import type { World } from './world.ts';

/** A shot a script directs: where the camera is, what it looks at, its field of view. */
export interface CameraPose {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fov: number;
}

/** What a mission script can see of the game around it. */
export interface ScriptHost {
  /** The body the player is in, if any. */
  avatar(): Avatar | null;
  ship: Warship;
  /** Experience for something the player did (a base taken). */
  reward?(xp: number, label: string): void;
  /** Skyscans in effect (the call-ins'). */
  sweeps?(): number;
  /** Tops the Skywatch's energy up to at least `at` (a drill's spare scans). */
  orbitalEnergy?(at: number): void;
  /** Charges the body's ultimate (Q) in full: a drill that teaches it. */
  chargeUltimate?(): void;
  /** How the body's ultimate charges from now on (the Practice Range's quick recharge). */
  ultimateCharging?(how: Charging): void;
  /** Puts the player in `u` at once (the Practice Range's unit picker). */
  possess?(u: Unit): void;
  /** Dims the battlefield toward night: 0 day, 1 night. */
  setNight?(k: number): void;
  /**
   * Puts the sun in the sky over `toward` (a direction across the ground), `elevation` radians
   * up, with the sky's fill light at `fill` of the map's (low for a backlit look).
   */
  setSun?(toward: THREE.Vector3, elevation: number, fill?: number): void;
  /** The keyboard and mouse, for a script with screens of its own (The Tide's requisition board). */
  input?: Input;
  /** The player's shots, hits, kills and deaths (read once the mission has begun). */
  readonly stats?: PlayerStats;
  /**
   * Takes the camera for a scripted shot (null gives it back): the HUD steps aside for a
   * letterboxed frame and the body takes no input until it's over.
   */
  cinematic?(pose: CameraPose | null): void;
  /** The view's camera, for marking places on the battlefield on screen. */
  camera?: THREE.Camera;
  /** Where the player is: in a body, up in the command view, or between bodies. */
  mode?(): 'ground' | 'command' | 'lost' | 'menu' | 'title' | string;
  /** The script's panel opened or shut on a click of its own: the mouse follows, inside the click. */
  panelChanged?(): void;
}

/** A mission's own logic, beyond (or instead of) the defense waves. */
/** What a mission's story asks of it as it plays. */
export interface StoryState {
  /** Seconds since the mission began. */
  time: number;
  wave: number;
  status(id: string): string | undefined;
  /** Whether a squadmate is in this mission and standing (or down, but not lost). */
  alive(id: EchoId): boolean;
  /** Bodies the player has lost this mission. */
  bodiesLost: number;
  /** The player is in a body on the ground (not between bodies). */
  inBody: boolean;
  /** Fenmoor's nights so far; All Hands's charge, 0..1. */
  night: number;
  charge: number;
  /** Something in the mission's script, by name (All Hands's Calyx on the field, the airfield loading). */
  flag(name: string): boolean;
}

/** A mission's story (a plugin's: src/content/provider.ts \`story\`): its voices as it plays, and the scene its debrief closes on. */
export interface MissionStory {
  update(): void;
  afterword(fallen: (id: EchoId) => boolean): { speaker: string; line: string }[];
}

export interface MissionScript {
  /**
   * Where Echo Squad holds instead of following the player (Sundown's walls at dusk and night), null to follow;
   * undefined where the mission never says.
   */
  echoHold?(): THREE.Vector3 | null | undefined;
  /** Builds the battlefield instead of the default base (assaults, Frontline). */
  setup?(): void;
  start(): void;
  update(dt: number): void;
  /** Where a fresh body deploys, when the mission decides (a captured point). */
  respawnPoint?(): THREE.Vector3 | null;
  /** What a fresh body is, when the mission decides (the Practice Range: the unit last taken). Unset: the chosen class. */
  deployKind?(): KindName | null;
  /** The mission's own key (G): Frontline's rally, the artifact's Aurora, The Tide's requisition board. */
  action?(): void;
  /**
   * A panel of the script's is open on the ground and wants the mouse (The Tide's requisition
   * board): the cursor is freed for it and the battle goes on, the body walking but not aiming.
   */
  cursor?(): boolean;
  /**
   * The script is placing something on the battlefield (a structure): its clicks are the
   * script's, so the body holds fire and the command view doesn't select or order with them.
   */
  placing?(): boolean;
  /** Esc: drops what the script is in the middle of (a placement). True if there was something. */
  cancel?(): boolean;
  /**
   * A panel of the script's that takes the keyboard while it's up (The Tide's requisition board,
   * ordered by the usual RTS hotkeys): read first each frame, before the body; true while it
   * has the keyboard, so nothing else reads it this frame.
   */
  keys?(input: Input): boolean;
  /** The number keys are the script's (The Tide's board picks a building by them), not the command view's class picks. */
  digits?: boolean;
  /** A soldier a transport set down at `at`: the mode's brain for it there (The Tide: a post in the nearest line). */
  dropped?(u: Unit, at: THREE.Vector3): Controller | null;
  /** Where a fresh body may deploy (the command console offers the choice), and the one chosen. */
  deployOptions?(): { id: string; label: string }[];
  deployChoice?: string;
  pickDeploy?(id: string): void;
  /** The player killed something (for objectives about what they bring down). */
  playerKilled?(e: Entity): void;
  /** Anything died (a building burned, a boss fell). */
  died?(e: Entity): void;
  /** The player set up a kill someone else made. */
  playerAssisted?(e: Entity): void;
  /** The player's body took a blow. */
  playerDamaged?(amount: number, maxHp: number): void;
  /** The player's body (or what it set going: a grenade, a strike, an ultimate) hurt `e` by `amount`. */
  playerDealt?(e: Entity, amount: number): void;
  /** The player spent their ultimate on `id`, which goes on for `seconds`. */
  playerUltimate?(id: UltimateId, seconds: number): void;
  /** The player's body went down. */
  playerDown?(): void;
  /** A machine's own ability on E while the player drives it, where the mode gives it one (Unleashed's Coyote: Scuttle Mines). */
  vehicleSpecial?(u: Unit): VehicleSpecial | null;
  /** A rendered frame took `ms` (for a mode that measures how smoothly it plays). */
  frameTime?(ms: number): void;
  /** How the mode measured up, as lines for the console and the debrief (a fun meter's report). */
  measured?(): string[] | null;
}

/** One line of radio traffic. */
export interface Transmission {
  speaker: string;
  portrait: PortraitName;
  line: string;
  seconds: number;
}

/** Radio lines in order, one at a time, each held long enough to read. */
export class Radio {
  private queue: Transmission[] = [];
  private left = 0;
  onLine: ((t: Transmission) => void) | null = null;

  say(speaker: string, portrait: PortraitName, line: string, seconds = Math.max(3.2, line.length / 15)) {
    this.queue.push({ speaker, portrait, line, seconds });
  }

  /** Drops lines still waiting and cuts the current one short: the moment has moved on. */
  interrupt() {
    this.queue.length = 0;
    this.left = Math.min(this.left, 0.8);
  }

  /** Nothing waiting and nothing on the air. */
  get idle(): boolean {
    return this.left <= 0 && !this.queue.length;
  }

  update(dt: number) {
    this.left -= dt;
    if (this.left <= 0 && this.queue.length) {
      const t = this.queue.shift()!;
      this.left = t.seconds + 0.35;
      this.onLine?.(t);
    }
  }
}

/**
 * A marker in the world: a column of light rising from a pulsing ring, visible across the
 * map, for wherever the player needs to go.
 */
export class Beacon {
  readonly object = new THREE.Group();
  private ring: THREE.Mesh;
  private beam: THREE.Mesh;
  private t = 0;
  private radius = 4;

  constructor(scene: THREE.Scene, color = 0x6cc8ff) {
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, time: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color; uniform float time; varying vec2 vUv;
        void main() {
          float fade = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6);
          float bands = 0.75 + 0.25 * sin(vUv.y * 60.0 - time * 4.0);
          gl_FragColor = vec4(color * fade * bands * 0.9, 1.0);
        }`,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 160, 16, 1, true), beamMat);
    this.beam.position.y = 80;
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 4, 48), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.25;
    this.object.add(this.beam, this.ring);
    this.object.visible = false;
    this.object.renderOrder = 5;
    scene.add(this.object);
  }

  show(at: THREE.Vector3 | null, radius = 4) {
    this.object.visible = !!at;
    if (!at) return;
    this.object.position.copy(at);
    this.radius = radius;
  }

  update(dt: number) {
    if (!this.object.visible) return;
    this.t += dt;
    (this.beam.material as THREE.ShaderMaterial).uniforms.time.value = this.t;
    const k = (this.t * 0.8) % 1;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    this.ring.scale.setScalar((this.radius / 4) * (1 + k * 0.35));
  }
}

/** Holds a unit still: a specimen in a pen, a target on a range. */
export class HoldBrain implements Controller {
  constructor(private u: Unit) {}
  update() {
    this.u.move.set(0, 0);
  }
}

/** A walkable spot near `p` (searching outward), at ground height. */
export function walkableNear(w: World, p: THREE.Vector3, step = 3): THREE.Vector3 {
  if (w.walkable(p.x, p.z)) return p.clone().setY(w.terrain.heightAt(p.x, p.z));
  for (let r = step; r < step * 12; r += step) {
    for (let a = 0; a < 12; a++) {
      const x = p.x + Math.cos((a / 12) * Math.PI * 2) * r;
      const z = p.z + Math.sin((a / 12) * Math.PI * 2) * r;
      if (w.walkable(x, z)) return new THREE.Vector3(x, w.terrain.heightAt(x, z), z);
    }
  }
  return p.clone();
}

/** Whether the ground and the buildings between two points leave a clear line of fire. */
export function lineOfFire(w: World, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const steps = Math.ceil(from.distanceTo(to) / 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const y = from.y + (to.y - from.y) * t;
    if (w.terrain.heightAt(x, z) > y - 0.15) return false;
  }
  // A bunker or a barracks in the way stops rounds as surely as a ridge.
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d2 = dx * dx + dz * dz;
  for (const b of w.buildings) {
    const t = d2 > 0 ? THREE.MathUtils.clamp(((b.position.x - from.x) * dx + (b.position.z - from.z) * dz) / d2, 0, 1) : 0;
    const off = Math.hypot(from.x + dx * t - b.position.x, from.z + dz * t - b.position.z);
    const y = from.y + (to.y - from.y) * t;
    // With room to spare: whoever takes the shot won't stand exactly where it was checked from.
    if (off < b.radius + 1.5 && y < b.position.y + b.height) return false;
  }
  return true;
}

/**
 * Open ground near `p` on the same level as `from` (within a meter and a half of its height),
 * that a soldier standing at `from` can see and shoot: for targets that must be reachable, not
 * left below a cliff where no round can find them.
 */
export function inSightNear(w: World, from: THREE.Vector3, p: THREE.Vector3, step = 2.5): THREE.Vector3 {
  const ground = w.terrain.heightAt(from.x, from.z);
  const eye = new THREE.Vector3(from.x, ground + 1.8, from.z);
  const ok = (x: number, z: number) => {
    if (!w.walkable(x, z)) return false;
    const h = w.terrain.heightAt(x, z);
    return Math.abs(h - ground) < 1.5 && lineOfFire(w, eye, new THREE.Vector3(x, h + 0.6, z));
  };
  if (ok(p.x, p.z)) return p.clone().setY(w.terrain.heightAt(p.x, p.z));
  for (let r = step; r < step * 14; r += step) {
    for (let a = 0; a < 16; a++) {
      const x = p.x + Math.cos((a / 16) * Math.PI * 2) * r;
      const z = p.z + Math.sin((a / 16) * Math.PI * 2) * r;
      if (ok(x, z)) return new THREE.Vector3(x, w.terrain.heightAt(x, z), z);
    }
  }
  // Nothing in sight out there: closer in, toward the soldier.
  for (let k = 0.8; k > 0.1; k -= 0.15) {
    const q = from.clone().lerp(p, k);
    if (ok(q.x, q.z)) return q.setY(w.terrain.heightAt(q.x, q.z));
  }
  return walkableNear(w, p);
}

/**
 * How many soldiers the `index`-th placement of a garrison becomes when the force is scaled by
 * `scale` (difficulty): whole numbers that add up to the scaled total over the placements.
 */
export function copies(scale: number, index: number): number {
  return Math.floor((index + 1) * scale + 1e-6) - Math.floor(index * scale + 1e-6);
}

/** A walkable spot a few meters from `p`, for a soldier standing beside another. */
export function beside(w: World, p: THREE.Vector3, spread = 4): THREE.Vector3 {
  const a = Math.random() * Math.PI * 2;
  const r = spread * (0.6 + Math.random() * 0.4);
  return walkableNear(w, p.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)), 1.5);
}

/** Everything still standing in a set. */
export function alive(units: Iterable<Entity>): number {
  let n = 0;
  for (const u of units) if (u.alive) n++;
  return n;
}

/**
 * Helpers every mission script uses: the radio, objectives, waypoints, the player's body.
 * Scripts are written as plain state machines over these.
 */
export abstract class ScriptBase implements MissionScript {
  protected time = 0;

  constructor(
    protected m: Mission,
    protected host: ScriptHost,
  ) {}

  protected get w(): World {
    return this.m.world;
  }

  abstract start(): void;
  protected abstract tick(dt: number): void;

  update(dt: number) {
    this.time += dt;
    this.tick(dt);
  }

  protected say(speaker: string, portrait: PortraitName, line: string, seconds?: number) {
    this.m.radio.say(speaker, portrait, line, seconds);
  }

  /** The player's body on the ground (a Trooper or a tank), if they're in one. */
  protected body(): Entity | null {
    return this.host.avatar()?.entity ?? null;
  }

  /** Draws the player's eye to the current objective, with a hint: quieter than the radio. */
  protected nudge(hint: string) {
    this.m.onNudge?.(hint);
  }

  /** Marks an objective done, with the HUD's announcement. */
  protected complete(id: string) {
    if (this.m.status.get(id) !== 'active') return;
    this.m.status.set(id, 'done');
    const o = this.m.def.objectives.find((x) => x.id === id);
    this.m.onMessage?.(o?.bonus ? 'BONUS OBJECTIVE COMPLETE' : 'OBJECTIVE COMPLETE', o?.text ?? '', 3);
    this.w.sfx.play('ui.select', { volume: 0.8 });
  }

  protected fail(id: string) {
    if (this.m.status.get(id) !== 'active') return;
    this.m.status.set(id, 'failed');
    const o = this.m.def.objectives.find((x) => x.id === id);
    this.m.onMessage?.('OBJECTIVE FAILED', o?.text ?? '', 3);
  }

  /** Reveals a hidden objective. */
  protected reveal(id: string) {
    this.m.revealed.add(id);
    const o = this.m.def.objectives.find((x) => x.id === id);
    this.m.onMessage?.(o?.bonus ? 'NEW BONUS OBJECTIVE' : 'NEW OBJECTIVE', o?.text ?? '', 3);
  }

  /** Distance on the ground from the player's body to a point (Infinity without a body). */
  protected distanceTo(p: THREE.Vector3): number {
    const b = this.body();
    return b ? Math.hypot(b.position.x - p.x, b.position.z - p.z) : Infinity;
  }
}
