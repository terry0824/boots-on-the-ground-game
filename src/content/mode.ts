/**
 * Where the game's content comes from (docs/original-assets.md): the player's own install, read
 * by the StarCraft II loader (`sc2`), the original pack (`original`: nothing is asked of an
 * install), or, while new assets are made, the original where the pack has it and the install
 * otherwise (`mix`). Set by `?content=` or the menu (kept for next time); `sc2` by default for now.
 */
export type ContentMode = 'sc2' | 'original' | 'mix';

const STORE = 'botg.content';
const MODES: ContentMode[] = ['sc2', 'original', 'mix'];

function read(): ContentMode {
  if (typeof location === 'undefined') return 'sc2';
  const asked = new URLSearchParams(location.search).get('content');
  if (MODES.includes(asked as ContentMode)) return asked as ContentMode;
  try {
    const kept = localStorage.getItem(STORE);
    if (MODES.includes(kept as ContentMode)) return kept as ContentMode;
  } catch {
    // No storage (a private window): the default.
  }
  return 'sc2';
}

/** The mode the game was started in (it doesn't change while it runs: a new choice reloads the page). */
export let contentMode: ContentMode = read();
/** Whether anything is read from the install (through the loader). */
export let usesInstall = contentMode !== 'original';
/** Whether the original pack is read. */
export let usesPack = contentMode !== 'sc2';

/** The mode the stored choice and the address ask for, before a front door overrides it. */
export function askedContentMode(): ContentMode {
  return read();
}

/**
 * For a front door that chooses before the game starts (the web build's: play with the install
 * just picked, or without one): the mode for this run. Only before the game is imported.
 */
export function chooseContentMode(mode: ContentMode) {
  contentMode = mode;
  usesInstall = mode !== 'original';
  usesPack = mode !== 'sc2';
}

/** Keeps a choice for next time (the menu's switch; it takes effect on the next start). */
export function keepContentMode(mode: ContentMode) {
  try {
    localStorage.setItem(STORE, mode);
  } catch {
    // Nowhere to keep it: it lasts as long as the address that asked for it.
  }
}

// The visit: a tab's time with the game, from the front door until the player reloads the page. The game moves
// between missions and the menus inside the page (game/main.ts), so the choice simply lasts; it's kept here too
// for the pages a visit opens anew (an address typed or pasted, the menu's switch of content mode), where the
// front door doesn't ask again.
const VISIT = 'botg.visit';

/**
 * The content mode chosen at the front door earlier in this visit, where this page load continues it (the player
 * going to an address in the same tab, the menu's switch). Null on a fresh start and on the player's own reload
 * (the front door asks then). Read once, by the front door.
 */
export function continuedVisit(): ContentMode | null {
  try {
    const mode = sessionStorage.getItem(VISIT) as ContentMode | null;
    if (!mode || !MODES.includes(mode)) return null;
    const load = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return load?.type !== 'reload' ? mode : null;
  } catch {
    // No session storage: every page starts at the front door.
    return null;
  }
}

/** Keeps the front door's choice for the rest of the visit (and a new one the menu makes). */
export function keepVisit(mode: ContentMode) {
  try {
    sessionStorage.setItem(VISIT, mode);
  } catch {
    // Nowhere to keep it: the next page asks again.
  }
}

/** A path into the loader's routes to the install (`/sc2/`, `/casc/`), which `original` mode never asks for. */
export function isInstallUrl(url: string): boolean {
  return url.startsWith('/sc2/') || url.startsWith('/casc/');
}
