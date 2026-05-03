/**
 * TriageTimeline — the main visual surface of the Triage workflow.
 *
 * Stacked layers (all share the same time-window mapping):
 *   1. Time ruler (~22 px) — MM:SS marks, agnostic to musical timing
 *   2. Bar ruler (~22 px) — per-chunk beat/bar ticks, anchored at each
 *      chunk's `audioStartMs` and stepping at that chunk's effective
 *      tempo. Chunks are not aligned to each other.
 *   3. Waveform (Canvas2D) — RMS envelope as vertical bars
 *   4. Chunk lane (~32 px) — solid-color bars per chunk
 *
 * Trim drag uses the editor's `snapTime` helper with the active
 * `snapMode` from the store, anchored at the chunk's own `audioStartMs`.
 *
 * Plus a playhead overlay and zoom/pan affordances.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  chunkBeatPhaseS,
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";
import { snapTime } from "../../editor/snap";
import type { Chunk } from "../../storage/jobs-db";

// Visual hierarchy (top to bottom):
//   Time ruler — secondary, MM:SS for absolute reference, faint
//   Bar ruler  — PRIMARY navigation surface, bar numbers + downbeats
//   Waveform   — RMS envelope
//   Chunk lane — chunk blocks
const TIME_RULER_HEIGHT = 16;
const BAR_RULER_HEIGHT = 30;
const CHUNK_LANE_HEIGHT = 32;
const MAX_WAVEFORM_HEIGHT = 110;
const PLAYHEAD_COLOR = "#FF5722";
const HOT_COLOR = "#FF5722";
const TRIM_HANDLE_PX = 6;

export function TriageTimeline() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 320 });

  const audioDuration = useTriageStore((s) => s.audioDuration);
  const envelope = useTriageStore((s) => s.envelope);
  const envelopeHz = useTriageStore((s) => s.envelopeHz);
  const chunks = useTriageStore((s) => s.chunks);
  const jobBpm = useTriageStore((s) => s.jobBpm);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const snapMode = useTriageStore((s) => s.snapMode);
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const view = useTriageStore((s) => s.view);
  const setZoom = useTriageStore((s) => s.setZoom);
  const setScrollX = useTriageStore((s) => s.setScrollX);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const seek = useTriageStore((s) => s.seek);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  const currentTime = useTriageStore((s) => s.playback.currentTime);

  // Track wrapper width AND height so the waveform breathes vertically
  // when the user gives the timeline column more room.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: Math.max(200, entry.contentRect.width),
          height: Math.max(180, entry.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const waveformHeight = Math.min(
    MAX_WAVEFORM_HEIGHT,
    Math.max(
      60,
      size.height - TIME_RULER_HEIGHT - BAR_RULER_HEIGHT - CHUNK_LANE_HEIGHT,
    ),
  );

  const visibleDuration = audioDuration > 0 ? audioDuration / view.zoom : 60;
  const pxPerSec = size.width / visibleDuration;
  const viewStartS = Math.min(
    Math.max(0, view.scrollX),
    Math.max(0, audioDuration - visibleDuration),
  );
  const viewEndS = viewStartS + visibleDuration;

  function timeToX(tS: number): number {
    return (tS - viewStartS) * pxPerSec;
  }
  function xToTime(xPx: number): number {
    return viewStartS + xPx / pxPerSec;
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const panSecs = ((e.deltaX || e.deltaY) / pxPerSec) * 0.5;
      setScrollX(view.scrollX + panSecs);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorTimeBefore = xToTime(cursorX);
    const factor = Math.exp(-e.deltaY * 0.002);
    const nextZoom = Math.max(1, Math.min(500, view.zoom * factor));
    const nextVisible = audioDuration / nextZoom;
    const nextPxPerSec = size.width / nextVisible;
    const nextScroll = cursorTimeBefore - cursorX / nextPxPerSec;
    setZoom(nextZoom);
    setScrollX(Math.max(0, Math.min(audioDuration - nextVisible, nextScroll)));
  }

  // Touch: pinch-zoom + 1-finger pan.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<
    | {
        zoom: number;
        scrollX: number;
        midTime: number;
        midX: number;
        dist: number;
      }
    | null
  >(null);
  const panStartRef = useRef<{ scrollX: number; pointerX: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midX = (p1.x + p2.x) / 2 - rect.left;
      pinchStartRef.current = {
        zoom: view.zoom,
        scrollX: view.scrollX,
        midTime: xToTime(midX),
        midX,
        dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      };
      panStartRef.current = null;
    } else if (pointersRef.current.size === 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      panStartRef.current = {
        scrollX: view.scrollX,
        pointerX: e.clientX - rect.left,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2 && pinchStartRef.current) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const factor = dist / pinchStartRef.current.dist;
      const nextZoom = Math.max(
        1,
        Math.min(500, pinchStartRef.current.zoom * factor),
      );
      const nextVisible = audioDuration / nextZoom;
      const nextPxPerSec = size.width / nextVisible;
      const nextScroll =
        pinchStartRef.current.midTime - pinchStartRef.current.midX / nextPxPerSec;
      setZoom(nextZoom);
      setScrollX(
        Math.max(0, Math.min(audioDuration - nextVisible, nextScroll)),
      );
    } else if (pointersRef.current.size === 1 && panStartRef.current) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const deltaPx = pointerX - panStartRef.current.pointerX;
      const deltaSec = -deltaPx / pxPerSec;
      setScrollX(panStartRef.current.scrollX + deltaSec);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) panStartRef.current = null;
  }

  // ─── Pointer interaction ──────────────────────────────────────────────
  // Unified drag state — playhead scrub OR per-chunk trim handle. The
  // trim handles have their own onMouseDown with stopPropagation so
  // they never bubble here; the wrapper's onMouseDown handles the
  // remaining cases (playhead drag, chunk-lane focus).
  type DragState =
    | {
        kind: "trim";
        chunkId: string;
        edge: "left" | "right";
        anchorS: number;
      }
    | { kind: "playhead" };
  const dragRef = useRef<DragState | null>(null);
  const movedRef = useRef(false);

  /** Pick the snap context for a given master-time. We anchor on
   *  whichever chunk the cursor is currently INSIDE; if it's between
   *  chunks, fall back to the focused chunk; if neither, no snap.
   *  Always reads the latest jobBpm/snapMode/beatsPerBar via store. */
  function buildSnapAtTime(tS: number): {
    bpm: number;
    anchorS: number;
  } | null {
    const tMs = tS * 1000;
    const inside = chunks.find((c) => tMs >= c.startMs && tMs <= c.endMs);
    const focused = chunks.find((c) => c.id === focusedChunkId);
    const c = inside ?? focused ?? null;
    if (!c) return null;
    const bpm = effectiveChunkBpm(c, jobBpm?.value ?? null);
    if (bpm <= 0) return null;
    return { bpm, anchorS: chunkBeatPhaseS(c) };
  }

  function snapTimeS(tS: number, ev: { shiftKey: boolean }, ctx?: { bpm: number; anchorS: number } | null): number {
    if (ev.shiftKey || snapMode === "off") return tS;
    const snapCtx = ctx ?? buildSnapAtTime(tS);
    if (!snapCtx) return tS;
    return snapTime(tS, snapMode, {
      bpm: snapCtx.bpm,
      beatPhase: snapCtx.anchorS,
      beatsPerBar,
    });
  }

  function onWrapperMouseDown(e: React.MouseEvent) {
    // Only primary button.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Trim handles register their own onMouseDown with stopPropagation,
    // so they never reach here. Defensive double-check via data attr.
    if (target.dataset.trimHandle) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const tRaw = xToTime(xPx);
    const chunkLaneTop = TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight;

    // Click in the chunk lane on a chunk → focus it; that's the
    // primary curation action there. We don't seek/scrub from the
    // chunk lane to keep the focus interaction predictable.
    if (yPx >= chunkLaneTop) {
      const hit = chunks.find(
        (c) => tRaw * 1000 >= c.startMs && tRaw * 1000 <= c.endMs,
      );
      if (hit) {
        focusChunk(hit.id);
        return;
      }
      // Fallthrough: empty area in chunk lane → playhead drag.
    }

    // Playhead scrub — seek immediately + start tracking.
    movedRef.current = false;
    dragRef.current = { kind: "playhead" };
    seek(snapTimeS(tRaw, e));
  }

  function startTrimDrag(
    e: React.MouseEvent,
    chunk: Chunk,
    edge: "left" | "right",
  ) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    movedRef.current = false;
    dragRef.current = {
      kind: "trim",
      chunkId: chunk.id,
      edge,
      anchorS: chunkBeatPhaseS(chunk),
    };
  }

  useEffect(() => {
    function onMove(ev: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      movedRef.current = true;
      const rect = wrapper.getBoundingClientRect();
      const xPx = ev.clientX - rect.left;
      const tRaw = xToTime(xPx);

      if (drag.kind === "playhead") {
        seek(snapTimeS(tRaw, ev));
        return;
      }

      // Trim drag: snap anchored at the chunk's own audio-start, with
      // the song-global BPM resolved fresh each move so changes mid-
      // drag (rare) take effect immediately.
      const chunk = chunks.find((c) => c.id === drag.chunkId);
      if (!chunk) return;
      const bpm = effectiveChunkBpm(chunk, jobBpm?.value ?? null);
      const snapped =
        ev.shiftKey || snapMode === "off" || bpm <= 0
          ? tRaw
          : snapTime(tRaw, snapMode, {
              bpm,
              beatPhase: drag.anchorS,
              beatsPerBar,
            });
      const timeMs = Math.round(snapped * 1000);
      const trimMode: "free" | "bar" = ev.shiftKey ? "free" : "bar";
      if (drag.edge === "left") {
        const next = Math.max(0, Math.min(chunk.endMs - 100, timeMs));
        if (next !== chunk.startMs) updateChunk(chunk.id, { startMs: next, trimMode });
      } else {
        const next = Math.max(
          chunk.startMs + 100,
          Math.min(audioDuration * 1000, timeMs),
        );
        if (next !== chunk.endMs) updateChunk(chunk.id, { endMs: next, trimMode });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // buildSnapAtTime / snapTimeS close over the current store values
    // so we re-install the listeners whenever any of those change.
  }, [
    chunks,
    focusedChunkId,
    updateChunk,
    xToTime,
    audioDuration,
    snapMode,
    beatsPerBar,
    jobBpm,
    seek,
  ]);

  const timeTicks = useTimeRuler(viewStartS, viewEndS, size.width);
  const barTicks = usePerChunkBarTicks(
    chunks,
    focusedChunkId,
    jobBpm?.value ?? null,
    beatsPerBar,
    viewStartS,
    viewEndS,
    pxPerSec,
  );
  // Waveform canvas.
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !envelope || envelope.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = size.width;
    const cssH = waveformHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#FAF6EC";
    ctx.fillRect(0, 0, cssW, cssH);

    const thresholdLin = Math.pow(10, silenceConfig.thresholdDb / 20);
    const peakRef = Math.max(0.01, ...envelope);

    const sPerEnv = 1 / envelopeHz;
    const cx = cssH / 2;
    const half = cssH / 2 - 2;
    for (let xPx = 0; xPx < cssW; xPx++) {
      const t0 = xToTime(xPx);
      const t1 = xToTime(xPx + 1);
      const e0 = Math.max(0, Math.floor(t0 / sPerEnv));
      const e1 = Math.min(envelope.length, Math.ceil(t1 / sPerEnv));
      if (e1 <= e0) continue;
      let max = 0;
      for (let i = e0; i < e1; i++) {
        if (envelope[i] > max) max = envelope[i];
      }
      const norm = max / peakRef;
      const h = Math.max(1, norm * half);
      const aboveThreshold = max > thresholdLin;
      ctx.fillStyle = aboveThreshold ? "#221E1A" : "#A89F8B";
      ctx.fillRect(xPx, cx - h, 1, h * 2);
    }

    const thresholdY = cx - (thresholdLin / peakRef) * half;
    if (thresholdY > 0 && thresholdY < cssH) {
      ctx.strokeStyle = "rgba(255,87,34,0.5)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(cssW, thresholdY);
      ctx.stroke();
      const thresholdYBottom = cx + (thresholdLin / peakRef) * half;
      if (thresholdYBottom < cssH) {
        ctx.beginPath();
        ctx.moveTo(0, thresholdYBottom);
        ctx.lineTo(cssW, thresholdYBottom);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }, [envelope, envelopeHz, size.width, waveformHeight, viewStartS, viewEndS, silenceConfig, xToTime]);

  const totalHeight =
    TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight + CHUNK_LANE_HEIGHT;

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full bg-paper-hi border border-rule rounded-md overflow-hidden select-none touch-none"
      onWheel={onWheel}
      onMouseDown={onWrapperMouseDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Time ruler — secondary surface. Faint MM:SS for absolute
       *  reference; visually subordinate to the bar ruler below so
       *  the user's eye reads "musical grid" first. */}
      <div
        className="absolute left-0 top-0 right-0 bg-paper-bg border-b border-rule pointer-events-none"
        style={{ height: TIME_RULER_HEIGHT }}
      >
        {timeTicks.map((tick, i) => (
          <div
            key={`t-${i}`}
            className="absolute top-0 bottom-0 flex items-end pl-1"
            style={{
              left: timeToX(tick.t),
              color: tick.major ? "#A89F8B" : "#C9BFA6",
            }}
          >
            <span
              className="font-mono text-[8px] tracking-label uppercase pb-0.5 leading-none"
              style={{ opacity: tick.major ? 0.85 : 0.55 }}
            >
              {tick.label}
            </span>
            <span
              className="absolute right-0 bottom-0 w-px"
              style={{
                background: tick.major ? "#A89F8B" : "#C9BFA6",
                height: tick.major ? "60%" : "30%",
                opacity: tick.major ? 0.7 : 0.45,
              }}
            />
          </div>
        ))}
      </div>

      {/* Bar ruler — PRIMARY navigation surface. Per-chunk grid with
       *  numbered downbeats; each chunk's bar 1 sits at its
       *  audio-start onset. Beats between bars are thinner ticks at
       *  high zoom. */}
      <div
        className="absolute left-0 right-0 bg-paper-deep border-b border-rule pointer-events-none"
        style={{
          top: TIME_RULER_HEIGHT,
          height: BAR_RULER_HEIGHT,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 0 rgba(0,0,0,0.08)",
        }}
      >
        {barTicks.map((tick, i) => {
          const dim = tick.extension;
          // Three tiers of marker, each with its own stroke + height
          // so the eye reads the hierarchy at any zoom:
          //   bar-major: 2px, full height, labeled with bar number
          //   bar-minor: 1.5px, ~70% height, no label
          //   beat:      1px, ~40% height, no label
          let tickWidth = 1;
          let tickHeight = "40%";
          let tickColor = dim ? "#FF572233" : "#FF5722B0";
          if (tick.kind === "bar-major") {
            tickWidth = 2;
            tickHeight = "100%";
            tickColor = dim ? "#FF572266" : HOT_COLOR;
          } else if (tick.kind === "bar-minor") {
            tickWidth = 1.5;
            tickHeight = "70%";
            tickColor = dim ? "#FF572255" : "#FF5722CC";
          }
          const x = timeToX(tick.tS);
          return (
            <span key={`b-${i}`}>
              <span
                className="absolute bottom-0"
                style={{
                  left: x,
                  width: tickWidth,
                  height: tickHeight,
                  background: tickColor,
                  marginLeft: -tickWidth / 2,
                }}
              />
              {tick.kind === "bar-major" && (
                <span
                  className="absolute font-display tracking-[0.05em] uppercase tabular leading-none select-none"
                  style={{
                    left: x + 3,
                    top: 3,
                    fontSize: 9,
                    color: dim ? "#FF572277" : "#1A1612",
                    fontWeight: dim ? 400 : 700,
                  }}
                >
                  {tick.barIndex}
                </span>
              )}
            </span>
          );
        })}
      </div>

      <div
        className="absolute left-0 right-0"
        style={{ top: TIME_RULER_HEIGHT + BAR_RULER_HEIGHT }}
      >
        <canvas ref={waveformCanvasRef} />
      </div>

      <div
        className="absolute left-0 right-0 border-t border-rule bg-paper-deep"
        style={{
          top: TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight,
          height: CHUNK_LANE_HEIGHT,
        }}
      >
        {chunks.map((chunk) => (
          <ChunkBlock
            key={chunk.id}
            chunk={chunk}
            timeToX={timeToX}
            visibleStart={viewStartS}
            visibleEnd={viewEndS}
            focused={chunk.id === focusedChunkId}
            onTrimStart={(edge, e) => startTrimDrag(e, chunk, edge)}
          />
        ))}
      </div>

      {currentTime >= viewStartS && currentTime <= viewEndS && (
        <div
          className="absolute top-0 pointer-events-none"
          style={{
            left: timeToX(currentTime),
            height: totalHeight,
            width: 2,
            background: PLAYHEAD_COLOR,
            boxShadow: "0 0 4px rgba(255,87,34,0.6)",
          }}
        />
      )}
    </div>
  );
}

interface ChunkBlockProps {
  chunk: Chunk;
  timeToX: (t: number) => number;
  visibleStart: number;
  visibleEnd: number;
  focused: boolean;
  onTrimStart: (edge: "left" | "right", e: React.MouseEvent) => void;
}

function ChunkBlock({
  chunk,
  timeToX,
  visibleStart,
  visibleEnd,
  focused,
  onTrimStart,
}: ChunkBlockProps) {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  if (endS < visibleStart || startS > visibleEnd) return null;

  const left = timeToX(startS);
  const right = timeToX(endS);
  const widthPx = Math.max(2, right - left);

  const bg = chunk.accepted ? "#FF5722" : "#5D5546";
  const fg = chunk.accepted ? "#FAF6EC" : "#A89F8B";

  const showLabel = widthPx >= 28;
  const showFullDetail = widthPx >= 120;
  const showHandles = widthPx >= TRIM_HANDLE_PX * 3;

  return (
    <div
      className="absolute top-0 bottom-0 flex items-center px-1 overflow-hidden"
      style={{
        left,
        width: widthPx,
        background: bg,
        color: fg,
        outline: focused ? "2px solid #2F6FED" : undefined,
        outlineOffset: focused ? -2 : undefined,
        zIndex: focused ? 2 : 1,
      }}
      title={`${chunk.id}: ${formatTime(startS)} → ${formatTime(endS)}${
        chunk.detectedBpm ? ` · ${chunk.detectedBpm.toFixed(1)} BPM` : ""
      }`}
    >
      {!chunk.accepted && (
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 h-px"
          style={{ background: "#FAF6EC" }}
        />
      )}
      {showLabel && (
        <span className="font-mono text-[10px] tracking-label uppercase truncate relative">
          {showFullDetail
            ? `${formatTime(startS)} · ${(endS - startS).toFixed(1)}s${
                chunk.detectedBpm ? ` · ${chunk.detectedBpm.toFixed(0)}` : ""
              }`
            : chunk.accepted
              ? "●"
              : "✕"}
        </span>
      )}
      {showHandles && (
        <>
          <div
            data-trim-handle="left"
            className="absolute left-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("left", e)}
            title="Drag to trim start (Shift = bypass snap)"
          />
          <div
            data-trim-handle="right"
            className="absolute right-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("right", e)}
            title="Drag to trim end (Shift = bypass snap)"
          />
        </>
      )}
    </div>
  );
}

interface RulerTick {
  t: number;
  label: string;
  major: boolean;
}

function useTimeRuler(viewStartS: number, viewEndS: number, widthPx: number): RulerTick[] {
  return useMemo(() => {
    const visible = viewEndS - viewStartS;
    if (visible <= 0 || widthPx <= 0) return [];
    const targetMajorPx = 120;
    const targetCount = Math.max(2, widthPx / targetMajorPx);
    const rawSpacing = visible / targetCount;
    const majorStep = niceStep(rawSpacing);
    const minorStep = majorStep / 5;
    const ticks: RulerTick[] = [];
    const t0 = Math.floor(viewStartS / minorStep) * minorStep;
    for (let t = t0; t <= viewEndS + minorStep; t += minorStep) {
      const isMajor = Math.abs(t / majorStep - Math.round(t / majorStep)) < 0.001;
      ticks.push({
        t,
        label: isMajor ? formatTime(t) : "",
        major: isMajor,
      });
    }
    return ticks;
  }, [viewStartS, viewEndS, widthPx]);
}

interface BarTick {
  tS: number;
  /** Visual category — drives stroke + label rendering.
   *  - "bar-major": labeled downbeat (e.g. bar 1, 5, 9 at stride 4)
   *  - "bar-minor": unlabeled downbeat between major bars
   *  - "beat":      sub-bar beat tick (high zoom only)
   */
  kind: "bar-major" | "bar-minor" | "beat";
  /** Bar number — 1 at the chunk's audio-start anchor. Only rendered
   *  for `bar-major` ticks. */
  barIndex: number;
  /** True when this tick lies outside the chunk's current bounds — a
   *  potential snap target if the user trims outwards. */
  extension: boolean;
}

/** Bar/beat ticks for the FOCUSED chunk only.
 *
 *  Long-form sessions with dozens of chunks turned the ruler into a
 *  festival of "1" labels — each chunk's bar 1 sat at its own anchor,
 *  and at low zoom they all fired at once and collided. Bar markers
 *  are a per-chunk-context tool anyway: the user only cares about the
 *  bar grid of whatever they're trimming or scrubbing. Other chunks
 *  show up as colored lane blocks below; that's enough to navigate.
 *
 *  Density is adaptive to zoom — picks the smallest power-of-2 stride
 *  such that labeled downbeats sit at least 56 px apart. In between
 *  we render minor unlabeled bar ticks while there's room (≥ 6 px),
 *  and beat sub-ticks only at high zoom (≥ 8 px per beat).
 *
 *  When a chunk is focused, its grid projects across the FULL view
 *  with `extension: true` flag for ticks outside the chunk's current
 *  bounds — so trim-dragging outwards has visible snap targets. */
const TARGET_LABEL_PX = 56;
const MIN_MINOR_BAR_PX = 6;
const MIN_BEAT_PX = 8;

function pickBarStride(pxPerBar: number): number {
  if (pxPerBar >= TARGET_LABEL_PX) return 1;
  if (pxPerBar <= 0) return 1;
  const need = TARGET_LABEL_PX / pxPerBar;
  return Math.pow(2, Math.ceil(Math.log2(need)));
}

function usePerChunkBarTicks(
  chunks: Chunk[],
  focusedChunkId: string | null,
  jobBpm: number | null,
  beatsPerBar: number,
  viewStartS: number,
  viewEndS: number,
  pxPerSec: number,
): BarTick[] {
  return useMemo(() => {
    if (!focusedChunkId) return [];
    const chunk = chunks.find((c) => c.id === focusedChunkId);
    if (!chunk) return [];
    const bpm = effectiveChunkBpm(chunk, jobBpm);
    if (bpm <= 0) return [];

    const sPerBeat = 60 / bpm;
    const sPerBar = sPerBeat * beatsPerBar;
    const pxPerBar = sPerBar * pxPerSec;
    const pxPerBeat = sPerBeat * pxPerSec;
    if (pxPerBar < 0.25) return [];

    const stride = pickBarStride(pxPerBar);
    const showMinorBars = stride > 1 && pxPerBar >= MIN_MINOR_BAR_PX;
    const showBeats = stride === 1 && pxPerBeat >= MIN_BEAT_PX;

    const startS = chunk.startMs / 1000;
    const endS = chunk.endMs / 1000;
    // The focused chunk's grid projects across the full visible view
    // so trim-dragging outwards has visible snap targets.
    const renderStart = viewStartS;
    const renderEnd = viewEndS;
    const anchorS = chunkBeatPhaseS(chunk);

    const ticks: BarTick[] = [];
    const firstBeatI = Math.ceil((renderStart - anchorS) / sPerBeat - 1e-9);
    const lastBeatI = Math.floor((renderEnd - anchorS) / sPerBeat + 1e-9);
    for (let i = firstBeatI; i <= lastBeatI; i++) {
      const t = anchorS + i * sPerBeat;
      if (t < renderStart - 1e-9 || t > renderEnd + 1e-9) continue;
      const beatInBar = ((i % beatsPerBar) + beatsPerBar) % beatsPerBar;
      const isDownbeat = beatInBar === 0;
      const barIndex = Math.floor(i / beatsPerBar) + 1;
      const isLabeled =
        isDownbeat && (((barIndex - 1) % stride) + stride) % stride === 0;

      let kind: BarTick["kind"];
      if (isLabeled) kind = "bar-major";
      else if (isDownbeat) {
        if (!showMinorBars) continue;
        kind = "bar-minor";
      } else {
        if (!showBeats) continue;
        kind = "beat";
      }

      const extension = t < startS || t > endS;
      ticks.push({ tS: t, kind, barIndex, extension });
    }
    return ticks;
  }, [chunks, focusedChunkId, jobBpm, beatsPerBar, viewStartS, viewEndS, pxPerSec]);
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const candidates = [
    0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600,
  ];
  for (const c of candidates) {
    if (c >= raw) return c;
  }
  return Math.ceil(raw / 3600) * 3600;
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
