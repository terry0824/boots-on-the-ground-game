import * as THREE from 'three';
import type { ModelAnim, ModelBone, ModelLayer, ModelMaterial, ModelData, ModelSequence, ModelTrack, Vec3 } from '../engine/modeldata.ts';
import { ModelTemplate } from '../engine/model.ts';

/**
 * A model the game makes for itself where the original pack has nothing yet (docs/original-
 * assets.md, phase 0): a block figure of about the right size in the team's color, with the
 * attachment points and clips the engine asks for, so a unit can be fielded and fought before
 * its model exists. In the engine's own model format (Z up, the front at -Y), like any model.
 */

/** Sizes (meters: height, width, length) by what a model is; anything else is a soldier's. */
const SIZES: Record<string, Vec3> = {
  holdfast: [12, 20, 20],
  barracks: [10, 16, 14],
  motorPool: [10, 16, 14],
  airfield: [10, 16, 14],
  storehouse: [3, 7, 7],
  bunker: [4, 9, 9],
  flakTower: [6, 4, 4],
  workshop: [8, 14, 14],
  refinery: [6, 9, 9],
  armory: [8, 14, 14],
  reactorHall: [10, 12, 12],
  hiringHall: [10, 16, 14],
  howitzerMorph: [3, 4.5, 7],
  howitzer: [3, 4.5, 7],
  torchrunner: [2, 3, 5.5],
  bulwark: [15, 10, 8],
  behemoth: [30, 20, 16],
  picket: [5, 3.5, 3],
  coyote: [1.8, 1.8, 4.5],
  warship: [40, 70, 160],
  dustoff: [5, 8, 14],
  jackknifeFighter: [3, 9, 10],
  jackknifeAssault: [6, 5, 5],
  nightjar: [3, 8, 9],
  swift: [3, 9, 11],
  frigate: [4, 12, 16],
  rigger: [3, 2.5, 2.5],
  mender: [4.2, 3, 3],
  hound: [1.2, 0.9, 2],
  leaper: [1.4, 1, 2.2],
  blister: [1.4, 1.4, 1.6],
  shellback: [2.2, 2, 3.5],
  quillback: [3.8, 1.6, 3],
  tusker: [8, 5, 12],
  kite: [3, 9, 6],
  bilewing: [6, 6, 6],
  sower: [8, 14, 24],
  lantern: [10, 10, 10],
  rifle: [0.25, 0.08, 0.9],
};

/** What flies: its block hangs about its middle, as a flyer's model does. */
const FLYERS = new Set(['warship', 'dustoff', 'jackknifeFighter', 'nightjar', 'swift', 'frigate', 'kite', 'bilewing', 'sower', 'lantern']);

const BODY = 1;
const ID = (bone: number, part: number) => 100 + bone * 3 + part;

function anim<T>(id: number, value: T): ModelAnim<T> {
  return { id, value };
}

function layer(): ModelLayer {
  return {
    path: '',
    flags: 0,
    uvSource: 0,
    colorChannels: 1,
    multiply: anim(0, 1),
    add: anim(0, 0),
    invert: false,
    clamp: false,
    colorAnim: 0,
    alpha: 1,
    flipbook: null,
    uvOffset: anim(0, [0, 0] as [number, number]),
    uvTiling: anim(0, [1, 1] as [number, number]),
  };
}

function material(name: string): ModelMaterial {
  // Authored at their own brightness (gain undoes the engine's lift for textures authored dark).
  return { name, flags: 0, blendMode: 0, cutout: 0, layers: { diffuse: layer() }, gain: 1 / 3.2 };
}

/** A flat color, its alpha the team mask (0 takes the team's color, 1 keeps this one). */
function flat(r: number, g: number, b: number, keep: boolean): THREE.Texture {
  const data = new Uint8Array(4 * 4);
  for (let i = 0; i < 4; i++) data.set([r, g, b, keep ? 255 : 0], i * 4);
  const t = new THREE.DataTexture(data, 2, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function bone(name: string, parent: number, at: Vec3): ModelBone {
  const i = parent + 1;
  return {
    name,
    parent,
    location: at,
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    locationAnim: ID(i, 0),
    rotationAnim: ID(i, 1),
    scaleAnim: ID(i, 2),
    visibility: anim(0, 1),
  };
}

/** The body's clips: keys on the body bone (its place, its turn), each of the engine's names. */
function clips(h: number, flyer: boolean): ModelSequence[] {
  const seq = (name: string, duration: number, looping: boolean, tracks: [number, ModelTrack][]): ModelSequence => ({ name, duration, looping, tracks: new Map(tracks) });
  const loc = (times: number[], values: number[][]): [number, ModelTrack] => [ID(BODY, 0), { times: Float32Array.from(times), values: Float32Array.from(values.flat()) }];
  const rot = (times: number[], values: number[][]): [number, ModelTrack] => [ID(BODY, 1), { times: Float32Array.from(times), values: Float32Array.from(values.flat()) }];
  const scl = (times: number[], values: number[][]): [number, ModelTrack] => [ID(BODY, 2), { times: Float32Array.from(times), values: Float32Array.from(values.flat()) }];
  const up = (z: number) => [0, 0, z];
  const tilt = (a: number) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
  const b = h * 0.04;
  return [
    seq('Stand', 2, true, [loc([0, 1, 2], [up(0), up(b * 0.3), up(0)])]),
    seq('Walk', 0.8, true, [loc([0, 0.2, 0.4, 0.6, 0.8], [up(0), up(b), up(0), up(b), up(0)])]),
    seq('Attack', 0.5, false, [loc([0, 0.06, 0.5], [[0, 0, 0], [0, h * 0.05, 0], [0, 0, 0]])]),
    seq('Spell', 0.6, false, [scl([0, 0.2, 0.6], [[1, 1, 1], [1.08, 1.08, 1.08], [1, 1, 1]])]),
    seq('Death', 1.2, false, flyer ? [loc([0, 1.2], [up(0), up(-h * 3)]), rot([0, 1.2], [tilt(0), tilt(1.2)])] : [rot([0, 0.8, 1.2], [tilt(0), tilt(-1.45), tilt(-1.5)])]),
    seq('Morph Start', 1, false, [loc([0, 1], [up(0), up(0)])]),
    seq('Morph End', 1, false, [loc([0, 1], [up(0), up(0)])]),
    seq('Burrow', 1, false, [loc([0, 1], [up(0), up(-h * 0.9)])]),
    seq('Unburrow', 0.6, false, [loc([0, 0.6], [up(-h * 0.9), up(0)])]),
    seq('Stand Work Start', 0.4, false, [loc([0, 0.4], [up(0), up(-b)])]),
    seq('Stand Work', 0.8, false, [loc([0, 0.4, 0.8], [up(-b), up(0), up(-b)])]),
    seq('Stand Work End', 0.4, false, [loc([0, 0.4], [up(-b), up(0)])]),
    seq('Birth', 0.5, false, [scl([0, 0.5], [[0.01, 0.01, 0.01], [1, 1, 1]])]),
  ];
}

/** Boxes, as triangles: each [center, half sizes, material]. */
function boxes(parts: { at: Vec3; half: Vec3; material: number }[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[][] = parts.map(() => []);
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  ];
  parts.forEach((p, k) => {
    for (const [n, u, v] of faces) {
      const base = positions.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        for (let c = 0; c < 3; c++) positions.push(p.at[c] + (n[c] + u[c] * su + v[c] * sv) * p.half[c]);
        normals.push(...n);
        uvs.push((su + 1) / 2, (sv + 1) / 2);
      }
      indices[k].push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  });
  return { positions, normals, uvs, indices };
}

/** A block figure for `name` (a building's mass, a soldier's body and head, a flyer's flat hull), as a ModelData. */
export function placeholderModel(name: string, flyer = FLYERS.has(name)): { data: ModelData; layers: Record<string, THREE.Texture>[] } {
  const [h, w, l] = SIZES[name] ?? [2.2, 0.9, 0.7];
  const building = h <= 12 && w >= 7 && !flyer && !/howitzer|bulwark|behemoth|torchrunner|coyote|picket/.test(name);
  // A flyer hangs about its middle; anything else stands on the ground under it.
  const ground = flyer ? -h / 2 : 0;
  const rifle = name === 'rifle';
  // Body (keeps its grey) and a band in the team's color; a head on a soldier. The first-person
  // rifle: a barrel along +Z from its grip, its magazine hanging at +X (the gun's top is -X).
  const parts: { at: Vec3; half: Vec3; material: number }[] = [];
  if (rifle) {
    parts.push({ at: [0, 0, l * 0.45], half: [w / 2, w / 2, l * 0.55], material: 0 });
    parts.push({ at: [w, 0, 0.02], half: [w * 0.8, w * 0.4, 0.06], material: 1 });
  } else if (building) {
    parts.push({ at: [0, 0, ground + h * 0.4], half: [w / 2, l / 2, h * 0.4], material: 0 });
    parts.push({ at: [0, 0, ground + h * 0.85], half: [w * 0.22, l * 0.22, h * 0.15], material: 1 });
  } else if (h > w * 1.4) {
    parts.push({ at: [0, 0, ground + h * 0.42], half: [w / 2, l / 2, h * 0.42], material: 0 });
    parts.push({ at: [0, 0, ground + h * 0.6], half: [w * 0.52, l * 0.52, h * 0.08], material: 1 });
    parts.push({ at: [0, -l * 0.05, ground + h * 0.92], half: [w * 0.25, l * 0.3, h * 0.08], material: 0 });
  } else {
    parts.push({ at: [0, 0, ground + h * 0.5], half: [w / 2, l / 2, h * 0.5], material: 0 });
    parts.push({ at: [0, -l * 0.3, ground + h * 0.75], half: [w * 0.3, l * 0.2, h * 0.25], material: 1 });
  }
  const g = boxes(parts);
  // Its bones: a root, the body, and the attachment points on it (the front is -Y).
  const bones: ModelBone[] = [
    bone('Root', -1, [0, 0, 0]),
    bone('Body', 0, [0, 0, 0]),
    bone('Ref_Center', BODY, [0, 0, h * 0.5]),
    bone('Ref_Head', BODY, [0, -l * 0.2, h * 0.92]),
    bone('Ref_Overhead', BODY, [0, 0, h * 1.05]),
    bone('Ref_Weapon', BODY, [w * 0.25, -l * 0.6, h * 0.62]),
    bone('Ref_Weapon Left', BODY, [-w * 0.3, -l * 0.6, h * 0.62]),
    bone('Ref_Weapon Right', BODY, [w * 0.3, -l * 0.6, h * 0.62]),
    bone('Ref_TurretZ', BODY, [0, 0, h * 0.8]),
  ];
  // The first-person rifle's bones, as the viewmodel finds them: its grip and its muzzle.
  if (rifle) bones.push(bone('MRF_Ctrl_Main_SkinPoint', BODY, [0, 0, 0]), bone('MRF_Ctrl_MuzzleFlash', BODY, [0, 0, l]));
  const n = g.positions.length / 3;
  const world = (i: number): THREE.Matrix4 => {
    const b = bones[i];
    const m = new THREE.Matrix4().makeTranslation(...b.location);
    return b.parent >= 0 ? world(b.parent).multiply(m) : m;
  };
  const inverseBind = new Float32Array(bones.length * 16);
  bones.forEach((_, i) => inverseBind.set(world(i).invert().elements, i * 16));
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    skinIndex[v * 4] = BODY;
    skinWeight[v * 4] = 1;
  }
  const allIndices: number[] = [];
  const batches = g.indices.map((list, k) => {
    const start = allIndices.length;
    allIndices.push(...list);
    return { material: parts[k].material, start, count: list.length, bone: -1 };
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], g.positions[v * 3 + c]);
      max[c] = Math.max(max[c], g.positions[v * 3 + c]);
    }
  const data: ModelData = {
    bones,
    inverseBind,
    positions: Float32Array.from(g.positions),
    normals: Float32Array.from(g.normals),
    uv0: Float32Array.from(g.uvs),
    uv1: null,
    skinIndex,
    skinWeight,
    indices: Uint32Array.from(allIndices),
    batches,
    materials: [material('Body'), material('Team')],
    // The rifle holds still in its one pose (the viewmodel's GLstand).
    sequences: rifle ? [{ name: 'GLstand', duration: 1, looping: true, tracks: new Map() }] : clips(h, flyer),
    attachments: bones.map((b, i) => ({ name: b.name, bone: i })).filter((a) => a.name.startsWith('Ref_')),
    cameras: [],
    bounds: { min, max, radius: Math.hypot(...max.map((x, c) => Math.max(Math.abs(x), Math.abs(min[c])))) },
    emitters: [],
  };
  // A mid gray as the game lights it (as the greybox kit's: tools/assetgen/blender/greybox.py).
  return { data, layers: [{ diffuse: flat(124, 126, 131, true) }, { diffuse: flat(255, 255, 255, false) }] };
}

/** The block figure as a template the engine draws like any model. */
export function placeholderTemplate(name: string, flyer = FLYERS.has(name)): ModelTemplate {
  const { data, layers } = placeholderModel(name, flyer);
  return new ModelTemplate(`placeholder:${name}`, data, layers);
}
