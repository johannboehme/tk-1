/**
 * Walker-planner tests — the pure decision core of the Arrange audio
 * walker (useArrangeAudio). Covers the two playback modes:
 *
 *   1. arrangement mode — walk item to item, crossfade-hop near each
 *      chunk end, stop after the last item.
 *   2. preview mode — transient loop over a pool chunk's master-time
 *      range (chunk audition before committing it to the strip).
 */
import { describe, expect, it } from "vitest";
import { planWalkerTick } from "./arrange-walker";
import type { ArrangementItem, Chunk } from "../../storage/jobs-db";

function chunk(id: string, startMs: number, endMs: number): Chunk {
  return {
    id,
    startMs,
    endMs,
    bpmOctaveShift: 0,
    effectiveBpm: 120,
    detectedBpm: 120,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
  };
}

function arr(id: string, chunkId: string): ArrangementItem {
  return { id, chunkId };
}

const LEAD = 0.05;

const chunks = [chunk("c1", 0, 1000), chunk("c2", 2000, 3000), chunk("cPool", 8000, 9000)];
const arrangement = [arr("a1", "c1"), arr("a2", "c2")];

function plan(overrides: Partial<Parameters<typeof planWalkerTick>[0]>) {
  return planWalkerTick({
    isPlaying: true,
    hasArmed: false,
    tS: 0.5,
    arrangement,
    chunks,
    currentItemId: "a1",
    previewChunkId: null,
    leadTimeS: LEAD,
    ...overrides,
  });
}

describe("planWalkerTick · gates", () => {
  it("does nothing while paused", () => {
    expect(plan({ isPlaying: false })).toEqual({ kind: "none" });
  });

  it("does nothing while a crossfade is already armed", () => {
    expect(plan({ hasArmed: true, tS: 0.99 })).toEqual({ kind: "none" });
  });
});

describe("planWalkerTick · arrangement mode", () => {
  it("stays idle mid-chunk", () => {
    expect(plan({ tS: 0.5 })).toEqual({ kind: "none" });
  });

  it("arms an advance-hop near the tracked chunk's end", () => {
    const p = plan({ tS: 0.97 });
    expect(p).toEqual({
      kind: "arm-advance",
      hopToS: 2,
      remainingS: expect.closeTo(0.03, 5),
      nextItemId: "a2",
    });
  });

  it("arms an end-stop near the last item's end", () => {
    const p = plan({ currentItemId: "a2", tS: 2.97 });
    expect(p).toEqual({ kind: "arm-end", remainingS: expect.closeTo(0.03, 5) });
  });

  it("stops when the tracked item vanished from the arrangement", () => {
    expect(plan({ currentItemId: "gone" })).toEqual({ kind: "stop" });
    expect(plan({ currentItemId: null })).toEqual({ kind: "stop" });
  });

  it("does not arm when t already ran past the tracked chunk's end", () => {
    // Matches the pre-existing arrangement semantics: remaining <= 0
    // means the seek subscription / stop logic handles it, not an arm.
    expect(plan({ tS: 1.5 })).toEqual({ kind: "none" });
  });
});

describe("planWalkerTick · preview mode (pool chunk audition)", () => {
  it("stays idle mid-preview-chunk", () => {
    expect(plan({ previewChunkId: "cPool", tS: 8.5 })).toEqual({ kind: "none" });
  });

  it("arms a loop-hop back to the chunk start near its end", () => {
    const p = plan({ previewChunkId: "cPool", tS: 8.97 });
    expect(p).toEqual({
      kind: "arm-loop",
      hopToS: 8,
      remainingS: expect.closeTo(0.03, 5),
    });
  });

  it("arms an immediate loop-hop when t derailed past the chunk end", () => {
    const p = plan({ previewChunkId: "cPool", tS: 9.4 });
    expect(p).toEqual({ kind: "arm-loop", hopToS: 8, remainingS: 0 });
  });

  it("preview overrides the arrangement walker even with a live currentItemId", () => {
    const p = plan({ previewChunkId: "cPool", currentItemId: "a1", tS: 0.97 });
    expect(p).toEqual({ kind: "none" });
  });

  it("previews fine with an empty arrangement (never bails to stop)", () => {
    const p = plan({
      previewChunkId: "cPool",
      arrangement: [],
      currentItemId: null,
      tS: 8.5,
    });
    expect(p).toEqual({ kind: "none" });
  });

  it("stops when the previewed chunk no longer exists", () => {
    expect(plan({ previewChunkId: "gone", tS: 8.5 })).toEqual({ kind: "stop" });
  });
});
