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
import { removeItemGuarded } from "../../local/arrange/arrange-guarded-actions";
import {
  effectiveBarsForChunk,
  frameWidthForBars,
  FRAME_MIN_PX,
} from "../../local/arrange/arrange-store";
import { chunkSpectralColor } from "../../local/arrange/chunk-mel";
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
  const seekToItem = useArrangeStore((s) => s.seekToItem);
  const reorderItem = useArrangeStore((s) => s.reorderItem);
  const setStripScrollPx = useArrangeStore((s) => s.setStripScrollPx);
  const setStripMetrics = useArrangeStore((s) => s.setStripMetrics);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const jobBeatsPerBar = useArrangeStore((s) => s.jobBeatsPerBar);
  const analysis = useArrangeStore((s) => s.analysis);
  // Highlight the active drop target while the user is dragging a
  // chunk from the Contact Sheet. Null when no drag is in flight or
  // the pointer isn't over the strip.
  const dropTargetIndex = useArrangeStore(
    (s) => s.drag?.dropTargetIndex ?? null,
  );

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

  // Auto-center on focus changes: when the focused item shifts (by
  // SHIFT-buttons or PREV/NEXT or a click on an out-of-view polaroid),
  // smoothly scroll the corresponding frame into the strip's center.
  useEffect(() => {
    if (!focusedItemId) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = scroller.querySelector<HTMLElement>(
      `[data-strip-frame-id="${CSS.escape(focusedItemId)}"]`,
    );
    if (!target) return;
    const sRect = scroller.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const offsetWithinScroller = tRect.left - sRect.left + scroller.scrollLeft;
    const desired =
      offsetWithinScroller - scroller.clientWidth / 2 + tRect.width / 2;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const clamped = Math.max(0, Math.min(max, desired));
    if (Math.abs(scroller.scrollLeft - clamped) > 1) {
      scroller.scrollTo({ left: clamped, behavior: "smooth" });
    }
  }, [focusedItemId, arrangement]);

  // Follow the playhead during playback — focus jumps to whichever
  // chunk is currently playing, which in turn re-uses the auto-center
  // effect above to keep the strip scrolled. Triggers only when the
  // currentItemId changes, so a deliberate user-focus on a different
  // frame still gets respected for the rest of that frame's playback.
  useEffect(() => {
    if (!currentItemId) return;
    if (focusedItemId === currentItemId) return;
    focusItem(currentItemId);
    // We deliberately don't depend on focusedItemId here — that would
    // re-fire every time the user picks a different frame and yank
    // focus right back. This effect is a one-shot per-currentItemId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItemId, focusItem]);

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
      <FilmStripShell
        scrollerRef={scrollerRef}
        contentRef={contentRef}
        dropZoneEnd={0}
      >
        <div className="flex w-full items-stretch">
          <InsertionCursor
            index={0}
            active={insertionIndex === 0}
            dropTarget={dropTargetIndex === 0}
            isTail
            height={FRAME_HEIGHT}
            onClick={() => setInsertionIndex(0)}
          />
          <div className="flex-1 flex items-center justify-center min-h-[96px] px-4">
            <span className="font-mono text-[11px] tracking-label uppercase text-paper-hi/60">
              ◇ pool empty — drag a polaroid here, or hit + ADD
            </span>
          </div>
        </div>
      </FilmStripShell>
    );
  }

  return (
    <FilmStripShell
      scrollerRef={scrollerRef}
      contentRef={contentRef}
      dropZoneEnd={arrangement.length}
    >
      <div
        className="flex items-stretch"
        // Subtle horizontal grain to fake the film-stock texture
        style={{ minWidth: "100%" }}
      >
        {/* Leading cursor */}
        <InsertionCursor
          index={0}
          active={insertionIndex === 0}
          dropTarget={dropTargetIndex === 0}
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
              data-strip-frame-index={i}
              data-strip-frame-id={item.id}
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
                spectralColor={chunkSpectralColor(chunk, analysis)}
                onFocus={() => {
                  // Click on a frame = focus + seek + tag this as the
                  // current playback item. Matches PREV/NEXT in the
                  // transport bar; during playback the audio walker
                  // continues from THIS item onwards.
                  seekToItem(item.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Right-click = drop the item (matches the inspector
                  // affordance)
                  void removeItemGuarded(item.id);
                }}
              />
              <InsertionCursor
                index={i + 1}
                active={insertionIndex === i + 1}
                dropTarget={dropTargetIndex === i + 1}
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
 *  frames get composed into the middle band by the caller.
 *
 *  `dropZoneEnd` is the index used as the fallback "drop at the end"
 *  position when a chunk-drag lands inside the shell but not over a
 *  specific frame or cursor (e.g. on the sprocket rails or empty
 *  trailing space). The ChunkDragController hit-tests against the
 *  `data-strip-drop-zone` attribute set here. */
function FilmStripShell({
  scrollerRef,
  contentRef,
  children,
  dropZoneEnd,
}: {
  scrollerRef: React.MutableRefObject<HTMLDivElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
  children: React.ReactNode;
  dropZoneEnd: number;
}) {
  return (
    <div
      ref={(el) => {
        scrollerRef.current = el;
      }}
      data-strip-drop-zone="1"
      data-strip-drop-zone-end={dropZoneEnd}
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
  // Sprocket holes painted as a repeating background. Pinned to top
  // and bottom of the scroller via `position: absolute` so both rails
  // are anchored at their edges regardless of how the document flow
  // resolves around the absolutely-positioned frame band — `sticky`
  // doesn't help here because there's no vertical scroll for it to
  // anchor against, and the bottom rail would otherwise fall back to
  // its natural flow position right under the top rail.
  const holeSize = 6;
  const holePitch = 22;
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 z-10 pointer-events-none"
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
