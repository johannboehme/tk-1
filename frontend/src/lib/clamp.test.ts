import { describe, expect, it } from "vitest";
import { clamp, clamp01, clampSeek } from "./clamp";

describe("clamp", () => {
  it("passes through in-range values", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-3, -10, 10)).toBe(-3);
  });

  it("clamps to the bounds", () => {
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
  });

  it("propagates NaN (matches Math.max/min semantics)", () => {
    expect(clamp(Number.NaN, 0, 1)).toBeNaN();
  });
});

describe("clamp01", () => {
  it("clamps into [0, 1]", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.7)).toBe(0.7);
    expect(clamp01(1.4)).toBe(1);
  });
});

describe("clampSeek", () => {
  it("clamps into [0, duration]", () => {
    expect(clampSeek(5, 10)).toBe(5);
    expect(clampSeek(-1, 10)).toBe(0);
    expect(clampSeek(12, 10)).toBe(10);
  });

  it("non-finite target lands at 0", () => {
    expect(clampSeek(Number.NaN, 10)).toBe(0);
    expect(clampSeek(Number.POSITIVE_INFINITY, 10)).toBe(0);
  });

  it("invalid duration only floors at 0", () => {
    expect(clampSeek(7, 0)).toBe(7);
    expect(clampSeek(7, Number.NaN)).toBe(7);
    expect(clampSeek(-2, 0)).toBe(0);
  });
});
