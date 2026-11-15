/**
 * Synthesized sound layers, rendered once at load with an OfflineAudioContext. An RTS's
 * own samples are mixed for a camera hovering over the battlefield; these add what a shooter
 * needs at arm's length: the low punch and supersonic crack of a rifle round, the slap of a
 * round into flesh, the click of a hit marker, the sub-bass of a shell landing.
 */

type Build = (ctx: OfflineAudioContext, out: AudioNode, rnd: () => number) => void;

const RATE = 44100;

function noiseBuffer(ctx: BaseAudioContext, seconds: number, rnd: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, Math.floor(seconds * ctx.sampleRate)), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
  return b;
}

function noise(ctx: OfflineAudioContext, seconds: number, rnd: () => number, at = 0): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, seconds, rnd);
  s.start(at);
  return s;
}

/** A gain node shaped as attack-then-exponential-decay, starting at `at`. */
function env(ctx: OfflineAudioContext, peak: number, attack: number, decay: number, at = 0): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + Math.max(0.0005, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return g;
}

function filter(ctx: OfflineAudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function sweep(ctx: OfflineAudioContext, type: OscillatorType, from: number, to: number, seconds: number, at = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + seconds);
  o.start(at);
  o.stop(at + seconds + 0.05);
  return o;
}

const LAYERS: Record<string, { seconds: number; build: Build }> = {
  /** The low-end shove of a coil rifle round. */
  punch: {
    seconds: 0.2,
    build(ctx, out, r) {
      sweep(ctx, 'sine', 150 + r() * 30, 46, 0.1).connect(env(ctx, 0.9, 0.002, 0.14)).connect(out);
      noise(ctx, 0.01, r).connect(filter(ctx, 'highpass', 900)).connect(env(ctx, 0.5, 0.0005, 0.008)).connect(out);
    },
  },
  /** The snap of the round breaking the sound barrier. */
  crack: {
    seconds: 0.09,
    build(ctx, out, r) {
      noise(ctx, 0.08, r).connect(filter(ctx, 'bandpass', 2400 + r() * 1400, 0.8)).connect(env(ctx, 1, 0.0008, 0.04)).connect(out);
    },
  },
  /**
   * The report rolling back off the canyon walls: a darkening rumble, and a slapback off the
   * nearest wall a sixth of a second later.
   */
  tail: {
    seconds: 1.5,
    build(ctx, out, r) {
      const lp = filter(ctx, 'lowpass', 1800, 0.5);
      lp.frequency.setValueAtTime(1800, 0);
      lp.frequency.exponentialRampToValueAtTime(240, 1.3);
      noise(ctx, 1.4, r).connect(lp).connect(env(ctx, 0.45, 0.025, 1.0)).connect(out);
      const at = 0.15 + r() * 0.08;
      noise(ctx, 0.3, r, at).connect(filter(ctx, 'bandpass', 650 + r() * 350, 0.9)).connect(env(ctx, 0.4, 0.004, 0.2, at)).connect(out);
      sweep(ctx, 'sine', 70, 40, 0.3, at).connect(env(ctx, 0.25, 0.006, 0.25, at)).connect(out);
    },
  },
  /** The rifle's action cycling. */
  mech: {
    seconds: 0.07,
    build(ctx, out, r) {
      for (const t of [0, 0.022 + r() * 0.01]) noise(ctx, 0.02, r, t).connect(filter(ctx, 'bandpass', 4200 + r() * 1500, 5)).connect(env(ctx, 0.7, 0.0005, 0.01, t)).connect(out);
    },
  },
  /** A round hitting carapace and flesh. */
  /** A Crawl bursting. */
  /** A round off armor plate. */
  /** Hit marker. */
  /** Kill confirmed: a thump and a bright ping. */
  /** The sub-bass and roar of a shell or a building going up. */
  /** Debris rattling down after a blast. */
  /** A tank cannon's report. */
  /** Taking a hit. */
  hurt: {
    seconds: 0.3,
    build(ctx, out, r) {
      sweep(ctx, 'sine', 95, 45, 0.18).connect(env(ctx, 0.9, 0.002, 0.2)).connect(out);
      noise(ctx, 0.2, r).connect(filter(ctx, 'lowpass', 600)).connect(env(ctx, 0.5, 0.002, 0.12)).connect(out);
    },
  },
  heartbeat: {
    seconds: 0.7,
    build(ctx, out) {
      for (const [t, a] of [[0, 0.9], [0.26, 0.6]] as const) sweep(ctx, 'sine', 62, 38, 0.1, t).connect(env(ctx, a, 0.006, 0.12, t)).connect(out);
    },
  },
  /** Energy gathering (Keel Gun, Snap Jump). */
  whoosh: {
    seconds: 0.9,
    build(ctx, out, r) {
      const bp = filter(ctx, 'bandpass', 300, 2);
      bp.frequency.setValueAtTime(300, 0);
      bp.frequency.exponentialRampToValueAtTime(3200, 0.8);
      noise(ctx, 0.9, r).connect(bp).connect(env(ctx, 0.8, 0.5, 0.35)).connect(out);
    },
  },
  /** A UI click. */
  /** A radio keying up: the click and hiss between lines of a conversation. */
  squelch: {
    seconds: 0.16,
    build(ctx, out, r) {
      noise(ctx, 0.12, r).connect(filter(ctx, 'bandpass', 2200 + r() * 400, 1.2)).connect(env(ctx, 0.35, 0.002, 0.1)).connect(out);
      noise(ctx, 0.008, r).connect(filter(ctx, 'highpass', 3000)).connect(env(ctx, 0.6, 0.0005, 0.006)).connect(out);
      const o = ctx.createOscillator();
      o.frequency.value = 1250;
      o.start(0.004);
      o.stop(0.05);
      o.connect(env(ctx, 0.08, 0.001, 0.03, 0.004)).connect(out);
    },
  },
  /** An objective asking for attention: two soft rising notes. */
  nudge: {
    seconds: 0.55,
    build(ctx, out, r) {
      for (const [f, at, a] of [[784, 0, 0.32], [1175, 0.11, 0.28]] as const) {
        for (const [mul, gain] of [[1, 1], [2, 0.18]] as const) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f * mul * (0.998 + r() * 0.004);
          o.start(at);
          o.stop(at + 0.42);
          o.connect(env(ctx, a * gain, 0.006, 0.36, at)).connect(out);
        }
      }
    },
  },
  /** Desert wind, four seconds that loop. */
  wind: {
    seconds: 6,
    build(ctx, out, r) {
      const lp = filter(ctx, 'lowpass', 420, 0.6);
      const am = ctx.createGain();
      am.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1 / 6; // one gust per loop, so the loop is seamless
      const depth = ctx.createGain();
      depth.gain.value = 0.35;
      lfo.connect(depth).connect(am.gain);
      lfo.start();
      const g = ctx.createGain();
      g.gain.value = 0.5;
      noise(ctx, 6, r).connect(lp).connect(am).connect(g).connect(out);
    },
  },
};

export type LayerName = keyof typeof LAYERS;

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Renders every layer in a few variations. */
export async function synthesize(variations = 4): Promise<Record<string, AudioBuffer[]>> {
  const out: Record<string, AudioBuffer[]> = {};
  await Promise.all(
    Object.entries(LAYERS).map(async ([name, layer]) => {
      const count = name === 'wind' || name === 'heartbeat' ? 1 : variations;
      out[`synth.${name}`] = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const ctx = new OfflineAudioContext(1, Math.ceil(layer.seconds * RATE), RATE);
          layer.build(ctx, ctx.destination, seeded(1 + i * 7919 + name.length * 104729));
          return ctx.startRendering();
        }),
      );
    }),
  );
  return out;
}
