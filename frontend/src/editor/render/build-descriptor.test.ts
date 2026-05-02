import { describe, expect, it } from "vitest";
import {
  buildElementFitRect,
  buildPreviewFrameDescriptor,
  type EditorStoreSnapshot,
} from "./build-descriptor";
import type { Clip, ImageClip, VideoClip } from "../types";
import type { Cut } from "../../storage/jobs-db";
import type { PunchFx } from "../fx/types";

function video(id: string, displayW?: number, displayH?: number, more: Partial<VideoClip> = {}): VideoClip {
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
    ...more,
  };
}

function image(id: string, displayW?: number, displayH?: number, more: Partial<ImageClip> = {}): ImageClip {
  return {
    kind: "image",
    id,
    filename: `${id}.png`,
    color: "#fff",
    durationS: 5,
    startOffsetS: 0,
    displayW,
    displayH,
    ...more,
  };
}

function snap(over: Partial<EditorStoreSnapshot> = {}): EditorStoreSnapshot {
  return {
    clips: [],
    cuts: [],
    fx: [],
    exportSpec: { preset: "web" },
    ...over,
  };
}

// ----------------------------------------------------------------------

describe("buildPreviewFrameDescriptor — output dims", () => {
  it("returns null output and no layers when no clips have displayDims", () => {
    const d = buildPreviewFrameDescriptor(snap(), 0);
    expect(d.output).toBeNull();
    expect(d.layers).toEqual([]);
  });

  it("uses FIRST clip's dims (by start time) as the Stage default", () => {
    // No bbox anymore — first clip wins. Both at startOffsetS=0, so 'a' is first.
    const clips: Clip[] = [video("a", 1920, 1080), video("b", 720, 1280)];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    expect(d.output).toEqual({ w: 1920, h: 1080 });
  });

  it("explicit exportSpec.resolution overrides the first-clip default", () => {
    const clips: Clip[] = [video("a", 1920, 1080)];
    const d = buildPreviewFrameDescriptor(
      snap({ clips, exportSpec: { preset: "custom", resolution: { w: 1280, h: 720 } } }),
      0,
    );
    expect(d.output).toEqual({ w: 1280, h: 720 });
  });

  it("snaps output dims to integer pixels", () => {
    const clips: Clip[] = [video("a", 1280, 720)];
    const d = buildPreviewFrameDescriptor(
      snap({ clips, exportSpec: { preset: "custom", resolution: { w: 1280.4, h: 719.6 } } }),
      0,
    );
    expect(d.output).toEqual({ w: 1280, h: 720 });
  });
});

// ----------------------------------------------------------------------

describe("buildPreviewFrameDescriptor — layers", () => {
  it("emits no layers when output is null even if clips exist", () => {
    const d = buildPreviewFrameDescriptor(snap({ clips: [video("a")] }), 0);
    expect(d.output).toBeNull();
    expect(d.layers).toEqual([]);
  });

  it("emits one video layer for the active cam at full output rect", () => {
    const clips: Clip[] = [video("a", 1920, 1080)];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    expect(d.layers).toHaveLength(1);
    const l = d.layers[0];
    expect(l.layerId).toBe("a");
    expect(l.weight).toBe(1);
    expect(l.fitRect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(l.rotationDeg).toBe(0);
    expect(l.flipX).toBe(false);
    expect(l.flipY).toBe(false);
    expect(l.displayW).toBe(1920);
    expect(l.displayH).toBe(1080);
  });

  it("video layer carries source-time and duration", () => {
    const clips: Clip[] = [video("a", 1920, 1080, { sourceDurationS: 30 })];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 1.5);
    const l = d.layers[0];
    expect(l.source).toEqual({
      kind: "video",
      clipId: "a",
      sourceTimeS: 1.5,
      sourceDurS: 30,
    });
  });

  it("source-time includes syncOffset / override / drift", () => {
    // syncOffsetMs=200 → masterStartS = -0.2 → source(t=0.5) = (0.5 - (-0.2)) * 1.5 = 1.05
    const clips: Clip[] = [
      video("a", 1920, 1080, { syncOffsetMs: 200, driftRatio: 1.5 }),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0.5);
    const src = d.layers[0].source;
    if (src.kind !== "video") throw new Error("expected video source");
    expect(src.sourceTimeS).toBeCloseTo(1.05, 6);
  });

  it("emits image layer for an image clip", () => {
    const clips: Clip[] = [image("img1", 800, 600)];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    expect(d.layers[0].source).toEqual({ kind: "image", clipId: "img1" });
  });

  it("respects cuts: switches active cam at cut time", () => {
    const clips: Clip[] = [video("a", 1920, 1080), video("b", 1920, 1080)];
    const cuts: Cut[] = [{ atTimeS: 1.0, camId: "b" }];
    const before = buildPreviewFrameDescriptor(snap({ clips, cuts }), 0.5);
    const after = buildPreviewFrameDescriptor(snap({ clips, cuts }), 1.5);
    expect(before.layers[0].layerId).toBe("a");
    expect(after.layers[0].layerId).toBe("b");
  });

  it("emits no layers (only test-pattern fallback) when no cam has material at t", () => {
    // Clip with finite range; t outside its range → activeCamId is null
    const clips: Clip[] = [
      video("a", 1920, 1080, { sourceDurationS: 1, trimInS: 0, trimOutS: 1 }),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 5);
    expect(d.layers).toEqual([]);
  });

  it("user rotation 90 swaps display dims and propagates rotationDeg", () => {
    const clips: Clip[] = [
      video("a", 1920, 1080, { rotation: 90, flipX: true }),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    const l = d.layers[0];
    expect(l.rotationDeg).toBe(90);
    expect(l.flipX).toBe(true);
    expect(l.flipY).toBe(false);
    expect(l.displayW).toBe(1080);
    expect(l.displayH).toBe(1920);
  });

  it("rotation 180 leaves display dims, sets rotationDeg=180", () => {
    const clips: Clip[] = [video("a", 1920, 1080, { rotation: 180 })];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    const l = d.layers[0];
    expect(l.rotationDeg).toBe(180);
    expect(l.displayW).toBe(1920);
    expect(l.displayH).toBe(1080);
  });

  it("normalises out-of-range rotation values", () => {
    const clips: Clip[] = [video("a", 1920, 1080, { rotation: 450 })]; // 450 → 90
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    expect(d.layers[0].rotationDeg).toBe(90);
  });

  it("cover-fits a portrait active cam into a landscape Stage (overflows top/bottom)", () => {
    // First clip = 'a' landscape (Stage = 1920×1080). Cut to portrait 'b'.
    const clips: Clip[] = [video("a", 1920, 1080), video("b", 720, 1280)];
    const cuts: Cut[] = [{ atTimeS: 0, camId: "b" }];
    const d = buildPreviewFrameDescriptor(snap({ clips, cuts }), 0.5);
    expect(d.output).toEqual({ w: 1920, h: 1080 });
    const fr = d.layers[0].fitRect;
    // cover-fit: portrait 720×1280 in 1920×1080 Stage. Scale up to fill width
    // (Stage is wider than the source), so dstW = 1920 and dstH overflows.
    expect(fr.x).toBe(0);
    expect(fr.w).toBe(1920);
    // Source AR 720/1280 = 0.5625, dstH = 1920 / 0.5625 ≈ 3413
    expect(fr.h).toBeCloseTo(1920 / (720 / 1280), 1);
    // Vertically centered → negative y offset (overflow above & below).
    expect(fr.y).toBeCloseTo((1080 - fr.h) / 2, 1);
  });

  it("cover-fits a landscape active cam into a portrait Stage (overflows sides)", () => {
    // First clip = 'a' portrait (Stage = 720×1280).
    const clips: Clip[] = [video("a", 720, 1280), video("b", 1920, 1080)];
    const cuts: Cut[] = [{ atTimeS: 0, camId: "b" }];
    const d = buildPreviewFrameDescriptor(snap({ clips, cuts }), 0.5);
    expect(d.output).toEqual({ w: 720, h: 1280 });
    const fr = d.layers[0].fitRect;
    // Landscape 1920×1080 in portrait 720×1280: fill height (1280),
    // dstW overflows sides.
    expect(fr.y).toBe(0);
    expect(fr.h).toBe(1280);
    expect(fr.w).toBeCloseTo(1280 * (1920 / 1080), 1);
    expect(fr.x).toBeCloseTo((720 - fr.w) / 2, 1);
  });

  it("applies viewportTransform.scale on top of cover-fit", () => {
    const clips: Clip[] = [
      video("a", 1920, 1080, { viewportTransform: { scale: 2, x: 0, y: 0 } }),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    const fr = d.layers[0].fitRect;
    // cover at 1920×1080 → 1920×1080. scale 2 → 3840×2160 around center.
    expect(fr.w).toBe(3840);
    expect(fr.h).toBe(2160);
    expect(fr.x).toBe(-960);
    expect(fr.y).toBe(-540);
  });

  it("applies viewportTransform.x/y as a translate on top of cover-fit", () => {
    const clips: Clip[] = [
      video("a", 1920, 1080, { viewportTransform: { scale: 1, x: 100, y: -50 } }),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    const fr = d.layers[0].fitRect;
    expect(fr.x).toBe(100);
    expect(fr.y).toBe(-50);
    expect(fr.w).toBe(1920);
    expect(fr.h).toBe(1080);
  });
});

// ----------------------------------------------------------------------

describe("buildPreviewFrameDescriptor — fx", () => {
  it("includes only active fx in stable order", () => {
    const fx: PunchFx[] = [
      { id: "f1", kind: "vignette", inS: 0, outS: 1.0 },
      { id: "f2", kind: "vignette", inS: 0.5, outS: 1.5, params: { intensity: 0.5 } },
      { id: "f3", kind: "vignette", inS: 2, outS: 3 },
    ];
    const d = buildPreviewFrameDescriptor(snap({ fx }), 0.7);
    expect(d.fx.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("merges defaults into params when fx has none", () => {
    const fx: PunchFx[] = [{ id: "f1", kind: "vignette", inS: 0, outS: 1.0 }];
    const d = buildPreviewFrameDescriptor(snap({ fx }), 0.5);
    const params = d.fx[0].params;
    expect(params.intensity).toBeGreaterThan(0);
    expect(params.falloff).toBeGreaterThan(0);
  });

  it("explicit params override defaults but missing keys still default", () => {
    const fx: PunchFx[] = [
      { id: "f1", kind: "vignette", inS: 0, outS: 1.0, params: { intensity: 0.3 } },
    ];
    const d = buildPreviewFrameDescriptor(snap({ fx }), 0.5);
    expect(d.fx[0].params.intensity).toBe(0.3);
    expect(d.fx[0].params.falloff).toBeGreaterThan(0); // default applied
  });

  it("returns empty fx list when none active at t", () => {
    const fx: PunchFx[] = [{ id: "f1", kind: "vignette", inS: 0, outS: 0.5 }];
    const d = buildPreviewFrameDescriptor(snap({ fx }), 1.0);
    expect(d.fx).toEqual([]);
  });
});

// ----------------------------------------------------------------------

describe("buildPreviewFrameDescriptor — structural invariants", () => {
  it("descriptor is JSON-roundtrip-safe (no DOM refs, no functions)", () => {
    const clips: Clip[] = [video("a", 1920, 1080, { rotation: 90, flipX: true })];
    const fx: PunchFx[] = [{ id: "f", kind: "vignette", inS: 0, outS: 1 }];
    const d = buildPreviewFrameDescriptor(snap({ clips, fx }), 0.5);
    const round = JSON.parse(JSON.stringify(d));
    expect(round).toEqual(d);
  });

  it("layers from cuts are exclusive — V2 emits at most one layer", () => {
    const clips: Clip[] = [
      video("a", 1920, 1080),
      video("b", 1920, 1080),
      video("c", 1920, 1080),
    ];
    const d = buildPreviewFrameDescriptor(snap({ clips }), 0);
    expect(d.layers.length).toBeLessThanOrEqual(1);
  });

  it("fx from polyphonic FX list — multiple can overlap at the same time", () => {
    const fx: PunchFx[] = [
      { id: "f1", kind: "vignette", inS: 0, outS: 1 },
      { id: "f2", kind: "vignette", inS: 0, outS: 1 },
      { id: "f3", kind: "vignette", inS: 0, outS: 1 },
    ];
    const d = buildPreviewFrameDescriptor(snap({ fx }), 0.5);
    expect(d.fx).toHaveLength(3);
  });
});

// ----------------------------------------------------------------------

describe("buildElementFitRect (shared with export)", () => {
  it("equal aspect → element exactly fills the Stage", () => {
    expect(buildElementFitRect({ w: 1920, h: 1080 }, { w: 1280, h: 720 })).toEqual({
      x: 0,
      y: 0,
      w: 1280,
      h: 720,
    });
  });

  it("element wider than stage → fills height, overflows sides (cover)", () => {
    // 1920×1080 in 1920×1280 stage: fill height (1280), dstW overflows.
    const r = buildElementFitRect({ w: 1920, h: 1080 }, { w: 1920, h: 1280 });
    expect(r.h).toBe(1280);
    // dstW = 1280 * (1920/1080) ≈ 2275.5
    expect(r.w).toBeCloseTo(1280 * (1920 / 1080), 1);
    expect(r.x).toBeCloseTo((1920 - r.w) / 2, 1);
    expect(r.y).toBe(0);
  });

  it("element taller than stage → fills width, overflows top/bottom (cover)", () => {
    const r = buildElementFitRect({ w: 720, h: 1280 }, { w: 1920, h: 1280 });
    expect(r.w).toBe(1920);
    expect(r.h).toBeCloseTo(1920 / (720 / 1280), 1);
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo((1280 - r.h) / 2, 1);
  });

  it("returns zero rect for non-positive inputs", () => {
    expect(buildElementFitRect({ w: 0, h: 1080 }, { w: 1920, h: 1280 })).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });

  it("respects an explicit ViewportTransform", () => {
    const r = buildElementFitRect(
      { w: 1920, h: 1080 },
      { w: 1920, h: 1080 },
      { scale: 0.5, x: 50, y: -30 },
    );
    expect(r.w).toBe(960);
    expect(r.h).toBe(540);
    expect(r.x).toBe(480 + 50);
    expect(r.y).toBe(270 - 30);
  });
});

// ----------------------------------------------------------------------

describe("buildPreviewFrameDescriptor — fx wetness + live override", () => {
  const fx = (
    id: string,
    inS: number,
    outS: number,
    over: Partial<PunchFx> = {},
  ): PunchFx => ({
    id,
    kind: "vignette",
    inS,
    outS,
    ...over,
  });

  it("INSTANT envelope yields wetness=1 throughout the active range", () => {
    const f = fx("a", 0, 1);
    const d = buildPreviewFrameDescriptor(snap({ fx: [f] }), 0.5);
    expect(d.fx).toHaveLength(1);
    expect(d.fx[0].wetness).toBe(1);
  });

  it("samples envelope to a fractional wetness in the release phase", () => {
    const f = fx("a", 0, 1, {
      envelope: { attackS: 0, decayS: 0, sustain: 1, releaseS: 0.4 },
    });
    // releaseStart = 0.6 → at t=0.8 we are halfway through release
    const d = buildPreviewFrameDescriptor(snap({ fx: [f] }), 0.8);
    expect(d.fx[0].wetness).toBeCloseTo(0.5, 5);
  });

  it("drops fx whose wetness collapses to 0 at the very end of the region", () => {
    const f = fx("a", 0, 1);
    // INSTANT at t == outS is exclusive → 0 wetness → dropped
    const d = buildPreviewFrameDescriptor(snap({ fx: [f] }), 1.0);
    expect(d.fx).toHaveLength(0);
  });

  it("overrides params with fxDefaults when selectedFxKind matches", () => {
    const f = fx("a", 0, 1, { params: { intensity: 0.2, falloff: 0.2 } });
    const d = buildPreviewFrameDescriptor(
      snap({
        fx: [f],
        selectedFxKind: "vignette",
        fxDefaults: { vignette: { intensity: 0.9, falloff: 0.7 } },
      }),
      0.5,
    );
    expect(d.fx[0].params).toMatchObject({ intensity: 0.9, falloff: 0.7 });
  });

  it("does NOT override params when selectedFxKind is a different kind", () => {
    const f = fx("a", 0, 1, { params: { intensity: 0.2, falloff: 0.2 } });
    const d = buildPreviewFrameDescriptor(
      snap({
        fx: [f],
        selectedFxKind: "wear",
        fxDefaults: { vignette: { intensity: 0.9, falloff: 0.7 } },
      }),
      0.5,
    );
    expect(d.fx[0].params).toMatchObject({ intensity: 0.2, falloff: 0.2 });
  });

  it("overrides envelope with fxEnvelopes when selectedFxKind matches", () => {
    const f = fx("a", 0, 1, {
      envelope: { attackS: 0, decayS: 0, sustain: 1, releaseS: 0 }, // would be wetness=1
    });
    const d = buildPreviewFrameDescriptor(
      snap({
        fx: [f],
        selectedFxKind: "vignette",
        fxEnvelopes: {
          vignette: { attackS: 0, decayS: 0, sustain: 0.5, releaseS: 0 },
        },
      }),
      0.5,
    );
    // Override envelope has sustain=0.5 → wetness=0.5 in sustain phase
    expect(d.fx[0].wetness).toBeCloseTo(0.5, 5);
  });

  it("synthesises preview holds with full wetness into the descriptor", () => {
    const d = buildPreviewFrameDescriptor(
      snap({
        fxHolds: {
          "key:F": {
            mode: "preview",
            kind: "vignette",
            fxId: "",
            startS: 1.5,
          },
        },
        fxDefaults: { vignette: { intensity: 0.85, falloff: 0.6 } },
      }),
      0,
    );
    expect(d.fx).toHaveLength(1);
    expect(d.fx[0].kind).toBe("vignette");
    expect(d.fx[0].wetness).toBe(1);
    expect(d.fx[0].params).toMatchObject({ intensity: 0.85, falloff: 0.6 });
  });

  it("ignores persistent holds in the synthesis pass (they're already in fx[])", () => {
    const f = fx("real", 0, 1);
    const d = buildPreviewFrameDescriptor(
      snap({
        fx: [f],
        fxHolds: {
          "key:F": {
            mode: "persistent",
            kind: "vignette",
            fxId: "real",
            startS: 0,
          },
        },
      }),
      0.5,
    );
    // Only the real fx, no synthesised duplicate
    expect(d.fx).toHaveLength(1);
    expect(d.fx[0].id).toBe("real");
  });
});
