/**
 * Pure-function tests for the Triage transport/sequence/seam logic.
 * No React, no audio — plain chunk objects in, plain values out.
 */
import { describe, it, expect } from "vitest";
import {
  loopForMode,
  buildSequence,
  nextSequenceId,
  resolveSeamWindow,
  seamHopTarget,
} from "./triage-sequence";
import type { Chunk } from "../../storage/jobs-db";

function makeChunk(
  o: Partial<Chunk> & Pick<Chunk, "id" | "startMs" | "endMs">,
): Chunk {
  return {
    bpmOctaveShift: 0,
    effectiveBpm: 120,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...o,
  };
}

describe("loopForMode", () => {
  const c = makeChunk({ id: "c1", startMs: 2000, endMs: 6000 });

  it("returns the focused chunk's bounds in seconds in loop mode", () => {
    expect(loopForMode("loop", c)).toEqual({ start: 2, end: 6 });
  });

  it("returns null in loop mode with no focused chunk", () => {
    expect(loopForMode("loop", null)).toBeNull();
  });

  it("returns null in continue mode even with a focused chunk", () => {
    expect(loopForMode("continue", c)).toBeNull();
  });

  it("returns null in sequence mode even with a focused chunk", () => {
    expect(loopForMode("sequence", c)).toBeNull();
  });
});

describe("buildSequence", () => {
  it("returns only accepted chunks, sorted by startMs", () => {
    const seq = buildSequence(
      [
        makeChunk({ id: "c3", startMs: 8000, endMs: 9000 }),
        makeChunk({ id: "c1", startMs: 1000, endMs: 2000 }),
        makeChunk({ id: "c2", startMs: 4000, endMs: 5000, accepted: false }),
      ],
      0,
      null,
      4,
    );
    expect(seq.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("drops chunks below the min-bars filter (needs bpm to size a bar)", () => {
    // 120 BPM, 4/4 → msPerBar = (60000/120)*4 = 2000ms; minBars 2 → 4000ms.
    const seq = buildSequence(
      [
        makeChunk({ id: "short", startMs: 0, endMs: 1000 }), // 1s < 4s
        makeChunk({ id: "long", startMs: 5000, endMs: 10000 }), // 5s ≥ 4s
      ],
      2,
      120,
      4,
    );
    expect(seq.map((c) => c.id)).toEqual(["long"]);
  });

  it("keeps everything accepted when the filter is off", () => {
    const seq = buildSequence(
      [
        makeChunk({ id: "a", startMs: 0, endMs: 100 }),
        makeChunk({ id: "b", startMs: 200, endMs: 300 }),
      ],
      0,
      120,
      4,
    );
    expect(seq.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("nextSequenceId", () => {
  const seq = [
    makeChunk({ id: "a", startMs: 0, endMs: 1000 }),
    makeChunk({ id: "b", startMs: 2000, endMs: 3000 }),
    makeChunk({ id: "c", startMs: 4000, endMs: 5000 }),
  ];

  it("returns the next chunk's id", () => {
    expect(nextSequenceId(seq, "a")).toBe("b");
    expect(nextSequenceId(seq, "b")).toBe("c");
  });

  it("returns null at the last chunk", () => {
    expect(nextSequenceId(seq, "c")).toBeNull();
  });

  it("returns null when the current id is not in the sequence", () => {
    expect(nextSequenceId(seq, "zzz")).toBeNull();
  });

  it("returns null for a null current id or empty sequence", () => {
    expect(nextSequenceId(seq, null)).toBeNull();
    expect(nextSequenceId([], "a")).toBeNull();
  });
});

describe("resolveSeamWindow", () => {
  const a = makeChunk({ id: "a", startMs: 10000, endMs: 20000 }); // 10–20s
  const b = makeChunk({ id: "b", startMs: 50000, endMs: 70000 }); // 50–70s
  const chunks = [a, b];

  it("returns the four edges when both chunks + brackets are in range", () => {
    const win = resolveSeamWindow(
      { aId: "a", bId: "b", loopInS: 18, loopOutS: 53 },
      chunks,
    );
    expect(win).toEqual({ loopInS: 18, aEndS: 20, bStartS: 50, loopOutS: 53 });
  });

  it("returns null when B is not yet chosen", () => {
    expect(
      resolveSeamWindow({ aId: "a", bId: null, loopInS: 18, loopOutS: 0 }, chunks),
    ).toBeNull();
  });

  it("returns null when a referenced chunk is missing", () => {
    expect(
      resolveSeamWindow({ aId: "a", bId: "gone", loopInS: 18, loopOutS: 53 }, chunks),
    ).toBeNull();
  });

  it("clamps loopIn back to A.start when it is at/after A.end", () => {
    const win = resolveSeamWindow(
      { aId: "a", bId: "b", loopInS: 25, loopOutS: 53 },
      chunks,
    );
    expect(win?.loopInS).toBe(10);
  });

  it("clamps loopOut back to B.end when it is at/before B.start", () => {
    const win = resolveSeamWindow(
      { aId: "a", bId: "b", loopInS: 18, loopOutS: 45 },
      chunks,
    );
    expect(win?.loopOutS).toBe(70);
  });

  it("supports A === B (audition a chunk's own tail→head)", () => {
    const win = resolveSeamWindow(
      { aId: "a", bId: "a", loopInS: 12, loopOutS: 18 },
      [a],
    );
    expect(win).toEqual({ loopInS: 12, aEndS: 20, bStartS: 10, loopOutS: 18 });
  });
});

describe("seamHopTarget", () => {
  const win = { loopInS: 18, aEndS: 20, bStartS: 50, loopOutS: 53 };

  it("phase A arms at A.end and hops to B.start", () => {
    expect(seamHopTarget(win, "A")).toEqual({
      armAtS: 20,
      seekToS: 50,
      nextPhase: "B",
    });
  });

  it("phase B arms at loopOut and wraps back to loopIn", () => {
    expect(seamHopTarget(win, "B")).toEqual({
      armAtS: 53,
      seekToS: 18,
      nextPhase: "A",
    });
  });
});
