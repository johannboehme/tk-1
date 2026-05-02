import { describe, it, expect } from "vitest";
import {
  computeOutputFrameBox,
  resolveOutputAspectRatio,
  resolveOutputDims,
} from "./output-frame";
import type { Clip } from "./types";

function videoClip(id: string, displayW?: number, displayH?: number): Clip {
  return {
    kind: "video",
    id,
    filename: `${id}.mp4`,
    color: "#fff",
    sourceDurationS: 60,
    syncOffsetMs: 0,
    syncOverrideMs: 0,
    startOffsetS: 0,
    driftRatio: 1,
    candidates: [],
    selectedCandidateIdx: 0,
    displayW,
    displayH,
  };
}

describe("computeOutputFrameBox", () => {
  it("returns full container when AR matches container", () => {
    const box = computeOutputFrameBox(16 / 9, { width: 1600, height: 900 });
    expect(box).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });

  it("letterboxes top/bottom when output is wider than container", () => {
    const box = computeOutputFrameBox(16 / 9, { width: 1600, height: 1000 });
    expect(box.left).toBe(0);
    expect(box.width).toBe(1600);
    expect(box.height).toBeCloseTo(900, 6);
    expect(box.top).toBeCloseTo(50, 6);
  });

  it("pillarboxes left/right when output is taller than container", () => {
    const box = computeOutputFrameBox(9 / 16, { width: 1600, height: 900 });
    expect(box.top).toBe(0);
    expect(box.height).toBe(900);
    expect(box.width).toBeCloseTo(506.25, 4);
    expect(box.left).toBeCloseTo((1600 - 506.25) / 2, 4);
  });

  it("returns zero-area for zero container", () => {
    expect(computeOutputFrameBox(16 / 9, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });

  it("returns full container for non-positive AR", () => {
    expect(
      computeOutputFrameBox(0, { width: 100, height: 50 }),
    ).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });
});

describe("resolveOutputDims", () => {
  it("prefers explicit resolution over clip dims", () => {
    const dims = resolveOutputDims(
      [videoClip("a", 1080, 1920)],
      { w: 1920, h: 1080 },
    );
    expect(dims).toEqual({ w: 1920, h: 1080 });
  });

  it("falls back to FIRST clip's dims (sorted by startS) — no bbox", () => {
    // First by startS = "a" (startOffsetS 0). Second clip dims must NOT
    // affect output — even if larger.
    const dims = resolveOutputDims(
      [videoClip("a", 1080, 1920), videoClip("b", 3840, 2160)],
      undefined,
    );
    expect(dims).toEqual({ w: 1080, h: 1920 });
  });

  it("respects timeline order — earliest clip wins", () => {
    const a = videoClip("a", 1920, 1080);
    a.startOffsetS = 10;
    const b = videoClip("b", 1080, 1920);
    b.startOffsetS = 0;
    // 'b' is earlier on the master timeline — its dims define the stage.
    expect(resolveOutputDims([a, b], "source")).toEqual({ w: 1080, h: 1920 });
  });

  it("falls back to a single clip's dims when only one has them", () => {
    const dims = resolveOutputDims(
      [videoClip("a", 1080, 1920), videoClip("b")],
      "source",
    );
    expect(dims).toEqual({ w: 1080, h: 1920 });
  });

  it("skips clips without dims and uses the first that has them", () => {
    const a = videoClip("a"); // no dims
    const b = videoClip("b", 1920, 1080); // earlier on tl, but no dims wins later
    a.startOffsetS = 0;
    b.startOffsetS = 5;
    expect(resolveOutputDims([a, b], "source")).toEqual({ w: 1920, h: 1080 });
  });

  it("returns null when no clip has dims yet and no explicit resolution", () => {
    expect(resolveOutputDims([videoClip("a")], "source")).toBeNull();
    expect(resolveOutputDims([], undefined)).toBeNull();
  });
});

describe("resolveOutputAspectRatio", () => {
  it("derives AR from explicit resolution", () => {
    const ar = resolveOutputAspectRatio({
      resolution: { w: 1920, h: 1080 },
      clips: [],
    });
    expect(ar).toBeCloseTo(16 / 9, 6);
  });

  it("derives AR from the FIRST clip on the timeline", () => {
    const ar = resolveOutputAspectRatio({
      resolution: "source",
      clips: [videoClip("a", 1080, 1920), videoClip("b", 1920, 1080)],
    });
    // first clip = portrait 1080×1920 → 9:16.
    expect(ar).toBeCloseTo(1080 / 1920, 6);
  });

  it("returns null when nothing is known", () => {
    expect(
      resolveOutputAspectRatio({ resolution: "source", clips: [] }),
    ).toBeNull();
  });
});
