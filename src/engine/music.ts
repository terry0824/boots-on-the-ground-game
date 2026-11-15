import { mediaUrl } from './assets.ts';
import type { Audio } from './audio.ts';

interface Track {
  el: HTMLAudioElement;
  gain: GainNode;
  name: string;
}

/**
 * Streams the mission score and crossfades between moods. Pieces play from compressed files
 * (two minutes of decoded stereo would be tens of megabytes each), loop, and fade over a few
 * seconds when the mood changes. Stingers play over the top on the music bus.
 */
export class Music {
  private tracks = new Map<string, Track>();
  private current: Track | null = null;
  private pending: string | null = null;
  private changedAt = 0;

  constructor(
    private audio: Audio,
    private paths: Record<string, string>,
  ) {}

  private track(name: string): Track | null {
    let t = this.tracks.get(name);
    if (t) return t;
    const path = this.paths[name];
    if (!path) return null;
    const url = mediaUrl(path);
    // None to be had (the content mode reads nothing from a plugin): silence.
    if (url === '') return null;
    const el = new window.Audio();
    el.loop = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const ctx = this.audio.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain).connect(this.audio.bus('music'));
    const track: Track = { el, gain, name };
    if (typeof url === 'string') el.src = url;
    else {
      // Its file is still being got: a piece asked to play meanwhile starts once it's there.
      void url.then((u) => {
        el.src = u;
        if (this.current === track) void el.play().catch(() => undefined);
      });
    }
    this.tracks.set(name, track);
    return track;
  }

  /** Starts loading pieces ahead of time so the first change of mood is instant. */
  preload(names: string[]) {
    for (const n of names) this.track(n)?.el.load();
  }

  get playing(): string | null {
    return this.current?.name ?? null;
  }

  /**
   * Fades to a piece. Changes are held back for `hold` seconds after the previous one so the
   * score doesn't flicker between moods.
   */
  play(name: string, fade = 3, hold = 8) {
    if (this.current?.name === name) {
      this.pending = null;
      return;
    }
    const now = this.audio.ctx.currentTime;
    if (now - this.changedAt < hold && this.current) {
      this.pending = name;
      return;
    }
    const next = this.track(name);
    if (!next) return;
    const t = this.audio.ctx.currentTime;
    const prev = this.current;
    if (prev) {
      prev.gain.gain.cancelScheduledValues(t);
      prev.gain.gain.setTargetAtTime(0, t, fade / 3);
      const el = prev.el;
      window.setTimeout(() => {
        if (this.current !== prev) el.pause();
      }, fade * 1000 + 500);
    }
    next.el.currentTime = 0;
    void next.el.play().catch(() => undefined);
    next.gain.gain.cancelScheduledValues(t);
    next.gain.gain.setTargetAtTime(1, t, fade / 3);
    this.current = next;
    this.pending = null;
    this.changedAt = now;
  }

  /** Call every frame or so: applies a mood change that was held back. */
  update() {
    if (this.pending) this.play(this.pending);
  }

  /** Dips the score under a stinger or a voice, then brings it back. */
  duck(depth = 0.35, seconds = 2.5) {
    const c = this.current;
    if (!c) return;
    const t = this.audio.ctx.currentTime;
    c.gain.gain.cancelScheduledValues(t);
    c.gain.gain.setTargetAtTime(depth, t, 0.15);
    c.gain.gain.setTargetAtTime(1, t + seconds, 0.8);
  }

  stop(fade = 2) {
    // A change held back would start it again at the next update.
    this.pending = null;
    const c = this.current;
    if (!c) return;
    const t = this.audio.ctx.currentTime;
    c.gain.gain.setTargetAtTime(0, t, fade / 3);
    window.setTimeout(() => c.el.pause(), fade * 1000 + 500);
    this.current = null;
  }
}
