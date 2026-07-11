/**
 * Frame planning + timestamp math for the segment export loop (issue
 * #107). Two failure modes are pinned here:
 *
 *  1. Per-segment `Math.round(dur * fps)` rounds each segment
 *     independently, so identical off-grid chunk durations (the
 *     bar-grid long-form case) all round the same direction and the
 *     video/audio length divergence accumulates linearly across chunk
 *     boundaries — audio is concatenated sample-exactly, so ~25 chunks
 *     exceed the ~45 ms lip-sync threshold.
 *
 *  2. `framesEmitted * Math.round(1e6 / fps)` bakes the µs truncation
 *     (33333.33 → 33333) into every timestamp — ~18 ms drift per 30 min
 *     of output at 30 fps.
 */
import { describe, expect, it } from "vitest";
import { planSegmentFrames, outputTimestampUs } from "./frame-timing";

describe("planSegmentFrames", () => {
  it("keeps exact frame-aligned segments unchanged", () => {
    const plan = planSegmentFrames(
      [
        { in: 0, out: 2 },
        { in: 3, out: 5 },
      ],
      30,
    );
    expect(plan).toEqual([60, 60]);
  });

  it("cancels rounding across identical off-grid chunk durations (bar-grid case)", () => {
    // 1 bar at 93 BPM = 2.580645…s = 77.42 frames at 30 fps. Naive
    // per-segment rounding gives 77 frames each → 40 chunks lose
    // 40 × 0.42 frames ≈ 0.56 s of video vs the sample-exact audio.
    const dur = (4 * 60) / 93;
    const segments = Array.from({ length: 40 }, (_, i) => ({
      in: i * 10,
      out: i * 10 + dur,
    }));
    const plan = planSegmentFrames(segments, 30);
    const total = plan.reduce((a, b) => a + b, 0);
    expect(total).toBe(Math.round(40 * dur * 30)); // 3097, not 40×77=3080
    // Each segment stays within one frame of its own duration…
    for (const n of plan) {
      expect(Math.abs(n - dur * 30)).toBeLessThanOrEqual(1);
    }
    // …and the cumulative video length never departs from the exact
    // kept audio duration by more than half a frame.
    let framesSoFar = 0;
    let keptSoFar = 0;
    for (let i = 0; i < segments.length; i++) {
      framesSoFar += plan[i];
      keptSoFar += dur;
      expect(Math.abs(framesSoFar / 30 - keptSoFar)).toBeLessThanOrEqual(
        0.5 / 30 + 1e-9,
      );
    }
  });

  it("handles adversarial half-frame durations without one-directional drift", () => {
    // 0.35 s = 10.5 frames at 30 fps — Math.round always rounds up →
    // naive plan = 24 × 11 = 264 frames (8.8 s) for 8.4 s of audio.
    const segments = Array.from({ length: 24 }, (_, i) => ({
      in: i,
      out: i + 0.35,
    }));
    const plan = planSegmentFrames(segments, 30);
    const total = plan.reduce((a, b) => a + b, 0);
    expect(total).toBe(Math.round(24 * 0.35 * 30)); // 252
  });

  it("returns 0 frames for empty/inverted segments", () => {
    expect(planSegmentFrames([{ in: 5, out: 5 }], 30)).toEqual([0]);
    expect(planSegmentFrames([{ in: 5, out: 4 }], 30)).toEqual([0]);
  });

  it("never returns a negative count even after an over-rounded predecessor", () => {
    const plan = planSegmentFrames(
      [
        { in: 0, out: 0.5166667 }, // 15.5 frames → 16 (cumulative round)
        { in: 1, out: 1.0033333 }, // 0.1 frames — target already covered
      ],
      30,
    );
    expect(plan[0]).toBe(16);
    expect(plan[1]).toBe(0);
    for (const n of plan) expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("outputTimestampUs", () => {
  it("stamps frame k at round(k/fps · 1e6) instead of k · round(1e6/fps)", () => {
    // Frame 54 000 = 30 min at 30 fps. The pre-fix constant-cadence
    // stamp was 54 000 × 33 333 = 1 799 982 000 µs — 18 ms early.
    expect(outputTimestampUs(54_000, 30)).toBe(1_800_000_000);
    expect(outputTimestampUs(0, 30)).toBe(0);
    expect(outputTimestampUs(1, 30)).toBe(33_333);
    expect(outputTimestampUs(3, 30)).toBe(100_000);
  });

  it("is exact for fps that divide 1e6", () => {
    expect(outputTimestampUs(25, 25)).toBe(1_000_000);
    expect(outputTimestampUs(7, 50)).toBe(140_000);
  });
});
