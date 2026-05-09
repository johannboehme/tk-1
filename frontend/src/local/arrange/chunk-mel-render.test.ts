/**
 * Tests for the mel-spectrogram rendering helpers used by the
 * Polaroid + FilmStrip Frame overlay (variant: double exposure).
 *
 * The overlay needs two summarisation steps to behave well across
 * chunk durations (a chunk can be 10 s or 6 min — same canvas width):
 *
 *   1. `maxPoolTimeAxis`: aggregate the native-rate mel data into the
 *      canvas's pixel-column count by taking the **peak** of each bin
 *      over the source window. Mean-pool would smooth percussive peaks
 *      into a uniform smear at long durations; max-pool keeps them.
 *
 *   2. `normalizeP95`: scale so the 95th-percentile non-trivial value
 *      maps to 1.0. Keeps the visual exposure consistent — short clips
 *      and long clips end up similarly bright.
 */
import { describe, expect, it } from "vitest";
import { maxPoolTimeAxis, normalizeP95 } from "./chunk-mel-render";

describe("maxPoolTimeAxis", () => {
  it("returns the source unchanged when src ≤ dst", () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = maxPoolTimeAxis(src, /*nMels*/ 2, /*srcFrames*/ 4, /*dstFrames*/ 8);
    expect(out).toBe(src);
  });

  it("max-pools 4 src frames down to 2 dst frames per mel bin", () => {
    // 2 mel bins × 4 src frames, frame-major (data[f * nMels + m])
    // Frames: f0=[1,2] f1=[3,4] f2=[5,1] f3=[7,0]
    // Pool 4→2 ⇒ dst0 = max(f0,f1) = [3,4],  dst1 = max(f2,f3) = [7,1]
    const src = new Uint8Array([1, 2,  3, 4,  5, 1,  7, 0]);
    const out = maxPoolTimeAxis(src, 2, 4, 2);
    expect(Array.from(out)).toEqual([3, 4, 7, 1]);
  });

  it("preserves percussive peaks under heavy compression", () => {
    // 1 mel bin × 100 src frames with a peak at f=50, otherwise zero.
    const src = new Uint8Array(100);
    src[50] = 255;
    const out = maxPoolTimeAxis(src, 1, 100, 10);
    // Whatever bucket frame 50 lands in must keep the peak. The other
    // 9 buckets remain 0.
    expect(Math.max(...out)).toBe(255);
    const peakCount = Array.from(out).filter((v) => v === 255).length;
    expect(peakCount).toBe(1);
  });

  it("handles dst > 1 even when src is tiny", () => {
    const src = new Uint8Array([100]);
    const out = maxPoolTimeAxis(src, 1, 1, 4);
    // src ≤ dst → returns src as-is per contract.
    expect(out).toBe(src);
  });
});

describe("normalizeP95", () => {
  it("maps the 95th percentile of non-trivial values to ~255", () => {
    // 100 values: 1..100. p95 = 95.
    const data = new Uint8Array(100);
    for (let i = 0; i < 100; i++) data[i] = i + 1;
    normalizeP95(data);
    // The original 95 should now be near 255. Values above 95 clamp.
    expect(data[94]).toBeGreaterThanOrEqual(245); // ~255 (within rounding)
    expect(data[99]).toBe(255);
    // Lower values scaled proportionally.
    expect(data[49]).toBeLessThan(180);
    expect(data[49]).toBeGreaterThan(110);
  });

  it("leaves silent data alone (target ≤ 0)", () => {
    const data = new Uint8Array(50);
    normalizeP95(data);
    expect(Array.from(data).every((v) => v === 0)).toBe(true);
  });

  it("ignores near-zero noise floor when picking the percentile", () => {
    // 99 noise values + 1 strong signal: signal must end up at peak,
    // not get squashed because most of the array is silent.
    const data = new Uint8Array(100);
    for (let i = 0; i < 99; i++) data[i] = 1; // noise floor
    data[99] = 200;
    normalizeP95(data);
    expect(data[99]).toBeGreaterThan(200);
  });

  it("is a no-op when the array is too small to take a percentile", () => {
    const data = new Uint8Array([10, 20, 30]);
    const before = Array.from(data);
    normalizeP95(data);
    expect(Array.from(data)).toEqual(before);
  });
});
