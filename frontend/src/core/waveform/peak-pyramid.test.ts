import { describe, it, expect } from "vitest";
import {
  buildPeakPyramid,
  buildPyramidFromEnvelope,
  pickLevel,
  bucketRangeForTime,
  aggregateColumn,
  rawPcmColumn,
  PYRAMID_VERSION,
} from "./peak-pyramid";

/** Brute-force per-bucket min/max over a sample range, for cross-checks. */
function trueMinMax(pcm: Float32Array, s0: number, s1: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = s0; i < s1; i++) {
    if (pcm[i] < lo) lo = pcm[i];
    if (pcm[i] > hi) hi = pcm[i];
  }
  return [lo, hi];
}

function sine(n: number, sr: number, freq: number, amp = 1): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return y;
}

describe("buildPeakPyramid", () => {
  it("empty PCM does not throw and yields an empty, well-formed pyramid", () => {
    const p = buildPeakPyramid(new Float32Array(0), 22050);
    expect(p.version).toBe(PYRAMID_VERSION);
    expect(p.sampleCount).toBe(0);
    expect(p.durationS).toBe(0);
    expect(p.levels).toEqual([]);
    expect(p.globalPeak).toBeGreaterThan(0); // floored, never zero
  });

  it("level 0 buckets hold the true per-bucket min/max", () => {
    const sr = 22050;
    const base = 64;
    const pcm = sine(sr, sr, 440); // 1s
    const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: base });
    const lvl0 = p.levels[0];
    expect(lvl0.samplesPerBucket).toBe(base);
    expect(lvl0.bucketCount).toBe(Math.ceil(pcm.length / base));
    // Check a handful of buckets against brute force.
    for (const b of [0, 1, 5, 100, lvl0.bucketCount - 1]) {
      const s0 = b * base;
      const s1 = Math.min(pcm.length, s0 + base);
      const [lo, hi] = trueMinMax(pcm, s0, s1);
      expect(lvl0.min[b]).toBeCloseTo(lo, 6);
      expect(lvl0.max[b]).toBeCloseTo(hi, 6);
    }
  });

  it("globalPeak equals max(|pcm|)", () => {
    const sr = 22050;
    const pcm = sine(sr, sr, 100, 0.5);
    pcm[1234] = -0.9; // a louder-than-sine trough
    const p = buildPeakPyramid(pcm, sr);
    expect(p.globalPeak).toBeCloseTo(0.9, 6);
  });

  it("2:1 pooling invariant: parent = min/max of its children", () => {
    const sr = 22050;
    const pcm = sine(2 * sr, sr, 440);
    const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64 });
    for (let L = 1; L < p.levels.length; L++) {
      const parent = p.levels[L];
      const child = p.levels[L - 1];
      expect(parent.samplesPerBucket).toBe(child.samplesPerBucket * 2);
      expect(parent.bucketCount).toBe(Math.ceil(child.bucketCount / 2));
      for (let i = 0; i < parent.bucketCount; i++) {
        const c0 = 2 * i;
        const c1 = Math.min(child.bucketCount, c0 + 2);
        let lo = Infinity;
        let hi = -Infinity;
        for (let c = c0; c < c1; c++) {
          if (child.min[c] < lo) lo = child.min[c];
          if (child.max[c] > hi) hi = child.max[c];
        }
        expect(parent.min[i]).toBeCloseTo(lo, 6);
        expect(parent.max[i]).toBeCloseTo(hi, 6);
      }
    }
  });

  it("builds down to a small top level (bucketCount <= minBuckets)", () => {
    const sr = 22050;
    const pcm = sine(10 * sr, sr, 440); // 10s
    const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64, minBuckets: 64 });
    const top = p.levels[p.levels.length - 1];
    expect(top.bucketCount).toBeLessThanOrEqual(64);
    // Strictly decreasing bucket counts up the pyramid.
    for (let L = 1; L < p.levels.length; L++) {
      expect(p.levels[L].bucketCount).toBeLessThan(p.levels[L - 1].bucketCount);
    }
  });

  it("preserves a single-sample transient up to the top level (vs. RMS averaging)", () => {
    const sr = 22050;
    const n = 4 * sr;
    const pcm = new Float32Array(n); // dead silence...
    const spikeIdx = Math.floor(n / 3);
    pcm[spikeIdx] = 1.0; // ...except one lone full-scale sample
    const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64 });
    // The spike's magnitude must survive at EVERY level (max-pool keeps peaks).
    for (const lvl of p.levels) {
      let hi = 0;
      for (let i = 0; i < lvl.bucketCount; i++) if (lvl.max[i] > hi) hi = lvl.max[i];
      expect(hi).toBeCloseTo(1.0, 6);
    }
    // Sanity: an RMS average over the same coarse window would be ~0 (the fix).
    const coarse = p.levels[p.levels.length - 1];
    const rmsLikeAvg = 1.0 / coarse.samplesPerBucket;
    expect(rmsLikeAvg).toBeLessThan(0.01);
  });

  it("optional per-bucket RMS matches sqrt(mean(square)) at level 0 and pools by energy", () => {
    const sr = 22050;
    const base = 64;
    const pcm = sine(sr, sr, 440);
    const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: base, withRms: true });
    const lvl0 = p.levels[0];
    expect(lvl0.rms).toBeDefined();
    // brute-force rms of bucket 10
    const b = 10;
    let sumSq = 0;
    const s0 = b * base;
    const s1 = Math.min(pcm.length, s0 + base);
    for (let i = s0; i < s1; i++) sumSq += pcm[i] * pcm[i];
    expect(lvl0.rms![b]).toBeCloseTo(Math.sqrt(sumSq / (s1 - s0)), 5);
    // pooled rms = energy average of children
    const lvl1 = p.levels[1];
    const r0 = lvl0.rms![0];
    const r1 = lvl0.rms![1];
    expect(lvl1.rms![0]).toBeCloseTo(Math.sqrt((r0 * r0 + r1 * r1) / 2), 5);
  });

  it("omits RMS arrays by default (memory)", () => {
    const p = buildPeakPyramid(sine(22050, 22050, 440), 22050);
    expect(p.levels[0].rms).toBeUndefined();
  });
});

describe("pickLevel", () => {
  const sr = 22050;
  const pcm = sine(20 * sr, sr, 440); // 20s, many levels
  const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64 });
  const baseDur = 64 / sr;

  it("returns level 0 when a device pixel spans <= one base bucket (zoomed in)", () => {
    expect(pickLevel(p, baseDur * 0.5)).toBe(0);
    expect(pickLevel(p, baseDur)).toBe(0);
  });

  it("increases monotonically as the window widens (more seconds per pixel)", () => {
    let prev = -1;
    for (const spp of [baseDur, baseDur * 4, baseDur * 64, baseDur * 1024, 999]) {
      const lvl = pickLevel(p, spp);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it("clamps to the top level for absurdly wide windows", () => {
    expect(pickLevel(p, 1e6)).toBe(p.levels.length - 1);
  });

  it("the chosen level has bucketDuration <= secondsPerDevicePx (>= ~1 bucket/px)", () => {
    const spp = baseDur * 50;
    const lvl = pickLevel(p, spp);
    const dur = p.levels[lvl].samplesPerBucket / sr;
    expect(dur).toBeLessThanOrEqual(spp + 1e-9);
  });
});

describe("bucketRangeForTime + aggregateColumn", () => {
  const sr = 22050;
  const pcm = sine(4 * sr, sr, 440);
  const p = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64 });

  it("a window covering exactly k buckets yields a [i0,i1) of length k", () => {
    const lvl = p.levels[0];
    const dur = lvl.samplesPerBucket / sr;
    const { i0, i1 } = bucketRangeForTime(lvl, sr, 10 * dur, 15 * dur);
    expect(i0).toBe(10);
    expect(i1).toBe(15);
  });

  it("aggregateColumn peak-holds min/max over the bucket range", () => {
    const lvl = p.levels[0];
    const { min, max } = aggregateColumn(lvl, 10, 15);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 10; i < 15; i++) {
      if (lvl.min[i] < lo) lo = lvl.min[i];
      if (lvl.max[i] > hi) hi = lvl.max[i];
    }
    expect(min).toBeCloseTo(lo, 6);
    expect(max).toBeCloseTo(hi, 6);
  });

  it("empty range returns zeros", () => {
    expect(aggregateColumn(p.levels[0], 7, 7)).toEqual({ min: 0, max: 0 });
  });

  it("clamps out-of-bounds ranges", () => {
    const lvl = p.levels[0];
    const r = bucketRangeForTime(lvl, sr, -5, 1e9);
    expect(r.i0).toBe(0);
    expect(r.i1).toBe(lvl.bucketCount);
  });
});

describe("rawPcmColumn", () => {
  const sr = 22050;
  const pcm = new Float32Array([0, 0.2, -0.4, 0.9, -0.1, 0.3, -0.7, 0.5]);

  it("returns the exact min/max over an explicit sample span", () => {
    // samples [1,4): 0.2, -0.4, 0.9
    const t0 = 1 / sr;
    const t1 = 4 / sr;
    const { min, max } = rawPcmColumn(pcm, sr, t0, t1);
    expect(max).toBeCloseTo(0.9, 6);
    expect(min).toBeCloseTo(-0.4, 6);
  });

  it("sub-sample span still returns the nearest sample (no NaN)", () => {
    const t = 3.2 / sr;
    const { min, max } = rawPcmColumn(pcm, sr, t, t); // zero-width
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeCloseTo(0.9, 6); // sample index 3
  });
});

describe("buildPyramidFromEnvelope (degenerate fallback for the cached-open race)", () => {
  it("produces a non-empty symmetric silhouette from a 10 Hz envelope", () => {
    const envelopeHz = 10;
    const sr = 22050;
    const env = new Float32Array([0.1, 0.5, 0.5, 0.2, 0.8, 0.0, 0.3]);
    const p = buildPyramidFromEnvelope(env, envelopeHz, sr);
    expect(p.levels.length).toBeGreaterThan(0);
    const lvl0 = p.levels[0];
    expect(lvl0.bucketCount).toBe(env.length);
    expect(lvl0.samplesPerBucket).toBe(Math.round(sr / envelopeHz));
    // min = -env, max = +env
    expect(lvl0.max[4]).toBeCloseTo(0.8, 6);
    expect(lvl0.min[4]).toBeCloseTo(-0.8, 6);
    expect(p.globalPeak).toBeCloseTo(0.8, 6);
  });
});
