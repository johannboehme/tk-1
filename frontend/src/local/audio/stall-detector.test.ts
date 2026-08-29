/**
 * Unit tests for the playback-stall detector (pure logic, no timers —
 * wall-clock time is passed in explicitly).
 */
import { describe, expect, it } from "vitest";
import { createStallDetector, STALL_AFTER_MS } from "./stall-detector";

describe("createStallDetector", () => {
  it("never stalls while the clock advances", () => {
    const d = createStallDetector();
    let now = 0;
    for (let t = 0; t < 10; t += 0.25) {
      expect(d.sample(t, now)).toBe(false);
      now += 250;
    }
  });

  it("reports a stall once the clock freezes past the threshold", () => {
    const d = createStallDetector();
    expect(d.sample(1.0, 0)).toBe(false); // baseline
    expect(d.sample(1.0, STALL_AFTER_MS - 1)).toBe(false);
    expect(d.sample(1.0, STALL_AFTER_MS)).toBe(true);
  });

  it("does not stall on the very first sample, even at a late wall time", () => {
    const d = createStallDetector();
    // e.g. the interval's first fire lands long after play() was called.
    expect(d.sample(0, 999999)).toBe(false);
  });

  it("treats backward clock jumps (loop wrap) as progress", () => {
    const d = createStallDetector();
    expect(d.sample(7.9, 0)).toBe(false);
    // Loop wraps: 7.9 → 2.0. Different value = progress, window resets.
    expect(d.sample(2.0, STALL_AFTER_MS)).toBe(false);
    expect(d.sample(2.0, STALL_AFTER_MS * 2 - 1)).toBe(false);
    expect(d.sample(2.0, STALL_AFTER_MS * 2)).toBe(true);
  });

  it("recovers after progress resumes", () => {
    const d = createStallDetector();
    expect(d.sample(1.0, 0)).toBe(false);
    expect(d.sample(1.0, STALL_AFTER_MS)).toBe(true);
    expect(d.sample(1.5, STALL_AFTER_MS + 250)).toBe(false);
    expect(d.sample(1.5, STALL_AFTER_MS + 500)).toBe(false);
  });

  it("survives throttled (sparse) sampling of a healthy clock", () => {
    // Background tabs throttle timers — samples may arrive minutes
    // apart. A moving clock must still never read as stalled.
    const d = createStallDetector();
    expect(d.sample(10, 0)).toBe(false);
    expect(d.sample(70, 60_000)).toBe(false);
    expect(d.sample(130, 120_000)).toBe(false);
  });

  it("reset() drops the baseline so the next sample re-arms", () => {
    const d = createStallDetector();
    expect(d.sample(3.0, 0)).toBe(false);
    d.reset();
    // Same frozen value, but post-reset this is a fresh baseline.
    expect(d.sample(3.0, STALL_AFTER_MS * 5)).toBe(false);
    expect(d.sample(3.0, STALL_AFTER_MS * 6)).toBe(true);
  });

  it("honors a custom threshold", () => {
    const d = createStallDetector(500);
    expect(d.sample(0, 0)).toBe(false);
    expect(d.sample(0, 499)).toBe(false);
    expect(d.sample(0, 500)).toBe(true);
  });
});
