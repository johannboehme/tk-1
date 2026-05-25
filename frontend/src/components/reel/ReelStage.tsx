/**
 * Reel framing preview: shows the selected member's frame contain-fit onto
 * the common reel stage with its per-member pan/zoom — the exact transform
 * the renderer's `outer` letterbox applies. Drag = translate, wheel = zoom,
 * double-click = reset. Orange L-corner marks track the placed frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyViewportTransform } from "../../editor/render/element-transform";
import type { ViewportTransform } from "../../editor/types";

const SCALE_STEP = 1.01;
const SCALE_STEP_FINE = 1.002;
const DRAG_FACTOR = 0.2;
const PRECISION_DRAG_FACTOR = 0.05;
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;

export function ReelStage({
  stage,
  videoUrl,
  seekTime = 0,
  viewport,
  onViewport,
  onReset,
}: {
  stage: { w: number; h: number };
  videoUrl: string | null;
  /** Source-time (s) of the frame to show — driven by the frame scrubber. */
  seekTime?: number;
  viewport: ViewportTransform;
  onViewport: (patch: Partial<ViewportTransform>) => void;
  onReset: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setNatural(null);
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => setNatural({ w: v.videoWidth, h: v.videoHeight });
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [videoUrl]);

  // Seek the preview to the scrubbed frame so framing is judged against
  // real content, not a fixed poster.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      try {
        v.currentTime = Math.max(0, Math.min(seekTime, v.duration || seekTime));
      } catch {
        /* seek rejected pre-load */
      }
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
  }, [seekTime, videoUrl]);

  const nat = natural ?? { w: stage.w, h: stage.h };
  // Contain-fit (letterbox) the member's native frame into the stage, then
  // apply the user's pan/zoom — identical to the render's `outer` math.
  const s = Math.min(stage.w / nat.w, stage.h / nat.h);
  const cover = {
    dstX: (stage.w - nat.w * s) / 2,
    dstY: (stage.h - nat.h * s) / 2,
    dstW: nat.w * s,
    dstH: nat.h * s,
  };
  const placed = applyViewportTransform(cover, viewport);
  const cssScale = stage.w > 0 ? boxW / stage.w : 1;

  const dragRef = useRef<{
    lx: number;
    ly: number;
    x: number;
    y: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { lx: e.clientX, ly: e.clientY, x: viewport.x, y: viewport.y };
    },
    [viewport.x, viewport.y],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const k = e.altKey ? PRECISION_DRAG_FACTOR : DRAG_FACTOR;
      const inv = cssScale === 0 ? 1 : 1 / cssScale;
      const nx = d.x + (e.clientX - d.lx) * inv * k;
      const ny = d.y + (e.clientY - d.ly) * inv * k;
      d.x = nx;
      d.y = ny;
      d.lx = e.clientX;
      d.ly = e.clientY;
      onViewport({ x: nx, y: ny });
    },
    [cssScale, onViewport],
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    dragRef.current = null;
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.altKey ? SCALE_STEP_FINE : SCALE_STEP;
      const f = e.deltaY < 0 ? step : 1 / step;
      const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, viewport.scale * f));
      if (next !== viewport.scale) onViewport({ scale: next });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [viewport.scale, onViewport]);

  const isDefault =
    viewport.scale === 1 && viewport.x === 0 && viewport.y === 0;
  const css = {
    left: placed.dstX * cssScale,
    top: placed.dstY * cssScale,
    width: placed.dstW * cssScale,
    height: placed.dstH * cssScale,
  };

  return (
    <div
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      className="relative w-full bg-black overflow-hidden rounded-md select-none touch-none"
      style={{ aspectRatio: `${stage.w} / ${stage.h}`, cursor: "grab" }}
    >
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          className="absolute object-cover pointer-events-none"
          style={css}
        />
      )}
      <CornerMarks rect={css} />
      {!isDefault && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
          className="absolute right-2 bottom-2 z-10 font-display text-[10px] tracking-label uppercase text-paper-hi/80 hover:text-paper-hi bg-black/45 px-1.5 py-0.5 rounded"
        >
          ↻ reset
        </button>
      )}
      <span className="absolute left-2 top-2 font-mono text-[10px] tabular text-paper-hi/70">
        {Math.round(viewport.scale * 100)}%
      </span>
    </div>
  );
}

function CornerMarks({
  rect,
}: {
  rect: { left: number; top: number; width: number; height: number };
}) {
  const SIZE = 13;
  const W = 2;
  const C = "rgba(255,87,34,0.9)";
  return (
    <div
      aria-hidden
      className="absolute pointer-events-none"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {([
        { left: 0, top: 0, h: true },
        { left: 0, top: 0, h: false },
        { right: 0, top: 0, h: true },
        { right: 0, top: 0, h: false },
        { left: 0, bottom: 0, h: true },
        { left: 0, bottom: 0, h: false },
        { right: 0, bottom: 0, h: true },
        { right: 0, bottom: 0, h: false },
      ] as const).map((m, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: "left" in m ? m.left : undefined,
            right: "right" in m ? m.right : undefined,
            top: "top" in m ? m.top : undefined,
            bottom: "bottom" in m ? m.bottom : undefined,
            width: m.h ? SIZE : W,
            height: m.h ? W : SIZE,
            backgroundColor: C,
          }}
        />
      ))}
    </div>
  );
}
