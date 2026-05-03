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

  function onCanvasClick(e: React.MouseEvent) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const t = xToTime(xPx);
    const chunkLaneTop = TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight;
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

  // ─── Trim drag ────────────────────────────────────────────────────────
  // Per-chunk left/right edge drag. Uses the editor's snap helper so
  // the modes (off / 1 / 1/2 / 1/4 / 1/8 / 1/16) feel identical to the
  // editor's timeline.
  const dragRef = useRef<
    | {
        chunkId: string;
        edge: "left" | "right";
        bpm: number;
        anchorS: number;
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
    const bpm = effectiveChunkBpm(chunk, jobBpm?.value ?? null);
    dragRef.current = {
      chunkId: chunk.id,
      edge,
      bpm,
      anchorS: chunkBeatPhaseS(chunk),
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
      const tS = xToTime(xPx);
      // Alt = bypass snap for free positioning, otherwise honour the
      // active snap mode anchored at the chunk's own audio-start.
      const snapped = ev.shiftKey
        ? tS
        : snapTime(tS, snapMode, {
            bpm: dragRef.current.bpm > 0 ? dragRef.current.bpm : null,
            beatPhase: dragRef.current.anchorS,
            beatsPerBar,
          });
      let timeMs = Math.round(snapped * 1000);
      const chunk = chunks.find((c) => c.id === dragRef.current!.chunkId);
      if (!chunk) return;
      if (dragRef.current.edge === "left") {
        const next = Math.max(0, Math.min(chunk.endMs - 100, timeMs));
        if (next !== chunk.startMs) {
          updateChunk(chunk.id, {
            startMs: next,
            trimMode: ev.shiftKey ? "free" : "bar",
          });
        }
      } else {
        const next = Math.max(
          chunk.startMs + 100,
          Math.min(audioDuration * 1000, timeMs),
        );
        if (next !== chunk.endMs) {
          updateChunk(chunk.id, {
            endMs: next,
            trimMode: ev.shiftKey ? "free" : "bar",
          });
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
  }, [chunks, updateChunk, xToTime, audioDuration, snapMode, beatsPerBar]);

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
  const audioStartMarkers = useAudioStartMarkers(
    chunks,
    focusedChunkId,
    viewStartS,
    viewEndS,
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
      onClick={onCanvasClick}
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
          // Downbeats: thick, full-height. Beats: thin, half-height.
          const isDownbeat = tick.downbeat;
          const tickWidth = isDownbeat ? 2 : 1;
          const tickHeight = isDownbeat ? "100%" : "45%";
          const tickColor = isDownbeat
            ? dim
              ? "#FF572266"
              : HOT_COLOR
            : dim
              ? "#FF572233"
              : "#FF5722B0";
          return (
            <span key={`b-${i}`}>
              <span
                className="absolute bottom-0"
                style={{
                  left: timeToX(tick.tS),
                  width: tickWidth,
                  height: tickHeight,
                  background: tickColor,
                  marginLeft: -tickWidth / 2,
                }}
              />
              {isDownbeat && (
                <span
                  className="absolute font-display tracking-[0.05em] uppercase tabular leading-none select-none"
                  style={{
                    left: timeToX(tick.tS) + 3,
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

      {/* Audio-start anchor markers — one per visible chunk at its
       *  audioStartMs. A thin hot vertical line spans bar ruler →
       *  waveform → chunk lane, plus a small filled flag glyph at the
       *  top of the bar ruler. Makes "where bar 1 begins" obvious
       *  even at high zoom or when the chunk extends across the
       *  whole view. */}
      {audioStartMarkers.map((marker) => {
        const x = timeToX(marker.tS);
        const opacity = marker.focused ? 1 : 0.55;
        const lineTop = TIME_RULER_HEIGHT;
        const lineBottom = TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight;
        return (
          <div
            key={`as-${marker.chunkId}`}
            className="absolute pointer-events-none"
            style={{
              left: x,
              top: lineTop,
              height: lineBottom - lineTop,
              width: 0,
              zIndex: 3,
              opacity,
            }}
          >
            {/* Vertical anchor line through bar ruler + waveform. */}
            <span
              className="absolute"
              style={{
                left: -1,
                top: 0,
                bottom: 0,
                width: 2,
                background: HOT_COLOR,
                boxShadow: "0 0 4px rgba(255,87,34,0.4)",
              }}
            />
            {/* Flag at the top of the bar ruler. */}
            <span
              className="absolute font-display text-[7px] tracking-[0.1em] uppercase leading-none px-1 py-0.5 rounded-[2px] whitespace-nowrap"
              style={{
                left: 2,
                top: 0,
                background: HOT_COLOR,
                color: "#FAF6EC",
                boxShadow: "0 1px 1px rgba(0,0,0,0.2)",
              }}
            >
              {marker.detected ? "▼1" : "1"}
            </span>
          </div>
        );
      })}

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
            className="absolute left-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("left", e)}
            onClick={(e) => e.stopPropagation()}
            title="Drag to trim start (Shift = bypass snap)"
          />
          <div
            className="absolute right-0 top-0 bottom-0 cursor-ew-resize"
            style={{
              width: TRIM_HANDLE_PX,
              background: focused ? "#2F6FED" : "rgba(0,0,0,0.25)",
            }}
            onMouseDown={(e) => onTrimStart("right", e)}
            onClick={(e) => e.stopPropagation()}
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
  downbeat: boolean;
  /** Bar number — 1 at the chunk's audio-start anchor, 2 at the next
   *  downbeat, etc. Only meaningful for downbeats (beats inside a bar
   *  share the same barIndex but we don't render it for them). */
  barIndex: number;
  /** True when this tick lies outside the chunk's current bounds — a
   *  potential snap target if the user trims outwards. Rendered
   *  dimmer so the user sees where the next bar would land without
   *  confusing it with the chunk's "real" content. */
  extension: boolean;
}

interface AudioStartMarker {
  tS: number;
  chunkId: string;
  focused: boolean;
  /** Whether the chunk has its own per-chunk audio-start detection. If
   *  false, the marker sits at the chunk's silence-detection start —
   *  still useful as a "this is where the chunk begins" indicator,
   *  just less musically meaningful. */
  detected: boolean;
}

/** Per-chunk bar/beat ticks. Each chunk has its own anchor (audio-
 *  start onset) and uses the song-global BPM (or its own detected
 *  value as fallback). Chunks with no BPM info anywhere are skipped.
 *
 *  Visibility rules:
 *  - Non-focused chunks: ticks only within the chunk's current bounds.
 *  - Focused chunk: ticks render across the FULL visible view, so the
 *    user can see snap targets when trim-dragging the boundary
 *    outwards past the current chunk extent. The extra ticks carry
 *    `extension: true` and are drawn at lower contrast.
 */
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
    const ticks: BarTick[] = [];
    const minBeatPx = 3;
    const minBarPx = 8;
    for (const chunk of chunks) {
      const bpm = effectiveChunkBpm(chunk, jobBpm);
      if (bpm <= 0) continue;
      const sPerBeat = 60 / bpm;
      const sPerBar = sPerBeat * beatsPerBar;
      if (sPerBar * pxPerSec < minBarPx) continue;
      const startS = chunk.startMs / 1000;
      const endS = chunk.endMs / 1000;
      const isFocused = chunk.id === focusedChunkId;
      // Where this chunk's grid should render. Focused chunks paint
      // their grid across the full view to expose snap targets while
      // trimming; everyone else stays inside their bounds.
      const renderStart = isFocused ? viewStartS : Math.max(startS, viewStartS);
      const renderEnd = isFocused ? viewEndS : Math.min(endS, viewEndS);
      if (renderEnd < viewStartS || renderStart > viewEndS) continue;
      const showBeats = sPerBeat * pxPerSec >= minBeatPx;
      const anchorS = chunkBeatPhaseS(chunk);

      // Forward sweep from anchor (anchor = beat 0 = bar 1).
      let beat = 0;
      for (
        let t = anchorS;
        t <= renderEnd;
        t = anchorS + ++beat * sPerBeat
      ) {
        if (t < renderStart) continue;
        const isDownbeat = beat % beatsPerBar === 0;
        if (!showBeats && !isDownbeat) continue;
        const extension = isFocused && (t < startS || t > endS);
        const barIndex = Math.floor(beat / beatsPerBar) + 1;
        ticks.push({ tS: t, downbeat: isDownbeat, barIndex, extension });
      }
      // Backward sweep — start at beat -1 (anchor itself was emitted).
      beat = -1;
      for (
        let t = anchorS + beat * sPerBeat;
        t >= renderStart;
        t = anchorS + --beat * sPerBeat
      ) {
        if (t > renderEnd) continue;
        const isDownbeat = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        if (!showBeats && !isDownbeat) continue;
        const extension = isFocused && (t < startS || t > endS);
        const barIndex = Math.floor(beat / beatsPerBar) + 1;
        ticks.push({ tS: t, downbeat: isDownbeat, barIndex, extension });
      }
    }
    return ticks;
  }, [chunks, focusedChunkId, jobBpm, beatsPerBar, viewStartS, viewEndS, pxPerSec]);
}

/** One marker per chunk at its audio-start anchor (= where bar 1
 *  lives). Drawn as a vertical line spanning the timeline + a small
 *  flag glyph in the bar ruler, so the user can see "where the
 *  chunk's musical grid begins". */
function useAudioStartMarkers(
  chunks: Chunk[],
  focusedChunkId: string | null,
  viewStartS: number,
  viewEndS: number,
): AudioStartMarker[] {
  return useMemo(() => {
    const out: AudioStartMarker[] = [];
    for (const c of chunks) {
      const anchorMs = c.audioStartMs ?? c.startMs;
      const tS = anchorMs / 1000;
      if (tS < viewStartS || tS > viewEndS) continue;
      out.push({
        tS,
        chunkId: c.id,
        focused: c.id === focusedChunkId,
        detected: c.audioStartMs !== undefined && c.audioStartMs !== c.startMs,
      });
    }
    return out;
  }, [chunks, focusedChunkId, viewStartS, viewEndS]);
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
