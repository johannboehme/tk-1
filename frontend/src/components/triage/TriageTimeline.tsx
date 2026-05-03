/**
 * TriageTimeline — the main visual surface of the Triage workflow.
 *
 * Three stacked layers, all sharing the same time-window mapping:
 *   1. Bar-ruler strip (top, ~26 px) — beat / bar ticks per chunk's BPM
 *      where chunks have BPM info, fall-back to plain MM:SS marks
 *      between chunks.
 *   2. Waveform (Canvas2D, ~120 px) — RMS envelope as vertical bars.
 *      Above the silence-threshold = ink, below = ink-3.
 *   3. Chunk lane (~32 px) — solid-color bars per chunk. Accepted = hot,
 *      rejected = ink-2 with a strikethrough line, focused = cobalt
 *      outline. Drag the left/right edge to trim (snap-to-bar when
 *      the chunk has BPM, otherwise free drag).
 *
 * Plus a playhead overlay and zoom/pan affordances:
 *   - mouse-wheel = zoom anchored at cursor x
 *   - shift+drag or middle-mouse = pan
 *   - pinch (touch) = zoom anchored at the centroid; one-finger drag = pan
 *   - click on the lane = focus the chunk under cursor
 *   - click on the waveform / ruler = seek the playhead
 *
 * No transparency tricks — chunk states are solid colors so the
 * accept/reject distinction reads at any background.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chunk } from "../../storage/jobs-db";
import {
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";

const BAR_RULER_HEIGHT = 24;
const WAVEFORM_HEIGHT = 120;
const CHUNK_LANE_HEIGHT = 32;
const PLAYHEAD_COLOR = "#FF5722";
const TRIM_HANDLE_PX = 6;

export function TriageTimeline() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);

  const audioDuration = useTriageStore((s) => s.audioDuration);
  const envelope = useTriageStore((s) => s.envelope);
  const envelopeHz = useTriageStore((s) => s.envelopeHz);
  const chunks = useTriageStore((s) => s.chunks);
  const sessionBpm = useTriageStore((s) => s.sessionBpmOverride);
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const view = useTriageStore((s) => s.view);
  const setZoom = useTriageStore((s) => s.setZoom);
  const setScrollX = useTriageStore((s) => s.setScrollX);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const seek = useTriageStore((s) => s.seek);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  const currentTime = useTriageStore((s) => s.playback.currentTime);

  // Track wrapper width so zoom math has real pixels to work with.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(Math.max(200, entry.contentRect.width));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Time-to-pixel mapping. zoom=1 fits the full duration; zoom=2 shows
  // half; etc.
  const visibleDuration = audioDuration > 0 ? audioDuration / view.zoom : 60;
  const pxPerSec = width / visibleDuration;
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

  // ─── Wheel: zoom or pan ───────────────────────────────────────────────
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
    const nextPxPerSec = width / nextVisible;
    const nextScroll = cursorTimeBefore - cursorX / nextPxPerSec;
    setZoom(nextZoom);
    setScrollX(Math.max(0, Math.min(audioDuration - nextVisible, nextScroll)));
  }

  // ─── Touch: pinch-zoom + 1-finger pan ─────────────────────────────────
  // Track active pointers so we can detect pinch.
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
      const nextPxPerSec = width / nextVisible;
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

  // ─── Click: seek or focus chunk ───────────────────────────────────────
  function onCanvasClick(e: React.MouseEvent) {
    // Drag-trim sets a flag; ignore the synthetic click that fires
    // immediately afterwards.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const t = xToTime(xPx);
    const chunkLaneTop = BAR_RULER_HEIGHT + WAVEFORM_HEIGHT;
    if (yPx >= chunkLaneTop) {
      const hit = chunks.find(
        (c) => t * 1000 >= c.startMs && t * 1000 <= c.endMs,
      );
      if (hit) {
        focusChunk(hit.id);
        return;
      }
    }
    seek(t);
  }

  // ─── Trim drag state ──────────────────────────────────────────────────
  // Per-chunk left/right edge drag. Snaps to nearest bar when the
  // chunk has BPM, otherwise free.
  const dragRef = useRef<
    | {
        chunkId: string;
        edge: "left" | "right";
        snapMsPerBar: number; // 0 = no snap
        startMs: number;
        endMs: number;
      }
    | null
  >(null);
  const suppressClickRef = useRef(false);

  function startTrimDrag(
    e: React.MouseEvent,
    chunk: Chunk,
    edge: "left" | "right",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const bpm = effectiveChunkBpm(chunk, sessionBpm);
    dragRef.current = {
      chunkId: chunk.id,
      edge,
      snapMsPerBar: bpm > 0 ? (60_000 / bpm) * chunk.beatsPerBar : 0,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
    };
  }

  useEffect(() => {
    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const xPx = ev.clientX - rect.left;
      let timeMs = xToTime(xPx) * 1000;
      // Snap to bar if the chunk has BPM and the user isn't holding Alt.
      if (dragRef.current.snapMsPerBar > 0 && !ev.altKey) {
        const anchor =
          dragRef.current.edge === "left"
            ? dragRef.current.endMs
            : dragRef.current.startMs;
        const bars = Math.round(
          (timeMs - anchor) / dragRef.current.snapMsPerBar,
        );
        timeMs = anchor + bars * dragRef.current.snapMsPerBar;
      }
      const chunk = chunks.find((c) => c.id === dragRef.current!.chunkId);
      if (!chunk) return;
      if (dragRef.current.edge === "left") {
        const next = Math.max(
          0,
          Math.min(chunk.endMs - 100, Math.round(timeMs)),
        );
        if (next !== chunk.startMs) {
          updateChunk(chunk.id, { startMs: next, trimMode: ev.altKey ? "free" : "bar" });
        }
      } else {
        const next = Math.max(
          chunk.startMs + 100,
          Math.min(audioDuration * 1000, Math.round(timeMs)),
        );
        if (next !== chunk.endMs) {
          updateChunk(chunk.id, { endMs: next, trimMode: ev.altKey ? "free" : "bar" });
        }
      }
      suppressClickRef.current = true;
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
  }, [chunks, updateChunk, xToTime, audioDuration]);

  // ─── Layer 1: Bar-Ruler ───────────────────────────────────────────────
  const ruler = useTimeRuler(viewStartS, viewEndS, width);
  const barTicks = usePerChunkBarTicks(chunks, sessionBpm, viewStartS, viewEndS, pxPerSec);

  // ─── Layer 2: Waveform ────────────────────────────────────────────────
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !envelope || envelope.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = width;
    const cssH = WAVEFORM_HEIGHT;
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

    // Threshold guide lines.
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
  }, [envelope, envelopeHz, width, viewStartS, viewEndS, silenceConfig, xToTime]);

  // ─── Layer 3: Chunk Lane (DOM-rendered) ───────────────────────────────
  const totalHeight = BAR_RULER_HEIGHT + WAVEFORM_HEIGHT + CHUNK_LANE_HEIGHT;

  return (
    <div
      ref={wrapperRef}
      className="relative w-full bg-paper-hi border border-rule rounded-md overflow-hidden select-none touch-none"
      style={{ height: totalHeight }}
      onWheel={onWheel}
      onClick={onCanvasClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Bar-ruler */}
      <div
        className="absolute left-0 top-0 right-0 bg-paper-deep border-b border-rule pointer-events-none"
        style={{ height: BAR_RULER_HEIGHT }}
      >
        {/* Time-based ruler (always visible) */}
        {ruler.map((tick, i) => (
          <div
            key={`t-${i}`}
            className="absolute top-0 bottom-0 flex items-end pl-1"
            style={{ left: timeToX(tick.t), color: tick.major ? "#221E1A" : "#A89F8B" }}
          >
            <span className="font-mono text-[10px] tracking-label uppercase pb-0.5">
              {tick.label}
            </span>
            <span
              className="absolute right-0 bottom-0 w-px"
              style={{
                background: tick.major ? "#221E1A" : "#A89F8B",
                height: tick.major ? "100%" : "50%",
              }}
            />
          </div>
        ))}
        {/* Per-chunk BPM bar ticks (drawn over time ruler) */}
        {barTicks.map((tick, i) => (
          <span
            key={`b-${i}`}
            className="absolute bottom-0"
            style={{
              left: timeToX(tick.tS),
              width: 1,
              height: tick.downbeat ? "70%" : "40%",
              background: tick.downbeat ? "#FF5722" : "#FF572299",
            }}
          />
        ))}
      </div>

      {/* Waveform */}
      <div className="absolute left-0 right-0" style={{ top: BAR_RULER_HEIGHT }}>
        <canvas ref={waveformCanvasRef} />
      </div>

      {/* Chunk lane */}
      <div
        className="absolute left-0 right-0 border-t border-rule bg-paper-deep"
        style={{
          top: BAR_RULER_HEIGHT + WAVEFORM_HEIGHT,
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

      {/* Playhead */}
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
      {/* Trim handles — only shown on chunks wide enough to hit. */}
      {showHandles && (
        <>
          <div
            className="absolute left-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("left", e)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to trim start (Alt = free, no bar snap)"
          />
          <div
            className="absolute right-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("right", e)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to trim end (Alt = free, no bar snap)"
          />
        </>
      )}
    </div>
  );
}

// ─── Bar-ruler tick generator ───────────────────────────────────────────
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
  downbeat: boolean;
}

/** Per-chunk bar/beat ticks. Skips chunks without BPM. Bails out when
 *  the bars would be too dense to read (< 4 px between ticks) — that
 *  visual noise is worse than nothing. */
function usePerChunkBarTicks(
  chunks: Chunk[],
  sessionBpm: number | null,
  viewStartS: number,
  viewEndS: number,
  pxPerSec: number,
): BarTick[] {
  return useMemo(() => {
    const ticks: BarTick[] = [];
    const minBeatPx = 3; // suppress beat ticks below this
    const minBarPx = 8; // suppress entire bar grid below this
    for (const chunk of chunks) {
      const bpm = effectiveChunkBpm(chunk, sessionBpm);
      if (bpm <= 0) continue;
      const sPerBeat = 60 / bpm;
      const sPerBar = sPerBeat * chunk.beatsPerBar;
      if (sPerBar * pxPerSec < minBarPx) continue;
      const startS = chunk.startMs / 1000;
      const endS = chunk.endMs / 1000;
      if (endS < viewStartS || startS > viewEndS) continue;
      const showBeats = sPerBeat * pxPerSec >= minBeatPx;
      // Bars from chunk start.
      let beat = 0;
      for (
        let t = startS;
        t <= endS && t <= viewEndS;
        t = startS + beat * sPerBeat, beat++
      ) {
        if (t < viewStartS) continue;
        const isDownbeat = beat % chunk.beatsPerBar === 0;
        if (!showBeats && !isDownbeat) continue;
        ticks.push({ tS: t, downbeat: isDownbeat });
      }
    }
    return ticks;
  }, [chunks, sessionBpm, viewStartS, viewEndS, pxPerSec]);
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
