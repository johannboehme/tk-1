import { describe, it, expect } from "vitest";
import {
  countEditsAffectedByChunkRemoval,
  countEditsAffectedByItemRemoval,
  countEditsAffectedByCamRemoval,
  arrangementItemsForChunk,
  isAlwaysAdjacentInArrangement,
} from "./edits-impact";
import type { ArrangementItem, PillRecord, Cut, PunchFxRecord } from "../storage/jobs-db";

function pill(id: string, camId: string, fromArrId: string | undefined, opts: Partial<PillRecord> = {}): PillRecord {
  return {
    id,
    camId,
    arrStartS: 0,
    arrEndS: 10,
    sourceInS: 0,
    sourceOutS: 10,
    originalArrStartS: 0,
    originalArrEndS: 10,
    originalSourceInS: 0,
    originalSourceOutS: 10,
    fromArrangementItemId: fromArrId,
    ...opts,
  };
}

describe("arrangementItemsForChunk", () => {
  it("returns all arrangement items referencing a chunk id", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
      { id: "a3", chunkId: "c1" },
    ];
    expect(arrangementItemsForChunk("c1", arr)).toEqual(["a1", "a3"]);
    expect(arrangementItemsForChunk("c2", arr)).toEqual(["a2"]);
    expect(arrangementItemsForChunk("c-missing", arr)).toEqual([]);
  });
});

describe("countEditsAffectedByChunkRemoval", () => {
  it("counts items, user-edited pills, cuts in item ranges, and fx in item ranges", () => {
    const arrangement: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
      { id: "a3", chunkId: "c1" },
    ];
    const pills: PillRecord[] = [
      pill("cam-1::a1", "cam-1", "a1", {
        arrStartS: 0,
        arrEndS: 5,
        userEdited: true,
      }),
      pill("cam-1::a2", "cam-1", "a2", { arrStartS: 5, arrEndS: 10 }),
      pill("cam-1::a3", "cam-1", "a3", {
        arrStartS: 10,
        arrEndS: 15,
        userEdited: true,
      }),
    ];
    const cuts: Cut[] = [
      { atTimeS: 1, camId: "cam-1" },
      { atTimeS: 6, camId: "cam-1" },
      { atTimeS: 12, camId: "cam-1" },
    ];
    const fx: PunchFxRecord[] = [
      { id: "fx1", kind: "vignette", inS: 0.5, outS: 1.5 },
      { id: "fx2", kind: "echo", inS: 11, outS: 14 },
      { id: "fx3", kind: "rgb", inS: 7, outS: 8 }, // outside chunk c1 ranges
    ];

    const r = countEditsAffectedByChunkRemoval("c1", arrangement, pills, cuts, fx);
    expect(r.items).toBe(2);
    expect(r.userEditedPills).toBe(2);
    expect(r.cuts).toBe(2);
    expect(r.fx).toBe(2);
  });

  it("returns zeros when chunk not in arrangement", () => {
    const r = countEditsAffectedByChunkRemoval("c-missing", [], [], [], []);
    expect(r).toEqual({ items: 0, cuts: 0, fx: 0, userEditedPills: 0 });
  });
});

describe("countEditsAffectedByItemRemoval", () => {
  it("counts cuts and fx that fall inside this item's pill ranges", () => {
    const pills: PillRecord[] = [
      pill("cam-1::a1", "cam-1", "a1", { arrStartS: 0, arrEndS: 5, userEdited: true }),
      pill("cam-2::a1", "cam-2", "a1", { arrStartS: 0, arrEndS: 5 }),
      pill("cam-1::a2", "cam-1", "a2", { arrStartS: 5, arrEndS: 10 }),
    ];
    const cuts: Cut[] = [
      { atTimeS: 1, camId: "cam-1" },
      { atTimeS: 4, camId: "cam-2" },
      { atTimeS: 7, camId: "cam-1" },
    ];
    const fx: PunchFxRecord[] = [
      { id: "fx1", kind: "vignette", inS: 0.5, outS: 1.5 },
      { id: "fx2", kind: "echo", inS: 6, outS: 8 },
    ];

    const r = countEditsAffectedByItemRemoval("a1", pills, cuts, fx);
    expect(r.userEditedPills).toBe(1);
    expect(r.cuts).toBe(2);
    expect(r.fx).toBe(1);
  });
});

describe("countEditsAffectedByCamRemoval", () => {
  it("counts user-edited pills, cuts, and fx tied to this cam", () => {
    const pills: PillRecord[] = [
      pill("cam-1::a1", "cam-1", "a1", { userEdited: true }),
      pill("cam-1::a2", "cam-1", "a2", { userEdited: true }),
      pill("cam-2::a1", "cam-2", "a1", { userEdited: false }),
    ];
    const cuts: Cut[] = [
      { atTimeS: 1, camId: "cam-1" },
      { atTimeS: 5, camId: "cam-2" },
    ];
    const fx: PunchFxRecord[] = [];

    const r = countEditsAffectedByCamRemoval("cam-1", pills, cuts, fx);
    expect(r.userEditedPills).toBe(2);
    expect(r.cuts).toBe(1);
    expect(r.fx).toBe(0);
  });
});

describe("isAlwaysAdjacentInArrangement", () => {
  it("returns true when both chunks always appear directly adjacent (in either order)", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
    ];
    expect(isAlwaysAdjacentInArrangement("c1", "c2", arr)).toBe(true);
    expect(isAlwaysAdjacentInArrangement("c2", "c1", arr)).toBe(true);
  });

  it("returns true when both occur multiple times but always adjacent", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c2" },
      { id: "a3", chunkId: "c3" },
      { id: "a4", chunkId: "c2" },
      { id: "a5", chunkId: "c1" },
    ];
    expect(isAlwaysAdjacentInArrangement("c1", "c2", arr)).toBe(true);
  });

  it("returns false if any occurrence is isolated (no neighbour of the other id)", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c3" },
      { id: "a3", chunkId: "c2" },
    ];
    expect(isAlwaysAdjacentInArrangement("c1", "c2", arr)).toBe(false);
  });

  it("returns false if only one of the two is in the arrangement", () => {
    const arr: ArrangementItem[] = [
      { id: "a1", chunkId: "c1" },
      { id: "a2", chunkId: "c1" },
    ];
    expect(isAlwaysAdjacentInArrangement("c1", "c2", arr)).toBe(false);
  });

  it("returns true when neither chunk appears in the arrangement (vacuously true → silent merge)", () => {
    const arr: ArrangementItem[] = [{ id: "a1", chunkId: "c3" }];
    expect(isAlwaysAdjacentInArrangement("c1", "c2", arr)).toBe(true);
  });
});
