import { describe, it, expect } from "vitest";
import { createMonoResampler } from "./resampler";

function fillSine(len: number, freq: number, rate: number): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("createMonoResampler", () => {
  it("identity-passthrough when source rate matches target rate", () => {
    const r = createMonoResampler({ targetSampleRate: 22050 });
    const sig = fillSine(22050, 440, 22050);
    r.pushPlanar([sig], 22050);
    const out = r.finish();
    // Linear-interp identity is exact at integer positions; allow only
    // tiny float rounding tolerance.
    let maxDelta = 0;
    for (let i = 0; i < sig.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(out[i] - sig[i]));
    }
    expect(maxDelta).toBeLessThan(1e-6);
  });

  it("downsamples 44100 → 22050 producing roughly half the samples", () => {
    const r = createMonoResampler({ targetSampleRate: 22050 });
    const sig = fillSine(44100, 440, 44100);
    r.pushPlanar([sig], 44100);
    const out = r.finish();
    // Tolerance: ±1 sample at boundary handling.
    expect(out.length).toBeGreaterThanOrEqual(22049);
    expect(out.length).toBeLessThanOrEqual(22052);
  });

  it("downsampled 440 Hz tone preserves zero-crossing rate", () => {
    const r = createMonoResampler({ targetSampleRate: 22050 });
    const sig = fillSine(44100, 440, 44100);
    r.pushPlanar([sig], 44100);
    const out = r.finish();
    // Skip the leading 100 samples to dodge any boundary artefacts at t=0.
    const slice = out.subarray(100, 22000);
    let zc = 0;
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1] <= 0 && slice[i] > 0) zc++;
    }
    // 440 Hz × ~1 sec → 440 zero crossings. Allow ±5 for boundary.
    expect(zc).toBeGreaterThanOrEqual(435);
    expect(zc).toBeLessThanOrEqual(445);
  });

  it("mixes down stereo to mono via channel averaging", () => {
    const r = createMonoResampler({ targetSampleRate: 22050 });
    const left = new Float32Array(22050).fill(0.5);
    const right = new Float32Array(22050).fill(-0.5);
    r.pushPlanar([left, right], 22050);
    const out = r.finish();
    // Average of +0.5 and -0.5 = 0
    for (let i = 0; i < 22000; i++) {
      expect(Math.abs(out[i])).toBeLessThan(1e-6);
    }
  });

  it("produces continuous output across multiple pushes (no boundary gap)", () => {
    const ref = createMonoResampler({ targetSampleRate: 22050 });
    const split = createMonoResampler({ targetSampleRate: 22050 });
    const sig = fillSine(44100, 440, 44100);

    ref.pushPlanar([sig], 44100);
    const refOut = ref.finish();

    // Split into 5 batches of 8820 samples each, push individually.
    const batchSize = 8820;
    for (let off = 0; off < sig.length; off += batchSize) {
      const slice = sig.slice(off, Math.min(off + batchSize, sig.length));
      split.pushPlanar([slice], 44100);
    }
    const splitOut = split.finish();

    // Lengths should match within ±1.
    expect(Math.abs(refOut.length - splitOut.length)).toBeLessThanOrEqual(1);

    // Sample-by-sample RMS difference should be tiny — linear-interp is
    // deterministic across batch boundaries given our carry bookkeeping.
    const len = Math.min(refOut.length, splitOut.length);
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      const d = refOut[i] - splitOut[i];
      sumSq += d * d;
    }
    const rms = Math.sqrt(sumSq / len);
    expect(rms).toBeLessThan(1e-3);
  });

  it("rejects a mid-stream sample-rate change", () => {
    const r = createMonoResampler({ targetSampleRate: 22050 });
    r.pushPlanar([new Float32Array(100)], 44100);
    expect(() => r.pushPlanar([new Float32Array(100)], 48000)).toThrow(
      /source rate changed/,
    );
  });
});
