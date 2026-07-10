/**
 * MiniMap drag-scroll mapping (#100).
 *
 * A minimap drag scrolls the strip RELATIVE to where the drag started
 * — no jump on the first move, no seek. Movement in minimap pixels
 * maps proportionally onto strip-content pixels and clamps to the
 * scrollable range.
 */
import { describe, expect, it } from "vitest";
import { minimapDragScroll, MINIMAP_CLICK_SLOP_PX } from "./minimap-drag";

const base = {
  startScrollPx: 400,
  minimapWidthPx: 500,
  contentWidthPx: 2000,
  viewportWidthPx: 500,
};

describe("minimapDragScroll", () => {
  it("maps minimap movement proportionally onto content scroll", () => {
    // 500 px minimap represents 2000 px content → 4 content px per
    // minimap px. +50 px drag → +200 px scroll.
    expect(minimapDragScroll({ ...base, dxPx: 50 })).toBe(600);
    expect(minimapDragScroll({ ...base, dxPx: -50 })).toBe(200);
  });

  it("no movement → scroll stays where the drag started", () => {
    expect(minimapDragScroll({ ...base, dxPx: 0 })).toBe(400);
  });

  it("clamps to the scrollable range", () => {
    // Max scroll = content - viewport = 1500.
    expect(minimapDragScroll({ ...base, dxPx: 10_000 })).toBe(1500);
    expect(minimapDragScroll({ ...base, dxPx: -10_000 })).toBe(0);
  });

  it("degrades safely when the minimap has no measured width", () => {
    expect(
      minimapDragScroll({ ...base, dxPx: 50, minimapWidthPx: 0 }),
    ).toBe(400);
  });

  it("content narrower than viewport → pinned to 0", () => {
    expect(
      minimapDragScroll({
        ...base,
        dxPx: 50,
        contentWidthPx: 300,
        viewportWidthPx: 500,
      }),
    ).toBe(0);
  });

  it("click slop is small enough that deliberate drags always scroll", () => {
    expect(MINIMAP_CLICK_SLOP_PX).toBeGreaterThan(0);
    expect(MINIMAP_CLICK_SLOP_PX).toBeLessThanOrEqual(8);
  });
});
