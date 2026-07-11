import { describe, it, expect } from "vitest";
import { activeFxAt } from "./active";
import type { PunchFx } from "./types";

const fx = (id: string, inS: number, outS: number): PunchFx => ({
  id,
  kind: "vignette",
  inS,
  outS,
});

describe("activeFxAt", () => {
  it("returns empty array for empty input", () => {
    expect(activeFxAt([], 1.0)).toEqual([]);
  });

  it("includes a fx when t is exactly at inS (inclusive start)", () => {
    expect(activeFxAt([fx("a", 1.0, 2.0)], 1.0)).toHaveLength(1);
  });

  it("excludes a fx when t is exactly at outS (exclusive end)", () => {
    expect(activeFxAt([fx("a", 1.0, 2.0)], 2.0)).toEqual([]);
  });

  it("excludes a fx fully before t", () => {
    expect(activeFxAt([fx("a", 0.0, 1.0)], 1.5)).toEqual([]);
  });

  it("excludes a fx fully after t", () => {
    expect(activeFxAt([fx("a", 2.0, 3.0)], 1.0)).toEqual([]);
  });

  it("returns multiple overlapping fx in original (stable) order", () => {
    const a = fx("a", 0, 10);
    const b = fx("b", 1, 5);
    const c = fx("c", 2, 4);
    const result = activeFxAt([a, b, c], 3.0);
    expect(result.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const list = [fx("a", 0, 1), fx("b", 0.5, 1.5)];
    const snapshot = list.slice();
    activeFxAt(list, 0.7);
    expect(list).toEqual(snapshot);
  });
});
