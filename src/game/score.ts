import type { Entity } from './entity.ts';
import type { KindName } from './kinds.ts';

/** Experience for each kill, by what it was. Assists pay a share. */
export const KILL_XP: Partial<Record<KindName, number>> = {
  hound: 10,
  leaper: 12,
  blister: 15,
  mite: 2,
  quillback: 25,
  shellback: 30,
  kite: 40,
  bilewing: 45,
  lantern: 40,
  sower: 120,
  tusker: 150,
  turnedColonist: 5,
  turnedTrooper: 15,
  swollen: 80,
  calyx: 500,
  trooper: 50,
  grenadier: 60,
  burner: 50,
  medic: 40,
  seer: 80,
  vaulter: 50,
  torchrunner: 50,
  jackknifeFighter: 70,
  jackknifeAssault: 70,
  nightjar: 80,
  bulwark: 250,
  howitzer: 120,
  howitzerMobile: 120,
  flakTower: 60,
  holdfast: 500,
  barracks: 250,
  motorPool: 250,
  airfield: 250,
  workshop: 150,
  armory: 150,
  bunker: 150,
  storehouse: 80,
};
const ASSIST_SHARE = 0.4;
/** How long after the player's last hit a kill by someone else counts as an assist. */
const ASSIST_WINDOW = 6;
/** Kills closer together than this build a streak. */
const STREAK_WINDOW = 2.2;

const LABELS: Partial<Record<KindName, string>> = {
  howitzerMobile: 'Howitzer',
};

export type TickKind = 'kill' | 'assist' | 'objective';

/** The player's score for a mission: experience, kills, assists, streaks. */
export class Score {
  xp = 0;
  kills = 0;
  assists = 0;
  bestStreak = 0;
  streak = 0;
  private lastKill = -Infinity;
  private tagged = new WeakMap<Entity, number>();
  /** Shows a tick in the HUD. */
  onTick: ((amount: number, label: string, kind: TickKind) => void) | null = null;

  /** The player hurt `e` at `time`. */
  tag(e: Entity, time: number) {
    this.tagged.set(e, time);
  }

  /** Something died; `byPlayer` when the player's body landed the blow. Returns the streak (0 if not a kill). */
  died(e: Entity, byPlayer: boolean, time: number): number {
    const base = KILL_XP[e.kind.name] ?? 0;
    if (!base || e.team === 'holdouts') return 0;
    const label = LABELS[e.kind.name] ?? e.kind.name[0].toUpperCase() + e.kind.name.slice(1);
    if (byPlayer) {
      this.kills++;
      this.streak = time - this.lastKill < STREAK_WINDOW ? this.streak + 1 : 1;
      this.lastKill = time;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.award(base, label, 'kill');
      return this.streak;
    }
    const at = this.tagged.get(e);
    if (at !== undefined && time - at < ASSIST_WINDOW) {
      this.assists++;
      this.award(Math.round(base * ASSIST_SHARE), `${label} assist`, 'assist');
    }
    return 0;
  }

  /** Objectives, waves held, ratings. */
  objective(amount: number, label: string) {
    this.award(amount, label, 'objective');
  }

  private award(amount: number, label: string, kind: TickKind) {
    this.xp += amount;
    this.onTick?.(amount, label, kind);
  }
}
