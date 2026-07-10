import { describe, expect, it } from "vitest";
import { buildTimeRulerTicks, niceStep } from "./time-ruler-ticks";

describe("niceStep", () => {
  it("rounds up to the next 'nice' clock step", () => {
    expect(niceStep(0.4)).toBe(0.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(6)).toBe(10);
    expect(niceStep(45)).toBe(60);
    expect(niceStep(1500)).toBe(1800);
  });

  it("falls back to whole hours above the table", () => {
    expect(niceStep(4000)).toBe(7200);
  });

  it("guards degenerate input", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
  });
});

describe("buildTimeRulerTicks", () => {
  it("returns empty for a degenerate view or width", () => {
    expect(buildTimeRulerTicks(10, 10, 800)).toEqual([]);
    expect(buildTimeRulerTicks(10, 5, 800)).toEqual([]);
    expect(buildTimeRulerTicks(0, 60, 0)).toEqual([]);
  });

  it("emits labeled majors on nice steps and unlabeled minors between", () => {
    // 60 s across 1200 px → ~10 majors → majorStep 10 s, minorStep 2 s.
    const ticks = buildTimeRulerTicks(0, 60, 1200);
    const majors = ticks.filter((t) => t.major);
    expect(majors.map((t) => t.t)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(majors.map((t) => t.label)).toEqual([
      "0:00",
      "0:10",
      "0:20",
      "0:30",
      "0:40",
      "0:50",
      "1:00",
    ]);
    for (const t of ticks.filter((x) => !x.major)) {
      expect(t.label).toBe("");
    }
  });
});
