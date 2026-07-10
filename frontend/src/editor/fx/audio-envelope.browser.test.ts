/**
 * Main-thread responsiveness of the loudness-envelope build — real Chromium.
 *
 * The editor builds the sidechain loudness envelope in the background AFTER
 * it is already interactive (Editor.tsx), so the user can be playing when the
 * build lands. The synchronous builder scans every PCM sample in one block —
 * on a long-form master that block stalls the preview rAF and the audio
 * walker past its crossfade lead window. The async builder must chunk that
 * scan so no single main-thread block comes anywhere near the sync total.
 *
 * Also doubles as the perf probe: logs sync-total vs. longest async chunk.
 */
import { describe, expect, it } from "vitest";
import {
  buildLoudnessEnvelope,
  buildLoudnessEnvelopeAsync,
} from "./audio-envelope";

const SR = 22050;

/** Music-ish PCM: tone bed + a kick-like transient every 0.5 s. */
function makePcm(durationS: number): Float32Array {
  const n = Math.floor(durationS * SR);
  const pcm = new Float32Array(n);
  const beatPeriod = Math.floor(SR * 0.5);
  for (let i = 0; i < n; i++) {
    let s = 0.2 * Math.sin(i * 0.031);
    const intoBeat = i % beatPeriod;
    if (intoBeat < SR * 0.04) s += 0.6 * (1 - intoBeat / (SR * 0.04));
    pcm[i] = s;
  }
  return pcm;
}

describe("buildLoudnessEnvelopeAsync — main-thread blocks stay small", () => {
  it("longest per-chunk block is a fraction of the sync builder's single block", async () => {
    // 15 min of master audio (~19.8 M samples) — long-form territory,
    // where the sync build is an unmistakable multi-frame stall.
    const pcm = makePcm(15 * 60);

    const t0 = performance.now();
    const sync = buildLoudnessEnvelope(pcm, SR);
    const syncMs = performance.now() - t0;

    // onProgress fires at the end of each chunk's compute; the delta since
    // the previous fire = that chunk's compute + one event-loop yield (µs),
    // i.e. an upper bound on the longest contiguous main-thread block.
    let lastMark = performance.now();
    let maxBlockMs = 0;
    let chunks = 0;
    const asy = await buildLoudnessEnvelopeAsync(pcm, SR, {
      onProgress: () => {
        const now = performance.now();
        maxBlockMs = Math.max(maxBlockMs, now - lastMark);
        lastMark = now;
        chunks++;
      },
    });

    // Same output as the sync path (identity is covered sample-exactly in
    // the unit suite; here a spot-check guards against a broken fixture).
    expect(asy.data.length).toBe(sync.data.length);
    expect(asy.fps).toBeCloseTo(sync.fps, 9);

    // Actually chunked (~19.8 M samples / 2 M per chunk ≈ 10 chunks).
    expect(chunks).toBeGreaterThan(4);

    // The responsiveness claim: no single block near the sync total.
    // eslint-disable-next-line no-console
    console.log(
      `[loudness-envelope] sync single block: ${syncMs.toFixed(1)} ms — ` +
        `async: ${chunks} chunks, longest block ${maxBlockMs.toFixed(1)} ms`,
    );
    expect(maxBlockMs).toBeLessThan(Math.max(1, syncMs) * 0.5);
  }, 60_000);
});
