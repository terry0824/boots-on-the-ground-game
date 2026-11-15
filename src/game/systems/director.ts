import * as THREE from 'three';

/**
 * The Tide's director: Left 4 Dead's adaptive dramatic pacing, after Michael Booth's "The AI
 * Systems of Left 4 Dead" (Valve, 2009). It estimates how hard-pressed the player is and paces
 * the swarm in a cycle:
 *
 * - Build Up: full threat (packs, surges, specials) until intensity crosses the peak.
 * - Sustain Peak: full threat a few seconds more, so a crisis always gets its moment.
 * - Peak Fade: nothing new; the fight already on the field plays out until intensity falls back.
 * - Relax: half a minute of only what's left out there: the window to spend, repair and
 *   reposition.
 *
 * Booth's director changes pacing and never strength. This one also drifts the swarm's
 * strength (`amplitude`), within bounds, with how pressed the player has been over a couple of
 * minutes: a calm player gets more of it, sooner; a drowning one a little less.
 */
export type Phase = 'buildup' | 'peak' | 'fade' | 'relax';

/** Intensity (0..1) that makes a peak, and that counts as calm again. */
const PEAK = 0.72;
const CALM = 0.42;
/** Seconds of full threat after the peak. */
const SUSTAIN = 4;
/** The shortest build-up, so a crisis builds rather than flickers. */
const MIN_BUILD_UP = 22;
/** Seconds the swarm regroups, by difficulty level. */
const RELAX = [40, 34, 30, 26];
/** Where the strength may drift, and how fast (per second). */
const AMPLITUDE = { min: 0.9, max: 1.2, rate: 0.0012 };

export interface BattleState {
  /** Crawl on the player right now (within a few meters, or hitting them). */
  engaged: boolean;
  /** Lines overrun. */
  brokenLines: number;
  /** Crawl at the base. */
  crawlAtBase: number;
  /** The Holdfast's life, as a share. */
  base: number;
  /** The worst-pressed line: the swarm's supply in front of it over its own. */
  pressure: number;
}

export class Director {
  phase: Phase = 'buildup';
  private phaseTime = 0;
  /** The player's intensity (Booth's): up with damage taken, going down, and Crawl dying close by. */
  player = 0;
  /** The battle's: the army's losses over the last 20 seconds, broken lines, the swarm at the base. */
  battle = 0;
  /** How hard the swarm comes: a multiplier on its strength. */
  amplitude = 1;
  /**
   * How big the battle is now (a bigger battle's swarm, as it grows): losses that make a crisis
   * grow with it, or a battle twice the size would be in crisis twice as often.
   */
  scale = 1;
  /** A slow average of intensity, for the strength. */
  private average = 0.5;
  private losses: { at: number; supply: number }[] = [];
  private calmFor = 0;
  private time = 0;
  /** Phase changes, for the radio and the HUD. */
  onPhase: ((p: Phase) => void) | null = null;

  constructor(private level: number) {}

  get intensity(): number {
    return Math.max(this.player, this.battle);
  }

  /** New threats come in Build Up and its peak, not while the fight fades or the swarm regroups. */
  get spawning(): boolean {
    return this.phase === 'buildup' || this.phase === 'peak';
  }

  /** Seconds left in a lull (0 outside one). */
  get relaxLeft(): number {
    return this.phase === 'relax' ? Math.max(0, (RELAX[this.level] ?? 34) - this.phaseTime) : 0;
  }

  playerDamaged(amount: number, maxHp: number) {
    this.player = Math.min(1, this.player + (amount / Math.max(1, maxHp)) * 0.9);
    this.calmFor = 0;
  }

  playerDown() {
    this.player = Math.min(1, this.player + 0.6);
    this.calmFor = 0;
  }

  /** A Crawl died this far from the player: close calls count, more the closer. */
  crawlDied(distance: number) {
    if (distance < 25) this.player = Math.min(1, this.player + 0.03 * (1 - distance / 25));
  }

  holdoutsLost(supply: number) {
    this.losses.push({ at: this.time, supply });
  }

  update(dt: number, s: BattleState) {
    this.time += dt;
    this.phaseTime += dt;
    // Down toward zero over time, but never while the swarm is on the player.
    this.calmFor = s.engaged ? 0 : this.calmFor + dt;
    if (this.calmFor > 2) this.player = Math.max(0, this.player - dt * 0.06);
    while (this.losses.length && this.time - this.losses[0].at > 20) this.losses.shift();
    const lost = this.losses.reduce((a, l) => a + l.supply, 0);
    // A line about to go under counts before it does: past even odds in front of it, it climbs fast.
    const pressed = Math.max(0, s.pressure - 0.5) * 0.8;
    const battle = THREE.MathUtils.clamp(lost / (45 * this.scale) + s.brokenLines * 0.3 + s.crawlAtBase / 25 + (1 - s.base) * 0.6 + pressed, 0, 1);
    this.battle += (battle - this.battle) * Math.min(1, dt * 0.8);
    this.average += (this.intensity - this.average) * Math.min(1, dt / 120);
    if (this.average < 0.3) this.amplitude = Math.min(AMPLITUDE.max, this.amplitude + dt * AMPLITUDE.rate);
    else if (this.average > 0.6) this.amplitude = Math.max(AMPLITUDE.min, this.amplitude - dt * AMPLITUDE.rate);
    const go = (p: Phase) => {
      this.phase = p;
      this.phaseTime = 0;
      this.onPhase?.(p);
    };
    switch (this.phase) {
      case 'buildup':
        if (this.intensity >= PEAK && this.phaseTime > MIN_BUILD_UP) go('peak');
        break;
      case 'peak':
        if (this.phaseTime > SUSTAIN) go('fade');
        break;
      case 'fade':
        if (this.intensity < CALM) go('relax');
        break;
      case 'relax':
        if (this.phaseTime > (RELAX[this.level] ?? 34)) go('buildup');
        break;
    }
  }
}
