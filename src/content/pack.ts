import { usesPack } from './mode.ts';

/**
 * The original pack (content/original, served at `content/original/`): what it has, by the
 * engine's own names (docs/original-assets/conventions.md). Its index is made by
 * `tools/assetgen/index.ts` from the files there; an asset it doesn't list isn't there.
 */
export interface PackIndex {
  /** ModelName → its `.glb`, relative to the pack. */
  models: Record<string, string>;
  /** SoundName → its variants. */
  sounds: Record<string, string[]>;
  /** MusicName → its file. */
  music: Record<string, string>;
  /** A texture's name (`ground/sandA`, `fx/muzzle`) → its file. */
  textures: Record<string, string>;
  /** IconName → its file. */
  icons: Record<string, string>;
  /** Original speaker ID → its 512-square still portrait. */
  portraits: Record<string, string>;
}

const EMPTY: PackIndex = { models: {}, sounds: {}, music: {}, textures: {}, icons: {}, portraits: {} };

/** Where the pack is served from. */
export const PACK_BASE = `${import.meta.env?.BASE_URL ?? '/'}content/original/`;

/** A file of the pack, by its path inside it. */
export function packUrl(path: string): string {
  return PACK_BASE + path;
}

let index: PackIndex = EMPTY;

/** Reads the pack's index (once, at start); an empty pack where there's none or the mode doesn't read it. */
export async function loadPack(): Promise<PackIndex> {
  if (!usesPack) return (index = EMPTY);
  try {
    const r = await fetch(packUrl('index.json'));
    index = r.ok ? { ...EMPTY, ...((await r.json()) as Partial<PackIndex>) } : EMPTY;
  } catch {
    index = EMPTY;
  }
  return index;
}

/** The pack's index, as read at start. */
export function pack(): PackIndex {
  return index;
}
