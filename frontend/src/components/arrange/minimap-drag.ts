/**
 * Pure scroll math for the MiniMap's drag-to-scroll gesture.
 *
 * The minimap is a navigation surface: a DISCRETE CLICK jumps/seeks,
 * a DRAG only scrolls the strip viewport — never relocates playback.
 * Dragging maps relative pointer movement (in minimap pixels)
 * proportionally onto strip-content pixels, so the viewport rectangle
 * tracks the finger without the initial jump an absolute mapping
 * would cause.
 */

/** A press that moves no more than this many horizontal pixels counts
 *  as a click (→ navigate); anything larger is a scroll drag. */
export const MINIMAP_CLICK_SLOP_PX = 4;

export function minimapDragScroll(args: {
  /** Strip scroll position when the drag started. */
  startScrollPx: number;
  /** Horizontal pointer travel since the drag started (minimap px). */
  dxPx: number;
  minimapWidthPx: number;
  contentWidthPx: number;
  viewportWidthPx: number;
}): number {
  const maxScroll = Math.max(0, args.contentWidthPx - args.viewportWidthPx);
  const scale =
    args.minimapWidthPx > 0 ? args.contentWidthPx / args.minimapWidthPx : 0;
  const desired = args.startScrollPx + args.dxPx * scale;
  return Math.max(0, Math.min(maxScroll, desired));
}
