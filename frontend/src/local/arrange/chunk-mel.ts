/**
 * Per-chunk audio glance helpers for the Arrange page.
 *
 *   - `computeChunkMelSpec` (in worker): mel-spectrogram from a PCM slice.
 *   - `chunkAutoTags`: cheap derived stats (KEY, density, brightness,
 *     peak dB) from the existing master `AudioAnalysis`.
 *   - `chunkSpectralColor`: HSL color tag — bass-heavy = warm red,
 *     hi-hat-heavy = cyan, etc. Used by the polaroid + frame badges.
 *   - `chunkStemHeuristic`: best-effort drums / bass / melody / formants
 *     decomposition from the same `AudioAnalysis` band data. NOT a
 *     real stem-separator — labelled accordingly so users don't read
 *     the formants bar as "vocals".
 *
 * The mel pipeline runs in a dedicated worker keyed off the
 * `chunk-mel.worker.ts` module. Computation is per-chunk (PCM slice
 * + `melSpectrogram()` WASM call). Results cache in IDB
 * (`chunk-mel-specs` store) so re-mounts of Arrange skip the work.
 */

import type { AudioAnalysis } from "../render/audio-analysis/types";
import type { Chunk } from "../../storage/jobs-db";

/** Number of mel bins. 64 is the sweet spot: enough vertical resolution
 *  to see formants and kicks, small enough that ~10s chunk = ~20 KB. */
export const MEL_N_MELS = 64;
/** Mel-spec frame rate in fps. 30 means a 33 ms hop — matches Audio
 *  Analysis hop, gives a nice horizontal resolution for the LCD. */
export const MEL_FPS = 30;

export interface ChunkMelData {
  /** Frame-major u8 grayscale, length = `nMels * nFrames`. */
  data: Uint8Array;
  nMels: number;
  nFrames: number;
  /** Source chunk duration (seconds). The renderer divides this by
   *  `nFrames` to map x-pixels to time. */
  durationS: number;
  /** 12-bin pitch-class profile (L2-normalized), class 0 = C. Drives
   *  the Cockpit KEY tag via Krumhansl-Schmuckler matching. */
  chroma: Float32Array;
}

// ─── Worker singleton ────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextRequestId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./chunk-mel.worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return worker;
}

interface WorkerOk {
  type: "result";
  id: number;
  data: Uint8Array;
  nMels: number;
  nFrames: number;
  chroma: Float32Array;
}
interface WorkerErr {
  type: "error";
  id: number;
  message: string;
}
type WorkerReply = WorkerOk | WorkerErr;

/**
 * Compute the mel-spectrogram of a PCM slice in a worker.
 * Resolves with `{ data, nMels, nFrames }`. The caller owns the
 * lifecycle of the input PCM (we copy a view; the underlying buffer
 * is not transferred out from under them).
 */
export async function computeChunkMelSpec(
  pcm: Float32Array,
  sampleRate: number,
): Promise<ChunkMelData> {
  const w = getWorker();
  const id = nextRequestId++;
  return new Promise<ChunkMelData>((resolve, reject) => {
    function onMessage(e: MessageEvent<WorkerReply>) {
      if (e.data.id !== id) return;
      w.removeEventListener("message", onMessage);
      if (e.data.type === "result") {
        resolve({
          data: e.data.data,
          nMels: e.data.nMels,
          nFrames: e.data.nFrames,
          durationS: pcm.length / sampleRate,
          chroma: e.data.chroma,
        });
      } else {
        reject(new Error(e.data.message));
      }
    }
    w.addEventListener("message", onMessage);
    // Copy the slice into a fresh buffer so we can transfer it to the
    // worker without disturbing the caller's master PCM.
    const slice = new Float32Array(pcm.length);
    slice.set(pcm);
    w.postMessage(
      {
        type: "mel",
        id,
        pcm: slice,
        sampleRate,
        nMels: MEL_N_MELS,
        fps: MEL_FPS,
      },
      [slice.buffer],
    );
  });
}

// ─── Auto-tag derivations ────────────────────────────────────────────────

const PITCH_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

const MAJ_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MIN_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

export interface ChunkAutoTags {
  /** Estimated key, e.g. "C MIN" / "G MAJ" / "—" if no signal. */
  key: string;
  /** Onset density 0..3 (mapped to ●●●○ glyph). */
  dens: 0 | 1 | 2 | 3;
  /** Spectral brightness 0..4 — index into a 5-bar sparkline. */
  brgt: 0 | 1 | 2 | 3 | 4;
  /** Peak in dBFS, e.g. -3.2. -Infinity if silent. */
  peakDb: number;
}

const SILENT_TAGS: ChunkAutoTags = {
  key: "—",
  dens: 0,
  brgt: 0,
  peakDb: -Infinity,
};

/** Cheap per-chunk auto-tags derived from the existing master
 *  AudioAnalysis (RMS / bands / onsets). When the chunk's mel-spec is
 *  also available, its 12-bin chroma feeds the KEY estimate via
 *  Krumhansl-Schmuckler. */
export function chunkAutoTags(
  chunk: Chunk,
  analysis: AudioAnalysis | null,
  mel?: ChunkMelData | null,
): ChunkAutoTags {
  if (!analysis) return SILENT_TAGS;
  const fps = analysis.framesPerSec;
  const startIdx = Math.max(0, Math.floor((chunk.startMs / 1000) * fps));
  const endIdx = Math.min(
    analysis.rms.length,
    Math.ceil((chunk.endMs / 1000) * fps),
  );
  if (endIdx <= startIdx) return SILENT_TAGS;

  // Peak RMS → dBFS. AudioAnalysis RMS is linear amplitude.
  let peakLin = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const v = analysis.rms[i];
    if (v > peakLin) peakLin = v;
  }
  const peakDb = peakLin > 1e-6 ? 20 * Math.log10(peakLin) : -Infinity;

  // Onset density — onsets per second, normalised to 0..3.
  const durationS = (chunk.endMs - chunk.startMs) / 1000;
  let onsetCount = 0;
  for (const t of analysis.onsets) {
    const tMs = t * 1000;
    if (tMs >= chunk.startMs && tMs <= chunk.endMs) onsetCount++;
  }
  const onsetsPerSec = durationS > 0 ? onsetCount / durationS : 0;
  // Tuned for typical music: 0–1/s = sparse, ≥4/s = dense.
  const dens: 0 | 1 | 2 | 3 =
    onsetsPerSec < 0.5 ? 0
    : onsetsPerSec < 1.5 ? 1
    : onsetsPerSec < 3 ? 2 : 3;

  // Spectral brightness — high-band / total-band ratio averaged over
  // the chunk, mapped to 0..4 as a 5-step sparkline.
  let bassSum = 0, lowMidSum = 0, midSum = 0, highSum = 0;
  for (let i = startIdx; i < endIdx; i++) {
    bassSum += analysis.bands.bass[i] ?? 0;
    lowMidSum += analysis.bands.lowMids[i] ?? 0;
    midSum += analysis.bands.mids[i] ?? 0;
    highSum += analysis.bands.highs[i] ?? 0;
  }
  const total = bassSum + lowMidSum + midSum + highSum;
  // Brightness ~ centroid index. Compute the energy-weighted band
  // index, then scale to 0..4.
  let centroid = 0;
  if (total > 0) {
    const num =
      0 * bassSum + 1 * lowMidSum + 2 * midSum + 3 * highSum;
    centroid = num / total; // 0..3
  }
  const brgt: 0 | 1 | 2 | 3 | 4 =
    centroid < 0.5 ? 0
    : centroid < 1.0 ? 1
    : centroid < 1.7 ? 2
    : centroid < 2.4 ? 3 : 4;

  // KEY: Krumhansl-Schmuckler over the chunk's 12-bin chroma when the
  // mel-spec (and its bundled chroma) has been computed. While the
  // worker is still chewing through the chunk pool, the field falls
  // back to "—" — that's intentional, KEY snapping in late looks better
  // than a wrong best-guess based on band energies alone.
  const key = mel?.chroma ? keyFromChroma(mel.chroma) : "—";

  return { key, dens, brgt, peakDb };
}

/**
 * Krumhansl-Schmuckler key estimate from a 12-bin chroma vector.
 * Returns the best-matching key as e.g. "C MIN" / "G MAJ".
 *
 * Exposed so a future chroma-slicing path (per-chunk WASM call) can
 * plug in without re-deriving the algorithm.
 */
export function keyFromChroma(chroma: ArrayLike<number>): string {
  if (chroma.length !== 12) return "—";
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i] ?? 0;
  if (total < 1e-6) return "—";
  let bestScore = -Infinity;
  let bestRoot = 0;
  let bestMode: "MAJ" | "MIN" = "MAJ";
  for (let r = 0; r < 12; r++) {
    let majScore = 0, minScore = 0;
    for (let i = 0; i < 12; i++) {
      const idx = (i + r) % 12;
      const c = chroma[idx] ?? 0;
      majScore += c * MAJ_PROFILE[i];
      minScore += c * MIN_PROFILE[i];
    }
    if (majScore > bestScore) {
      bestScore = majScore;
      bestRoot = r;
      bestMode = "MAJ";
    }
    if (minScore > bestScore) {
      bestScore = minScore;
      bestRoot = r;
      bestMode = "MIN";
    }
  }
  return `${PITCH_NAMES[bestRoot]} ${bestMode}`;
}

// ─── Color tag (Phase D) ────────────────────────────────────────────────

/** Phosphor-zone HSL stops for the spectral colour tag. Hue runs from
 *  dusty oxblood at low centroid to pale denim at high centroid; the
 *  stops are deliberately desaturated so the contact-sheet doesn't
 *  turn into a parrot show even when many chunks are present. Each
 *  entry is `[centroid, [h, s, l]]`. Centroid range 0..3 covers our
 *  4-band energy decomposition. */
const SPECTRAL_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0.0, [8, 50, 42]],   // Dusty oxblood   — sub-bass / kicks
  [0.4, [22, 48, 48]],  // Worn copper     — bass-heavy loop
  [0.8, [36, 42, 52]],  // Wheat / brass   — full mix
  [1.2, [64, 32, 54]],  // Olive sand      — mid-rich pad
  [1.6, [108, 28, 50]], // Faded fern      — vocal / formants
  [2.0, [160, 32, 48]], // Steeped sage    — bright melody
  [2.4, [196, 38, 52]], // Misty cyan      — bell / shaker
  [3.0, [214, 42, 60]], // Pale denim      — hi-hat / cymbal
];

/**
 * Derive a single HSL color from a chunk's spectral content. Drives
 * the Polaroid stripe + the Frame mini-dot. Tuned to stay in the
 * phosphor / OP-1 palette zone — desaturated mid-tones that sit
 * comfortably next to the warm paper UI.
 */
export function chunkSpectralColor(
  chunk: Chunk,
  analysis: AudioAnalysis | null,
): string {
  if (!analysis) return "#666";
  const fps = analysis.framesPerSec;
  const startIdx = Math.max(0, Math.floor((chunk.startMs / 1000) * fps));
  const endIdx = Math.min(
    analysis.rms.length,
    Math.ceil((chunk.endMs / 1000) * fps),
  );
  if (endIdx <= startIdx) return "#666";

  let bassSum = 0, lowMidSum = 0, midSum = 0, highSum = 0;
  let rmsSum = 0;
  let n = 0;
  for (let i = startIdx; i < endIdx; i++) {
    bassSum += analysis.bands.bass[i] ?? 0;
    lowMidSum += analysis.bands.lowMids[i] ?? 0;
    midSum += analysis.bands.mids[i] ?? 0;
    highSum += analysis.bands.highs[i] ?? 0;
    rmsSum += analysis.rms[i] ?? 0;
    n++;
  }
  const total = bassSum + lowMidSum + midSum + highSum;
  if (total < 1e-6 || n === 0) return "#666";

  // Centroid 0..3 — energy-weighted band index.
  const centroid = (lowMidSum + 2 * midSum + 3 * highSum) / total;
  const t = Math.max(0, Math.min(3, centroid));
  // Find the surrounding stops and lerp.
  let i = 0;
  while (i < SPECTRAL_STOPS.length - 1 && SPECTRAL_STOPS[i + 1][0] < t) i++;
  const [t0, hsl0] = SPECTRAL_STOPS[i];
  const [t1, hsl1] = SPECTRAL_STOPS[Math.min(i + 1, SPECTRAL_STOPS.length - 1)];
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const h = hsl0[0] + (hsl1[0] - hsl0[0]) * u;
  const s = hsl0[1] + (hsl1[1] - hsl0[1]) * u;
  // Lightness still tracks loudness — clamp to 32..62 so we don't blow
  // out into pastel highlight or muddy black-with-tint territory.
  const meanRms = rmsSum / n;
  const dB = meanRms > 1e-6 ? 20 * Math.log10(meanRms) : -60;
  const lAdj = Math.max(-10, Math.min(10, dB / 4));
  const baseL = hsl0[2] + (hsl1[2] - hsl0[2]) * u;
  const l = Math.max(32, Math.min(62, baseL + lAdj));

  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
}

// ─── Stem-bars heuristic (Phase E) ──────────────────────────────────────

export interface ChunkStemHeuristic {
  /** Drums / percussion — transient-heavy bass + highs. 0..1. */
  drums: number;
  /** Bass — sustained low energy. 0..1. */
  bass: number;
  /** Melodic / harmonic — sustained mids. 0..1. */
  melody: number;
  /** Formant proxy (NOT real vocal detection) — concentrated mid-high
   *  energy with non-percussive envelope. 0..1. */
  formants: number;
}

const ZERO_STEMS: ChunkStemHeuristic = {
  drums: 0, bass: 0, melody: 0, formants: 0,
};

/** Heuristic 4-stem proxy from the existing master AudioAnalysis.
 *  Not a real stem separator — labels are intentionally honest
 *  ("formants" not "vocals"). For TE-style typical single-source
 *  builds (drum-only loop, bassline take, pad layer) the bars
 *  consistently lean the right way. */
export function chunkStemHeuristic(
  chunk: Chunk,
  analysis: AudioAnalysis | null,
): ChunkStemHeuristic {
  if (!analysis) return ZERO_STEMS;
  const fps = analysis.framesPerSec;
  const startIdx = Math.max(0, Math.floor((chunk.startMs / 1000) * fps));
  const endIdx = Math.min(
    analysis.rms.length,
    Math.ceil((chunk.endMs / 1000) * fps),
  );
  if (endIdx <= startIdx) return ZERO_STEMS;

  // Per-band sustained mean (proxy for held / pitched content).
  let bass = 0, lowMid = 0, mid = 0, high = 0;
  let rmsSum = 0;
  for (let i = startIdx; i < endIdx; i++) {
    bass += analysis.bands.bass[i] ?? 0;
    lowMid += analysis.bands.lowMids[i] ?? 0;
    mid += analysis.bands.mids[i] ?? 0;
    high += analysis.bands.highs[i] ?? 0;
    rmsSum += analysis.rms[i] ?? 0;
  }
  const n = endIdx - startIdx;
  bass /= n; lowMid /= n; mid /= n; high /= n;
  const meanRms = rmsSum / n;
  if (meanRms < 1e-6) return ZERO_STEMS;

  // Per-band onset density (transients).
  const durationS = (chunk.endMs - chunk.startMs) / 1000;
  function densityIn(times: number[]): number {
    if (durationS <= 0) return 0;
    let count = 0;
    for (const t of times) {
      const ms = t * 1000;
      if (ms >= chunk.startMs && ms <= chunk.endMs) count++;
    }
    return count / durationS;
  }
  const dBass = densityIn(analysis.onsetsByBand.bass);
  const dHigh = densityIn(analysis.onsetsByBand.highs);
  const dMid = densityIn(analysis.onsetsByBand.mids);

  // Drums: low-band kicks + high-band hats, weighted by transient
  // density. Saturate at ~6 hits/s per band → 1.0.
  const kickStrength = clamp01(dBass / 6) * clamp01(bass * 5);
  const hatStrength = clamp01(dHigh / 8) * clamp01(high * 5);
  const drums = clamp01(kickStrength + hatStrength * 0.7);

  // Bass: sustained low energy minus transient density. A held bass
  // line scores high; a kick-only pattern scores low.
  const bassSus = clamp01(bass * 4) * clamp01(1 - dBass / 6);
  const bassFinal = clamp01(bassSus);

  // Melody: sustained mids + lowMids, deweighted when transient-busy.
  const melSus = clamp01((mid + lowMid * 0.7) * 4);
  const melody = clamp01(melSus * clamp01(1 - dMid / 6));

  // Formants: concentrated mid-high band with low transient density.
  // Vocal-like content sits there. Stays a heuristic — speech-presence
  // detector would need its own model.
  const formantBand = (mid * 0.7 + high * 0.3);
  const formantSus = clamp01(formantBand * 5);
  const formants = clamp01(formantSus * clamp01(1 - (dMid + dHigh) / 10));

  return { drums, bass: bassFinal, melody, formants };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── IDB cache wrapper ───────────────────────────────────────────────────

export interface CachedMelLookup {
  data: Uint8Array;
  nMels: number;
  nFrames: number;
  durationS: number;
}
