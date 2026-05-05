import { describe, it, expect } from "vitest";
import { buildSyncProgressView } from "./parse-stage";

const cams = [{ id: "cam-1" }, { id: "cam-2" }, { id: "cam-3" }];

describe("buildSyncProgressView — initial states", () => {
  it("queued: master and all cams pending", () => {
    const v = buildSyncProgressView({ stage: "queued", pct: 0, cams });
    expect(v.master).toBe("pending");
    expect(v.cams.map((c) => c.state)).toEqual(["pending", "pending", "pending"]);
    expect(v.globalPct).toBe(0);
  });

  it("loading (pct 2): master is decoding, cams pending", () => {
    const v = buildSyncProgressView({ stage: "loading", pct: 2, cams });
    expect(v.master).toBe("decoding");
    expect(v.cams.every((c) => c.state === "pending")).toBe(true);
  });

  it("decoding-studio-audio: master is decoding", () => {
    const v = buildSyncProgressView({
      stage: "decoding-studio-audio",
      pct: 5,
      cams,
    });
    expect(v.master).toBe("decoding");
    expect(v.cams.every((c) => c.state === "pending")).toBe(true);
  });
});

describe("buildSyncProgressView — per-cam routing", () => {
  it("syncing-cam-1: cam-1 syncing, others pending, master done", () => {
    const v = buildSyncProgressView({
      stage: "syncing-cam-1",
      pct: 10,
      cams,
    });
    expect(v.master).toBe("done");
    expect(v.cams[0].state).toBe("syncing");
    expect(v.cams[1].state).toBe("pending");
    expect(v.cams[2].state).toBe("pending");
  });

  it("frames-cam-1: cam-1 in frames stage", () => {
    const v = buildSyncProgressView({ stage: "frames-cam-1", pct: 25, cams });
    expect(v.cams[0].state).toBe("frames");
    expect(v.cams[1].state).toBe("pending");
  });

  it("syncing-cam-2: cam-1 done, cam-2 syncing, cam-3 pending", () => {
    const v = buildSyncProgressView({ stage: "syncing-cam-2", pct: 40, cams });
    expect(v.cams[0].state).toBe("done");
    expect(v.cams[1].state).toBe("syncing");
    expect(v.cams[2].state).toBe("pending");
  });

  it("frames-cam-3 (last cam): earlier cams done, cam-3 in frames", () => {
    const v = buildSyncProgressView({ stage: "frames-cam-3", pct: 90, cams });
    expect(v.cams[0].state).toBe("done");
    expect(v.cams[1].state).toBe("done");
    expect(v.cams[2].state).toBe("frames");
  });
});

describe("buildSyncProgressView — local fraction", () => {
  it("computes fraction for the active cam from global pct within its band", () => {
    // 3 cams → band = 90/3 = 30. cam-1 covers pct 5..35.
    const v = buildSyncProgressView({
      stage: "syncing-cam-1",
      pct: 20,
      cams,
    });
    // 20 within [5, 35] → (20 - 5) / 30 = 0.5
    expect(v.cams[0].fraction).toBeCloseTo(0.5, 2);
  });

  it("clamps fraction to [0, 1]", () => {
    const v = buildSyncProgressView({
      stage: "syncing-cam-1",
      pct: 100,
      cams,
    });
    expect(v.cams[0].fraction).toBeLessThanOrEqual(1);
    expect(v.cams[0].fraction).toBeGreaterThanOrEqual(0);
  });

  it("inactive cams have fraction 0", () => {
    const v = buildSyncProgressView({
      stage: "syncing-cam-2",
      pct: 50,
      cams,
    });
    expect(v.cams[2].fraction).toBe(0);
  });
});

describe("buildSyncProgressView — analyzing & done", () => {
  it("analyzing-audio: all cams done, master analyzing", () => {
    const v = buildSyncProgressView({
      stage: "analyzing-audio",
      pct: 95,
      cams,
    });
    expect(v.master).toBe("analyzing");
    expect(v.cams.every((c) => c.state === "done")).toBe(true);
  });

  it("done flag: everything done", () => {
    const v = buildSyncProgressView({
      stage: "queued",
      pct: 0,
      cams,
      done: true,
    });
    expect(v.master).toBe("done");
    expect(v.cams.every((c) => c.state === "done")).toBe(true);
    expect(v.globalPct).toBe(100);
  });
});

describe("buildSyncProgressView — failure", () => {
  it("error without cam-stage marks master as failed", () => {
    const v = buildSyncProgressView({
      stage: "loading",
      pct: 5,
      cams,
      error: "boom",
    });
    expect(v.master).toBe("failed");
  });

  it("failed mid-cam: that cam is failed, prior cams done, later cams pending", () => {
    // Stage was "syncing-cam-2" when failure hit.
    const v = buildSyncProgressView({
      stage: "syncing-cam-2",
      pct: 45,
      cams,
      error: "decode failed",
    });
    expect(v.cams[0].state).toBe("done");
    expect(v.cams[1].state).toBe("failed");
    expect(v.cams[2].state).toBe("pending");
  });
});

describe("buildSyncProgressView — single cam edge", () => {
  it("works with a single cam (no division-by-zero risks)", () => {
    const v = buildSyncProgressView({
      stage: "syncing-cam-1",
      pct: 50,
      cams: [{ id: "cam-1" }],
    });
    expect(v.cams).toHaveLength(1);
    expect(v.cams[0].state).toBe("syncing");
    // Single-cam band is 90, starting at 5. 50 in [5, 95] → 0.5.
    expect(v.cams[0].fraction).toBeCloseTo(0.5, 2);
  });

  it("works with zero cams (defensive)", () => {
    const v = buildSyncProgressView({ stage: "queued", pct: 0, cams: [] });
    expect(v.cams).toEqual([]);
    expect(v.master).toBe("pending");
  });
});

describe("buildSyncProgressView — unknown cam id in stage string", () => {
  it("treats unknown cam-id stage as no specific cam active (falls back to global pct heuristic)", () => {
    const v = buildSyncProgressView({
      stage: "syncing-cam-99",
      pct: 50,
      cams,
    });
    // No cam should crash. All cams are pending if we can't find the active one.
    expect(v.cams.every((c) => c.state === "pending" || c.state === "done")).toBe(true);
  });
});
