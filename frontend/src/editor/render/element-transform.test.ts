import { describe, it, expect } from "vitest";
import {
  coverFitDefault,
  applyViewportTransform,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "./element-transform";

describe("coverFitDefault", () => {
  it("equal aspect → fills stage exactly", () => {
    const r = coverFitDefault({ w: 1920, h: 1080 }, { w: 1920, h: 1080 });
    expect(r).toEqual({ dstX: 0, dstY: 0, dstW: 1920, dstH: 1080 });
  });

  it("widescreen element in portrait stage → full-height, sides cropped", () => {
    const stage = { w: 1080, h: 1920 };
    const r = coverFitDefault({ w: 1920, h: 1080 }, stage);
    expect(r.dstH).toBeCloseTo(1920, 4);
    // dstW > stageW → element overflows horizontally (will be clipped).
    expect(r.dstW).toBeGreaterThan(stage.w);
    // Vertically centered on the stage (overflow is symmetric).
    expect(r.dstY).toBeCloseTo(0, 4);
    expect(r.dstX).toBeCloseTo((stage.w - r.dstW) / 2, 4);
  });

  it("portrait element in widescreen stage → full-width, top/bottom cropped", () => {
    const stage = { w: 1920, h: 1080 };
    const r = coverFitDefault({ w: 1080, h: 1920 }, stage);
    expect(r.dstW).toBeCloseTo(1920, 4);
    expect(r.dstH).toBeGreaterThan(stage.h);
    expect(r.dstX).toBeCloseTo(0, 4);
    expect(r.dstY).toBeCloseTo((stage.h - r.dstH) / 2, 4);
  });

  it("smaller element scales up to fill stage", () => {
    // 480×270 (16:9) into 1920×1080 → scale 4× → 1920×1080.
    const r = coverFitDefault({ w: 480, h: 270 }, { w: 1920, h: 1080 });
    expect(r.dstW).toBeCloseTo(1920, 4);
    expect(r.dstH).toBeCloseTo(1080, 4);
    expect(r.dstX).toBeCloseTo(0, 4);
    expect(r.dstY).toBeCloseTo(0, 4);
  });

  it("returns zero rect when element dims are degenerate", () => {
    expect(coverFitDefault({ w: 0, h: 100 }, { w: 1920, h: 1080 })).toEqual({
      dstX: 0,
      dstY: 0,
      dstW: 0,
      dstH: 0,
    });
    expect(coverFitDefault({ w: 100, h: 0 }, { w: 1920, h: 1080 })).toEqual({
      dstX: 0,
      dstY: 0,
      dstW: 0,
      dstH: 0,
    });
  });

  it("returns zero rect when stage is degenerate", () => {
    expect(coverFitDefault({ w: 1920, h: 1080 }, { w: 0, h: 0 })).toEqual({
      dstX: 0,
      dstY: 0,
      dstW: 0,
      dstH: 0,
    });
  });
});

describe("applyViewportTransform", () => {
  const cover = { dstX: 0, dstY: 0, dstW: 1920, dstH: 1080 };

  it("identity transform = unchanged cover", () => {
    expect(applyViewportTransform(cover, DEFAULT_VIEWPORT_TRANSFORM)).toEqual(
      cover,
    );
  });

  it("scale 2 → element doubles, centered around cover-center", () => {
    // cover center = (960, 540). scale 2: w=3840, h=2160.
    // dstX = 960 - 3840/2 = -960
    const r = applyViewportTransform(cover, { scale: 2, x: 0, y: 0 });
    expect(r.dstW).toBe(3840);
    expect(r.dstH).toBe(2160);
    expect(r.dstX).toBe(-960);
    expect(r.dstY).toBe(-540);
  });

  it("scale 0.5 → element halves, centered around cover-center", () => {
    const r = applyViewportTransform(cover, { scale: 0.5, x: 0, y: 0 });
    expect(r.dstW).toBe(960);
    expect(r.dstH).toBe(540);
    expect(r.dstX).toBe(480);
    expect(r.dstY).toBe(270);
  });

  it("translate moves the rect linearly post-scale", () => {
    const r = applyViewportTransform(cover, { scale: 1, x: 100, y: -50 });
    expect(r.dstX).toBe(100);
    expect(r.dstY).toBe(-50);
    expect(r.dstW).toBe(1920);
    expect(r.dstH).toBe(1080);
  });

  it("scale + translate compose: scale first, then translate", () => {
    const r = applyViewportTransform(cover, { scale: 2, x: 100, y: 50 });
    expect(r.dstW).toBe(3840);
    expect(r.dstH).toBe(2160);
    expect(r.dstX).toBe(-960 + 100);
    expect(r.dstY).toBe(-540 + 50);
  });

  it("works with non-zero cover origin (e.g. portrait-in-widescreen overflow)", () => {
    // Portrait element in widescreen stage produced this cover:
    const portraitCover = { dstX: 0, dstY: -1166, dstW: 1920, dstH: 3412 };
    const r = applyViewportTransform(portraitCover, {
      scale: 1,
      x: 0,
      y: 100,
    });
    expect(r.dstX).toBe(0);
    expect(r.dstY).toBe(-1166 + 100);
    expect(r.dstW).toBe(1920);
    expect(r.dstH).toBe(3412);
  });
});
