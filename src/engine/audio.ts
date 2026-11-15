import * as THREE from 'three';
import { fetchBuffer } from './assets.ts';

/** Mixer channels. Each has its own volume (the settings menu sets them). */
export type Bus = 'sfx' | 'weapons' | 'voice' | 'music' | 'ambience' | 'ui';
const BUSES: Bus[] = ['sfx', 'weapons', 'voice', 'music', 'ambience', 'ui'];

interface Group {
  buffers: AudioBuffer[];
  playing: number;
  last: number;
  lastIndex: number;
}

export interface PlayOptions {
  volume?: number;
  /** World position for 3D sounds; omit for UI and the player's own sounds. */
  at?: THREE.Vector3;
  /** Distance (m) at which the sound starts to fade. */
  near?: number;
  /** Maximum simultaneous plays of this group. */
  limit?: number;
  /** Minimum seconds between plays of this group. */
  spacing?: number;
  /** Playback rate (1 = as recorded). */
  rate?: number;
  /** Random pitch spread in semitones (±). */
  pitch?: number;
  bus?: Bus;
  /** How much goes to the reverb, 0..1 (far sounds get more on their own). */
  reverb?: number;
  /** Arrive late with distance, at the speed of sound (cannons, explosions). */
  delay?: boolean;
  /** Higher survives voice stealing. */
  priority?: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  priority: number;
  started: number;
  end: number;
}

const SPEED_OF_SOUND = 343;
const MAX_VOICES = 80;

/**
 * Game audio on Web Audio: groups of sample variants, synthesized layers, mixer buses into a
 * master compressor, an outdoor reverb, 3D panning with air absorption (far sounds lose their
 * highs) and speed-of-sound delay, and priority-based voice stealing so a 400-unit battle
 * keeps the sounds that matter.
 */
/** Decoded sound: its channels' samples (-1..1) and its rate. */
export interface Pcm {
  channels: Float32Array[];
  sampleRate: number;
}

/** A decoder for files the browser can't decode (a plugin's: setAudioDecoder), or null where it isn't one of its. */
let decoder: ((data: ArrayBuffer) => Pcm | null) | null = null;

export function setAudioDecoder(fn: (data: ArrayBuffer) => Pcm | null) {
  decoder = fn;
}

export class Audio {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private compressor = this.ctx.createDynamicsCompressor();
  private buses = new Map<Bus, GainNode>();
  /** After each bus's own volume: the gain ducking pulls down under the player's gun. */
  private duckers = new Map<Bus, GainNode>();
  private reverbIn = this.ctx.createGain();
  private groups = new Map<string, Group>();
  private voices: Voice[] = [];
  /** Every loop still sounding, to hush (a mission ending). */
  private loops = new Set<Loop>();
  private listener = new THREE.Vector3();

  constructor() {
    const c = this.compressor;
    c.threshold.value = -16;
    c.knee.value = 12;
    c.ratio.value = 5;
    c.attack.value = 0.004;
    c.release.value = 0.22;
    this.master.connect(c).connect(this.ctx.destination);
    for (const b of BUSES) {
      const g = this.ctx.createGain();
      const duck = this.ctx.createGain();
      g.connect(duck).connect(this.master);
      this.buses.set(b, g);
      this.duckers.set(b, duck);
    }
    this.buses.get('music')!.gain.value = 0.42;
    this.buses.get('ambience')!.gain.value = 0.55;
    // A dry desert canyon: short pre-delay, a second and a half of darkening tail.
    const reverb = this.ctx.createConvolver();
    reverb.buffer = this.impulse(1.7, 0.018);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbIn.connect(reverb).connect(wet).connect(this.master);
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  bus(name: Bus): GainNode {
    return this.buses.get(name)!;
  }

  setVolume(bus: Bus | 'master', v: number) {
    (bus === 'master' ? this.master : this.bus(bus)).gain.value = v;
  }

  /**
   * Sidechain ducking: the score and the ambience dip for a moment under a loud close sound
   * (the player's own gun), so it hits harder without the mix getting any louder.
   */
  duck(depth: number, release: number, buses: Bus[] = ['music', 'ambience']) {
    const t = this.ctx.currentTime;
    for (const b of buses) {
      const g = this.duckers.get(b)!.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(Math.min(g.value, 1 - depth), t + 0.006);
      g.setTargetAtTime(1, t + 0.04, release / 3);
    }
  }

  /** Loads the variants of a sound group from their addresses (the original pack's, or a plugin's). */
  async loadUrls(name: string, urls: string[]): Promise<void> {
    const buffers = await Promise.all(urls.map((u) => this.decodeUrl(u)));
    this.add(name, buffers.filter((b): b is AudioBuffer => !!b));
  }

  /** Fetches and decodes one file: by a plugin's decoder where one knows it (setAudioDecoder), else by the browser. */
  async decodeUrl(url: string): Promise<AudioBuffer | null> {
    const data = await fetchBuffer(url);
    if (!data) return null;
    const pcm = decoder?.(data);
    if (pcm) {
      const b = this.ctx.createBuffer(pcm.channels.length, Math.max(1, pcm.channels[0].length), pcm.sampleRate);
      pcm.channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      return b;
    }
    try {
      return await this.ctx.decodeAudioData(data.slice(0));
    } catch {
      return null;
    }
  }

  /** Registers ready-made buffers (synthesized layers) as a group. */
  add(name: string, buffers: AudioBuffer[]) {
    this.groups.set(name, { buffers, playing: 0, last: -1, lastIndex: -1 });
  }

  has(name: string): boolean {
    return (this.groups.get(name)?.buffers.length ?? 0) > 0;
  }

  /** Keeps 3D sounds relative to the camera. */
  setListener(camera: THREE.Camera) {
    const l = this.ctx.listener;
    const p = camera.getWorldPosition(this.listener);
    const f = camera.getWorldDirection(new THREE.Vector3());
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.01);
      l.positionY.setTargetAtTime(p.y, t, 0.01);
      l.positionZ.setTargetAtTime(p.z, t, 0.01);
      l.forwardX.setTargetAtTime(f.x, t, 0.01);
      l.forwardY.setTargetAtTime(f.y, t, 0.01);
      l.forwardZ.setTargetAtTime(f.z, t, 0.01);
      l.upX.setTargetAtTime(u.x, t, 0.01);
      l.upY.setTargetAtTime(u.y, t, 0.01);
      l.upZ.setTargetAtTime(u.z, t, 0.01);
    }
  }

  /** Distance from the listener, meters. */
  distance(at: THREE.Vector3): number {
    return this.listener.distanceTo(at);
  }

  /** Plays one variant of a group (never the same one twice running). Returns the source, if it played. */
  play(name: string, opts: PlayOptions = {}): AudioBufferSourceNode | null {
    const g = this.groups.get(name);
    if (!g || !g.buffers.length || this.ctx.state !== 'running') return null;
    const now = this.ctx.currentTime;
    if (opts.limit !== undefined && g.playing >= opts.limit) return null;
    if (opts.spacing !== undefined && now - g.last < opts.spacing) return null;
    let volume = opts.volume ?? 1;
    const dist = opts.at ? this.distance(opts.at) : 0;
    const near = opts.near ?? 8;
    // Too far to matter: skip it rather than spend a voice.
    if (opts.at && volume * (near / Math.max(near, dist)) < 0.012) return null;
    const priority = (opts.priority ?? 1) * volume * (opts.at ? near / Math.max(near, dist) : 1.5);
    if (!this.claimVoice(priority)) return null;
    g.last = now;

    let index = Math.floor(Math.random() * g.buffers.length);
    if (g.buffers.length > 1 && index === g.lastIndex) index = (index + 1) % g.buffers.length;
    g.lastIndex = index;
    const src = this.ctx.createBufferSource();
    src.buffer = g.buffers[index];
    const semis = opts.pitch ? (Math.random() * 2 - 1) * opts.pitch : 0;
    src.playbackRate.value = (opts.rate ?? 1) * Math.pow(2, semis / 12);
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    const out = this.bus(opts.bus ?? 'sfx');
    let reverb = opts.reverb ?? 0.15;
    if (opts.at) {
      // Air absorbs the highs over distance; far sounds are mostly reverb.
      const lowpass = this.ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = THREE.MathUtils.clamp(22000 * Math.exp(-dist / 140), 900, 22000);
      lowpass.Q.value = 0.5;
      const panner = this.ctx.createPanner();
      panner.panningModel = dist < 30 ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = near;
      panner.rolloffFactor = 1.1;
      panner.positionX.value = opts.at.x;
      panner.positionY.value = opts.at.y;
      panner.positionZ.value = opts.at.z;
      gain.connect(lowpass).connect(panner).connect(out);
      reverb = Math.min(1, reverb * (1 + dist / 120));
      if (reverb > 0) {
        const send = this.ctx.createGain();
        send.gain.value = reverb * volume * Math.min(1, (near * 2) / Math.max(near, dist));
        src.connect(send).connect(this.reverbIn);
      }
    } else {
      gain.connect(out);
      if (reverb > 0) {
        const send = this.ctx.createGain();
        send.gain.value = reverb;
        gain.connect(send).connect(this.reverbIn);
      }
    }
    const when = opts.delay && opts.at ? now + dist / SPEED_OF_SOUND : now;
    g.playing++;
    const voice: Voice = { src, priority, started: now, end: when + src.buffer.duration / src.playbackRate.value };
    this.voices.push(voice);
    src.onended = () => {
      g.playing--;
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    src.start(when);
    return src;
  }

  /** Room for one more voice, stealing the least important one if it's less important than this. */
  private claimVoice(priority: number): boolean {
    if (this.voices.length < MAX_VOICES) return true;
    let worst: Voice | null = null;
    for (const v of this.voices) if (!worst || v.priority < worst.priority) worst = v;
    if (!worst || worst.priority >= priority) return false;
    try {
      worst.src.stop();
    } catch {
      // Already stopped.
    }
    this.voices.splice(this.voices.indexOf(worst), 1);
    return true;
  }

  /** A looping sound on a bus, with a handle to fade it. */
  loop(name: string, bus: Bus, volume = 1): Loop | null {
    const g = this.groups.get(name);
    if (!g?.buffers.length) return null;
    const loop = new Loop(this.ctx, g.buffers[0], this.bus(bus), volume, () => this.loops.delete(loop));
    this.loops.add(loop);
    return loop;
  }

  /** Silences everything sounding, in a moment: a mission ending, the next one's sounds to come. The sounds stay loaded. */
  hush(seconds = 0.25) {
    for (const l of [...this.loops]) l.stop(seconds);
    for (const v of this.voices.splice(0)) {
      try {
        v.src.stop(this.ctx.currentTime + seconds);
      } catch {
        // Already stopped.
      }
    }
  }

  /** Stereo impulse response: noise under an exponential decay that darkens as it goes. */
  private impulse(seconds: number, preDelay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * (seconds + preDelay));
    const ir = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let low = 0;
      for (let i = Math.floor(preDelay * rate); i < length; i++) {
        const t = i / rate - preDelay;
        const env = Math.exp((-6.9 * t) / seconds);
        // A one-pole lowpass whose cutoff falls over the tail.
        const k = 0.6 * Math.exp(-t * 2.2) + 0.04;
        low += k * ((Math.random() * 2 - 1) - low);
        // A few discrete early reflections off canyon walls.
        const early = t < 0.12 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 2.5 : 0;
        data[i] = (low + early) * env * 0.55;
      }
    }
    return ir;
  }
}

/** A looping buffer with smooth volume changes. */
export class Loop {
  private src: AudioBufferSourceNode;
  private gain: GainNode;

  constructor(
    private ctx: AudioContext,
    buffer: AudioBuffer,
    out: AudioNode,
    volume: number,
    private ended: () => void = () => undefined,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    this.src.loop = true;
    this.src.connect(this.gain).connect(out);
    this.src.start();
    this.fade(volume, 1.5);
  }

  fade(volume: number, seconds = 0.5) {
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(volume, t, Math.max(0.01, seconds / 3));
  }

  stop(seconds = 1) {
    this.fade(0, seconds);
    try {
      this.src.stop(this.ctx.currentTime + seconds * 2);
    } catch {
      // Already stopped.
    }
    this.ended();
  }
}
