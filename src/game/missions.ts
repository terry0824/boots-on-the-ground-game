import { showMission } from '../content/names.ts';
import type { ModelName } from '../content/assetnames.ts';
import type { EchoId } from './echo.ts';
import type { KindName, Team } from './kinds.ts';
import type { Profile } from './profile.ts';
import type { MissionRules } from './systems/rules.ts';

export type Wave = Partial<Record<KindName, number>>;

export type MissionKind = 'training' | 'defense' | 'survival' | 'assault' | 'frontline' | 'escort' | 'daynight' | 'tide' | 'practice';

export interface Objective {
  id: string;
  text: string;
  bonus?: boolean;
  /** Kept rather than achieved ("lose no bunkers"): done at victory unless it failed first. */
  keep?: boolean;
  /** Hidden until the script reveals it. */
  hidden?: boolean;
  /** How many it takes, where it counts something (the player's kills: 120 unless set). */
  count?: number;
}

export interface MissionDef {
  id: string;
  /**
   * Where it stands among the missions (the campaign's order, then the rest). A plugin's missions
   * (src/content/provider.ts \`missions\`) take their places around the game's own by it.
   */
  order: number;
  act: number;
  title: string;
  planet: string;
  /** A plugin's map folder (for its missions), or null for the procedural plateau. */
  map: string | null;
  kind: MissionKind;
  /** One line on the star map. */
  summary: string;
  briefing: { speaker: string; portrait: string; lines: string[] };
  objectives: Objective[];
  /** Mission that must be completed first. */
  requires?: string;
  /** The campaign's last mission: its victory ends the story. */
  finale?: boolean;
  /** A mode still being tried out, shown as such on the menus and kept out of the campaign. */
  experimental?: boolean;
  /** Kept off the menus: still there by its link (`?mission=<id>`), for a mode not meant to be found yet. */
  hidden?: boolean;
  /**
   * Every class and call-in open from the start, whatever the player's rank: a special operation
   * meant to be played without the campaign first.
   */
  allOpen?: boolean;
  /**
   * The shared systems this mission switches on, and how (construction, the respawn policy, a
   * bounty streak, which vehicles the player can take). None: as the campaign has always played.
   */
  rules?: MissionRules;
  /** The map's night light (the content's `light` id), for missions that turn dark. */
  night?: string;
  reward: { xp: number; credits: number };
  waves?: Wave[];
  /** A tile of its own on the command screen (a mode beside the campaign), in \`order\` among the tiles. */
  tile?: { order: number; kicker: string; title: string; text: (p: Profile) => string; className?: string };
  /** The mission the menus offer when the campaign is done (else Hold the Line). */
  fallback?: boolean;
  /** Who of Echo Squad fights in it. */
  echo?: EchoId[];
  /** The crowds to bake before it starts, so the first wave doesn't hitch. */
  prewarm?: { team: Team; models: ModelName[] }[];
}

/**
 * Difficulty, the campaign's four levels. The army fights with the game's own numbers;
 * difficulty changes how much of the enemy comes (`waveScale`: the swarm's waves, every
 * scripted spawn, the Directorate's garrisons), how big the defending forces are (`allies`), how
 * many may go for the player's body at once (`tokens`), how hard what reaches you hits
 * (`incoming`), how fast the line is reinforced, and what the mission pays. The enemy grows
 * faster than the defense: battles get bigger and harder together.
 */
export const DIFFICULTY = [
  { level: 0, name: 'Casual', waveScale: 0.85, allies: 1, tokens: { melee: 3, ranged: 2 }, incoming: 0.9, reinforce: 6, reward: 0.75 },
  { level: 1, name: 'Normal', waveScale: 1.75, allies: 1.25, tokens: { melee: 5, ranged: 4 }, incoming: 1.25, reinforce: 10, reward: 1 },
  { level: 2, name: 'Hard', waveScale: 2.2, allies: 1.35, tokens: { melee: 6, ranged: 5 }, incoming: 1.5, reinforce: 14, reward: 1.25 },
  { level: 3, name: 'Brutal', waveScale: 2.8, allies: 1.45, tokens: { melee: 8, ranged: 6 }, incoming: 1.8, reinforce: 18, reward: 1.5 },
] as const;

export type Difficulty = (typeof DIFFICULTY)[number];

/**
 * How big the battle is, for a mode that offers the choice (`rules.size`, on the menu): a
 * multiple of what's counted in supply. The enemy grows to that multiple of itself, and the
 * player's side may be built up to that multiple of its cap, with the income and production to
 * pay for it; the army itself starts as it always does.
 */
export const BATTLE_SIZES = [
  { id: 'standard', name: 'Standard', scale: 1 },
  { id: 'large', name: 'Large', scale: 1.5 },
  { id: 'epic', name: 'Epic', scale: 2 },
] as const;

export type BattleSize = (typeof BATTLE_SIZES)[number];
export type BattleSizeId = BattleSize['id'];

/** The size a mission plays at: the one asked for if it offers sizes (its default if none was), Standard if it doesn't. */
export function sizeFor(def: MissionDef, asked?: string | null): BattleSize {
  const offer = def.rules?.size;
  if (!offer) return BATTLE_SIZES[0];
  return BATTLE_SIZES.find((s) => s.id === asked) ?? BATTLE_SIZES.find((s) => s.id === offer.default) ?? BATTLE_SIZES[0];
}

export const HOLD_WAVES: Wave[] = [
  { hound: 30 },
  { hound: 60 },
  { hound: 60, shellback: 10 },
  { hound: 70, quillback: 20 },
  { hound: 150, shellback: 18, quillback: 22 },
  { tusker: 4, hound: 170, shellback: 10, quillback: 24 },
  // The swarm.
  { tusker: 6, hound: 320, shellback: 24, quillback: 36 },
];

export const MISSIONS: MissionDef[] = [
  {
    id: 'hold-the-line',
    order: 70,
    act: 1,
    title: 'Hold the Line',
    planet: 'Calder outskirts',
    map: null,
    kind: 'defense',
    summary: 'The first stand on the plateau: three ramps, three bunkers, seven waves of the Crawl.',
    briefing: {
      speaker: 'Sgt. Dana Rourke',
      portrait: 'trooper',
      lines: [
        "Three ramps, three bunkers, one Holdfast. That's the whole plateau, Corporal, and the Crawl wants every inch of it.",
        "Hounds first. Then Shellbacks and Quillbacks, and when the ground starts to shake, that's a Tusker. Nothing gets up those ramps. Nothing.",
      ],
    },
    objectives: [
      { id: 'waves', text: 'Survive every wave' },
      { id: 'cc', text: 'The Holdfast must survive' },
      { id: 'bunkers', text: 'Lose no bunkers', bonus: true, keep: true },
      { id: 'kills', text: 'Kill 120 of the Crawl yourself', bonus: true },
      { id: 'healthy', text: 'Holdfast above half health', bonus: true, keep: true },
    ],
    reward: { xp: 1000, credits: 700 },
    waves: HOLD_WAVES,
  },
];


/**
 * A plugin's missions, each in its place by \`order\` (src/content/provider.ts \`missions\`), before the
 * menus are built; the game's own told in the plugin's words first (content/names.ts showMission). The
 * plugin's own are in its words already.
 */
export function addMissions(defs: MissionDef[]) {
  for (const m of MISSIONS) showMission(m);
  for (const m of defs) if (!MISSIONS.some((x) => x.id === m.id)) MISSIONS.push(m);
  MISSIONS.sort((a, b) => a.order - b.order);
}

/** The mission the menus offer when the campaign is done: a plugin's, or Hold the Line. */
export function fallbackMission(): MissionDef {
  return MISSIONS.find((m) => m.fallback) ?? missionById('hold-the-line')!;
}

export function missionById(id: string | null): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}

/**
 * Wave `n` of an endless survival: the classic waves first, then ever larger mixes, with
 * Tuskers becoming common.
 */
export function endlessWave(n: number): Wave {
  if (n < HOLD_WAVES.length) return HOLD_WAVES[n];
  const k = n - HOLD_WAVES.length + 1;
  return {
    hound: Math.round(260 + 60 * k),
    quillback: Math.round(30 + 10 * k),
    shellback: Math.round(20 + 8 * k),
    tusker: Math.round(5 + 2 * k),
  };
}
