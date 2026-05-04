/**
 * FilmStrip — the centrepiece of the Arrange page.
 *
 * Renders the user's `arrangement[]` as a horizontal 35mm-style filmstrip:
 * sprocket-hole rails top + bottom, Frame components in the middle,
 * InsertionCursors between every pair (and at both ends), playhead +
 * "now playing" indicator overlaid.
 *
 * Length-proportional scaling — wider chunks really are wider in the
 * strip. Frame widths come from `frameWidthForBars` so visual length
 * roughly tracks musical length without 64-bar monsters dominating
 * the screen (sublinear sqrt scaling, capped at 200 px).
 *
 * Reorder via drag-on-frame: pointer-down on a Frame, drag horizontally,
 * the dragged frame "follows" via translateX while neighbours animate
 * to make room. Drop = commit reorder. Touch + mouse both supported.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import {
  effectiveBarsForChunk,
  frameWidthForBars,
  FRAME_MIN_PX,
} from "../../local/arrange/arrange-store";
import type { Chunk } from "../../storage/jobs-db";
import { Frame } from "./Frame";
import { InsertionCursor } from "./InsertionCursor";

const STRIP_HEIGHT = 132;
const FRAME_HEIGHT = 96;
const SPROCKET_RAIL_HEIGHT = (STRIP_HEIGHT - FRAME_HEIGHT) / 2;

export function FilmStrip() {
  const jobId = useArrangeStore((s) => s.jobId);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const chunks = useArrangeStore((s) => s.chunks);
  const cams = useArrangeStore((s) => s.cams);
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const insertionIndex = useArrangeStore((s) => s.insertionIndex);
  const currentItemId = useArrangeStore((s) => s.playback.currentItemId);
  const setInsertionIndex = useArrangeStore((s) => s.setInsertionIndex);
  const focusItem = useArrangeStore((s) => s.focusItem);
  const reorderItem = useArrangeStore((s) => s.reorderItem);
  const removeItem = useArrangeStore((s) => s.removeItem);
  const setStripScrollPx = useArrangeStore((s) => s.setStripScrollPx);
  const setStripMetrics = useArrangeStore((s) => s.setStripMetrics);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const jobBeatsPerBar = useArrangeStore((s) => s.jobBeatsPerBar);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Look up chunk by ID. Build once per arrangement/chunks change.
  const chunkById = new Map<string, Chunk>();
  for (const c of chunks) chunkById.set(c.id, c);

  // Resolve cam for each item — use the selectedCamId if set, else
  // fall back to cam-1. The arrange page only previews ONE cam at a
  // time so all frames show the same cam's perspective.
  const selectedCamId = useArrangeStore((s) => s.selectedCamId);
  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;

  // ─── Track scroll + content/viewport sizes ────────────────────────────
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const ro = new ResizeObserver(() => {
      setStripMetrics(scroller.clientWidth, content.scrollWidth);
    });
    ro.observe(scroller);
    ro.observe(content);
    setStripMetrics(scroller.clientWidth, content.scrollWidth);
    return () => ro.disconnect();
  }, [setStripMetrics, arrangement.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function onScroll() {
      if (el) setStripScrollPx(el.scrollLeft);
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [setStripScrollPx]);

  // Sync mini-map → strip scroll: the parent component pushes a
  // `targetScrollPx` to the store when the user drags the mini-map
  // viewport. We read it here and apply.
  const stripScrollPx = useArrangeStore((s) => s.view.stripScrollPx);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollLeft - stripScrollPx) > 1) {
      el.scrollLeft = stripScrollPx;
    }
  }, [stripScrollPx]);

  // ─── Reorder via drag ─────────────────────────────────────────────────
  const dragStateRef = useRef<{
    itemId: string;
    startX: number;
    startIdx: number;
    currentIdx: number;
  } | null>(null);

  function beginDrag(e: React.PointerEvent, itemId: string) {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    const startIdx = arrangement.findIndex((a) => a.id === itemId);
    if (startIdx === -1) return;
    dragStateRef.current = {
      itemId,
      startX: e.clientX,
      startIdx,
      currentIdx: startIdx,
    };
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      // Each frame is roughly FRAME_MIN_PX wide; use a softer threshold
      // so reorder feels snappy without trigger-happy snap.
      const stepPx = FRAME_MIN_PX + 12;
      const stepCount = Math.round(dx / stepPx);
      const targetIdx = Math.max(
        0,
        Math.min(
          arrangement.length - 1,
          drag.startIdx + stepCount,
        ),
      );
      if (targetIdx !== drag.currentIdx) {
        drag.currentIdx = targetIdx;
        reorderItem(drag.itemId, targetIdx);
      }
    }
    function onUp() {
      dragStateRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [arrangement, reorderItem]);

  // ─── Empty state ──────────────────────────────────────────────────────
  if (arrangement.length === 0) {
    return (
      <FilmStripShell scrollerRef={scrollerRef} contentRef={contentRef}>
        <div className="flex w-full items-stretch">
          <InsertionCursor
            active={insertionIndex === 0}
            isTail
            height={FRAME_HEIGHT}
            onClick={() => setInsertionIndex(0)}
          />
          <div className="flex-1 flex items-center justify-center min-h-[96px] px-4">
            <span className="font-mono text-[11px] tracking-label uppercase text-paper-hi/60">
              ◇ pool empty — add chunks from the contact sheet below
            </span>
          </div>
        </div>
      </FilmStripShell>
    );
  }

  return (
    <FilmStripShell scrollerRef={scrollerRef} contentRef={contentRef}>
      <div
        className="flex items-stretch"
        // Subtle horizontal grain to fake the film-stock texture
        style={{ minWidth: "100%" }}
      >
        {/* Leading cursor */}
        <InsertionCursor
          active={insertionIndex === 0}
          height={FRAME_HEIGHT}
          onClick={() => setInsertionIndex(0)}
        />
        {arrangement.map((item, i) => {
          const chunk = chunkById.get(item.chunkId);
          if (!chunk) return null;
          const bars = effectiveBarsForChunk(chunk, jobBpm, jobBeatsPerBar);
          const w = frameWidthForBars(bars);
          return (
            <div
              key={item.id}
              className="flex items-stretch"
              onPointerDown={(e) => beginDrag(e, item.id)}
              style={{ touchAction: "pan-y" }}
            >
              <Frame
                jobId={jobId}
                cam={cam}
                chunk={chunk}
                index={i}
                bars={bars}
                width={w}
                height={FRAME_HEIGHT}
                focused={item.id === focusedItemId}
                isCurrentItem={item.id === currentItemId}
                onFocus={() => focusItem(item.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Right-click = drop the item (matches the inspector
                  // affordance)
                  removeItem(item.id);
                }}
              />
              <InsertionCursor
                active={insertionIndex === i + 1}
                isTail={i === arrangement.length - 1}
                height={FRAME_HEIGHT}
                onClick={() => setInsertionIndex(i + 1)}
              />
            </div>
          );
        })}
      </div>
    </FilmStripShell>
  );
}

/** Outer chrome: sprocket-hole rails + scroll container. The actual
 *  frames get composed into the middle band by the caller. */
function FilmStripShell({
  scrollerRef,
  contentRef,
  children,
}: {
  scrollerRef: React.MutableRefObject<HTMLDivElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={(el) => {
        scrollerRef.current = el;
      }}
      className="relative w-full overflow-x-auto overflow-y-hidden bg-sunken rounded-md border border-rule shadow-emboss"
      style={{ height: STRIP_HEIGHT }}
    >
      {/* Sprocket rail TOP */}
      <SprocketRail height={SPROCKET_RAIL_HEIGHT} side="top" />
      {/* Frame band */}
      <div
        ref={(el) => {
          contentRef.current = el;
        }}
        className="absolute inline-flex"
        style={{
          top: SPROCKET_RAIL_HEIGHT,
          height: FRAME_HEIGHT,
          minWidth: "100%",
        }}
      >
        {children}
      </div>
      {/* Sprocket rail BOTTOM */}
      <SprocketRail height={SPROCKET_RAIL_HEIGHT} side="bottom" />
    </div>
  );
}

function SprocketRail({ height, side }: { height: number; side: "top" | "bottom" }) {
  // Sprocket holes painted as a repeating background — dark rounded
  // rects on a slightly lighter rail strip. The rail itself sticks
  // to the scroller (position: sticky on the y axis) so it stays
  // visible no matter how far the user scrolls horizontally.
  // Dark gray rail with painted-on hole pattern.
  const holeSize = 6;
  const holePitch = 22;
  return (
    <div
      aria-hidden
      className="sticky inset-x-0 z-10 pointer-events-none"
      style={{
        top: side === "top" ? 0 : "auto",
        bottom: side === "bottom" ? 0 : "auto",
        height,
        background: `
          linear-gradient(180deg, #0E0D0B 0%, #1A1816 50%, #0E0D0B 100%)
        `,
        boxShadow:
          side === "top"
            ? "inset 0 -1px 0 rgba(255,255,255,0.04)"
            : "inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle at ${holePitch / 2}px 50%, #050402 ${holeSize / 2}px, transparent ${holeSize / 2 + 0.5}px)`,
          backgroundRepeat: "repeat-x",
          backgroundSize: `${holePitch}px 100%`,
          opacity: 0.85,
        }}
      />
    </div>
  );
}
