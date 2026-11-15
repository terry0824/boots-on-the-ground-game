// The web build's front door: the game on its own content first ("Play original (work in progress)", where
// this build has it), then each plugin it has, standing out as much (src/content/plugins.ts: the StarCraft II
// loader's "Play with your StarCraft II installation", or "Continue with" it where a folder is kept). The
// content mode is settled here, before the game is imported, as the game reads it as it loads. It asks
// whenever the page is opened or the player reloads it. The game moves between missions and the menus inside
// the page (game/main.ts), so the choice lasts the visit; a page the visit opens anew (an address in the same
// tab, the menu's switch of content mode) carries it on without asking (content/mode.ts continuedVisit).

/// <reference types="vite/client" />
import { askedContentMode, chooseContentMode, continuedVisit, keepVisit, type ContentMode } from '../content/mode.ts';
import { plugins, type ContentPlugin, type FrontDoor } from '../content/plugins.ts';
import { NOTICE, NOTICE_ORIGINAL, noticeHtml, TAGLINE } from '../game/notice.ts';

const style = document.createElement('style');
style.textContent = `
#boot { position: fixed; inset: 0; display: grid; place-items: center; z-index: 50; font-family: var(--hud-font, system-ui, sans-serif);
  background: radial-gradient(ellipse at 30% 20%, #0d1a2b 0, #04070c 60%); color: #d8e6f5; letter-spacing: 0.03em; }
#boot .panel { width: min(640px, calc(100vw - 32px)); padding: 32px 36px; box-sizing: border-box; }
#boot h1 { margin: 0; font-size: 36px; letter-spacing: 0.1em; font-weight: 800; color: #f2f7ff; text-shadow: 0 0 24px rgba(74, 163, 255, 0.45); }
#boot h2 { margin: 6px 0 20px; font-size: 13px; letter-spacing: 0.3em; text-transform: uppercase; color: #7fb6ea; font-weight: 600; }
#boot p { margin: 0 0 14px; line-height: 1.5; font-size: 15px; color: #b9c9db; }
#boot .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 22px 0 8px; }
#boot .fine { font-size: 13px; color: #8295aa; }
#boot code { color: #cfe3f7; font-size: 13px; }
#boot .status { min-height: 1.5em; margin-top: 12px; font-size: 14px; color: #9fd0ff; }
#boot .status.error { color: #ff9a8a; }
#boot .row button.quiet { padding: 10px 18px; }
#boot .row button.cta { padding: 14px 28px; font-size: 17px; letter-spacing: 0.12em; box-shadow: 0 0 24px rgba(74, 163, 255, 0.32); }
#boot .own .row { margin: 16px 0 6px; }
#boot .own:not([hidden]) + .plugins { margin-top: 22px; padding-top: 6px; border-top: 1px solid rgba(127, 182, 234, 0.16); }
`;
document.head.appendChild(style);

const root = document.createElement('div');
root.id = 'boot';
root.innerHTML = `
  <div class="panel">
    <h1>BOOTS ON THE GROUND</h1>
    <h2>${TAGLINE}</h2>
    <div class="own" id="boot-own" hidden>
      <p>Play the game on its own content: its own models, sounds and music, still being made, with plain stand-ins where nothing is made yet.</p>
      <div class="row" id="boot-own-actions"></div>
    </div>
    <div class="plugins" id="boot-plugins">
      <div id="boot-texts"></div>
      <div class="row" id="boot-actions"></div>
      <div class="fine" id="boot-hint"></div>
    </div>
    <div class="status" id="boot-status"></div>
    <div id="boot-notice"></div>
  </div>`;
document.body.appendChild(root);
const actions = root.querySelector<HTMLElement>('#boot-actions')!;
const status = root.querySelector<HTMLElement>('#boot-status')!;

function say(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function button(label: string, primary: boolean, onClick: () => void, row = actions): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = primary ? 'cta' : 'quiet';
  b.onclick = onClick;
  row.appendChild(b);
  return b;
}

const setBusy = (on: boolean) => root.querySelectorAll('.row button, .row input').forEach((b) => ((b as HTMLButtonElement).disabled = on));

const door: FrontDoor = {
  text: (html) => root.querySelector('#boot-texts')!.insertAdjacentHTML('beforeend', `<p>${html}</p>`),
  button: (label, primary, onClick) => button(label, primary, onClick),
  add: (el) => actions.appendChild(el),
  hint: (html) => root.querySelector('#boot-hint')!.insertAdjacentHTML('beforeend', ` ${html}`),
  say,
  busy: setBusy,
};

let started = false;

/** Starts the game in a content mode (the game's own, or a plugin's, already opened). */
async function start(mode: 'original' | ContentPlugin['mode']) {
  if (started) return;
  started = true;
  setBusy(true);
  // A plugin's content, unless the game's own was asked for over it (a mix stays a mix).
  const chosen: ContentMode = mode === 'original' || askedContentMode() !== 'mix' ? mode : 'mix';
  chooseContentMode(chosen);
  // The rest of the visit plays the same, without asking again.
  keepVisit(chosen);
  // The game shows its own loading screen from here.
  root.remove();
  try {
    await import('../game/main.ts');
  } catch (e) {
    document.body.appendChild(root);
    started = false;
    setBusy(false);
    say(`The game couldn't start: ${(e as Error).message}`, true);
  }
}

/**
 * Whether this build has the game's own content beside it (the single-file build opened on its own doesn't): its
 * index and its stats table, answered as JSON (a server's fallback page for a missing file doesn't count).
 */
async function hasOwnContent(): Promise<boolean> {
  const json = (p: string) =>
    fetch(new URL(p, location.href), { method: 'HEAD' })
      .then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json'))
      .catch(() => false);
  return (await json('content/original/index.json')) && (await json('content/original/data/stats.json'));
}

/** The visit's mode where this page continues one; the address's `?content=` can change it on the way. */
function visitMode(): ContentMode | null {
  const visit = continuedVisit();
  const asked = new URLSearchParams(location.search).get('content');
  return visit && (['sc2', 'original', 'mix'] as const).find((m) => m === asked) ? (asked as ContentMode) : visit;
}

async function main() {
  const visit = visitMode();
  const [own, found] = await Promise.all([hasOwnContent(), plugins()]);
  // A plugin that can be read without asking (a test server) goes straight in.
  for (const p of found) if (await p.auto?.(door)) return start(p.mode);
  // A page of the same visit: it goes on as it was chosen.
  if (visit === 'original' && own) return start('original');
  if (visit && visit !== 'original') {
    const p = found.find((x) => x.mode === 'sc2');
    if (p && (await p.resume?.(door))) return start(p.mode);
  }
  // The game's own content first; each plugin's way in after it, standing out as much.
  if (own) {
    root.querySelector('#boot-own')!.removeAttribute('hidden');
    button('Play original (work in progress)', true, () => void start('original'), root.querySelector<HTMLElement>('#boot-own-actions')!);
  }
  if (found.length) for (const p of found) await p.offer(door, true, () => void start(p.mode));
  else root.querySelector<HTMLElement>('#boot-plugins')!.hidden = true;
  root.querySelector('#boot-notice')!.outerHTML = noticeHtml(own ? NOTICE_ORIGINAL : NOTICE);
  if (!own && !found.length) say('This build has neither the game\'s own content nor a plugin to play with.', true);
}

void main();
