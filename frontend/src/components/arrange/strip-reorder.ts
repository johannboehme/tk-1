/**
 * Pure hit-testing for the FilmStrip's reorder drag.
 *
 * Frames are length-proportional (frameWidthForBars, 64..200 px), so a
 * fixed pixels-per-index step mis-tracks the pointer on mixed-length
 * strips. Instead the drop position is derived from the actual frame
 * rects: the dragged item lands after every frame whose midpoint lies
 * left of the pointer.
 */

export interface StripFrameRect {
  /** ArrangementItem.id of the frame. */
  id: string;
  /** Viewport-space left edge (getBoundingClientRect().left). */
  left: number;
  width: number;
}

/**
 * Target index for `reorderItem(draggedId, targetIndex)`: the number
 * of non-dragged frames whose midpoint sits left of `pointerX`. This
 * matches reorderItem's splice-out-then-in semantics — inserting at k
 * puts the dragged item after exactly those k frames — and is stable
 * under the live mid-drag reorders that shift indices around.
 */
export function reorderTargetIndex(
  rects: readonly StripFrameRect[],
  draggedId: string,
  pointerX: number,
): number {
  let target = 0;
  for (const r of rects) {
    if (r.id === draggedId) continue;
    if (r.left + r.width / 2 < pointerX) target += 1;
  }
  return target;
}
