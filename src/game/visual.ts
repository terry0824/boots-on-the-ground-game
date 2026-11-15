import * as THREE from 'three';
import type { BakedClip, Crowd } from '../engine/crowd.ts';
import type { ModelInstance, ModelTemplate, PlayOptions } from '../engine/model.ts';
import { Emitters, particles, type BoneSource } from '../engine/particles.ts';

/**
 * How a unit is drawn. Most units are one instance in a GPU crowd; the unit the player is
 * controlling is a full skeleton (a "hero"), which allows layered animation and aiming.
 */
export interface Visual {
  readonly template: ModelTemplate;
  readonly animation: string;
  /** The clip playing: the variant picked ("Death 02"), not the base name. */
  readonly variant: string;
  /** Seconds into the current animation. */
  readonly time: number;
  /** Whether the current animation loops (a Stand) or plays once and holds (a brace transformation). */
  readonly looping: boolean;
  /** Plays an animation by base name (numbered variants picked at random); returns its length in seconds, 0 if missing. */
  play(name: string, opts?: PlayOptions): number;
  /** Continues an animation from `time` seconds in, when a unit changes visuals. */
  resume(name: string, time: number, loop?: boolean): void;
  setTimeScale(scale: number): void;
  update(dt: number): void;
  sync(position: THREE.Vector3, yaw: number, scale: number): void;
  /** World position of an attachment point ("Ref_Weapon", "Ref_Head", ...). */
  attachment(name: string, out: THREE.Vector3): THREE.Vector3 | null;
  /** A hit: a brief flash and a flinch away from `dir` (world, horizontal), scaled 0..1. */
  hit(dir: THREE.Vector3, strength: number): void;
  /** A hit that doesn't move it (a building): only the flash. */
  flash(strength: number): void;
  /** Tread texture scroll, left and right, in model units traveled. */
  treadLeft: number;
  treadRight: number;
  /** How far its wheels have turned, as seconds into its Walk (where the model has wheels: see `ModelTemplate.wheels`). */
  wheel: number;
  /** 0 intact, 1 gone. */
  dissolve: number;
  /** Roll into a turn, radians (flyers bank); positive dips the right side. */
  bank: number;
  /** 0 standing .. 1 flat on its back (a downed soldier). */
  lie: number;
  /** The ground's lean under it, turning world up onto the slope (a tracked machine on a ramp: see `KindDef.tilt`). */
  readonly ground: THREE.Quaternion;
  dispose(): void;
}

const m = new THREE.Matrix4();
const world = new THREE.Matrix4();
const q = new THREE.Quaternion();
const qTilt = new THREE.Quaternion();
const s = new THREE.Vector3();
const p = new THREE.Vector3();
const qBank = new THREE.Quaternion();
const axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);
const qLie = new THREE.Quaternion();
/** Flat on the back: a little short of a right angle, so the pack doesn't sink into the ground. */
const LIE_ANGLE = -Math.PI / 2 * 0.92;

/** Hit reactions shared by both kinds of visual: a flash that fades and a flinch that springs back. */
class Reaction {
  flash = 0;
  /** Horizontal shove, meters, and its direction. */
  readonly offset = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  tilt = 0;
  private tiltVelocity = 0;
  readonly tiltAxis = new THREE.Vector3(1, 0, 0);

  /** `strength` already accounts for the target's size: a rifle round rocks a Hound, not an Tusker. */
  hit(dir: THREE.Vector3, strength: number) {
    this.light(strength);
    this.velocity.addScaledVector(dir, strength * 2.6);
    this.tiltVelocity += strength * 2.4;
    this.tiltAxis.crossVectors(UP, dir).normalize();
  }

  /** Just the flash. */
  light(strength: number) {
    this.flash = Math.min(1, this.flash + 0.35 + 0.35 * Math.min(1, strength));
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 7);
    // A stiff spring back to rest.
    const k = 160;
    const c = 18;
    this.velocity.addScaledVector(this.offset, -k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.offset.addScaledVector(this.velocity, dt);
    this.tiltVelocity += -k * this.tilt * dt;
    this.tiltVelocity *= Math.max(0, 1 - c * dt);
    this.tilt += this.tiltVelocity * dt;
  }
}

/** How long two clips blend when a crowd unit changes animation. */
const CROWD_FADE = 0.16;

export class CrowdVisual implements Visual, BoneSource {
  private slot: number;
  /**
   * Its slot given back: nothing more is written to it. A unit dying inside its own update (a
   * Scuttle Mine bursting) is still updated that frame, which drew it back into the freed slot,
   * where it stayed; and a second release would hand one slot to two units.
   */
  private disposed = false;
  /** The model's particle emitters (blood, exhaust, glows), if it has any. */
  private emitters: Emitters | null;
  private clip: BakedClip | undefined;
  private name = '';
  time = 0;
  private timeScale = 1;
  private loop = true;
  private prev: { clip: BakedClip; time: number; loop: boolean; timeScale: number } | null = null;
  private fadeLeft = 0;
  private fadeTotal = 0;
  private position = new THREE.Vector3();
  private yaw = 0;
  private scale = 1;
  private reaction = new Reaction();
  /** Extra height offset, for corpses sinking into the ground. */
  sink = 0;
  treadLeft = 0;
  treadRight = 0;
  wheel = 0;
  dissolve = 0;
  bank = 0;
  lie = 0;
  readonly ground = new THREE.Quaternion();

  constructor(readonly crowd: Crowd) {
    this.slot = crowd.add();
    this.emitters = particles.has(crowd.template) ? new Emitters(crowd.template) : null;
  }

  get template(): ModelTemplate {
    return this.crowd.template;
  }

  get animation(): string {
    return this.name;
  }

  get variant(): string {
    return this.clip?.name ?? '';
  }

  get looping(): boolean {
    return this.loop;
  }

  play(name: string, opts: PlayOptions = {}): number {
    const { loop = true, timeScale = 1, restart = false, fade = CROWD_FADE } = opts;
    if (name === this.name && this.clip && !restart) {
      this.timeScale = timeScale;
      return this.clip.duration;
    }
    const clip = this.crowd.pick(name);
    if (!clip) return 0;
    // Blend out of whatever was playing.
    if (this.clip && fade > 0) {
      this.prev = { clip: this.clip, time: this.time, loop: this.loop, timeScale: this.timeScale };
      this.fadeLeft = this.fadeTotal = fade;
    } else this.prev = null;
    this.clip = clip;
    this.name = name;
    this.time = 0;
    this.timeScale = timeScale;
    this.loop = loop;
    return clip.duration;
  }

  /** Continues an animation from a given time, when switching over from another visual. */
  resume(name: string, time: number, loop = true) {
    if (this.play(name, { loop, restart: true, fade: 0 })) this.time = time;
  }

  setTimeScale(scale: number) {
    this.timeScale = scale;
  }

  hit(dir: THREE.Vector3, strength: number) {
    this.reaction.hit(dir, strength);
  }

  flash(strength: number) {
    this.reaction.light(strength);
  }

  update(dt: number) {
    if (this.disposed) return;
    this.time += dt * this.timeScale;
    this.reaction.update(dt);
    let fade = 0;
    if (this.prev) {
      this.prev.time += dt * this.prev.timeScale;
      this.fadeLeft -= dt;
      if (this.fadeLeft <= 0) this.prev = null;
      else fade = this.fadeLeft / this.fadeTotal;
    }
    if (this.clip) this.crowd.set(this.slot, this.matrix(), this.clip, this.time, this.loop, this.prev, fade);
    this.crowd.setFx(this.slot, this.reaction.flash * 0.5, this.treadLeft, this.treadRight, this.dissolve);
    if (this.emitters && this.clip) {
      this.emitters.density = this.dissolve < 1 && particles.near(this.position, this.scale) ? particles.density : 0;
      this.emitters.update(dt, this.clip.name, this.time, this.loop, this, this.timeScale < 0);
    }
  }

  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null {
    if (!this.clip || !this.crowd.bone(index, this.clip, this.time, this.loop, out)) return null;
    return out.premultiply(world.copy(this.matrix()));
  }

  sync(position: THREE.Vector3, yaw: number, scale: number) {
    this.position.copy(position);
    this.yaw = yaw;
    this.scale = scale;
  }

  private matrix(): THREE.Matrix4 {
    q.setFromAxisAngle(UP, this.yaw);
    if (this.bank !== 0) q.multiply(qBank.setFromAxisAngle(FORWARD, this.bank));
    if (this.lie !== 0) q.multiply(qLie.setFromAxisAngle(RIGHT, LIE_ANGLE * this.lie));
    if (this.ground.w < 1) q.premultiply(this.ground);
    if (this.reaction.tilt !== 0) q.premultiply(qTilt.setFromAxisAngle(this.reaction.tiltAxis, this.reaction.tilt));
    s.setScalar(this.scale);
    p.copy(this.position).add(this.reaction.offset);
    m.compose(p, q, s);
    m.elements[13] -= this.sink;
    return m;
  }

  attachment(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.clip) return null;
    const a = this.crowd.attachment(name, this.clip, this.time, this.loop, out);
    return a ? a.applyMatrix4(this.matrix()) : null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.crowd.remove(this.slot);
  }
}

export class HeroVisual implements Visual, BoneSource {
  private reaction = new Reaction();
  /** Extra height offset, for wrecks settling into the ground. */
  sink = 0;
  private emitters: Emitters | null;
  /** Whether the skeleton's world matrices are current this frame. */
  private posed = false;
  private position = new THREE.Vector3();
  private yaw = 0;
  private scale = 1;
  treadLeft = 0;
  treadRight = 0;
  wheel = 0;
  dissolve = 0;
  bank = 0;
  lie = 0;
  readonly ground = new THREE.Quaternion();
  /** Nose down (radians): a flung creature diving. */
  pitch = 0;

  constructor(
    readonly instance: ModelInstance,
    private scene: THREE.Scene,
  ) {
    scene.add(instance.object);
    instance.object.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    this.emitters = particles.has(instance.template) ? new Emitters(instance.template) : null;
  }

  get template(): ModelTemplate {
    return this.instance.template;
  }

  get animation(): string {
    return this.instance.animation;
  }

  get variant(): string {
    return this.instance.clip;
  }

  get time(): number {
    return this.instance.time;
  }

  get looping(): boolean {
    return this.instance.looping;
  }

  play(name: string, opts?: PlayOptions): number {
    return this.instance.play(name, opts)?.getClip().duration ?? 0;
  }

  resume(name: string, time: number, loop = true) {
    const action = this.instance.play(name, { loop, restart: true, fade: 0 });
    if (!action) return;
    const d = action.getClip().duration;
    action.time = loop && d > 0 ? time % d : Math.min(time, d);
  }

  setTimeScale(scale: number) {
    this.instance.setTimeScale(scale);
  }

  hit(dir: THREE.Vector3, strength: number) {
    this.reaction.hit(dir, strength * 0.5);
  }

  flash(strength: number) {
    this.reaction.light(strength * 0.5);
  }

  update(dt: number) {
    this.instance.update(dt);
    // Its wheels turn as far as it has gone, but not through its death: a Death clip may move the same bone (a
    // rolling body that topples on its side) and has the last word on it.
    if (this.instance.template.wheels.length && !this.instance.animation.startsWith('Death')) this.instance.roll(this.wheel);
    this.reaction.update(dt);
    // Only an instance with materials of its own has effects of its own: the rest share theirs.
    if (this.instance.ownMaterials) this.instance.fx.set(this.reaction.flash * 0.6, this.treadLeft, this.dissolve, this.treadRight);
    this.place();
    if (this.emitters) {
      this.posed = false;
      this.emitters.density = this.dissolve < 1 && particles.near(this.position, this.scale) ? particles.density : 0;
      this.emitters.update(dt, this.instance.clip, this.instance.time, this.instance.looping, this, this.instance.timeScale < 0);
    }
  }

  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null {
    const bone = this.instance.mesh.skeleton.bones[index];
    if (!bone) return null;
    if (!this.posed) {
      this.instance.object.updateMatrixWorld(true);
      this.posed = true;
    }
    return out.copy(bone.matrixWorld);
  }

  sync(position: THREE.Vector3, yaw: number, scale: number) {
    this.position.copy(position);
    this.yaw = yaw;
    this.scale = scale;
    this.place();
  }

  private place() {
    const o = this.instance.object;
    o.position.copy(this.position).add(this.reaction.offset);
    o.position.y -= this.sink;
    o.quaternion.setFromAxisAngle(UP, this.yaw);
    if (this.bank !== 0) o.quaternion.multiply(qBank.setFromAxisAngle(FORWARD, this.bank));
    if (this.lie !== 0) o.quaternion.multiply(qLie.setFromAxisAngle(RIGHT, LIE_ANGLE * this.lie));
    if (this.pitch !== 0) o.quaternion.multiply(qLie.setFromAxisAngle(RIGHT, this.pitch));
    if (this.ground.w < 1) o.quaternion.premultiply(this.ground);
    if (this.reaction.tilt !== 0) o.quaternion.premultiply(qTilt.setFromAxisAngle(axis.copy(this.reaction.tiltAxis), this.reaction.tilt));
    o.scale.setScalar(this.scale);
  }

  attachment(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const bone = this.instance.attachment(name);
    return bone ? bone.getWorldPosition(out) : null;
  }

  dispose() {
    this.scene.remove(this.instance.object);
  }
}
