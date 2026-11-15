/**
 * What the player reads: the game's own text, or a plugin's over it (the StarCraft II loader brings
 * that game's names and story: src/content/provider.ts). The text passes through here at a few
 * choke points on its way to the screen (the HUD's setters, the menus, the board), and the game's
 * own missions once a plugin has said its text (missions.ts addMissions).
 */

/** A plugin's text over the game's (setTextOverlay). */
export interface TextOverlay {
  /** Whole strings the game writes, and what the plugin shows instead. */
  exact: Record<string, string>;
  /** Words and phrases within the game's text, and the plugin's: whole words, longest first, a/an following the new word. */
  words: readonly (readonly [from: string, to: string])[];
  /** A mission's text where the plugin's says more than other words: by the mission's id. */
  missions?: Record<string, { title?: string; planet?: string; summary?: string; speaker?: string; lines?: string[]; objectives?: Record<string, string> }>;
}

/**
 * Names straight from the data that can reach the screen (a unit's id in the kill feed, a kind's in
 * the command view: "Sower", "2 grenadiers"), and the game's own for them.
 */
const DATA_NAMES: readonly (readonly [id: string, name: string])[] = [
  ["harlan", "Wes Harlan"],
  ["harlans", "Harlan"],
  ["seer", "Seer"],
  ["seers", "Seers"],
  ["HowitzerBraced", "Howitzer"],
  ["HowitzerBraceds", "Howitzers"],
  ["howitzer", "Howitzer"],
  ["howitzers", "Howitzers"],
  ["howitzerMobile", "Howitzer"],
  ["howitzerMobiles", "Howitzers"],
  ["ScuttleMine", "Scuttle Mine"],
  ["ScuttleMines", "Scuttle Mines"],
  ["scuttleMine", "Scuttle Mine"],
  ["scuttleMines", "Scuttle Mines"],
  ["ColonistHauler", "Colonist Hauler"],
  ["ColonistHaulers", "Colonist Haulers"],
  ["colonistHauler", "Colonist Hauler"],
  ["colonistHaulers", "Colonist Haulers"],
  ["JackknifeFighter", "Jackknife"],
  ["JackknifeFighters", "Jackknives"],
  ["JackknifeAssault", "Jackknife"],
  ["JackknifeAssaults", "Jackknives"],
  ["jackknifeFighter", "Jackknife"],
  ["jackknifeFighters", "Jackknives"],
  ["jackknifeAssault", "Jackknife"],
  ["jackknifeAssaults", "Jackknives"],
  ["TurnedColonist", "Turned Colonist"],
  ["TurnedColonists", "Turned Colonists"],
  ["TurnedTrooper", "Turned Trooper"],
  ["TurnedTroopers", "Turned Troopers"],
  ["OvergrownHut", "Overgrown Hut"],
  ["OvergrownHuts", "Overgrown Huts"],
  ["OvergrownDome", "Overgrown Dome"],
  ["OvergrownDomes", "Overgrown Domes"],
  ["holdfast", "Holdfast"],
  ["holdfasts", "Holdfasts"],
  ["storehouse", "Storehouse"],
  ["storehouses", "Storehouses"],
  ["FlakTower", "Flak Tower"],
  ["FlakTowers", "Flak Towers"],
  ["flakTower", "Flak Tower"],
  ["flakTowers", "Flak Towers"],
  ["workshop", "Workshop"],
  ["workshops", "Workshops"],
  ["motorPool", "motor pool"],
  ["motorPools", "motor pools"],
  ["ReactorHall", "Reactor Hall"],
  ["ReactorHalls", "Reactor Halls"],
  ["reactorHall", "Reactor Hall"],
  ["reactorHalls", "Reactor Halls"],
  ["HiringHall", "Hiring Hall"],
  ["HiringHalls", "Hiring Hall"],
  ["hiringHall", "Hiring Hall"],
  ["hiringHalls", "Hiring Hall"],
  ["DirectorateBillboard", "Directorate Billboard"],
  ["DirectorateBillboards", "Directorate Billboards"],
  ["LogisticsHeadquarters", "Logistics Headquarters"],
  ["radioTower", "Logistics Headquarters"],
  ["radioTowers", "Logistics Headquarters"],
  ["DefenseWall", "Defense Wall"],
  ["DefenseWalls", "Defense Walls"],
  ["defenseWall", "Defense Wall"],
  ["defenseWalls", "Defense Walls"]
];

interface Translator {
  pattern: RegExp;
  forms: Map<string, string>;
}

/** Every form and the one regular expression that finds them: the first to claim a form keeps it. */
function translator(pairs: readonly (readonly [string, string])[]): Translator {
  const forms = new Map<string, string>();
  for (const [from, to] of pairs) if (from && from !== to && !forms.has(from)) forms.set(from, to);
  // Whole words only, with an article before it caught too, so a/an can follow the new word.
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:(an?|An?|AN?)( +))?(${trie(forms.keys())})(?![A-Za-z0-9])`, 'g');
  return { pattern, forms };
}

/**
 * The words as one alternation shaped as a trie (each first letter once, then each second...):
 * the engine steps through it a character at a time instead of trying every word at every
 * position, and a longer word is still preferred to its prefix.
 */
function trie(words: Iterable<string>): string {
  type Node = { next: Map<string, Node>; end: boolean };
  const root: Node = { next: new Map(), end: false };
  for (const w of words) {
    let n = root;
    for (const ch of w) {
      let c = n.next.get(ch);
      if (!c) n.next.set(ch, (c = { next: new Map(), end: false }));
      n = c;
    }
    n.end = true;
  }
  const emit = (n: Node): string => {
    const alts = [...n.next].map(([ch, c]) => ch.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&') + emit(c));
    if (!alts.length) return '';
    const body = alts.length > 1 ? `(?:${alts.join('|')})` : alts[0];
    return n.end ? `(?:${body})?` : body;
  };
  return emit(root);
}

/**
 * a or an before `word`, in the case the text had it: by its first sound, so an initialism goes
 * by its letter's name ("an RK-4") and a "u" said "you" takes a ("a Union").
 */
function article(was: string, word: string): string {
  const an = /^[A-Z]+-?\d/.test(word) ? /^[AEFHILMNORSX]/.test(word) : /^[aeiou]/i.test(word) && !/^uni/i.test(word);
  if (was === was.toLowerCase()) return an ? 'an' : 'a';
  const caps = was.length > 1 ? was === was.toUpperCase() : word === word.toUpperCase();
  return an ? (caps ? 'AN' : 'An') : 'A';
}

/** Whether `at` starts a sentence in `text`: its start, or after a full stop and space (an opening quote between). */
function sentenceStart(text: string, at: number): boolean {
  return /(?:^|[.!?…][”"’)]*\s+)[“"‘(]*$/.test(text.slice(0, at));
}

function translate(t: Translator, text: string): string {
  if (!t.forms.size) return text;
  return text.replace(t.pattern, (_match, was: string | undefined, gap: string | undefined, term: string, offset: number, whole: string) => {
    let out = t.forms.get(term) ?? term;
    // A word in lower case ("human") where the original was capitalized: a capital at a sentence's start.
    if (!was && /^[a-z]/.test(out) && /^[A-Z]/.test(term) && sentenceStart(whole, offset)) out = out[0].toUpperCase() + out.slice(1);
    return was ? article(was, out) + gap + out : out;
  });
}

let overlay: TextOverlay | null = null;
let overlayWords: Translator | null = null;
let dataWords: Translator | null = null;
/** Recent texts: the HUD sends the same few lines every frame. */
const cache = new Map<string, string>();
const CACHE_SIZE = 2000;

/** A plugin's text over the game's, from here on (the loader's, as it loads). */
export function setTextOverlay(o: TextOverlay) {
  overlay = o;
  overlayWords = translator(o.words);
  cache.clear();
}

/** Whether the player reads a plugin's text rather than the game's own. */
export function hasTextOverlay(): boolean {
  return overlay !== null;
}

/** Text for the screen: the plugin's where one has said its text, else the game's own (with its names for the data's ids). */
export function shown(text: string): string {
  if (!text) return text;
  let out = cache.get(text);
  if (out === undefined) {
    out = overlay ? (overlay.exact[text] ?? translate(overlayWords!, text)) : translate((dataWords ??= translator(DATA_NAMES)), text);
    if (cache.size >= CACHE_SIZE) cache.clear();
    cache.set(text, out);
  }
  return out;
}

const SEGMENT = /(<[^>]*>)|([^<]+)/g;
const TITLE = /(\stitle=")([^"]*)(")/g;

/**
 * HTML for the screen, the same way: only its text and its tooltips (`title`) change, never a tag,
 * an id, a data attribute or a class (a button's class is "quiet"; a picker's data-cls is "trooper").
 */
export function shownHtml(html: string): string {
  if (!html) return html;
  return html.replace(SEGMENT, (_m, tag: string | undefined, text: string | undefined) => {
    if (tag) return tag.includes(' title="') ? tag.replace(TITLE, (_t, a: string, v: string, b: string) => a + shown(v) + b) : tag;
    return shown(text!);
  });
}

/** A loading card's line: what's loading (a model's or a sound's own name only where a plugin is in). */
export function shownLoading(label: string): string {
  if (overlay) return shown(label);
  const file = /^(Model|Sounds): /.exec(label);
  return shown(file ? `${file[1] === 'Model' ? 'Models' : 'Sounds'}…` : label);
}

/** What `showMission` changes: a mission definition's text. */
interface MissionLike {
  id: string;
  title: string;
  planet: string;
  summary: string;
  briefing: { speaker: string; lines: string[] };
  objectives: { id: string; text: string }[];
}

/** One of the game's own missions as a plugin tells it (its overrides, then its words); nothing without a plugin. */
export function showMission(m: MissionLike) {
  if (!overlay) return;
  const t = overlay.missions?.[m.id] ?? {};
  m.title = t.title ?? shown(m.title);
  m.planet = t.planet ?? shown(m.planet);
  m.summary = t.summary ?? shown(m.summary);
  m.briefing.speaker = t.speaker ?? shown(m.briefing.speaker);
  m.briefing.lines = t.lines ?? m.briefing.lines.map(shown);
  for (const o of m.objectives) o.text = t.objectives?.[o.id] ?? shown(o.text);
}
