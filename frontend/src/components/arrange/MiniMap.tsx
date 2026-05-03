/**
 * Mini-map — a tiny overview of the FilmStrip with a draggable
 * viewport rectangle. Only rendered when the strip's content overflows
 * its viewport; otherwise it's irrelevant overhead.
 *
 * Each frame is drawn as a thin coloured tick (cam-color) at a width
 * proportional to the frame's actual film-strip width. The viewport
 * rectangle reflects which slice of the strip is on-screen; dragging
 * the rectangle scrolls the strip.
 */
import { useRef } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import {
  effectiveBarsForChunk,
  frameWidthForBars,
} from "../../local/arrange/arrange-store";

const MINIMAP_HEIGHT = 18;

export function MiniMap() {
  const arrangement = useArrangeStore((s) => s.arrangement);
  const chunks = useArrangeStore((s) => s.chunks);
  const cams = useArrangeStore((s) => s.cams);
  const selectedCamId = useArrangeStore((s) => s.selectedCamId);
  const view = useArrangeStore((s) => s.view);
  const currentItemId = useArrangeStore((s) => s.playback.currentItemId);
  const setStripScrollPx = useArrangeStore((s) => s.setStripScrollPx);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const camColor = cam?.color ?? "#FF5722";

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startX: number; startScroll: number } | null>(
    null,
  );

  // Hide when not needed.
  const overflowing = view.stripContentWidthPx > view.stripViewportWidthPx + 2;
  if (!overflowing || arrangement.length === 0) return null;

  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  // Build per-frame width array (mirrors FilmStrip math).
  const widths = arrangement.map((item) => {
    const ck = chunkById.get(item.chunkId);
    if (!ck) return 0;
    return frameWidthForBars(effectiveBarsForChunk(ck));
  });
  const totalContent = widths.reduce((s, w) => s + w, 0) + arrangement.length * 8; // +cursors

  const minimapWidth = view.stripViewportWidthPx;
  if (minimapWidth <= 0) return null;
  const scale = minimapWidth / totalContent;

  const viewportPx = Math.max(
    24,
    (view.stripViewportWidthPx / view.stripContentWidthPx) * minimapWidth,
  );
  const viewportLeft =
    (view.stripScrollPx / Math.max(1, view.stripContentWidthPx)) * minimapWidth;

  function pointerToScroll(clientX: number): number {
    const el = wrapRef.current;
    if (!el) return view.stripScrollPx;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    // Centre the viewport on the click point.
    const desiredLeftMm = x - viewportPx / 2;
    const scrollPx =
      (desiredLeftMm / minimapWidth) * view.stripContentWidthPx;
    return Math.max(
      0,
      Math.min(
        view.stripContentWidthPx - view.stripViewportWidthPx,
        scrollPx,
      ),
    );
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = {
      startX: e.clientX,
      startScroll: view.stripScrollPx,
    };
    setStripScrollPx(pointerToScroll(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    setStripScrollPx(pointerToScroll(e.clientX));
  }
  function onPointerUp(e: React.PointerEvent) {
    draggingRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  // Place each frame's tick.
  let runningX = 4;
  return (
    <div
      ref={wrapRef}
      className="relative w-full mt-1 select-none cursor-pointer rounded border border-rule"
      style={{
        height: MINIMAP_HEIGHT,
        background:
          "linear-gradient(180deg, #1A1816 0%, #0E0D0B 100%)",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title="Mini-map · drag to scroll strip"
    >
      {arrangement.map((item, i) => {
        const w = widths[i] * scale;
        const left = runningX * scale;
        runningX += widths[i] + 8;
        const isCurrent = item.id === currentItemId;
        return (
          <span
            key={item.id}
            aria-hidden
            className="absolute"
            style={{
              left,
              width: Math.max(1, w),
              top: 3,
              bottom: 3,
              background: isCurrent ? "#FFB58A" : camColor,
              opacity: isCurrent ? 1 : 0.6,
              borderRadius: 1,
            }}
          />
        );
      })}
      {/* Viewport rectangle */}
      <span
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: viewportLeft,
          width: viewportPx,
          top: 0,
          bottom: 0,
          border: "1px solid rgba(255,255,255,0.65)",
          background: "rgba(255,255,255,0.06)",
          boxShadow:
            "inset 0 0 0 1px rgba(0,0,0,0.45), 0 0 6px rgba(0,0,0,0.6)",
          borderRadius: 1,
        }}
      />
    </div>
  );
}
