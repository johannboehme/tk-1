/**
 * Uniform P-FX modulation engine.
 *
 * Every Punch-In effect shares the SAME control surface:
 *   - 2 opinionated macros (see catalog `macros`) shape the look.
 *   - an always-on ADSR `envelope` shapes the punch over the region.
 *   - exactly ONE time-modulator — `lfo` OR `sidechain` — drives the
 *     intensity over time. Never both at once.
 *
 * The output is a single `level` ∈ [0,1] (intensity) that flows into the
 * effect's `applyIntensity` so each kind dims itself sensibly, plus a
 * `phase` ∈ [0,1] that effects with internal periodic geometry (zoom
 * pulse, echo sweep, …) can read while in LFO mode.
 *
 *   level = envelope ⊗ modulator,  modulator = lfo | sidechain
 *
 * This module is pure and has no DOM / store / time-source dependencies —
 * the renderer (live + export) and the sidechain widget all call the same
 * functions so preview == export and the on-screen preview band == what
 * actually renders.
 */
import { envelopeAt, type ADSREnvelope } from "./envelope";

// ── LFO ──────────────────────────────────────────────────────────────

export type LfoShape = "sine" | "triangle" | "saw" | "ramp" | "square";

export interface LfoConfig {
  shape: LfoShape;
  /** Bipolar 0..1 encoder value. Left half (< 0.5) = FREE (continuous Hz),
   *  right half (> 0.5) = SYNCED to a beat-division. Center = slowest. The
   *  same value drives both the rendered period and the UI label via
   *  {@link bipolarRatePeriodS} / {@link bipolarRateLabel} — one source of
   *  truth, so the displayed division can never disagree with what renders.
   */
  rate: number;
  /** When true (and on the synced half with a known BPM) the phase is
   *  anchored to the GLOBAL beat grid in master-time, so pulses land on
   *  the song's beats with a crisp onset — not drifting from where the
   *  punch happened to start. */
  beatSync: boolean;
}

// ── Sidechain ────────────────────────────────────────────────────────

export interface SidechainConfig {
  /** Master-audio loudness (0..1) at/above which the effect engages. */
  threshold: number;
  /** Follower rise time (s) — how fast intensity chases a rising signal. */
  attackS: number;
  /** Follower fall time (s) — how fast it relaxes after a transient. */
  releaseS: number;
  /** false (default) = loud → stronger (kick triggers the effect);
   *  true = loud → weaker (Ableton-style ducking). */
  invert: boolean;
}

// ── Modulation (per-fx) ──────────────────────────────────────────────

export interface Modulation {
  /** Always-on amplitude envelope over the region. */
  envelope: ADSREnvelope;
  /** Exactly one time-modulator is active. */
  timeMod: "lfo" | "sidechain";
  /** 0 = modulator does nothing (envelope only / full), 1 = full swing. */
  depth: number;
  lfo: LfoConfig;
  side: SidechainConfig;
}

/** A normalized loudness curve sampled at a fixed frame-rate, indexed by
 *  master-audio seconds. Produced from the master PCM (see
 *  {@link buildFollowerCurve}) and shared by renderer + widget. */
export interface AudioEnvelope {
  /** 0..1 samples. */
  data: readonly number[] | Float32Array;
  /** Samples per second. */
  fps: number;
}

export const DEFAULT_LFO: LfoConfig = Object.freeze({
  shape: "sine",
  rate: 0.75, // synced side, mid → a musical default division
  beatSync: true,
});

export const DEFAULT_SIDECHAIN: SidechainConfig = Object.freeze({
  threshold: 0.35,
  attackS: 0.01,
  releaseS: 0.18,
  invert: false,
});

export const DEFAULT_MODULATION: Modulation = Object.freeze({
  envelope: { attackS: 0.04, decayS: 0, sustain: 1, releaseS: 0.25 },
  timeMod: "lfo",
  depth: 1,
  lfo: DEFAULT_LFO,
  side: DEFAULT_SIDECHAIN,
});

// ── Beat-division mapping (single source of truth) ───────────────────
//
// Synced rate stops, ordered SLOW → FAST. `beats` = quarter-note beats per
// cycle (1/4 note = 1 beat). TE convention: nearest to centre = slowest,
// far right = fastest. The UI label and the rendered period BOTH derive
// from this table, so "what the knob says" always equals "what renders".

interface Division {
  label: string;
  /** Quarter-note beats per LFO cycle. */
  beats: number;
}

const DIVISIONS: readonly Division[] = [
  { label: "4", beats: 16 }, // whole·4  (slowest)
  { label: "2", beats: 8 },
  { label: "1", beats: 4 }, // whole note / 1 bar in 4/4
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1 }, // quarter note = 1 beat
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 }, // (fastest)
];

const FREE_SLOW_S = 2.0; // period near centre (slowest free)
const FREE_FAST_S = 0.04; // period at full left (fastest free)
const CENTER = 0.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Is the bipolar rate on the beat-synced (right) half? */
export function isSyncedRate(rate: number): boolean {
  return rate > CENTER;
}

/** Map a right-half rate (0.5..1) to a slow→fast division bucket. */
function syncedDivision(rate: number): Division {
  const t = clamp01((rate - CENTER) / CENTER); // 0..1
  const idx = Math.min(
    DIVISIONS.length - 1,
    Math.max(0, Math.round(t * DIVISIONS.length - 0.5)),
  );
  return DIVISIONS[idx];
}

/**
 * Resolve the LFO period in seconds from the bipolar rate.
 *  - Right half: beat-synced division at the REAL `bpm` (60/bpm * beats).
 *    Falls back to a 120-BPM equivalent only when bpm is unknown.
 *  - Left half: free continuous period, slowest near centre.
 */
export function bipolarRatePeriodS(rate: number, bpm: number | null): number {
  if (isSyncedRate(rate)) {
    const div = syncedDivision(rate);
    const beatS = bpm && bpm > 0 ? 60 / bpm : 0.5; // 0.5s = one beat @120
    return beatS * div.beats;
  }
  const t = clamp01((CENTER - rate) / CENTER); // 0 near centre, 1 full left
  return FREE_SLOW_S + t * (FREE_FAST_S - FREE_SLOW_S);
}

/** Human label for the bipolar rate — the SAME mapping the renderer uses. */
export function bipolarRateLabel(rate: number, bpm: number | null): string {
  if (isSyncedRate(rate)) return syncedDivision(rate).label;
  const periodS = bipolarRatePeriodS(rate, bpm);
  const hz = periodS > 0 ? 1 / periodS : 0;
  return `${hz.toFixed(hz < 10 ? 1 : 0)}HZ`;
}

// ── LFO shape (unipolar 0..1, peak ON the beat at phase 0) ────────────

/** Sample an LFO `shape` at `phase` ∈ [0,1) → 0..1. phase 0 = on the beat;
 *  shapes are oriented so the "strong" moment sits on the beat. */
export function lfoShapeAt(shape: LfoShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case "sine":
      // Cosine bell: 1 on the beat, dips to 0 at the half, back to 1.
      return (Math.cos(2 * Math.PI * p) + 1) / 2;
    case "triangle":
      // 1 on the beat, linear down to 0 at the half, back up.
      return 2 * Math.abs(p - 0.5);
    case "saw":
      // Pluck: snaps to 1 on the beat, ramps down to 0.
      return 1 - p;
    case "ramp":
      // Reverse: builds 0 → 1 across the cycle.
      return p;
    case "square":
      return p < 0.5 ? 1 : 0;
    default:
      return 1;
  }
}

// ── Sidechain follower curve (one source of truth) ───────────────────

function sampleEnv(env: AudioEnvelope, tSeconds: number): number {
  const data = env.data;
  const n = data.length;
  if (n === 0) return 0;
  const fps = env.fps > 0 ? env.fps : 30;
  const x = tSeconds * fps;
  if (x <= 0) return data[0];
  if (x >= n - 1) return data[n - 1];
  const i = Math.floor(x);
  const frac = x - i;
  return data[i] * (1 - frac) + data[i + 1] * frac;
}

/**
 * Turn a raw master-loudness curve into a sidechain FOLLOWER curve:
 * threshold → normalize → asymmetric one-pole (attack/release) → invert.
 * Returns a 0..1 curve at the same fps. Pure & deterministic so the render
 * path (sampled per frame) and the widget's preview band agree exactly.
 */
export function buildFollowerCurve(
  audio: AudioEnvelope,
  side: SidechainConfig,
): AudioEnvelope {
  const src = audio.data;
  const n = src.length;
  const out = new Float32Array(n);
  if (n === 0) return { data: out, fps: audio.fps };
  const fps = audio.fps > 0 ? audio.fps : 30;
  const dt = 1 / fps;

  // One-pole coefficient from a time constant: per-frame retention.
  const coef = (tau: number): number =>
    tau <= 0 ? 0 : Math.exp(-dt / tau);
  const aCoef = coef(side.attackS);
  const rCoef = coef(side.releaseS);
  const denom = Math.max(1e-6, 1 - side.threshold);

  let y = 0;
  for (let i = 0; i < n; i++) {
    // Target: how far the loudness sits above the threshold, 0..1.
    const target = clamp01((src[i] - side.threshold) / denom);
    // Asymmetric smoothing — rises at attack speed, falls at release.
    const c = target > y ? aCoef : rCoef;
    y = target + (y - target) * c;
    out[i] = side.invert ? 1 - y : y;
  }
  return { data: out, fps };
}

/** Sample a (already-built) follower curve at master-time. */
export function sampleFollower(
  curve: AudioEnvelope | null,
  tMasterS: number,
): number {
  if (!curve) return 0;
  return clamp01(sampleEnv(curve, tMasterS));
}

// ── Intensity ────────────────────────────────────────────────────────

export interface ModContext {
  /** Master-audio time — drives beat-synced LFO + sidechain. */
  tMasterS: number;
  /** Timeline time — drives the region-local envelope. */
  tTimelineS: number;
  /** Region start (timeline). */
  regionInS: number;
  /** Region duration (timeline). */
  regionDurS: number;
  /** True while the pad is held (envelope skips release). */
  holding: boolean;
  bpm: number | null;
  /** Master-time of beat 0 (for grid-anchored beat-sync). */
  beatPhaseS: number;
  beatsPerBar: number;
  /** Prebuilt sidechain follower curve for THIS fx (see
   *  {@link buildFollowerCurve}). Only read in sidechain mode. */
  sidechainCurve: AudioEnvelope | null;
}

export interface ModResult {
  /** Intensity 0..1 → feeds `applyIntensity`. */
  level: number;
  /** Cycle phase 0..1 — meaningful in LFO mode (0 in sidechain mode). */
  phase: number;
}

/** Compute the LFO phase for the current frame. Beat-synced + grid-anchored
 *  uses master-time so pulses land on the song beats; otherwise the cycle
 *  is anchored to the region start (free-running from the punch). */
export function lfoPhaseAt(lfo: LfoConfig, ctx: ModContext): number {
  const periodS = bipolarRatePeriodS(lfo.rate, ctx.bpm);
  if (!(periodS > 0) || !Number.isFinite(periodS)) return 0;
  let elapsed: number;
  if (lfo.beatSync && isSyncedRate(lfo.rate) && ctx.bpm && ctx.bpm > 0) {
    elapsed = ctx.tMasterS - ctx.beatPhaseS;
  } else {
    elapsed = ctx.tTimelineS - ctx.regionInS;
  }
  const phase = (elapsed / periodS) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/**
 * The heart: intensity = envelope ⊗ (lfo | sidechain), blended by `depth`.
 *  - depth 0 → modulator is a no-op (envelope only, effect at full).
 *  - depth 1 → full modulator swing.
 */
export function computeIntensity(mod: Modulation, ctx: ModContext): ModResult {
  const envLevel = envelopeAt(
    mod.envelope,
    ctx.regionDurS,
    ctx.tTimelineS - ctx.regionInS,
    ctx.holding,
  );
  if (envLevel <= 0) return { level: 0, phase: 0 };

  let raw: number;
  let phase = 0;
  if (mod.timeMod === "lfo") {
    phase = lfoPhaseAt(mod.lfo, ctx);
    raw = lfoShapeAt(mod.lfo.shape, phase);
  } else {
    raw = sampleFollower(ctx.sidechainCurve, ctx.tMasterS);
  }

  const depth = clamp01(mod.depth);
  const modLevel = 1 - depth + depth * clamp01(raw);
  return { level: clamp01(envLevel * modLevel), phase };
}
