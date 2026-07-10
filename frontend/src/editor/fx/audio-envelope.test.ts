import { describe, expect, test } from "vitest";
import {
  buildLoudnessEnvelope,
  buildLoudnessEnvelopeAsync,
} from "./audio-envelope";

describe("buildLoudnessEnvelope", () => {
  test("empty input → empty curve", () => {
    const env = buildLoudnessEnvelope(new Float32Array(0), 22050, 60);
    expect(env.data.length).toBe(0);
    expect(env.fps).toBe(60);
  });

  test("normalizes loudest window to 1, silence to 0", () => {
    const sr = 600;
    const fps = 60; // hop = 10 samples
    // 3 windows: silent, half-amplitude tone, full-amplitude tone.
    const pcm = new Float32Array(30);
    for (let i = 10; i < 20; i++) pcm[i] = 0.5;
    for (let i = 20; i < 30; i++) pcm[i] = 1.0;
    const env = buildLoudnessEnvelope(pcm, sr, fps);
    expect(env.data.length).toBe(3);
    expect(env.data[0]).toBeCloseTo(0, 6); // silence
    expect(env.data[2]).toBeCloseTo(1, 6); // loudest → normalized to 1
    expect(env.data[1]).toBeGreaterThan(0);
    expect(env.data[1]).toBeLessThan(env.data[2]); // quieter than the peak
  });

  test("all-silence stays 0 (no divide-by-zero blowup)", () => {
    const env = buildLoudnessEnvelope(new Float32Array(100), 600, 60);
    expect(env.data.every((v) => v === 0)).toBe(true);
  });

  // Regression: the envelope's time axis must stay accurate ALL the way
  // through a long track. `hop = round(sr/fps)` is whole-sample-rounded
  // (22050/120 = 183.75 → 184); storing the requested fps instead of the
  // true rate (sr/hop) mis-scaled every sample by ~0.14%, which is ~0.4s
  // off at 5 minutes — the sidechain peaks drifted further the deeper in
  // you went. The time of a transient must land where it actually is.
  describe("time-axis accuracy (no scaling drift deep into the track)", () => {
    /** master-time (s) of the envelope's loudest sample — exactly how the
     *  scope/renderer locate a peak (index / fps). */
    function peakTimeS(env: { data: Float32Array | readonly number[]; fps: number }): number {
      let bestI = 0;
      let best = -Infinity;
      const d = env.data;
      for (let i = 0; i < d.length; i++) if (d[i] > best) { best = d[i]; bestI = i; }
      return bestI / env.fps;
    }

    test.each([22050, 44100, 48000])(
      "a transient at 300s is located within 1 frame at %i Hz",
      (sr) => {
        const tImpulseS = 300;
        const totalS = 305;
        const pcm = new Float32Array(sr * totalS);
        const start = Math.round(tImpulseS * sr);
        for (let j = start; j < start + Math.round(sr * 0.01); j++) pcm[j] = 1;
        const env = buildLoudnessEnvelope(pcm, sr, 120);
        // Within one frame (~8 ms) of the true transient time.
        expect(Math.abs(peakTimeS(env) - tImpulseS)).toBeLessThan(1.5 / env.fps);
      },
    );

    test("stored fps is the TRUE rate sampleRate/hop, not the requested fps", () => {
      const sr = 22050;
      const env = buildLoudnessEnvelope(new Float32Array(sr), sr, 120);
      const hop = Math.round(sr / 120); // 184
      expect(env.fps).toBeCloseTo(sr / hop, 6); // 119.84, NOT 120
    });
  });
});

describe("buildLoudnessEnvelopeAsync — chunked, yielding builder", () => {
  /** Music-ish PCM: tone bed + a transient burst so the peak windows have
   *  structure (an all-constant signal would hide bucket-boundary bugs). */
  function makePcm(n: number): Float32Array {
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pcm[i] = 0.3 * Math.sin(i * 0.01);
      if (i % 5000 < 50) pcm[i] += 0.6 * (1 - (i % 5000) / 50);
    }
    return pcm;
  }

  test("produces an envelope identical to the sync builder", async () => {
    const sr = 22050;
    const pcm = makePcm(3 * sr);
    const sync = buildLoudnessEnvelope(pcm, sr);
    const asy = await buildLoudnessEnvelopeAsync(pcm, sr, {
      chunkSamples: 8_192, // force many chunks
    });
    expect(asy.fps).toBeCloseTo(sync.fps, 9);
    expect(asy.data.length).toBe(sync.data.length);
    expect(Array.from(asy.data)).toEqual(Array.from(sync.data));
  });

  test("identical across chunk boundaries (window overlaps a chunk seam)", async () => {
    const sr = 600;
    const pcm = makePcm(sr * 4);
    const sync = buildLoudnessEnvelope(pcm, sr, 60);
    // chunk of ~7 buckets → many seams; centred windows span seams.
    const asy = await buildLoudnessEnvelopeAsync(pcm, sr, {
      fps: 60,
      chunkSamples: 70,
    });
    expect(Array.from(asy.data)).toEqual(Array.from(sync.data));
  });

  test("reports progress ending at 1 and yields between chunks", async () => {
    const sr = 22050;
    const pcm = makePcm(2 * sr);
    const ticks: number[] = [];
    const env = await buildLoudnessEnvelopeAsync(pcm, sr, {
      chunkSamples: 8_192,
      onProgress: (f) => ticks.push(f),
    });
    expect(env.data.length).toBeGreaterThan(0);
    expect(ticks.length).toBeGreaterThan(1); // actually chunked
    expect(ticks[ticks.length - 1]).toBeCloseTo(1, 6);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
    }
  });

  test("empty input → empty curve", async () => {
    const env = await buildLoudnessEnvelopeAsync(new Float32Array(0), 22050, {
      fps: 60,
    });
    expect(env.data.length).toBe(0);
    expect(env.fps).toBe(60);
  });
});
