/**
 * Tests for the re-detection merge — the reconcile step that runs when
 * the user tweaks the Threshold / Min-pause sliders and the silence
 * detector produces a fresh chunk list.
 *
 * The invariant under test: a parameter tweak must NOT wipe the user's
 * curation work. Keep/drop decisions, manual trims, splits, joins and
 * inserted chunks survive; only regions the new segmentation genuinely
 * abandons may disappear. Matching is overlap-based — a threshold nudge
 * moves nearly every chunk edge by at least one envelope sample, so
 * exact-boundary equality (the old behaviour) matched nothing.
 */
import { describe, expect, it } from "vitest";
import { mergeRedetectedChunks } from "./redetect-merge";
import type { Chunk } from "../../storage/jobs-db";

function makeChunk(
  overrides: Partial<Chunk> & Pick<Chunk, "id" | "startMs" | "endMs">,
): Chunk {
  return {
    bpmOctaveShift: 0,
    effectiveBpm: 0,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...overrides,
  };
}

/** A chunk shaped like the detector's output (id derived from bounds). */
function freshChunk(
  startMs: number,
  endMs: number,
  overrides: Partial<Chunk> = {},
): Chunk {
  return makeChunk({
    id: `chunk-${startMs}-${endMs}`,
    startMs,
    endMs,
    audioStartMs: startMs,
    originalStartMs: startMs,
    originalEndMs: endMs,
    originalAudioStartMs: startMs,
    ...overrides,
  });
}

describe("mergeRedetectedChunks — overlap matching for detector chunks", () => {
  it("carries id + accepted across a small boundary shift (threshold nudge)", () => {
    // 1 dB nudge → edges move by one 100 ms envelope sample.
    const prev = [
      makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000, accepted: false }),
      makeChunk({ id: "chunk-30000-40000", startMs: 30000, endMs: 40000, accepted: true }),
    ];
    const fresh = [freshChunk(9900, 20100), freshChunk(29900, 40100)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    const a = out.find((c) => c.startMs === 9900)!;
    const b = out.find((c) => c.startMs === 29900)!;
    // Identity and the user's DROP decision survive the shift.
    expect(a.id).toBe("chunk-10000-20000");
    expect(a.accepted).toBe(false);
    expect(b.id).toBe("chunk-30000-40000");
    expect(b.accepted).toBe(true);
  });

  it("carries bpmOctaveShift and falls back to prev analysis when fresh has none", () => {
    const prev = [
      makeChunk({
        id: "chunk-10000-20000",
        startMs: 10000,
        endMs: 20000,
        detectedBpm: 120,
        effectiveBpm: 240,
        bpmOctaveShift: 1,
        audioStartMs: 10250,
      }),
    ];
    const fresh = [freshChunk(9900, 20100)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(1);
    expect(out[0].bpmOctaveShift).toBe(1);
    expect(out[0].detectedBpm).toBe(120);
    expect(out[0].effectiveBpm).toBe(240);
  });

  it("prefers fresh analysis over prev when the fresh chunk has its own", () => {
    const prev = [
      makeChunk({
        id: "chunk-10000-20000",
        startMs: 10000,
        endMs: 20000,
        detectedBpm: 120,
        effectiveBpm: 120,
      }),
    ];
    const fresh = [
      freshChunk(9900, 20100, { detectedBpm: 96, effectiveBpm: 96, audioStartMs: 9950 }),
    ];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out[0].detectedBpm).toBe(96);
    expect(out[0].effectiveBpm).toBe(96);
    expect(out[0].audioStartMs).toBe(9950);
  });

  it("treats non-overlapping fresh chunks as genuinely new (accepted, fresh id)", () => {
    const prev = [makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 })];
    const fresh = [freshChunk(9900, 20100), freshChunk(50000, 60000)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    const fresh2 = out.find((c) => c.startMs === 50000)!;
    expect(fresh2.id).toBe("chunk-50000-60000");
    expect(fresh2.accepted).toBe(true);
  });

  it("matches each prev chunk at most once when one prev splits into two fresh chunks", () => {
    // Threshold raised: the quiet middle of one chunk fell below the
    // threshold — the region comes back as two fresh chunks. The bigger
    // half inherits the identity; the other is new.
    const prev = [
      makeChunk({ id: "chunk-10000-30000", startMs: 10000, endMs: 30000, accepted: false }),
    ];
    const fresh = [freshChunk(10000, 14000), freshChunk(18000, 30000)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    const big = out.find((c) => c.startMs === 18000)!;
    const small = out.find((c) => c.startMs === 10000)!;
    expect(big.id).toBe("chunk-10000-30000");
    expect(big.accepted).toBe(false);
    expect(small.id).toBe("chunk-10000-14000");
    expect(small.accepted).toBe(true);
  });

  it("does not match on insignificant overlap (< half of the shorter chunk)", () => {
    const prev = [
      makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000, accepted: false }),
    ];
    // Only 1 s of the 10 s prev chunk is covered — not the same chunk.
    const fresh = [freshChunk(19000, 45000)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("chunk-19000-45000");
    expect(out[0].accepted).toBe(true);
  });
});

describe("mergeRedetectedChunks — user-shaped chunks are preserved verbatim", () => {
  it("keeps a manually trimmed chunk untouched and drops the fresh chunk covering it", () => {
    const trimmed = makeChunk({
      id: "chunk-10000-20000",
      startMs: 12000,
      endMs: 18000,
      trimMode: "bar",
      accepted: true,
      audioStartMs: 12100,
    });
    const prev = [trimmed];
    const fresh = [freshChunk(9900, 20100)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(trimmed);
  });

  it("keeps manually split halves and drops the fresh chunk spanning both", () => {
    const left = makeChunk({
      id: "chunk-10000-20000",
      startMs: 10000,
      endMs: 15000,
      trimMode: "free",
    });
    const right = makeChunk({
      id: "chunk-10000-20000-r-abc",
      startMs: 15000,
      endMs: 20000,
      trimMode: "free",
      accepted: false,
    });
    const prev = [left, right];
    const fresh = [freshChunk(9900, 20100)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id).sort()).toEqual(
      ["chunk-10000-20000", "chunk-10000-20000-r-abc"].sort(),
    );
    expect(out.find((c) => c.id === "chunk-10000-20000-r-abc")!.accepted).toBe(false);
  });

  it("keeps a manually inserted chunk in a silence gap (no fresh counterpart)", () => {
    const manual = makeChunk({
      id: "manual-xyz",
      startMs: 42000,
      endMs: 46000,
      trimMode: "free",
    });
    const prev = [
      makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 }),
      manual,
    ];
    const fresh = [freshChunk(9900, 20100)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.id === "manual-xyz")).toEqual(manual);
  });

  it("keeps fresh chunks that only kiss a user chunk's boundary", () => {
    const trimmed = makeChunk({
      id: "chunk-10000-20000",
      startMs: 10000,
      endMs: 20050,
      trimMode: "free",
    });
    const prev = [trimmed];
    // 50 ms of overlap with a 10 s fresh chunk — a boundary kiss, not a
    // re-detection of the same region.
    const fresh = [freshChunk(20000, 30000)];
    const out = mergeRedetectedChunks(prev, fresh);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id).sort()).toEqual(
      ["chunk-10000-20000", "chunk-20000-30000"].sort(),
    );
  });

  it("output is sorted by startMs and has no duplicate ids", () => {
    const trimmed = makeChunk({
      id: "chunk-30000-40000",
      startMs: 31000,
      endMs: 39000,
      trimMode: "bar",
    });
    const prev = [
      trimmed,
      makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 }),
    ];
    const fresh = [
      freshChunk(9900, 20100),
      freshChunk(30000, 40000),
      freshChunk(50000, 60000),
    ];
    const out = mergeRedetectedChunks(prev, fresh);
    const starts = out.map((c) => c.startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
  });
});
