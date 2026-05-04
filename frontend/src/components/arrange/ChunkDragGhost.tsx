/**
 * Floating "ghost" tile that follows the pointer while a chunk is
 * being dragged from the Contact Sheet onto the Film Strip.
 *
 * Rendered into a portal at the document body so it can escape any
 * overflow:hidden ancestor and float above the rest of the UI. Hidden
 * when no drag is in flight.
 */
import { createPortal } from "react-dom";
import { useArrangeStore } from "../../local/arrange/arrange-store";

const GHOST_W = 96;
const GHOST_H = 54;

export function ChunkDragGhost() {
  const drag = useArrangeStore((s) => s.drag);
  if (!drag) return null;
  const overDrop = drag.dropTargetIndex !== null;
  return createPortal(
    <div
      aria-hidden
      style={{
        position: "fixed",
        // Anchor by the ghost's centre to the cursor so the user sees
        // the thumbnail "right under their finger".
        left: drag.cursorX - GHOST_W / 2,
        top: drag.cursorY - GHOST_H / 2,
        width: GHOST_W,
        height: GHOST_H,
        // 5° tilt — borrowed from the Polaroid hover micro-interaction
        // to keep the visual vocabulary consistent.
        transform: "rotate(-3deg)",
        pointerEvents: "none",
        zIndex: 9999,
        borderRadius: 4,
        overflow: "hidden",
        boxShadow: overDrop
          ? "0 8px 24px rgba(255,87,34,0.45), 0 0 0 2px rgba(255,87,34,0.7)"
          : "0 6px 16px rgba(0,0,0,0.35)",
        background: "#1A1816",
        transition: "box-shadow 120ms ease-out",
      }}
    >
      {drag.thumbUrl ? (
        <img
          src={drag.thumbUrl}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.9,
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: `linear-gradient(135deg, ${drag.camColor}40 0%, transparent 80%)`,
          }}
        />
      )}
    </div>,
    document.body,
  );
}
