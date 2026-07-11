import { describe, it, expect } from "vitest";
import { packFxIntoSlots } from "./pack";
import type { PunchFx } from "./types";

const fx = (id: string, inS: number, outS: number): PunchFx => ({
  id,
  kind: "vignette",
  inS,
  outS,
});

describe("packFxIntoSlots", () => {
  it("returns 0 slots for empty input", () => {
    const r = packFxIntoSlots([]);
    expect(r.slots).toBe(0);
    expect(r.layout).toEqual([]);
  });

  it("uses a single slot for a single fx", () => {
    const r = packFxIntoSlots([fx("a", 0, 1)]);
    expect(r.slots).toBe(1);
    expect(r.layout).toEqual([{ id: "a", slotIdx: 0 }]);
  });

  it("uses a single slot for sequential non-overlapping fx", () => {
    const r = packFxIntoSlots([fx("a", 0, 1), fx("b", 1, 2), fx("c", 2, 3)]);
    expect(r.slots).toBe(1);
    expect(r.layout.map((l) => l.slotIdx)).toEqual([0, 0, 0]);
  });

  it("stacks two overlapping fx into two slots", () => {
    const r = packFxIntoSlots([fx("a", 0, 2), fx("b", 1, 3)]);
    expect(r.slots).toBe(2);
    const a = r.layout.find((l) => l.id === "a")!;
    const b = r.layout.find((l) => l.id === "b")!;
    expect(a.slotIdx).toBe(0);
    expect(b.slotIdx).toBe(1);
  });

  it("uses N slots when N fx all overlap simultaneously", () => {
    const r = packFxIntoSlots([
      fx("a", 0, 5),
      fx("b", 0, 5),
      fx("c", 0, 5),
      fx("d", 0, 5),
    ]);
    expect(r.slots).toBe(4);
  });

  it("re-uses lower slots after they free up (greedy)", () => {
    // a:0-2 in slot0, b:1-4 in slot1 (overlaps a), c:3-5 starts after a
    // ends → can reuse slot0.
    const r = packFxIntoSlots([
      fx("a", 0, 2),
      fx("b", 1, 4),
      fx("c", 3, 5),
    ]);
    expect(r.slots).toBe(2);
    const layoutById = new Map(r.layout.map((l) => [l.id, l.slotIdx]));
    expect(layoutById.get("a")).toBe(0);
    expect(layoutById.get("b")).toBe(1);
    // c starts at 3, a (slot0) ended at 2 → c gets slot0.
    expect(layoutById.get("c")).toBe(0);
  });

  it("processes input regardless of inS-order", () => {
    // Same as above, but shuffled in input. Output identifies by id.
    const r = packFxIntoSlots([
      fx("c", 3, 5),
      fx("a", 0, 2),
      fx("b", 1, 4),
    ]);
    expect(r.slots).toBe(2);
    const layoutById = new Map(r.layout.map((l) => [l.id, l.slotIdx]));
    expect(layoutById.get("a")).toBe(0);
    expect(layoutById.get("b")).toBe(1);
    expect(layoutById.get("c")).toBe(0);
  });

  it("treats touching ends as non-overlapping (a.outS == b.inS)", () => {
    // outS is exclusive — fx ending at 1.0 doesn't conflict with one
    // starting at 1.0 in the same slot.
    const r = packFxIntoSlots([fx("a", 0, 1), fx("b", 1, 2)]);
    expect(r.slots).toBe(1);
  });
});
