import * as THREE from 'three';

/** A soft radial gradient, for flashes and particles. */
function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PARTICLE_VERTEX = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (900.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vTint, t.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
  }`;

/** A fixed pool of point particles with velocity, gravity, drag and fade. */
class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private tint: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private gravity: Float32Array;
  private opacity: Float32Array;
  private next = 0;

  constructor(private capacity: number, map: THREE.Texture, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.tint = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.opacity = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  emit(
    at: THREE.Vector3,
    vel: THREE.Vector3,
    color: THREE.Color,
    size: number,
    life: number,
    gravity = 0,
    grow = 0,
    opacity = 1,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([at.x, at.y, at.z], i * 3);
    this.vel.set([vel.x, vel.y, vel.z], i * 3);
    this.tint.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = this.maxLife[i] = life;
    this.gravity[i] = gravity;
    this.grow[i] = grow;
    this.opacity[i] = opacity;
    this.alpha[i] = opacity;
  }

  /** Ground height, so falling matter lands instead of sinking through the terrain. */
  floor: ((x: number, z: number) => number) | null = null;

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= this.gravity[i] * dt;
      const drag = Math.exp(-1.5 * dt);
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.floor && this.gravity[i] > 0) {
        const ground = this.floor(this.pos[k], this.pos[k + 2]) + this.size[i] * 0.3;
        if (this.pos[k + 1] < ground) {
          this.pos[k + 1] = ground;
          this.vel[k] *= 0.3;
          this.vel[k + 2] *= 0.3;
          this.vel[k + 1] = Math.abs(this.vel[k + 1]) > 3 ? Math.abs(this.vel[k + 1]) * 0.25 : 0;
        }
      }
      this.size[i] += this.grow[i] * dt;
      // Fade in quickly, then out over the particle's life.
      const f = this.life[i] / this.maxLife[i];
      this.alpha[i] = this.opacity[i] * Math.min(1, (1 - f) * 8) * f;
    }
    const g = this.points.geometry;
    for (const name of ['position', 'tint', 'size', 'alpha']) g.attributes[name].needsUpdate = true;
  }
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  width: number;
  /** A round in flight: meters per second its streak travels (0 for a beam drawn end to end). */
  speed: number;
  /** The streak's length, meters. */
  length: number;
}

interface Flash {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  size: number;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const basis = new THREE.Matrix4();
const faceZ = new THREE.Vector3();
const faceY = new THREE.Vector3();

/**
 * The turn that lays a quad's X along `axis` (a tracer's, a bolt's, a flame's) and faces it to the
 * camera at `camPos`, as near as a quad held along that line can: X the axis, Z toward the camera
 * (square to the axis), Y = Z x X. Right-handed, so it's a rotation: a frame built the other way
 * round is a mirror image, and a mirror has no rotation (the quad comes out turned any old way).
 */
function faceAlong(axis: THREE.Vector3, camPos: THREE.Vector3, at: THREE.Vector3): THREE.Matrix4 {
  faceZ.subVectors(camPos, at);
  faceZ.addScaledVector(axis, -axis.dot(faceZ));
  if (faceZ.lengthSq() < 1e-8) {
    // Looking straight down the line: any face square to it will do.
    faceZ.set(Math.abs(axis.y) < 0.9 ? 0 : 1, Math.abs(axis.y) < 0.9 ? 1 : 0, 0);
    faceZ.addScaledVector(axis, -axis.dot(faceZ));
  }
  faceZ.normalize();
  faceY.crossVectors(faceZ, axis);
  return basis.makeBasis(axis, faceY, faceZ);
}
const color = new THREE.Color();

/** An irregular splat: a central blot with droplets, as an alpha mask. */
function splatTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const blot = (x: number, y: number, r: number, a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.7, `rgba(255,255,255,${a * 0.85})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  blot(64, 64, 30, 0.9);
  for (let i = 0; i < 7; i++) blot(64 + (rnd() - 0.5) * 40, 64 + (rnd() - 0.5) * 40, 10 + rnd() * 14, 0.8);
  for (let i = 0; i < 24; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 30 + rnd() * 30;
    blot(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + rnd() * 4, 0.9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Stains on the ground: ichor where Crawl die, scorch where shells land. One instanced draw,
 * a ring buffer of a few hundred, each fading out over half a minute.
 */
class Decals {
  readonly mesh: THREE.InstancedMesh;
  private alpha: THREE.InstancedBufferAttribute;
  private born: Float32Array;
  private life: Float32Array;
  private peak: Float32Array;
  private next = 0;
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(private capacity: number) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('decalAlpha', this.alpha);
    const material = new THREE.MeshLambertMaterial({ map: splatTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float decalAlpha;\nvarying float vDecalAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDecalAlpha = decalAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDecalAlpha;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecalAlpha;');
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
    this.born = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.peak = new Float32Array(capacity);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.mesh.setColorAt(i, this.c.set(0x000000));
    }
  }

  add(at: THREE.Vector3, size: number, hex: number, opacity: number, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.random() * Math.PI * 2);
    this.s.set(size, 1, size);
    this.m.compose(at, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, this.c.setHex(hex));
    this.born[i] = this.time;
    this.life[i] = life;
    this.peak[i] = opacity;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number) {
    this.time += dt;
    for (let i = 0; i < this.capacity; i++) {
      const age = this.time - this.born[i];
      const left = this.life[i] - age;
      this.alpha.setX(i, left > 0 ? this.peak[i] * Math.min(1, left / 6) * Math.min(1, age * 6) : 0);
    }
    this.alpha.needsUpdate = true;
  }
}

/**
 * A piece of a texture atlas, by its pixel rectangle in a `size`-pixel texture (rows counted
 * from the top, the way the loader's textures are stored and uploaded).
 */
export function atlasPiece(tex: THREE.Texture, size: number, x0: number, y0: number, x1: number, y1: number): THREE.Texture {
  const t = tex.clone();
  t.offset.set(x0 / size, y0 / size);
  t.repeat.set((x1 - x0) / size, (y1 - y0) / size);
  return t;
}

/**
 * The RK-4's muzzle-flash texture is an atlas of flash pieces (bursts, jets, sparks) for the
 * rifle model's flash cards. A sprite showing all of it draws slices of several, cut off at the
 * quad's edges; these are its four round bursts, one picked per flash.
 */
const FLASH_BURSTS: [number, number, number, number][] = [
  [172, 428, 252, 510],
  [170, 173, 256, 257],
  [422, 175, 512, 259],
  [408, 413, 511, 512],
];
/**
 * The same atlas's flames seen from the side, hot blue base at the left and billowing out to the
 * right: the rifle's four big ones, and four thin jets. A muzzle flash lays one along the barrel.
 */
const FLASH_FLAMES: [number, number, number, number][] = [
  [20, 70, 242, 164],
  [274, 56, 466, 170],
  [12, 298, 236, 442],
  [264, 284, 512, 452],
];
const FLASH_JETS: [number, number, number, number][] = [
  [18, 206, 154, 250],
  [260, 206, 364, 250],
  [6, 464, 154, 506],
  [260, 460, 414, 508],
];

/** Tracers, muzzle flashes, sparks, ichor, smoke and explosions. */
export class Effects {
  private glow = new Particles(3000, glowTexture(), true);
  private matter = new Particles(3000, glowTexture(), false);
  private decals = new Decals(320);
  private tracers: Tracer[] = [];
  /** Bolts drawn with a texture of the game's own (a Warship's laser), by texture. */
  private bolts: Tracer[] = [];
  /** Muzzle flames: a flame from the rifle's atlas laid along the barrel. */
  private flames: Tracer[] = [];
  private flameTextures: THREE.Texture[] = [];
  private jetTextures: THREE.Texture[] = [];
  /** A quad whose texture runs along its length (its V along local X), for bolts. */
  private boltGeometry: THREE.BufferGeometry;
  /** A quad from its left edge (local X 0..1), for a flame that starts at the muzzle. */
  private flameGeometry: THREE.BufferGeometry;
  private flashes: Flash[] = [];
  private lights: { light: THREE.PointLight; life: number; maxLife: number; intensity: number }[] = [];
  private flashTextures: THREE.Texture[];
  private softTexture = glowTexture();
  /** Camera shake amount, decays over time; the camera rig reads it. */
  shake = 0;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    muzzleTexture: THREE.Texture | null,
  ) {
    scene.add(this.glow.points, this.matter.points, this.decals.mesh);
    this.flashTextures = muzzleTexture ? FLASH_BURSTS.map((r) => atlasPiece(muzzleTexture, 512, ...r)) : [glowTexture()];
    if (muzzleTexture) {
      this.flameTextures = FLASH_FLAMES.map((r) => atlasPiece(muzzleTexture, 512, ...r));
      this.jetTextures = FLASH_JETS.map((r) => atlasPiece(muzzleTexture, 512, ...r));
    }
    this.boltGeometry = new THREE.PlaneGeometry(1, 1);
    const uv = this.boltGeometry.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
    this.flameGeometry = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffc070, 0, 14, 2);
      scene.add(light);
      this.lights.push({ light, life: 0, maxLife: 1, intensity: 0 });
    }
    // A few of each up front, so their shaders compile while loading rather than mid-fight.
    for (let i = 0; i < 8; i++) {
      this.newTracer();
      this.newFlash();
    }
  }

  private newTracer(): Tracer {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    const t = { mesh, life: 0, maxLife: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), width: 0, speed: 0, length: 0 };
    this.tracers.push(t);
    return t;
  }

  private newFlash(): Flash {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.flashTextures[0], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    sprite.visible = false;
    this.scene.add(sprite);
    const f = { sprite, life: 0, maxLife: 0, size: 0 };
    this.flashes.push(f);
    return f;
  }

  private newTextured(pool: Tracer[], geometry: THREE.BufferGeometry, map: THREE.Texture): Tracer {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    const t = { mesh, life: 0, maxLife: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), width: 0, speed: 0, length: 0 };
    pool.push(t);
    return t;
  }

  /**
   * A bolt in flight drawn with a texture of the game's own (the Warship's laser bolt): a
   * quad `length` long and `width` wide running along its path from `from` to `to` at `speed`,
   * the texture's length along it, facing the camera.
   */
  bolt(from: THREE.Vector3, to: THREE.Vector3, map: THREE.Texture, width: number, length: number, speed: number, hex = 0xffffff, intensity = 1) {
    const t = this.bolts.find((x) => x.life <= 0 && (x.mesh.material as THREE.MeshBasicMaterial).map === map) ?? this.newTextured(this.bolts, this.boltGeometry, map);
    // Brighter than white blooms: the glow round a laser bolt.
    (t.mesh.material as THREE.MeshBasicMaterial).color.setHex(hex).multiplyScalar(intensity);
    t.from.copy(from);
    t.to.copy(to);
    t.width = width;
    t.speed = speed;
    t.length = length;
    t.life = t.maxLife = (from.distanceTo(to) + length) / speed;
    t.mesh.visible = true;
  }

  /**
   * A muzzle flash as the rifle model's own flash cards draw it: a flame from its atlas laid along
   * the barrel from the muzzle (`length` meters), a round burst over the muzzle, and a flash of
   * light round about. `jet`: one of the thin jets, for a lighter round.
   */
  muzzleFlash(at: THREE.Vector3, dir: THREE.Vector3, length: number, opts: { jet?: boolean; light?: number; hex?: number; life?: number } = {}) {
    const textures = opts.jet ? this.jetTextures : this.flameTextures;
    const life = opts.life ?? 0.05;
    if (textures.length) {
      const map = textures[Math.floor(Math.random() * textures.length)];
      const t = this.flames.find((x) => x.life <= 0) ?? this.newTextured(this.flames, this.flameGeometry, map);
      const m = t.mesh.material as THREE.MeshBasicMaterial;
      m.map = map;
      m.color.setHex(opts.hex ?? 0xffffff);
      t.from.copy(at);
      t.to.copy(at).addScaledVector(dir, length * (0.85 + Math.random() * 0.3));
      // As wide as the piece is, for its length (the big flames run about two and a half to one).
      t.width = length * (opts.jet ? 0.32 : 0.42);
      t.speed = 0;
      t.length = 0;
      t.life = t.maxLife = life;
      t.mesh.visible = true;
    }
    this.flash(at, length * 0.55, opts.hex ?? 0xffd8a0, life, opts.light ?? 0);
  }

  /** A flash of light alone (no sprite), for `life` seconds: a muzzle flash lighting what's round it. */
  light(at: THREE.Vector3, hex: number, intensity: number, life = 0.05) {
    const l = this.lights.reduce((a, b) => (a.life < b.life ? a : b));
    l.light.position.copy(at);
    l.light.color.setHex(hex);
    l.life = l.maxLife = life;
    l.intensity = intensity;
  }

  /** A beam, drawn end to end for `life` seconds: the Keel Gun, a battery bolt, a laser. */
  tracer(from: THREE.Vector3, to: THREE.Vector3, hex = 0xffd890, width = 0.05, life = 0.07) {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.newTracer();
    (t.mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
    t.from.copy(from);
    t.to.copy(to);
    t.width = width;
    t.life = t.maxLife = life;
    t.speed = 0;
    t.length = 0;
    t.mesh.visible = true;
  }

  /**
   * A round's tracer: a short glowing streak that flies from the muzzle to where the round
   * landed, the way tracer fire looks, rather than a line drawn across the whole distance.
   */
  bullet(from: THREE.Vector3, to: THREE.Vector3, hex = 0xffe6a0, width = 0.035, speed = 520, length?: number) {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.newTracer();
    (t.mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
    t.from.copy(from);
    t.to.copy(to);
    t.width = width;
    const dist = from.distanceTo(to);
    t.speed = speed;
    t.length = length ?? THREE.MathUtils.clamp(dist * 0.2, 1.2, 7);
    // Flight time, plus the moment the tail takes to arrive.
    t.life = t.maxLife = (dist + t.length) / speed;
    t.mesh.visible = true;
  }

  /** A brief additive flash; `soft` uses a plain glow instead of the muzzle-flash texture. */
  flash(at: THREE.Vector3, size: number, hex = 0xffd8a0, life = 0.06, lightIntensity = 0, soft = false) {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.newFlash();
    f.sprite.material.map = soft ? this.softTexture : this.flashTextures[Math.floor(Math.random() * this.flashTextures.length)];
    f.sprite.position.copy(at);
    f.sprite.material.color.setHex(hex);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.size = size;
    f.life = f.maxLife = life;
    f.sprite.visible = true;
    if (lightIntensity > 0) {
      const l = this.lights.reduce((a, b) => (a.life < b.life ? a : b));
      l.light.position.copy(at);
      l.light.color.setHex(hex);
      l.life = l.maxLife = Math.max(life, 0.06);
      l.intensity = lightIntensity;
    }
  }

  /** Ground height for landing debris and laying stains; set once the terrain exists. */
  set floor(f: (x: number, z: number) => number) {
    this.ground = f;
    this.matter.floor = f;
  }
  private ground: ((x: number, z: number) => number) | null = null;

  /** A stain on the ground under `at`: ichor, blood, or scorch. */
  stain(at: THREE.Vector3, size: number, hex: number, opacity = 0.85, life = 30) {
    const y = this.ground ? this.ground(at.x, at.z) + 0.03 : at.y;
    this.decals.add(tmp2.set(at.x, y, at.z), size, hex, opacity, life);
  }

  /** Chunks thrown off a creature that bursts: they arc, land and lie in the dust. */
  gibs(at: THREE.Vector3, hex: number, scale = 1, count = 10) {
    color.setHex(hex).multiplyScalar(0.55);
    for (let i = 0; i < count; i++) {
      tmp.set(Math.random() - 0.5, 0.6 + Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar((3 + Math.random() * 5) * Math.sqrt(scale));
      this.matter.emit(at, tmp, color, (0.12 + Math.random() * 0.2) * scale, 1.6 + Math.random() * 1.4, 18, 0, 1);
    }
  }

  sparks(at: THREE.Vector3, normal: THREE.Vector3, count = 6, hex = 0xffc060) {
    color.setHex(hex);
    for (let i = 0; i < count; i++) {
      tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.2).add(normal).normalize();
      this.glow.emit(at, tmp.multiplyScalar(4 + Math.random() * 8), color, 0.05 + Math.random() * 0.05, 0.15 + Math.random() * 0.25, 18);
    }
    this.matter.emit(at, tmp2.copy(normal).multiplyScalar(0.6), color.setHex(0x8a7a66), 0.35, 0.6, -0.4, 1.2);
  }

  /** Crawl ichor: thick, dark and falling. */
  ichor(at: THREE.Vector3, dir: THREE.Vector3, count = 8, hex = 0x7a8a22, scale = 1) {
    color.setHex(hex);
    for (let i = 0; i < count; i++) {
      tmp.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(1.5).add(dir).normalize();
      this.matter.emit(at, tmp.multiplyScalar((2 + Math.random() * 4) * scale), color, (0.08 + Math.random() * 0.12) * scale, 0.5 + Math.random() * 0.5, 14);
    }
  }

  smoke(at: THREE.Vector3, size = 1.5, hex = 0x8a7a68, life = 2.5) {
    tmp.set((Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6);
    this.matter.emit(at, tmp, color.setHex(hex), size, life, -0.2, size * 0.8, 0.45);
  }

  /** A Burner's flame: burning fuel streaming out along `dir`, licking up as it goes. */
  /** A flamethrower's gout; `scale` sizes its fire (smaller from the eye, in first person). */
  flame(from: THREE.Vector3, dir: THREE.Vector3, length: number, scale = 1) {
    for (let i = 0; i < 12; i++) {
      const speed = length * (2.6 + Math.random() * 1.4);
      tmp.copy(dir).multiplyScalar(speed);
      tmp.x += (Math.random() - 0.5) * speed * 0.2;
      tmp.y += (Math.random() - 0.2) * speed * 0.16;
      tmp.z += (Math.random() - 0.5) * speed * 0.2;
      color.setHSL(0.04 + Math.random() * 0.07, 1, 0.5 + Math.random() * 0.15);
      this.glow.emit(from, tmp, color, (0.35 + Math.random() * 0.45) * scale, 0.4 + Math.random() * 0.2, -4, 5.5 * scale);
    }
    if (Math.random() < 0.5) {
      tmp2.copy(from).addScaledVector(dir, length * (0.6 + Math.random() * 0.4));
      this.smoke(tmp2, 0.9 * scale, 0x3a3029, 1.4);
    }
  }

  /**
   * A flamethrower's fire laid along the stream out to `reach` (meters) every frame, thin and hot
   * at the nozzle and billowing as it goes, licking up, with smoke where it ends. Laid along its
   * whole length, it reads the same from any angle (fire only flung from the nozzle showed from
   * the side, and from behind the shoulder hardly at all). `scale` sizes the fire, `strength` its
   * brightness, and the first `clear` meters are left out (from the eye, so it doesn't fill the
   * view); `count` flames a frame. `even` spreads them evenly along the stream rather than
   * crowding the nozzle, where additive fire stacks up into a glare (a soldier's own flame, seen
   * from just behind it).
   */
  flameStream(from: THREE.Vector3, dir: THREE.Vector3, reach: number, opts: { scale?: number; strength?: number; clear?: number; count?: number; even?: boolean } = {}) {
    const { scale = 1, strength = 1, clear = 0, count = 30, even = false } = opts;
    for (let i = 0; i < count; i++) {
      // Along the stream, more of it near the nozzle, where it's dense (or evenly).
      const t = even ? Math.random() : Math.pow(Math.random(), 1.35);
      const d = clear + (reach - clear) * t;
      const spread = d * (0.04 + 0.1 * t);
      tmp2.copy(from).addScaledVector(dir, d);
      tmp2.x += (Math.random() - 0.5) * spread;
      tmp2.y += (Math.random() - 0.3) * spread * 0.6;
      tmp2.z += (Math.random() - 0.5) * spread;
      // Still pouring forward, and rising.
      tmp.copy(dir).multiplyScalar(8 + Math.random() * 8);
      tmp.y += 1 + Math.random() * 2;
      // A yellow core through the orange, reddening as it goes; never white (it overlaps itself, and adds up).
      if (i % 5 === 0) color.setHSL(0.11, 1, 0.56 - t * 0.06);
      else color.setHSL(0.02 + Math.random() * 0.07 - t * 0.02, 1, 0.44 + Math.random() * 0.1 - t * 0.08);
      this.glow.emit(tmp2, tmp, color, (0.25 + 1.5 * t) * (0.8 + Math.random() * 0.4) * scale, 0.14 + Math.random() * 0.12, -2, 1.5 * scale, 0.75 * strength);
    }
    if (Math.random() < 0.45) {
      tmp2.copy(from).addScaledVector(dir, reach * (0.75 + Math.random() * 0.3));
      this.smoke(tmp2, 1.1 * scale, 0x3a3029, 1.5);
    }
  }

  /** Jet pack exhaust: a downward burst of flame and dust. */
  jet(at: THREE.Vector3) {
    color.setHex(0x9fd4ff);
    for (let i = 0; i < 4; i++) {
      tmp.set((Math.random() - 0.5) * 2, -6 - Math.random() * 6, (Math.random() - 0.5) * 2);
      this.glow.emit(at, tmp, color, 0.18 + Math.random() * 0.15, 0.18 + Math.random() * 0.12, 0, 1);
    }
    this.smoke(at, 0.7, 0x8a7a68, 0.9);
  }

  /**
   * A nuclear detonation: the white flash, a fireball rising into a mushroom cloud, the
   * shockwave of dust rolling out across the ground, debris raining back down.
   */
  warhead(at: THREE.Vector3, radius: number) {
    this.flash(at, radius * 6, 0xffffff, 0.6, 400, true);
    this.flash(tmp2.copy(at).setY(at.y + radius * 0.4), radius * 4, 0xffc070, 1.6, 300, true);
    this.shake = Math.max(this.shake, 2.5);
    // Fireball and stem.
    for (let i = 0; i < 90; i++) {
      tmp.set(Math.random() - 0.5, Math.random() * 1.2, Math.random() - 0.5).normalize().multiplyScalar(radius * (0.3 + Math.random() * 0.7));
      color.setHSL(0.04 + Math.random() * 0.08, 1, 0.45 + Math.random() * 0.25);
      this.glow.emit(at, tmp, color, radius * (0.06 + Math.random() * 0.06), 1.2 + Math.random() * 1.6, -2, radius * 0.05);
    }
    for (let i = 0; i < 70; i++) {
      // The column, then the cap spreading at the top.
      const h = Math.random();
      tmp2.copy(at).add(tmp.set((Math.random() - 0.5) * radius * 0.3, h * radius * 1.6, (Math.random() - 0.5) * radius * 0.3));
      tmp.set((Math.random() - 0.5) * 2, 6 + h * 10, (Math.random() - 0.5) * 2);
      this.matter.emit(tmp2, tmp, color.setHex(h > 0.7 ? 0x8a6a52 : 0x5a4a40), radius * (0.12 + Math.random() * 0.1), 6 + Math.random() * 5, -0.6, radius * 0.08, 0.7);
    }
    // The shockwave: dust racing outward along the ground.
    for (let i = 0; i < 80; i++) {
      const a = (i / 80) * Math.PI * 2;
      tmp.set(Math.cos(a), 0.05, Math.sin(a)).multiplyScalar(radius * (1.6 + Math.random() * 0.6));
      tmp2.copy(at).add(new THREE.Vector3(Math.cos(a) * 2, 1, Math.sin(a) * 2));
      this.matter.emit(tmp2, tmp, color.setHex(0x9a8670), radius * 0.1, 3 + Math.random() * 1.5, 0, radius * 0.12, 0.55);
    }
    for (let i = 0; i < 40; i++) {
      tmp.set(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).normalize().multiplyScalar(radius * (1 + Math.random() * 1.5));
      this.matter.emit(at, tmp, color.setHex(0x2a1d14), 0.3 + Math.random() * 0.4, 3 + Math.random() * 2, 14);
    }
    this.stain(at, radius * 2.4, 0x120c08, 0.9, 120);
  }

  /** A Blister bursting: a green flash, acid spraying out in a ring and raining down, a caustic haze. */
  acidBurst(at: THREE.Vector3, radius: number) {
    this.flash(at, radius * 1.4, 0xb8ff58, 0.22, 30 * radius, true);
    this.flash(at, radius * 0.6, 0xe8ffb0, 0.08);
    color.setHex(0x9cff40);
    for (let i = 0; i < 50; i++) {
      tmp.set(Math.random() - 0.5, 0.2 + Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(radius * (1 + Math.random() * 1.4));
      this.glow.emit(at, tmp, color, 0.1 + Math.random() * 0.16, 0.45 + Math.random() * 0.5, 16);
    }
    color.setHex(0x5a7a18);
    for (let i = 0; i < 24; i++) {
      tmp.set(Math.random() - 0.5, 0.4 + Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(radius * (0.6 + Math.random()));
      this.matter.emit(at, tmp, color, 0.1 + Math.random() * 0.16, 0.6 + Math.random() * 0.6, 16);
    }
    for (let i = 0; i < 8; i++) {
      tmp2.copy(at).add(tmp.set(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).multiplyScalar(radius * 0.9));
      this.smoke(tmp2, radius * (0.22 + Math.random() * 0.2), 0x8aa040, 1.4 + Math.random());
    }
    this.stain(at, radius * 0.9, 0x4a6a10, 0.85, 40);
  }

  explosion(at: THREE.Vector3, radius: number) {
    this.flash(at, radius * 3, 0xffb060, 0.18, 60 * radius);
    color.setHex(0xffa040);
    for (let i = 0; i < 40; i++) {
      tmp.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(radius * (4 + Math.random() * 8));
      this.glow.emit(at, tmp, color, 0.08 + Math.random() * 0.1, 0.3 + Math.random() * 0.5, 15);
    }
    for (let i = 0; i < 10; i++) {
      tmp2.copy(at).add(tmp.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(radius));
      this.smoke(tmp2, radius * (0.8 + Math.random()), 0x6a5e52, 2 + Math.random() * 2);
    }
    for (let i = 0; i < 12; i++) {
      tmp.set(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize().multiplyScalar(radius * (3 + Math.random() * 4));
      this.matter.emit(at, tmp, color.setHex(0x3b2a1c), 0.12 + Math.random() * 0.15, 0.8 + Math.random() * 0.6, 16);
    }
  }

  /** A screen white-out, 0..1, fading (a nuclear flash). */
  whiteout = 0;

  update(dt: number) {
    this.whiteout = Math.max(0, this.whiteout - dt * 0.9);
    this.glow.update(dt);
    this.matter.update(dt);
    this.decals.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);

    const camPos = this.camera.getWorldPosition(tmp2);
    for (const t of this.flames) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.visible = false;
        continue;
      }
      // From the muzzle along the barrel, turned about it to face the camera.
      const axis = tmp.subVectors(t.to, t.from);
      const len = axis.length();
      axis.divideScalar(Math.max(len, 1e-4));
      t.mesh.position.copy(t.from);
      t.mesh.quaternion.setFromRotationMatrix(faceAlong(axis, camPos, t.from));
      t.mesh.scale.set(len, t.width, 1);
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (t.life / t.maxLife) * 1.6);
    }
    for (const t of [...this.tracers, ...this.bolts]) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.visible = false;
        continue;
      }
      // A quad stretched from `from` to `to` (or along the streak of a round in flight), turned
      // about its axis to face the camera.
      const axis = tmp.subVectors(t.to, t.from);
      const full = axis.length();
      axis.normalize();
      let len = full;
      const mid = new THREE.Vector3();
      if (t.speed > 0) {
        const head = Math.min(full, (t.maxLife - t.life) * t.speed);
        const tail = Math.max(0, head - t.length);
        len = Math.max(0.01, head - tail);
        mid.copy(t.from).addScaledVector(axis, (head + tail) * 0.5);
      } else mid.addVectors(t.from, t.to).multiplyScalar(0.5);
      t.mesh.position.copy(mid);
      t.mesh.quaternion.setFromRotationMatrix(faceAlong(axis, camPos, mid));
      t.mesh.scale.set(len, t.width, 1);
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = t.speed > 0 ? 0.9 : t.life / t.maxLife;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.sprite.visible = false;
        continue;
      }
      const k = f.life / f.maxLife;
      f.sprite.scale.setScalar(f.size * (0.6 + 0.4 * k));
      f.sprite.material.opacity = k;
    }
    for (const l of this.lights) {
      l.life = Math.max(0, l.life - dt);
      l.light.intensity = l.life > 0 ? l.intensity * (l.life / l.maxLife) : 0;
    }
  }
}
