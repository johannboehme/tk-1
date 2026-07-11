/**
 * Per-element viewport transforms.
 *
 * Replaces the old letterbox/pillarbox `computeFitRect` shared between
 * preview and export. With a fixed Stage (output frame) and per-element
 * placement, every element gets:
 *   1. A cover-fit default rect — the element scaled to FILL the stage
 *      on its short side (overflowing on the long side, center-cropped
 *      via the canvas/stage clip rect).
 *   2. A user-applied `ViewportTransform` (scale + translate) on top.
 *
 * Both preview ({@link buildPreviewLayers}) and export
 * ({@link Compositor.compositeImage}) call these helpers — single source
 * of truth so the two passes can never drift again.
 */

import type { ViewportTransform } from "../types";
import type { FitRect } from "./frame-descriptor";

export interface ElementRect {
  dstX: number;
  dstY: number;
  dstW: number;
  dstH: number;
}

/** Identity transform — element renders at its cover-fit default. */
export const DEFAULT_VIEWPORT_TRANSFORM: ViewportTransform = {
  scale: 1,
  x: 0,
  y: 0,
};

/**
 * Cover-fit default: scale `element` to FILL `stage`, centered.
 *
 * The shorter side (relative to the stage) reaches the stage edge; the
 * longer side overflows and gets clipped by the stage's `overflow:hidden`
 * (in the live preview) or by the canvas bounds (in export). This mirrors
 * CSS `object-fit: cover`.
 *
 * Returns a zero rect when either dim is non-positive.
 */
export function coverFitDefault(
  element: { w: number; h: number },
  stage: { w: number; h: number },
): ElementRect {
  if (element.w <= 0 || element.h <= 0 || stage.w <= 0 || stage.h <= 0) {
    return { dstX: 0, dstY: 0, dstW: 0, dstH: 0 };
  }
  const scale = Math.max(stage.w / element.w, stage.h / element.h);
  const dstW = element.w * scale;
  const dstH = element.h * scale;
  return {
    dstX: (stage.w - dstW) / 2,
    dstY: (stage.h - dstH) / 2,
    dstW,
    dstH,
  };
}

/**
 * Apply a user `ViewportTransform` on top of the cover-fit default.
 *
 * Scaling pivots around the cover rect's center, then the offset
 * translates linearly. (`scale === 1`, `x === 0`, `y === 0` is identity.)
 */
export function applyViewportTransform(
  cover: ElementRect,
  transform: ViewportTransform,
): ElementRect {
  const cx = cover.dstX + cover.dstW / 2;
  const cy = cover.dstY + cover.dstH / 2;
  const dstW = cover.dstW * transform.scale;
  const dstH = cover.dstH * transform.scale;
  return {
    dstX: cx - dstW / 2 + transform.x,
    dstY: cy - dstH / 2 + transform.y,
    dstW,
    dstH,
  };
}

/**
 * One-shot helper: cover-fit + transform → FitRect.
 *
 * Single source of truth for "where does an element land on the Stage".
 * Both the preview descriptor builder ({@link buildPreviewLayers}) and
 * the export compositor ({@link Compositor.compositeImage}) call this so
 * the two pipelines can never drift on placement again.
 */
export function buildElementFitRect(
  display: { w: number; h: number },
  stage: { w: number; h: number },
  transform: ViewportTransform = DEFAULT_VIEWPORT_TRANSFORM,
): FitRect {
  const cover = coverFitDefault(display, stage);
  const placed = applyViewportTransform(cover, transform);
  return { x: placed.dstX, y: placed.dstY, w: placed.dstW, h: placed.dstH };
}
