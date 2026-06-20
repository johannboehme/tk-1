import { describe, it, expect } from "vitest";
import { buildPeakPyramid } from "./peak-pyramid";
import { computeColumnModel, expandToMinThickness } from "./draw-waveform";

function sine(n: number, sr: number, freq: number, amp = 1): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return y;
}

function maxAdjDiff(a: Float32Array): number {
  let m = 0;
  for (let i = 1; i < a.length; i++) {
    const d = Math.abs(a[i] - a[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

function runCount(hasData: Uint8Array): number {
  let runs = 0;
  let inRun = false;
  for (const v of hasData) {
    if (v && !inRun) runs++;
    inRun = !!v;
  }
  return runs;
}

describe("computeColumnModel — device-pixel resolution", () => {
  const sr = 22050;
  const pcm = sine(sr, sr, 440); // 1s
  const pyr = buildPeakPyramid(pcm, sr);

  it("emits one column per DEVICE pixel (retina fix)", () => {
    const cssW = 300;
    const m1 = computeColumnModel({ pyramid: pyr, t0S: 0, t1S: 1, cssW, dpr: 1 });
    const m2 = computeColumnModel({ pyramid: pyr, t0S: 0, t1S: 1, cssW, dpr: 2 });
    expect(m1.deviceWidth).toBe(300);
    expect(m2.deviceWidth).toBe(600);
    expect(m2.top.length).toBe(600);
    // 2x device columns for the same CSS width.
    expect(m2.deviceWidth).toBe(2 * m1.deviceWidth);
  });

  it("returns a per-CSS-column max array of length cssW (for the silence tint)", () => {
    const cssW = 300;
    const m = computeColumnModel({ pyramid: pyr, t0S: 0, t1S: 1, cssW, dpr: 2 });
    expect(m.colMaxCss.length).toBe(cssW);
    // Each css column max is the max of its underlying device columns' top.
    expect(m.colMaxCss[150]).toBeCloseTo(Math.max(m.top[300], m.top[301]), 5);
  });
});

describe("computeColumnModel — no smoothing (crisp transients)", () => {
  it("keeps a hard silence->loud edge sharp (a 3-tap blur would round it)", () => {
    const sr = 22050;
    const n = sr; // 1s
    const pcm = new Float32Array(n);
    // First half dead silent, second half full-scale.
    for (let i = n / 2; i < n; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
    const pyr = buildPeakPyramid(pcm, sr);
    const m = computeColumnModel({ pyramid: pyr, t0S: 0, t1S: 1, cssW: 200, dpr: 1 });
    // Silent columns ~0, loud columns ~1 -> a single ~1.0 step.
    expect(maxAdjDiff(m.top)).toBeGreaterThan(0.9);
    // A 3-tap (a+2b+c)/4 blur of a 0->1 step caps the single-step delta at 0.75.
  });
});

describe("computeColumnModel — normalization", () => {
  const sr = 22050;
  const pcm = sine(sr, sr, 440, 0.5); // half-scale
  const pyr = buildPeakPyramid(pcm, sr);

  it("absolute shows true amplitude (~0.5)", () => {
    const m = computeColumnModel({
      pyramid: pyr,
      t0S: 0,
      t1S: 1,
      cssW: 200,
      dpr: 1,
      normalize: "absolute",
    });
    let top = 0;
    for (const v of m.top) if (v > top) top = v;
    expect(top).toBeGreaterThan(0.45);
    expect(top).toBeLessThan(0.55);
  });

  it("peak fills the lane (~1.0)", () => {
    const m = computeColumnModel({
      pyramid: pyr,
      t0S: 0,
      t1S: 1,
      cssW: 200,
      dpr: 1,
      normalize: "peak",
    });
    let top = 0;
    for (const v of m.top) if (v > top) top = v;
    expect(top).toBeGreaterThan(0.95);
    expect(top).toBeLessThanOrEqual(1.0001);
  });
});

describe("computeColumnModel — gaps via mapXToTime (Editor long-form)", () => {
  it("marks gap columns hasData=0 and yields one clean run", () => {
    const sr = 22050;
    const pcm = sine(2 * sr, sr, 440);
    const pyr = buildPeakPyramid(pcm, sr);
    const cssW = 200;
    // Master-time present only for CSS x in [50,150); gaps elsewhere.
    const mapXToTime = (cssX: number): number | null => {
      if (cssX < 50 || cssX >= 150) return null;
      return ((cssX - 50) / 100) * 2; // 0..2s across the painted band
    };
    const m = computeColumnModel({
      pyramid: pyr,
      t0S: 0,
      t1S: 2,
      cssW,
      dpr: 1,
      mapXToTime,
    });
    expect(m.hasData[0]).toBe(0);
    expect(m.hasData[100]).toBe(1);
    expect(m.hasData[180]).toBe(0);
    expect(runCount(m.hasData)).toBe(1);
  });
});

describe("expandToMinThickness — body never collapses to an invisible line", () => {
  it("leaves a tall body unchanged", () => {
    expect(expandToMinThickness(0.8, -0.6, 0.01)).toEqual([0.8, -0.6]);
  });

  it("expands a fully collapsed (top==bot) column around its value", () => {
    // At sub-sample zoom the raw path yields min==max — without this the
    // filled body has zero height and vanishes to a flat line (the bug).
    const [t, b] = expandToMinThickness(0.5, 0.5, 0.02);
    expect((t + b) / 2).toBeCloseTo(0.5, 6);
    expect(t - b).toBeCloseTo(0.04, 6);
  });

  it("expands a too-thin body to the minimum, staying centred on the signal", () => {
    const [t, b] = expandToMinThickness(0.305, 0.295, 0.02); // h=0.01 < 0.04
    expect((t + b) / 2).toBeCloseTo(0.3, 6);
    expect(t - b).toBeCloseTo(0.04, 6);
  });
});

describe("computeColumnModel — detached/empty PCM must not flatten the body", () => {
  it("falls back to the pyramid (not the raw path) when pcm is length 0 at deep zoom", () => {
    const sr = 22050;
    const pyr = buildPeakPyramid(sine(2 * sr, sr, 440), sr); // base 64
    // Deep zoom: samplesPerDevPx < base would trigger useRaw — but the store's
    // PCM buffer has been detached to length 0 (still a truthy Float32Array).
    const m = computeColumnModel({
      pyramid: pyr,
      pcm: new Float32Array(0),
      t0S: 0.5,
      t1S: 0.55, // 50 ms window
      cssW: 400,
      dpr: 2,
      normalize: "peak",
    });
    let maxTop = 0;
    let minBot = 0;
    for (let i = 0; i < m.top.length; i++) {
      if (m.top[i] > maxTop) maxTop = m.top[i];
      if (m.bot[i] < minBot) minBot = m.bot[i];
    }
    // Without the pcm.length>0 guard, rawPcmColumn(empty) returns {0,0} for
    // every column and the body is a flat line. With it, the sine's silhouette
    // comes through the pyramid.
    expect(maxTop).toBeGreaterThan(0.5);
    expect(minBot).toBeLessThan(-0.5);
  });
});

describe("computeColumnModel — extreme zoom uses raw PCM when supplied", () => {
  it("resolves detail finer than one base bucket via raw PCM", () => {
    const sr = 22050;
    const pcm = new Float32Array(2048);
    // A lone spike at sample 1000.
    pcm[1000] = 1.0;
    const pyr = buildPeakPyramid(pcm, sr, { baseSamplesPerBucket: 64 });
    // Window 40 samples wide across 200 device px => ~0.2 samples/px (deep zoom).
    const t0 = 980 / sr;
    const t1 = 1020 / sr;
    const m = computeColumnModel({
      pyramid: pyr,
      pcm,
      t0S: t0,
      t1S: t1,
      cssW: 200,
      dpr: 1,
      normalize: "absolute",
    });
    // The spike must appear as a single tall column, with neighbours at ~0.
    let peak = 0;
    let peakCol = -1;
    for (let i = 0; i < m.top.length; i++) {
      if (m.top[i] > peak) {
        peak = m.top[i];
        peakCol = i;
      }
    }
    expect(peak).toBeCloseTo(1.0, 2);
    // Columns well away from the spike are silent (raw detail, not a smear).
    expect(m.top[peakCol > 20 ? 5 : 195]).toBeLessThan(0.2);
  });
});
