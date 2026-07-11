import { describe, expect, it } from "vitest";
import { AdaptiveScaler } from "./adaptive-scaler";

const FAST_MS = 8;
const SLOW_MS = 30;

function fill(scaler: AdaptiveScaler, frameMs: number, n: number): void {
  for (let i = 0; i < n; i++) scaler.record(frameMs);
}

describe("AdaptiveScaler", () => {
  it("starts at the supplied initial scale (clamped to min/max)", () => {
    expect(new AdaptiveScaler(1.0).scale).toBe(1.0);
    expect(new AdaptiveScaler(0.5).scale).toBe(0.5);
    // Out of bounds → clamped.
    expect(new AdaptiveScaler(5.0).scale).toBe(1.0);
    expect(new AdaptiveScaler(0.01).scale).toBe(0.25);
  });

  it("does not adjust before the window is half-full", () => {
    const s = new AdaptiveScaler(1.0, { windowSize: 30 });
    fill(s, SLOW_MS, 5); // only 5 samples in a 30-sample window
    expect(s.consult().changed).toBe(false);
    expect(s.scale).toBe(1.0);
  });

  it("scales DOWN when p95 frame time is over the lag threshold", () => {
    const s = new AdaptiveScaler(1.0);
    fill(s, SLOW_MS, 30);
    const status = s.consult();
    expect(status.changed).toBe(true);
    expect(status.scale).toBeCloseTo(0.75, 5);
    expect(s.scale).toBeCloseTo(0.75, 5);
  });

  it("scales UP when p95 is well below the fast threshold", () => {
    const s = new AdaptiveScaler(0.5);
    fill(s, FAST_MS, 30);
    const status = s.consult();
    expect(status.changed).toBe(true);
    expect(status.scale).toBeGreaterThan(0.5);
    expect(status.scale).toBeLessThanOrEqual(1.0);
  });

  it("does not scale above max (1.0) under any sample distribution", () => {
    const s = new AdaptiveScaler(1.0);
    fill(s, FAST_MS, 30);
    s.consult();
    expect(s.scale).toBe(1.0);
  });

  it("does not scale below min (0.25) on persistent lag", () => {
    const s = new AdaptiveScaler(0.3);
    // Repeated lag across multiple consult cycles — but cooldown gates
    // each step, so we manually fire many.
    for (let cycle = 0; cycle < 20; cycle++) {
      fill(s, SLOW_MS, 30);
      s.consult();
    }
    expect(s.scale).toBe(0.25);
  });

  it("respects cooldown — no two adjustments back to back", () => {
    const s = new AdaptiveScaler(1.0);
    fill(s, SLOW_MS, 30);
    expect(s.consult().changed).toBe(true);
    // Immediately fill again with lag → next consult should NOT
    // adjust because cooldown has not elapsed.
    fill(s, SLOW_MS, 30);
    expect(s.consult().changed).toBe(false);
  });

  it("ignores the in-between zone — neither lag nor fast → no change", () => {
    const s = new AdaptiveScaler(1.0);
    fill(s, 17, 30); // between fastThreshold (12) and lagThreshold (22)
    expect(s.consult().changed).toBe(false);
    expect(s.scale).toBe(1.0);
  });

  it("override() bypasses the auto-loop and resets cooldown", () => {
    const s = new AdaptiveScaler(1.0);
    s.override(0.5);
    expect(s.scale).toBe(0.5);
    // Even if we feed lag, cooldown blocks immediate reaction.
    fill(s, SLOW_MS, 30);
    expect(s.consult().changed).toBe(false);
  });
});
