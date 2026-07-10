/**
 * Reorder hit-testing for the FilmStrip drag.
 *
 * Regression tests for #99: the old implementation used fixed
 * index-stepping (stepPx = FRAME_MIN_PX + 12 = 76 px) although frames
 * are length-proportional (64..200 px) — dragging across one wide
 * frame jumped 2-3 positions. `reorderTargetIndex` instead counts the
 * actual frame rects' midpoints, so the drop always lands where the
 * pointer visibly is.
 */
import { describe, expect, it } from "vitest";
import { reorderTargetIndex } from "./strip-reorder";

// Helper: lay out frames left-to-right with an 8 px gap (the
// InsertionCursor's width), mirroring the real strip DOM.
function layout(widths: { id: string; w: number }[], gap = 8) {
  let x = 0;
  return widths.map(({ id, w }) => {
    const rect = { id, left: x, width: w };
    x += w + gap;
    return rect;
  });
}

describe("reorderTargetIndex", () => {
  it("keeps the item in place while the pointer stays before the next midpoint", () => {
    // A(64) B(200) C(64) — dragging A.
    const rects = layout([
      { id: "A", w: 64 },
      { id: "B", w: 200 },
      { id: "C", w: 64 },
    ]);
    // B spans 72..272, midpoint 172. Pointer at 150 → still 0.
    expect(reorderTargetIndex(rects, "A", 150)).toBe(0);
  });

  it("moves exactly one position when crossing one wide frame (no step-jumping)", () => {
    // Three 200 px frames — the old 76 px stepping would report
    // round(208/76) = 3 steps for one frame of travel.
    const rects = layout([
      { id: "A", w: 200 },
      { id: "B", w: 200 },
      { id: "C", w: 200 },
    ]);
    // B spans 208..408, midpoint 308. Pointer just past it → 1, not 3.
    expect(reorderTargetIndex(rects, "A", 320)).toBe(1);
    // C spans 416..616, midpoint 516. Pointer past it → 2.
    expect(reorderTargetIndex(rects, "A", 520)).toBe(2);
  });

  it("handles mixed-width strips (the sqrt-scaled sessions the fix exists for)", () => {
    const rects = layout([
      { id: "A", w: 64 },
      { id: "B", w: 200 },
      { id: "C", w: 100 },
      { id: "D", w: 64 },
    ]);
    // Dragging C leftwards. A midpoint 32, B midpoint 172.
    expect(reorderTargetIndex(rects, "C", 100)).toBe(1); // past A, before B
    expect(reorderTargetIndex(rects, "C", 20)).toBe(0); // before A's midpoint
  });

  it("clamps to the ends", () => {
    const rects = layout([
      { id: "A", w: 64 },
      { id: "B", w: 64 },
      { id: "C", w: 64 },
    ]);
    expect(reorderTargetIndex(rects, "B", -500)).toBe(0);
    expect(reorderTargetIndex(rects, "B", 5000)).toBe(2);
  });

  it("ignores the dragged frame's own rect", () => {
    const rects = layout([
      { id: "A", w: 200 },
      { id: "B", w: 64 },
    ]);
    // Pointer inside A itself (past A's midpoint 100) — but A is the
    // dragged frame, so only B's midpoint (236) counts. Target stays 0.
    expect(reorderTargetIndex(rects, "A", 150)).toBe(0);
  });

  it("returns 0 for a single-item strip", () => {
    const rects = layout([{ id: "A", w: 64 }]);
    expect(reorderTargetIndex(rects, "A", 999)).toBe(0);
  });
});
