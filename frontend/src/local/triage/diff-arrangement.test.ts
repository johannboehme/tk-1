import { describe, it, expect } from "vitest";
import { propagateTriageChangesToArrangement } from "./diff-arrangement";
import type { ArrangementItem, Chunk } from "../../storage/jobs-db";

function chunk(id: string, opts: Partial<Chunk> = {}): Chunk {
  return {
    id,
    startMs: 0,
    endMs: 10_000,
    bpmOctaveShift: 0,
    effectiveBpm: 120,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...opts,
  };
}

describe("propagateTriageChangesToArrangement", () => {
  it("returns the same arrangement reference when chunks are unchanged", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
    ];
    const prev = [chunk("c1"), chunk("c2")];
    const next = [chunk("c1"), chunk("c2")];
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toBe(arr);
  });

  it("removes arrangement items whose chunk was deleted entirely", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
      { id: "a3", chunkId: "c1" },
    ];
    const prev = [chunk("c1"), chunk("c2")];
    const next = [chunk("c2")];
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toEqual([{ id: "a2", chunkId: "c2" }]);
  });

  it("removes arrangement items when a chunk's accepted flips to false", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
    ];
    const prev = [chunk("c1", { accepted: true }), chunk("c2", { accepted: true })];
    const next = [chunk("c1", { accepted: false }), chunk("c2", { accepted: true })];
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toEqual([{ id: "a2", chunkId: "c2" }]);
  });

  it("does NOT auto-add new chunks to the arrangement (pool only)", () => {
    const arr: ArrangementItem[] = [{ id: "a1", chunkId: "c1" }];
    const prev = [chunk("c1")];
    const next = [chunk("c1"), chunk("c2", { id: "c2" })]; // c2 is new
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toEqual([{ id: "a1", chunkId: "c1" }]);
  });

  it("leaves arrangement unchanged when a chunk's bounds are trimmed but it's still in chunks list", () => {
    const arr: ArrangementItem[] = [{ id: "a1", chunkId: "c1" }];
    const prev = [chunk("c1", { startMs: 1000, endMs: 5000 })];
    const next = [chunk("c1", { startMs: 1500, endMs: 4500 })]; // trimmed
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toBe(arr); // identity preserved (no removal needed)
  });

  it("preserves order and ids of remaining items", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
      { id: "a3", chunkId: "c3" },
      { id: "a4", chunkId: "c2" },
    ];
    const prev = [chunk("c1"), chunk("c2"), chunk("c3")];
    const next = [chunk("c1"), chunk("c3")]; // c2 removed
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toEqual([
      { id: "a1", chunkId: "c1" },
      { id: "a3", chunkId: "c3" },
    ]);
  });

  it("returns identity when arrangement is empty regardless of chunk diff", () => {
    const arr: ArrangementItem[] = [];
    const prev = [chunk("c1")];
    const next: Chunk[] = [];
    const out = propagateTriageChangesToArrangement(prev, next, arr);
    expect(out).toBe(arr);
  });
});
