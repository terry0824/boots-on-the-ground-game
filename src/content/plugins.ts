/// <reference types="vite/client" />
// The game's plugins: content it can borrow from somewhere else, each in its own folder under plugins/
// (the StarCraft II loader is plugins/sc2-loader). The game builds and plays with none. The front door
// (src/standalone/boot.ts) offers each one it finds, after the game's own content.

import type { ContentMode } from './mode.ts';
import type { ContentProvider } from './provider.ts';

/** What a plugin can put on the front door. */
export interface FrontDoor {
  /** A paragraph about it, under the game's own. */
  text(html: string): void;
  /** A button in the row. */
  button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement;
  /** An element in the row that isn't a button (a hidden file input). */
  add(el: HTMLElement): void;
  /** Fine print under the row. */
  hint(html: string): void;
  /** How it's going (in red for an error). */
  say(text: string, error?: boolean): void;
  /** Turns the row's buttons off while something is opening, and back on. */
  busy(on: boolean): void;
}

export interface ContentPlugin {
  /** The content mode it plays in (content/mode.ts). */
  mode: ContentMode;
  /** What the front door calls it. */
  label: string;
  /**
   * Its way in on the front door; `primary` where the game has nothing of its own to offer here. It calls
   * `ready` once its content can be read (what it asks the player for given and opened).
   */
  offer(door: FrontDoor, primary: boolean, ready: () => void): void | Promise<void>;
  /** Where it can be read without asking (a test server with what it reads behind it): opens it and says so. */
  auto?(door: FrontDoor): Promise<boolean>;
  /**
   * The player chose it earlier in this visit, and the game has moved to another page since (a mission, the
   * menus, a restart): opens it again without asking where it can (true), or leaves it to the front door.
   */
  resume?(door: FrontDoor): Promise<boolean>;
  /** Its content, by the game's names, once it can be read (the game asks as it loads). */
  provider(): Promise<ContentProvider>;
}

const found = import.meta.glob<{ plugin: ContentPlugin }>('/plugins/*/index.ts');

/** Whether this build has any plugin at all (without loading one). */
export function hasPlugins(): boolean {
  return Object.keys(found).length > 0;
}

/** The plugins this build has, in the order of their folders' names. */
export async function plugins(): Promise<ContentPlugin[]> {
  const paths = Object.keys(found).sort();
  return Promise.all(paths.map(async (p) => (await found[p]()).plugin));
}
