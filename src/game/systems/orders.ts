import type { KindName } from '../kinds.ts';
import type { Stance } from './lines.ts';

/**
 * Everything a side's commander can do, as plain data: what the requisition board, the command
 * view and a test bot issue for the Holdouts, and what the director issues for the swarm. One
 * entry point checks and applies them (The Tide's `apply`). This is the seam for
 * multiplayer: a human Overmind would issue the same Crawl orders the director does, a second
 * human player the same requisitions, and under a host the entry point is where clients'
 * orders arrive.
 */
export type HoldoutsOrder =
  /** A squad from the board (by its key), sent to a line, "Auto", "With me" or "Base". */
  | { side: 'holdouts'; kind: 'requisition'; offer: string; destination: string }
  /** One of a building's orders taken back (by its place in that building's queue), refunded. */
  | { side: 'holdouts'; kind: 'withdraw'; producer: 'barracks' | 'motorPool' | 'airfield'; index: number }
  /** A line's stance. */
  | { side: 'holdouts'; kind: 'stance'; line: string; stance: Stance }
  /** A structure (by its kind) on a spot of the map: an Rigger goes out and builds it. */
  | { side: 'holdouts'; kind: 'build'; structure: KindName; at: [number, number] }
  /** Dustoffs pull a line's soldiers out by air, to its fallback (or the base). */
  | { side: 'holdouts'; kind: 'evacuate'; line: string };

export type CrawlOrder =
  /** Supply's worth of the swarm, by the mix of the moment, down one route (or any). */
  | { side: 'crawl'; kind: 'pack'; supply: number; route?: number }
  /** A special: Lanterns dropping Hounds, or a Blister bust at the thinnest line. */
  | { side: 'crawl'; kind: 'special' };

export type Order = HoldoutsOrder | CrawlOrder;

/** Whoever applies orders: null if it went through, otherwise why not. */
export interface Commanded {
  apply(order: Order): string | null;
}
