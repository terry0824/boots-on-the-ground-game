import * as THREE from 'three';
import { contentMode, usesInstall } from '../content/mode.ts';
import { loadPack, packUrl } from '../content/pack.ts';
import { loadContentModel, packTexture, soundUrls } from '../content/resolve.ts';
import type { Battlefield, ContentProvider } from '../content/provider.ts';
import { ANIMATION_NAMES, MODEL_NAMES, SOUND_NAMES, UNLEASHED_MODEL_NAMES, UNLEASHED_SOUND_NAMES } from '../content/assetnames.ts';
import { groundTexture, loadImageTexture, type GroundName } from '../content/textures.ts';
import { type ModelData } from '../engine/modeldata.ts';
import { Audio } from '../engine/audio.ts';
import { Effects } from '../engine/effects.ts';
import { particles } from '../engine/particles.ts';
import { Music } from '../engine/music.ts';
import { PostFX } from '../engine/post.ts';
import { synthesize } from '../engine/synth.ts';
import { Input } from '../engine/input.ts';
import { GroundShadows } from '../engine/groundshadows.ts';
import { animateTextures, type ModelTemplate } from '../engine/model.ts';
import { Terrain, type Ground } from '../engine/terrain.ts';
import type { Avatar, PlayerStats } from './avatar.ts';
import { Warship, WarshipAvatar } from './warship.ts';
import { CrawlBrain, type Squad } from './brains.ts';
import { CallIns } from './callins.ts';
import { EchoSquad, type EchoId } from './echo.ts';
import { Attract } from './attract.ts';
import { applyUpgrades, bunkerRangeBonus } from './armory.ts';
import { CameraDirector, lookAtPose, view } from './camera.ts';
import { CommandView, type Possessable } from './command.ts';
import type { Entity, Unit } from './entity.ts';
import { Frontend } from './frontend.ts';
import { Hud } from './hud.ts';
import { buildKinds, KIND_DEFS, RANGE_METERS_PER_CELL } from './kinds.ts';
import { FASTER, type Stats } from './stats.ts';
import type { AnimationName, ModelName, SoundName } from '../content/assetnames.ts';
import { TrooperArms } from './trooperarms.ts';
import { TrooperAvatar, type InfantryData } from './trooper.ts';
import { DIFFICULTY, fallbackMission, MISSIONS, missionById, sizeFor } from './missions.ts';
import { loadProfile, rankOf, rankProgress, RANKS, record, saveProfile, type Settings } from './profile.ts';
import { MAP, Mission, baseMask, farHeight, terrainHeight } from './mission.ts';
import { buildMinimap } from './minimap.ts';
import { CLASSES, classById } from './classes.ts';
import { loadIcons } from './icons.ts';
import { defaultEnvironment } from './environment.ts';
import { mapLayout, proceduralLayout, type Layout } from './layout.ts';
import { Score } from './score.ts';
import { LOOK, Ultimate, UNIT_ULTIMATES, type UltimateId } from './ultimate.ts';
import { Soundscape } from './soundscape.ts';
import { crew, isTank, TankAvatar } from './tank.ts';
import { drivable, tuneMachines, VehicleAvatar, VEHICLES } from './vehicle.ts';
import { Viewmodel } from './viewmodel.ts';
import { ARMS, ArmsViewmodel, type ArmsDef } from './armsview.ts';
import { PortraitView } from './portrait.ts';
import { walkableNear, type ScriptHost } from './script.ts';
import { DEFAULT_RESPAWN, Respawn } from './systems/respawn.ts';
import { useMorphData } from './systems/morph.ts';
import { holdOf, useTransportData } from './systems/transport.ts';
import { cast as castUnitUltimate } from './systems/ultimates.ts';
import { RideAvatar } from './ride.ts';
import { unleash } from './experimental/unleashed/power.ts';
import { drawVitals } from './vitals.ts';
import { World } from './world.ts';

/** How long the screen shows static before rising to command. */
const SIGNAL_LOST_SECONDS = 1.6;
/** The kill feed's name for a kind whose id isn't its name (a braced Howitzer is a Howitzer). */
const NAMES: Record<string, string> = { HowitzerBraced: 'Howitzer' };
const nameOf = (e: Entity) => e.name ?? NAMES[e.kind.def.dataId] ?? e.kind.def.dataId;

/** What a mission plays inside: the page's renderer, scene and lights, its input and audio, the content, its navigation. */
export interface Page {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  post: PostFX;
  sky: THREE.Mesh;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  SUN_DIR: THREE.Vector3;
  FOG: THREE.Color;
  groundShadows: GroundShadows;
  input: Input;
  audio: Audio;
  /** The score: its pieces stay loaded from mission to mission. */
  music: Music;
  content: ContentProvider | null;
  /** Another mission or the menus, by the address's parameters (test mode kept). */
  go(query: Record<string, string | number>): void;
  /** This mission again from the start (Restart, Retry). */
  restart(): void;
}

/** The stats tables (the campaign's, and with a later campaign's units: `swarm`), the cinematic keys and the synthesized sounds, read once a page. */
const tables = new Map<boolean, Promise<Stats>>();
const animations = new Map<AnimationName, Promise<ModelData | null>>();
let synthesized: ReturnType<typeof synthesize> | null = null;

/** A mission running in the page. */
export interface Session {
  /** Takes the mission down: its sounds, its body's hold on the mouse, its test hook. The page clears the rest. */
  stop(): void;
}

/**
 * One mission (or the menus over their battle) inside the page that stays (main.ts): it builds its world, HUD
 * and battle from what the address asks for, and stop() takes it down again, leaving the page for the next.
 * `life` ends with it, built or not (the page aborts it): its listeners and timers go with it.
 */
export async function play(page: Page, params: URLSearchParams, life: AbortSignal): Promise<Session> {
  const { renderer, scene, camera, post, sky, hemi, sun, SUN_DIR, FOG, groundShadows, input, audio, content } = page;
  const on = { signal: life };
  /** `?test` runs without pointer lock, for automated play-testing. */
  const TEST = params.has('test');
  /**
   * What to play: `?mission=<id>&difficulty=<0-3>`. With no mission, the menus, over a battle
   * on Last Lift's map (`?menu` forces them in test runs). Plain `?test` is Hold the Line, and
   * `?map=<folder>` puts Last Lift's defense on any campaign map.
   */
  const MENU = params.has('menu') || (!params.get('mission') && !TEST && !params.get('map'));
  // After the plugin: it may bring a profile saved by an older version up to date (the StarCraft II loader's
  // names for the classes and upgrades).
  const profile = loadProfile();

  /**
   * Without an install (content mode `original`), only what plays on the procedural battlefield:
   * the menus over Hold the Line, and Hold the Line (the campaign maps come with the plugin).
   */
  const asked = missionById(params.get('mission')) ?? (MENU || params.get('map') ? fallbackMission() : missionById('hold-the-line')!);
  const def = usesInstall || !asked.map ? asked : missionById('hold-the-line')!;
  if (def !== asked) console.info(`[content] ${asked.id} plays on the loader's map: Hold the Line instead (content: ${contentMode})`);
  const difficultyIndex = THREE.MathUtils.clamp(Math.round(Number(params.get('difficulty') ?? 1)) || 0, 0, DIFFICULTY.length - 1);
  const difficulty = DIFFICULTY[difficultyIndex];
  /** `&size=standard|large|epic`, for a mission that offers battle sizes (its default if unasked). */
  const size = sizeFor(def, params.get('size'));
  /** The size, for the briefing's and debrief's line: only where there's a choice of one. */
  const sizeNote = def.rules?.size ? ` · ${size.name}` : '';
  /** Every class and call-in available: test runs, and special operations that don't ask for the campaign. */
  const OPEN = TEST || !!def.allOpen;

  const go = page.go;

  const hud = new Hud(document.getElementById('hud')!);
  // On the way to the menus the loading card is only that: no class to pick, nothing to deploy.
  if (MENU) hud.deployButton.style.display = 'none';
  if (!MENU) {
    hud.briefing({
      kicker: `${def.kind === 'practice' ? 'Practice · Experimental' : def.experimental ? 'Experimental' : def.kind === 'tide' ? 'Special Operation' : def.act === 0 ? 'Survival' : 'Mission'} · ${def.planet} · ${difficulty.name}${sizeNote}`,
      title: def.title,
      speaker: def.briefing.speaker,
      lines: def.briefing.lines,
      objectives: def.objectives.filter((o) => !o.hidden),
      keys: briefingKeys(),
    });
  }

  /** The controls as this mission plays them, for the briefing: what Q calls, the board, what can be driven. */
  function briefingKeys(): [string, string][] {
    const r = def.rules;
    const drive = !!(r?.drive?.vehicles || r?.drive?.aircraft);
    const strike = r?.warship;
    return [
      ['Mouse', 'Aim · left button fires'],
      ['W A S D', 'Move · right button aims down the sights'],
      ['E', drive ? 'Unit ability: cloak, jet pack, siege, land, load, mines' : 'Unit ability: cloak, jet pack, siege'],
      ['Shift · Space', r?.drive?.aircraft ? 'Jolt · jet pack · afterburner' : 'Jolt · jet pack'],
      ['F', drive ? 'Bunker · vehicle or aircraft (F again: out) · revive' : 'Bunker · Howitzer · revive a squadmate'],
      ...(r?.ultimates === 'unit'
        ? ([['Q', 'Your unit’s ultimate, charged by fighting']] as [string, string][])
        : ([['Q', strike ? 'Warhead Strike (a Seer)' : 'Keel Gun on your crosshair (a Seer: Warhead Strike)']] as [string, string][])),
      ...(strike
        ? ([['X', `The Lodestar to your mark${strike.first ? ` (first ready at ${Math.round((strike.first / 60) * 2) / 2} min)` : ''}`]] as [string, string][])
        : []),
      ...(def.kind === 'tide' ? ([['G', 'Requisition: 1–4 picks a building, letters order']] as [string, string][]) : []),
      ...(def.kind === 'practice'
        ? ([
            ['G', 'The range: units, targets, rules'],
            ['Z', 'Recharge your ultimate and the Lodestar'],
          ] as [string, string][])
        : []),
      ['Hold T', 'Call-ins: Skyscan, Mender, Dustoff'],
      ['Wheel out', 'Command view · double-click a unit to take it'],
      ...(r?.unleashed && def.kind === 'tide' ? ([['Space · Enter', 'Skip the opening']] as [string, string][]) : []),
      ['V · Esc', 'First / third person · pause'],
    ];
  }
  /** The shadow map's resolution and its reach around the player on foot, meters, by shadow level. */
  const SHADOW_MAP = [0, 2048, 4096, 4096];
  const SHADOW_REACH = [0, 90, 130, 220];
  let graphics = profile.settings.graphics;

  /** Applies the player's settings: mouse, field of view, mix, quality, accessibility. */
  function applySettings(s: Settings) {
    input.sensitivity = s.sensitivity;
    input.invertY = s.invertY;
    view.fov = s.fov;
    audio.setVolume('master', s.volume.master);
    audio.setVolume('music', 0.42 * s.volume.music);
    audio.setVolume('ambience', 0.55 * s.volume.ambience);
    audio.setVolume('sfx', s.volume.sfx);
    audio.setVolume('weapons', s.volume.sfx);
    audio.setVolume('ui', s.volume.sfx);
    audio.setVolume('voice', s.volume.voice);
    hud.colorblind = s.colorblind;
    const g = s.graphics;
    graphics = g;
    const ratio = [0.75, 1, Math.min(window.devicePixelRatio, 1.5), Math.min(window.devicePixelRatio, 2)][g.resolution] ?? 1;
    if (renderer.getPixelRatio() !== ratio) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      post.setSize(window.innerWidth, window.innerHeight);
    }
    post.enabled = g.effects > 0;
    // Shadows off leaves the soft ground shadows under every unit.
    sun.castShadow = g.shadows > 0;
    const shadow = SHADOW_MAP[g.shadows] ?? 4096;
    if (sun.shadow.mapSize.x !== shadow) {
      sun.shadow.mapSize.set(shadow, shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    particles.density = [0.35, 0.65, 1][g.particles] ?? 1;
    particles.reach = [0.6, 0.8, 1][g.particles] ?? 1;
  }
  applySettings(profile.settings);

  /** The game's own stats table (public/content/original/data/stats.json), where no plugin gives the stats. */
  async function ownNumbers(swarm: boolean): Promise<Stats> {
    try {
      return await (await import('./numbers.ts')).loadNumbers(packUrl('data/stats.json'), { swarm });
    } catch (e) {
      hud.setLoading(0, "This build has no stats table (content/original/data/stats.json): the game can't start without it.");
      throw e;
    }
  }

  async function load() {
    const soundNames: SoundName[] = [...SOUND_NAMES, ...(def.rules?.unleashed ? UNLEASHED_SOUND_NAMES : [])];
    const modelNames: ModelName[] = [...MODEL_NAMES, ...(def.rules?.unleashed ? UNLEASHED_MODEL_NAMES : [])];
    const total = 1 + modelNames.length + soundNames.length + 1;
    let done = 0;
    const tick = (label: string) => hud.setLoading(++done / total, label);

    // The game's own pack (the plugin, if any, is in already).
    await loadPack();
    // A later campaign's numbers (`swarm`), for the units only Unleashed fields.
    const swarm = !!def.rules?.unleashed;
    // The numbers: the plugin's, or the game's own table (content mode `original`).
    // Read once a page, for each table (the page stays from mission to mission: main.ts); nothing writes to it.
    let numbers = tables.get(swarm);
    if (!numbers) tables.set(swarm, (numbers = content ? content.stats({ swarm }) : ownNumbers(swarm)));
    numbers.catch(() => tables.delete(swarm));
    const data = await numbers;
    tick('Game data: units, weapons, effects…');

    // The bodies a battle can't do without: a block figure stands in for any the content has no model for.
    const bodies = new Set<string>([...Object.values(KIND_DEFS).map((d) => d.model), 'rifle', 'warship']);
    const models = {} as Record<ModelName, ModelTemplate>;
    await Promise.all(
      modelNames.map(async (name) => {
        // A model the content doesn't have leaves its unit out rather than stopping the game.
        const m = await loadContentModel(name, bodies).catch((e) => {
          console.warn(`model ${name} unavailable:`, e);
          return null;
        });
        if (m) models[name] = m;
        tick(`Model: ${name}`);
      }),
    );
    // Cinematic keys (first person's grips); without them, the plain viewmodel.
    const anims: Partial<Record<AnimationName, ModelData>> = {};
    await Promise.all(
      ANIMATION_NAMES.map(async (name) => {
        // Read once a page (the rigs only read them). One that won't read leaves its grip out (its rig falls
        // back), not the game.
        let read = animations.get(name);
        if (!read && content) {
          read = content.animation(name).catch((e) => {
            console.warn(`animation ${name} unreadable:`, e);
            return null;
          });
          animations.set(name, read);
        }
        const keys = await read;
        if (keys) anims[name] = keys;
      }),
    );
    // The procedural battlefield's ground: the pack's, the plugin's, or the game's own.
    const ground = async (name: GroundName) => {
      const own = packTexture(`ground/${name}`);
      const t = own ? await loadImageTexture(own, true) : ((await content?.texture(`ground/${name}`)) ?? null);
      return t ?? groundTexture(name);
    };
    const [sandA, sandB, rock, gravel, plating, muzzle, laserBolt] = await Promise.all([
      ground('sandA'),
      ground('sandB'),
      ground('rock'),
      ground('gravel'),
      ground('plating'),
      // Without them, the effects draw their own glow.
      content?.texture('muzzleFlash') ?? null,
      content?.texture('laserBolt') ?? null,
    ]);
    tick('Terrain');
    await Promise.all([
      // Decoded once a page: the audio stays, and so do its sounds.
      ...soundNames.map(async (name) => {
        if (!audio.has(name)) await audio.loadUrls(name, soundUrls(name));
        tick(`Sounds: ${name}`);
      }),
      (synthesized ??= synthesize()).then((layers) => {
        for (const [name, buffers] of Object.entries(layers)) if (!audio.has(name)) audio.add(name, buffers);
      }),
    ]);
    return { data, models, anims, layers: { sandA, sandB, rock, gravel, plating }, muzzle, laserBolt };
  }

  const assets = await load();
  const kinds = buildKinds(assets.data);
  // The Tide: Unleashed's real-world power, under the Armory's research.
  if (def.rules?.unleashed) unleash(kinds);
  // The Armory's research, on every unit of the player's side.
  applyUpgrades(kinds, profile.upgrades);

  /** The mission's campaign map, where there's an install (`?map=` overrides it); none is the procedural plateau. */
  const MAP_NAME = usesInstall ? (params.get('map') ?? def.map) : null;
  /** Meters per map cell: a campaign map at the true scale of the units on it. */
  const CELL = 6;

  let terrain: Ground;
  let layout: Layout;
  let battlefield: Battlefield | null = null;
  if (MAP_NAME && content) {
    battlefield = await content.battlefield(MAP_NAME, { cell: CELL, mission: def, loading: (label) => hud.setLoading(1, label) });
  }
  if (battlefield) {
    terrain = battlefield.terrain;
    layout = mapLayout(battlefield.map, battlefield.terrain);
  } else {
    const t = new Terrain(MAP.size, MAP.segments, terrainHeight, baseMask, assets.layers);
    t.radius = MAP.radius;
    terrain = t;
    layout = proceduralLayout(MAP.ramps);
  }
  scene.add(terrain.mesh);
  if (battlefield?.cliffs) scene.add(battlefield.cliffs);

  // The planet's sky, haze and light, from the tileset's own data.
  const env = content ? await content.environment(battlefield?.map.tileset ?? 'Calder') : defaultEnvironment();
  if (env.sky) {
    sky.visible = false;
    scene.add(env.sky);
  }
  const skyDome = env.sky ?? sky;
  if (env.zenith) {
    // A planet under its own haze (Scoria): a dim sun, tinted by the tileset's key light, through smoke.
    const u = (sky.material as THREE.ShaderMaterial).uniforms;
    u.zenith.value.copy(env.zenith);
    u.sunColor.value.copy(env.sunColor).multiplyScalar(0.35);
  }
  // The tileset's back light: a rim of color from behind (Scoria's lava glow).
  let backLight: THREE.DirectionalLight | null = null;
  if (env.backIntensity > 0) {
    backLight = new THREE.DirectionalLight(env.backColor, env.backIntensity * 0.9);
    backLight.position.copy(env.backDir).multiplyScalar(100);
    scene.add(backLight);
  }
  // A mode's own haze over the map's.
  const haze = def.rules?.haze;
  if (haze) {
    env.fogScale *= haze.density;
    if (haze.color !== undefined) env.fog.lerp(new THREE.Color(haze.color), haze.mix ?? 0.5);
  }
  FOG.copy(env.fog);
  (scene.fog as THREE.FogExp2).color.copy(env.fog);
  SUN_DIR.copy(env.sunDir);
  sun.color.copy(env.sunColor);
  sun.intensity = env.sunIntensity;
  hemi.color.copy(env.skyLight).multiplyScalar(1.6);
  hemi.groundColor.copy(env.groundLight).multiplyScalar(0.6);
  hemi.intensity = env.ambientIntensity;

  /**
   * Night, for missions that have one (Sundown): the day's light blended toward the map's own
   * night light (Fenmoor's moon: the key light at 8%, a cold fill), the haze and sky darkened.
   * 0 is day, 1 is full night.
   */
  const dayLight = {
    sunColor: sun.color.clone(),
    sunIntensity: sun.intensity,
    sunDir: SUN_DIR.clone(),
    sky: hemi.color.clone(),
    ground: hemi.groundColor.clone(),
    hemi: hemi.intensity,
    fog: FOG.clone(),
    back: backLight?.intensity ?? 0,
    backColor: backLight?.color.clone() ?? new THREE.Color(),
    zenith: ((sky.material as THREE.ShaderMaterial).uniforms.zenith.value as THREE.Color).clone(),
  };
  const nightLight = def.night ? (content?.light(def.night) ?? null) : null;
  const nightFog = dayLight.fog.clone().multiplyScalar(0.12).lerp(new THREE.Color(0x0a1420), 0.5);
  function setNight(k: number) {
    k = THREE.MathUtils.clamp(k, 0, 1);
    const n = nightLight;
    sun.color.copy(dayLight.sunColor).lerp(n?.sunColor ?? dayLight.sunColor, k);
    sun.intensity = THREE.MathUtils.lerp(dayLight.sunIntensity, n ? n.sunIntensity : dayLight.sunIntensity * 0.08, k);
    SUN_DIR.copy(dayLight.sunDir).lerp(n?.sunDir ?? dayLight.sunDir, k).normalize();
    hemi.color.copy(dayLight.sky).lerp((n?.skyLight ?? dayLight.sky).clone().multiplyScalar(0.9), k);
    hemi.groundColor.copy(dayLight.ground).lerp((n?.groundLight ?? dayLight.ground).clone().multiplyScalar(0.5), k);
    hemi.intensity = THREE.MathUtils.lerp(dayLight.hemi, dayLight.hemi * 0.42, k);
    if (backLight) {
      backLight.intensity = THREE.MathUtils.lerp(dayLight.back, (n?.backIntensity ?? 0) * 0.9, k);
      backLight.color.copy(dayLight.backColor).lerp(n?.backColor ?? dayLight.backColor, k);
    }
    FOG.copy(dayLight.fog).lerp(nightFog, k);
    (scene.fog as THREE.FogExp2).color.copy(FOG);
    const u = (sky.material as THREE.ShaderMaterial).uniforms;
    (u.zenith.value as THREE.Color).copy(dayLight.zenith).lerp(new THREE.Color(0x02040a), k);
    if (env.sky) {
      env.sky.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m?.color) m.color.setScalar(1 - 0.86 * k);
      });
    }
    post.grade.uniforms.saturation.value = THREE.MathUtils.lerp(1.08, 0.82, k);
    post.grade.uniforms.vignette.value = THREE.MathUtils.lerp(0.32, 0.55, k);
  }
  // The mountains run on to the horizon at low detail, so from a Warship's altitude the
  // valley sits inside a range instead of floating in haze. Its grid puts a row of vertices
  // exactly on the map's edge (37.5 m cells, 450 = 12 cells), where both meshes follow
  // farHeight; under the playable map it drops away out of sight, and it's shaded as if it
  // didn't, so the drop doesn't darken the strip along the edge.
  const FAR_SIZE = 9000;
  if (battlefield) {
    // Beyond the map's margin ring, the far land carries on to the horizon in the map's own textures.
    scene.add(battlefield.terrain.far);
  } else {
    const farLand = new Terrain(
      FAR_SIZE,
      FAR_SIZE / 37.5,
      (x, z) => farHeight(x, z) - (Math.max(Math.abs(x), Math.abs(z)) < MAP.size / 2 - 1 ? 150 : 0.6),
      () => 0,
      assets.layers,
      [FAR_SIZE * 0.3, FAR_SIZE * 0.48],
      farHeight,
    );
    scene.add(farLand.mesh);
  }
  const effects = new Effects(scene, camera, assets.muzzle);
  effects.floor = (x, z) => terrain.heightAt(x, z);
  // The models' own particle effects, from their emitters.
  particles.camera = camera;
  particles.ground = (x, z) => terrain.heightAt(x, z);
  /** How bright the scene's light is on smoke and blood, relative to this map's day. */
  const lightLevel = () => hemi.intensity * (hemi.color.r + hemi.color.g + hemi.color.b) * 0.18 + sun.intensity * (sun.color.r + sun.color.g + sun.color.b) * 0.08;
  const dayLevel = lightLevel();
  function lightParticles() {
    const k = lightLevel() / dayLevel;
    particles.light.copy(hemi.color).multiplyScalar(0.55).add(sun.color.clone().multiplyScalar(0.45)).multiplyScalar(k);
    particles.unlit.setScalar(THREE.MathUtils.lerp(1, k, 0.7));
  }
  const world = new World(scene, terrain, effects, audio, kinds, assets.models, MAP.radius);
  // A mode's own story sizes, before anything is drawn at them.
  if (def.rules?.sizes) world.sizes = def.rules.sizes;
  // The minimap's picture of the ground: the map's playable area, or the plateau and its badlands.
  const minimapFrame = (() => {
    if (battlefield) {
      const b = battlefield.map.bounds;
      const nw = battlefield.terrain.toWorld(b.x0, b.y1);
      const se = battlefield.terrain.toWorld(b.x1, b.y0);
      return buildMinimap(terrain, { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z });
    }
    const r = MAP.radius * 1.08;
    return buildMinimap(terrain, { x0: -r, z0: -r, x1: r, z1: r });
  })();
  world.braceTime = assets.data.braceTime();
  // Transformations and transports time and size themselves by the data.
  useMorphData(assets.data);
  // The player's machines as this mode has them (their reach, an aircraft's speed).
  tuneMachines(def.rules?.machines);
  world.tokensBySize = !!def.rules?.tokensBySize;
  useTransportData(assets.data);
  {
    const h = assets.data.campaign.heal();
    world.medicHeal = { rate: h.rate * FASTER, energyPerLife: h.energyPerLife, range: h.range * RANGE_METERS_PER_CELL };
  }
  // Bake the crowds now so the first wave doesn't hitch.
  hud.setLoading(1, 'Baking animations for the crowds…');
  world.prewarm(['hound', 'houndDeath', 'quillback', 'quillbackDeath', 'shellback', 'shellbackDeath', 'tusker', 'tuskerDeath', 'leaper', 'leaperDeath'], 'crawl');
  world.prewarm(['trooper', 'trooperDeath', 'howitzer', 'howitzerMorph', 'howitzerDeath', 'howitzerBracedDeath'], 'holdouts');
  if (battlefield && content) {
    hud.setLoading(1, 'Scenery: placing the map’s doodads…');
    // The scenery's own fires, smoke and lights run with the battle.
    world.timed.push(...(await content.doodads(scene, battlefield, world.scaleOf('barracks'))));
  }
  const mission = new Mission(world, layout, def, difficulty, size);
  mission.bunkerBonus = bunkerRangeBonus(profile.upgrades);
  // The mission's own script, by mission: training drills, Saltwell Rising's assault.
  const host: ScriptHost = {
    avatar: () => avatar,
    get ship() {
      return bc;
    },
    input,
    camera,
    mode: () => mode,
    panelChanged: () => syncPanel(),
    get stats() {
      return stats;
    },
    cinematic: (pose) => {
      scriptCamera = pose ? { from: pose.from.clone(), to: pose.to.clone(), fov: pose.fov } : null;
      document.body.classList.toggle('cinema', !!pose);
    },
  };
  host.setSun = (toward, elevation, fill = 1) => {
    SUN_DIR.set(toward.x * Math.cos(elevation), Math.sin(elevation), toward.z * Math.cos(elevation)).normalize();
    dayLight.sunDir.copy(SUN_DIR);
    hemi.intensity *= fill;
    dayLight.hemi = hemi.intensity;
  };
  mission.script = content?.script(def, { mission, host, battlefield, data: assets.data }) ?? null;
  // The crowds this mission fields, baked before it starts.
  for (const p of def.prewarm ?? []) world.prewarm(p.models, p.team);
  // The height flyers fly over, built now rather than at the first one's first move.
  void world.airHeight;
  // Mites and the like, born mid-battle, join the swarm's assault.
  world.events.spawned = (u) => {
    if (u.team === 'crawl') u.setController(new CrawlBrain(u));
  };
  mission.setup();

  // The Warship over the colony: a commander's asset, a call-in, and a ship you can captain.
  const bc = new Warship(world, assets.models.warship, assets.data.keelGun(), kinds.warship);
  // Its batteries fire when it's called in or flown; on their own only where the mission has
  // Warships fighting (All Hands). Behind the menus it's scenery.
  bc.holdFire = MENU || !def.rules?.shipFights;
  // Where the mission has it as a call-in: behind the base between strikes, called in with X from
  // any body, the first time once the rules let it.
  bc.strikeRules = def.rules?.warship ?? null;
  /** Q as each body's own ultimate (The Tide: Unleashed). The Lodestar, where it's a call-in, is on X from any body. */
  const unitUltimates = def.rules?.ultimates === 'unit';
  if (bc.strikeRules) bc.callKey = 'X';
  if (bc.strikeRules?.first) bc.rechargeLeft = bc.strikeRules.first;
  // Its batteries' bolts: the game's laser texture, with the missile's own glowing head.
  bc.boltLook = { texture: assets.laserBolt, head: assets.models.bcMissile ?? null };
  const viewmodel = new Viewmodel(assets.models.rifle, assets.muzzle);
  /**
   * First person through the soldier's own arms (armsview.ts), made on first use for each body's
   * model; the Trooper's hold the RK-4. A body whose model the rig can't read gets the rifle alone.
   */
  const armsViews = new Map<string, ArmsViewmodel | null>();
  let trooperArms: TrooperArms | null | undefined;
  function viewmodelFor(a: TrooperAvatar): Viewmodel | ArmsViewmodel | TrooperArms {
    if (a.cls.id === 'trooper') {
      if (trooperArms === undefined) {
        const { trooperGrip, rifleGrip } = assets.anims;
        const rig = assets.models.smTrooper && trooperGrip && rifleGrip ? new TrooperArms(assets.models.smTrooper, trooperGrip, rifleGrip, viewmodel) : null;
        trooperArms = rig?.ok ? rig : null;
      }
      if (trooperArms) return trooperArms.claim();
    }
    const own = a.unit.kind.def.model;
    const listed = ARMS[a.cls.id];
    // The game's own model of it may want a rig of its own (its parts and poses aren't StarCraft II's).
    const def = listed?.own && !listed.model && assets.models[own]?.path.startsWith('glb:') ? listed.own : listed;
    const model = def?.model ?? own;
    let v = def ? armsViews.get(model) : null;
    if (def && v === undefined) {
      // A story-mode character's arms where its model and keys can be had, else the unit's own.
      const rig = (d: ArmsDef, m: ModelName) => {
        const template = assets.models[m];
        const r = template ? new ArmsViewmodel(template, d, 'keys' in d.pose ? assets.anims[d.pose.keys] : undefined) : null;
        return r?.ok ? r : null;
      };
      v = rig(def, model) ?? (def.fallback ? rig(def.fallback, own) : null);
      armsViews.set(model, v);
    }
    if (v) return v.claim();
    // The rifle on its own, back in its own pass.
    if (viewmodel.holder.parent !== viewmodel.scene) viewmodel.scene.add(viewmodel.holder);
    viewmodel.grip = null;
    return viewmodel;
  }
  const director = new CameraDirector(camera);
  const command = new CommandView(world, input, camera, bc, hud.overlay);
  const portrait = new PortraitView();
  /** The objective the HUD is showing, to flash a new one. */
  let shownObjective: string | undefined;
  /** When the radio's last line ends, and when the Dispatch last announced a transmission (game seconds). */
  let radioEnds = -Infinity;
  let announced = -Infinity;
  mission.radio.onLine = (t) => {
    hud.transmit(t.speaker, t.line, t.seconds);
    void portrait.show(t.portrait, t.seconds);
    // "Incoming transmission" opens a conversation after a stretch of quiet, not every line of
    // it (nor more than once a minute); the lines in between key up with a click.
    if (world.time - radioEnds > 20 && world.time - announced > 60) {
      audio.play('transmission', { volume: 0.6, bus: 'voice' });
      announced = world.time;
    } else world.sfx.play('ui.radio');
    radioEnds = world.time + t.seconds;
  };
  // An objective asking for attention (First Muster's reminders): the panel flashes, the hint shows
  // under it, a soft chime.
  mission.onNudge = (hint) => {
    hud.nudge(hint);
    world.sfx.play('ui.nudge');
  };
  // Call-ins: the Skywatch's sweep and Mender, the Lodestar's dropships.
  const callins = new CallIns(
    world,
    () => (OPEN ? Infinity : rankOf(profile.xp)),
    assets.data.orbital(),
    assets.models.comsatScanner ?? null,
    () => (mode === 'ground' ? (avatar?.entity ?? null) : null),
    (e) => e.kind.name === 'artifact',
    def.rules?.callins,
  );
  callins.onMessage = (big, sub) => hud.message(big, sub, 2.5);
  // Echo Squad: the player's own fireteam through the campaign, by name (echo.ts). They join the
  // mission's squad when it has one (Harlan's), the call-ins' otherwise; both follow the body.
  const echo = new EchoSquad(world, mission.radio, (mission.script as { squad?: Squad } | null)?.squad ?? callins.squad);
  let echoPrompt: { prompt: string; progress: number } | null = null;
  /** Seconds since the player deployed. */
  let missionClock = 0;
  /** Head hits this mission, for the citations. */
  let weakHits = 0;
  host.sweeps = () => callins.reveals.length;
  host.orbitalEnergy = (at) => (callins.energy = Math.min(callins.energyMax, Math.max(callins.energy, at)));
  host.chargeUltimate = () => ult.fill();
  host.ultimateCharging = (how) => (ult.charging = how);
  host.possess = (u) => possess(u, 0.5);
  host.setNight = setNight;
  world.prewarm(['dustoff', 'dustoffDeath', 'mender', 'menderDeath', 'howitzer', 'howitzerDeath'], 'holdouts');
  const music = page.music;
  const soundscape = new Soundscape(audio, music);
  const overlay2d = hud.overlay.getContext('2d')!;
  const stats: PlayerStats = { shots: 0, hits: 0, kills: 0, deaths: 0 };
  const infantry: InfantryData = {
    jolt: assets.data.jolt(),
    joltGrenadier: assets.data.jolt('JoltGrenadier'),
    heal: assets.data.campaign.heal(),
    shroud: assets.data.campaign.shroud(),
    warhead: assets.data.campaign.warhead(),
    stagger: assets.data.stagger(),
  };

  type Mode = 'title' | 'menu' | 'ground' | 'command' | 'lost';
  let mode: Mode = 'title';
  let avatar: Avatar | null = null;
  let lastBody: Possessable | null = null;
  let lostAt = 0;
  let lostPosition = new THREE.Vector3();
  let redeployReady = 0;
  /** How long losing a body keeps the player out (the mission's rules; the campaign's six seconds). */
  const respawn = new Respawn({ ...DEFAULT_RESPAWN, ...def.rules?.respawn });
  let started = false;
  let ended = false;
  let orbit = 0;
  /** Esc in the command view (where there's no pointer lock to lose) pauses too. */
  let manualPause = false;
  const attract = new Attract(world, layout, terrain, bc);
  /** Seconds of slowed time after a heavy kill: the hit-stop that gives a kill its weight. */
  let hitStop = 0;
  /** The last thing the Warship's batteries struck while the player was its captain. */
  let batteryTarget: Entity | null = null;
  const score = new Score();
  // The ultimate (Q) charges on what the player earns fighting.
  const ult = new Ultimate();
  score.onTick = (amount, label, kind) => {
    hud.xp(amount, label, kind);
    ult.earn(amount, world.time);
  };
  // The campaign's story around the mission: Echo's voices, and the scene the debrief closes on.
  const story = content?.story(def, mission, echo, {
    get time() {
      return missionClock;
    },
    get wave() {
      return mission.wave;
    },
    status: (id) => mission.status.get(id),
    alive: (id) => echo.slots.some((x) => x.def.id === id && x.state !== 'kia'),
    get bodiesLost() {
      return stats.deaths;
    },
    get inBody() {
      return mode === 'ground' && !!avatar;
    },
    get night() {
      return (mission.script as { night?: number } | null)?.night ?? 0;
    },
    get charge() {
      return mission.meter?.value ?? 0;
    },
    flag: (name) =>
      name === 'calyx' ? !!mission.boss?.unit.alive && !mission.boss.unit.stowed : name === 'loading' ? (mission.script as { stage?: string } | null)?.stage === 'loading' : false,
  }) ?? { update() {}, afterword: () => [] };
  host.reward = (xp, label) => score.objective(xp, label);
  hud.onPickDeploy = (id) => {
    if (!mission.script?.pickDeploy) return;
    mission.script.pickDeploy(id);
    world.sfx.play('ui.click');
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'KeyG' || mode !== 'ground' || isPaused() || e.repeat) return;
      mission.script?.action?.();
      // Inside the key press, so the mouse can be captured again as the panel closes.
      syncPanel();
    },
    on,
  );

  /**
   * A script's panel on the ground that takes the mouse (The Tide's requisition board): the
   * cursor is freed for it and the battle goes on; closing it takes the mouse back.
   */
  function panelOpen(): boolean {
    return mode === 'ground' && started && !ended && !!mission.script?.cursor?.();
  }
  let panelWas = false;
  function syncPanel() {
    const open = panelOpen();
    if (open === panelWas) return;
    panelWas = open;
    if (open) input.unlock();
    else if (!TEST && mode === 'ground' && !ended) input.lock();
  }

  function attachHooks(a: Avatar) {
    const onHit = (e: Entity, killed: boolean, mitigated = false, weakSpot = false) => {
      // Seen, not heard: the hit and the kill sound as the units have them, where they land.
      hud.hitmarker(killed ? 'kill' : weakSpot ? 'weak' : mitigated ? 'armor' : 'hit');
      if (weakSpot) weakHits++;
      if (killed && (e.kind.name === 'tusker' || score.streak >= 4)) hitStop = Math.max(hitStop, 0.07);
    };
    // The ship: the Lodestar called in where the mission has it as a call-in (its own recharge, on
    // X); otherwise its Keel Gun, the body's ultimate (Q), charged by fighting (a Seer's is its warhead).
    const keelGunBar = () => (bc.strikeRules ? bc.callBar() : (ult.bar(bc.keelGunLeft !== null ? { value: 1 - bc.keelGunLeft / bc.prep, text: `Charging ${bc.keelGunLeft.toFixed(1)}s` } : null) ?? bc.callBar()));
    const refused = (why: string) => {
      hud.message(ult.id ? LOOK[ult.id].label.toUpperCase() : 'NO ULTIMATE', why, 1.6);
      world.sfx.play('ui.click', { volume: 0.5 });
    };
    const canUltimate = () => (ult.id ? ult.refusal() : bc.strikeRules ? `Nothing on Q for this unit · ${bc.callKey} calls the Lodestar` : null);
    const spent = (seconds: number) => {
      const id = ult.id;
      ult.spend(world.time, seconds);
      if (id) mission.script?.playerUltimate?.(id, seconds);
    };
    /**
     * Q as the body's own ultimate, where each has its own (systems/ultimates.ts): cast where the
     * player faces and the crosshair is. False if it couldn't be (the reason said on screen).
     */
    const castOwn = (unit: Unit, heading: () => number, point: THREE.Vector3): boolean => {
      const why = canUltimate();
      if (why) {
        refused(why);
        return false;
      }
      const id = ult.id!;
      const r = castUnitUltimate(id, { world, unit, heading, aim: point, jolt: assets.data.jolt(), revive: (at, radius) => echo.reviveNear(at, radius) });
      if (typeof r === 'string') {
        refused(r);
        return false;
      }
      spent(r);
      ultimateActive = { until: world.time + r, seconds: r };
      hud.feed(LOOK[id].label);
      return true;
    };
    /** The ultimate's bar: charging, or how long what it set going has left. */
    const ultBar = (busy?: { value: number; text: string } | null) => {
      const live = ultimateActive && ultimateActive.until > world.time ? ultimateActive : null;
      return ult.bar(busy ?? (live ? { value: (live.until - world.time) / live.seconds, text: `Active · ${Math.ceil(live.until - world.time)}s` } : null));
    };
    /** A call went out: an ultimate's charge is spent, and what the strike kills earns nothing back. */
    const called = () => {
      if (ult.id === 'keelGun') spent(bc.prep + 3);
    };
    if (a instanceof TrooperAvatar) {
      a.onHit = onHit;
      a.keelGunBar = keelGunBar;
      a.canUltimate = canUltimate;
      a.onUltimateRefused = refused;
      a.onUltimate = spent;
      a.ultimateBar = ultBar;
      // Each class's own ultimate on Q, and the Lodestar's bar beside it, where the ship is a call-in of its own (X).
      a.ownUltimate = unitUltimates;
      a.onCast = unitUltimates ? (point) => castOwn(a.unit, () => a.yaw, point) : null;
      a.onShot = () => viewmodelFor(a).shoot();
      a.firstPersonMuzzle = (out) => viewmodelFor(a).muzzleWorld(camera, out);
      a.onKeelGun = (target, point) => {
        if (!callShip(target, point, a.unit)) return false;
        called();
        return true;
      };
      a.onBoard = (vehicle) => possess(vehicle, 0.7, a.unit);
      // A transport overhead with room: aboard it, the player rides where it's going.
      a.canRide = (u) => {
        const hold = holdOf(u);
        return hold && u.team === a.unit.team && hold.fits(a.unit) && !(avatar instanceof VehicleAvatar && avatar.unit === u) ? 'it sets down where it\'s headed' : null;
      };
      a.onRide = (transport) => ride(transport, a.unit);
      a.canBoard = (u) => (isTank(u) ? 'Howitzer' : drivable(u, def.rules?.drive) && !VEHICLES[u.kind.name]?.air ? VEHICLES[u.kind.name]!.label : null);
      // PlanetSide's lesson: support pays. Every life a Medic restores is experience.
      a.onHeal = (amount) => score.objective(Math.round(amount / 2), 'Heal');
      a.onWarheadRefused = (why) => hud.message('WARHEAD', why, 2);
      a.onWarhead = (strike) => {
        hud.message('WARHEAD INBOUND', 'Hold position: keep the laser on target', 3.5);
        strike.onImpact = (killed) => {
          const n = killed.filter((e) => e.team !== 'holdouts').length;
          if (n) score.objective(n * 10, `Warhead · ${n} killed`);
        };
      };
    } else if (a instanceof TankAvatar || a instanceof VehicleAvatar) {
      a.onHit = onHit;
      a.keelGunBar = keelGunBar;
      a.onCall = (point) => {
        const why = canUltimate();
        if (why) {
          refused(why);
          return false;
        }
        // Q as the machine's own, where each body has one.
        if (unitUltimates) return castOwn(a.unit, () => a.yaw, point);
        if (!callShip(null, point, a.unit)) return false;
        called();
        return true;
      };
      a.ultimateBar = unitUltimates ? () => ultBar() : null;
      // What soldiers set down by a transport the player flies do there: the mission's say.
      if (a instanceof VehicleAvatar) a.dropBrain = (u, at) => mission.script?.dropped?.(u, at) ?? null;
      // Its own ability on E, where the mode gives it one.
      if (a instanceof VehicleAvatar) a.special = mission.script?.vehicleSpecial?.(a.unit) ?? null;
      // The soldier who boarded climbs out beside it, and the player is them again.
      a.onExit = (passenger) => {
        const vehicle = a.unit;
        crew.delete(vehicle);
        passenger.stowed = false;
        const side = new THREE.Vector3(-Math.cos(vehicle.yaw), 0, Math.sin(vehicle.yaw)).multiplyScalar(vehicle.radius + passenger.radius + 1.2);
        passenger.position.copy(vehicle.position).add(side);
        passenger.position.y = terrain.heightAt(passenger.position.x, passenger.position.z);
        possess(passenger, 0.6, null, true);
      };
    } else if (a instanceof WarshipAvatar) {
      a.canUltimate = canUltimate;
      a.onUltimateRefused = refused;
      a.onUltimate = spent;
      a.ultimateBar = (busy) => ult.bar(busy);
      bc.onBatteryStrike = (e) => {
        batteryTarget = e;
        score.tag(e, world.time);
      };
      bc.onBatteryHit = (e, killed) => {
        onHit(e, killed);
      };
    }
  }

  /**
   * F: the Lodestar called to a mark (where the mission has it as a call-in), or its Keel Gun at what's
   * there (the campaign's). False if it couldn't be.
   */
  function callShip(target: Entity | null, point: THREE.Vector3, source: Entity | null): boolean {
    if (bc.strikeRules) {
      const why = bc.callIn(point);
      if (why) {
        hud.message('LODESTAR', why, 1.6);
        world.sfx.play('ui.click', { volume: 0.5 });
        return false;
      }
      return true;
    }
    if (!bc.request(target, point, source)) return false;
    hud.message('KEEL GUN', `Locked on ${target ? nameOf(target) : 'position'} · firing in ${bc.prep.toFixed(1)}s`, 2.5);
    return true;
  }
  bc.onStrike = (what) => {
    if (what === 'called') hud.message('LODESTAR INBOUND', 'Snap Jump to your mark: its batteries on everything there', 2.5);
    else if (what === 'leaving') hud.feed(`Lodestar pulling out · back in ${Math.round(bc.strikeRules?.recharge ?? 0)}s`);
  };
  // With the ship selected in the command view, a right-click calls it there (where it's a call-in).
  command.onShipOrder = (point) => {
    if (!bc.strikeRules) return false;
    callShip(null, point, null);
    return true;
  };

  /** The soldiers a body can be: the classes' kinds. */
  const SOLDIERS = new Set(CLASSES.map((c) => c.kind));
  /**
   * Whether the player can take a unit: a soldier, a Howitzer, or a vehicle or aircraft the
   * mission's rules open (vehicle.ts). Anything else (a Rigger, a Torchrunner where vehicles aren't
   * allowed) can be ordered from the command view but not taken.
   */
  function canTake(u: Unit): boolean {
    return SOLDIERS.has(u.kind.name) || isTank(u) || drivable(u, def.rules?.drive);
  }
  command.canTake = canTake;
  const dustoffHeal = assets.data.dustoffHeal();

  /** Takes control of a unit (or the Warship); the camera dives into it. */
  /**
   * The soft ground shadows: under every unit on the ground, or the ones beyond `span` of the
   * shadow map's focus (fading in at its edge), pushed a little away from the sun.
   */
  function groundUnder(focus: THREE.Vector3, span: number) {
    groundShadows.begin();
    for (const e of world.entities) {
      if (!e.alive || e.stowed || e.isBuilding) continue;
      const ground = terrain.heightAt(e.position.x, e.position.z);
      const up = e.position.y - ground;
      if (up > 60) continue;
      const d = Math.hypot(e.position.x - focus.x, e.position.z - focus.z);
      const fade = span > 0 ? THREE.MathUtils.smoothstep(d, span * 0.8, span) : 1;
      if (fade <= 0) continue;
      const lift = up + e.height * 0.5;
      groundShadows.add(e.position.x - SUN_DIR.x * lift * 0.6, ground + 0.08, e.position.z - SUN_DIR.z * lift * 0.6, e.radius * 1.25, 0.5 * fade * (up > 2 ? 0.6 : 1));
    }
    groundShadows.end();
  }

  /**
   * What a body's Q calls as its ultimate: a Seer's warhead; where each body has its own, a Bulwark's or
   * a Behemoth's Lance storm and a Nightjar's carpet bombing (nothing yet for the rest); otherwise the
   * Keel Gun (none where the Lodestar is a call-in with its own recharge).
   */
  function ultimateOf(a: Avatar): UltimateId | null {
    if (a instanceof TrooperAvatar && a.unit.kind.name === 'seer') return 'warhead';
    if (a instanceof WarshipAvatar) return 'keelGun';
    if (unitUltimates) return a.entity ? (UNIT_ULTIMATES[a.entity.kind.name] ?? null) : null;
    return bc.strikeRules ? null : 'keelGun';
  }

  /** What the body's ultimate set going, while it lasts (for its bar). */
  let ultimateActive: { until: number; seconds: number } | null = null;

  /** X: the Lodestar to wherever the crosshair meets the ground, from any body (where it's a call-in). */
  function callLodestar() {
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const hit = world.raycast(origin, dir, 2500, (e) => e.team === 'holdouts');
    if (!hit) {
      hud.message('LODESTAR', 'Mark a spot on the ground', 1.6);
      world.sfx.play('ui.click', { volume: 0.5 });
      return;
    }
    callShip(null, hit.point, avatar?.entity ?? null);
  }

  function possess(target: Possessable, transition = 1.1, passenger: Unit | null = null, keepCharge = false) {
    const previous = avatar;
    avatar = null;
    previous?.release();
    if (target instanceof Warship) avatar = new WarshipAvatar(target, input, world, camera, stats);
    else if (isTank(target)) avatar = new TankAvatar(target, input, world, camera, stats, passenger ?? crew.get(target) ?? null);
    else if (drivable(target, def.rules?.drive)) avatar = new VehicleAvatar(target, input, world, camera, stats, passenger ?? crew.get(target) ?? null, dustoffHeal);
    else avatar = new TrooperAvatar(target, input, world, camera, infantry, stats);
    // The same soldier into a vehicle (or back out of one) keeps the charge; any other body halves it.
    ult.enter(target, ultimateOf(avatar), keepCharge || !!passenger);
    // What the last body's ultimate set going is its own: the new one's bar shows its own charge.
    if (target !== lastBody) ultimateActive = null;
    attachHooks(avatar);
    lastBody = target;
    mode = 'ground';
    command.show(false);
    hud.setMode('ground');
    hud.show('signal', false);
    director.transition(transition);
    input.consume();
    if (!TEST) input.lock();
  }

  /**
   * Aboard a transport someone else flies: the body goes into its hold, the player rides along,
   * and is back in the body wherever it's set down (or loses it with the transport).
   */
  function ride(transport: Unit, body: Unit) {
    const hold = holdOf(transport);
    if (!hold || !avatar || avatar.entity !== body) return;
    const previous = avatar;
    avatar = null;
    previous.release();
    // Nothing of its own to go back to: it's the player's, wherever it's set down.
    body.setController(null);
    if (!hold.load(body)) {
      possess(body, 0.3);
      return;
    }
    const where = () => {
      const brain = transport.controller as { stage?: string } | null;
      return brain?.stage === 'loading' ? '(boarding)' : 'to the drop';
    };
    avatar = new RideAvatar(transport, body, input, world, stats, where);
    lastBody = body;
    director.transition(0.6);
    world.audio.play('dustoffUnload', { at: transport.position, volume: 0.8 });
    hud.feed('Aboard the Dustoff');
  }

  /** Rises from the body to the command view. */
  function toCommand(transition: number, at: THREE.Vector3) {
    const previous = avatar;
    avatar = null;
    previous?.release();
    mode = 'command';
    command.focus(at);
    command.height = 170;
    command.show(true);
    hud.setMode('command');
    hud.show('signal', false);
    director.transition(transition);
    input.consume();
    input.unlock();
  }

  // After a death, until the player has once taken a soldier from the command view: how to get back in.
  const DIVE_TIP = TEST ? 'botg.tip.dive.test' : 'botg.tip.dive';
  function diveTip() {
    try {
      if (localStorage.getItem(DIVE_TIP)) return;
    } catch {
      // No storage: the tip every time.
    }
    hud.message('TAKE A NEW BODY', 'Double-click a soldier (or click one and press P) to fight as it · R deploys a fresh one', 8);
  }
  function learnedDive() {
    try {
      localStorage.setItem(DIVE_TIP, '1');
    } catch {
      // Nowhere to keep it: the tip shows again.
    }
  }

  /** The class the player deploys as: the chosen one, if their rank has unlocked it. */
  function loadout() {
    const c = classById(profile.loadout);
    return OPEN || rankOf(profile.xp) >= c.rank ? c : CLASSES[0];
  }

  /** A fresh soldier of the chosen class, straight under the player's control. */
  function redeploy() {
    if (world.time < redeployReady || mission.phase === 'defeat' || mission.phase === 'victory') return;
    const p = mission.respawnPoint();
    const c = loadout();
    // The mission's say where it has one (the Practice Range: the unit last taken), the chosen class otherwise.
    const u = world.spawnUnit(mission.script?.deployKind?.() ?? c.kind, p.x, p.z, Math.PI);
    possess(u, 1.4);
    const ready: Record<string, Parameters<typeof audio.play>[0]> = { trooper: 'trooperReady', grenadier: 'grenadierReady', seer: 'seerReady', vaulter: 'vaulterReady' };
    const voice = ready[u.kind.name] ?? (SOLDIERS.has(u.kind.name) ? 'trooperReady' : null);
    if (voice) audio.play(voice, { volume: 0.9 });
  }

  // The deploy screen's class picker: command-card icons, unlocked by rank.
  const icons = await loadIcons();
  function refreshClasses() {
    const rank = rankOf(profile.xp);
    hud.classes(
      CLASSES.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        icon: icons[c.id as keyof typeof icons],
        locked: OPEN || rank >= c.rank ? null : RANKS[c.rank].name,
        keys: c.keys,
      })),
      loadout().id,
      // Where the number keys pick the board's buildings, the class is picked by clicking.
      !mission.script?.digits,
    );
  }
  hud.onPickClass = (id) => {
    profile.loadout = id;
    saveProfile(profile);
    world.sfx.play('ui.click');
    refreshClasses();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      // Where the board's number keys pick a building (The Tide), the class is picked by clicking.
      if (mode !== 'command' || !/^Digit[1-6]$/.test(e.code) || mission.script?.digits) return;
      const c = CLASSES[Number(e.code.slice(5)) - 1];
      if (c && (OPEN || rankOf(profile.xp) >= c.rank)) hud.onPickClass?.(c.id);
    },
    on,
  );
  if (!MENU) refreshClasses();
  command.onRedeploy = redeploy;

  world.events.damaged = (e, amount, source) => {
    if (avatar?.entity && source === avatar.entity) {
      score.tag(e, world.time);
      mission.script?.playerDealt?.(e, amount);
    }
    if (avatar instanceof VehicleAvatar && source === avatar.entity && e.alive) {
      stats.hits++;
      avatar.onHit?.(e, false);
    }
    if (avatar && e === avatar.entity) {
      mission.script?.playerDamaged?.(amount, e.maxHp);
      hud.hurt(amount);
      world.sfx.play('ui.hurt', { volume: Math.min(1.2, 0.4 + amount / 12) });
      // Which way the blow came from, relative to where the camera looks.
      if (source) {
        const toward = Math.atan2(source.position.x - e.position.x, source.position.z - e.position.z);
        const view = Math.atan2(camera.getWorldDirection(new THREE.Vector3()).x, camera.getWorldDirection(new THREE.Vector3()).z);
        hud.damageFrom(view - toward, amount);
      }
    }
    else if (e.team === 'holdouts') mission.holdoutsDamaged(e);
  };
  world.events.killed = (e, source) => {
    mission.entityDied(e);
    const byPlayer = (!!avatar?.entity && source === avatar.entity) || (avatar instanceof WarshipAvatar && !source && e === batteryTarget);
    const assists = score.assists;
    score.died(e, byPlayer, world.time);
    if (score.assists > assists) mission.script?.playerAssisted?.(e);
    // Every kill the player makes is counted here, whatever body or weapon made it.
    if (byPlayer && e.team !== 'holdouts') {
      mission.playerKills++;
      stats.kills++;
      mission.script?.playerKilled?.(e);
      if (avatar instanceof VehicleAvatar) avatar.onHit?.(e, true);
    }
    if (avatar && e === avatar.entity) hud.killedBy(source ? `Killed by ${nameOf(source)}` : 'Rerouting to command');
    // A tank's crew goes down with it.
    const passenger = !e.isBuilding ? crew.get(e as Unit) : undefined;
    if (passenger?.alive) passenger.takeDamage(passenger.hp + 1, null);
    if (avatar && e === avatar.entity) {
      loseBody(e);
    } else if (source && avatar && source === avatar.entity) {
      hud.feed(`${nameOf(e)} killed`);
    } else if (e.team === 'holdouts') {
      // In a big battle only losses that matter to you make the feed: structures, and soldiers
      // falling near you.
      const near = avatar?.position ?? command.target;
      if (e.isBuilding || Math.hypot(e.position.x - near.x, e.position.z - near.z) < 45) hud.feed(`${nameOf(e)} lost`);
    }
  };
  /** The player's body is gone (dead, or a squadmate they were in is down): static, then command. */
  function loseBody(e: Entity) {
    stats.deaths++;
    ult.died();
    mission.script?.playerDown?.();
    const previous = avatar;
    avatar = null;
    if (e.alive) previous?.release();
    else previous?.dispose?.();
    mode = 'lost';
    lostAt = performance.now();
    lostPosition = e.position.clone();
    const wait = respawn.died(world.time);
    redeployReady = world.time + wait;
    hud.show('signal', true);
    hud.feed('Signal lost');
    if (wait > respawn.rules.delay) hud.feed(`Back in ${Math.round(wait)}s: deaths close together`);
  }
  echo.onPlayerDown = (u) => {
    hud.killedBy(u.name ? `${u.name} is down · Get ${u.name} back up` : 'Down · Get them back up');
    loseBody(u);
  };
  echo.onRevive = (s, byPlayer) => {
    if (byPlayer) score.objective(75, `${s.def.short} back up`);
  };
  mission.onMessage = (big, sub, seconds) => {
    hud.message(big, sub, seconds);
    if (big === 'WAVE CLEARED') score.objective(100, 'Wave held');
    if (big === 'VICTORY') score.objective(500, 'Mission complete');
  };
  mission.onWave = (_n, big) => soundscape.sting(big ? 'tense' : 'intro');

  // Compile every shader in the scene now (pooled effects included), so nothing stalls mid-fight.
  hud.setLoading(1, 'Compiling shaders…');
  await renderer.compileAsync(scene, camera);
  hud.ready();
  hud.setMode('title');

  function begin() {
    if (started) return;
    started = true;
    mission.start();
    soundscape.start();
    redeploy();
    deployEcho();
  }

  /** Whether a squadmate fell in an earlier mission of the campaign (a replay brings them back). */
  function echoFallen(id: EchoId): boolean {
    const where = profile.echo[id];
    if (!where) return false;
    const order = (m: string) => MISSIONS.findIndex((x) => x.id === m);
    return order(where) < order(def.id);
  }

  /** Echo Squad on the ground beside the player's first body; Briggs's tank on the approach. */
  function deployEcho() {
    const ids = (def.echo ?? []).filter((id) => !echoFallen(id));
    if (!ids.length || !avatar) return;
    const cc = mission.holdfast?.position ?? null;
    let post: THREE.Vector3 | null = null;
    let hold: THREE.Vector3 | null = null;
    if (cc) {
      const lane = mission.layout.lanes[0];
      const toward = lane?.bunker ? new THREE.Vector3(lane.bunker.x, 0, lane.bunker.z) : lane?.spawn ?? avatar.position;
      const dir = new THREE.Vector3(toward.x - cc.x, 0, toward.z - cc.z);
      if (dir.lengthSq() < 1) dir.set(1, 0, 0);
      dir.normalize();
      const r = mission.holdfast!.radius;
      if (ids.includes('briggs')) post = walkableNear(world, cc.clone().addScaledVector(dir, r + 22), 3);
      // In a defense, Echo holds the line at the base's heart rather than chasing the player
      // from bunker to bunker and body to body.
      if (def.kind === 'defense') hold = walkableNear(world, cc.clone().addScaledVector(dir, r + 12), 3);
    }
    echo.deploy(ids, hold ?? avatar.position.clone(), post, hold);
    // In a defense the squad mans the bunker nearest its post.
    if (hold) {
      const shelter = world.buildings
        .filter((b) => b.alive && b.team === 'holdouts' && b.kind.name === 'bunker' && b.position.distanceTo(hold!) < 90)
        .sort((a, b) => a.position.distanceTo(hold!) - b.position.distanceTo(hold!))[0];
      if (shelter) echo.shelter(shelter);
    }
  }

  hud.deployButton.onclick = () => {
    audio.resume();
    world.sfx.play('ui.select');
    hud.show('title', false);
    if (!started) begin();
    else if (mode === 'ground') input.lock();
  };

  // The menus: over a live battle on the campaign's first map, the AI fighting it out.
  let frontend: Frontend | null = null;
  if (MENU) {
    hud.show('title', false);
    hud.setMode('menu');
    mode = 'menu';
    started = true;
    // A battle that never ends: the swarm can't win it and the waves keep coming.
    mission.backdrop();
    mission.start();
    frontend = new Frontend(document.body, profile, {
      launch: (id, d, s) => go({ mission: id, difficulty: d, ...(s ? { size: s } : {}) }),
      settingsChanged: applySettings,
      sound: (kind) => world.sfx.play(`ui.${kind}`),
    });
    frontend.show(true);
    const wake = () => {
      audio.resume();
      soundscape.start();
    };
    window.addEventListener('pointerdown', wake, { once: true, ...on });
    window.addEventListener('keydown', wake, { once: true, ...on });
  }

  hud.button('resume').onclick = () => {
    manualPause = false;
    hud.pauseNote(null);
    hud.show('pause', false);
    if (mode === 'ground') input.lock();
  };
  hud.button('restart').onclick = () => page.restart();
  hud.button('quit').onclick = () => go({});
  document.addEventListener(
    'pointerlockchange',
    () => {
      if (input.reallyLocked) menuDismissed = false;
      pauseShown = isPaused() && !menuDismissed;
      hud.show('pause', pauseShown);
    },
    on,
  );
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !started || ended || MENU) return;
    // Esc calls off whatever the script is in the middle of first (placing a structure), and closes an
    // open panel (the board). The browser won't take the mouse back on Esc (only a click or another key
    // may), so the game waits for a click behind the small "click to resume" line, not the pause menu.
    if (mission.script?.cancel?.()) {
      menuDismissed = true;
      return;
    }
    if (panelOpen()) {
      mission.script?.action?.();
      panelWas = false;
      menuDismissed = true;
      return;
    }
    // Esc on the pause screen (the one that let the mouse go put it up) closes it, and Esc again
    // brings it back; the game goes on at the next click on the battlefield.
    if (mode === 'ground' && !input.freeLook && isPaused()) {
      manualPause = false;
      menuDismissed = !menuDismissed;
      hud.pauseNote(null);
      return;
    }
    // Esc pauses wherever there's no captured mouse to release: the command view, or a browser
    // that wouldn't capture it.
    if (mode === 'command' || input.freeLook) {
      manualPause = !manualPause;
      hud.pauseNote(null);
      hud.show('pause', isPaused());
    }
  }, on);
  // Clicking the battlefield takes the mouse back (after Esc, or a lost capture), and keeps
  // asking while the game plays without it: a refusal may have been only for a moment.
  renderer.domElement.addEventListener('mousedown', () => {
    // A click on the battlefield past an open panel closes it (the click doesn't fire: the body
    // holds fire until the button is let go).
    if (panelOpen()) {
      mission.script?.action?.();
      syncPanel();
      return;
    }
    if (!TEST && started && !ended && !MENU && mode === 'ground' && !input.reallyLocked) input.lock();
  }, on);
  // Some browsers (embedded views, some privacy settings) won't capture the mouse at all. The
  // game goes on in free-look rather than sitting paused: the cursor is hidden over the game,
  // held near an edge it keeps the view turning, and if it leaves the window the game pauses
  // so the player can find it again.
  input.onLockRefused = () => {
    hud.show('pause', isPaused());
    hud.message('MOUSE NOT CAPTURED', 'This browser view can’t hold the mouse. The cursor is hidden while you play: hold it near an edge to keep turning. Esc pauses and shows it.', 6);
  };
  /** Pauses a free-look game the cursor has left (the window's edge, another app). */
  function pauseForCursor(why: string) {
    if (!started || ended || MENU || mode !== 'ground' || !input.freeLook || input.reallyLocked || manualPause) return;
    manualPause = true;
    hud.pauseNote(why);
    hud.show('pause', isPaused());
  }
  input.onLeave = () => pauseForCursor('The mouse left the game window. Resume when you’re ready.');
  window.addEventListener('blur', () => pauseForCursor('The game window lost focus. Resume when you’re ready.'), on);
  /** Whether the pause screen is up, so it follows the game's actual state, whatever paused it. */
  let pauseShown = false;
  /**
   * Esc put the pause screen away, as Esc toggles a game's menu, with the mouse still let go: the
   * game waits for a click to take it back (a browser won't capture the mouse for the Esc key).
   */
  let menuDismissed = false;

  function isPaused(): boolean {
    if (!started || ended || MENU) return false;
    return manualPause || (mode === 'ground' && !input.locked && !panelOpen());
  }

  /** The next campaign mission after this one, if winning this opened it. */
  function nextMission(): string | null {
    return MISSIONS.find((m) => m.requires === def.id)?.id ?? null;
  }

  /**
   * Citations: what the mission recognizes beyond the win. They reward the soldier's craft and
   * the squad's survival, not a body count: the player is one Holdout among many, and the
   * achievement is in what they made possible.
   */
  function cite(squad: number, home: number): { name: string; why: string }[] {
    const out: { name: string; why: string }[] = [];
    const accuracy = stats.shots ? stats.hits / stats.shots : 0;
    if (squad >= 3 && home === squad) out.push({ name: 'Nobody Left Behind', why: 'Every member of Echo came home' });
    if (echo.revives > 0) out.push({ name: 'Lifeline', why: `Got ${echo.revives === 1 ? 'a squadmate' : `${echo.revives} squadmates`} back on their feet` });
    if (stats.deaths === 0 && def.kind !== 'training') out.push({ name: 'Clean Sheet', why: 'Never lost a body' });
    if (stats.shots >= 150 && accuracy >= 0.55) out.push({ name: 'Marksman', why: `${Math.round(accuracy * 100)}% of rounds on target` });
    if (weakHits >= 30) out.push({ name: 'Steady Hand', why: `${weakHits} rounds where it hurts most` });
    if (score.assists >= 12) out.push({ name: 'Spotter', why: `${score.assists} kills set up for the squad` });
    return out;
  }

  /**
   * The debrief: objectives, stars, experience and credits earned, a promotion if one came;
   * everything recorded to the profile.
   */
  function debrief(victory: boolean) {
    const survival = def.kind === 'survival';
    const bonus = def.objectives.filter((o) => o.bonus);
    const bonusDone = bonus.filter((o) => mission.status.get(o.id) === 'done');
    const waves = mission.wave;
    // Stars: the win, then the bonus objectives; a mission without bonuses rates difficulty and
    // staying alive instead. Survival rates how long you lasted.
    const stars = survival
      ? (waves >= 7 ? 1 : 0) + (waves >= 12 ? 1 : 0) + (waves >= 18 ? 1 : 0)
      : !victory
        ? 0
        : bonus.length
          ? 1 + (bonusDone.length * 2 >= bonus.length ? 1 : 0) + (bonusDone.length === bonus.length ? 1 : 0)
          : 1 + (difficultyIndex >= 1 ? 1 : 0) + (stats.deaths === 0 ? 1 : 0);
    const rewards: [string, string][] = [['Field experience', score.xp.toLocaleString()]];
    let xp = score.xp;
    let credits = Math.round(score.xp / 20);
    if (victory) {
      const m = Math.round(def.reward.xp * difficulty.reward);
      rewards.push([`Mission complete (${difficulty.name})`, m.toLocaleString()]);
      xp += m;
      credits += Math.round(def.reward.credits * difficulty.reward);
    }
    if (bonusDone.length) {
      const b = Math.round(bonusDone.length * 250 * difficulty.reward);
      rewards.push([`Bonus objectives (${bonusDone.length}/${bonus.length})`, b.toLocaleString()]);
      xp += b;
      credits += bonusDone.length * 100;
    }
    if (survival && waves) {
      rewards.push([`Waves survived (${waves})`, (waves * 150).toLocaleString()]);
      xp += waves * 150;
      credits += waves * 40;
    }
    // Echo Squad: who came home. A squadmate lost in a mission that was won stays lost for the
    // campaign; winning it again with them alive brings them back.
    const roll = echo.roll();
    const home = roll.filter((m) => m.state !== 'kia').length;
    if (victory) {
      for (const m of roll) {
        if (m.state === 'kia') profile.echo[m.id] = def.id;
        else if (profile.echo[m.id] === def.id) delete profile.echo[m.id];
      }
      if (roll.length) {
        const b = Math.round(home * 150 * difficulty.reward);
        rewards.push([`Echo came home (${home}/${roll.length})`, b.toLocaleString()]);
        xp += b;
        credits += home * 50;
      }
    }
    const citations = victory ? cite(roll.length, home) : [];
    const rec = record(profile, def.id);
    rec.medals = [...new Set([...rec.medals, ...citations.map((c) => c.name)])];

    const rankBefore = rankOf(profile.xp);
    const from = rankProgress(profile.xp);
    profile.xp += xp;
    profile.credits += credits;
    const rankAfter = rankOf(profile.xp);
    const st = profile.stats;
    st.kills += stats.kills;
    st.deaths += stats.deaths;
    st.shots += stats.shots;
    st.hits += stats.hits;
    st.playSeconds += mission.elapsed;
    if (victory) st.missions++;
    const r = record(profile, def.id);
    if (victory) {
      r.completed = true;
      r.difficulty = Math.max(r.difficulty, difficultyIndex);
      r.bestTime = r.bestTime === null ? mission.elapsed : Math.min(r.bestTime, mission.elapsed);
    }
    r.stars = Math.max(r.stars, stars);
    r.bonus = [...new Set([...r.bonus, ...bonusDone.map((o) => o.id)])];
    if (survival) profile.lastStandBest = Math.max(profile.lastStandBest, waves);
    saveProfile(profile);

    const minutes = Math.floor(mission.elapsed / 60);
    const seconds = String(Math.floor(mission.elapsed % 60)).padStart(2, '0');
    hud.debrief({
      victory: victory || survival,
      kicker: victory && def.finale ? `Campaign complete · ${def.title} · ${def.planet} · ${difficulty.name}` : `${def.title} · ${def.planet} · ${difficulty.name}${sizeNote}`,
      title: survival ? `WAVE ${waves}` : victory ? (def.finale ? 'SCORIA IS FREE' : 'VICTORY') : 'DEFEAT',
      sub: survival ? (waves > profile.lastStandBest - 1 && waves === profile.lastStandBest ? 'A new best' : `Best: wave ${profile.lastStandBest}`) : mission.outcome,
      stars,
      objectives: def.objectives.map((o) => ({ text: o.text, bonus: o.bonus, state: mission.status.get(o.id) ?? 'active' })),
      stats: [
        [String(stats.kills), 'Kills'],
        [String(score.assists), 'Assists'],
        [String(score.bestStreak), 'Best streak'],
        [`${stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0}%`, 'Accuracy'],
        [String(stats.deaths), 'Bodies lost'],
        [`${minutes}:${seconds}`, 'Time'],
      ],
      rewards,
      xp,
      credits,
      rankName: RANKS[rankAfter].name,
      promoted: rankAfter > rankBefore,
      rankFrom: rankAfter > rankBefore ? 0 : from,
      rankTo: rankProgress(profile.xp),
      next: victory && !!nextMission(),
      squad: roll.map((m) => ({
        name: m.name,
        state: m.state,
        note: m.state === 'kia' ? 'Killed in action' : m.state === 'down' ? 'Carried out wounded' : m.downs ? `Went down ${m.downs === 1 ? 'once' : `${m.downs} times`}, got back up` : 'Came home',
      })),
      citations,
      story: victory ? story.afterword(echoFallen) : undefined,
    });
    document.querySelectorAll<HTMLElement>('#debrief [data-act]').forEach((b) => {
      b.addEventListener('mouseenter', () => world.sfx.play('ui.hover'));
      b.onclick = () => {
        world.sfx.play('ui.select');
        const act = b.dataset.act;
        if (act === 'retry') page.restart();
        else if (act === 'next') go({ mission: nextMission()!, difficulty: difficultyIndex });
        else go({});
      };
    });
  }

  /**
   * How hard the fight is pressing, 0..1: Crawl close to the player's body, and Crawl inside the
   * base perimeter. Drives the score and the distant-battle ambience.
   */
  function threat(): number {
    if (!started || mission.phase !== 'wave') return 0;
    const near = avatar?.position ?? command.target;
    const cc = mission.holdfast?.position ?? near;
    let close = 0;
    let inside = 0;
    for (const e of world.entities) {
      if (e.team === 'holdouts' || e.ignored || !e.targetable) continue;
      if (e.position.distanceTo(near) < 60) close += e.kind.name === 'tusker' ? 8 : 1;
      if (e.position.distanceTo(cc) < 140) inside += e.kind.name === 'tusker' ? 8 : 1;
    }
    return Math.min(1, Math.max(close / 30, inside / 50));
  }

  /** One frame: simulate `dt` seconds, then (optionally) draw. */
  function frame(dt: number, draw = true) {
    const paused = isPaused();
    // The pause screen, unless Esc put it away (the game still waits for the mouse: a click).
    const menu = paused && !menuDismissed;
    if (menu !== pauseShown) {
      pauseShown = menu;
      hud.show('pause', menu);
    }
    if (!paused) menuDismissed = false;
    hud.show('resumeHint', paused && menuDismissed);
    // A free-look cursor is hidden over the game while it plays (a captured one is anyway).
    document.body.classList.toggle('nocursor', started && !ended && !MENU && !paused && mode === 'ground' && !panelOpen());
    // A panel closed from inside the script (or the body lost): the mouse back to the game.
    if (!panelOpen() && panelWas) syncPanel();
    input.muted = false;
    if (!paused && started) {
      // A panel of the script's that takes the keyboard (The Tide's requisition board, ordered by
      // the classic RTS hotkeys) reads it first; while it does, nothing else this frame reads a key:
      // the body stands, the call-ins and the command view leave them be.
      if (!scriptCamera && mission.script?.keys?.(input)) input.muted = true;
      // Hit-stop: the world nearly freezes for a moment after a heavy kill; the camera doesn't.
      let simDt = dt;
      if (hitStop > 0) {
        hitStop -= dt;
        simDt = dt * 0.12;
      }
      // Free-look (no captured mouse): the cursor held at an edge keeps the view turning.
      const panel = panelOpen();
      if (mode === 'ground' && !input.down('KeyT') && !panel) input.edgeTurn(dt);
      // Before the body reads the mouse: the call-in menu takes it while T is held.
      const onFoot = mode === 'ground' && avatar instanceof TrooperAvatar && avatar.alive && !avatar.garrison ? avatar : null;
      callins.update(dt, input, camera, onFoot);
      // A body the call-ins don't steer holds its fire only until the button is let go.
      if (avatar && avatar !== onFoot) avatar.holdFire = avatar.holdFire && input.mouse(0);
      // An open panel has the mouse: the body neither turns nor fires. A placement has the
      // clicks: the body turns (to aim it) but doesn't fire.
      if (panel) input.consume();
      if (avatar && (panel || mission.script?.placing?.())) avatar.holdFire = true;
      missionClock += simDt;
      if (!MENU) story.update();
      // Where the mission holds Echo (Fenmoor's nights: back to the walls at dusk, with the player at dawn).
      const hold = mission.script?.echoHold?.();
      if (hold !== undefined) echo.holdAt(hold);
      // Downed squadmates, and the player's hands on one (F), before the body takes the key.
      const foot = mode === 'ground' && avatar instanceof TrooperAvatar && avatar.alive ? avatar : null;
      echoPrompt = echo.update(simDt, input, foot && !foot.garrison ? foot.unit : null, foot?.garrison ?? null);
      // X: the Lodestar, from whatever body the player is in, wherever it's a call-in.
      if (bc.strikeRules && mode === 'ground' && avatar && !(avatar instanceof WarshipAvatar) && !panel && input.hit('KeyX')) callLodestar();
      // A scripted shot holds the body still and the mouse out of it.
      if (scriptCamera) input.consume();
      else if (mode === 'ground' && avatar) avatar.tick?.(dt);
      // A body in the fight charges its ultimate a little, even without a kill.
      if (mode === 'ground' && avatar && !(avatar instanceof RideAvatar)) ult.update(simDt, world.time);
      world.player = mode === 'ground' ? (avatar?.entity ?? null) : null;
      world.update(simDt);
      bc.update(simDt);
      mission.update(simDt);
      lightParticles();
      particles.update(simDt);
      animateTextures(world.time);
      if (mode === 'ground' && avatar?.wantsCommand) toCommand(1.3, avatar.position);
      // Set down from a ride: back in the body, wherever the transport put it.
      if (mode === 'ground' && avatar instanceof RideAvatar && avatar.over && avatar.body.alive && !avatar.body.stowed) possess(avatar.body, 0.6);
      if (mode === 'lost' && (TEST || performance.now() - lostAt > SIGNAL_LOST_SECONDS * 1000)) {
        toCommand(TEST ? 0.01 : 1.8, lostPosition);
        diveTip();
      }
      if (mode === 'command') {
        const r = command.update(dt, !mission.script?.placing?.());
        // Where the mission says so, the wait after a death holds for taking over a soldier too
        // (the Warship's bridge is always open).
        const wait = respawn.rules.gateDive && !(r.dive instanceof Warship) ? redeployReady - world.time : 0;
        if (r.dive && wait > 0) {
          hud.feed(`Back in the fight in ${Math.ceil(wait)}s`);
          world.sfx.play('ui.click', { volume: 0.5 });
        } else if (r.dive) {
          possess(r.dive);
          learnedDive();
        }
        else if (r.zoomedIn && lastBody && (lastBody instanceof Warship || lastBody.alive)) possess(lastBody);
      }
      if (!ended && !MENU && (mission.phase === 'victory' || mission.phase === 'defeat')) {
        ended = true;
        const victory = mission.phase === 'victory';
        // A mode that measures itself says how it went, for whoever's tuning it.
        const measured = mission.script?.measured?.();
        if (measured) console.info(`${def.title}: how it played\n${measured.join('\n')}`);
        setTimeout(() => {
          if (life.aborted) return;
          input.unlock();
          debrief(victory);
        }, 3200);
      }
    } else if (!started) {
      world.update(dt);
      bc.update(dt);
      lightParticles();
      particles.update(dt);
      animateTextures(world.time);
    }

    // Camera.
    const pinned = testCamera ?? scriptCamera;
    if (pinned) {
      camera.position.copy(pinned.from);
      camera.lookAt(pinned.to);
      camera.fov = pinned.fov;
      camera.updateProjectionMatrix();
    } else if (mode === 'menu') {
      const pose = attract.pose(dt);
      if (attract.cut) hud.fade(0.7);
      director.apply(dt, pose);
    } else if (mode === 'title') {
      orbit += dt * 0.04;
      camera.position.set(Math.sin(orbit) * 170, 60, Math.cos(orbit) * 170);
      camera.lookAt(0, 20, 0);
      camera.fov = 60;
      camera.updateProjectionMatrix();
    } else if (mode === 'ground' && avatar) {
      director.apply(dt, avatar.cameraPose(dt), effects.shake);
    } else if (mode === 'command') {
      director.apply(dt, command.cameraPose());
    } else if (mode === 'lost') {
      // Drift up from where the body fell while the signal is lost.
      const up = camera.position.clone().add(new THREE.Vector3(0, dt * 6, 0));
      director.apply(dt, lookAtPose(up, lostPosition, camera.fov));
    }

    // Shadows follow whatever the camera is looking at; wider from command height.
    const focus = mode === 'command' ? command.target : avatar?.position ?? lostPosition;
    const reach = SHADOW_REACH[graphics.shadows] ?? 130;
    const span = mode === 'command' ? Math.min(420, command.height * 1.6) * (reach / 130) : avatar instanceof WarshipAvatar ? 380 : reach;
    groundUnder(focus, graphics.shadows > 0 ? span : 0);
    const sc = sun.shadow.camera;
    if (sc.right !== span) {
      sc.left = sc.bottom = -span;
      sc.right = sc.top = span;
      sc.updateProjectionMatrix();
    }
    sun.position.copy(focus).addScaledVector(SUN_DIR, 600);
    sun.target.position.copy(focus);
    skyDome.position.copy(camera.position);
    // Dust hangs low: thick at ground level, thin from the command view and the Warship.
    const altitude = camera.position.y - terrain.heightAt(camera.position.x, camera.position.z);
    (scene.fog as THREE.FogExp2).density = THREE.MathUtils.lerp(0.0011, 0.00028, THREE.MathUtils.smoothstep(altitude, 40, 450)) * env.fogScale;
    audio.setListener(camera);
    soundscape.update(dt, {
      phase: started && !MENU ? mission.phase : 'title',
      wave: mission.wave,
      totalWaves: mission.totalWaves,
      threat: threat(),
      life: mode === 'ground' && avatar?.entity ? avatar.entity.hp / avatar.entity.maxHp : null,
    });

    // HUD.
    const cc = mission.holdfast;
    hud.update(dt);
    const current = mission.script ? def.objectives.find((o) => !o.bonus && mission.status.get(o.id) === 'active' && (!o.hidden || mission.revealed.has(o.id))) : undefined;
    // A new objective flashes its panel (the old one's completion already sounded).
    if (current?.id !== shownObjective) {
      if (shownObjective !== undefined && current && started && !MENU) hud.nudge(null);
      shownObjective = current?.id;
    }
    hud.warbar(!MENU ? ((mission.script as { scoreboard?: Parameters<typeof hud.warbar>[0] } | null)?.scoreboard ?? null) : null);
    if (mode === 'command') hud.deployOptions(mission.script?.deployOptions?.() ?? [], mission.script?.deployChoice ?? '');
    hud.objective({ wave: mission.wave, totalWaves: mission.totalWaves, enemies: mission.enemiesLeft, base: cc ? { hp: cc.hp, max: cc.maxHp, label: mission.baseName } : null, phase: mission.phase, countdown: mission.countdown, status: current?.text });
    hud.meter(MENU ? null : mission.meter);
    hud.callins(!MENU && mode === 'ground' && avatar instanceof TrooperAvatar ? callins.state() : null);
    const boss = mission.boss;
    hud.boss(!MENU && boss && boss.unit.alive && !boss.unit.stowed ? { name: boss.name, sub: boss.sub, hp: boss.unit.hp, max: boss.unit.maxHp } : null);
    hud.objectives(
      `${def.title} · ${def.planet}`,
      def.objectives.filter((o) => !o.hidden || mission.revealed.has(o.id) || mission.status.get(o.id) !== 'active').map((o) => ({
        text: o.id === 'kills' && mission.status.get(o.id) === 'active' ? `${o.text} (${mission.playerKills}/${mission.killsWanted})` : mission.progress.has(o.id) && mission.status.get(o.id) === 'active' ? `${o.text} (${mission.progress.get(o.id)})` : o.text,
        state: mission.status.get(o.id) ?? 'active',
        bonus: o.bonus,
      })),
    );
    if (mode === 'ground' && avatar) {
      const h = avatar.hud();
      if (echoPrompt) h.prompt = echoPrompt.prompt;
      hud.avatar(h, camera.fov, avatar instanceof TrooperAvatar && avatar.joltLeft > 0);
    }
    hud.echo(!MENU && started && (mode === 'ground' || mode === 'lost') ? echo.panel() : null);
    if (mode === 'command') hud.command(command.summary(), redeployReady - world.time, respawn.rules.gateDive);
    command.drawOverlay();
    if (mode === 'ground' && avatar?.drawOverlay) avatar.drawOverlay(overlay2d, hud.overlay.width, hud.overlay.height);
    if (mode === 'ground') drawVitals(overlay2d, camera, world, hud.overlay.width, hud.overlay.height);
    if (mode === 'ground' || mode === 'command') callins.drawOverlay(overlay2d, camera, hud.overlay.width, hud.overlay.height);
    if (mode === 'ground' || mode === 'command') echo.drawOverlay(overlay2d, camera, hud.overlay.width, hud.overlay.height);
    hud.drawMinimap(dt, world, minimapFrame, bc.position, mode === 'command' ? command.target : avatar?.position ?? lostPosition, mode === 'ground' && avatar ? avatar.yaw : null, {
      points: mission.points,
      waypoint: mission.waypoint?.position ?? null,
    });
    // Standing in a capture point: its bar.
    const body = mode === 'ground' ? avatar?.entity : null;
    const inside = body ? mission.points.find((p) => p.contains(body.position)) : undefined;
    hud.capture(
      inside
        ? {
            name: inside.name,
            letter: inside.letter,
            progress: inside.progress,
            contested: inside.contested,
            mine: inside.owner === 'holdouts' && !inside.capturer,
            color: inside.capturer === 'holdouts' || inside.owner === 'holdouts' ? 'var(--holdouts)' : '#ff5a4a',
          }
        : null,
    );

    // The waypoint: projected to the screen, or pinned to its edge.
    if (mission.waypoint && (mode === 'ground' || mode === 'command') && !ended) {
      const p = mission.waypoint.position.clone();
      p.y = terrain.heightAt(p.x, p.z) + 4;
      const v = p.clone().project(camera);
      const W = window.innerWidth;
      const H = window.innerHeight;
      const behind = v.z > 1;
      let x = (v.x * 0.5 + 0.5) * W;
      let y = (-v.y * 0.5 + 0.5) * H;
      if (behind) {
        x = W - x;
        y = H - y;
      }
      const margin = 70;
      const onScreen = !behind && x > margin && x < W - margin && y > margin && y < H - margin;
      let angle = 0;
      if (!onScreen) {
        const dx = x - W / 2;
        const dy = behind && Math.abs(y - H / 2) < 1 ? H : y - H / 2;
        const k = Math.min((W / 2 - margin) / Math.max(1e-3, Math.abs(dx)), (H / 2 - margin) / Math.max(1e-3, Math.abs(dy)));
        x = W / 2 + dx * k;
        y = H / 2 + dy * k;
        angle = Math.atan2(dy, dx);
      }
      const from = avatar?.position ?? command.target;
      hud.waypoint({ x, y, onScreen, angle }, mission.waypoint.label, Math.hypot(p.x - from.x, p.z - from.z));
    } else hud.waypoint(null);

    if (draw) {
      const firstPerson = mode === 'ground' && avatar instanceof TrooperAvatar && avatar.firstPerson && !avatar.garrison && avatar.alive;
      const vm = firstPerson && avatar instanceof TrooperAvatar ? viewmodelFor(avatar) : null;
      if (vm && avatar instanceof TrooperAvatar) {
        const speed = Math.hypot(avatar.unit.velocity.x, avatar.unit.velocity.z);
        vm.update(dt, {
          moving: Math.min(1, speed / avatar.unit.kind.speed),
          ads: avatar.ads,
          turnX: avatar.turnX,
          turnY: avatar.turnY,
          aspect: camera.aspect,
          fov: camera.fov,
          sunDir: SUN_DIR,
          cameraQuat: camera.quaternion,
          camera,
        });
      }
      if (post.enabled) {
        post.overlay(vm ? vm.scene : null, vm ? vm.camera : null);
        post.grade.uniforms.flash.value = effects.whiteout;
        post.render(dt);
      } else renderer.render(scene, camera);
      if (!post.enabled && vm) {
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(vm.scene, vm.camera);
        renderer.autoClear = true;
      }
      portrait.render(renderer, mode === 'menu' ? null : hud.portraitRect, dt);
    }
    input.endFrame();
  }

  const clock = new THREE.Timer();
  renderer.setAnimationLoop(() => {
    clock.update();
    const t0 = performance.now();
    frame(Math.min(clock.getDelta(), 1 / 20));
    mission.script?.frameTime?.(performance.now() - t0);
  });

  /** Test hook: a fixed camera for screenshots (null hands it back to the game). */
  let testCamera: { from: THREE.Vector3; to: THREE.Vector3; fov: number } | null = null;
  /** A mission script's shot (The Tide: Unleashed's Barracks drop), while it lasts. */
  let scriptCamera: { from: THREE.Vector3; to: THREE.Vector3; fov: number } | null = null;
  function cam(from: THREE.Vector3 | null, to?: THREE.Vector3, fov = 60) {
    testCamera = from && to ? { from: from.clone(), to: to.clone(), fov } : null;
  }

  /** Test hook: runs the game for `seconds` at a fixed step, independent of display refresh. */
  function step(seconds: number, dt = 1 / 30) {
    for (let t = 0; t < seconds; t += dt) frame(dt, t + dt >= seconds);
  }

  /** Test hook: renders a frame and saves it to cache/shots/<name>.png (dev server only). */
  async function shot(name: string) {
    frame(0);
    await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: renderer.domElement.toDataURL('image/png') });
  }

  const game = {
    world, mission, camera, kinds, data: assets.data, input, renderer, step, shot, viewmodel, viewmodelFor, bc, command, stats, possess, redeploy, toCommand, THREE, soundscape, audio,
    profile, frontend, hud, score, debrief, begin, post, cam, callins, particles, echo, story, attract, ult, applySettings,
    /** Another mission or the menus, as the menus' buttons go there (in the page), and this one again. */
    go: page.go,
    restart: page.restart,
    /** The mode's fun meter, where it has one: its report as lines. */
    fun: () => mission.script?.measured?.() ?? null,
    /** Where the content comes from, and what the mode was asked for and refused (what still has no original of its own). */
    content: { mode: contentMode, refused: new Set<string>() },
    get avatar() { return avatar; },
    get mode() { return mode; },
  };
  Object.assign(window, { game });
  if (TEST) {
    const { runMission, runAssault } = await import('../dev/autopilot.ts');
    const { makeDrive } = await import('../dev/drive.ts');
    const { runTide } = await import('../dev/tide-sim.ts');
    Object.assign(game, {
      run: (seconds?: number, player?: 'trooper' | 'none') => runMission(game, seconds, player),
      assault: (seconds?: number) => runAssault(game, seconds),
      drive: makeDrive(game),
      tide: (options?: Parameters<typeof runTide>[1]) => runTide(game, options),
    });
  }

  /** Takes the mission down; the page ends its life and clears the scene and the HUD after it (main.ts). */
  function stop() {
    renderer.setAnimationLoop(null);
    input.unlock();
    soundscape.stop();
    if ((window as { game?: unknown }).game === game) delete (window as { game?: unknown }).game;
  }

  return { stop };
}
