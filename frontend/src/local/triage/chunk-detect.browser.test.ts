import { describe, it, expect } from "vitest";
import { detectChunks, dbToLinear, TRIAGE_ENVELOPE_HZ } from "./chunk-detect";
import type { SilenceConfig } from "../../storage/jobs-db";

/** Build a PCM buffer made of tone/silence segments at a given BPM.
 *  Each entry is `{kind, secs}` — "tone" is a click train at the
 *  requested BPM (so the per-chunk tempo detector has something
 *  unambiguous to lock onto), "silence" is true digital silence. */
type Seg = { kind: "tone" | "silence"; secs: number };

function buildPcm(segments: Seg[], sampleRate: number, bpm: number): Float32Array {
  const totalSamples = Math.round(
    segments.reduce((acc, s) => acc + s.secs, 0) * sampleRate,
  );
  const out = new Float32Array(totalSamples);
  let cursor = 0;
  const samplesPerBeat = Math.round((60 / bpm) * sampleRate);
  // Click envelope: 30 ms decay.
  const clickLen = Math.round(0.03 * sampleRate);
  for (const seg of segments) {
    const segLen = Math.round(seg.secs * sampleRate);
    if (seg.kind === "tone") {
      // Place clicks at every beat boundary inside this segment.
      let beat = 0;
      while (true) {
        const idx = beat * samplesPerBeat;
        if (idx >= segLen) break;
        const start = cursor + idx;
        for (let i = 0; i < clickLen && start + i < cursor + segLen; i++) {
          // Exponential decay click — strong attack so the spectral
          // flux fires unambiguously per click.
          const env = Math.exp(-i / (clickLen / 4));
          out[start + i] = 0.6 * env;
        }
        beat++;
      }
    }
    // silence stays at 0
    cursor += segLen;
  }
  return out;
}

const SAMPLE_RATE = 22050;

describe("detectChunks", () => {
  it("splits tone/silence/tone with a 2-second gap and a generous min-pause", async () => {
    const pcm = buildPcm(
      [
        { kind: "tone", secs: 6 },
        { kind: "silence", secs: 2 },
        { kind: "tone", secs: 6 },
      ],
      SAMPLE_RATE,
      120,
    );
    const config: SilenceConfig = { thresholdDb: -50, minPauseMs: 1500 };
    const result = await detectChunks(pcm, SAMPLE_RATE, config);

    expect(result.envelopeHz).toBe(TRIAGE_ENVELOPE_HZ);
    expect(result.envelope.length).toBeGreaterThan(0);
    expect(result.chunks.length).toBe(2);
    // First chunk roughly 0..6s, second 8..14s.
    const c0 = result.chunks[0];
    const c1 = result.chunks[1];
    expect(c0.startMs).toBeLessThanOrEqual(200);
    expect(c0.endMs).toBeGreaterThan(5_500);
    expect(c0.endMs).toBeLessThanOrEqual(6_500);
    expect(c1.startMs).toBeGreaterThanOrEqual(7_500);
    expect(c1.startMs).toBeLessThanOrEqual(8_500);
    expect(c1.endMs).toBeGreaterThan(13_500);
  }, 30_000);

  it("does not split when the gap is shorter than min-pause", async () => {
    const pcm = buildPcm(
      [
        { kind: "tone", secs: 4 },
        { kind: "silence", secs: 0.5 },
        { kind: "tone", secs: 4 },
      ],
      SAMPLE_RATE,
      120,
    );
    const config: SilenceConfig = { thresholdDb: -50, minPauseMs: 1500 };
    const result = await detectChunks(pcm, SAMPLE_RATE, config);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].startMs).toBeLessThanOrEqual(200);
    expect(result.chunks[0].endMs).toBeGreaterThan(8_000);
  }, 30_000);

  it("returns no chunks for an all-silence input", async () => {
    const pcm = new Float32Array(SAMPLE_RATE * 5); // 5 s of zeros
    const config: SilenceConfig = { thresholdDb: -50, minPauseMs: 1500 };
    const result = await detectChunks(pcm, SAMPLE_RATE, config);
    expect(result.chunks.length).toBe(0);
  }, 15_000);

  it("populates detectedBpm for chunks long enough to detect tempo", async () => {
    // 8-second tone block at 120 BPM → 16 clicks → enough for the
    // autocorrelation to lock onto the half-second period.
    const pcm = buildPcm([{ kind: "tone", secs: 8 }], SAMPLE_RATE, 120);
    const config: SilenceConfig = { thresholdDb: -50, minPauseMs: 1500 };
    const result = await detectChunks(pcm, SAMPLE_RATE, config);
    expect(result.chunks.length).toBe(1);
    const chunk = result.chunks[0];
    expect(chunk.detectedBpm).toBeDefined();
    // Detector may pick perceptual tempo (could be 120 or 60 / 240
    // depending on octave voting). Accept any of the standard
    // octave-shifted variants of 120.
    const candidates = [60, 120, 240];
    const closeEnough = candidates.some(
      (c) => Math.abs((chunk.detectedBpm ?? 0) - c) < 5,
    );
    expect(
      closeEnough,
      `detectedBpm=${chunk.detectedBpm} not within 5 BPM of 60/120/240`,
    ).toBe(true);
    expect(chunk.effectiveBpm).toBe(chunk.detectedBpm);
  }, 30_000);

  it("leaves detectedBpm undefined for chunks shorter than the BPM-detection floor", async () => {
    // 1-second tone — too short for autocorrelation to lock. Threshold
    // detection still finds it.
    const pcm = buildPcm([{ kind: "tone", secs: 1.5 }], SAMPLE_RATE, 120);
    const config: SilenceConfig = { thresholdDb: -50, minPauseMs: 500 };
    const result = await detectChunks(pcm, SAMPLE_RATE, config);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].detectedBpm).toBeUndefined();
    expect(result.chunks[0].effectiveBpm).toBe(0);
  }, 15_000);

  it("threshold parameter changes which chunks are kept", async () => {
    // A loud-ish chunk and a barely-audible one. Strict threshold
    // keeps only the loud one; loose threshold keeps both.
    const pcm = new Float32Array(SAMPLE_RATE * 10);
    // Loud tone 0..3s (0.5 amp clicks).
    const click = (offset: number, amp: number) => {
      for (let i = 0; i < SAMPLE_RATE * 0.03; i++) {
        const env = Math.exp(-i / (SAMPLE_RATE * 0.03 / 4));
        pcm[offset + i] = amp * env;
      }
    };
    for (let beat = 0; beat < 6; beat++) {
      click(Math.round(beat * 0.5 * SAMPLE_RATE), 0.5);
    }
    // Quiet tone 5..8s (0.005 amp).
    for (let beat = 0; beat < 6; beat++) {
      click(Math.round((5 + beat * 0.5) * SAMPLE_RATE), 0.005);
    }

    const strict: SilenceConfig = { thresholdDb: -30, minPauseMs: 1000 };
    const loose: SilenceConfig = { thresholdDb: -70, minPauseMs: 1000 };

    const strictRes = await detectChunks(pcm, SAMPLE_RATE, strict);
    const looseRes = await detectChunks(pcm, SAMPLE_RATE, loose);

    expect(strictRes.chunks.length).toBe(1);
    expect(looseRes.chunks.length).toBeGreaterThanOrEqual(1);
    expect(looseRes.chunks.length).toBeGreaterThan(strictRes.chunks.length);
  }, 30_000);
});

describe("dbToLinear", () => {
  it("converts 0 dBFS to 1.0", () => {
    expect(dbToLinear(0)).toBeCloseTo(1.0, 6);
  });
  it("converts -20 dBFS to 0.1", () => {
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 6);
  });
  it("converts -60 dBFS to ~0.001", () => {
    expect(dbToLinear(-60)).toBeCloseTo(0.001, 6);
  });
});
