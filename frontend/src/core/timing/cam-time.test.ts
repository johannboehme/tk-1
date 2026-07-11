import { describe, expect, it } from "vitest";
import { camSourceTimeS, camSourceTimeUs } from "./cam-time";

describe("camSourceTimeS — shared cam-frame time mapping", () => {
  it("identity at masterStartS=0, driftRatio=1", () => {
    expect(camSourceTimeS(0, { masterStartS: 0, driftRatio: 1 })).toBe(0);
    expect(camSourceTimeS(7.5, { masterStartS: 0, driftRatio: 1 })).toBe(7.5);
  });

  it("subtracts masterStartS for an offset cam", () => {
    expect(camSourceTimeS(5, { masterStartS: 2, driftRatio: 1 })).toBe(3);
  });

  it("treats negative masterStartS (cam started before t=0)", () => {
    // Cam-1 had 1.5 s of pre-roll → at master t=0 cam already at source 1.5
    expect(
      camSourceTimeS(0, { masterStartS: -1.5, driftRatio: 1 }),
    ).toBeCloseTo(1.5, 9);
    expect(
      camSourceTimeS(2, { masterStartS: -1.5, driftRatio: 1 }),
    ).toBeCloseTo(3.5, 9);
  });

  it("scales by driftRatio so cam catches up to master", () => {
    // driftRatio=1.001 means cam clock ran 0.1 % faster than master.
    // After 1000 master-seconds the cam is at source 1001.
    const cam = { masterStartS: 0, driftRatio: 1.001 };
    expect(camSourceTimeS(1000, cam)).toBeCloseTo(1001, 6);
    // Sub-second case (the one that matters in practice).
    expect(camSourceTimeS(60, cam)).toBeCloseTo(60.06, 6);
  });

  it("composes masterStartS and driftRatio correctly", () => {
    // Cam at masterStartS=2, drift 1.001. At masterT=12 we expect
    // (12-2)*1.001 = 10.01 source-seconds.
    expect(
      camSourceTimeS(12, { masterStartS: 2, driftRatio: 1.001 }),
    ).toBeCloseTo(10.01, 6);
  });

  it("drift < 1 (cam ran slower than master) shrinks source-time", () => {
    expect(
      camSourceTimeS(100, { masterStartS: 0, driftRatio: 0.999 }),
    ).toBeCloseTo(99.9, 6);
  });
});

describe("camSourceTimeUs — micro-second flooring", () => {
  it("converts seconds to integer microseconds", () => {
    expect(camSourceTimeUs(1.234567, { masterStartS: 0, driftRatio: 1 })).toBe(
      1_234_567,
    );
  });

  it("floors so the result is reproducible at hop boundaries", () => {
    // 1.0000005 s → 1.0000005 * 1e6 = 1000000.5 → floor 1000000.
    expect(camSourceTimeUs(1.0000005, { masterStartS: 0, driftRatio: 1 })).toBe(
      1_000_000,
    );
  });
});
