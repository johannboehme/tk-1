import { describe, it, expect } from "vitest";
import {
  applySplitToArrangement,
  applyMergeToArrangement,
} from "./triage-arrangement-ops";
import type { ArrangementItem } from "../../storage/jobs-db";

const item = (id: string, chunkId: string): ArrangementItem => ({ id, chunkId });

describe("applySplitToArrangement", () => {
  it("returns identity when split is not in use (mode = 'a')", () => {
    const arr: ArrangementItem[] = [item("a1", "c1"), item("a2", "c2")];
    const out = applySplitToArrangement(arr, "c1", "c1-r", "a");
    expect(out).toBe(arr);
  });

  it("mode 'b' replaces every occurrence's chunkId with the new (right-half) id", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c2"),
      item("a3", "c1"),
    ];
    const out = applySplitToArrangement(arr, "c1", "c1-r", "b");
    expect(out).toEqual([
      item("a1", "c1-r"),
      item("a2", "c2"),
      item("a3", "c1-r"),
    ]);
  });

  it("mode 'both' inserts a new item with the new id after every original occurrence", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c2"),
      item("a3", "c1"),
    ];
    const out = applySplitToArrangement(arr, "c1", "c1-r", "both");
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(item("a1", "c1"));
    expect(out[1].chunkId).toBe("c1-r");
    expect(out[1].id).not.toBe("a1");
    expect(out[2]).toEqual(item("a2", "c2"));
    expect(out[3]).toEqual(item("a3", "c1"));
    expect(out[4].chunkId).toBe("c1-r");
    expect(out[4].id).not.toBe("a3");
    expect(out[1].id).not.toBe(out[4].id);
  });
});

describe("applyMergeToArrangement", () => {
  it("collapses adjacent (a,b) pairs to a single merged item", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c2"),
      item("a3", "c3"),
    ];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toEqual([item("a1", "c1"), item("a3", "c3")]);
  });

  it("collapses adjacent (b,a) pairs (other order)", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c2"),
      item("a2", "c1"),
      item("a3", "c3"),
    ];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toEqual([item("a1", "c1"), item("a3", "c3")]);
  });

  it("replaces standalone removed-id occurrences with merged id", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c3"),
      item("a3", "c2"),
    ];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toEqual([
      item("a1", "c1"),
      item("a2", "c3"),
      item("a3", "c1"),
    ]);
  });

  it("collapses every (merged, removed) and (removed, merged) adjacency", () => {
    // a1, a2 are an adjacent (merged, removed) pair → collapse.
    // a4, a5 are an adjacent (removed, merged) pair → collapse.
    // a3 is isolated and not the removed id → pass through.
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c2"),
      item("a3", "c3"),
      item("a4", "c2"),
      item("a5", "c1"),
    ];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toEqual([
      item("a1", "c1"),
      item("a3", "c3"),
      item("a4", "c1"),
    ]);
  });

  it("handles isolated removed-id between non-adjacent merged-ids (replace, no collapse)", () => {
    const arr: ArrangementItem[] = [
      item("a1", "c1"),
      item("a2", "c3"),
      item("a3", "c2"),
      item("a4", "c4"),
      item("a5", "c1"),
    ];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toEqual([
      item("a1", "c1"),
      item("a2", "c3"),
      item("a3", "c1"),
      item("a4", "c4"),
      item("a5", "c1"),
    ]);
  });

  it("returns identity when neither id is present", () => {
    const arr: ArrangementItem[] = [item("a1", "c3"), item("a2", "c4")];
    const out = applyMergeToArrangement(arr, "c1", "c2");
    expect(out).toBe(arr);
  });
});
