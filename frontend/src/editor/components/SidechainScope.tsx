/**
 * Sidechain scope — the Ableton-style marquee widget.
 *
 * A phosphor-LCD field that shows a ZOOMED, playhead-centred window of the
 * master-loudness envelope (~8 beats wide) so individual hits — the kick,
 * the snare — are legible. Faint beat grid-lines mark where the beats fall,
 * a draggable threshold line sets the level above which the effect engages,
 * and a tinted band shows the resulting effect-strength (the follower
 * curve) responding in real time. Renderer and this widget sample the SAME
 * follower curve, so what you see is what plays.
 *
 * Drawing the whole song squashed into the width (the old behaviour) made
 * the peaks unreadable — you couldn't tell a kick from a hi-hat, let alone
 * tune a threshold to it. The window scrolls with the playhead instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "../store";
import { fxCatalog } from "../fx/catalog";
import type { FxKind } from "../fx/types";
import {
  followerFor,
  DEFAULT_SIDECHAIN,
  type AudioEnvelope,
} from "../fx/modulation";
import {
  effectiveBeatPhaseS,
  effectiveBeatsPerBar,
} from "../selectors/timing";

const LCD_GREEN = "#9FE08E";
const RENDER_W = 280; // logical px (SVG viewBox); scales to container
const RENDER_H = 80;
const PAD_X = 4;
const PAD_Y = 5;
/** How many beats the window spans — wide enough for context, tight enough
 *  that a single kick is a clear, separate peak. Clamped to a seconds range
 *  for very slow / very fast tempos (and when BPM is unknown). */
const BEATS_VISIBLE = 8;
const MIN_SPAN_S = 2;
const MAX_SPAN_S = 8;

/** Linear-interpolated sample of a 0..1 envelope at master-time `tSec`. */
function sampleEnv(env: AudioEnvelope, tSec: number): number {
  const data = env.data;
  const n = data.length;
  if (n === 0) return 0;
  const fps = env.fps > 0 ? env.fps : 60;
  const x = tSec * fps;
  if (x <= 0) return data[0] ?? 0;
  if (x >= n - 1) return data[n - 1] ?? 0;
  const i = Math.floor(x);
  const f = x - i;
  return data[i] * (1 - f) + data[i + 1] * f;
}

/** Filled area path sampled per-pixel across the visible window. */
function windowAreaPath(
  sampleAt: (t: number) => number,
  winStart: number,
  spanS: number,
  w: number,
  h: number,
): string {
  const innerW = w - 2 * PAD_X;
  const innerH = h - 2 * PAD_Y;
  const steps = Math.max(2, Math.round(innerW));
  let d = `M${PAD_X.toFixed(1)},${(h - PAD_Y).toFixed(1)}`;
  for (let i = 0; i <= steps; i++) {
    const x = PAD_X + (i / steps) * innerW;
    const t = winStart + (i / steps) * spanS;
    const v = Math.max(0, Math.min(1, sampleAt(t)));
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
  const currentTime = useEditorStore((s) => s.playback.currentTime);
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value ?? null);
  const beatPhaseS = useEditorStore((s) => effectiveBeatPhaseS(s.jobMeta));
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
      const v = 1 - frac; // top = 1, bottom = 0
      setFxSidechain(kind, { threshold: Math.max(0, Math.min(1, v)) });
    },
    [kind, setFxSidechain],
  );

  // Off-window release guard — mirror the Encoder's belt-and-suspenders so a
  // pointerup outside the widget doesn't strand the drag.
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

  // Full follower curve (memoized by audio-env + config), sampled in the
  // window below — never rebuilt per frame.
  const follower = useMemo(
    () => (hasAudio && audioEnv ? followerFor(audioEnv, side) : null),
    [hasAudio, audioEnv, side],
  );

  const spanS =
    bpm && bpm > 0
      ? Math.min(MAX_SPAN_S, Math.max(MIN_SPAN_S, (BEATS_VISIBLE * 60) / bpm))
      : 4;
  const winStart = currentTime - spanS / 2; // playhead centred
  const innerW = RENDER_W - 2 * PAD_X;

  let masterPath = "";
  let followerPath = "";
  const beatLines: { x: number; down: boolean }[] = [];
  if (hasAudio && audioEnv) {
    masterPath = windowAreaPath(
      (t) => sampleEnv(audioEnv, t),
      winStart,
      spanS,
      RENDER_W,
      RENDER_H,
    );
    if (follower) {
      followerPath = windowAreaPath(
        (t) => sampleEnv(follower, t),
        winStart,
        spanS,
        RENDER_W,
        RENDER_H,
      );
    }
    if (bpm && bpm > 0) {
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

  const playheadX = PAD_X + 0.5 * innerW; // centred
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
          {/* beat grid — faint; downbeats brighter. Behind the waveform so
              the hits read on top but you can still see where beats fall. */}
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
          {/* master loudness — dim phosphor fill */}
          <path
            d={masterPath}
            fill={LCD_GREEN}
            fillOpacity={0.16}
            stroke={LCD_GREEN}
            strokeOpacity={0.45}
            strokeWidth={0.7}
          />
          {/* effect-strength band — tinted with the effect colour */}
          <path
            d={followerPath}
            fill={tint}
            fillOpacity={0.5}
            stroke={tint}
            strokeOpacity={0.9}
            strokeWidth={0.8}
          />
          {/* threshold line */}
          <line
            x1={PAD_X}
            x2={RENDER_W - PAD_X}
            y1={threshY}
            y2={threshY}
            stroke="#FFD27F"
            strokeWidth={dragging ? 1.6 : 1}
            strokeDasharray="3 2"
          />
          {/* playhead (centred "now") */}
          <line
            x1={playheadX}
            x2={playheadX}
            y1={PAD_Y}
            y2={RENDER_H - PAD_Y}
            stroke="#FFFFFF"
            strokeOpacity={0.55}
            strokeWidth={0.8}
          />
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
      {/* threshold readout */}
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
