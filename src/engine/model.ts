import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LAYER_SLOTS, type LayerSlot, type ModelAnim, type ModelMaterial, type ModelData, type ModelSequence } from './modeldata.ts';
import { channelRange } from './assets.ts';
import { injectCrowdSkinning } from './crowd.ts';

/** A material's textures, by the layer each fills. */
export type LayerTextures = Partial<Record<LayerSlot, THREE.Texture>>;

/** Layers that hold color (sRGB); the rest hold data. */
export const COLOR_SLOTS: LayerSlot[] = ['diffuse', 'emissive', 'decal'];
export const DATA_SLOTS: LayerSlot[] = ['specular', 'normal', 'alphaMask'];

/** Material flags. */
const TWO_SIDED = 0x8;
const NO_SHADOWS_CAST = 0x20;
/** Material flag: drawn in a depth pre-pass (the format's name for it), as a see-through solid is. */
const DEPTH_PREPASS = 0x100;
/** Material blend modes. */
const BLEND = { opaque: 0, alpha: 1, add: 2, alphaAdd: 3, mod: 4, mod2x: 5 } as const;

/** How a material is drawn: a lit opaque surface, a lit see-through solid, or an unlit blended effect. */
type MaterialKind = 'opaque' | 'translucent' | 'effect';

function kindOf(mat: ModelMaterial, tex: LayerTextures): MaterialKind {
  // A see-through solid is blended, but has a surface: a normal map, and a depth pre-pass.
  if (mat.blendMode === BLEND.alpha && !!tex.normal && (mat.flags & DEPTH_PREPASS) !== 0) return 'translucent';
  return mat.blendMode === BLEND.opaque ? 'opaque' : 'effect';
}

/** The texture channel an alpha mask reads, by its layer's channel setting (RGB reads as 1). */
const MASK_PICK = ['1.0', 't.a', 't.a', 't.r', 't.g', 't.b'];

/**
 * What changes with the animation in a material's layers, as the model data keys it: the alpha
 * mask's multiply and add (a death model burns its body away by sweeping the add down through a
 * burn-pattern texture) and the color layer's multiply (glows fading, a wreck charring).
 */
export interface LayerAnim {
  kind: MaterialKind;
  /** The alpha mask, and the range its channel spans in the texture (after any invert). */
  mask: { multiply: ModelAnim; add: ModelAnim; lo: number; hi: number } | null;
  /** The color layer's multiply, when a sequence animates it. */
  color: ModelAnim | null;
  /** The color multiply where nothing animates it. */
  colorRest: number;
  cutout: number;
  /** Whether any sequence animates these (otherwise they hold one value). */
  animated: boolean;
  /** Whether the surface casts a shadow: opaque, and not marked otherwise. */
  shadow: boolean;
}

function layerAnimOf(mat: ModelMaterial, tex: LayerTextures, sequences: ModelSequence[]): LayerAnim {
  const keyed = (a: ModelAnim) => sequences.some((s) => s.tracks.has(a.id));
  const kind = kindOf(mat, tex);
  const maskLayer = tex.alphaMask ? mat.layers.alphaMask : undefined;
  const maskAnimated = !!maskLayer && (keyed(maskLayer.multiply) || keyed(maskLayer.add));
  let mask: LayerAnim['mask'] = null;
  if (maskLayer && tex.alphaMask) {
    // The range matters only to an animated mask (when has it hidden every pixel?).
    let lo = 1;
    let hi = 1;
    const c = maskLayer.colorChannels;
    if (maskAnimated && c !== 0) {
      const range = channelRange(tex.alphaMask);
      const ch = c === 3 ? 0 : c === 4 ? 1 : c === 5 ? 2 : 3;
      [lo, hi] = [range.min[ch], range.max[ch]];
    }
    if (maskLayer.invert) [lo, hi] = [1 - hi, 1 - lo];
    mask = { multiply: maskLayer.multiply, add: maskLayer.add, lo, hi };
  }
  const colorLayer = kind === 'effect' ? (mat.layers.diffuse ?? mat.layers.emissive) : mat.layers.diffuse;
  const color = colorLayer && keyed(colorLayer.multiply) ? colorLayer.multiply : null;
  return {
    kind,
    mask,
    color,
    // A glow at no brightness at all shows nowhere (the Tusker's blade glow, which nothing
    // animates): it draws black, which an additive layer doesn't show.
    colorRest: kind === 'effect' ? (colorLayer?.multiply.value === 0 ? 0 : THREE.MathUtils.clamp(colorLayer?.multiply.value || 1, 0.2, 4)) : 1,
    cutout: mat.cutout,
    animated: maskAnimated || !!color,
    shadow: kind === 'opaque' && (mat.flags & NO_SHADOWS_CAST) === 0,
  };
}

/**
 * An animated scalar `time` seconds into `seq`: its keys blended (or held), the value it rests
 * at where `seq` doesn't key it, and its own value with no sequence at all.
 */
export function animValue(a: ModelAnim, seq: ModelSequence | null, time: number): number {
  if (!seq) return a.value;
  const t = seq.tracks.get(a.id);
  if (!t || !t.times.length) return a.rest ?? a.value;
  const n = t.times.length;
  if (time <= t.times[0]) return t.values[0];
  if (time >= t.times[n - 1]) return t.values[n - 1];
  let i = 1;
  while (t.times[i] < time) i++;
  if (a.step) return t.values[i - 1];
  const k = (time - t.times[i - 1]) / Math.max(1e-6, t.times[i] - t.times[i - 1]);
  return t.values[i - 1] + (t.values[i] - t.values[i - 1]) * k;
}

/**
 * A material's layer values at a moment of `seq` (null: unanimated): x the alpha mask's
 * multiply, y its add, z the color multiply, w 1 while the mask can still show any pixel.
 */
export function layerValues(l: LayerAnim, seq: ModelSequence | null, time: number, out: THREE.Vector4): THREE.Vector4 {
  let shown = 1;
  let multiply = 1;
  let add = 0;
  if (l.mask) {
    multiply = animValue(l.mask.multiply, seq, time);
    add = animValue(l.mask.add, seq, time);
    // The brightest pixel the mask has, against the cut-out threshold.
    if (seq && l.animated) shown = (multiply >= 0 ? l.mask.hi : l.mask.lo) * multiply + add >= l.cutout ? 1 : 0;
  }
  let color = l.colorRest;
  if (seq && l.color) {
    const v = animValue(l.color, seq, time);
    color = l.kind === 'effect' ? THREE.MathUtils.clamp(v, 0, 4) : v / (l.color.value || 1);
  }
  return out.set(multiply, add, color, shown);
}

/** How a death clip plays out: when its fall is over, and when it starts to burn its body away. */
export interface DeathPlan {
  duration: number;
  /** Seconds in when what's drawn opaque has stopped falling, tumbling and flying apart. */
  settled: number;
  /**
   * Seconds in when the model starts burning away a body that was whole until then (its own
   * end), or `duration` if it doesn't.
   */
  burn: number;
}

/** How fast (model heights per second) a death model's pieces may still drift once settled. */
const SETTLED_SPEED = 0.25;

/**
 * A layer's uvSource for a particle's own coordinates, run through its emitter's flipbook
 * (the format's "Animated Particle UV"). Particles show a layer on the default coordinates (0)
 * whole, whatever their emitter's flipbook says.
 */
export const PARTICLE_UV = 6;

/** The layers a mesh can place: all but those on particle coordinates. */
function meshTextures(mat: ModelMaterial, tex: LayerTextures): LayerTextures {
  let out = tex;
  for (const slot of LAYER_SLOTS) {
    if (!out[slot] || mat.layers[slot]?.uvSource !== PARTICLE_UV) continue;
    if (out === tex) out = { ...tex };
    delete out[slot];
  }
  return out;
}

/** The loader's textures are lit in gamma space with roughly 2x multipliers, so they're authored dark. */
export const materialSettings = { diffuseBoost: { value: 3.2 }, teamBoost: { value: 0.35 } };

/**
 * Per-instance effects, in a vec4: x hit flash (0..1), y left tread scroll, z dissolve (0..1,
 * for corpses), w right tread scroll. Crowds carry it as an instanced attribute, lone
 * instances as a uniform.
 */
const FX_VERTEX = /* glsl */ `
  varying vec4 vFx;
  uniform vec3 uvScroll; // direction (xy), and which tread (z: 0 left, 1 right)
  #ifdef MAT_CROWD
    attribute vec4 crowdFx;
    #define MAT_FX crowdFx
  #else
    uniform vec4 heroFx;
    #define MAT_FX heroFx
  #endif
  // The layers' animated values (see layerValues): per instance from the crowd's baked
  // texture, or a uniform.
  varying vec4 vLayer;
  #ifndef MAT_LAYER_CROWD
    uniform vec4 layerAnim;
  #endif
  #ifdef MAT_MASK
    varying vec2 vMaskUv;
  #endif
  #if ( defined( MAT_DECAL ) && defined( MAT_DECAL_UV1 ) || defined( MAT_MASK ) && defined( MAT_MASK_UV1 ) ) && !defined( USE_UV1 )
    attribute vec2 uv1;
  #endif
  #ifdef MAT_DECAL
    varying vec2 vDecalUv;
  #endif
`;

const FX_UV = /* glsl */ `
  vFx = MAT_FX;
  vec2 layerScroll = uvScroll.xy * mix( vFx.y, vFx.w, uvScroll.z );
  #ifdef USE_MAP
    vMapUv += layerScroll;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv += layerScroll;
  #endif
  #ifdef USE_SPECULARMAP
    vSpecularMapUv += layerScroll;
  #endif
  #ifdef USE_EMISSIVEMAP
    vEmissiveMapUv += layerScroll;
  #endif
  #ifdef MAT_DECAL
    #ifdef MAT_DECAL_UV1
      vDecalUv = uv1;
    #else
      vDecalUv = uv;
    #endif
  #endif
  #ifdef MAT_LAYER_CROWD
    vLayer = crowdLayer( MAT_LAYER_COLUMN );
  #else
    vLayer = layerAnim;
  #endif
  #ifdef MAT_MASK
    #if defined( MAT_MASK_UV1 )
      vMaskUv = uv1;
    #elif defined( USE_MAP )
      vMaskUv = vMapUv;
    #else
      vMaskUv = uv;
    #endif
  #endif
`;

/**
 * An alpha mask, as the model format defines one: its texture's chosen channel, inverted if the
 * layer says so, times the layer's multiply plus its add (vLayer.xy), clamped if the layer says
 * so. Needs vLayer declared ahead of it.
 */
const MASK_FRAGMENT = /* glsl */ `
  #if defined( MAT_MASK ) || defined( MAT_CUTOUT )
    uniform float maskCutout;
  #endif
  #ifdef MAT_MASK
    uniform sampler2D alphaMaskMap;
    varying vec2 vMaskUv;
    float layerMask() {
      vec4 t = texture2D( alphaMaskMap, vMaskUv );
      float a = MAT_MASK_PICK;
      #ifdef MAT_MASK_INVERT
        a = 1.0 - a;
      #endif
      a = a * vLayer.x + vLayer.y;
      #ifdef MAT_MASK_CLAMP
        a = saturate( a );
      #endif
      return a;
    }
  #endif
`;

/** The defines for a material's alpha mask, if it has one. */
function maskSetup(mat: ModelMaterial, tex: LayerTextures, defines: Record<string, string>) {
  const layer = mat.layers.alphaMask;
  if (!tex.alphaMask || !layer) return;
  defines.MAT_MASK = '';
  defines.MAT_MASK_PICK = MASK_PICK[layer.colorChannels] ?? 't.a';
  if (layer.invert) defines.MAT_MASK_INVERT = '';
  if (layer.clamp) defines.MAT_MASK_CLAMP = '';
  if (layer.uvSource === 1) defines.MAT_MASK_UV1 = '';
}

/** Dissolve: corpses break up into noise instead of popping out of existence. */
const FX_DISSOLVE = /* glsl */ `
  if ( vFx.z > 0.0 ) {
    vec2 cell = floor( gl_FragCoord.xy * 0.5 );
    float n = fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    if ( n < vFx.z ) discard;
  }
`;

export interface MaterialOptions {
  /** Skin an instanced crowd from this baked bone texture. */
  crowd?: THREE.Texture;
  /** With `crowd`: each instance's layer values, baked per frame and material (see Crowd). */
  crowdLayers?: THREE.Texture;
  /** The effects uniform of a lone instance (defaults to a shared zero vector). */
  fx?: THREE.Vector4;
}

/**
 * The material's layer values: an animated material in a crowd reads its own column of the
 * crowd's texture; any other holds them in a uniform, kept in `userData.layer` for a lone
 * instance to update.
 */
function layerSetup(m: THREE.Material, anim: LayerAnim, column: number, opts: MaterialOptions, defines: Record<string, string>) {
  const value = layerValues(anim, null, 0, new THREE.Vector4());
  m.userData.layer = value;
  if (opts.crowd && opts.crowdLayers && anim.animated) {
    defines.MAT_LAYER_CROWD = '';
    defines.MAT_LAYER_COLUMN = String(column);
  }
  return value;
}

const NO_FX = new THREE.Vector4();

/**
 * Tank treads scroll their textures as the tank moves, each side on its own so a tank
 * turning in place runs its treads in opposite directions. Direction xy, side z. A layer's
 * offset is meant to be taken away from its UVs (a tank model's Walk keys the tread offset
 * rising as it drives forward, and the tread's V runs the way a forward-rolling track moves),
 * so the scroll is negative: each tread's value is how far that tread has rolled forward.
 */
function scrollDirection(mat: ModelMaterial): THREE.Vector3 {
  if (!/tread/i.test(mat.name)) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(0, -1, /(_|\b)r\d*$|right/i.test(mat.name) ? 1 : 0);
}

/**
 * The model format's standard material, approximated with Phong lighting. Changes to the stock
 * shader: the diffuse alpha channel is the team-color mask (for RGBA layers), normal maps keep X in alpha and Y
 * in green, a decal layer can sit over the diffuse, an alpha mask cuts out holes (below the
 * material's threshold, as an alpha test does), and the per-instance effects above.
 * With `crowd`, it also skins instanced crowds from baked animation.
 */
function standardMaterial(mat: ModelMaterial, tex: LayerTextures, team: THREE.Color, opts: MaterialOptions, anim: LayerAnim, column: number): THREE.Material {
  const translucent = anim.kind === 'translucent';
  const emissiveLayer = mat.layers.emissive;
  const m = new THREE.MeshPhongMaterial({
    map: tex.diffuse ?? null,
    specularMap: tex.specular ?? null,
    normalMap: tex.normal ?? null,
    emissiveMap: tex.emissive ?? null,
    emissive: tex.emissive ? 0xffffff : 0x000000,
    emissiveIntensity: tex.emissive ? THREE.MathUtils.clamp(emissiveLayer?.multiply.value || 1, 0.5, 3) : 1,
    specular: 0xb0b0b0,
    shininess: 24,
    side: mat.flags & TWO_SIDED ? THREE.DoubleSide : THREE.FrontSide,
  });
  const defines: Record<string, string> = {};
  if (opts.crowd) defines.MAT_CROWD = '';
  if (tex.decal) {
    defines.MAT_DECAL = '';
    if ((mat.layers.decal?.uvSource ?? 0) >= 1) defines.MAT_DECAL_UV1 = '';
  }
  maskSetup(mat, tex, defines);
  if (mat.gain !== undefined) defines.MAT_GAIN = mat.gain.toFixed(4);
  if (mat.rgbNormal) defines.MAT_RGB_NORMAL = '';
  // The diffuse alpha is a team-color mask only when the layer uses its alpha (RGBA channels);
  // story characters' skin and a tank's treads keep their own color.
  if (!translucent && mat.layers.diffuse?.colorChannels === 1) defines.MAT_TEAM = '';
  if (translucent) {
    // A see-through solid (an ore crystal, a Lantern's gas sacs): its mask is how much
    // shows, and it's glossy (standing in for an environment reflection).
    defines.MAT_TRANSLUCENT = '';
    m.transparent = true;
    m.depthWrite = true;
    m.shininess = 70;
    m.specular.setHex(0xffffff);
  }
  const layer = layerSetup(m, anim, column, opts, defines);
  m.defines = defines;
  const fx = opts.fx ?? NO_FX;
  const scroll = scrollDirection(mat);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.teamColor = { value: team };
    shader.uniforms.diffuseBoost = materialSettings.diffuseBoost;
    shader.uniforms.teamBoost = materialSettings.teamBoost;
    shader.uniforms.heroFx = { value: fx };
    shader.uniforms.uvScroll = { value: scroll };
    shader.uniforms.layerAnim = { value: layer };
    shader.uniforms.maskCutout = { value: mat.cutout };
    if (tex.decal) shader.uniforms.decalMap = { value: tex.decal };
    if (tex.alphaMask) shader.uniforms.alphaMaskMap = { value: tex.alphaMask };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FX_VERTEX}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${FX_UV}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 teamColor;
        uniform float diffuseBoost;
        uniform float teamBoost;
        varying vec4 vFx;
        varying vec4 vLayer;
        #ifdef MAT_DECAL
          uniform sampler2D decalMap;
          varying vec2 vDecalUv;
        #endif
        ${MASK_FRAGMENT}`,
      )
      .replace(
        '#include <map_fragment>',
        `${FX_DISSOLVE}
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          #ifdef MAT_GAIN
            vec3 base = sampledDiffuseColor.rgb * diffuseBoost * MAT_GAIN * vLayer.z;
          #else
            vec3 base = sampledDiffuseColor.rgb * diffuseBoost * vLayer.z;
          #endif
          #ifdef MAT_DECAL
            vec4 decal = texture2D( decalMap, vDecalUv );
            base = mix( base, decal.rgb * diffuseBoost, decal.a );
          #endif
          #if defined( MAT_TRANSLUCENT )
            diffuseColor.rgb *= base;
            #ifdef MAT_MASK
              diffuseColor.a *= layerMask();
            #else
              // The diffuse alpha runs low (about 0.1 to 0.4): lifted so the solid reads as one.
              diffuseColor.a *= saturate( sampledDiffuseColor.a * 2.4 + 0.15 );
            #endif
          #elif defined( MAT_TEAM )
            vec3 tinted = teamColor * ( teamBoost + base );
            diffuseColor.rgb *= mix( tinted, base, sampledDiffuseColor.a );
          #else
            diffuseColor.rgb *= base;
          #endif
        #endif
        #if defined( MAT_MASK ) && !defined( MAT_TRANSLUCENT )
          // An opaque surface is cut out where its mask falls below the material's threshold.
          if ( layerMask() < maskCutout ) discard;
        #endif`,
      )
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `#ifdef MAT_RGB_NORMAL
          // An ordinary (OpenGL, green-up) map: its Y flips against the tangent frame the
          // derivatives of these UVs give (V runs down the image), as three's own glTF loader does.
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          mapN.y = -mapN.y;
        #else
          vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).ag * 2.0 - 1.0, 0.0 );
          mapN.z = sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) );
        #endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        // A hit flash that brightens the model without washing out its shape.
        gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * 0.7 + vec3( 1.0, 0.86, 0.62 ) * 0.85, vFx.x * 0.6 );`,
      );
    if (opts.crowd) {
      shader.uniforms.crowdBones = { value: opts.crowd };
      if (opts.crowdLayers) shader.uniforms.crowdLayers = { value: opts.crowdLayers };
      shader.vertexShader = injectCrowdSkinning(shader.vertexShader, true);
    }
  };
  return m;
}

/**
 * Glows, energy, smoke and other blended layers: unlit, not writing depth. Additive layers
 * add their color; alpha layers take opacity from the diffuse alpha or the alpha mask.
 */
function effectMaterial(mat: ModelMaterial, tex: LayerTextures, opts: MaterialOptions, anim: LayerAnim, column: number): THREE.Material {
  const additive = mat.blendMode === BLEND.add || mat.blendMode === BLEND.alphaAdd;
  const modulate = mat.blendMode === BLEND.mod || mat.blendMode === BLEND.mod2x;
  const m = new THREE.MeshBasicMaterial({
    // Glows often have only an emissive layer, and some layers only an alpha mask: whichever
    // texture there is gives the color.
    map: tex.diffuse ?? tex.emissive ?? tex.alphaMask ?? null,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : modulate ? THREE.MultiplyBlending : THREE.NormalBlending,
    premultipliedAlpha: modulate,
    side: mat.flags & TWO_SIDED ? THREE.DoubleSide : THREE.FrontSide,
  });
  const defines: Record<string, string> = {};
  if (opts.crowd) defines.MAT_CROWD = '';
  maskSetup(mat, tex, defines);
  if (mat.blendMode === BLEND.add) defines.MAT_ADD = '';
  if (mat.cutout > 0) defines.MAT_CUTOUT = '';
  const layer = layerSetup(m, anim, column, opts, defines);
  m.defines = defines;
  const fx = opts.fx ?? NO_FX;
  const scroll = scrollDirection(mat);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.heroFx = { value: fx };
    shader.uniforms.uvScroll = { value: scroll };
    shader.uniforms.layerAnim = { value: layer };
    shader.uniforms.maskCutout = { value: mat.cutout };
    if (tex.alphaMask) shader.uniforms.alphaMaskMap = { value: tex.alphaMask };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FX_VERTEX}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${FX_UV}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vFx;
        varying vec4 vLayer;
        ${MASK_FRAGMENT}`,
      )
      .replace(
        '#include <map_fragment>',
        `${FX_DISSOLVE}
        #include <map_fragment>
        diffuseColor.rgb *= vLayer.z;
        #ifdef MAT_MASK
          diffuseColor.a *= layerMask();
        #endif
        #ifdef MAT_ADD
          diffuseColor.a = 1.0;
        #endif
        #ifdef MAT_CUTOUT
          if ( diffuseColor.a < maskCutout ) discard;
        #endif
        diffuseColor.a *= 1.0 - vFx.z;`,
      );
    if (opts.crowd) {
      shader.uniforms.crowdBones = { value: opts.crowd };
      if (opts.crowdLayers) shader.uniforms.crowdLayers = { value: opts.crowdLayers };
      shader.vertexShader = injectCrowdSkinning(shader.vertexShader, false);
    }
  };
  return m;
}

function createMaterial(mat: ModelMaterial, tex: LayerTextures, team: THREE.Color, opts: MaterialOptions, anim: LayerAnim, column: number): THREE.Material {
  // A layer that's a flipbook (an atlas of frames) shows one cell: its own copy of the texture,
  // windowed onto it, so the frame can change per material.
  let flip: { tex: THREE.Texture; rows: number; cols: number } | null = null;
  for (const slot of COLOR_SLOTS) {
    const fb = mat.layers[slot]?.flipbook;
    const t = tex[slot];
    if (!fb || !t) continue;
    const cell = t.clone();
    cell.repeat.set(1 / fb.cols, 1 / fb.rows);
    tex = { ...tex, [slot]: cell };
    flip = { tex: cell, rows: fb.rows, cols: fb.cols };
    setCell(flip, fb.frame.value);
    break;
  }
  // A see-through solid is lit like any surface; other blended layers are glows, smoke and
  // energy, drawn unlit.
  const m = anim.kind === 'effect' ? effectMaterial(mat, tex, opts, anim, column) : standardMaterial(mat, tex, team, opts, anim, column);
  if (flip) m.userData.flipbook = flip;
  return m;
}

function setCell(flip: { tex: THREE.Texture; rows: number; cols: number }, frame: number) {
  const f = Math.max(0, Math.floor(frame)) % (flip.rows * flip.cols);
  flip.tex.offset.set((f % flip.cols) / flip.cols, Math.floor(f / flip.cols) / flip.rows);
}

/** Shows frame `frame` of a material's flipbook layer (rows of the atlas counted from the top). */
export function setFlipbookFrame(material: THREE.Material, frame: number) {
  const flip = material.userData.flipbook as { tex: THREE.Texture; rows: number; cols: number } | undefined;
  if (flip) setCell(flip, frame);
}

/** How many frames a material's flipbook layer has (0 if none). */
export function flipbookFrames(material: THREE.Material): number {
  const flip = material.userData.flipbook as { rows: number; cols: number } | undefined;
  return flip ? flip.rows * flip.cols : 0;
}

/** A layer texture that slides: its own copy of the texture, and the loop that moves it. */
interface UvAnimation {
  tex: THREE.Texture;
  offset: ModelAnim<[number, number]>;
  tiling: ModelAnim<[number, number]>;
  seq: ModelSequence;
}

const animatedTemplates = new Set<ModelTemplate>();

function trackValue(seq: ModelSequence, a: ModelAnim<[number, number]>, time: number, c: number): number {
  const t = seq.tracks.get(a.id);
  if (!t || !t.times.length) return a.value[c];
  const n = t.times.length;
  if (time <= t.times[0]) return t.values[c];
  if (time >= t.times[n - 1]) return t.values[(n - 1) * 2 + c];
  let i = 1;
  while (t.times[i] < time) i++;
  const k = (time - t.times[i - 1]) / Math.max(1e-6, t.times[i] - t.times[i - 1]);
  return t.values[(i - 1) * 2 + c] + (t.values[i * 2 + c] - t.values[(i - 1) * 2 + c]) * k;
}

/**
 * Moves every sliding texture (lava pouring down a fall, energy crawling over the artifact, a
 * Warship's warp lines) to where its model's standing loop has it at `time` seconds.
 * Instances share the motion: these are ambient loops, not tied to what a unit is doing.
 */
export function animateTextures(time: number) {
  for (const template of animatedTemplates) {
    for (const a of template.uvAnimations) {
      const t = a.seq.duration > 0 ? time % a.seq.duration : 0;
      // A layer's offset is meant to be taken away from its UVs (three.js adds it): a lava fall's
      // V runs downhill and its offset rises, so added, the lava ran up the fall.
      a.tex.offset.set(-trackValue(a.seq, a.offset, t, 0), -trackValue(a.seq, a.offset, t, 1));
      a.tex.repeat.set(trackValue(a.seq, a.tiling, t, 0) || 1, trackValue(a.seq, a.tiling, t, 1) || 1);
    }
  }
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/**
 * Whether rotation keys (x, y, z, w quaternions) turn steadily one way about one axis, through a
 * full turn or more: a wheel.
 */
function turnsAround(values: ArrayLike<number>): boolean {
  const n = values.length / 4;
  if (n < 3) return false;
  const a = new THREE.Quaternion();
  const b = new THREE.Quaternion();
  const step = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const first = new THREE.Vector3();
  let total = 0;
  for (let k = 1; k < n; k++) {
    a.fromArray(values as number[], (k - 1) * 4);
    b.fromArray(values as number[], k * 4);
    step.copy(a).invert().multiply(b);
    if (step.w < 0) step.set(-step.x, -step.y, -step.z, -step.w);
    const angle = 2 * Math.acos(Math.min(1, step.w));
    if (angle < 1e-4) continue;
    axis.set(step.x, step.y, step.z).normalize();
    if (total === 0) first.copy(axis);
    // Always the same way round about the same axis.
    else if (axis.dot(first) < 0.97) return false;
    total += angle;
  }
  return total >= Math.PI * 2 * 0.95;
}

/** A bone standing in for another under a batch shown and hidden by a bone's visibility (see withShownBatches). */
interface StandIn {
  bone: number;
  /** The bone whose visibility shows it. */
  shows: number;
}

/**
 * Some batches are drawn only while a bone is visible (`ModelBatch.bone`, the bone's visibility
 * flag): a death model's whole body until the moment it bursts, a Seer's knife only in its
 * Spell, a building's parts as it goes up. Each such batch is skinned here onto
 * stand-ins for the bones it hangs on (a child of each, at no offset) that the clips scale to
 * nothing while it's hidden: so every way a model is drawn (one unit, a baked crowd, frozen
 * scenery) shows and hides it with the animation. Hidden, a stand-in skins with an all-zero
 * matrix (see `hiddenStandIn`): the whole batch folds into one point and draws nothing (scaled
 * about each bone, it would leave slivers between the bones, unlit). A batch always shown is
 * left alone; a vertex other batches draw too gets a copy of its own.
 */
function withShownBatches(data: ModelData): { data: ModelData; standIns: StandIn[] } {
  const keyed = new Set<number>();
  for (const seq of data.sequences) for (const id of seq.tracks.keys()) keyed.add(id);
  const tied = new Set(
    data.batches.filter((b) => {
      const vis = data.bones[b.bone]?.visibility;
      return b.material >= 0 && !!vis && (vis.value === 0 || keyed.has(vis.id));
    }),
  );
  if (!tied.size) return { data, standIns: [] };

  // The bone each vertex is shown by (-1: always); one drawn under two gets copies.
  const vertexCount = data.positions.length / 3;
  const owner = new Int32Array(vertexCount).fill(-2);
  const shared = new Uint8Array(vertexCount);
  for (const b of data.batches) {
    if (b.material < 0) continue;
    const by = tied.has(b) ? b.bone : -1;
    for (let i = b.start; i < b.start + b.count; i++) {
      const v = data.indices[i];
      if (owner[v] === -2) owner[v] = by;
      else if (owner[v] !== by) shared[v] = 1;
    }
  }
  const indices = data.indices.slice();
  const copied: number[] = [];
  const copyOf = new Map<string, number>();
  for (const b of tied) {
    for (let i = b.start; i < b.start + b.count; i++) {
      const v = indices[i];
      if (!shared[v]) continue;
      const key = `${b.bone}:${v}`;
      let c = copyOf.get(key);
      if (c === undefined) copyOf.set(key, (c = vertexCount + copied.push(v) - 1));
      indices[i] = c;
    }
  }
  function grow<T extends Float32Array | Uint16Array>(src: T, width: number): T {
    const out = new (src.constructor as new (n: number) => T)((vertexCount + copied.length) * width);
    out.set(src);
    copied.forEach((v, k) => out.set(src.subarray(v * width, (v + 1) * width), (vertexCount + k) * width));
    return out;
  }
  const skinIndex = grow(data.skinIndex, 4);
  const skinWeight = grow(data.skinWeight, 4);

  const bones = [...data.bones];
  const standIns: StandIn[] = [];
  const standInOf = new Map<string, number>();
  const done = new Uint8Array(vertexCount + copied.length);
  for (const b of tied) {
    const shows = data.bones[b.bone];
    for (let i = b.start; i < b.start + b.count; i++) {
      const v = indices[i];
      if (done[v]) continue;
      done[v] = 1;
      for (let k = 0; k < 4; k++) {
        if (skinWeight[v * 4 + k] <= 0) continue;
        const of = skinIndex[v * 4 + k];
        const key = `${b.bone}:${of}`;
        let n = standInOf.get(key);
        if (n === undefined) {
          n = bones.length;
          const on = shows.visibility.value;
          bones.push({
            name: `${data.bones[of].name} (shown by ${shows.name})`,
            parent: of,
            location: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [on, on, on],
            locationAnim: -1,
            rotationAnim: -1,
            scaleAnim: -1,
            visibility: { id: -1, value: 1 },
          });
          standIns.push({ bone: n, shows: b.bone });
          standInOf.set(key, n);
        }
        skinIndex[v * 4 + k] = n;
      }
    }
  }
  // A stand-in sits where its bone is, so it binds as its bone does.
  const inverseBind = new Float32Array(bones.length * 16);
  inverseBind.set(data.inverseBind);
  for (let n = data.bones.length; n < bones.length; n++) inverseBind.set(data.inverseBind.subarray(bones[n].parent * 16, bones[n].parent * 16 + 16), n * 16);
  return {
    data: {
      ...data,
      bones,
      inverseBind,
      positions: grow(data.positions, 3),
      normals: grow(data.normals, 3),
      uv0: grow(data.uv0, 2),
      uv1: data.uv1 && grow(data.uv1, 2),
      skinIndex,
      skinWeight,
      indices,
    },
    standIns,
  };
}

/** Whether a stand-in bone (see withShownBatches) is hidden now: its clips set its scale to 0 or 1. */
export function hiddenStandIn(bone: THREE.Bone): boolean {
  return bone.scale.x < 0.5;
}

/** A parsed model, ready to be instantiated any number of times. */
export class ModelTemplate {
  readonly data: ModelData;
  /** Its stand-in bones (see withShownBatches): skinned with an all-zero matrix while hidden. */
  readonly standIns: number[];
  readonly clips = new Map<string, THREE.AnimationClip>();
  /** Bounding box of the opaque mesh in the standing pose, model units, Y up. */
  readonly bounds = new THREE.Box3();
  private readonly prototype = new THREE.Group();
  private readonly materialSets = new Map<number, THREE.Material[]>();
  private readonly opaqueGroups: number[] = [];
  /** Layers whose texture slides, and how. */
  readonly uvAnimations: UvAnimation[] = [];
  /**
   * Its wheels: the bones its Walk clip turns one way about one axis, a full turn or more over the
   * loop (a Torchrunner's four), with Walk's own turn for each. They're turned by the distance driven
   * (ModelInstance.roll) rather than by the clip playing, so they stay where they stopped, roll
   * back reversing, and an attack's or a stand's pose doesn't snap them round.
   */
  readonly wheels: { bone: number; times: ArrayLike<number>; values: ArrayLike<number>; duration: number }[] = [];
  /**
   * How fast the model goes at its Walk clip's own rate, feet planted, in meters a second at its
   * own size: an original model says so itself (its Walk animation's `extras.metersPerSecond`);
   * one of the loader's takes it from its unit's data instead (Kind.walkAnim), so it's unset.
   */
  walkSpeed?: number;
  /** Per material: what its layers do over time (see LayerAnim). */
  readonly layerAnims: LayerAnim[];
  /** The materials whose layers some sequence animates. */
  readonly animatedLayers: number[];
  private readonly deathPlans = new Map<string, DeathPlan>();
  private probe: ModelInstance | null = null;

  constructor(
    readonly path: string,
    parsed: ModelData,
    readonly layers: LayerTextures[],
  ) {
    const { data, standIns } = withShownBatches(parsed);
    this.data = data;
    this.standIns = standIns.map((s) => s.bone);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv0, 2));
    if (data.uv1) geometry.setAttribute('uv1', new THREE.BufferAttribute(data.uv1, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(data.skinWeight, 4));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // Opaque batches first, then blended ones (glows, smoke) so they draw over them.
    const ordered = data.batches
      .filter((b) => b.material >= 0)
      .sort((a, b) => Number(data.materials[a.material].blendMode !== 0) - Number(data.materials[b.material].blendMode !== 0));
    for (const b of ordered) {
      if (data.materials[b.material].blendMode === 0) this.opaqueGroups.push(geometry.groups.length);
      geometry.addGroup(b.start, b.count, b.material);
    }

    // Model data is Z-up; the container turns it Y-up.
    const container = new THREE.Group();
    container.rotation.x = -Math.PI / 2;
    const bones = data.bones.map((b, i) => {
      const bone = new THREE.Bone();
      bone.name = `b${i}`;
      bone.userData.sourceName = b.name;
      bone.position.fromArray(b.location);
      bone.quaternion.fromArray(b.rotation);
      bone.scale.fromArray(b.scale);
      return bone;
    });
    data.bones.forEach((b, i) => (b.parent >= 0 ? bones[b.parent] : container).add(bones[i]));
    const inverses = data.bones.map((_, i) => new THREE.Matrix4().fromArray(data.inverseBind, i * 16));
    const mesh = new THREE.SkinnedMesh(geometry, []);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    container.add(mesh);
    container.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
    this.prototype.add(container);

    // Every animated property is meant to be evaluated in every sequence: one the sequence
    // doesn't animate sits at its default value. Three.js would leave it wherever the last
    // clip put it (a burrowing Shellback's debris stuck in its walk, a death pose bleeding into
    // a stand), so each clip gets explicit tracks holding those defaults.
    const animated = new Set<number>();
    for (const seq of data.sequences) for (const id of seq.tracks.keys()) animated.add(id);
    const ZERO = [0];
    for (const seq of data.sequences) {
      const tracks: THREE.KeyframeTrack[] = [];
      data.bones.forEach((b, i) => {
        const loc = seq.tracks.get(b.locationAnim);
        const rot = seq.tracks.get(b.rotationAnim);
        const scl = seq.tracks.get(b.scaleAnim);
        if (loc) tracks.push(new THREE.VectorKeyframeTrack(`b${i}.position`, loc.times, loc.values));
        else if (animated.has(b.locationAnim)) tracks.push(new THREE.VectorKeyframeTrack(`b${i}.position`, ZERO, b.location));
        if (rot) tracks.push(new THREE.QuaternionKeyframeTrack(`b${i}.quaternion`, rot.times, rot.values));
        else if (animated.has(b.rotationAnim)) tracks.push(new THREE.QuaternionKeyframeTrack(`b${i}.quaternion`, ZERO, b.rotation));
        if (scl) tracks.push(new THREE.VectorKeyframeTrack(`b${i}.scale`, scl.times, scl.values));
        else if (animated.has(b.scaleAnim)) tracks.push(new THREE.VectorKeyframeTrack(`b${i}.scale`, ZERO, b.scale));
      });
      // Batches shown by a bone's visibility: on and off in steps, as keyed, or as it starts.
      for (const s of standIns) {
        const vis = data.bones[s.shows].visibility;
        const keys = seq.tracks.get(vis.id);
        const flags = keys ? keys.values : [vis.value];
        const scale = new Float32Array(flags.length * 3);
        flags.forEach((f, k) => scale.fill(f, k * 3, k * 3 + 3));
        tracks.push(new THREE.VectorKeyframeTrack(`b${s.bone}.scale`, keys ? keys.times : ZERO, scale, THREE.InterpolateDiscrete));
      }
      this.clips.set(seq.name, new THREE.AnimationClip(seq.name, seq.duration, tracks));
    }
    const walk = data.sequences.find((x) => x.name === 'Walk');
    if (walk && walk.duration > 0) {
      data.bones.forEach((b, i) => {
        const rot = walk.tracks.get(b.rotationAnim);
        if (rot && turnsAround(rot.values)) this.wheels.push({ bone: i, times: rot.times, values: rot.values, duration: walk.duration });
      });
    }

    // Layers whose texture slides (lava pouring, energy crawling, heat shimmer) get their own
    // copy of the texture, moved by the loop that animates it: the standing one if it does.
    data.materials.forEach((mat, i) => {
      for (const slot of LAYER_SLOTS) {
        const layer = mat.layers[slot];
        const tex = this.layers[i]?.[slot];
        if (!layer || !tex || layer.flipbook) continue;
        const keyed = (s: ModelSequence) => s.tracks.has(layer.uvOffset.id) || s.tracks.has(layer.uvTiling.id);
        const seq = data.sequences.find((s) => /^Stand$/.test(s.name) && keyed(s)) ?? data.sequences.find((s) => /^(GL|Stand)/.test(s.name) && keyed(s)) ?? data.sequences.find(keyed);
        if (!seq) continue;
        const own = tex.clone();
        own.wrapS = own.wrapT = THREE.RepeatWrapping;
        own.needsUpdate = true;
        this.layers[i] = { ...this.layers[i], [slot]: own };
        this.uvAnimations.push({ tex: own, offset: layer.uvOffset, tiling: layer.uvTiling, seq });
      }
    });
    if (this.uvAnimations.length) animatedTemplates.add(this);

    this.layerAnims = data.materials.map((mat, i) => layerAnimOf(mat, meshTextures(mat, this.layers[i] ?? {}), data.sequences));
    this.animatedLayers = this.layerAnims.flatMap((l, i) => (l.animated ? [i] : []));

    this.measure();
  }

  /**
   * How a death clip plays out, measured once: when the opaque pieces stop moving faster than a
   * slow drift (`SETTLED_SPEED`), and when, after that, an opaque surface whole until then
   * starts burning away (its mask losing pixels).
   */
  deathPlan(name: string): DeathPlan {
    const known = this.deathPlans.get(name);
    if (known) return known;
    const clip = this.clips.get(name);
    const seq = this.data.sequences.find((s) => s.name === name) ?? null;
    const duration = clip?.duration ?? 0;
    const plan: DeathPlan = { duration, settled: duration, burn: duration };
    this.deathPlans.set(name, plan);
    if (!clip || !seq || duration <= 0) return plan;

    // The bones the opaque surfaces hang on (helpers and emitter bones may move all along).
    const data = this.data;
    const bones = new Set<number>();
    for (const b of data.batches) {
      if (b.material < 0 || this.layerAnims[b.material].kind !== 'opaque') continue;
      for (let i = b.start; i < b.start + b.count; i++) {
        const v = data.indices[i];
        for (let k = 0; k < 4; k++) if (data.skinWeight[v * 4 + k] > 0) bones.add(data.skinIndex[v * 4 + k]);
      }
    }
    const probe = (this.probe ??= this.instantiate(new THREE.Color(1, 1, 1)));
    probe.mixer.stopAllAction();
    const action = probe.mixer.clipAction(clip);
    action.reset().setLoop(THREE.LoopOnce, 1).play();
    action.clampWhenFinished = true;
    const list = [...bones].map((b) => probe.mesh.skeleton.bones[b]).filter((b) => !!b);
    const step = 0.1;
    const limit = SETTLED_SPEED * Math.max(0.1, this.bounds.max.y - this.bounds.min.y) * step;
    const v = new THREE.Vector3();
    let last: THREE.Vector3[] = [];
    let settled = 0;
    for (let t = 0; t <= duration + 1e-6; t += step) {
      action.time = Math.min(t, duration);
      probe.mixer.update(0);
      probe.object.updateMatrixWorld(true);
      const now = list.map((b) => b.getWorldPosition(v).clone());
      if (last.length && now.some((p, i) => p.distanceTo(last[i]) > limit)) settled = Math.min(duration, t);
      last = now;
    }
    probe.mixer.stopAllAction();

    // The first opaque surface to start burning away after that, having been whole.
    let burn = duration;
    const value = new THREE.Vector4();
    for (const i of this.animatedLayers) {
      const l = this.layerAnims[i];
      if (l.kind !== 'opaque' || !l.mask) continue;
      // Whole: even its darkest pixel clears the cut-out threshold.
      const whole = (t: number) => {
        layerValues(l, seq, t, value);
        return (value.x >= 0 ? l.mask!.lo : l.mask!.hi) * value.x + value.y >= l.cutout;
      };
      if (!whole(settled)) continue;
      for (let t = settled; t < burn; t += 1 / 30) {
        if (!whole(t)) {
          burn = t;
          break;
        }
      }
    }
    plan.settled = Math.min(settled, burn);
    plan.burn = burn;
    return plan;
  }

  /**
   * Animation names that are variants of `base`: "Attack" matches "Attack" and "Attack 01".
   * Models that name an animation differently (the Grenadier fires "Attack Right" and "Attack
   * Left", the Medic heals with "Spell") answer to the common name through their own.
   */
  variants(base: string): THREE.AnimationClip[] {
    const match = (name: string) => {
      const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`, 'i');
      return [...this.clips.values()].filter((c) => re.test(c.name));
    };
    const direct = match(base);
    if (direct.length) return direct;
    for (const alias of CLIP_ALIASES[base] ?? []) {
      const found = alias.flatMap((a) => match(a));
      if (found.length) return found;
    }
    return [];
  }

  /**
   * A new instance. With `own`, it gets materials of its own, so its effects uniform (hit
   * flash, tread scroll, dissolve) is independent of other instances.
   */
  instantiate(team: THREE.Color, own = false): ModelInstance {
    const container = cloneSkinned(this.prototype.children[0]) as THREE.Group;
    let mesh!: THREE.SkinnedMesh;
    container.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    const fx = own ? new THREE.Vector4() : NO_FX;
    mesh.material = own ? this.createSet(team, { fx }) : this.materialsFor(team);
    if (this.standIns.length) {
      // A hidden batch folds into a point (see withShownBatches).
      const skeleton = mesh.skeleton;
      const update = skeleton.update.bind(skeleton);
      const standIns = this.standIns;
      skeleton.update = () => {
        update();
        for (const i of standIns) if (hiddenStandIn(skeleton.bones[i])) skeleton.boneMatrices?.fill(0, i * 16, i * 16 + 16);
      };
    }
    return new ModelInstance(this, container, mesh, fx);
  }

  /**
   * The model frozen in one pose (the first frame of `clip`, or the rest pose) as a plain
   * geometry, skinned on the CPU once: for scenery drawn instanced, thousands at a time.
   * Y-up, in model units, with the same material groups.
   */
  bakeStatic(clip = 'Stand'): THREE.BufferGeometry {
    const probe = this.instantiate(new THREE.Color(1, 1, 1));
    const c = this.variants(clip)[0] ?? [...this.clips.values()][0];
    if (c) probe.mixer.clipAction(c).play();
    probe.mixer.update(0);
    probe.object.updateMatrixWorld(true);
    const skeleton = probe.mesh.skeleton;
    const hidden = new Set(this.standIns.filter((i) => hiddenStandIn(skeleton.bones[i])));
    const mats = skeleton.bones.map((b, i) => (hidden.has(i) ? new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) : new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i])));
    const src = probe.mesh.geometry;
    const pos = src.attributes.position as THREE.BufferAttribute;
    const nrm = src.attributes.normal as THREE.BufferAttribute;
    const si = src.attributes.skinIndex as THREE.BufferAttribute;
    const sw = src.attributes.skinWeight as THREE.BufferAttribute;
    const outPos = new Float32Array(pos.count * 3);
    const outNrm = new Float32Array(pos.count * 3);
    const m = new THREE.Matrix4();
    const e = m.elements;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      e.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const b = mats[si.getComponent(i, k)].elements;
        for (let j = 0; j < 16; j++) e[j] += b[j] * w;
      }
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      // A hidden batch's vertices fold into the origin (applyMatrix4 divides by w: 0 here).
      if (e[15] === 0) p.set(0, 0, 0);
      n.fromBufferAttribute(nrm, i).transformDirection(m);
      if (!Number.isFinite(n.x) || n.lengthSq() === 0) n.set(0, 1, 0);
      outPos.set([p.x, p.y, p.z], i * 3);
      outNrm.set([n.x, n.y, n.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
    g.setAttribute('uv', src.attributes.uv);
    if (src.attributes.uv1) g.setAttribute('uv1', src.attributes.uv1);
    g.setIndex(src.index);
    for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
    g.computeBoundingSphere();
    return g;
  }

  /** Materials for an instanced crowd of this model, skinned from a baked bone texture. */
  crowdMaterials(team: THREE.Color, bones: THREE.Texture, layers: THREE.Texture): THREE.Material[] {
    return this.createSet(team, { crowd: bones, crowdLayers: layers });
  }

  private createSet(team: THREE.Color, opts: MaterialOptions): THREE.Material[] {
    return this.data.materials.map((mat, i) => createMaterial(mat, meshTextures(mat, this.layers[i] ?? {}), team, opts, this.layerAnims[i], i));
  }

  /** What it holds on the graphics card: its geometries and its layers' textures (kept while it's cached: teardown.ts). */
  holdings(): (THREE.BufferGeometry | THREE.Texture)[] {
    const out: (THREE.BufferGeometry | THREE.Texture)[] = [];
    this.prototype.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) out.push(g);
    });
    for (const layer of this.layers) for (const t of Object.values(layer)) if ((t as THREE.Texture | undefined)?.isTexture) out.push(t as THREE.Texture);
    return out;
  }

  /** The shared materials (no skinning needed: works for baked, instanced scenery too). */
  sharedMaterials(team: THREE.Color): THREE.Material[] {
    return this.materialsFor(team);
  }

  private materialsFor(team: THREE.Color): THREE.Material[] {
    const key = team.getHex();
    let set = this.materialSets.get(key);
    if (!set) {
      set = this.createSet(team, {});
      this.materialSets.set(key, set);
    }
    return set;
  }

  /**
   * Measures the opaque mesh in the first frame of "Stand" (or the first animation); a model
   * that is all see-through (an ore field's crystals) by everything it draws.
   */
  private measure() {
    const probe = this.instantiate(new THREE.Color(1, 1, 1));
    const clip = this.variants('Stand')[0] ?? [...this.clips.values()][0];
    if (clip) probe.mixer.clipAction(clip).play();
    probe.mixer.update(0);
    probe.object.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const geometry = probe.mesh.geometry;
    const index = geometry.index!;
    const measured = this.opaqueGroups.length ? this.opaqueGroups : geometry.groups.map((_, i) => i);
    for (const g of measured) {
      const group = geometry.groups[g];
      for (let i = group.start; i < group.start + group.count; i++) {
        probe.mesh.getVertexPosition(index.getX(i), v);
        this.bounds.expandByPoint(v.applyMatrix4(probe.mesh.matrixWorld));
      }
    }
    // Where the head is standing up: a truer measure of a figure's size than its bounds,
    // which a raised weapon or a backpack can stretch.
    const head = probe.attachment('Ref_Head');
    if (head) this.headHeight = head.getWorldPosition(v).y;
  }

  /** Height of the Ref_Head attachment in the Stand pose (model units), or 0. */
  headHeight = 0;

  private standingPoints: Map<string, THREE.Vector3> | null = null;
  /** Where an attachment point is in the first frame of its Stand (model units, the model's own frame), or null. */
  standing(name: string): THREE.Vector3 | null {
    if (!this.standingPoints) {
      const probe = (this.probe ??= this.instantiate(new THREE.Color(1, 1, 1)));
      probe.mixer.stopAllAction();
      const clip = this.variants('Stand')[0] ?? [...this.clips.values()][0];
      if (clip) probe.mixer.clipAction(clip).reset().play();
      probe.mixer.update(0);
      probe.object.updateMatrixWorld(true);
      this.standingPoints = new Map();
      for (const a of this.data.attachments) {
        const bone = probe.mesh.skeleton.bones[a.bone];
        if (bone) this.standingPoints.set(a.name.toLowerCase(), bone.getWorldPosition(new THREE.Vector3()));
      }
      probe.mixer.stopAllAction();
    }
    return this.standingPoints.get(name.toLowerCase()) ?? null;
  }
}

export interface PlayOptions {
  fade?: number;
  loop?: boolean;
  timeScale?: number;
  restart?: boolean;
}

/** One animated copy of a model in the scene. */
export class ModelInstance {
  /** Position, rotate and scale this; it holds the model with Y up and its feet at y = 0 in model units. */
  readonly object = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  private action: THREE.AnimationAction | null = null;
  private actionName = '';

  constructor(
    readonly template: ModelTemplate,
    container: THREE.Group,
    readonly mesh: THREE.SkinnedMesh,
    /** x hit flash, y UV scroll, z dissolve; only independent for instances made with `own`. */
    readonly fx: THREE.Vector4,
  ) {
    this.object.add(container);
    this.mixer = new THREE.AnimationMixer(container);
  }

  get animation(): string {
    return this.actionName;
  }

  /**
   * What's playing, where its animation is split in halves that play clips of their own (a
   * walker the player drives: walkerrig.ts): the model's clip its emitters and layers go by,
   * and where it's at. Null where it plays one clip, its own.
   */
  layered: { clip: string; time: number; loop: boolean; timeScale: number } | null = null;

  /** Whether it was made with materials of its own (so its effects, `fx`, are its own too). */
  get ownMaterials(): boolean {
    return this.fx !== NO_FX;
  }

  /** The clip playing: the variant picked ("Stand 01"), not the base name. */
  get clip(): string {
    return this.layered?.clip ?? this.action?.getClip().name ?? '';
  }

  /** Whether the current animation loops. */
  get looping(): boolean {
    return this.layered ? this.layered.loop : this.action?.loop === THREE.LoopRepeat;
  }

  /** Seconds into the current animation. */
  get time(): number {
    return this.layered?.time ?? this.action?.time ?? 0;
  }

  setTimeScale(scale: number) {
    if (this.action) this.action.timeScale = scale;
  }

  /** Plays an animation by base name; numbered variants ("Attack 01") are picked at random. */
  play(name: string, opts: PlayOptions = {}): THREE.AnimationAction | null {
    const { fade = 0.2, loop = true, timeScale = 1, restart = false } = opts;
    if (name === this.actionName && this.action && !restart) {
      this.action.timeScale = timeScale;
      return this.action;
    }
    const options = this.template.variants(name);
    if (!options.length) return null;
    const action = this.mixer.clipAction(options[Math.floor(Math.random() * options.length)]);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = timeScale;
    action.play();
    if (this.action && this.action !== action && fade > 0) action.crossFadeFrom(this.action, fade, false);
    else if (this.action && this.action !== action) this.action.stop();
    this.action = action;
    this.actionName = name;
    return action;
  }

  /** The bone an attachment point ("Ref_Weapon", "Ref_Head", ...) is attached to. */
  attachment(name: string): THREE.Bone | null {
    const a = this.template.data.attachments.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return a ? this.mesh.skeleton.bones[a.bone] : null;
  }

  update(dt: number) {
    this.mixer.update(dt);
    this.animateLayers();
  }

  /** Its wheels turned to `t` seconds into its Walk (see `ModelTemplate.wheels`), over whatever the clip playing says. */
  roll(t: number) {
    for (const w of this.template.wheels) {
      const bone = this.mesh.skeleton.bones[w.bone];
      if (!bone) continue;
      const at = ((t % w.duration) + w.duration) % w.duration;
      const times = w.times;
      const n = times.length;
      // Between the keys either side of it, turned the short way (as the clip plays it).
      let i = 0;
      while (i < n - 2 && times[i + 1] <= at) i++;
      const span = times[i + 1] - times[i];
      const k = span > 0 ? THREE.MathUtils.clamp((at - times[i]) / span, 0, 1) : 0;
      qa.fromArray(w.values as number[], i * 4);
      qb.fromArray(w.values as number[], (i + 1) * 4);
      bone.quaternion.slerpQuaternions(qa, qb, k);
    }
  }

  /** The current animation's playback rate (negative: playing backwards). */
  get timeScale(): number {
    return this.layered?.timeScale ?? this.action?.timeScale ?? 1;
  }

  /**
   * Plays the layers' animation (a death model burning its body away, glows fading) on an
   * instance with materials of its own; a surface its mask has wholly hidden isn't drawn at
   * all, so it casts no shadow either.
   */
  private animateLayers() {
    const animated = this.template.animatedLayers;
    if (!animated.length || !this.ownMaterials || !Array.isArray(this.mesh.material)) return;
    const name = this.clip;
    const seq = this.template.data.sequences.find((s) => s.name === name) ?? null;
    for (const i of animated) {
      const m = this.mesh.material[i];
      const value = m?.userData.layer as THREE.Vector4 | undefined;
      if (!value) continue;
      layerValues(this.template.layerAnims[i], seq, this.time, value);
      m.visible = value.w > 0;
    }
  }
}

/** Fallback names for common animations, tried in order (each entry's names are pooled). */
const CLIP_ALIASES: Record<string, string[][]> = {
  Attack: [['Attack Right', 'Attack Left'], ['Attack Superior', 'Attack Inferior'], ['Spell']],
  Stand: [['Stand Ready'], ['Stand Left Ready', 'Stand Right Ready']],
  Walk: [['Walk Slow'], ['Move']],
  Spell: [['Spell A', 'Spell B'], ['Attack']],
  // The Rigger's welding and mining loop is "Work"; the Mender's, "Stand Work".
  'Stand Work': [['Work']],
};
