// Where a plugin's content comes in (src/content/plugins.ts): the provider it hands the game, asked for
// each asset by the game's own name for it (assetnames.ts). The game asks its own pack first where the
// content mode reads it, then the provider, then makes do (resolve.ts): a block figure for a body,
// silence for a sound, procedural ground.

import type * as THREE from 'three';
import type { MapTerrain } from '../engine/mapterrain.ts';
import type { MapData } from '../engine/mapdata.ts';
import type { Environment, Light } from '../game/environment.ts';
import type { EchoSquad } from '../game/echo.ts';
import type { Mission } from '../game/mission.ts';
import type { MissionDef } from '../game/missions.ts';
import type { MissionScript, MissionStory, ScriptHost, StoryState } from '../game/script.ts';
import type { ModelData } from '../engine/modeldata.ts';
import type { ModelTemplate } from '../engine/model.ts';
import type { Stats } from '../game/stats.ts';
import type { AnimationName, IconName, ModelName, MusicName, PortraitName, SoundName, TextureName } from './assetnames.ts';
import { chooseContentMode, contentMode, usesInstall } from './mode.ts';
import { plugins } from './plugins.ts';

export interface ContentProvider {
  /** The stats; `swarm` adds the numbers for the units only Unleashed fields, where a mission asks for them. */
  stats(opts: { swarm: boolean }): Promise<Stats>;
  /** A model, or null where it has none. */
  model(name: ModelName): Promise<ModelTemplate | null>;
  /** Animation keys first person takes its grips from, or null. */
  animation(name: AnimationName): Promise<ModelData | null>;
  /** A named texture, or null. */
  texture(name: TextureName): Promise<THREE.Texture | null>;
  /** A sound's variants, as addresses to fetch (none where it has no such sound). */
  sounds(name: SoundName): string[];
  /** A piece of music, as the music player resolves it (engine/assets.ts mediaUrl), or null. */
  music(name: MusicName): string | null;
  /** A command-card icon's address, or null. */
  icon(name: IconName): Promise<string | null>;
  /** A radio speaker's animated portrait (its model, with its own portrait camera), or null. */
  portrait(name: PortraitName): Promise<ModelTemplate | null>;
  /** A mission's map, built, by its name (MissionDef \`map\`); null where it has no such map. */
  battlefield(name: string, opts: BattlefieldOptions): Promise<Battlefield | null>;
  /** A planet's sky, haze and light, by its tileset (the battlefield's, or the game's own plateau's). */
  environment(tileset: string): Promise<Environment>;
  /** One of its lights by id (a mission's night), or null. */
  light(id: string): Light | null;
  /** A map's scenery placed in the scene; what of it runs with the battle (fires, smoke, lights). */
  doodads(scene: THREE.Scene, battlefield: Battlefield, buildingScale: number): Promise<{ update(dt: number): void; done: boolean }[]>;
  /** Its missions: the game adds them in their places among its own (MissionDef \`order\`). */
  missions(): MissionDef[];
  /** A mission's script, or null for one the game runs on its own (waves, as Hold the Line). */
  script(def: MissionDef, ctx: { mission: Mission; host: ScriptHost; battlefield: Battlefield | null; data: Stats }): MissionScript | null;
  /** The story around a mission: its squad's voices, the scene its debrief closes on. */
  story(def: MissionDef, mission: Mission, echo: EchoSquad, state: StoryState): MissionStory;
}

/** A map, built: its data, its ground, its cliffs. */
export interface Battlefield {
  map: MapData;
  terrain: MapTerrain;
  cliffs: THREE.Mesh | null;
}

export interface BattlefieldOptions {
  /** Meters a map cell. */
  cell: number;
  /** The mission it's for (its rules may reshape the map: The Tide: Unleashed's valley). */
  mission: MissionDef;
  /** What it's doing, for the loading card. */
  loading?: (label: string) => void;
}

let active: ContentProvider | null = null;

/** The provider of the plugin the content mode plays with, once the game has asked for it (null on its own content). */
export function provider(): ContentProvider | null {
  return active;
}

/** Brings in the provider of the plugin the content mode plays with; none on the game's own content. */
export async function useProvider(): Promise<ContentProvider | null> {
  if (!usesInstall) return (active = null);
  // `mix` plays the game's own where it has it, the loader's elsewhere.
  const mode = contentMode === 'mix' ? 'sc2' : contentMode;
  const plugin = (await plugins()).find((p) => p.mode === mode);
  if (!plugin) {
    // A build without it (the game on its own): the game's own content.
    chooseContentMode('original');
    return (active = null);
  }
  return (active = await plugin.provider());
}
