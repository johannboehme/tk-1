/**
 * Sidechain scope — the Ableton-style marquee widget.
 *
 * Phosphor-LCD field that draws the master-loudness envelope, a draggable
 * threshold line, and a preview band of the resulting effect-strength
 * (the follower curve) tinted with the effect's colour. Renderer and this
 * widget sample the SAME `buildFollowerCurve`, so what you see is what plays.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store";
import { fxCatalog } from "../fx/catalog";
import type { FxKind } from "../fx/types";
import {
  buildFollowerCurve,
  DEFAULT_SIDECHAIN,
  type AudioEnvelope,
} from "../fx/modulation";

const LCD_GREEN = "#9FE08E";
const RENDER_W = 280; // logical px (SVG viewBox); scales to container
const RENDER_H = 80;
const PAD_X = 4;
const PAD_Y = 5;

/** Downsample a 0..1 envelope to `n` peak buckets for a compact SVG path. */
function bucketize(data: readonly number[] | Float32Array, n: number): number[] {
  const out = new Array(n).fill(0);
  if (data.length === 0) return out;
  const per = data.length / n;
  for (let i = 0; i < n; i++) {
    const lo = Math.floor(i * per);
    const hi = Math.min(data.length, Math.floor((i + 1) * per) + 1);
    let m = 0;
    for (let j = lo; j < hi; j++) if (data[j] > m) m = data[j];
    out[i] = m;
  }
  return out;
}

/** Build a filled area path (baseline at bottom) for a 0..1 bucket list. */
function areaPath(buckets: number[], w: number, h: number): string {
  const n = buckets.length;
  if (n === 0) return "";
  const innerW = w - 2 * PAD_X;
  const innerH = h - 2 * PAD_Y;
  const x = (i: number) => PAD_X + (i / (n - 1)) * innerW;
  const y = (v: number) => PAD_Y + (1 - v) * innerH;
  let d = `M${PAD_X.toFixed(1)},${(h - PAD_Y).toFixed(1)}`;
  for (let i = 0; i < n; i++) d += ` L${x(i).toFixed(1)},${y(buckets[i]).toFixed(1)}`;
  d += ` L${(w - PAD_X).toFixed(1)},${(h - PAD_Y).toFixed(1)} Z`;
  return d;
}

export function SidechainScope({ kind }: { kind: FxKind }) {
  const audioEnv = useEditorStore((s) => s.audioEnv);
  const side =
    useEditorStore((s) => s.fxModulations[kind]?.side) ?? DEFAULT_SIDECHAIN;
  const setFxSidechain = useEditorStore((s) => s.setFxSidechain);
  const currentTime = useEditorStore((s) => s.playback.currentTime);
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

  let masterPath = "";
  let followerPath = "";
  let playheadX = -1;
  if (hasAudio && audioEnv) {
    const n = RENDER_W - 2 * PAD_X;
    masterPath = areaPath(bucketize(audioEnv.data, n), RENDER_W, RENDER_H);
    const follower: AudioEnvelope = buildFollowerCurve(audioEnv, side);
    followerPath = areaPath(bucketize(follower.data, n), RENDER_W, RENDER_H);
    const durS = audioEnv.data.length / (audioEnv.fps || 60);
    if (durS > 0) {
      const frac = Math.max(0, Math.min(1, currentTime / durS));
      playheadX = PAD_X + frac * (RENDER_W - 2 * PAD_X);
    }
  }

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
          style={{ display: "block", touchAction: "none", position: "relative", zIndex: 1 }}
          onPointerDown={(e) => {
            e.preventDefault();
            setDragging(true);
            setThresholdFromClientY(e.clientY);
          }}
        >
          {/* master loudness — dim phosphor fill */}
          <path d={masterPath} fill={LCD_GREEN} fillOpacity={0.16} stroke={LCD_GREEN} strokeOpacity={0.4} strokeWidth={0.7} />
          {/* effect-strength preview band — tinted with the effect colour */}
          <path d={followerPath} fill={tint} fillOpacity={0.5} stroke={tint} strokeOpacity={0.9} strokeWidth={0.8} />
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
          {/* playhead */}
          {playheadX >= 0 && (
            <line
              x1={playheadX}
              x2={playheadX}
              y1={PAD_Y}
              y2={RENDER_H - PAD_Y}
              stroke="#FFFFFF"
              strokeOpacity={0.5}
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
