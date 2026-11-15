import * as THREE from 'three';
import type { ModelAnim, ModelEmitter, ModelSequence, ModelTrack, RGBA, Vec3 } from './modeldata.ts';
import { PARTICLE_UV, type ModelTemplate } from './model.ts';

/**
 * Particle systems, driven by the emitters inside the models (the loader's): engine
 * glows, exhaust, smoke stacks, muzzle smoke and sparks, blood sprays and pools, gibs, dust.
 * Emission follows the model's animation: each emitter's rate and bursts are keyed per
 * sequence (a Hound's Death sprays blood for three seconds and throws its guts at 0.03 s;
 * a Warship's engines glow harder in Walk). Particles live in world space, so smoke
 * stays behind a moving ship, and are simulated on the CPU and drawn as instanced quads, one
 * draw call per texture and blend mode.
 */

/** Material blend modes. */
const BLEND = { opaque: 0, alpha: 1, add: 2, alphaAdd: 3, mod: 4, mod2x: 5 } as const;
/** Emitter flags. */
const COLLIDE = 0x2;
const CUTOUT = 0x10;
const LIT = 0x8000;
const RANDOM_CELL = 0x10000;
const PREWARM = 0x4000000;

/** Particle types: square billboards, stretched along the velocity, flat in the emitter's plane, facing the velocity. */
const STRETCHED = 1;
const FLAT = 5;
const FACING = 7;

/** Floats of simulation state per particle. */
const S = 48;
/** Offsets into a particle's state. */
const P = 0, V = 3, AGE = 6, LIFE = 7, SIZE = 8, SIZE_MID = 11, COLOR = 12, COLOR_MID = 24, ALPHA_MID = 25;
const ANGLE = 26, SPIN = 27, GRAVITY = 29, DRAG = 30, COLLIDES = 31, MODE = 32, RATIO = 33, SPEED0 = 34, AXIS = 35;
const COLS = 38, ROWS = 39, F_START = 40, F_END = 41, F_END2 = 42, PHASE1 = 43, CELL = 44;

const MAX_PER_BATCH = 16384;
const MAX_PER_FRAME = 256;

/** Where the animation of a model is: its sequence and time, and the global ("GL") sequences running beside it. */
export interface AnimState {
  seq: ModelSequence | null;
  time: number;
  globals: { seq: ModelSequence; time: number }[];
}

/** A track's component `c` at `time` (keys `width` values wide), linear between keys or stepped. */
export function trackAt(t: ModelTrack, time: number, width: number, c: number, step = false): number {
  const times = t.times;
  const n = times.length;
  if (n === 0) return 0;
  if (time <= times[0]) return t.values[c];
  if (time >= times[n - 1]) return t.values[(n - 1) * width + c];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const a = t.values[lo * width + c];
  if (step) return a;
  const b = t.values[hi * width + c];
  const span = times[hi] - times[lo];
  return span > 0 ? a + (b - a) * ((time - times[lo]) / span) : b;
}

/** The track animating `id` where the model is now, and the time to read it at. */
function find(id: number, st: AnimState): [ModelTrack, number] | null {
  const t = st.seq?.tracks.get(id);
  if (t) return [t, st.time];
  for (const g of st.globals) {
    const gt = g.seq.tracks.get(id);
    if (gt) return [gt, g.time];
  }
  return null;
}

function num(a: ModelAnim, st: AnimState, step = false): number {
  const f = find(a.id, st);
  return f ? trackAt(f[0], f[1], 1, 0, step) : a.value;
}

/**
 * An emission rate: where the playing sequence doesn't animate an animated rate, it's at rest
 * (off), or, for a `steady` model, at its own value.
 */
function rateOf(a: ModelAnim, st: AnimState, steady: boolean): number {
  const f = find(a.id, st);
  return f ? trackAt(f[0], f[1], 1, 0) : steady ? a.value : (a.rest ?? a.value);
}

function vec(a: ModelAnim<Vec3>, st: AnimState, out: number[]): number[] {
  const f = find(a.id, st);
  for (let c = 0; c < 3; c++) out[c] = f ? trackAt(f[0], f[1], 3, c, false) : a.value[c];
  return out;
}

function rgba(a: ModelAnim<RGBA>, st: AnimState, out: number[]): number[] {
  const f = find(a.id, st);
  for (let c = 0; c < 4; c++) out[c] = f ? trackAt(f[0], f[1], 4, c, false) : a.value[c];
  return out;
}

/** Particles a burst track fires between two times of its sequence (one wrap allowed). */
function burstsBetween(t: ModelTrack, from: number, to: number, duration: number): number {
  let n = 0;
  const count = (a: number, b: number) => {
    for (let i = 0; i < t.times.length; i++) if (t.times[i] > a && t.times[i] <= b && t.values[i] > 0) n += t.values[i];
  };
  if (to >= from) count(from, to);
  else {
    count(from, duration);
    count(-1, to);
  }
  return n;
}

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const n3a: number[] = [0, 0, 0];
const n3b: number[] = [0, 0, 0];
/** No flipbook: the whole texture. */
const WHOLE: ModelEmitter['flipbook'] = { cols: 1, rows: 1, start: 0, end: 0, end2: 0, phase1: 1 };

/** One draw call: every particle sharing a texture and blend mode, from any model. */
class Batch {
  count = 0;
  private cap = 256;
  sim = new Float32Array(this.cap * S);
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private aPos!: THREE.InstancedBufferAttribute;
  private aColor!: THREE.InstancedBufferAttribute;
  private aUv!: THREE.InstancedBufferAttribute;
  private aAxis!: THREE.InstancedBufferAttribute;
  private aSize!: THREE.InstancedBufferAttribute;
  private aGround!: THREE.InstancedBufferAttribute;
  private order: Uint32Array | null = null;
  private depth: Float32Array | null = null;

  constructor(
    readonly key: string,
    readonly material: THREE.ShaderMaterial,
    readonly sorted: boolean,
  ) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.allocate();
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = material.blending === THREE.AdditiveBlending ? 3 : 2;
  }

  private allocate() {
    const attr = (name: string, size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, a);
      return a;
    };
    this.aPos = attr('aPos', 4);
    this.aColor = attr('aColor', 4);
    this.aUv = attr('aUv', 4);
    this.aAxis = attr('aAxis', 4);
    this.aSize = attr('aSize', 2);
    this.aGround = attr('aGround', 1);
    this.order = null;
  }

  /** A new particle's state block (zeroed), or -1 when full. */
  add(): number {
    if (this.count >= this.cap) {
      if (this.cap >= MAX_PER_BATCH) return -1;
      this.cap *= 2;
      const sim = new Float32Array(this.cap * S);
      sim.set(this.sim);
      this.sim = sim;
      this.allocate();
    }
    const o = this.count++ * S;
    this.sim.fill(0, o, o + S);
    return o;
  }

  update(dt: number, ground: ((x: number, z: number) => number) | null, camera: THREE.Camera) {
    const s = this.sim;
    // Simulate, removing the dead by moving the last particle into their place.
    for (let i = 0; i < this.count; i++) {
      const o = i * S;
      s[o + AGE] += dt;
      if (s[o + AGE] >= s[o + LIFE]) {
        this.count--;
        if (i !== this.count) s.copyWithin(o, this.count * S, this.count * S + S);
        i--;
        continue;
      }
      if (dt <= 0) continue;
      s[o + V + 1] += s[o + GRAVITY] * dt;
      const drag = s[o + DRAG];
      if (drag > 0) {
        const k = Math.exp(-drag * dt);
        s[o + V] *= k;
        s[o + V + 1] *= k;
        s[o + V + 2] *= k;
      }
      s[o + P] += s[o + V] * dt;
      s[o + P + 1] += s[o + V + 1] * dt;
      s[o + P + 2] += s[o + V + 2] * dt;
      if (s[o + COLLIDES] && ground) {
        const h = ground(s[o + P], s[o + P + 2]);
        if (s[o + P + 1] < h) {
          // Bounce off the ground, losing most of the energy, then come to rest.
          s[o + P + 1] = h;
          s[o + V + 1] = Math.abs(s[o + V + 1]) * 0.3;
          s[o + V] *= 0.5;
          s[o + V + 2] *= 0.5;
        }
      }
    }
    this.write(camera, ground);
  }

  private write(camera: THREE.Camera, ground: ((x: number, z: number) => number) | null) {
    const s = this.sim;
    const n = this.count;
    const pos = this.aPos.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    const uv = this.aUv.array as Float32Array;
    const axis = this.aAxis.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    const grd = this.aGround.array as Float32Array;
    // Alpha-blended particles draw back to front.
    let order: Uint32Array | null = null;
    if (this.sorted && n > 1) {
      if (!this.order || this.order.length < this.sim.length / S) {
        this.order = new Uint32Array(this.sim.length / S);
        this.depth = new Float32Array(this.sim.length / S);
      }
      order = this.order;
      const depth = this.depth!;
      const cp = camera.position;
      for (let i = 0; i < n; i++) {
        const o = i * S;
        const dx = s[o + P] - cp.x;
        const dy = s[o + P + 1] - cp.y;
        const dz = s[o + P + 2] - cp.z;
        depth[i] = dx * dx + dy * dy + dz * dz;
        order[i] = i;
      }
      order.subarray(0, n).sort((a, b) => depth[b] - depth[a]);
    }
    for (let k = 0; k < n; k++) {
      const i = order ? order[k] : k;
      const o = i * S;
      const t = s[o + AGE] / s[o + LIFE];
      // Size, color and alpha run birth → middle → death.
      const sm = s[o + SIZE_MID];
      const sz = t < sm ? lerp(s[o + SIZE], s[o + SIZE + 1], sm > 0 ? t / sm : 1) : lerp(s[o + SIZE + 1], s[o + SIZE + 2], sm < 1 ? (t - sm) / (1 - sm) : 1);
      const cm = s[o + COLOR_MID];
      const ct = t < cm ? (cm > 0 ? t / cm : 1) : cm < 1 ? (t - cm) / (1 - cm) : 1;
      const c0 = t < cm ? o + COLOR : o + COLOR + 4;
      const am = s[o + ALPHA_MID];
      const at = t < am ? (am > 0 ? t / am : 1) : am < 1 ? (t - am) / (1 - am) : 1;
      const a0 = t < am ? o + COLOR + 3 : o + COLOR + 7;
      // Spin: from its starting angle, at a rate easing from the middle value to the final one.
      const age = s[o + AGE];
      const spinNow = lerp(s[o + SPIN], s[o + SPIN + 1], t);
      const angle = s[o + ANGLE] + (s[o + SPIN] + spinNow) * 0.5 * age;
      const k4 = k * 4;
      pos[k4] = s[o + P];
      pos[k4 + 1] = s[o + P + 1];
      pos[k4 + 2] = s[o + P + 2];
      pos[k4 + 3] = angle;
      col[k4] = lerp(s[c0], s[c0 + 4], ct);
      col[k4 + 1] = lerp(s[c0 + 1], s[c0 + 5], ct);
      col[k4 + 2] = lerp(s[c0 + 2], s[c0 + 6], ct);
      col[k4 + 3] = lerp(s[a0], s[a0 + 4], at);
      // Atlas cell.
      const cols = s[o + COLS];
      const rows = s[o + ROWS];
      if (cols * rows > 1) {
        const cells = cols * rows;
        let f: number;
        const start = s[o + F_START];
        const end = s[o + F_END];
        const p1 = s[o + PHASE1];
        if (end <= start || end >= 255) f = start;
        else if (t <= p1 || p1 >= 1) f = start + Math.floor((end - start + 1) * Math.min(0.9999, p1 > 0 ? t / p1 : 1));
        else {
          const end2 = s[o + F_END2];
          f = end2 > end && end2 < 255 ? end + Math.floor((end2 - end + 1) * Math.min(0.9999, (t - p1) / (1 - p1))) : end;
        }
        f = (f + s[o + CELL]) % cells;
        uv[k4] = (f % cols) / cols;
        uv[k4 + 1] = Math.floor(f / cols) / rows;
        uv[k4 + 2] = 1 / cols;
        uv[k4 + 3] = 1 / rows;
      } else {
        uv[k4] = 0;
        uv[k4 + 1] = 0;
        uv[k4 + 2] = 1;
        uv[k4 + 3] = 1;
      }
      const mode = s[o + MODE];
      if (mode === STRETCHED) {
        // Stretched along the velocity, longer while it's fast.
        const vx = s[o + V];
        const vy = s[o + V + 1];
        const vz = s[o + V + 2];
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        axis[k4] = vx;
        axis[k4 + 1] = vy;
        axis[k4 + 2] = vz;
        const s0 = s[o + SPEED0];
        size[k * 2 + 1] = sz * Math.max(1, s[o + RATIO] * (s0 > 0 ? Math.min(1.5, speed / s0) : 1));
      } else {
        axis[k4] = s[o + AXIS];
        axis[k4 + 1] = s[o + AXIS + 1];
        axis[k4 + 2] = s[o + AXIS + 2];
        size[k * 2 + 1] = sz;
      }
      axis[k4 + 3] = mode;
      size[k * 2] = sz;
      // The ground under it, which a quad turned to the camera fades into rather than being cut
      // off along it (the models' particles are made to be soft against what's behind them).
      // One lying on the ground (a pool, a scorch) is meant to be there.
      grd[k] = ground && mode !== FLAT ? ground(s[o + P], s[o + P + 2]) : -1e5;
    }
    for (const a of [this.aPos, this.aColor, this.aUv, this.aAxis, this.aSize, this.aGround]) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

const VERTEX = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 aPos;   // world position, rotation
  attribute vec4 aColor;
  attribute vec4 aUv;    // atlas cell: origin and size
  attribute vec4 aAxis;  // velocity or facing (xyz), particle type (w)
  attribute vec2 aSize;  // width, length
  attribute float aGround; // the ground's height under it
  varying vec2 vUv;
  varying vec4 vColor;
  // How far this point of the quad is above the ground, and over how much it fades in from it.
  varying float vAbove;
  varying float vSoft;
  #include <fog_pars_vertex>
  void main() {
    float c = cos(aPos.w);
    float s = sin(aPos.w);
    vec2 q = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    int mode = int(aAxis.w + 0.5);
    vec4 mvPosition;
    // Image rows run top down: the quad's top shows the cell's first row.
    vec2 cell = vec2(corner.x + 0.5, 0.5 - corner.y);
    if (mode == ${STRETCHED}) {
      // Along the velocity as seen on screen, the image's right edge leading (a spark's head).
      vec3 dir = (viewMatrix * vec4(aAxis.xyz, 0.0)).xyz;
      vec2 d = dir.xy;
      float l = length(d);
      d = l > 1e-6 ? d / l : vec2(0.0, 1.0);
      vec2 side = vec2(-d.y, d.x);
      mvPosition = viewMatrix * vec4(aPos.xyz, 1.0);
      vec2 off = d * corner.y * aSize.y + side * corner.x * aSize.x;
      mvPosition.xy += off;
      // The offset on screen, back in the world: its height (the view's axes are the rows).
      vAbove = aPos.y + viewMatrix[1][0] * off.x + viewMatrix[1][1] * off.y - aGround;
      cell = vec2(corner.y + 0.5, 0.5 - corner.x);
    } else if (mode == ${FLAT} || mode == ${FACING}) {
      // A quad facing its axis: lying in the emitter's plane, or across its flight.
      vec3 n = normalize(aAxis.xyz + vec3(0.0, 1e-6, 0.0));
      vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
      vec3 b = cross(n, t);
      vec3 world = aPos.xyz + (t * q.x + b * q.y) * aSize.x;
      mvPosition = viewMatrix * vec4(world, 1.0);
      vAbove = world.y - aGround;
    } else {
      mvPosition = viewMatrix * vec4(aPos.xyz, 1.0);
      vec2 off = q * aSize.x;
      mvPosition.xy += off;
      vAbove = aPos.y + viewMatrix[1][0] * off.x + viewMatrix[1][1] * off.y - aGround;
    }
    vSoft = clamp(0.25 * max(aSize.x, aSize.y), 0.15, 2.5);
    gl_Position = projectionMatrix * mvPosition;
    vUv = aUv.xy + cell * aUv.zw;
    vColor = aColor;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float brightness;
  uniform vec3 light;
  #ifdef ALPHA_MAP
    uniform sampler2D alphaMap;
  #endif
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vAbove;
  varying float vSoft;
  #include <fog_pars_fragment>
  void main() {
    vec4 tex = texture2D(map, vUv);
    #ifdef ALPHA_MAP
      float a = texture2D(alphaMap, vUv).a;
    #else
      float a = tex.a;
    #endif
    vec3 rgb = tex.rgb * vColor.rgb * brightness * light;
    // Soft against the ground: fading in from it, not cut off along it in a hard line.
    a *= vColor.a * smoothstep(0.0, vSoft, vAbove);
    #ifdef OPAQUE
      if (a < 0.5) discard;
      a = 1.0;
    #endif
    #ifdef MODULATE
      gl_FragColor = vec4(mix(vec3(1.0), rgb, a), 1.0);
    #else
      gl_FragColor = vec4(rgb, a);
    #endif
    #ifdef ADDITIVE
      // Glows fade into the haze rather than taking its color.
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor.rgb *= 1.0 - fogFactor;
      #endif
    #else
      #include <fog_fragment>
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

/** An emitter and the batch its particles draw in. */
interface Spec {
  e: ModelEmitter;
  batch: Batch;
  /**
   * Whether its texture is on particle coordinates, played through the emitter's flipbook;
   * otherwise each particle shows the whole texture (a smoke puff, a glow).
   */
  flipbook: boolean;
}

/** The scene's particle system. */
export class ParticleSystem {
  readonly group = new THREE.Group();
  private batches = new Map<string, Batch>();
  private specs = new Map<ModelTemplate, (Spec | null)[]>();
  camera: THREE.Camera | null = null;
  /** Ground height under a point, for particles that bounce. */
  ground: ((x: number, z: number) => number) | null = null;
  /** Light on lit particles (smoke, blood on the ground): the scene's ambient and sun. */
  readonly light = new THREE.Color(1, 1, 1);
  /** Light on unlit, non-additive particles: brighter than lit, but they still dim at night. */
  readonly unlit = new THREE.Color(1, 1, 1);
  enabled = true;
  /** The graphics setting: how much of each emitter's output is drawn, and how far away emitters run (fractions of the full). */
  density = 1;
  reach = 1;
  /** Particles alive, for the debug readout. */
  alive = 0;

  constructor() {
    this.group.name = 'particles';
  }

  /** Whether a model has emitters worth instancing. */
  has(template: ModelTemplate): boolean {
    return this.enabled && template.data.emitters.length > 0;
  }

  specsFor(template: ModelTemplate): (Spec | null)[] {
    let list = this.specs.get(template);
    if (!list) {
      list = template.data.emitters.map((e) => {
        const mat = template.data.materials[e.material];
        if (!mat) return null;
        const tex = template.layers[e.material];
        const map = tex.diffuse ?? tex.emissive ?? tex.alphaMask;
        if (!map) return null;
        const mapLayer = tex.diffuse ? mat.layers.diffuse : tex.emissive ? mat.layers.emissive : mat.layers.alphaMask;
        const alphaMap = tex.alphaMask && tex.alphaMask !== map ? tex.alphaMask : null;
        const layer = mat.layers.diffuse ?? mat.layers.emissive;
        const brightness = THREE.MathUtils.clamp(layer?.multiply.value || 1, 0.2, 4);
        const lit = (e.flags & LIT) !== 0;
        const flat = e.type === FLAT;
        const key = `${map.uuid}|${alphaMap?.uuid ?? ''}|${mat.blendMode}|${brightness.toFixed(2)}|${lit ? 1 : 0}|${flat ? 1 : 0}`;
        let batch = this.batches.get(key);
        if (!batch) {
          batch = new Batch(key, this.material(map, alphaMap, mat.blendMode, brightness, lit, flat), mat.blendMode === BLEND.alpha);
          this.batches.set(key, batch);
          this.group.add(batch.mesh);
        }
        return { e, batch, flipbook: mapLayer?.uvSource === PARTICLE_UV };
      });
      this.specs.set(template, list);
    }
    return list;
  }

  private material(map: THREE.Texture, alphaMap: THREE.Texture | null, blend: number, brightness: number, lit: boolean, flat: boolean): THREE.ShaderMaterial {
    const additive = blend === BLEND.add || blend === BLEND.alphaAdd;
    const modulate = blend === BLEND.mod || blend === BLEND.mod2x;
    const opaque = blend === BLEND.opaque;
    const defines: Record<string, string> = {};
    if (alphaMap) defines.ALPHA_MAP = '';
    if (additive) defines.ADDITIVE = '';
    if (modulate) defines.MODULATE = '';
    if (opaque) defines.OPAQUE = '';
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { map: { value: null }, alphaMap: { value: null }, brightness: { value: brightness }, light: { value: null } },
      ]),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines,
      transparent: !opaque,
      depthWrite: opaque,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : modulate ? THREE.MultiplyBlending : THREE.NormalBlending,
      premultipliedAlpha: modulate,
      side: THREE.DoubleSide,
    });
    m.uniforms.map.value = map ?? WHITE;
    m.uniforms.alphaMap.value = alphaMap;
    // Additive light ignores the scene's lighting; smoke and blood take it.
    m.uniforms.light.value = additive ? new THREE.Color(1, 1, 1) : lit ? this.light : this.unlit;
    if (flat) {
      // Pools and scorch lie on the ground: keep them from flickering through it.
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -4;
    }
    return m;
  }

  /**
   * Whether a model `scale` meters per unit at `p` is close enough to the camera for its
   * particles to matter: small units' blood within a few hundred meters, a Warship's
   * engines from kilometers away.
   */
  near(p: THREE.Vector3, scale: number): boolean {
    if (!this.camera) return false;
    const reach = Math.min(3000, 160 + scale * 70) * this.reach;
    return p.distanceToSquared(this.camera.position) < reach * reach;
  }

  /** Every particle gone (a mission ending): the batches stay, empty, for the next. */
  clear() {
    for (const b of this.batches.values()) b.count = 0;
    this.alive = 0;
  }

  /** Simulates every particle and prepares this frame's draw. */
  update(dt: number) {
    if (!this.camera) return;
    let alive = 0;
    for (const b of this.batches.values()) {
      b.update(dt, this.ground, this.camera);
      alive += b.count;
    }
    this.alive = alive;
  }

  /** Spawns `count` particles of an emitter from a bone (world matrix, model units to meters). */
  spawn(spec: Spec, bone: THREE.Matrix4, st: AnimState, count: number, prewarm = 0) {
    const e = spec.e;
    const batch = spec.batch;
    const m = bone.elements;
    // The bone's axes carry the model's scale; particles scale with it.
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const scale = (sx + sy + sz) / 3;
    if (scale < 1e-6) return;
    const speed1 = num(e.speed[0], st);
    const speed2 = e.random.speed ? num(e.speed[1], st) : speed1;
    const life1 = num(e.life[0], st);
    const life2 = e.random.life ? num(e.life[1], st) : life1;
    const angleX = num(e.angle[0], st);
    const angleY = num(e.angle[1], st);
    const spreadX = num(e.spread[0], st);
    const spreadY = num(e.spread[1], st);
    const size1 = vec(e.size[0], st, [0, 0, 0]);
    const size2 = e.random.size ? vec(e.size[1], st, [0, 0, 0]) : size1;
    const rot1 = e.rotation[0].value;
    const rot2 = e.random.rotation ? e.rotation[1].value : rot1;
    const colors1 = e.color[0].map((c) => rgba(c, st, [0, 0, 0, 0]));
    const colors2 = e.random.color ? e.color[1].map((c) => rgba(c, st, [0, 0, 0, 0])) : colors1;
    const areaType = e.area.type;
    const areaSize = vec(e.area.size, st, n3a);
    const radius = num(e.area.radius, st);
    const cut = (e.flags & CUTOUT) !== 0;
    const cutSize = cut ? vec(e.area.cutSize, st, n3b) : null;
    const cutRadius = cut ? num(e.area.cutRadius, st) : 0;
    const fb = spec.flipbook ? e.flipbook : WHOLE;
    const cells = fb.cols * fb.rows;
    // The emitter's +Z, tilted by its emission angles.
    tmpQ.setFromEuler(tmpE.set(angleX, angleY, 0));
    for (let i = 0; i < count; i++) {
      const o = batch.add();
      if (o < 0) return;
      const s = batch.sim;
      // Where: somewhere in the emission area, in the bone's space.
      let lx = 0, ly = 0, lz = 0;
      if (areaType === 1 || areaType === 3) {
        // Rectangle (in the bone's XY plane) or box, with an optional hole in the middle.
        for (let tries = 0; tries < 6; tries++) {
          lx = (Math.random() - 0.5) * areaSize[0];
          ly = (Math.random() - 0.5) * areaSize[1];
          lz = areaType === 3 ? (Math.random() - 0.5) * areaSize[2] : 0;
          if (!cutSize || Math.abs(lx) > cutSize[0] / 2 || Math.abs(ly) > cutSize[1] / 2 || (areaType === 3 && Math.abs(lz) > cutSize[2] / 2)) break;
        }
      } else if (areaType === 2) {
        // Sphere.
        const r = cut ? lerp(cutRadius, radius, Math.cbrt(Math.random())) : radius * Math.cbrt(Math.random());
        tmpV.randomDirection().multiplyScalar(r);
        lx = tmpV.x;
        ly = tmpV.y;
        lz = tmpV.z;
      } else if (areaType === 4 || areaType === 5) {
        // Cylinder (its height along the bone's Z) or disc.
        const r = cut ? Math.sqrt(lerp((cutRadius / Math.max(radius, 1e-6)) ** 2, 1, Math.random())) * radius : Math.sqrt(Math.random()) * radius;
        const a = Math.random() * Math.PI * 2;
        lx = Math.cos(a) * r;
        ly = Math.sin(a) * r;
        lz = areaType === 4 ? (Math.random() - 0.5) * areaSize[2] : 0;
      }
      s[o + P] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      s[o + P + 1] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      s[o + P + 2] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      // Which way: the emitter's axis with a random spread, or any direction.
      if (e.radial) tmpD.randomDirection();
      else {
        tmpD.set(0, 0, 1);
        if (spreadX || spreadY) tmpD.applyEuler(tmpE.set((Math.random() * 2 - 1) * spreadX, (Math.random() * 2 - 1) * spreadY, 0));
        tmpD.applyQuaternion(tmpQ);
      }
      // To world space, without the bone's scale.
      const dx = (m[0] * tmpD.x) / sx + (m[4] * tmpD.y) / sy + (m[8] * tmpD.z) / sz;
      const dy = (m[1] * tmpD.x) / sx + (m[5] * tmpD.y) / sy + (m[9] * tmpD.z) / sz;
      const dz = (m[2] * tmpD.x) / sx + (m[6] * tmpD.y) / sy + (m[10] * tmpD.z) / sz;
      const speed = lerp(speed1, speed2, Math.random()) * scale;
      s[o + V] = dx * speed;
      s[o + V + 1] = dy * speed;
      s[o + V + 2] = dz * speed;
      s[o + SPEED0] = speed;
      s[o + LIFE] = Math.max(0.02, lerp(life1, life2, Math.random()));
      const rs = e.random.size ? Math.random() : 0;
      for (let c = 0; c < 3; c++) s[o + SIZE + c] = lerp(size1[c], size2[c], rs) * scale;
      s[o + SIZE_MID] = e.mid.size;
      const rc = e.random.color ? Math.random() : 0;
      for (let k = 0; k < 3; k++) for (let c = 0; c < 4; c++) s[o + COLOR + k * 4 + c] = lerp(colors1[k][c], colors2[k][c], rc);
      s[o + COLOR_MID] = e.mid.color;
      s[o + ALPHA_MID] = e.mid.alpha;
      const ra = e.random.rotation ? Math.random() : 0;
      const rsp = e.random.rotation ? Math.random() : 0;
      s[o + ANGLE] = lerp(rot1[0], rot2[0], ra);
      s[o + SPIN] = lerp(rot1[1], rot2[1], rsp);
      s[o + SPIN + 1] = lerp(rot1[2], rot2[2], rsp);
      s[o + GRAVITY] = e.gravity * scale;
      s[o + DRAG] = e.drag;
      s[o + COLLIDES] = e.flags & COLLIDE ? 1 : 0;
      s[o + MODE] = e.type === STRETCHED || e.type === FLAT || e.type === FACING ? e.type : 0;
      s[o + RATIO] = e.ratio || 1;
      if (e.type === FACING && speed > 1e-4) {
        s[o + AXIS] = dx;
        s[o + AXIS + 1] = dy;
        s[o + AXIS + 2] = dz;
      } else {
        s[o + AXIS] = m[8] / sz;
        s[o + AXIS + 1] = m[9] / sz;
        s[o + AXIS + 2] = m[10] / sz;
      }
      s[o + COLS] = fb.cols;
      s[o + ROWS] = fb.rows;
      s[o + F_START] = fb.start;
      s[o + F_END] = fb.end;
      s[o + F_END2] = fb.end2;
      s[o + PHASE1] = fb.phase1 > 0 ? fb.phase1 : 1;
      s[o + CELL] = cells > 1 && e.flags & RANDOM_CELL ? Math.floor(Math.random() * cells) : 0;
      if (prewarm > 0) {
        // Already partway through its life, for emitters that start out running.
        const age = Math.random() * Math.min(prewarm, s[o + LIFE]);
        s[o + AGE] = age;
        s[o + P] += s[o + V] * age;
        s[o + P + 1] += s[o + V + 1] * age + 0.5 * s[o + GRAVITY] * age * age;
        s[o + P + 2] += s[o + V + 2] * age;
      }
    }
  }
}

/** The scene's particles (one renderer, one scene). */
export const particles = new ParticleSystem();

/** Where emitters get their bones' world matrices (model units to meters). */
export interface BoneSource {
  boneMatrix(index: number, out: THREE.Matrix4): THREE.Matrix4 | null;
}

/** Per emitter source (an emitter, or one of its copies): emission carried between frames. */
interface Source {
  spec: Spec;
  bone: number;
  rate: ModelAnim;
  burst: ModelAnim;
  carry: number;
}

/**
 * The emitters of one model instance. Each frame it reads where the model's animation is,
 * emits what the tracks call for, from the bones' current world transforms.
 */
export class Emitters {
  private sources: Source[] = [];
  private sequences = new Map<string, ModelSequence>();
  private globals: ModelSequence[] = [];
  private clock = 0;
  private lastSeq: ModelSequence | null = null;
  private lastTime = 0;
  private started = false;
  private state: AnimState = { seq: null, time: 0, globals: [] };
  /** Scales every emitter's rate (fewer particles for distant or crowded scenes). */
  density = 1;
  /** Emitters to leave alone: they're fired by hand (a weapon's muzzle effects). */
  readonly manual = new Set<number>();
  /**
   * Rates its sequence doesn't key run at their own value, not at rest: a missile's model in
   * flight, whose trail is keyed only in its Death, to stop (a Picket's: 140 a second, cut to
   * nothing in the Death's first frame), and the Burner's flame (burnerFireSprite, keyed only
   * in its Death, burning in its Stand for as long as the Burner fires).
   */
  steady = false;

  constructor(readonly template: ModelTemplate) {
    const specs = particles.specsFor(template);
    template.data.emitters.forEach((e, i) => {
      const spec = specs[i];
      if (!spec) return;
      this.sources.push({ spec, bone: e.bone, rate: e.rate, burst: e.burst, carry: 0 });
      for (const c of e.copies) this.sources.push({ spec, bone: c.bone, rate: c.rate, burst: c.burst, carry: 0 });
    });
    for (const s of template.data.sequences) {
      this.sequences.set(s.name, s);
      if (/^GL/.test(s.name)) this.globals.push(s);
    }
    this.state.globals = this.globals.map((seq) => ({ seq, time: 0 }));
  }

  get empty(): boolean {
    return this.sources.length === 0;
  }

  /**
   * Emits for this frame. `clip` and `time` are the sequence playing and how far into it (looping
   * sequences wrap); `bones` gives a bone's world matrix; `reverse`, the clip is playing backwards
   * (its bursts are crossed going the other way).
   */
  update(dt: number, clip: string, time: number, loop: boolean, bones: BoneSource, reverse = false) {
    if (!particles.enabled || this.sources.length === 0) return;
    const seq = this.sequences.get(clip) ?? null;
    const duration = seq?.duration ?? 0;
    let t = time;
    if (seq && duration > 0) t = loop ? ((time % duration) + duration) % duration : Math.min(time, duration);
    const prevClock = this.clock;
    this.clock += dt;
    const st = this.state;
    st.seq = seq;
    st.time = t;
    for (const g of st.globals) g.time = g.seq.duration > 0 ? this.clock % g.seq.duration : 0;
    // Where the previous frame left off: a new sequence starts from its beginning.
    let from = this.lastTime;
    if (seq !== this.lastSeq || !this.started) from = -1e-4;
    else if (!loop && t < from) from = -1e-4;
    const first = !this.started;
    this.started = true;
    this.lastSeq = seq;
    this.lastTime = t;
    for (let i = 0; i < this.sources.length; i++) {
      if (this.manual.has(i)) continue;
      const src = this.sources[i];
      let n = 0;
      const rate = rateOf(src.rate, st, this.steady);
      if (rate > 0) {
        src.carry += rate * dt * this.density;
        n = Math.floor(src.carry);
        src.carry -= n;
      }
      // Bursts: keys crossed since the last frame, in this sequence or a global one.
      const bt = seq?.tracks.get(src.burst.id);
      if (bt && seq) n += Math.round((reverse ? burstsBetween(bt, t, from, duration) : burstsBetween(bt, from, t, duration)) * this.density);
      else
        for (const g of this.globals) {
          const gt = g.tracks.get(src.burst.id);
          if (gt) n += Math.round(burstsBetween(gt, g.duration > 0 ? prevClock % g.duration : 0, this.clock % Math.max(1e-6, g.duration), g.duration) * this.density);
        }
      let prewarm = 0;
      if (first && src.spec.e.flags & PREWARM && rate > 0) {
        prewarm = Math.max(num(src.spec.e.life[0], st), num(src.spec.e.life[1], st));
        n = Math.max(n, Math.round(rate * prewarm * this.density));
      }
      if (n <= 0) continue;
      const m = bones.boneMatrix(src.bone, tmpM);
      if (!m) continue;
      particles.spawn(src.spec, m, st, Math.min(n, MAX_PER_FRAME), prewarm);
    }
  }

  /** Fires source `index` by hand: `count` particles from its bone. */
  fire(index: number, count: number, bones: BoneSource) {
    const src = this.sources[index];
    if (!src || !particles.enabled) return;
    const m = bones.boneMatrix(src.bone, tmpM);
    if (m) particles.spawn(src.spec, m, this.state, count);
  }

  /** The source index of an emitter by its bone's name, for firing by hand. */
  find(boneName: string): number {
    return this.sources.findIndex((s) => this.template.data.bones[s.bone]?.name === boneName);
  }
}
