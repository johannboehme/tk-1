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
  return renderScorePcm(
    buildDemoScore(spec),
    songDurationS(spec),
    spec.sampleRate,
  );
}

/** Synthesize a note list into mono PCM. Shared by the direct-mode song
 *  and the long-form session render. */
function renderScorePcm(
  score: DemoNote[],
  durationS: number,
  sr: number,
): Float32Array {
  const totalLen = Math.round(durationS * sr);
  const out = new Float32Array(totalLen);

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

// -----------------------------------------------------------------------------
// Long-form session — the same four voices arranged as a rehearsal-room
// recording: several distinct musical fragments at ONE tempo, separated
// by real silence so Triage's chunk detection has honest work to do.
// -----------------------------------------------------------------------------

/** What a section plays. Each style uses a different subset/pattern of
 *  the four voices so the chunks feel like different moments of a
 *  session (drum check, bass groove, full take, quiet noodling). */
export type DemoSectionStyle = "drums" | "bass-groove" | "full" | "sparse";

export interface DemoSessionSection {
  style: DemoSectionStyle;
  bars: number;
  /** Silence after this section, in whole bars — keeps every section
   *  start on the session's single bar grid. One bar at 112 BPM is
   *  ~2.14 s, comfortably past Triage's 1.5 s min-pause. */
  gapBars: number;
}

export interface DemoSessionSpec {
  bpm: number;
  beatsPerBar: number;
  sampleRate: number;
  /** Silence before the first section — recorders roll before the band
   *  plays, and chunk starts shouldn't sit at master-time 0. */
  leadInS: number;
  sections: DemoSessionSection[];
}

/** ~48 s session: drum check → bass groove → full take → sparse noodle,
 *  all at 112 BPM. One-bar gaps read as clean silence (the synth
 *  envelopes stop at each note's end); the sparse outro is deliberately
 *  short and quiet — a natural "reject me" candidate in Triage. */
export const DEMO_SESSION: DemoSessionSpec = {
  bpm: DEMO_SONG.bpm,
  beatsPerBar: DEMO_SONG.beatsPerBar,
  sampleRate: DEMO_SONG.sampleRate,
  leadInS: 1.0,
  sections: [
    { style: "drums", bars: 4, gapBars: 1 },
    { style: "bass-groove", bars: 4, gapBars: 1 },
    { style: "full", bars: 8, gapBars: 1 },
    { style: "sparse", bars: 2, gapBars: 1 },
  ],
};

export interface DemoSessionSectionSpan {
  startS: number;
  endS: number;
  style: DemoSectionStyle;
}

export interface DemoSessionScore {
  notes: DemoNote[];
  durationS: number;
  /** Loud regions on the session timeline — what Triage should find. */
  sections: DemoSessionSectionSpan[];
}

export function sessionDurationS(spec: DemoSessionSpec = DEMO_SESSION): number {
  const barS = spec.beatsPerBar * (60 / spec.bpm);
  let total = spec.leadInS;
  for (const s of spec.sections) {
    total += (s.bars + s.gapBars) * barS;
  }
  return total;
}

/** Notes for one bar of a given style. `globalBar` keeps the bass-root
 *  cycle and lead pattern rotating continuously across sections. */
function sectionBarNotes(
  style: DemoSectionStyle,
  barStartS: number,
  globalBar: number,
  beat: number,
  beatsPerBar: number,
): DemoNote[] {
  const notes: DemoNote[] = [];
  const root = BASS_ROOTS_HZ[globalBar % BASS_ROOTS_HZ.length];

  const kick = (atS: number, gain = 0.9) =>
    notes.push({ atS, durS: 0.25, freqHz: 0, voice: "kick", gain });
  const hat = (atS: number, gain = 0.22) =>
    notes.push({ atS, durS: 0.06, freqHz: 0, voice: "hat", gain });
  const bass = (atS: number, durS: number, gain = 0.5) =>
    notes.push({ atS, durS, freqHz: root, voice: "bass", gain });

  switch (style) {
    case "drums": {
      // Four-on-the-floor kick, offbeat hats — a drum check.
      for (let b = 0; b < beatsPerBar; b++) {
        const atS = barStartS + b * beat;
        kick(atS);
        hat(atS + beat / 2, 0.28);
      }
      break;
    }
    case "bass-groove": {
      // Kick on 1 and 3, syncopated bass, hats keep eighths.
      for (let b = 0; b < beatsPerBar; b++) {
        const atS = barStartS + b * beat;
        if (b % 2 === 0) kick(atS);
        hat(atS + beat / 2);
      }
      bass(barStartS, beat * 0.9);
      bass(barStartS + 1.5 * beat, beat * 0.4, 0.42);
      bass(barStartS + 2 * beat, beat * 0.9);
      bass(barStartS + 3.5 * beat, beat * 0.4, 0.42);
      break;
    }
    case "full": {
      // The direct-mode song's full-arrangement bar.
      for (let b = 0; b < beatsPerBar; b++) {
        const atS = barStartS + b * beat;
        kick(atS);
        hat(atS + beat / 2);
        if (b % 2 === 0) bass(atS, beat * 0.9);
      }
      for (let e = 0; e < LEAD_PATTERN.length; e++) {
        const idx = LEAD_PATTERN[(e + globalBar) % LEAD_PATTERN.length];
        notes.push({
          atS: barStartS + e * (beat / 2),
          durS: beat * 0.45,
          freqHz: LEAD_SCALE_HZ[idx % LEAD_SCALE_HZ.length],
          voice: "lead",
          gain: 0.32,
        });
      }
      break;
    }
    case "sparse": {
      // No kick — one soft bass note per bar and quiet quarter hats.
      // Short + low-energy: the session's "reject me" Triage candidate.
      bass(barStartS, beat * 1.8, 0.4);
      for (let b = 0; b < beatsPerBar; b++) {
        hat(barStartS + b * beat, 0.12);
      }
      break;
    }
  }
  return notes;
}

/** Build the full session score: sections at one BPM with silent gaps. */
export function buildDemoSessionScore(
  spec: DemoSessionSpec = DEMO_SESSION,
): DemoSessionScore {
  const beat = 60 / spec.bpm;
  const notes: DemoNote[] = [];
  const sections: DemoSessionSectionSpan[] = [];
  // Sections AND gaps are whole bars, so the entire session shares one
  // bar grid anchored at leadInS — "one tempo" in the strictest sense.
  const barS = spec.beatsPerBar * beat;
  let cursor = spec.leadInS;
  let globalBar = 0;
  for (const s of spec.sections) {
    const startS = cursor;
    for (let bar = 0; bar < s.bars; bar++) {
      notes.push(
        ...sectionBarNotes(s.style, startS + bar * barS, globalBar, beat, spec.beatsPerBar),
      );
      globalBar++;
    }
    const endS = startS + s.bars * barS;
    sections.push({ startS, endS, style: s.style });
    cursor = endS + s.gapBars * barS;
  }
  notes.sort((a, b) => a.atS - b.atS);
  return { notes, durationS: sessionDurationS(spec), sections };
}

/** Render the long-form session to mono PCM. Deterministic. */
export function renderDemoSessionPcm(
  spec: DemoSessionSpec = DEMO_SESSION,
): Float32Array {
  const score = buildDemoSessionScore(spec);
  return renderScorePcm(score.notes, score.durationS, spec.sampleRate);
}
