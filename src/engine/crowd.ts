import * as THREE from 'three';
import { hiddenStandIn, layerValues, type ModelTemplate } from './model.ts';

/** Frames per second the animations are baked at; the shader blends between frames. */
const FPS = 30;
/**
 * Attachment points whose positions are baked too, for muzzle flashes and the like: and the
 * barrels, tubes and pods weapons fire from in turn (a Picket's two autocannons and six
 * Seeker tubes, a Bulwark's four Lance pods, an Behemoth's chest guns, a pair of Gatlings), where
 * a model has them.
 */
const ATTACHMENTS = [
  'Ref_Weapon', 'Ref_Head', 'Ref_Center', 'Ref_Overhead', 'Ref_Weapon Left', 'Ref_Weapon Right', 'Ref_Weapon Bottom',
  ...Array.from({ length: 18 }, (_, i) => `Ref_Weapon ${String(i + 1).padStart(2, '0')}`),
];

export interface BakedClip {
  name: string;
  /** First row of this clip in the bone texture. */
  row: number;
  frames: number;
  duration: number;
}

/**
 * GLSL shared by the color and depth passes: skinning from the baked bone texture. Each
 * instance samples two neighboring frames of its clip, and while it crossfades from its
 * previous clip, two frames of that one too.
 */
export const CROWD_VERTEX_PARS = /* glsl */ `
  uniform highp sampler2D crowdBones;
  attribute vec4 crowdAnim; // frame row, next frame row, blend between them, crossfade weight
  attribute vec4 crowdPrev; // the same for the clip being faded out
  attribute vec4 skinIndex;
  attribute vec4 skinWeight;
  mat4 crowdBone(float row, float bone) {
    ivec2 p = ivec2(int(bone) * 3, int(row));
    vec4 a = texelFetch(crowdBones, p, 0);
    vec4 b = texelFetch(crowdBones, p + ivec2(1, 0), 0);
    vec4 c = texelFetch(crowdBones, p + ivec2(2, 0), 0);
    return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
  }
  mat4 crowdPose(float row) {
    return skinWeight.x * crowdBone(row, skinIndex.x) + skinWeight.y * crowdBone(row, skinIndex.y)
         + skinWeight.z * crowdBone(row, skinIndex.z) + skinWeight.w * crowdBone(row, skinIndex.w);
  }
  mat4 crowdSkin() {
    mat4 m = crowdPose(crowdAnim.x) * (1.0 - crowdAnim.z) + crowdPose(crowdAnim.y) * crowdAnim.z;
    if (crowdAnim.w > 0.001) {
      mat4 p = crowdPose(crowdPrev.x) * (1.0 - crowdPrev.z) + crowdPose(crowdPrev.y) * crowdPrev.z;
      m = m * (1.0 - crowdAnim.w) + p * crowdAnim.w;
    }
    return m;
  }
  #ifdef MAT_LAYER_CROWD
    // A material's layer values at this instance's pose: its column of the layer texture, blended
    // between frames and clips as the bones are.
    uniform highp sampler2D crowdLayers;
    vec4 crowdLayerAt(int column, float row) {
      return texelFetch(crowdLayers, ivec2(column, int(row)), 0);
    }
    vec4 crowdLayer(int column) {
      vec4 l = mix(crowdLayerAt(column, crowdAnim.x), crowdLayerAt(column, crowdAnim.y), crowdAnim.z);
      if (crowdAnim.w > 0.001) {
        vec4 p = mix(crowdLayerAt(column, crowdPrev.x), crowdLayerAt(column, crowdPrev.y), crowdPrev.z);
        l = mix(l, p, crowdAnim.w);
      }
      return l;
    }
  #endif
`;

/** Patches a vertex shader to skin from the bone texture. */
export function injectCrowdSkinning(vertexShader: string, withNormals: boolean): string {
  let s = vertexShader.replace('#include <common>', `#include <common>\n${CROWD_VERTEX_PARS}`);
  if (withNormals) {
    s = s
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nmat4 crowdM = crowdSkin();\nobjectNormal = normalize(mat3(crowdM) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = (crowdM * vec4(transformed, 1.0)).xyz;');
  } else {
    s = s.replace('#include <begin_vertex>', '#include <begin_vertex>\nmat4 crowdM = crowdSkin();\ntransformed = (crowdM * vec4(transformed, 1.0)).xyz;');
  }
  return s;
}

/**
 * Many copies of one model, drawn as a single instanced mesh and skinned on the GPU from
 * animations baked into a float texture: one row per frame, three texels (a 3x4 matrix) per bone.
 * Thousands of animated units cost a handful of draw calls and no per-unit animation mixers.
 */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  readonly bones: THREE.DataTexture;
  /**
   * Per frame (rows, as in `bones`) and material (columns): the material's layer values
   * (alpha mask multiply and add, color multiply; see layerValues), and in w whether it casts a
   * shadow then. One more column, never casting, for vertices no material draws.
   */
  readonly layers: THREE.DataTexture;
  private clips = new Map<string, BakedClip>();
  private attachments = new Map<string, Float32Array>();
  /** World matrices (3x4, model space) of the bones particle emitters ride, per baked frame. */
  private emitterBones = new Map<number, Float32Array>();
  private anim: THREE.InstancedBufferAttribute;
  private prev: THREE.InstancedBufferAttribute;
  /** Per instance: hit flash, left tread, dissolve, right tread (see the model's materials). */
  private fx: THREE.InstancedBufferAttribute;
  private free: number[] = [];
  private top = 0;
  private dirty = false;
  private static zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly template: ModelTemplate,
    team: THREE.Color,
    readonly capacity: number,
    clipFilter: RegExp,
  ) {
    // Pose a full skeleton once per frame of every clip we need and record its skin matrices.
    const probe = template.instantiate(team);
    const skeleton = probe.mesh.skeleton;
    const boneCount = skeleton.bones.length;
    const clips = [...template.clips.values()].filter((c) => clipFilter.test(c.name));
    let rows = 0;
    for (const c of clips) {
      const frames = Math.max(2, Math.ceil(c.duration * FPS) + 1);
      this.clips.set(c.name, { name: c.name, row: rows, frames, duration: c.duration });
      rows += frames;
    }
    rows = Math.max(rows, 1);
    const width = boneCount * 3;
    const data = new Float32Array(width * rows * 4);
    const attachBones = new Map<string, THREE.Bone>();
    for (const name of ATTACHMENTS) {
      const bone = probe.attachment(name);
      if (bone) {
        attachBones.set(name, bone);
        this.attachments.set(name, new Float32Array(rows * 3));
      }
    }
    for (const e of template.data.emitters) {
      for (const b of [e.bone, ...e.copies.map((c) => c.bone)]) {
        if (b < boneCount && !this.emitterBones.has(b)) this.emitterBones.set(b, new Float32Array(rows * 12));
      }
    }
    const materials = template.data.materials.length;
    const columns = materials + 1;
    const layerData = new Float32Array(columns * rows * 4);
    const value = new THREE.Vector4();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (const c of clips) {
      const baked = this.clips.get(c.name)!;
      const seq = template.data.sequences.find((s) => s.name === c.name) ?? null;
      probe.mixer.stopAllAction();
      const action = probe.mixer.clipAction(c);
      action.reset().setLoop(THREE.LoopOnce, 1).play();
      action.clampWhenFinished = true;
      for (let f = 0; f < baked.frames; f++) {
        action.time = Math.min(c.duration, f / FPS);
        probe.mixer.update(0);
        probe.object.updateMatrixWorld(true);
        const row = baked.row + f;
        for (let i = 0; i < materials; i++) {
          const anim = template.layerAnims[i];
          layerValues(anim, anim.animated ? seq : null, action.time, value);
          layerData.set([value.x, value.y, value.z, anim.shadow ? value.w : 0], (row * columns + i) * 4);
        }
        for (let b = 0; b < boneCount; b++) {
          m.multiplyMatrices(skeleton.bones[b].matrixWorld, skeleton.boneInverses[b]);
          const e = m.elements;
          const o = (row * width + b * 3) * 4;
          data.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], o);
        }
        // A hidden batch folds into a point (see withShownBatches): its stand-ins all zero.
        for (const b of template.standIns) if (hiddenStandIn(skeleton.bones[b])) data.fill(0, (row * width + b * 3) * 4, (row * width + b * 3 + 3) * 4);
        for (const [name, bone] of attachBones) {
          bone.getWorldPosition(p);
          this.attachments.get(name)!.set([p.x, p.y, p.z], row * 3);
        }
        for (const [b, track] of this.emitterBones) {
          const e = skeleton.bones[b].matrixWorld.elements;
          track.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]], row * 12);
        }
      }
    }
    this.bones = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
    this.bones.needsUpdate = true;
    this.layers = new THREE.DataTexture(layerData, columns, rows, THREE.RGBAFormat, THREE.FloatType);
    this.layers.needsUpdate = true;

    // Share the model's vertex buffers, adding a per-instance animation attribute.
    const source = probe.mesh.geometry;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(source.attributes)) geometry.setAttribute(name, attr);
    geometry.setIndex(source.index);
    for (const g of source.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    // Which material draws each vertex, for the shadow pass (one pass for every material).
    const owner = new Float32Array(source.attributes.position.count).fill(materials);
    const indices = template.data.indices;
    for (const b of template.data.batches) {
      if (b.material < 0) continue;
      for (let i = b.start; i < b.start + b.count; i++) owner[indices[i]] = b.material;
    }
    geometry.setAttribute('crowdMaterial', new THREE.BufferAttribute(owner, 1));
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('crowdAnim', this.anim);
    this.prev = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.prev.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('crowdPrev', this.prev);
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.fx.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('crowdFx', this.fx);

    this.mesh = new THREE.InstancedMesh(geometry, template.crowdMaterials(team, this.bones, this.layers), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.defines = { MAT_LAYER_CROWD: '' };
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.crowdBones = { value: this.bones };
      shader.uniforms.crowdLayers = { value: this.layers };
      shader.vertexShader = injectCrowdSkinning(shader.vertexShader, false)
        .replace('#include <common>', '#include <common>\nattribute float crowdMaterial;\nattribute vec4 crowdFx;')
        .replace(
          '#include <project_vertex>',
          `// No shadow from what isn't drawn solid: glows and smoke, a body burned away, a unit
          // stowed out of sight (fully dissolved).
          if (crowdLayer(int(crowdMaterial)).w < 0.5 || crowdFx.z > 0.999) transformed = vec3(0.0);
          #include <project_vertex>`,
        );
    };
    depth.customProgramCacheKey = () => 'crowd-depth';
    this.mesh.customDepthMaterial = depth;
  }

  /** A clip by exact name. */
  clip(name: string): BakedClip | undefined {
    return this.clips.get(name);
  }

  /** A random variant of an animation ("Attack" picks among "Attack", "Attack 01", ...). */
  pick(base: string): BakedClip | undefined {
    const options = this.template.variants(base).map((c) => this.clips.get(c.name)).filter((c): c is BakedClip => !!c);
    return options[Math.floor(Math.random() * options.length)];
  }

  /** Every slot taken: another instance would throw. */
  get full(): boolean {
    return !this.free.length && this.top >= this.capacity;
  }

  add(): number {
    const slot = this.free.pop() ?? this.top++;
    if (slot >= this.capacity) throw new Error(`crowd for ${this.template.path} is full`);
    this.mesh.count = Math.max(this.mesh.count, this.top);
    return slot;
  }

  remove(slot: number) {
    this.mesh.setMatrixAt(slot, Crowd.zero);
    this.fx.setXYZW(slot, 0, 0, 0, 0);
    this.free.push(slot);
    this.dirty = true;
  }

  /**
   * Places an instance and sets its pose: `time` seconds into `clip`, blended with `prev`
   * (the clip it's fading out of) by `fade`.
   */
  set(slot: number, matrix: THREE.Matrix4, clip: BakedClip, time: number, loop: boolean, prev?: { clip: BakedClip; time: number; loop: boolean } | null, fade = 0) {
    this.mesh.setMatrixAt(slot, matrix);
    const [a, b, t] = this.rows(clip, time, loop);
    if (prev && fade > 0) {
      const [pa, pb, pt] = this.rows(prev.clip, prev.time, prev.loop);
      this.prev.setXYZW(slot, pa, pb, pt, 0);
      this.anim.setXYZW(slot, a, b, t, fade);
    } else this.anim.setXYZW(slot, a, b, t, 0);
    this.dirty = true;
  }

  /** Per-instance effects: hit flash (0..1), tread scroll (left, right), dissolve (0..1). */
  setFx(slot: number, flash: number, treadLeft: number, treadRight: number, dissolve: number) {
    this.fx.setXYZW(slot, flash, treadLeft, dissolve, treadRight);
    this.dirty = true;
  }

  /** Where a baked attachment point is at a given pose, in model space. */
  attachment(name: string, clip: BakedClip, time: number, loop: boolean, out: THREE.Vector3): THREE.Vector3 | null {
    const track = this.attachments.get(name);
    if (!track) return null;
    const [a, b, t] = this.rows(clip, time, loop);
    return out.set(
      track[a * 3] + (track[b * 3] - track[a * 3]) * t,
      track[a * 3 + 1] + (track[b * 3 + 1] - track[a * 3 + 1]) * t,
      track[a * 3 + 2] + (track[b * 3 + 2] - track[a * 3 + 2]) * t,
    );
  }

  /** A particle emitter's bone at a given pose (model space), or null if it isn't baked. */
  bone(index: number, clip: BakedClip, time: number, loop: boolean, out: THREE.Matrix4): THREE.Matrix4 | null {
    const track = this.emitterBones.get(index);
    if (!track) return null;
    const [a, b, t] = this.rows(clip, time, loop);
    const e = out.elements;
    const at = (k: number) => track[a * 12 + k] + (track[b * 12 + k] - track[a * 12 + k]) * t;
    e[0] = at(0); e[1] = at(1); e[2] = at(2); e[3] = 0;
    e[4] = at(3); e[5] = at(4); e[6] = at(5); e[7] = 0;
    e[8] = at(6); e[9] = at(7); e[10] = at(8); e[11] = 0;
    e[12] = at(9); e[13] = at(10); e[14] = at(11); e[15] = 1;
    return out;
  }

  private rows(clip: BakedClip, time: number, loop: boolean): [number, number, number] {
    const last = clip.frames - 1;
    let f = time * FPS;
    if (loop && clip.duration > 0) f = ((f % (clip.duration * FPS)) + clip.duration * FPS) % (clip.duration * FPS);
    f = THREE.MathUtils.clamp(f, 0, last);
    const i = Math.floor(f);
    const j = Math.min(last, i + 1);
    return [clip.row + i, clip.row + j, f - i];
  }

  /** Uploads this frame's changes. */
  commit() {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
    this.prev.needsUpdate = true;
    this.fx.needsUpdate = true;
    this.dirty = false;
  }
}
