import { describe, expect, test } from "vitest";
import { buildLoudnessEnvelope } from "./audio-envelope";

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
});
