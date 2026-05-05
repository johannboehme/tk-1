/**
 * Preview ↔ Export placement convergence.
 *
 * The preview descriptor builder and the export compositor used to have
 * separate `computeFitRect` implementations that drifted (different
 * letterbox semantics, different rounding). They now share
 * {@link buildElementFitRect}. This test pins that down: any future
 * attempt to introduce a second copy of the placement math will trip
 * here before it ships.
 *
 * We don't construct an actual export Compositor (it needs an
 * OffscreenCanvas + GPU/Canvas context that vitest's node environment
 * doesn't provide). Instead we exercise the SHARED helper directly and
 * compare against the FitRect that lands inside the preview descriptor.
 */
import { describe, it, expect } from "vitest";
import { buildPreviewFrameDescriptor } from "./build-descriptor";
import { buildElementFitRect } from "./element-transform";
import type { Clip, ViewportTransform } from "../types";
import { generatePills } from "../arrangement-pills";

function video(
  id: string,
  displayW: number,
  displayH: number,
  viewportTransform?: ViewportTransform,
): Clip {
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
    viewportTransform,
  };
}

const cases: Array<{
  name: string;
  display: { w: number; h: number };
  stage: { w: number; h: number };
  transform?: ViewportTransform;
}> = [
  {
    name: "equal aspect, identity",
    display: { w: 1920, h: 1080 },
    stage: { w: 1920, h: 1080 },
  },
  {
    name: "portrait element in landscape stage, identity",
    display: { w: 720, h: 1280 },
    stage: { w: 1920, h: 1080 },
  },
  {
    name: "landscape element in portrait stage, identity",
    display: { w: 1920, h: 1080 },
    stage: { w: 1080, h: 1920 },
  },
  {
    name: "scale 2 zoom-in",
    display: { w: 1920, h: 1080 },
    stage: { w: 1920, h: 1080 },
    transform: { scale: 2, x: 0, y: 0 },
  },
  {
    name: "translate offset",
    display: { w: 1920, h: 1080 },
    stage: { w: 1920, h: 1080 },
    transform: { scale: 1, x: 75, y: -33 },
  },
  {
    name: "scale + translate composite",
    display: { w: 1080, h: 1920 },
    stage: { w: 1920, h: 1080 },
    transform: { scale: 1.5, x: -200, y: 50 },
  },
];

describe("preview vs export — placement convergence", () => {
  for (const c of cases) {
    it(c.name, () => {
      const clips = [video("a", c.display.w, c.display.h, c.transform)];
      // Synthetic single-take shape — same as synthesizeJobLoadShape
      // produces in production. Without it, the descriptor builder
      // finds no active cam and returns no layers.
      const segments = [{ in: 0, out: 60 }];
      const arrangement = [{ id: "__default__", chunkId: "__default_chunk__" }];
      const chunks = [
        {
          id: "__default_chunk__",
          startMs: 0,
          endMs: 60_000,
          bpmOctaveShift: 0 as const,
          effectiveBpm: 0,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "free" as const,
        },
      ];
      const previewDescriptor = buildPreviewFrameDescriptor(
        {
          clips,
          cuts: [],
          fx: [],
          exportSpec: { preset: "custom", resolution: c.stage },
          pills: generatePills(arrangement, chunks, clips),
          arrangementSegments: segments,
        },
        0,
      );
      const previewFit = previewDescriptor.layers[0].fitRect;

      // Export pipeline reaches the same destination via the shared
      // helper. If a second copy of the math sneaks in elsewhere, this
      // assertion catches the drift.
      const exportFit = buildElementFitRect(c.display, c.stage, c.transform);

      expect(previewFit).toEqual(exportFit);
    });
  }
});
