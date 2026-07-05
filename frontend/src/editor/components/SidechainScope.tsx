/**
 * Sidechain scope — an Ableton-style marquee that is a true LENS over the
 * timeline's master-audio lane.
 *
 * It mirrors the timeline's EXACT visible window (same arrangement-time
 * range, derived from the shared ui.zoom + ui.scrollX + arrangement
 * duration) and maps every column arr→master before reading the
 * master-indexed amplitude envelope — so the peaks line up 1:1 with the
 * timeline audio lane, including across pill/segment seams in long-form.
 * Columns are MIN/MAX-bucketed (peak per column), not point-sampled, so the
 * waveform is stable while playback pages the window (no shimmer/"wabern").
 *
 * Overlaid: a draggable threshold line, the resulting effect-strength band
 * (the follower curve, same one the renderer uses), beat grid-lines, and
 * the playhead at its true position in the window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "../store";
import { fxCatalog } from "../fx/catalog";
import type { FxKind } from "../fx/types";
import {
  followerFor,
  sampleEnv,
  DEFAULT_SIDECHAIN,
} from "../fx/modulation";
import { arrBeatPhaseS, effectiveBeatsPerBar } from "../selectors/timing";
import {
  arrToMaster,
  timelineVisibleWindow,
  totalArrDuration,
} from "../arrangement-time";

import { clamp01 } from "../../lib/clamp";
const LCD_GREEN = "#9FE08E";
const RENDER_W = 280; // logical px (SVG viewBox); scales to container
const RENDER_H = 80;
// No horizontal inset: the time axis fills the full width exactly like the
// timeline canvas (mapXToTime maps x=0→viewStart, x=W→viewEnd), so the scope
// is pixel-for-pixel time-aligned across the two panels.
const PAD_X = 0;
const PAD_Y = 5;
/** Fallback window (no arrangement) — ~8 beats so a kick is a clear peak. */
const FALLBACK_BEATS = 8;


/**
 * Filled area path, PEAK-bucketed per column: each column takes the max
 * envelope value over the arr-time slice it covers, mapped arr→master. This
 * keeps the waveform identical to the timeline (which also min/max buckets)
 * and stable as the window pages — point-sampling shimmered instead.
 */
function peakAreaPath(
  envAtMaster: (masterT: number) => number,
  toMaster: (arrT: number) => number,
  winStart: number,
  spanS: number,
  w: number,
  h: number,
  sub: number, // sub-samples per column → capture the column's true peak
): string {
  const innerW = w - 2 * PAD_X;
  const innerH = h - 2 * PAD_Y;
  const steps = Math.max(2, Math.round(innerW));
  const s = Math.max(1, sub);
  let d = `M${PAD_X.toFixed(1)},${(h - PAD_Y).toFixed(1)}`;
  for (let i = 0; i <= steps; i++) {
    const x = PAD_X + (i / steps) * innerW;
    let v = 0;
    for (let k = 0; k < s; k++) {
      const frac = (i + k / s) / steps;
      const arrT = winStart + frac * spanS;
      const val = clamp01(envAtMaster(toMaster(arrT)));
      if (val > v) v = val;
    }
    const y = PAD_Y + (1 - v) * innerH;
    d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  d += ` L${(w - PAD_X).toFixed(1)},${(h - PAD_Y).toFixed(1)} Z`;
  return d;
}

export function SidechainScope({ kind }: { kind: FxKind }) {
  const audioEnv = useEditorStore((s) => s.audioEnv);
  const side =
    useEditorStore((s) => s.fxModulations[kind]?.side) ?? DEFAULT_SIDECHAIN;
  const setFxSidechain = useEditorStore((s) => s.setFxSidechain);
  const timelineT = useEditorStore((s) => s.playback.timelineT);
  const segments = useEditorStore((s) => s.arrangementSegments);
  // The timeline's visible window is derived from these shared values
  // (liveTimelineRange is always [0, arrTotal]), so we can reconstruct the
  // EXACT same range here without lifting any local Timeline state.
  const zoom = useEditorStore((s) => s.ui.zoom);
  const scrollX = useEditorStore((s) => s.ui.scrollX);
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value ?? null);
  const beatPhaseS = useEditorStore((s) =>
    arrBeatPhaseS(s.jobMeta, s.arrangementSegments),
  );
  const beatsPerBar = useEditorStore((s) => effectiveBeatsPerBar(s.jobMeta));
  const tint = fxCatalog[kind]?.capsuleColor ?? LCD_GREEN;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const setThresholdFromClientY = useCallback(
    (clientY: number) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const innerTop = rect.top + (PAD_Y / RENDER_H) * rect.height;
      const innerH = rect.height * (1 - (2 * PAD_Y) / RENDER_H);
      const frac = innerH > 0 ? (clientY - innerTop) / innerH : 0;
      setFxSidechain(kind, { threshold: clamp01(1 - frac) }); // top = 1
    },
    [kind, setFxSidechain],
  );

  // Off-window release guard — mirror the Encoder's belt-and-suspenders.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setThresholdFromClientY(e.clientY);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
  }, [dragging, setThresholdFromClientY]);

  const hasAudio = !!audioEnv && audioEnv.data.length > 0;

  const follower = useMemo(
    () => (hasAudio && audioEnv ? followerFor(audioEnv, side) : null),
    [hasAudio, audioEnv, side],
  );

  // Reconstruct the timeline's EXACT visible arr-time window (shared helper
  // → can't drift from Timeline.tsx).
  const arrTotal = totalArrDuration(segments);
  let spanS: number;
  let winStart: number;
  if (arrTotal > 0) {
    const win = timelineVisibleWindow(arrTotal, zoom, scrollX);
    winStart = win.startS;
    spanS = win.spanS;
  } else {
    // No arrangement → centre a fallback window on the playhead.
    spanS = bpm && bpm > 0 ? Math.min(8, Math.max(2, (FALLBACK_BEATS * 60) / bpm)) : 4;
    winStart = timelineT - spanS / 2;
  }
  const innerW = RENDER_W - 2 * PAD_X;
  // Sub-samples per column: enough to catch the tallest env sample a column
  // spans (so peak HEIGHT isn't under-shown when zoomed out), capped for perf.
  const envFps = audioEnv?.fps ?? 120;
  const peakSub = Math.min(
    32,
    Math.max(4, Math.ceil((spanS / Math.max(1, innerW)) * envFps)),
  );

  // The paths + grid depend only on the window and the curves — NOT on the
  // playhead. This component re-renders on every timelineT tick (60 Hz
  // during playback); without the memo it would re-trace both SVG area
  // paths (~columns × sub-samples envelope lookups each, plus arr→master
  // projections) per tick just to move the playhead line. In the
  // no-arrangement fallback the window is playhead-centred, so `winStart`
  // changes per tick and the memo recomputes — same behaviour as before.
  const { masterPath, followerPath, beatLines } = useMemo(() => {
    const toMaster = (arrT: number) =>
      arrTotal > 0 ? arrToMaster(arrT, segments) : arrT;
    let masterPath = "";
    let followerPath = "";
    const beatLines: { x: number; down: boolean }[] = [];
    if (hasAudio && audioEnv) {
      masterPath = peakAreaPath(
        (m) => sampleEnv(audioEnv, m),
        toMaster,
        winStart,
        spanS,
        RENDER_W,
        RENDER_H,
        peakSub,
      );
      if (follower) {
        followerPath = peakAreaPath(
          (m) => sampleEnv(follower, m),
          toMaster,
          winStart,
          spanS,
          RENDER_W,
          RENDER_H,
          peakSub,
        );
      }
      if (bpm && bpm > 0 && spanS > 0) {
        const period = 60 / bpm;
        const firstK = Math.ceil((winStart - beatPhaseS) / period);
        for (let k = firstK; ; k++) {
          const t = beatPhaseS + k * period;
          if (t > winStart + spanS) break;
          if (t < winStart) continue;
          const x = PAD_X + ((t - winStart) / spanS) * innerW;
          const down = ((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
          beatLines.push({ x, down });
        }
      }
    }
    return { masterPath, followerPath, beatLines };
  }, [
    hasAudio,
    audioEnv,
    follower,
    arrTotal,
    segments,
    winStart,
    spanS,
    peakSub,
    bpm,
    beatPhaseS,
    beatsPerBar,
    innerW,
  ]);

  // Playhead at its TRUE position in the window (matches the timeline).
  const playheadFrac = spanS > 0 ? (timelineT - winStart) / spanS : -1;
  const playheadX =
    playheadFrac >= 0 && playheadFrac <= 1
      ? PAD_X + playheadFrac * innerW
      : -1;
  const threshY = PAD_Y + (1 - side.threshold) * (RENDER_H - 2 * PAD_Y);

  return (
    <div
      className="relative w-full"
      style={{
        height: RENDER_H,
        background: "linear-gradient(180deg, #1A2418 0%, #1F2A1E 100%)",
        border: "1px solid rgba(0,0,0,0.7)",
        borderRadius: 3,
        boxShadow:
          "inset 0 1px 1px rgba(0,0,0,0.7), inset 0 -1px 1px rgba(255,255,255,0.04), 0 0 0 2px rgba(0,0,0,0.35)",
        overflow: "hidden",
        cursor: hasAudio ? "ns-resize" : "default",
        touchAction: "none",
      }}
    >
      {/* scanlines */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 2px)",
          mixBlendMode: "multiply",
          zIndex: 2,
        }}
      />
      {hasAudio ? (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${RENDER_W} ${RENDER_H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          style={{
            display: "block",
            touchAction: "none",
            position: "relative",
            zIndex: 1,
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            setDragging(true);
            setThresholdFromClientY(e.clientY);
          }}
        >
          {beatLines.map((b, i) => (
            <line
              key={i}
              x1={b.x}
              x2={b.x}
              y1={PAD_Y}
              y2={RENDER_H - PAD_Y}
              stroke={LCD_GREEN}
              strokeOpacity={b.down ? 0.22 : 0.1}
              strokeWidth={b.down ? 0.8 : 0.5}
            />
          ))}
          <path
            d={masterPath}
            fill={LCD_GREEN}
            fillOpacity={0.16}
            stroke={LCD_GREEN}
            strokeOpacity={0.45}
            strokeWidth={0.7}
          />
          <path
            d={followerPath}
            fill={tint}
            fillOpacity={0.5}
            stroke={tint}
            strokeOpacity={0.9}
            strokeWidth={0.8}
          />
          <line
            x1={PAD_X}
            x2={RENDER_W - PAD_X}
            y1={threshY}
            y2={threshY}
            stroke="#FFD27F"
            strokeWidth={dragging ? 1.6 : 1}
            strokeDasharray="3 2"
          />
          {playheadX >= 0 && (
            <line
              x1={playheadX}
              x2={playheadX}
              y1={PAD_Y}
              y2={RENDER_H - PAD_Y}
              stroke="#FFFFFF"
              strokeOpacity={0.55}
              strokeWidth={0.8}
            />
          )}
        </svg>
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            color: "#6EA060",
            fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
            fontSize: 10,
            letterSpacing: 1.5,
            zIndex: 1,
          }}
        >
          NO AUDIO
        </div>
      )}
      {hasAudio && (
        <span
          aria-hidden
          className="absolute right-1 top-0.5 leading-none"
          style={{
            fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
            fontSize: 8,
            letterSpacing: 0.5,
            color: "#FFD27F",
            textShadow: "0 0 3px rgba(255,210,127,0.5)",
            zIndex: 3,
          }}
        >
          THR {Math.round(side.threshold * 100)}
        </span>
      )}
    </div>
  );
}
