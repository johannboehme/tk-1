import { describe, it, expect } from "vitest";
import { pickGlobalBpm } from "./chunk-detect";

// Helper: a chunk spanning `secs` seconds starting at `atS`, with optional
// per-chunk confidence/stability.
function chunk(
  bpm: number | undefined,
  secs: number,
  atS = 0,
  conf?: number,
  stab?: number,
) {
  return {
    detectedBpm: bpm,
    startMs: atS * 1000,
    endMs: (atS + secs) * 1000,
    detectedBpmConfidence: conf,
    detectedBpmStability: stab,
  };
}

describe("pickGlobalBpm — robust aggregation", () => {
  it("returns null when no chunk has a detected BPM", () => {
    expect(pickGlobalBpm([])).toBeNull();
    expect(pickGlobalBpm([chunk(undefined, 5)])).toBeNull();
  });

  it("keeps sub-integer precision — does NOT round 90.6 up to 91", () => {
    // Old code rounded each chunk to an integer before bucketing, so this
    // reported 91. The true tempo is 90.6 and the grid must use it.
    const r = pickGlobalBpm([chunk(90.6, 10, 0), chunk(90.6, 10, 12)]);
    expect(r).not.toBeNull();
    expect(r!.value).toBeGreaterThan(90.4);
    expect(r!.value).toBeLessThan(90.8);
  });

  it("clusters across the rounding boundary — 90.4 and 90.6 are one tempo", () => {
    // Old code rounded 90.4→90 and 90.6→91, splitting one tempo into two
    // buckets and reporting 0.5 confidence. They must cluster as one.
    const r = pickGlobalBpm([chunk(90.4, 10, 0), chunk(90.6, 10, 12)]);
    expect(r!.value).toBeGreaterThan(90.3);
    expect(r!.value).toBeLessThan(90.7);
    expect(r!.confidence).toBe(1);
  });

  it("orients on the biggest coherent part — long stable core beats short free fragments", () => {
    const r = pickGlobalBpm([
      chunk(132, 3, 0, 0.2, 0.2),
      chunk(70, 2.5, 4, 0.15, 0.1),
      chunk(95, 3, 7, 0.2, 0.3),
      chunk(107, 2, 11, 0.15, 0.2),
      chunk(91, 120, 14, 0.7, 0.95),
    ]);
    expect(r!.value).toBeGreaterThan(90.5);
    expect(r!.value).toBeLessThan(91.5);
  });

  it("merges octave-related detections — a long 182 chunk reinforces 91, not 182", () => {
    // Old code (no octave folding) would let the longer 182 chunk win
    // outright. Folding makes both vote for the same ~91 pulse.
    const r = pickGlobalBpm([
      chunk(91, 12, 0, 0.7, 0.9),
      chunk(182, 40, 14, 0.7, 0.9),
    ]);
    expect(r!.value).toBeGreaterThan(89);
    expect(r!.value).toBeLessThan(93);
  });

  it("down-weights an unstable chunk listed first, of equal duration", () => {
    // Equal durations and equal count: old code's tiebreak kept whichever
    // was encountered first → the rubato 120. Stability weighting flips it
    // to the steady 100.
    const r = pickGlobalBpm([
      chunk(120, 20, 0, 0.6, 0.05),
      chunk(100, 20, 22, 0.6, 0.95),
    ]);
    expect(r!.value).toBeGreaterThan(98);
    expect(r!.value).toBeLessThan(102);
  });

  it("still works when confidence/stability are absent (legacy chunks)", () => {
    const r = pickGlobalBpm([chunk(128, 10, 0), chunk(128, 10, 12)]);
    expect(r!.value).toBeCloseTo(128, 0);
  });
});
