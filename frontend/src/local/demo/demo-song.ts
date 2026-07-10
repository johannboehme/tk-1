/**
 * Demo-song synthesis — a small, fully deterministic instrumental
 * rendered as raw PCM with plain math (no WebAudio, no assets, nothing
 * checked in). Four voices over an A-minor vamp:
 *
 *   kick — pitch-swept sine on every beat
 *   bass — root notes walking A / F / C / G, two hits per bar
 *   lead — pentatonic eighth-note line from bar 3 on
 *   hat  — noise ticks on the offbeats
 *
 * The result doubles as the master audio of the demo project and (in
 * per-cam slices) as the audio track of the synthesized demo videos,
 * so the real sync pipeline has genuine same-source material to lock
 * onto.
 */

export interface DemoSongSpec {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  sampleRate: number;
}

export const DEMO_SONG: DemoSongSpec = {
  bpm: 112,
  beatsPerBar: 4,
  bars: 8,
  sampleRate: 44100,
};

export function beatDurationS(spec: DemoSongSpec = DEMO_SONG): number {
  return 60 / spec.bpm;
}

export function songDurationS(spec: DemoSongSpec = DEMO_SONG): number {
  return spec.bars * spec.beatsPerBar * beatDurationS(spec);
}

export type DemoVoice = "kick" | "bass" | "lead" | "hat";

export interface DemoNote {
  /** Start position in the song (seconds). */
  atS: number;
  /** Nominal note length (seconds); envelopes may end earlier. */
  durS: number;
  /** Fundamental (Hz). The kick ignores this — its pitch is swept. */
  freqHz: number;
  voice: DemoVoice;
  /** Per-note gain, 0..1. */
  gain: number;
}

/** Bass roots per bar: Am / F / C / G, cycled. */
const BASS_ROOTS_HZ = [55.0, 43.65, 65.41, 49.0];

/** A-minor pentatonic pool for the lead line. */
const LEAD_SCALE_HZ = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

/** Eighth-note scale indices, one bar long, cycled per bar. */
const LEAD_PATTERN = [0, 2, 3, 4, 3, 2, 4, 5];

/** First bar (0-based) in which the lead line enters. */
const LEAD_ENTRY_BAR = 2;

/** Build the full deterministic note list, sorted by start time. */
export function buildDemoScore(spec: DemoSongSpec = DEMO_SONG): DemoNote[] {
  const beat = beatDurationS(spec);
  const notes: DemoNote[] = [];

  for (let bar = 0; bar < spec.bars; bar++) {
    const barStartS = bar * spec.beatsPerBar * beat;
    const root = BASS_ROOTS_HZ[bar % BASS_ROOTS_HZ.length];

    for (let b = 0; b < spec.beatsPerBar; b++) {
      const atS = barStartS + b * beat;
      notes.push({ atS, durS: 0.25, freqHz: 0, voice: "kick", gain: 0.9 });
      notes.push({
        atS: atS + beat / 2,
        durS: 0.06,
        freqHz: 0,
        voice: "hat",
        gain: 0.22,
      });
      if (b % 2 === 0) {
        notes.push({
          atS,
          durS: beat * 0.9,
          freqHz: root,
          voice: "bass",
          gain: 0.5,
        });
      }
    }

    if (bar >= LEAD_ENTRY_BAR) {
      for (let e = 0; e < LEAD_PATTERN.length; e++) {
        const idx = LEAD_PATTERN[(e + bar) % LEAD_PATTERN.length];
        notes.push({
          atS: barStartS + e * (beat / 2),
          durS: beat * 0.45,
          freqHz: LEAD_SCALE_HZ[idx % LEAD_SCALE_HZ.length],
          voice: "lead",
          gain: 0.32,
        });
      }
    }
  }

  notes.sort((a, b) => a.atS - b.atS);
  return notes;
}

/** Deterministic xorshift32 PRNG in [-1, 1] — Math.random would make
 *  the render non-reproducible across calls. */
function makeNoise(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** Render the whole song to mono Float32 PCM. Deterministic; peak is
 *  normalized to a healthy non-clipping level. */
export function renderDemoSongPcm(spec: DemoSongSpec = DEMO_SONG): Float32Array {
  const sr = spec.sampleRate;
  const totalLen = Math.round(songDurationS(spec) * sr);
  const out = new Float32Array(totalLen);
  const score = buildDemoScore(spec);

  for (const note of score) {
    const start = Math.round(note.atS * sr);
    const len = Math.min(Math.round(note.durS * sr), totalLen - start);
    if (len <= 0) continue;

    switch (note.voice) {
      case "kick": {
        // Pitch sweep 120 → 40 Hz; phase is the integral of the freq
        // envelope so the sweep stays click-free.
        let phase = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const f = 40 + 80 * Math.exp(-t * 35);
          phase += (2 * Math.PI * f) / sr;
          const amp = Math.exp(-t * 18);
          out[start + i] += Math.sin(phase) * amp * note.gain;
        }
        break;
      }
      case "bass": {
        const w = 2 * Math.PI * note.freqHz;
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const env = Math.min(1, t / 0.005) * Math.exp(-t * 5);
          const s =
            Math.sin(w * t) + 0.35 * Math.sin(2 * w * t) + 0.15 * Math.sin(3 * w * t);
          out[start + i] += s * env * note.gain;
        }
        break;
      }
      case "lead": {
        const w = 2 * Math.PI * note.freqHz;
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const env = Math.min(1, t / 0.01) * Math.exp(-t * 6);
          const s = Math.sin(w * t) + 0.3 * Math.sin(2.01 * w * t);
          out[start + i] += s * env * note.gain;
        }
        break;
      }
      case "hat": {
        // Fresh seeded noise per note keeps the render deterministic.
        const noise = makeNoise(start + 1);
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const n = noise();
          // First difference ≈ crude highpass — reads as a hat tick.
          const hp = n - prev;
          prev = n;
          out[start + i] += hp * Math.exp(-t * 80) * note.gain;
        }
        break;
      }
    }
  }

  // Normalize the peak to a healthy level (≈ -1.5 dBFS), never boost
  // above the natural level of a quiet render.
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const target = 0.84;
    const scale = Math.min(target / peak, 1);
    if (scale < 1) {
      for (let i = 0; i < out.length; i++) out[i] *= scale;
    }
  }
  return out;
}
