import { describe, expect, it } from "vitest";
import { buildRulerTicks } from "../../editor/components/timeline/beat-ruler-ticks";
import { buildChunkGridTicks, buildSeamBarTicks } from "./chunk-ruler-ticks";

/** 120 BPM → 0.5 s per beat, 2 s per bar (4/4). */
const BPM = 120;

const chunk = {
  startMs: 4_000,
  endMs: 12_000,
  audioStartMs: 4_000,
  effectiveBpm: BPM,
};

describe("buildChunkGridTicks — same math as the editor ruler", () => {
  it("produces the identical grid as buildRulerTicks for the same anchor/zoom", () => {
    // Window fully inside the chunk → no extensions, stride 1 at this zoom.
    const triage = buildChunkGridTicks(chunk, BPM, 4, 4, 12, 100);
    const editor = buildRulerTicks({
      bpm: BPM,
      beatPhase: 4,
      startS: 4,
      endS: 12,
      pxPerSec: 100,
      beatsPerBar: 4,
    });
    const grid = (ticks: typeof editor) =>
      ticks.map((t) => ({
        t: t.t,
        kind: t.kind,
        barNumber: t.barNumber,
        labeled: t.labeled,
      }));
    expect(grid(triage)).toEqual(grid(editor));
    // Sanity: the zoom actually exercises beats + 1/8 subdivisions.
    const kinds = new Set(triage.map((t) => t.kind));
    expect(kinds.has("beat")).toBe(true);
    expect(kinds.has("div8")).toBe(true);
  });

  it("anchors bar 1 on the chunk's audio start", () => {
    const shifted = { ...chunk, audioStartMs: 4_250 };
    const ticks = buildChunkGridTicks(shifted, BPM, 4, 0, 16, 60);
    const bar1 = ticks.find((t) => t.kind === "bar" && t.barNumber === 1);
    expect(bar1?.t).toBeCloseTo(4.25, 9);
  });

  it("projects the grid across the full view and flags out-of-chunk ticks as extension", () => {
    const ticks = buildChunkGridTicks(chunk, BPM, 4, 0, 16, 60);
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    // Half-open chunk span: the downbeat exactly on endMs belongs to the
    // extension (it opens bar 5 of a 4-bar chunk).
    expect(bars.map((t) => t.extension)).toEqual([
      true, // 0 s — before the chunk
      true, // 2 s
      false, // 4 s — bar 1
      false,
      false,
      false,
      true, // 12 s — boundary bar, not primary
      true,
      true,
    ]);
    expect(bars.map((t) => t.barNumber)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("prefers the job BPM over the chunk's own detection", () => {
    const ticks = buildChunkGridTicks(
      { ...chunk, detectedBpm: 97 },
      BPM,
      4,
      4,
      8,
      100,
    );
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([4, 6, 8]);
  });

  it("returns nothing when no BPM is available anywhere", () => {
    expect(
      buildChunkGridTicks(
        { startMs: 0, endMs: 4_000, effectiveBpm: 0 },
        null,
        4,
        0,
        4,
        100,
      ),
    ).toEqual([]);
  });
});

describe("buildSeamBarTicks — SeamStrip's thin projection", () => {
  it("keeps only downbeats and beats (no 1/8 or 1/16 clutter)", () => {
    // pxPerSec 100 → div8 would be emitted by the grid; the seam ruler
    // only knows downbeat/beat.
    const ticks = buildSeamBarTicks(chunk, BPM, 4, 4, 12, 100);
    expect(ticks.length).toBeGreaterThan(0);
    const times = ticks.map((t) => t.tS);
    for (const t of times) {
      // Every tick sits on a whole beat (0.5 s grid from the 4 s anchor).
      expect(Math.abs(((t - 4) / 0.5) % 1)).toBeLessThan(1e-9);
    }
    const downbeats = ticks.filter((t) => t.downbeat);
    expect(downbeats.map((t) => t.tS)).toEqual([4, 6, 8, 10, 12]);
    expect(downbeats.map((t) => t.bar)).toEqual([1, 2, 3, 4, 5]);
  });

  it("hides beats and bar labels progressively at low zoom instead of going blank", () => {
    // pxPerBeat 2 → pxPerBar 8 → stride 8: unlabeled downbeats survive
    // (bar: null), beats disappear.
    const ticks = buildSeamBarTicks(chunk, BPM, 4, 0, 120, 4);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.downbeat)).toBe(true);
    const labeled = ticks.filter((t) => t.bar != null);
    for (const t of labeled) expect((t.bar! - 1) % 8 === 0).toBe(true);
    expect(labeled.length).toBeLessThan(ticks.length);
  });
});
