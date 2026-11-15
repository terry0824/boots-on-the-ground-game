import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** A light grade in linear space before tone mapping: a touch of contrast and saturation, and a vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.32 },
    saturation: { value: 1.08 },
    flash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    uniform float flash;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      // A white-out (a warhead, a Keel Gun at close range) washes everything.
      c.rgb += flash * vec3(1.0, 0.95, 0.85) * 3.0;
      gl_FragColor = c;
    }`,
};

/**
 * The frame's finishing: the scene, then the first-person weapon over it, bloom on what's
 * bright (muzzle flashes, explosions, the Keel Gun, engine glows), a light grade, and tone
 * mapping to the screen. Off at low quality, where the scene is drawn straight.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private scenePass: RenderPass;
  private overlayPass: RenderPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  enabled = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // On high-density screens the pixels are small enough that 2x multisampling does; 4x
    // where they're big. (4x at 2560x1600 costs over 4 ms a frame.)
    const samples = renderer.getPixelRatio() > 1.25 ? 2 : 4;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.scenePass = new RenderPass(scene, camera);
    this.overlayPass = new RenderPass(new THREE.Scene(), camera);
    this.overlayPass.clear = false;
    this.overlayPass.clearDepth = true;
    this.overlayPass.enabled = false;
    // Bloom is soft by nature: a quarter-resolution chain is indistinguishable and a quarter the cost.
    // Only what's brighter than sunlit white blooms: lights, flashes, fire, glows.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.38, 0.55, 1.7);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.overlayPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    // Adding a pass sizes it to the full frame; the bloom chain starts at half of what it's given.
    this.bloom.setSize(size.x / 2, size.y / 2);
  }

  /** The first-person weapon, drawn over the scene with its own camera (or nothing). */
  overlay(scene: THREE.Scene | null, camera: THREE.Camera | null) {
    this.overlayPass.enabled = !!scene;
    if (scene && camera) {
      this.overlayPass.scene = scene;
      this.overlayPass.camera = camera;
    }
  }

  setSize(w: number, h: number) {
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.bloom.setSize((w * ratio) / 2, (h * ratio) / 2);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
