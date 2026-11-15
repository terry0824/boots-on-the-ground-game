import * as THREE from 'three';
import type { ModelSequence } from './modeldata.ts';
import type { ModelTemplate } from './model.ts';
import { Emitters, particles, trackAt, type BoneSource } from './particles.ts';

/** Model data is Z-up; the world is Y-up. */
const Z_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const s = new THREE.Vector3();
const yawQ = new THREE.Quaternion();
const RIGHT = new THREE.Vector3(1, 0, 0);
const hYaw = new THREE.Quaternion();
const hPitch = new THREE.Quaternion();

/**
 * `out` turned so a model's front lies along `dir`: a yaw about up, then a pitch, never a roll.
 * A model's front is its -Y (a missile's tip, a unit's Ref_Head; its +X is its left), which
 * stood up from the model data's Z-up is +Z, as a unit's at yaw 0. (Turned by the shortest arc
 * from +X instead, every missile flew broadside, its nose a quarter turn to the right of its
 * path, and one climbing or diving across -Z rolled over.)
 */
export function heading(dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  hYaw.setFromAxisAngle(UP, Math.atan2(dir.x, dir.z));
  hPitch.setFromAxisAngle(RIGHT, Math.atan2(-dir.y, Math.hypot(dir.x, dir.z)));
  return out.copy(hYaw).multiply(hPitch);
}

/**
 * One play of an effect model: a weapon's impact, a launch flash, the reaction of what it hit.
 * Effect models are mostly particle systems riding a few animated bones; this poses those bones
 * on the CPU from the sequence's tracks (no skinned mesh, no mixer), so a battle can throw
 * hundreds of them.
 */
export class EffectModel implements BoneSource {
  private time = 0;
  private emitters: Emitters;
  private seq: ModelSequence | null;
  private root = new THREE.Matrix4();
  private pose = new Map<number, THREE.Matrix4>();
  private scale: number;
  done = false;
  /**
   * Where it's carried on to each frame while it plays (a launch flash on the gun that fired it,
   * which moves with the machine), or null to stay where it began; a null answer leaves it too.
   */
  follow: ((out: THREE.Vector3) => THREE.Vector3 | null) | null = null;

  /**
   * `carried`: a missile's model, riding the missile until it lands: its "Stand" loops (the
   * glow and the trail its emitters leave, at their own rates where the Stand doesn't key
   * them), and the missile moves it with `moveTo`.
   */
  constructor(
    readonly template: ModelTemplate,
    at: THREE.Vector3,
    yaw: number,
    scale: number,
    private carried = false,
  ) {
    this.emitters = new Emitters(template);
    this.emitters.steady = carried;
    this.scale = scale;
    const seqs = template.data.sequences.filter((x) => !/^GL/.test(x.name));
    const stand = carried ? seqs.filter((x) => /^Stand/.test(x.name)) : [];
    if (stand.length) this.seq = stand[0];
    else {
      // A variant of its first animation ("Birth", "Birth 01"; impacts that splash play "Death").
      const base = seqs[0]?.name.replace(/ \d+$/, '');
      const options = seqs.filter((x) => x.name.replace(/ \d+$/, '') === base);
      this.seq = options[Math.floor(Math.random() * options.length)] ?? null;
    }
    this.root.compose(at, yawQ.setFromAxisAngle(UP, yaw), s.setScalar(scale)).multiply(Z_UP);
  }

  /** A carried model follows its missile: at `at`, its front (see `heading`) along `dir`. */
  moveTo(at: THREE.Vector3, dir: THREE.Vector3) {
    if (dir.lengthSq() < 1e-8) return;
    this.root.compose(at, heading(dir, q), s.setScalar(this.scale)).multiply(Z_UP);
  }

  /** The missile has landed: its model stops; what its emitters already left fades on its own. */
  stop() {
    this.done = true;
  }

  update(dt: number) {
    if (this.done) return;
    this.time += dt;
    const at = this.follow?.(v);
    if (at) this.root.setPosition(at);
    this.pose.clear();
    if (this.seq) this.emitters.update(dt, this.seq.name, this.time, this.carried, this);
    if (!this.seq || (!this.carried && this.time > this.seq.duration)) this.done = true;
  }

  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null {
    const m = this.bone(index);
    return m ? out.multiplyMatrices(this.root, m) : null;
  }

  /** A bone's transform in model space at the current time, through its parents. */
  private bone(i: number): THREE.Matrix4 | null {
    const cached = this.pose.get(i);
    if (cached) return cached;
    const b = this.template.data.bones[i];
    if (!b) return null;
    const tracks = this.seq?.tracks;
    const t = this.time;
    const loc = tracks?.get(b.locationAnim);
    const rot = tracks?.get(b.rotationAnim);
    const scl = tracks?.get(b.scaleAnim);
    v.set(...(loc ? ([0, 1, 2].map((c) => trackAt(loc, t, 3, c)) as [number, number, number]) : b.location));
    if (rot) q.set(trackAt(rot, t, 4, 0), trackAt(rot, t, 4, 1), trackAt(rot, t, 4, 2), trackAt(rot, t, 4, 3)).normalize();
    else q.fromArray(b.rotation);
    s.set(...(scl ? ([0, 1, 2].map((c) => trackAt(scl, t, 3, c)) as [number, number, number]) : b.scale));
    const m = new THREE.Matrix4().compose(v, q, s);
    if (b.parent >= 0) {
      const parent = this.bone(b.parent);
      if (parent) m.premultiply(parent);
    }
    this.pose.set(i, m);
    return m;
  }
}

/** The effects playing in the world. */
export class EffectModels {
  private active: EffectModel[] = [];
  /** Most effects at once; past it, new ones are skipped (the particles already on screen carry the scene). */
  max = 400;

  /**
   * Plays `template` at `at`, turned to `yaw` (its front toward that heading), `scale` meters per
   * model unit. Skipped far from the camera, where its particles wouldn't show.
   */
  play(template: ModelTemplate, at: THREE.Vector3, yaw: number, scale: number, follow: EffectModel['follow'] = null) {
    if (!particles.enabled || this.active.length >= this.max || !particles.near(at, scale)) return;
    const e = new EffectModel(template, at, yaw, scale);
    e.follow = follow;
    this.active.push(e);
  }

  /** A missile's model, carried along its flight; null where it wouldn't show (too far, too many). */
  carry(template: ModelTemplate, at: THREE.Vector3, dir: THREE.Vector3, scale: number): EffectModel | null {
    if (!particles.enabled || this.active.length >= this.max || !particles.near(at, scale)) return null;
    const e = new EffectModel(template, at, 0, scale, true);
    e.moveTo(at, dir);
    this.active.push(e);
    return e;
  }

  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.update(dt);
      if (e.done) this.active.splice(i, 1);
    }
  }

  get count(): number {
    return this.active.length;
  }
}
