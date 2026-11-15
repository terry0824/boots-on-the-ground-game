// The page: the renderer, the scene and its light, input, audio and the content, kept from mission to mission.
// Moving between the menus and the missions (and restarting one) doesn't reload the page: the address changes
// (the browser's history, so Back and Forward work), the running mission is taken down (session.ts), and the
// next is built in the same page from what's already loaded and compiled: the content's models, sounds and
// maps, the shaders, and with the StarCraft II loader the folder the player opened (which a browser without
// a folder picker can't keep past a reload).

import * as THREE from 'three';
import { initAssets } from '../engine/assets.ts';
import { useProvider } from '../content/provider.ts';
import { MUSIC_NAMES } from '../content/assetnames.ts';
import { musicPaths } from '../content/resolve.ts';
import { Audio } from '../engine/audio.ts';
import { GroundShadows } from '../engine/groundshadows.ts';
import { Input } from '../engine/input.ts';
import { Music } from '../engine/music.ts';
import { particles } from '../engine/particles.ts';
import { PostFX } from '../engine/post.ts';
import { addMissions } from './missions.ts';
import { play, type Page, type Session } from './session.ts';
import { release, watchUploads } from '../engine/teardown.ts';

// Renderer, scene, sky.
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.className = 'game';
document.body.prepend(renderer.domElement);
initAssets(renderer);

const scene = new THREE.Scene();
const FOG = new THREE.Color(0xc9a57f);
scene.fog = new THREE.FogExp2(FOG, 0.0011);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 6000);
const post = new PostFX(renderer, scene, camera);

const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sun: { value: SUN_DIR }, horizon: { value: FOG }, zenith: { value: new THREE.Color(0x6f86a6) }, sunColor: { value: new THREE.Color(1, 0.85, 0.6) } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 sun, horizon, zenith, sunColor; varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, zenith, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sun), 0.0);
        c += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(c, 1.0);
        // Same encoding as the fog the ground fades into, so the horizon has no seam.
        #include <colorspace_fragment>
      }`,
  }),
);
scene.add(sky);
const hemi = new THREE.HemisphereLight(0xe2e8f5, 0x8a6a4a, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 3.1);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 1400;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
/** Soft shadows under the units the shadow map doesn't reach. */
const groundShadows = new GroundShadows(4096);
scene.add(groundShadows.mesh);
// The models' own particle effects: one set of batches for every mission, emptied between them.
scene.add(particles.group);

const asked = new URLSearchParams(location.search);
/** `?test` runs without pointer lock, for automated play-testing. */
const TEST = asked.has('test');
/**
 * What the address set for the whole visit, carried as the game moves between missions, so a reload starts the
 * same way: test mode, the content mode asked for (`?content=`), the loader's test source (`?source=http`).
 */
const CARRIED = ['test', 'content', 'source'].filter((k) => asked.has(k)).map((k) => [k, asked.get(k)!] as const);
const input = new Input(renderer.domElement, TEST);
const audio = new Audio();
// Browsers start audio suspended until the player interacts; the title screen's music starts
// with the first click anywhere.
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});

// The plugin the content mode plays with (the StarCraft II loader), if any: its missions join the game's
// own before anything asks which mission this is.
const content = await useProvider();
if (content) addMissions(content.missions());
const music = new Music(audio, musicPaths(MUSIC_NAMES));
music.preload(['menu', 'calm', 'tension']);

/** The light, sky and haze as the page starts them: each mission sets its planet's over these. */
const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;
const start = {
  fog: FOG.clone(),
  sunDir: SUN_DIR.clone(),
  sunColor: sun.color.clone(),
  sunIntensity: sun.intensity,
  sky: hemi.color.clone(),
  ground: hemi.groundColor.clone(),
  hemi: hemi.intensity,
  zenith: (skyUniforms.zenith.value as THREE.Color).clone(),
  skySun: (skyUniforms.sunColor.value as THREE.Color).clone(),
  grade: Object.fromEntries(Object.entries(post.grade.uniforms).map(([k, u]) => [k, u.value])) as Record<string, unknown>,
};
/** What the scene holds for every mission: the sky, the lights, the ground shadows, the particles. */
const lasting = new Set(scene.children);
/** The page's own elements (the canvas, the HUD's root): anything else a mission put in the body goes with it. */
const pageElements = new Set(Array.from(document.body.children));
const hudRoot = document.getElementById('hud')!;

/** The page as it was before any mission: the scene emptied of the last one, its light and HUD gone. */
function clearPage() {
  renderer.setAnimationLoop(null);
  audio.hush();
  input.unlock();
  const gone = scene.children.filter((o) => !lasting.has(o));
  for (const o of gone) scene.remove(o);
  release(gone);
  particles.clear();
  FOG.copy(start.fog);
  (scene.fog as THREE.FogExp2).color.copy(start.fog);
  (scene.fog as THREE.FogExp2).density = 0.0011;
  SUN_DIR.copy(start.sunDir);
  sun.color.copy(start.sunColor);
  sun.intensity = start.sunIntensity;
  hemi.color.copy(start.sky);
  hemi.groundColor.copy(start.ground);
  hemi.intensity = start.hemi;
  (skyUniforms.zenith.value as THREE.Color).copy(start.zenith);
  (skyUniforms.sunColor.value as THREE.Color).copy(start.skySun);
  sky.visible = true;
  sky.position.set(0, 0, 0);
  for (const [k, v] of Object.entries(start.grade)) post.grade.uniforms[k].value = v;
  camera.fov = 74;
  camera.updateProjectionMatrix();
  hudRoot.innerHTML = '';
  for (const el of Array.from(document.body.children)) if (!pageElements.has(el) && el.tagName !== 'SCRIPT') el.remove();
  document.body.classList.remove('cinema', 'nocursor');
  delete document.body.dataset.mode;
  input.onLockRefused = null;
  input.onLeave = null;
  input.muted = false;
  input.consume();
  renderer.setRenderTarget(null);
  renderer.clear();
}

const page: Page = {
  renderer, scene, camera, post, sky, hemi, sun, SUN_DIR, FOG, groundShadows, input, audio, music, content,
  go(query) {
    const q = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    for (const [k, v] of CARRIED) q.set(k, v);
    const search = q.toString().replace(/=(&|$)/g, '$1');
    try {
      history.pushState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    } catch {
      // A page that can't change its address (some browsers' file:// pages): the mission starts all the same.
    }
    void open(q);
  },
  restart() {
    void open(wanted ?? new URLSearchParams(location.search));
  },
};
// Back and Forward move between the missions and the menus the player has been to, as the pages they were.
window.addEventListener('popstate', () => void open(new URLSearchParams(location.search)));

let session: Session | null = null;
/** The running mission's life: its listeners and timers end with it, and with one that couldn't be built. */
let life = new AbortController();
/** The mission asked for last, and whether one is being built (a request meanwhile waits for it, then replaces it). */
let wanted: URLSearchParams | null = null;
let building = false;
let again = false;

/** Takes down the running mission and builds the one `params` asks for. The first one's failure is the caller's. */
async function open(params: URLSearchParams, first = false) {
  wanted = params;
  if (building) {
    again = true;
    return;
  }
  building = true;
  try {
    do {
      again = false;
      session?.stop();
      session = null;
      life.abort();
      clearPage();
      watchUploads();
      life = new AbortController();
      try {
        session = await play(page, wanted, life.signal);
      } catch (e) {
        life.abort();
        if (first && !again) throw e;
        console.error(e);
        failed(e as Error);
      }
      first = false;
    } while (again);
  } finally {
    building = false;
  }
}

/** A mission that couldn't be built: why, and the way back to the menus. */
function failed(e: Error) {
  hudRoot.innerHTML = `<div class="overlay show"><div class="card panel"><h1>COULDN'T START</h1><p></p><div class="col"><button class="cta">Back to the menus</button></div></div></div>`;
  hudRoot.querySelector('p')!.textContent = e.message;
  hudRoot.querySelector('button')!.onclick = () => page.go({});
}

await open(new URLSearchParams(location.search), true);
