import * as THREE from 'three';
import { PACK_BASE } from '../content/pack.ts';

let renderer: THREE.WebGLRenderer | null = null;

/** The renderer, for what has to know what it can draw (a plugin's compressed textures). */
export function initAssets(r: THREE.WebGLRenderer) {
  renderer = r;
}

export function assetRenderer(): THREE.WebGLRenderer | null {
  return renderer;
}

/**
 * The address a media element (the music player) plays a path from: the game's own files as they
 * are, a plugin's however it serves them (src/content/provider.ts \`music\`), nothing without one.
 */
let mediaSource: ((path: string) => string | Promise<string>) | null = null;

export function setMediaSource(source: (path: string) => string | Promise<string>) {
  mediaSource = source;
}

export function hasMediaSource(): boolean {
  return mediaSource !== null;
}

export function mediaUrl(path: string): string | Promise<string> {
  if (path.startsWith(PACK_BASE)) return path;
  return mediaSource?.(path) ?? '';
}

/**
 * The lowest and highest value each channel (red, green, blue, alpha; 0..1) reaches in a texture:
 * what an animated mask needs to know (when has a burn-away taken every pixel). A plugin that
 * knows its textures says (setChannelRange); otherwise all of each channel.
 */
let rangeOf: (texture: THREE.Texture) => { min: number[]; max: number[] } | null = () => null;

export function setChannelRange(fn: (texture: THREE.Texture) => { min: number[]; max: number[] } | null) {
  rangeOf = fn;
}

export function channelRange(texture: THREE.Texture): { min: number[]; max: number[] } {
  return rangeOf(texture) ?? { min: [0, 0, 0, 0], max: [1, 1, 1, 1] };
}

/** A fetch: null where the file isn't there. */
export async function fetchFile(url: string): Promise<Response | null> {
  const r = await fetch(url);
  return r.ok ? r : null;
}

const buffers = new Map<string, Promise<ArrayBuffer | null>>();

/** Fetches a file once; resolves to null where it isn't there. */
export function fetchBuffer(url: string): Promise<ArrayBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null));
    buffers.set(url, p);
  }
  return p;
}
