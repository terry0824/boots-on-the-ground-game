import type { Audio, Loop } from '../engine/audio.ts';
import type { Music } from '../engine/music.ts';
import type { MusicName } from '../content/assetnames.ts';

export interface SoundscapeState {
  /** 'title', or the mission's phase. */
  phase: string;
  wave: number;
  totalWaves: number;
  /** 0..1: how hard the fight is pressing on the player and the base. */
  threat: number;
  /** The player's life fraction, or null when not in a body. */
  life: number | null;
}

/**
 * Everything the player hears that isn't an event: the mission score following the fight,
 * the planet's ambience, the rumble of the battle beyond the ridge, a heartbeat at low life.
 */
export class Soundscape {
  private beds: Loop[] = [];
  private distant: Loop | null = null;
  private heartbeat = 0;
  private threat = 0;

  constructor(
    private audio: Audio,
    readonly music: Music,
  ) {}

  /** Starts the ambient beds (needs a running audio context). */
  start() {
    if (this.beds.length) return;
    const a = this.audio;
    const amb = a.loop('ambienceCalder', 'ambience', 0.8);
    const wind = a.loop('synth.wind', 'ambience', 0.35);
    this.distant = a.loop('distantBattle', 'ambience', 0);
    for (const l of [amb, wind, this.distant]) if (l) this.beds.push(l);
  }

  /** Ends the beds and the score (a mission ending). */
  stop(seconds = 0.6) {
    for (const l of this.beds) l.stop(seconds);
    this.beds = [];
    this.distant = null;
    this.music.stop(seconds);
  }

  update(dt: number, s: SoundscapeState) {
    // Smooth the threat so the score doesn't lurch with every Hound.
    this.threat += (s.threat - this.threat) * Math.min(1, dt * 0.8);
    this.music.play(this.mood(s));
    this.music.update();
    this.distant?.fade(Math.min(0.9, 0.15 + this.threat * 1.2), 1);

    if (s.life !== null && s.life < 0.3) {
      this.heartbeat -= dt;
      if (this.heartbeat <= 0) {
        this.audio.play('synth.heartbeat', { bus: 'ui', volume: 0.5 + (0.3 - s.life), reverb: 0 });
        this.heartbeat = 0.55 + s.life * 1.5;
      }
    } else this.heartbeat = 0;
  }

  private mood(s: SoundscapeState): MusicName {
    switch (s.phase) {
      case 'title':
        return 'menu';
      case 'victory':
        return 'victory';
      case 'defeat':
        return 'defeat';
      case 'briefing':
      case 'countdown':
        return s.wave >= s.totalWaves - 2 ? 'tensionFull' : s.wave >= 2 ? 'tension' : 'calm';
      default: {
        const last = s.wave >= s.totalWaves - 1;
        if (this.threat > 0.65 || (last && this.threat > 0.35)) return 'danger';
        if (this.threat > 0.25 || last) return 'combat';
        return 'tensionFull';
      }
    }
  }

  /** A musical sting over the score: a wave announced, something big arriving. */
  sting(kind: 'intro' | 'tense') {
    this.music.duck(0.3, 3);
    this.audio.play(kind === 'intro' ? 'stingerIntro' : 'stingerTense', { bus: 'music', volume: 1, reverb: 0.1, priority: 9 });
  }
}
