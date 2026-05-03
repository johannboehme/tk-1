/**
 * TriageTimeline — the main visual surface of the Triage workflow.
 *
 * Three stacked layers, all sharing the same time-window mapping:
 *   1. Bar-ruler strip (top, ~26 px) — beat / bar ticks per chunk's BPM.
 *      Reuses the editor's `buildRulerTicks` density-adaption so it
 *      stays readable at any zoom.
 *   2. Waveform (Canvas2D, ~120 px) — RMS envelope as vertical bars.
 *      Above the silence-threshold = ink, below = ink-3.
 *   3. Chunk lane (~28 px) — solid-color bars per chunk. Accepted = hot,
 *      rejected = ink-2 with a strikethrough line, focused = cobalt
 *      outline on top.
 *
 * Plus a playhead overlay and zoom/pan affordances:
 *   - mouse-wheel = zoom anchored at cursor x
 *   - shift+drag or middle-mouse = pan
 *   - click on the lane = focus the chunk under cursor
 *   - click on the waveform / ruler = seek the playhead
 *
 * No transparency tricks — all chunk states are solid colors so the
 * accept/reject distinction reads at any background.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chunk } from "../../storage/jobs-db";
import { useTriageStore } from "../../local/triage/triage-store";

const BAR_RULER_HEIGHT = 24;
const WAVEFORM_HEIGHT = 120;
const CHUNK_LANE_HEIGHT = 28;
const PLAYHEAD_COLOR = "#FF5722";

export function TriageTimeline() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);

  const audioDuration = useTriageStore((s) => s.audioDuration);
  const envelope = useTriageStore((s) => s.envelope);
  const envelopeHz = useTriageStore((s) => s.envelopeHz);
  const chunks = useTriageStore((s) => s.chunks);
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const view = useTriageStore((s) => s.view);
  const setZoom = useTriageStore((s) => s.setZoom);
  const setScrollX = useTriageStore((s) => s.setScrollX);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const seek = useTriageStore((s) => s.seek);
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

  // Wheel = zoom (if no modifier), shift+wheel = pan, on a trackpad
  // horizontal scroll already pans naturally via deltaX.
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Pan
      const panSecs = ((e.deltaX || e.deltaY) / pxPerSec) * 0.5;
      setScrollX(view.scrollX + panSecs);
      return;
    }
    // Zoom anchored at cursor
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

  // Tap/click on the canvas = seek (or focus a chunk if the click
  // landed on the chunk lane).
  function onCanvasClick(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const t = xToTime(xPx);
    // Chunk lane sits at the bottom of the stack.
    const chunkLaneTop =
      BAR_RULER_HEIGHT + WAVEFORM_HEIGHT;
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

  // ─── Layer 1: Bar-Ruler ───────────────────────────────────────────────
  // For Phase-3 v1: show simple second/minute marks. Per-chunk BPM bar
  // ruler comes in a follow-up — needs the focused-chunk BPM threaded
  // through, which works but adds complexity I'd rather land separately.
  const ruler = useTimeRuler(viewStartS, viewEndS, width);

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

    // Background.
    ctx.fillStyle = "#FAF6EC";
    ctx.fillRect(0, 0, cssW, cssH);

    // Threshold line at the visualisation level (visible reference).
    const thresholdLin = Math.pow(10, silenceConfig.thresholdDb / 20);
    const peakRef = Math.max(0.01, ...envelope);

    // Draw envelope as vertical bars centered on the lane.
    // Each pixel column = one or more envelope samples.
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
      ctx.fillStyle = aboveThreshold ? "#221E1A" : "#A89F8B"; // ink / ink-3
      ctx.fillRect(xPx, cx - h, 1, h * 2);
    }

    // Threshold guide line.
    const thresholdY = cx - (thresholdLin / peakRef) * half;
    if (thresholdY > 0 && thresholdY < cssH) {
      ctx.strokeStyle = "rgba(255,87,34,0.5)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, thresholdY);
      ctx.lineTo(cssW, thresholdY);
      ctx.stroke();
      ctx.setLineDash([]);
      const thresholdYBottom = cx + (thresholdLin / peakRef) * half;
      if (thresholdYBottom < cssH) {
        ctx.beginPath();
        ctx.moveTo(0, thresholdYBottom);
        ctx.lineTo(cssW, thresholdYBottom);
        ctx.stroke();
      }
    }
  }, [envelope, envelopeHz, width, viewStartS, viewEndS, silenceConfig, xToTime]);

  // ─── Layer 3: Chunk Lane ──────────────────────────────────────────────
  // DOM-rendered (not canvas) so we get accessible click targets,
  // hover states, and per-chunk styling for free.
  const totalHeight = BAR_RULER_HEIGHT + WAVEFORM_HEIGHT + CHUNK_LANE_HEIGHT;

  return (
    <div
      ref={wrapperRef}
      className="relative w-full bg-paper-hi border border-rule rounded-md overflow-hidden select-none"
      style={{ height: totalHeight }}
      onWheel={onWheel}
      onClick={onCanvasClick}
    >
      {/* Bar-ruler */}
      <div
        className="absolute left-0 top-0 right-0 bg-paper-deep border-b border-rule pointer-events-none"
        style={{ height: BAR_RULER_HEIGHT }}
      >
        {ruler.map((tick, i) => (
          <div
            key={i}
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
          />
        ))}
      </div>

      {/* Playhead — vertical line spanning all layers */}
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
}

function ChunkBlock({ chunk, timeToX, visibleStart, visibleEnd, focused }: ChunkBlockProps) {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  // Cull chunks fully outside the view.
  if (endS < visibleStart || startS > visibleEnd) return null;

  const left = timeToX(startS);
  const right = timeToX(endS);
  const widthPx = Math.max(2, right - left);

  // Solid colors — no opacity tricks.
  const bg = chunk.accepted ? "#FF5722" : "#5D5546";
  const fg = chunk.accepted ? "#FAF6EC" : "#A89F8B";

  // At very narrow widths (zoomed-out) we just show a colored stripe.
  // At wider widths we add labels and (for rejected chunks) the X badge.
  const showLabel = widthPx >= 28;
  const showFullDetail = widthPx >= 120;

  return (
    <div
      className="absolute top-0 bottom-0 flex items-center px-1 overflow-hidden"
      style={{
        left,
        width: widthPx,
        background: bg,
        color: fg,
        // Focused gets an orthogonal cobalt outline so it stays
        // distinguishable on either accepted or rejected backgrounds.
        outline: focused ? "2px solid #2F6FED" : undefined,
        outlineOffset: focused ? -2 : undefined,
        zIndex: focused ? 2 : 1,
      }}
      title={`${chunk.id}: ${formatTime(startS)} → ${formatTime(endS)}${
        chunk.detectedBpm ? ` · ${chunk.detectedBpm.toFixed(1)} BPM` : ""
      }`}
    >
      {!chunk.accepted && (
        // Strikethrough line for rejected chunks — second visual cue
        // beyond color, so accept/reject reads even on monochrome
        // displays.
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
    </div>
  );
}

// ─── Bar-ruler tick generator ───────────────────────────────────────────
// Picks a sensible tick spacing for the visible time range. Returns
// labels in MM:SS form for major ticks and tick lines for minor.

interface RulerTick {
  t: number;
  label: string;
  major: boolean;
}

function useTimeRuler(viewStartS: number, viewEndS: number, widthPx: number): RulerTick[] {
  return useMemo(() => {
    const visible = viewEndS - viewStartS;
    if (visible <= 0 || widthPx <= 0) return [];

    // Aim for one major tick per ~120 px.
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

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  // 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600 ...
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
