/**
 * Insertion-cursor — a glowing vertical line between two film-strip
 * frames (or at the very end of the strip). Click to position; the
 * "+ ADD" button on a Polaroid drops the chunk at the current cursor.
 *
 * The cursor lives inline with the frames (not absolute-positioned),
 * which keeps reorder/insert hit-testing simple — each gap is its own
 * little hit zone.
 */
interface InsertionCursorProps {
  active: boolean;
  /** True for the trailing cursor at the very end of the strip — gets
   *  a slightly different look (a "+" hint baked in) so the user
   *  understands it's a drop zone even when no items exist yet. */
  isTail?: boolean;
  height: number;
  onClick: () => void;
}

export function InsertionCursor({
  active,
  isTail = false,
  height,
  onClick,
}: InsertionCursorProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative shrink-0 grid place-items-center"
      style={{
        width: active ? 14 : 8,
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
          width: active ? 3 : 1,
          height: height - 16,
          background: active ? "#FF5722" : "rgba(154,143,128,0.5)",
          boxShadow: active
            ? "0 0 8px rgba(255,87,34,0.8), 0 0 14px rgba(255,87,34,0.4)"
            : "none",
          borderRadius: 2,
        }}
      />
      {/* Tail indicator when no items have been placed yet */}
      {isTail && !active && (
        <span
          aria-hidden
          className="absolute font-mono text-[10px] text-ink-3"
          style={{ top: -2, fontWeight: 600 }}
        >
          +
        </span>
      )}
    </button>
  );
}
