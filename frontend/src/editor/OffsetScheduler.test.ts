import { describe, expect, test } from "vitest";
import { clampLoopRegion } from "./OffsetScheduler";

describe("clampLoopRegion", () => {
  test("loop fully inside trim is unchanged", () => {
    expect(
      clampLoopRegion({ start: 1, end: 2 }, { in: 0, out: 5 }),
    ).toEqual({ start: 1, end: 2 });
  });

  test("loop extending past trim end is clipped to trim end", () => {
    expect(
      clampLoopRegion({ start: 4, end: 7 }, { in: 0, out: 5 }),
    ).toEqual({ start: 4, end: 5 });
  });

  test("loop starting before trim is shifted to trim start", () => {
    expect(
      clampLoopRegion({ start: -1, end: 1 }, { in: 0, out: 5 }),
    ).toEqual({ start: 0, end: 1 });
  });

  test("returns null when loop completely outside trim", () => {
    expect(
      clampLoopRegion({ start: 10, end: 12 }, { in: 0, out: 5 }),
    ).toBeNull();
  });

  test("returns null when start equals end after clamping", () => {
    expect(
      clampLoopRegion({ start: 5, end: 6 }, { in: 0, out: 5 }),
    ).toBeNull();
  });
});
