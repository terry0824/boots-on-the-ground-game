import type { StrikeRules } from '../warship.ts';
import type { CallInId } from '../callins.ts';
import type { KindName } from '../kinds.ts';
import type { ModelName } from '../../content/assetnames.ts';
import type { BattleSizeId } from '../missions.ts';
import type { Charging } from '../ultimate.ts';
import type { MachineTuning } from '../vehicle.ts';
import type { RespawnRules, StreakRules } from './respawn.ts';

/**
 * A mode's rules: which of the game's systems it switches on, and how. A mission that sets none
 * plays as the campaign always has; a new mode is mostly a set of these and a script.
 */
export interface MissionRules {
  /** Structures the commander can have built (from the construction catalog), and limits on them. */
  build?: { allow: KindName[]; limit?: Partial<Record<KindName, number>>; sites?: number };
  /** Death and the next body. */
  respawn?: Partial<RespawnRules>;
  /** A bounty streak: kills since the last death raise what kills pay. */
  streak?: StreakRules;
  /** Which other bodies the player can take, beyond infantry, Howitzers and the Warship. */
  drive?: { vehicles?: boolean; aircraft?: boolean };
  /** The call-ins on offer (T), in the menu's order; all of them if unset. */
  callins?: CallInId[];
  /** Evacuation by air: Dustoffs sent to pull a line's soldiers out, how many, and the seconds before they can go again. */
  evac?: { dustoffs: number; cooldown: number };
  /**
   * The Warship as a call-in (F, or right-click with it selected): it waits behind the base,
   * Snap Jumps over the mark, fights there with its batteries, flies home and recharges.
   * Unset: it circles the base and F fires its Keel Gun, as in the campaign.
   */
  warship?: StrikeRules;
  /**
   * The Lodestar's batteries pick their own targets over the base, as the Warships in the
   * mission's base fight (All Hands starts with three). Unset, the ship fires only when
   * it's called in or flown.
   */
  shipFights?: boolean;
  /**
   * The battle sizes it offers on the menu (Standard, Large, Epic: missions.ts), and the one it
   * plays at when the player hasn't picked. Unset, it has the one size.
   */
  size?: { default: BattleSizeId };
  /**
   * Story sizes this mode draws some units at instead of scale.ts's, in meters by each model's own
   * measure there (a Bulwark's height, a Sower's length). The campaign keeps its own.
   */
  sizes?: Partial<Record<ModelName, number>>;
  /**
   * The air thicker than the map's own: its fog `density` times as dense, its color mixed `mix`
   * of the way toward `color` (for a backlit, cinematic haze).
   */
  haze?: { density: number; color?: number; mix?: number };
  /**
   * The experimental Tide: Unleashed (src/game/experimental/unleashed/): every machine at its
   * real-world power, its own units, and a far bigger, faster swarm.
   */
  unleashed?: boolean;
  /** The player's machines: how far their weapons reach and how fast their aircraft fly, past the data's (vehicle.ts). */
  machines?: Partial<MachineTuning>;
  /**
   * The base down in a valley (The Tide: Unleashed): the map sculpted before its ground is built,
   * the base a cliff level under the basin, every ramp into it a long slope down
   * (experimental/unleashed/valley.ts).
   */
  valley?: boolean;
  /**
   * Q as each body's own ultimate, charged by fighting (a Trooper's Super Jolt, a Seer's Warhead
   * Strike, a Bulwark's or a Behemoth's Lance storm: ultimate.ts's `UNIT_ULTIMATES`) (The Tide:
   * Unleashed). Unset, Q is the ship's Keel Gun (a Seer's warhead), as in the campaign; where the
   * Lodestar is a call-in of its own (`warship`), it's on X from any body.
   */
  ultimates?: 'unit';
  /**
   * A practice range (experimental/unleashed/practice.ts): no swarm of its own and nothing to
   * hold. The player takes any body from the range's panel (G), calls up targets and allies, and
   * spends ultimates freely. What the panel starts at; the player's changes are kept for next time.
   */
  practice?: PracticeRules;
  /**
   * The Crawl that may go for the player's body at once (its attack tokens) grow with its size:
   * a Bulwark is surrounded by more Hounds than a Trooper, and an aircraft draws more fire.
   */
  tokensBySize?: boolean;
}

/** A practice range's settings (`MissionRules.practice`). */
export interface PracticeRules {
  /** How the ultimate (Q) charges: full again as soon as the last one is over, in ten seconds, or by fighting. */
  ultimate: Charging;
  /** What targets called up do: stand still, stand their ground and fight back, or come at the player. */
  targets: 'still' | 'fight' | 'charge';
  /** How far out targets are called up where the player is looking, meters. */
  distance: number;
  /** A group of targets wiped out comes back a few seconds later. */
  respawn: boolean;
  /** Nothing the enemy does can hurt the player's body. */
  invulnerable: boolean;
  /** Packs of the swarm coming in on their own: none, a steady stream, or a flood. */
  swarm: 'off' | 'steady' | 'flood';
}
