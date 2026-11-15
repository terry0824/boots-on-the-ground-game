import * as THREE from 'three';
import type { ModelBone, ModelData, ModelSequence, ModelTrack } from './modeldata.ts';

/**
 * Frames of external animations: one holds a cinematic's keys for one character, on its own
 * copy of the rig. They're matched to a model's bones by name, past the rig's three-letter
 * prefix (the story-mode Troopers' MRN_, MR3_, WAR_, RMR_ and MPT_ rigs are one rig), the exact
 * name first: a character carrying a rig of its own (the Seer's GHR_ rifle on her NOV_ body) has
 * names that only differ there.
 */
const rigName = (n: string) => n.replace(/^[A-Z0-9]{3}_/, '');

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** A track's value at `t` (held at the ends, linear between keys, quaternions slerped). */
function sample(track: ModelTrack, t: number, width: number, out: number[]): boolean {
  const { times, values } = track;
  const n = times.length;
  if (!n) return false;
  let i = 0;
  while (i < n - 1 && times[i + 1] <= t) i++;
  if (n === 1 || t <= times[0] || i >= n - 1) {
    const k = t <= times[0] ? 0 : i;
    for (let c = 0; c < width; c++) out[c] = values[k * width + c];
    return true;
  }
  const u = (t - times[i]) / Math.max(1e-6, times[i + 1] - times[i]);
  if (width === 4) {
    qa.fromArray(values, i * 4).slerp(qb.fromArray(values, (i + 1) * 4), u);
    out[0] = qa.x;
    out[1] = qa.y;
    out[2] = qa.z;
    out[3] = qa.w;
  } else for (let c = 0; c < width; c++) out[c] = values[i * width + c] * (1 - u) + values[(i + 1) * width + c] * u;
  return true;
}

export interface BoneLocal {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/**
 * Each of `bones`' local transforms at `t` seconds of `seq` of `anim`: the animation's keys for
 * the bone of the same name, or its own rest where the animation has no such bone.
 */
export function frameOf(bones: ModelBone[], anim: ModelData, seq: ModelSequence, t: number): BoneLocal[] {
  const exact = new Map(anim.bones.map((b) => [b.name, b]));
  const byName = new Map(anim.bones.map((b) => [rigName(b.name), b]));
  const v = [0, 0, 0, 0];
  return bones.map((b) => {
    const src = exact.get(b.name) ?? byName.get(rigName(b.name));
    const out: BoneLocal = { position: new THREE.Vector3(...b.location), quaternion: new THREE.Quaternion(...b.rotation), scale: new THREE.Vector3(...b.scale) };
    if (!src) return out;
    const loc = seq.tracks.get(src.locationAnim);
    const rot = seq.tracks.get(src.rotationAnim);
    const scl = seq.tracks.get(src.scaleAnim);
    if (loc && sample(loc, t, 3, v)) out.position.set(v[0], v[1], v[2]);
    else out.position.set(...src.location);
    if (rot && sample(rot, t, 4, v)) out.quaternion.set(v[0], v[1], v[2], v[3]);
    else out.quaternion.set(...src.rotation);
    if (scl && sample(scl, t, 3, v)) out.scale.set(v[0], v[1], v[2]);
    else out.scale.set(...src.scale);
    return out;
  });
}

/** The bones' world matrices (in the model's own Z-up space) for these local transforms. */
export function worldOf(bones: ModelBone[], locals: BoneLocal[]): THREE.Matrix4[] {
  const world: THREE.Matrix4[] = [];
  bones.forEach((b, i) => {
    const l = locals[i];
    const m = new THREE.Matrix4().compose(l.position, l.quaternion, l.scale);
    world[i] = b.parent >= 0 ? world[b.parent].clone().multiply(m) : m;
  });
  return world;
}
