/**
 * Global pointer-event controller for the Polaroid → FilmStrip drag.
 *
 * Mounted once at the Arrange-page level. While `store.drag` is
 * non-null:
 *   - tracks the pointer on `window` so the drag works even if the
 *     pointer leaves the originating Polaroid card
 *   - hit-tests the FilmStrip's marked drop zones (via the
 *     `data-strip-drop-zone` / `data-strip-frame` / `data-strip-cursor`
 *     attributes the strip places on its DOM nodes)
 *   - writes the resolved drop position back to the store so the strip
 *     can highlight the correct InsertionCursor
 *   - on pointerup, either commits the insert (drop succeeded) or
 *     cancels (released outside any drop zone)
 */
import { useEffect } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";

/**
 * Walk up from the element under the pointer to find what kind of
 * drop target we're over. Returns the chosen insertion index, or null
 * when the pointer isn't over the strip's drop area.
 */
function hitTestDropZone(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  // Direct hit on a marked InsertionCursor — easiest case.
  const cursor = el.closest("[data-strip-cursor-index]");
  if (cursor) {
    const raw = cursor.getAttribute("data-strip-cursor-index");
    const idx = raw === null ? NaN : Number(raw);
    return Number.isFinite(idx) ? idx : null;
  }

  // Hit on a frame — figure out left vs right half.
  const frame = el.closest("[data-strip-frame-index]");
  if (frame) {
    const raw = frame.getAttribute("data-strip-frame-index");
    const idx = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(idx)) return null;
    const rect = (frame as HTMLElement).getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    return x < mid ? idx : idx + 1;
  }

  // Inside the strip's outer drop-zone container but not on a frame
  // (empty strip, or the gutter area between rails) — drop at end.
  const zone = el.closest("[data-strip-drop-zone]");
  if (zone) {
    const raw = zone.getAttribute("data-strip-drop-zone-end");
    const idx = raw === null ? NaN : Number(raw);
    return Number.isFinite(idx) ? idx : 0;
  }

  return null;
}

export function useChunkDragController() {
  const drag = useArrangeStore((s) => s.drag);
  const updateChunkDrag = useArrangeStore((s) => s.updateChunkDrag);
  const commitChunkDrag = useArrangeStore((s) => s.commitChunkDrag);
  const cancelChunkDrag = useArrangeStore((s) => s.cancelChunkDrag);

  // Disable text selection / native scrolling while dragging — the
  // ghost-follow gesture shouldn't accidentally select text or scroll
  // the body. CSS overrides apply only for the duration of the drag.
  useEffect(() => {
    if (!drag) return;
    const prevUserSelect = document.body.style.userSelect;
    const prevTouchAction = document.body.style.touchAction;
    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.touchAction = prevTouchAction;
    };
  }, [drag !== null]);

  // Window-level pointer listeners only attached while dragging.
  useEffect(() => {
    if (!drag) return;

    function onMove(e: PointerEvent) {
      const idx = hitTestDropZone(e.clientX, e.clientY);
      updateChunkDrag({
        cursorX: e.clientX,
        cursorY: e.clientY,
        dropTargetIndex: idx,
      });
    }
    function onUp() {
      commitChunkDrag();
    }
    function onCancel() {
      cancelChunkDrag();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancelChunkDrag();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag !== null, updateChunkDrag, commitChunkDrag, cancelChunkDrag]);
}
