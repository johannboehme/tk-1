/**
 * Multi-resolution min/max peak pyramid for transient-accurate waveform
 * rendering (Ableton-style). Replaces the 10 Hz RMS envelope (Triage) and the
 * fixed bucket array (Editor) as the waveform SOURCE: min/max preserves
 * transients that RMS averaging smears away, and the level hierarchy lets the
 * draw engine read ~1 bucket per device pixel at any zoom without scanning raw
 * PCM every frame.
 *
 * Pure module — no canvas, no React, no IDB. Fully unit-testable.
 *
 * Level 0 is the finest: one [min,max] (and optional rms) per
 * `baseSamplesPerBucket` samples (64 -> ~2.9 ms at 22050 Hz). Each higher level
 * is 2:1 min/max-pooled from the one below, until the bucket count drops to
 * `minBuckets`. Memory ~20 MB/h (min/max) / ~30 MB/h (with rms) — far below the
 * ~317 MB/h of retaining raw Float32 PCM.
 */

export const PYRAMID_VERSION = 1;

export interface PyramidLevel {
  /** Per-bucket minimum sample value (signed). */
  min: Float32Array;
  /** Per-bucket maximum sample value (signed). */
  max: Float32Array;
  /** Optional per-bucket RMS (loudness), for the Ableton two-tone core. */
  rms?: Float32Array;
  samplesPerBucket: number;
  bucketCount: number;
}

export interface PeakPyramid {
  version: number;
  sampleRate: number;
  sampleCount: number;
  durationS: number;
  baseSamplesPerBucket: number;
  /** max(|pcm|), floored away from zero so callers can divide safely. */
  globalPeak: number;
  /** Finest level first. */
  levels: PyramidLevel[];
}

export interface ColumnAgg {
  min: number;
  max: number;
  rms?: number;
}

export interface BuildPyramidOpts {
  baseSamplesPerBucket?: number;
  withRms?: boolean;
  /** Stop pooling once a level has at most this many buckets. */
  minBuckets?: number;
}

export const PEAK_FLOOR = 0.01;

/**
 * Fill level-0 buckets [bStart,bEnd) into pre-allocated arrays. Exposed so the
 * async builder can compute level 0 in yielding chunks while sharing the exact
 * per-bucket min/max/rms math (one source of truth).
 */
export function fillLevel0(
  pcm: Float32Array,
  base: number,
  withRms: boolean,
  min: Float32Array,
  max: Float32Array,
  rms: Float32Array | undefined,
  bStart: number,
  bEnd: number,
): void {
  for (let b = bStart; b < bEnd; b++) {
    const s0 = b * base;
    const s1 = Math.min(pcm.length, s0 + base);
    let lo = Infinity;
    let hi = -Infinity;
    let sumSq = 0;
    for (let i = s0; i < s1; i++) {
      const v = pcm[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (withRms) sumSq += v * v;
    }
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
    if (rms) rms[b] = Math.sqrt(sumSq / Math.max(1, s1 - s0));
  }
}

/** Finest level straight from PCM: true per-bucket min/max (+ optional rms). */
function level0FromPcm(
  pcm: Float32Array,
  base: number,
  withRms: boolean,
): PyramidLevel {
  const bucketCount = Math.ceil(pcm.length / base);
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  const rms = withRms ? new Float32Array(bucketCount) : undefined;
  fillLevel0(pcm, base, withRms, min, max, rms, 0, bucketCount);
  return { min, max, rms, samplesPerBucket: base, bucketCount };
}

/** Build coarser levels by 2:1 min/max (+energy) pooling until <= minBuckets. */
export function poolUp(level0: PyramidLevel, minBuckets: number): PyramidLevel[] {
  const levels: PyramidLevel[] = [level0];
  let cur = level0;
  while (cur.bucketCount > minBuckets) {
    const count = Math.ceil(cur.bucketCount / 2);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const rms = cur.rms ? new Float32Array(count) : undefined;
    for (let i = 0; i < count; i++) {
      const c0 = 2 * i;
      const c1 = Math.min(cur.bucketCount, c0 + 2);
      let lo = Infinity;
      let hi = -Infinity;
      let energy = 0;
      for (let c = c0; c < c1; c++) {
        if (cur.min[c] < lo) lo = cur.min[c];
        if (cur.max[c] > hi) hi = cur.max[c];
        if (cur.rms) energy += cur.rms[c] * cur.rms[c];
      }
      min[i] = lo;
      max[i] = hi;
      if (rms && cur.rms) rms[i] = Math.sqrt(energy / (c1 - c0));
    }
    const next: PyramidLevel = {
      min,
      max,
      rms,
      samplesPerBucket: cur.samplesPerBucket * 2,
      bucketCount: count,
    };
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** Largest |amplitude| across the finest level, floored away from zero. */
export function globalPeakOf(level0: PyramidLevel): number {
  let peak = PEAK_FLOOR;
  for (let i = 0; i < level0.bucketCount; i++) {
    const a = Math.abs(level0.max[i]);
    const b = Math.abs(level0.min[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return peak;
}

export function buildPeakPyramid(
  pcm: Float32Array,
  sampleRate: number,
  opts: BuildPyramidOpts = {},
): PeakPyramid {
  const base = opts.baseSamplesPerBucket ?? 64;
  const withRms = opts.withRms ?? false;
  const minBuckets = opts.minBuckets ?? 64;
  const sampleCount = pcm.length;
  const durationS = sampleCount / sampleRate;
  if (sampleCount === 0) {
    return {
      version: PYRAMID_VERSION,
      sampleRate,
      sampleCount: 0,
      durationS: 0,
      baseSamplesPerBucket: base,
      globalPeak: PEAK_FLOOR,
      levels: [],
    };
  }
  const lvl0 = level0FromPcm(pcm, base, withRms);
  return {
    version: PYRAMID_VERSION,
    sampleRate,
    sampleCount,
    durationS,
    baseSamplesPerBucket: base,
    globalPeak: globalPeakOf(lvl0),
    levels: poolUp(lvl0, minBuckets),
  };
}

/**
 * Degenerate pyramid from a precomputed RMS envelope. Used as an immediate
 * fallback while the full PCM is still decoding in the background (Triage's
 * cached-open path) so the lane paints at once; replaced reactively once PCM
 * lands. min = -env, max = +env (a symmetric silhouette).
 */
export function buildPyramidFromEnvelope(
  envelope: Float32Array,
  envelopeHz: number,
  sampleRate: number,
  opts: { minBuckets?: number } = {},
): PeakPyramid {
  const minBuckets = opts.minBuckets ?? 64;
  const samplesPerBucket = Math.max(1, Math.round(sampleRate / envelopeHz));
  const n = envelope.length;
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = envelope[i];
    max[i] = v;
    min[i] = -v;
  }
  const lvl0: PyramidLevel = {
    min,
    max,
    samplesPerBucket,
    bucketCount: n,
  };
  return {
    version: PYRAMID_VERSION,
    sampleRate,
    sampleCount: n * samplesPerBucket,
    durationS: n / envelopeHz,
    baseSamplesPerBucket: samplesPerBucket,
    globalPeak: globalPeakOf(lvl0),
    levels: n === 0 ? [] : poolUp(lvl0, minBuckets),
  };
}

/**
 * Pick the coarsest level whose bucket is still no wider than one device pixel
 * (scaled by targetBucketsPerPx) — i.e. ~>=1 bucket per pixel, minimal work, no
 * aliasing. Clamps to [0, levels-1]. Returns 0 when even the finest level is
 * coarser than a pixel (the draw engine then interpolates or reads raw PCM).
 */
export function pickLevel(
  p: PeakPyramid,
  secondsPerDevicePx: number,
  targetBucketsPerPx = 1,
): number {
  const levels = p.levels;
  if (levels.length <= 1) return 0;
  const threshold = secondsPerDevicePx / Math.max(1e-9, targetBucketsPerPx);
  let level = 0;
  while (
    level + 1 < levels.length &&
    levels[level + 1].samplesPerBucket / p.sampleRate <= threshold
  ) {
    level++;
  }
  return level;
}

const EPS = 1e-6;

/** Bucket index range [i0,i1) at this level covering [t0S,t1S), clamped. */
export function bucketRangeForTime(
  level: PyramidLevel,
  sampleRate: number,
  t0S: number,
  t1S: number,
): { i0: number; i1: number } {
  const dur = level.samplesPerBucket / sampleRate;
  let i0 = Math.floor(t0S / dur + EPS);
  let i1 = Math.ceil(t1S / dur - EPS);
  if (i0 < 0) i0 = 0;
  if (i1 > level.bucketCount) i1 = level.bucketCount;
  if (i1 < i0) i1 = i0;
  return { i0, i1 };
}

/** Peak-hold min/max (and peak-hold rms) over buckets [i0,i1). */
export function aggregateColumn(
  level: PyramidLevel,
  i0: number,
  i1: number,
): ColumnAgg {
  const lo0 = Math.max(0, i0);
  const hi0 = Math.min(level.bucketCount, i1);
  if (hi0 <= lo0) return { min: 0, max: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  let rms = level.rms ? 0 : undefined;
  for (let i = lo0; i < hi0; i++) {
    if (level.min[i] < lo) lo = level.min[i];
    if (level.max[i] > hi) hi = level.max[i];
    if (level.rms && rms !== undefined && level.rms[i] > rms) rms = level.rms[i];
  }
  return rms === undefined ? { min: lo, max: hi } : { min: lo, max: hi, rms };
}

/**
 * Exact min/max (+ optional rms) over the raw samples in [t0S,t1S). Used at
 * extreme zoom (fewer than ~1 base bucket per device pixel) where the pyramid
 * is coarser than a pixel; gives true transient edges where PCM is available.
 */
export function rawPcmColumn(
  pcm: Float32Array,
  sampleRate: number,
  t0S: number,
  t1S: number,
  withRms = false,
): ColumnAgg {
  if (pcm.length === 0) return { min: 0, max: 0 };
  let s0 = Math.floor(t0S * sampleRate);
  let s1 = Math.ceil(t1S * sampleRate);
  if (s0 < 0) s0 = 0;
  if (s1 > pcm.length) s1 = pcm.length;
  if (s1 <= s0) {
    // Sub-sample column: grab the single nearest sample.
    s0 = Math.min(s0, pcm.length - 1);
    if (s0 < 0) s0 = 0;
    s1 = s0 + 1;
  }
  let lo = Infinity;
  let hi = -Infinity;
  let sumSq = 0;
  for (let i = s0; i < s1; i++) {
    const v = pcm[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (withRms) sumSq += v * v;
  }
  if (!withRms) return { min: lo, max: hi };
  return { min: lo, max: hi, rms: Math.sqrt(sumSq / (s1 - s0)) };
}
