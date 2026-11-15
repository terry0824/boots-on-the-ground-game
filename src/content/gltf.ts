import * as THREE from 'three';
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LayerSlot, ModelAnim, ModelBatch, ModelBone, ModelLayer, ModelMaterial, ModelData, ModelSequence, ModelTrack, Quat, Vec3 } from '../engine/modeldata.ts';
import { fetchFile } from '../engine/assets.ts';
import { ModelTemplate } from '../engine/model.ts';

/**
 * The glTF adapter: an original model (a `.glb` made to docs/original-assets/conventions.md)
 * read into the engine's own model format, `ModelData`, so a ModelTemplate draws it exactly as it
 * draws the loader's: the same skeleton and clips, attachment points, death plans, crowds,
 * wheels and team color, with nothing past this file knowing which kind of file it came from.
 *
 * glTF stands Y up with its front at +Z; the engine's frame is the model data's, Z up with the
 * front at -Y, which ModelTemplate stands back up (its container turns -90 degrees about X). So
 * the model is turned a quarter the other way, C: (x, y, z) -> (x, -z, y), and only at the top of
 * its skeleton: the roots' rest poses and keys, the vertices, the inverse bind matrices. Below a
 * root every bone keeps glTF's own local transform, and past the container three.js space is
 * glTF space again.
 *
 * The bones are every joint of a skin, every `Ref_*` empty (the attachment points), every node
 * carrying a mesh without a skin (its vertices ride it whole: a helmet on a head, a barrel on a
 * turret), and every node above one of these, so a parent's own transform and keys still apply.
 * Not read: morph targets, cameras, lights, more than four joints a vertex, and anything that
 * needs a decoder (Draco or meshopt meshes, KTX2 textures).
 */

/** The textures of one material, by layer slot: what ModelTemplate takes for each material. */
export type LayerTextures = Partial<Record<LayerSlot, THREE.Texture>>;

/**
 * An original texture's brightness against the loader's (ModelMaterial.gain). The loader's are
 * authored dark and lifted by the engine (materialSettings.diffuseBoost, 3.2); an original one is
 * authored as it should look, so it takes the lift's inverse. A material's `extras.gain` overrides it.
 */
export const ORIGINAL_GAIN = 1 / 3.2;

/** A model read from a `.glb`: its model data, each material's textures, and its stride where its Walk says (ModelTemplate.walkSpeed). */
export interface GlbModel {
  data: ModelData;
  layers: LayerTextures[];
  walkSpeed?: number;
}

// The parts of glTF's JSON read here (glTF 2.0; three.js has no types for it).
interface TextureRef {
  index: number;
  texCoord?: number;
}
interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: TextureRef;
    roughnessFactor?: number;
    metallicRoughnessTexture?: TextureRef;
  };
  normalTexture?: TextureRef;
  emissiveTexture?: TextureRef;
  emissiveFactor?: number[];
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: { KHR_materials_unlit?: object; KHR_materials_emissive_strength?: { emissiveStrength?: number } };
  extras?: unknown;
}
interface GltfAnimation {
  name?: string;
  channels?: { sampler: number; target: { node?: number; path: string } }[];
  samplers?: { input: number; output: number; interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }[];
  extras?: unknown;
}
interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { material?: number }[] }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  materials?: GltfMaterial[];
  animations?: GltfAnimation[];
}

/** The quarter turn from glTF's frame into the engine's: Y up becomes Z up, the front (+Z) becomes -Y. */
const C = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const C_INVERSE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const C_TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

/** Material flags (model.ts): drawn from both sides; a depth pre-pass, which makes a blended layer with a normal map a lit see-through solid. */
const TWO_SIDED = 0x8;
const DEPTH_PREPASS = 0x100;

/** Clips that loop, as conventions.md names them (with a variant's number); `Stand Work Start` and `End` play once. */
const LOOPING = /^(Stand|Walk|Turbo|Stand Ready|Stand Work)( \d+)?$/;

/** Bone i's animation ids: its location, rotation and scale tracks in every sequence. */
const animId = (bone: number, part: 0 | 1 | 2) => 1000 + bone * 3 + part;
const PARTS: Partial<Record<string, 0 | 1 | 2>> = { translation: 0, rotation: 1, scale: 2 };

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
/** A material as GLTFLoader built it: its textures come with their color space, UV channel and transform set. */
type LoadedMaterial = THREE.Material & { map?: THREE.Texture | null; normalMap?: THREE.Texture | null; emissiveMap?: THREE.Texture | null; roughnessMap?: THREE.Texture | null };

function record(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

function still<T>(value: T): ModelAnim<T> {
  return { id: 0, value };
}

/** A layer as the engine reads it: `colorChannels` 0 RGB, 1 RGBA (the alpha a team mask, for a diffuse), 2 alpha. */
function layer(colorChannels: number, multiply = 1, uvSource = 0): ModelLayer {
  return {
    path: '',
    flags: 0,
    uvSource,
    colorChannels,
    multiply: still(multiply),
    add: still(0),
    invert: false,
    clamp: false,
    colorAnim: 0,
    alpha: 1,
    flipbook: null,
    uvOffset: still<[number, number]>([0, 0]),
    uvTiling: still<[number, number]>([1, 1]),
  };
}

/** A linear 0..1 value as an sRGB byte (glTF's factors are linear; a color texture's bytes are sRGB). */
function srgbByte(linear: number): number {
  const c = THREE.MathUtils.clamp(linear, 0, 1);
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

/** A 2x2 texture of one color (bytes: sRGB for a color, as they are for data), for a material with a factor and no texture. */
function flat(r: number, g: number, b: number, a: number, srgb: boolean): THREE.DataTexture {
  const data = new Uint8Array(16);
  for (let i = 0; i < 4; i++) data.set([r, g, b, a], i * 4);
  const t = new THREE.DataTexture(data, 2, 2);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** An accessor's values as floats, item after item (normalized integers read as glTF means them). */
async function floats(parser: GLTFParser, index: number): Promise<Float32Array> {
  const a = (await parser.getDependency('accessor', index)) as Attribute;
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
  return out;
}

/** An image's pixels (RGBA bytes, the top row first), through a 2D canvas. */
function pixels(image: unknown): { data: Uint8ClampedArray; width: number; height: number } | null {
  const source = image as CanvasImageSource & { width?: number; height?: number };
  const width = source?.width ?? 0;
  const height = source?.height ?? 0;
  if (!width || !height) return null;
  let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(width, height).getContext('2d');
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext('2d');
  }
  if (!context) return null;
  context.drawImage(source, 0, 0);
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

/**
 * The engine's specular layer (the strength of Phong's highlight, read from red) from glTF's
 * roughness (the metallic-roughness texture's green, times its factor), turned round: rough is
 * dull. Metalness has no part in it. Kept per texture and factor, as several materials share them.
 */
function specularOf(rough: THREE.Texture | null, factor: number, made: Map<string, THREE.Texture>): THREE.Texture {
  const key = `${rough?.uuid ?? 'flat'}:${factor}`;
  let t = made.get(key);
  if (t) return t;
  const img = rough ? pixels(rough.image) : null;
  if (rough && img) {
    const out = new Uint8Array(img.width * img.height * 4);
    for (let i = 0; i < img.width * img.height; i++) {
      const s = 255 - Math.round(img.data[i * 4 + 1] * factor);
      out.set([s, s, s, 255], i * 4);
    }
    const d = new THREE.DataTexture(out, img.width, img.height);
    // Sampled where its source is (the same rows: neither is flipped).
    d.wrapS = rough.wrapS;
    d.wrapT = rough.wrapT;
    d.channel = rough.channel;
    d.offset.copy(rough.offset);
    d.repeat.copy(rough.repeat);
    d.rotation = rough.rotation;
    d.center.copy(rough.center);
    d.magFilter = THREE.LinearFilter;
    d.minFilter = THREE.LinearMipmapLinearFilter;
    d.generateMipmaps = true;
    d.anisotropy = 8;
    d.colorSpace = THREE.NoColorSpace;
    d.needsUpdate = true;
    t = d;
  } else {
    const s = 255 - Math.round(255 * THREE.MathUtils.clamp(factor, 0, 1));
    t = flat(s, s, s, 255, false);
  }
  made.set(key, t);
  return t;
}

/** Image textures sampled as sharply as the loader's (the renderer caps it at what the GPU has). */
function sharpen<T extends THREE.Texture | null | undefined>(t: T): T {
  if (t && !(t as THREE.Texture & { isDataTexture?: boolean }).isDataTexture) t.anisotropy = Math.max(t.anisotropy, 8);
  return t;
}

/**
 * A glTF material as the engine's (ModelMaterial, its layers and their textures):
 *
 * - OPAQUE: the base color's alpha is the team mask (1 keeps the color, 0 takes the team's). With
 *   only a factor, the color is flat and keeps its own, or takes the team's with `extras.team`.
 * - MASK: the alpha is a cut-out instead (through an alpha mask, at alphaCutoff); no team color.
 * - BLEND: a lit see-through solid (glass), its alpha exactly how much shows; with `extras.blend:
 *   "add"` an unlit glow that adds its color, and with KHR_materials_unlit an unlit blended card.
 * - normalTexture an ordinary normal map (rgbNormal), emissive the self-lit layer, and roughness
 *   the specular. A factor over a texture keeps only its brightness (the engine has no tint).
 */
function readMaterial(def: GltfMaterial, maps: LoadedMaterial | null, label: string, made: Map<string, THREE.Texture>): { material: ModelMaterial; textures: LayerTextures } {
  const pbr = def.pbrMetallicRoughness ?? {};
  const extras = record(def.extras);
  const [r, g, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const additive = extras.blend === 'add';
  const blended = additive || def.alphaMode === 'BLEND';
  const masked = !blended && def.alphaMode === 'MASK';
  const unlit = blended && (additive || !!def.extensions?.KHR_materials_unlit);
  const solid = blended && !unlit;
  const textures: LayerTextures = {};
  const layers: ModelMaterial['layers'] = {};
  const shared = (key: string, make: () => THREE.Texture) => made.get(key) ?? made.set(key, make()).get(key)!;
  let gain = typeof extras.gain === 'number' ? extras.gain : ORIGINAL_GAIN;

  const map = sharpen(maps?.map ?? null);
  let brightness = 1;
  if (map) {
    textures.diffuse = map;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 0.01) console.warn(`${label}: the base color factor tints the texture; only its brightness is kept`);
    brightness = (r + g + b) / 3;
    // Lit layers are brightened by the gain; the unlit ones (glows) by their color's multiply.
    if (!unlit) gain *= brightness;
  } else {
    const alpha = blended || masked ? a : extras.team === true ? 0 : 1;
    textures.diffuse = flat(srgbByte(r), srgbByte(g), srgbByte(b), Math.round(alpha * 255), true);
  }
  layers.diffuse = layer(masked ? 0 : 1, unlit ? brightness : 1, map?.channel ?? 0);

  // Where the alpha is coverage, an alpha mask carries it: exactly, and times the factor's alpha.
  if (masked || solid) {
    textures.alphaMask = textures.diffuse;
    layers.alphaMask = layer(2, map ? a : 1);
  } else if (unlit && !additive && map && a < 1) {
    textures.alphaMask = shared('white', () => flat(255, 255, 255, 255, false));
    layers.alphaMask = layer(2, a);
  }

  // A see-through solid is drawn lit only with a normal map: a flat one where it has none.
  const normal = sharpen(maps?.normalMap ?? null) ?? (solid ? shared('normal', () => flat(128, 128, 255, 255, false)) : null);
  if (normal) {
    textures.normal = normal;
    layers.normal = layer(0, 1, normal.channel);
  }

  const [er, eg, eb] = def.emissiveFactor ?? [0, 0, 0];
  const strength = def.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const glow = Math.max(er, eg, eb);
  if (glow > 0) {
    // The engine lights an emissive layer white times its texture, as bright as its multiply.
    const emissive = sharpen(maps?.emissiveMap ?? null);
    textures.emissive = emissive ?? flat(srgbByte(er), srgbByte(eg), srgbByte(eb), 255, true);
    layers.emissive = layer(0, (emissive ? glow : 1) * strength, emissive?.channel ?? 0);
  }

  if (!unlit) {
    textures.specular = specularOf(maps?.roughnessMap ?? null, pbr.roughnessFactor ?? 1, made);
    layers.specular = layer(0, 1, maps?.roughnessMap?.channel ?? 0);
  }

  const material: ModelMaterial = {
    name: def.name ?? label,
    flags: (def.doubleSided ? TWO_SIDED : 0) | (solid ? DEPTH_PREPASS : 0),
    blendMode: additive ? 2 : blended ? 1 : 0,
    cutout: masked ? (def.alphaCutoff ?? 0.5) : 0,
    layers,
    gain,
    rgbNormal: true,
  };
  return { material, textures };
}

/** A node's rest transform, from its TRS or its matrix. */
function restOf(def: GltfNode): { t: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 } {
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  if (def.matrix) new THREE.Matrix4().fromArray(def.matrix).decompose(t, q, s);
  else {
    if (def.translation) t.fromArray(def.translation);
    if (def.rotation) q.fromArray(def.rotation);
    if (def.scale) s.fromArray(def.scale);
  }
  return { t, q, s };
}

/** Keys of a STEP sampler as the engine's linear ones: each held until just before the next. */
function held(times: Float32Array, values: Float32Array, width: number): ModelTrack {
  const t: number[] = [];
  const v: number[] = [];
  for (let k = 0; k < times.length; k++) {
    const gap = k > 0 ? times[k] - times[k - 1] : 0;
    if (gap > 2e-4) {
      t.push(times[k] - 1e-4);
      for (let c = 0; c < width; c++) v.push(values[(k - 1) * width + c]);
    }
    t.push(times[k]);
    for (let c = 0; c < width; c++) v.push(values[k * width + c]);
  }
  return { times: Float32Array.from(t), values: Float32Array.from(v) };
}

/**
 * The clips: each glTF animation a sequence, its tracks keyed by the bones' animation ids. Roots'
 * keys are turned into the engine's frame like their rest poses; a CUBICSPLINE sampler is read
 * by its values (its tangents dropped), a STEP one held. Morph target weights aren't read.
 */
async function readClips(parser: GLTFParser, json: GltfJson, bones: ModelBone[], boneOf: Map<number, number>, label: string): Promise<ModelSequence[]> {
  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let morphs = false;
  const sequences: ModelSequence[] = [];
  for (const [i, anim] of (json.animations ?? []).entries()) {
    const name = anim.name ?? `Animation ${i}`;
    const tracks = new Map<number, ModelTrack>();
    let duration = 0;
    for (const channel of anim.channels ?? []) {
      const sampler = anim.samplers?.[channel.sampler];
      if (!sampler) continue;
      const times = await floats(parser, sampler.input);
      if (times.length) duration = Math.max(duration, times[times.length - 1]);
      const path = channel.target.path;
      if (path === 'weights') morphs = true;
      const bone = channel.target.node === undefined ? undefined : boneOf.get(channel.target.node);
      const part = PARTS[path];
      if (bone === undefined || part === undefined) continue;
      const width = part === 1 ? 4 : 3;
      let values = await floats(parser, sampler.output);
      if (sampler.interpolation === 'CUBICSPLINE') {
        // In-tangent, value, out-tangent for each key.
        const mid = new Float32Array(times.length * width);
        for (let k = 0; k < times.length; k++) mid.set(values.subarray((k * 3 + 1) * width, (k * 3 + 2) * width), k * width);
        values = mid;
      }
      for (let k = 0; k < times.length; k++) {
        if (part === 1) {
          q.fromArray(values, k * 4).normalize();
          if (bones[bone].parent < 0) q.premultiply(C_TURN);
          q.toArray(values, k * 4);
        } else if (part === 0 && bones[bone].parent < 0) {
          v.fromArray(values, k * 3).applyQuaternion(C_TURN).toArray(values, k * 3);
        }
      }
      const id = animId(bone, part);
      tracks.set(id, sampler.interpolation === 'STEP' ? held(times, values, width) : { times, values });
    }
    const extras = record(anim.extras);
    sequences.push({ name, duration, looping: typeof extras.loop === 'boolean' ? extras.loop : LOOPING.test(name), tracks });
  }
  if (morphs) console.warn(`${label}: morph target animation isn't read`);
  return sequences;
}

/** How fast the model goes at its Walk's own rate: `extras.metersPerSecond` of its Walk, or of the first Walk variant that says. */
function strideOf(json: GltfJson): number | undefined {
  const walks = (json.animations ?? [])
    .map((a) => ({ a, m: /^Walk(?: (\d+))?$/i.exec(a.name ?? '') }))
    .filter((w) => !!w.m)
    .sort((x, y) => Number(x.m![1] ?? -1) - Number(y.m![1] ?? -1));
  for (const { a } of walks) {
    const speed = record(a.extras).metersPerSecond;
    if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) return speed;
  }
  return undefined;
}

/** A primitive to draw: its node, its skin where it's skinned (else it rides its node whole), its geometry and material. */
interface Part {
  node: number;
  skin: number | undefined;
  geometry: THREE.BufferGeometry;
  material: number | undefined;
}

/** Reads a `.glb` (glTF 2.0, binary) into the engine's model format, with each material's textures. `name` labels its warnings. */
export async function parseGlb(buffer: ArrayBuffer, name: string): Promise<GlbModel> {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const parser = gltf.parser;
  // Names as written: three.js renames nodes (no spaces or dots), and the engine looks bones up by name.
  const json = parser.json as GltfJson;
  const nodes = json.nodes ?? [];

  // The scene's nodes, parents before children.
  const order: number[] = [];
  const parentOf = new Map<number, number>();
  const visit = (n: number, parent: number) => {
    if (parentOf.has(n) || !nodes[n]) return;
    parentOf.set(n, parent);
    order.push(n);
    for (const c of nodes[n].children ?? []) visit(c, n);
  };
  const children = new Set(nodes.flatMap((n) => n.children ?? []));
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !children.has(i));
  for (const n of roots) visit(n, -1);

  // Rest poses: each node's world matrix, in glTF's frame.
  const world = new Map<number, THREE.Matrix4>();
  for (const n of order) {
    const { t, q, s } = restOf(nodes[n]);
    const m = new THREE.Matrix4().compose(t, q, s);
    const p = parentOf.get(n)!;
    world.set(n, p >= 0 ? world.get(p)!.clone().multiply(m) : m);
  }

  // What's drawn: each primitive of each mesh node (lines and points aren't).
  const parts: Part[] = [];
  for (const n of order) {
    const def = nodes[n];
    if (def.mesh === undefined) continue;
    const object = (await parser.getDependency('mesh', def.mesh)) as THREE.Object3D;
    const primitives = (object as THREE.Group).isGroup ? object.children : [object];
    const defs = json.meshes?.[def.mesh]?.primitives ?? [];
    primitives.forEach((p, i) => {
      if (!(p as THREE.Mesh).isMesh) return;
      const geometry = (p as THREE.Mesh).geometry;
      const skinned = def.skin !== undefined && !!geometry.getAttribute('skinIndex') && !!geometry.getAttribute('skinWeight');
      parts.push({ node: n, skin: skinned ? def.skin : undefined, geometry, material: defs[i]?.material });
    });
  }

  // The bones: joints, attachment points and rigid meshes' nodes, and every node above them.
  const skins = [...new Set(parts.flatMap((p) => (p.skin === undefined ? [] : [p.skin])))];
  const wanted = new Set<number>();
  for (const s of skins) for (const j of json.skins?.[s]?.joints ?? []) if (parentOf.has(j)) wanted.add(j);
  for (const p of parts) if (p.skin === undefined) wanted.add(p.node);
  for (const n of order) if (/^ref_/i.test(nodes[n].name ?? '')) wanted.add(n);
  for (const n of [...wanted]) for (let p = parentOf.get(n)!; p >= 0 && !wanted.has(p); p = parentOf.get(p)!) wanted.add(p);
  const boneNodes = order.filter((n) => wanted.has(n));
  const boneOf = new Map(boneNodes.map((n, i) => [n, i]));
  const bones: ModelBone[] = boneNodes.map((n, i) => {
    const { t, q, s } = restOf(nodes[n]);
    const parent = boneOf.get(parentOf.get(n)!) ?? -1;
    if (parent < 0) {
      t.applyQuaternion(C_TURN);
      q.premultiply(C_TURN);
    }
    return {
      name: nodes[n].name ?? `Node ${n}`,
      parent,
      location: t.toArray() as Vec3,
      rotation: q.toArray() as Quat,
      scale: s.toArray() as Vec3,
      locationAnim: animId(i, 0),
      rotationAnim: animId(i, 1),
      scaleAnim: animId(i, 2),
      visibility: still(1),
    };
  });
  // A model with nothing to hang on (no skin, no node): one root, so the skeleton isn't empty.
  if (!bones.length) bones.push({ name: 'Root', parent: -1, location: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locationAnim: animId(0, 0), rotationAnim: animId(0, 1), scaleAnim: animId(0, 2), visibility: still(1) });

  // Inverse bind matrices. A joint binds as the first skin over it says (its matrix, turned with
  // the vertices). A later skin that bound the same joint elsewhere gets its vertices moved into
  // that binding: exact where its bind differs by one matrix, as two meshes bound apart do.
  const jointBind = new Map<number, THREE.Matrix4>();
  const rebind = new Map<number, THREE.Matrix4[]>();
  for (const s of skins) {
    const skin = json.skins![s];
    const data = skin.inverseBindMatrices === undefined ? null : await floats(parser, skin.inverseBindMatrices);
    let moved = false;
    const fix = skin.joints.map((j, k) => {
      const ib = data ? new THREE.Matrix4().fromArray(data, k * 16) : new THREE.Matrix4();
      const known = jointBind.get(j);
      if (!known) {
        jointBind.set(j, ib);
        return new THREE.Matrix4();
      }
      const f = known.clone().invert().multiply(ib);
      if (f.elements.some((e, c) => Math.abs(e - (c % 5 === 0 ? 1 : 0)) > 1e-4)) moved = true;
      return f;
    });
    if (moved) rebind.set(s, fix);
  }
  // Any other bone binds where it rests. `bind` is where a vertex riding a bone whole sits.
  const inverseBind = new Float32Array(bones.length * 16);
  const bind: THREE.Matrix4[] = bones.map((_, i) => {
    const n = boneNodes[i];
    const known = n === undefined ? undefined : jointBind.get(n);
    const ib = known ? known.clone().multiply(C_INVERSE) : n === undefined ? new THREE.Matrix4() : C.clone().multiply(world.get(n)!).invert();
    inverseBind.set(ib.elements, i * 16);
    return ib.clone().invert();
  });

  // Materials, in the order the primitives first use them (a primitive without one gets glTF's default).
  const used = [...new Set(parts.map((p) => p.material))];
  const made = new Map<string, THREE.Texture>();
  const read = await Promise.all(
    used.map(async (m) => {
      const def = m === undefined ? { name: 'Default' } : (json.materials?.[m] ?? {});
      const maps = m === undefined ? null : ((await parser.getDependency('material', m)) as LoadedMaterial);
      return readMaterial(def, maps, `${name}: material ${def.name ?? m}`, made);
    }),
  );
  const materialOf = new Map(used.map((m, i) => [m, i]));

  // The vertices, in the engine's frame, each on up to four bones.
  const positions: number[] = [];
  const normals: number[] = [];
  const uv0: number[] = [];
  const uv1: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const indices: number[] = [];
  const batches: ModelBatch[] = [];
  const withUv1 = parts.some((p) => !!p.geometry.getAttribute('uv1'));
  const p = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const blend = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  for (const part of parts) {
    const g = part.geometry;
    const pos = g.getAttribute('position') as Attribute | undefined;
    if (!pos) continue;
    let nrm = g.getAttribute('normal') as Attribute | undefined;
    if (!nrm) {
      // glTF asks for flat normals where there are none; smooth ones are close enough to stand in.
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', pos);
      if (g.index) tmp.setIndex(g.index);
      tmp.computeVertexNormals();
      nrm = tmp.getAttribute('normal') as Attribute;
    }
    const uvA = g.getAttribute('uv') as Attribute | undefined;
    const uvB = g.getAttribute('uv1') as Attribute | undefined;
    const base = positions.length / 3;
    if (part.skin !== undefined) {
      const joints = json.skins![part.skin].joints;
      const fix = rebind.get(part.skin);
      const si = g.getAttribute('skinIndex') as Attribute;
      const sw = g.getAttribute('skinWeight') as Attribute;
      for (let v = 0; v < pos.count; v++) {
        p.fromBufferAttribute(pos, v);
        nv.fromBufferAttribute(nrm, v);
        if (fix) {
          blend.elements.fill(0);
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(v, k);
            const f = fix[si.getComponent(v, k)];
            if (w && f) for (let c = 0; c < 16; c++) blend.elements[c] += f.elements[c] * w;
          }
          p.applyMatrix4(blend);
          nv.applyMatrix3(normalMatrix.getNormalMatrix(blend));
        }
        p.applyMatrix4(C);
        nv.applyQuaternion(C_TURN).normalize();
        positions.push(p.x, p.y, p.z);
        normals.push(nv.x, nv.y, nv.z);
        for (let k = 0; k < 4; k++) {
          skinIndex.push(boneOf.get(joints[si.getComponent(v, k)]) ?? 0);
          skinWeight.push(sw.getComponent(v, k));
        }
      }
    } else {
      const bone = boneOf.get(part.node) ?? 0;
      normalMatrix.getNormalMatrix(bind[bone]);
      for (let v = 0; v < pos.count; v++) {
        p.fromBufferAttribute(pos, v).applyMatrix4(bind[bone]);
        nv.fromBufferAttribute(nrm, v).applyMatrix3(normalMatrix).normalize();
        positions.push(p.x, p.y, p.z);
        normals.push(nv.x, nv.y, nv.z);
        skinIndex.push(bone, 0, 0, 0);
        skinWeight.push(1, 0, 0, 0);
      }
    }
    // UVs as they are: glTF's run from the image's top-left corner, as the model data's do, and
    // GLTFLoader leaves its textures unflipped, as the loader's compressed textures are.
    for (let v = 0; v < pos.count; v++) {
      uv0.push(uvA ? uvA.getX(v) : 0, uvA ? uvA.getY(v) : 0);
      if (withUv1) uv1.push(uvB ? uvB.getX(v) : 0, uvB ? uvB.getY(v) : 0);
    }
    const start = indices.length;
    const index = g.getIndex();
    if (index) for (let k = 0; k < index.count; k++) indices.push(base + index.getX(k));
    else for (let k = 0; k < pos.count; k++) indices.push(base + k);
    batches.push({ material: materialOf.get(part.material)!, start, count: indices.length - start, bone: -1 });
  }

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < positions.length; k += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], positions[k + c]);
      max[c] = Math.max(max[c], positions[k + c]);
    }
  if (!positions.length) min.fill(0), max.fill(0);

  const data: ModelData = {
    bones,
    inverseBind,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uv0: Float32Array.from(uv0),
    uv1: withUv1 ? Float32Array.from(uv1) : null,
    skinIndex: Uint16Array.from(skinIndex),
    skinWeight: Float32Array.from(skinWeight),
    indices: Uint32Array.from(indices),
    batches,
    materials: read.map((r) => r.material),
    sequences: await readClips(parser, json, bones, boneOf, name),
    attachments: bones.flatMap((b, i) => (/^ref_/i.test(b.name) ? [{ name: b.name, bone: i }] : [])),
    cameras: [],
    bounds: { min, max, radius: Math.hypot(...max.map((x, c) => Math.max(Math.abs(x), Math.abs(min[c])))) },
    emitters: [],
  };
  return { data, layers: read.map((r) => r.textures), walkSpeed: strideOf(json) };
}

const templates = new Map<string, Promise<ModelTemplate>>();

/** Loads (once per URL) an original model as a template the engine draws like any other. `name` is its ModelName. */
export function loadGlbTemplate(url: string, name: string): Promise<ModelTemplate> {
  let p = templates.get(url);
  if (!p) {
    p = (async () => {
      const r = await fetchFile(url);
      if (!r) throw new Error(`model not found: ${url}`);
      const { data, layers, walkSpeed } = await parseGlb(await r.arrayBuffer(), name);
      const template = new ModelTemplate(`glb:${name}`, data, layers);
      if (walkSpeed) template.walkSpeed = walkSpeed;
      return template;
    })();
    templates.set(url, p);
  }
  return p;
}
