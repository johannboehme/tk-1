/**
 * Tests for `arrangementToSegments` — the bridge from the user's
 * arrange-stage decisions into the renderer/editor's segment model.
 */
import { describe, expect, it } from "vitest";
import { arrangementToSegments, totalSegmentDurationS } from "./chunks-to-segments";
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

describe("arrangementToSegments", () => {
  it("maps each item to a segment in arrangement order", () => {
    const chunks = [
      chunk("c1", 1000, 3000),
      chunk("c2", 5000, 9000),
    ];
    const arrangement = [arr("a1", "c2"), arr("a2", "c1")];
    const segs = arrangementToSegments(arrangement, chunks);
    expect(segs).toEqual([
      { in: 5, out: 9 },
      { in: 1, out: 3 },
    ]);
  });

  it("emits duplicate segments for repeated chunkIds (no coalescing)", () => {
    const chunks = [chunk("c1", 0, 2000)];
    const arrangement = [arr("a1", "c1"), arr("a2", "c1"), arr("a3", "c1")];
    const segs = arrangementToSegments(arrangement, chunks);
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.in === 0 && s.out === 2)).toBe(true);
  });

  it("skips items whose chunk is missing from the pool", () => {
    const chunks = [chunk("c1", 0, 1000)];
    const arrangement = [arr("a1", "c1"), arr("a2", "c-deleted")];
    const segs = arrangementToSegments(arrangement, chunks);
    expect(segs).toEqual([{ in: 0, out: 1 }]);
  });

  it("applies endTrimMs to all segments", () => {
    const chunks = [chunk("c1", 0, 1000)];
    const segs = arrangementToSegments([arr("a1", "c1")], chunks, {
      endTrimMs: 100,
    });
    expect(segs).toEqual([{ in: 0, out: 0.9 }]);
  });

  it("drops segments where endTrim makes the window collapse", () => {
    const chunks = [chunk("c-tiny", 0, 50)];
    const segs = arrangementToSegments([arr("a", "c-tiny")], chunks, {
      endTrimMs: 100,
    });
    expect(segs).toEqual([]);
  });

  it("totalSegmentDurationS sums durations", () => {
    const segs = [
      { in: 0, out: 1.5 },
      { in: 5, out: 10 },
    ];
    expect(totalSegmentDurationS(segs)).toBeCloseTo(6.5, 6);
  });
});
