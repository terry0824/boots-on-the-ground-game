/**
 * The engine's model format: a mesh skinned to bones, its materials and their layers, its
 * animation sequences and the tracks they key, its particle emitters, attachment points and
 * cameras. ModelTemplate (model.ts) builds what the renderer draws from one. The game's own
 * models come in as glTF (content/gltf.ts) and block figures (content/placeholder.ts); a plugin
 * with models of another format brings its own reader into this one.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface ModelBone {
  name: string;
  parent: number; // -1 for roots
  location: Vec3;
  rotation: Quat; // x, y, z, w
  scale: Vec3;
  // Animation ids, matched against the tracks of each sequence.
  locationAnim: number;
  rotationAnim: number;
  scaleAnim: number;
  /**
   * Whether it's drawn (the bone's fourth animation reference: a flag, keyed in steps). The
   * batches tied to the bone (`ModelBatch.bone`) show only while it's on: a death model's whole
   * body until it bursts, a Seer's knife only in its Spell. A sequence that doesn't key it
   * takes its `value`, the reference's initial one.
   */
  visibility: ModelAnim;
}

export interface ModelTrack {
  times: Float32Array; // seconds from the start of the sequence
  /** 3 floats per key for vectors, 4 (x, y, z, w) for quaternions, 1 for floats and flags (0 or 1), 4 (r, g, b, a in 0..1) for colors. */
  values: Float32Array;
}

export interface ModelSequence {
  name: string;
  duration: number; // seconds
  looping: boolean;
  tracks: Map<number, ModelTrack>; // keyed by animation id
}

export const LAYER_SLOTS = [
  'diffuse', 'decal', 'specular', 'emissive', 'emissive2', 'evio', 'evioMask',
  'alphaMask', 'alphaMask2', 'normal', 'height', 'lightMap', 'ambientOcclusion',
] as const;
export type LayerSlot = (typeof LAYER_SLOTS)[number];

export interface ModelLayer {
  path: string;
  flags: number;
  uvSource: number;
  /** Which of the texture's channels the layer uses: 0 RGB, 1 RGBA, 2 alpha, 3 red, 4 green, 5 blue. */
  colorChannels: number;
  /**
   * The layer's value is its texture's channels, inverted when `invert`, times `multiply` plus
   * `add` (the "brightness multiplier" and "midtone offset"), clamped to 0..1 when `clamp`.
   * Death models burn their bodies away by animating an alpha mask's `add` down.
   */
  multiply: ModelAnim;
  add: ModelAnim;
  invert: boolean;
  clamp: boolean;
  /** Animation id of the layer's color (alpha fades effects in and out). */
  colorAnim: number;
  /** The color's default alpha, 0..1. */
  alpha: number;
  /** An atlas of frames (rows by columns) the layer shows one cell of. */
  flipbook: { rows: number; cols: number; frame: ModelAnim } | null;
  /** The texture's offset and tiling, which some layers animate (lava flowing, energy crawling). */
  uvOffset: ModelAnim<[number, number]>;
  uvTiling: ModelAnim<[number, number]>;
}

export interface ModelMaterial {
  name: string;
  flags: number;
  blendMode: number; // 0 opaque, 1 blend, 2 add, 3 alpha add, 4 mod, 5 mod 2x
  /** Pixels whose alpha (after the alpha mask) is below this are cut out, 0..1. */
  cutout: number;
  layers: Partial<Record<LayerSlot, ModelLayer>>;
  /**
   * An original asset's (src/content): its diffuse's brightness against the loader's, whose
   * textures are authored dark and lifted by the engine (`materialSettings.diffuseBoost`); one
   * authored at its own brightness takes the lift's inverse. Absent on the loader's own.
   */
  gain?: number;
  /** An original asset's normal map is an ordinary one (X, Y, Z in red, green, blue), not the loader's (X in alpha, Y in green). */
  rgbNormal?: true;
}

export interface ModelBatch {
  material: number; // index into materials, or -1 for material types we don't draw
  start: number; // first index in the index buffer
  count: number;
  /** The bone whose visibility shows and hides it (`ModelBone.visibility`), or -1. */
  bone: number;
  /**
   * With `composites`: the batch shows the terrain's own texture (a terrain material, alone or
   * as a pass of a composite next to `material`), so it blends into the ground around it.
   */
  terrain?: true;
}


/** An animatable value: the id its tracks are keyed by, and its value where no sequence animates it. */
export interface ModelAnim<T = number> {
  id: number;
  value: T;
  /**
   * For an animated value, what it is in a sequence that doesn't key it: the reference's "null"
   * value (Calyx's channeling glows are keyed in her Stand Channel, not her plain Stand, and
   * there they're off).
   */
  rest?: T;
  /** Its keys are held until the next rather than blended (interpolation type 0). */
  step?: true;
}

export type RGBA = [number, number, number, number];

/**
 * A particle emitter (as the loader's models store one: version 12, 1316 bytes). Distances are
 * model units, times seconds, angles radians. Pairs are the two values a particle picks between
 * at random when the matching `random` flag is set (otherwise the first is used); triples run
 * from birth through the middle of a particle's life (at `mid`, a fraction of it) to its death.
 */
export interface ModelEmitter {
  bone: number;
  /** Index into materials, or -1 for material types we don't draw. */
  material: number;
  /** Particles per second. */
  rate: ModelAnim;
  /** Particles emitted at once, at each key of its (stepped) track. */
  burst: ModelAnim;
  maxParticles: number;
  speed: [ModelAnim, ModelAnim];
  /** Emission direction: the bone's +Z, tilted about its X and Y axes, spread at random by up to `spread` either way. */
  angle: [ModelAnim, ModelAnim];
  spread: [ModelAnim, ModelAnim];
  /** Emission type 1: in all directions. */
  radial: boolean;
  life: [ModelAnim, ModelAnim];
  /** Acceleration along world up (negative falls). */
  gravity: number;
  /** Velocity damping per second. */
  drag: number;
  mid: { size: number; color: number; alpha: number; rotation: number };
  size: [ModelAnim<Vec3>, ModelAnim<Vec3>];
  /** Starting angle, then spin in radians per second at the middle and end of life. */
  rotation: [ModelAnim<Vec3>, ModelAnim<Vec3>];
  /** Initial, middle and final color (r, g, b, a in 0..1). */
  color: [ModelAnim<RGBA>[], ModelAnim<RGBA>[]];
  random: { speed: boolean; life: boolean; size: boolean; rotation: boolean; color: boolean };
  /** Where particles appear: 0 point, 1 rectangle, 2 sphere, 3 box, 4 cylinder, 5 disc; with an optional cut-out middle. */
  area: { type: number; size: ModelAnim<Vec3>; cutSize: ModelAnim<Vec3>; radius: ModelAnim; cutRadius: ModelAnim };
  /** Texture atlas: columns, rows, and the cells played in two phases over a particle's life. */
  flipbook: { cols: number; rows: number; start: number; end: number; end2: number; phase1: number };
  /** 0 billboard, 1 stretched along its velocity, 5 lying flat on the emitter's plane, 7 facing its direction of travel. */
  type: number;
  /** Length over width, for stretched particles. */
  ratio: number;
  /** Emitter flags: 0x1 sort, 0x2 collide with terrain, 0x10 cut-out area, 0x10000 random atlas cell, 0x8000 lit, 0x4000000 simulate on init. */
  flags: number;
  /** The same emitter on more bones, each with its own rate and bursts. */
  copies: { bone: number; rate: ModelAnim; burst: ModelAnim }[];
}

export interface ModelData {
  bones: ModelBone[];
  inverseBind: Float32Array; // one column-major 4x4 matrix per bone
  positions: Float32Array;
  normals: Float32Array;
  uv0: Float32Array;
  uv1: Float32Array | null;
  skinIndex: Uint16Array; // 4 bone indices per vertex
  skinWeight: Float32Array; // 4 weights per vertex
  indices: Uint32Array;
  batches: ModelBatch[];
  materials: ModelMaterial[];
  sequences: ModelSequence[];
  attachments: { name: string; bone: number }[];
  /** Cameras (portraits frame their subject with one): the bone it rides and its lens (fov in radians). */
  cameras: { name: string; bone: number; fov: number; near: number; far: number }[];
  bounds: { min: Vec3; max: Vec3; radius: number };
  emitters: ModelEmitter[];
}
