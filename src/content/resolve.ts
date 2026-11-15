import type { ModelTemplate } from '../engine/model.ts';
import { lastingModel } from '../engine/teardown.ts';
import type { ModelName, MusicName, SoundName } from './assetnames.ts';
import { usesPack } from './mode.ts';
import { pack, packUrl } from './pack.ts';
import { placeholderTemplate } from './placeholder.ts';
import { provider } from './provider.ts';

/**
 * Where each asset comes from, by the content mode (mode.ts): the game's own pack where the mode
 * reads it and the pack has one, a plugin's provider where the mode plays with one (provider.ts),
 * and otherwise what the engine makes for itself (a block figure for a body, silence for a sound).
 */

/** A sound's variants, as addresses to fetch. */
export function soundUrls(name: SoundName): string[] {
  const own = usesPack ? pack().sounds[name] : undefined;
  if (own?.length) return own.map(packUrl);
  return provider()?.sounds(name) ?? [];
}

/** Every piece of music, as the music player takes them: the pack's addresses or the provider's. */
export function musicPaths(names: readonly MusicName[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const own = usesPack ? pack().music[name] : undefined;
    const path = own ? packUrl(own) : provider()?.music(name);
    if (path) out[name] = path;
  }
  return out;
}

/**
 * A model by its name in the game (`trooper`): the pack's, the provider's, or, for a body the
 * game can't do without (`bodies`), a block figure of its size; null where there's none of these
 * (an effect, a death: the engine draws its own in their place).
 */
export function loadContentModel(name: ModelName, bodies: ReadonlySet<string>): Promise<ModelTemplate | null> {
  // Read once a page: the page stays from mission to mission (game/main.ts), and so do the models, on the card too.
  let model = models.get(name);
  if (!model) {
    model = readModel(name, bodies).then((m) => {
      if (m) lastingModel(m);
      return m;
    });
    models.set(name, model);
  }
  return model;
}
const models = new Map<ModelName, Promise<ModelTemplate | null>>();

async function readModel(name: ModelName, bodies: ReadonlySet<string>): Promise<ModelTemplate | null> {
  const own = usesPack ? pack().models[name] : undefined;
  if (own) {
    try {
      // The glTF reader only where there's a glTF to read (it stays out of a run on the loader's content alone).
      const { loadGlbTemplate } = await import('./gltf.ts');
      return await loadGlbTemplate(packUrl(own), name);
    } catch (e) {
      console.warn(`original model ${own} unreadable:`, e);
    }
  }
  const theirs = await provider()?.model(name);
  if (theirs) return theirs;
  return bodies.has(name) ? placeholderTemplate(name) : null;
}

/** A texture of the pack by its name (`ground/sandA`), where the mode reads the pack and it has one. */
export function packTexture(name: string): string | null {
  const own = usesPack ? pack().textures[name] : undefined;
  return own ? packUrl(own) : null;
}

/** A still radio portrait, keyed by the original speaker's name. */
export function packPortrait(speaker: string): string | null {
  const own = usesPack ? pack().portraits[speaker] : undefined;
  return own ? packUrl(own) : null;
}
