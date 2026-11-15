/**
 * Death and the next body, for any mode: how long before a fresh body can be called down, and
 * what dying costs. The cost is kept light on purpose: a few seconds, a little longer for deaths
 * close together (so throwing bodies at the swarm isn't free), and, where a mode pays bounties, the
 * streak that raises them. Nothing the base owns is taken: a commander already being overrun
 * mustn't be pushed further behind for it.
 */

export interface RespawnRules {
  /** Seconds before a fresh body can be called down. */
  delay: number;
  /** And this much more for each other death in the last `window` seconds, up to `max`. */
  perDeath: number;
  window: number;
  max: number;
  /** The wait holds for taking over a soldier in the command view too, not only a fresh body. */
  gateDive: boolean;
}

/** The campaign's: six seconds for a fresh body, every time; any soldier can be taken at once. */
export const DEFAULT_RESPAWN: RespawnRules = { delay: 6, perDeath: 0, window: 60, max: 6, gateDive: false };

export class Respawn {
  private deaths: number[] = [];

  constructor(readonly rules: RespawnRules) {}

  /** A body was lost at `now`: seconds until the next one can deploy. */
  died(now: number): number {
    const r = this.rules;
    this.deaths = this.deaths.filter((t) => now - t < r.window);
    const delay = Math.min(r.max, r.delay + r.perDeath * this.deaths.length);
    this.deaths.push(now);
    return delay;
  }
}

export interface StreakRules {
  /** Kills between steps. */
  every: number;
  /** What each step adds to the bounty multiplier. */
  step: number;
  /** The highest the multiplier goes. */
  max: number;
}

/**
 * A bounty streak: kills since the player's last death raise what each kill pays, step by step;
 * dying puts it back to the start. What's lost is a bonus, never money already earned.
 */
export class BountyStreak {
  kills = 0;

  constructor(readonly rules: StreakRules) {}

  get multiplier(): number {
    return Math.min(this.rules.max, 1 + this.rules.step * Math.floor(this.kills / this.rules.every));
  }

  /** Kills to the next step, or null at the top. */
  get toNext(): number | null {
    if (this.multiplier >= this.rules.max) return null;
    return this.rules.every - (this.kills % this.rules.every);
  }

  /** A kill; true if it took the multiplier up a step. */
  kill(): boolean {
    const before = this.multiplier;
    this.kills++;
    return this.multiplier > before;
  }

  /** The player died: back to the start. Returns the multiplier lost. */
  reset(): number {
    const lost = this.multiplier;
    this.kills = 0;
    return lost;
  }
}
