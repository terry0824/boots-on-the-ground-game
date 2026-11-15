import type { Stats } from './stats.ts';

/**
 * The game's stats, as a table (public/content/original/data/stats.json): the answer to each call the
 * game makes of its stats (\`unit("Trooper")\`, \`cost("Bulwark")\`, \`heal()\`), played back here. A plugin may
 * answer the same calls from content of its own (src/content/provider.ts \`stats\`).
 *
 * A table has three views: the skirmish numbers (\`melee\`), the campaign's over them (\`campaign\`), and a
 * later campaign's over those (\`swarm\`). Each files an answer under its call, \`method(the arguments as
 * JSON)\`, trailing arguments left to their defaults unwritten (\`jolt()\`). What JSON can't hold is
 * written as a one-key object: {"$n":"Infinity"} (and "-Infinity", "NaN", "-0") for a number, {"$u":1}
 * for undefined.
 */

/** One view's answers, by call. */
export type NumbersView = Record<string, unknown>;

export interface NumbersTable {
  version: number;
  /** Where the numbers came from. */
  source: string;
  views: { melee: NumbersView; campaign: NumbersView; swarm?: NumbersView };
}

/** The key a call's answer is filed under: `duration("MiteLife",5)`. */
export function callKey(method: string, args: readonly unknown[]): string {
  // `transport()` and `transport(undefined)` are the same call: the default answers both.
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return `${method}(${JSON.stringify(args.slice(0, n)).slice(1, -1)})`;
}

/** A value as the table holds it (see the top). Only plain data: anything else would come back as something else. */
export function encodeValue(v: unknown): unknown {
  if (v === undefined) return { $u: 1 };
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: String(Object.is(v, -0) ? '-0' : v) };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(encodeValue);
  const proto: unknown = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
  if (proto !== Object.prototype && proto !== null) throw new Error(`numbers: can't keep ${Object.prototype.toString.call(v)} in a table`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as object)) out[k] = encodeValue(x);
  return out;
}

/** A value back from the table: a new copy each time, so a caller may change what it's given. */
export function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '$u') return undefined;
  // Number() reads all four back: "Infinity", "-Infinity", "NaN", "-0".
  if (keys.length === 1 && keys[0] === '$n') return Number(o.$n);
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decodeValue(o[k]);
  return out;
}

/** Every question the game asks of its stats. */
const METHODS = [
  'unit', 'heal', 'dustoffHeal', 'shroud', 'warhead', 'weapon', 'missileFlight', 'cost', 'trainTime', 'buildTime', 'weaponEffect',
  'duration', 'leap', 'keelGun', 'walkAnimMoveSpeed', 'modelScale', 'morphTiming', 'transport', 'cargoSize', 'braceTime',
  'jolt', 'blightStorm', 'crush', 'aurora', 'orbital', 'stagger',
] as const satisfies readonly (keyof Stats)[];
type Method = (typeof METHODS)[number];

const damage = (amount: number, bonus: Record<string, number> = {}) => ({ amount, bonus, splash: [] });

/**
 * The answer to a call the table hasn't got: an id the stats don't know. A unit can't be made up (it
 * throws); the rest have a plain answer (a weapon of 5 cells that does no damage, a cost of nothing, no
 * train time, an effect's duration its fallback, a hold of 8, a 15-second Jolt). Each a new copy.
 */
const FALLBACK: { [M in Method]: (...args: never[]) => ReturnType<Stats[M]> } = {
  unit: (id: string) => {
    throw new Error(`no unit ${id} in game data`);
  },
  heal: () => ({ rate: 9, energyPerLife: 0.33, range: 2 }),
  dustoffHeal: () => ({ rate: 9, energyPerLife: 0.33, range: 4 }),
  shroud: () => ({ cost: 25, drain: 1.4765 }),
  warhead: () => ({ damage: damage(300, { Structure: 200 }), delay: 10 }),
  weapon: (id: string) =>
    ({ id, range: 5, minRange: 0, period: 1, damagePoint: 0, missile: false, damage: damage(0), melee: false, air: true, ground: true, structures: true }) as ReturnType<Stats['weapon']>,
  missileFlight: () => null,
  cost: () => ({ ore: 0, gas: 0, supply: 0 }),
  trainTime: () => null,
  buildTime: () => null,
  weaponEffect: (id: string) => id,
  duration: (_effect: string, fallback: number) => fallback,
  leap: () => ({ cooldown: 2, speed: 10, clearance: 1 }),
  keelGun: () => ({ damage: damage(240), prep: 3, cooldown: 100 }) as ReturnType<Stats['keelGun']>,
  walkAnimMoveSpeed: () => 0,
  modelScale: () => 1,
  morphTiming: () => ({ total: 2.34, moveDelay: 0, move: 1 }),
  transport: () => ({ space: 8, unloadPeriod: 1, cargoDeath: true, searchRadius: 4 }),
  cargoSize: () => 0,
  braceTime: () => 4.0417000000000005,
  jolt: () => ({ duration: 15, moveSpeed: 1.5, attackSpeed: 1.5, lifeCost: 10, cooldown: 1 }) as ReturnType<Stats['jolt']>,
  blightStorm: () => ({ damage: damage(12, { Structure: 9 }), radius: 2.5, period: 0.5712, count: 12 }),
  crush: () => 3.125,
  aurora: () => ({ amount: 550, cells: 39, seconds: 1.1875 }),
  orbital: () => ({ energy: { start: 50, max: 200, regen: 0.5625 }, skyscan: { cost: 50, radius: 13, duration: 12.2775 }, mender: { cost: 50, life: 64, delay: 4 } }),
  stagger: () => ({ factor: 0.5, duration: 1.5 }),
};

/** One view, answering from its table; a call it hasn't got warns once and gets the plain answer (FALLBACK). */
function replay(answers: NumbersView, name: string): Stats {
  const warned = new Set<string>();
  const view: Record<string, unknown> = { swarm: null };
  for (const method of METHODS) {
    view[method] = (...args: unknown[]) => {
      const key = callKey(method, args);
      if (Object.hasOwn(answers, key)) return decodeValue(answers[key]);
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[numbers] the table has no ${name} ${key}: answering as for an id the stats don't know`);
      }
      return (FALLBACK[method] as (...a: unknown[]) => unknown)(...args);
    };
  }
  // Its own campaign view, as each view is.
  view.campaign = view;
  return view as unknown as Stats;
}

/**
 * Stats that answer from a table: the melee view, with \`campaign\` and \`swarm\` its views of the same
 * kind. \`swarm\` is there only where it's asked for and the table has it (The Tide: Unleashed asks);
 * null otherwise. Each answer is a new copy: callers change what they're given (Unleashed's power,
 * the Armory's research).
 */
export function numbersData(table: NumbersTable, opts: { swarm?: boolean } = {}): Stats {
  if (table.version !== 1) throw new Error(`stats table version ${table.version}: this game reads version 1`);
  const melee = replay(table.views.melee ?? {}, 'melee');
  melee.campaign = replay(table.views.campaign ?? {}, 'campaign');
  const swarm = table.views.swarm;
  melee.swarm = opts.swarm && swarm && Object.keys(swarm).length ? replay(swarm, 'swarm') : null;
  return melee;
}

/** Reads a table (the game's data/stats.json) into Stats: see numbersData. */
export async function loadNumbers(url: string, opts: { swarm?: boolean } = {}): Promise<Stats> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`stats table ${url}: ${r.status} ${r.statusText}`);
  return numbersData((await r.json()) as NumbersTable, opts);
}
