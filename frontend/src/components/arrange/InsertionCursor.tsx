/**
 * Insertion-cursor — a glowing vertical line between two film-strip
 * frames (or at the very end of the strip). Click to position; the
 * "+ ADD" button on a Polaroid drops the chunk at the current cursor.
 *
 * The cursor lives inline with the frames (not absolute-positioned),
 * which keeps reorder/insert hit-testing simple — each gap is its own
 * little hit zone.
 *
 * Three visual states: idle (faint line), active (clicked → primary
 * insertion point), and dropTarget (a chunk is being dragged onto
 * THIS gap from the Contact Sheet). The dropTarget look is more
 * insistent than active — wider, brighter, with an animated glow —
 * so the user can tell while dragging exactly where the chunk will
 * land if they release the pointer here.
 */
interface InsertionCursorProps {
  /** Index in the arrangement where this cursor inserts. */
  index: number;
  active: boolean;
  /** True when a chunk-drag is currently aimed at this gap. */
  dropTarget: boolean;
  /** True for the trailing cursor at the very end of the strip — gets
   *  a slightly different look (a "+" hint baked in) so the user
   *  understands it's a drop zone even when no items exist yet. */
  isTail?: boolean;
  height: number;
  onClick: () => void;
}

export function InsertionCursor({
  index,
  active,
  dropTarget,
  isTail = false,
  height,
  onClick,
}: InsertionCursorProps) {
  // Drop target wins over active — it's the in-flight gesture.
  const lit = dropTarget || active;
  const wide = dropTarget ? 18 : active ? 14 : 8;
  const lineWidth = dropTarget ? 4 : active ? 3 : 1;
  return (
    <button
      type="button"
      data-strip-cursor-index={index}
      onClick={onClick}
      className="relative shrink-0 grid place-items-center"
      style={{
        width: wide,
        height,
        background: "transparent",
      }}
      aria-label="Set insertion point"
      title="Click to set insertion point"
    >
      {/* Vertical line */}
      <span
        aria-hidden
        className="block transition-all"
        style={{
          width: lineWidth,
          height: height - 16,
          background: lit ? "#FF5722" : "rgba(154,143,128,0.5)",
          boxShadow: dropTarget
            ? "0 0 16px rgba(255,87,34,1), 0 0 28px rgba(255,87,34,0.6)"
            : active
              ? "0 0 8px rgba(255,87,34,0.8), 0 0 14px rgba(255,87,34,0.4)"
              : "none",
          borderRadius: 2,
          // Pulse the drop-target line so it's unmistakable as the
          // drop spot during a drag.
          animation: dropTarget ? "pulse-drop 0.7s ease-in-out infinite" : undefined,
        }}
      />
      {/* Tail indicator when no items have been placed yet */}
      {isTail && !active && !dropTarget && (
        <span
          aria-hidden
          className="absolute font-mono text-[10px] text-ink-3"
          style={{ top: -2, fontWeight: 600 }}
        >
          +
        </span>
      )}
      {/* Drop-target chevron — caps the cursor at the bottom while
       *  dragging so the eye locks onto exactly this gap. */}
      {dropTarget && (
        <span
          aria-hidden
          className="absolute font-mono text-[12px] font-bold"
          style={{ bottom: -2, color: "#FF5722" }}
        >
          ▼
        </span>
      )}
      {/* Inline keyframes — keeps the styling self-contained. */}
      <style>{`@keyframes pulse-drop {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.55; }
      }`}</style>
    </button>
  );
}
