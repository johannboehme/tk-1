/**
 * Reel preview player — the middle column.
 *
 * Plays the WHOLE reel: one `<video>` shows the member under the playhead,
 * positioned/letterboxed onto the common stage with that member's pan/zoom
 * (the exact transform the renderer applies). During playback the video runs
 * free and an rAF loop advances the global playhead; at a member boundary the
 * next member loads and continues. Drag = pan, wheel = zoom, double-click =
 * reset framing (only the member at the playhead).
 *
 * Audio is the member video's own track (synced to the picture). The render
 * uses each project's studio master instead — preview sound is a rough guide.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyViewportTransform } from "../../editor/render/element-transform";
import type { ViewportTransform } from "../../editor/types";
import type { ReelMember } from "../../local/reel/reel-store";

export interface ReelLayoutItem {
  member: ReelMember;
  start: number;
  dur: number;
}

export function reelLayout(members: ReelMember[]): ReelLayoutItem[] {
  let t = 0;
  const out: ReelLayoutItem[] = [];
  for (const m of members) {
    const dur = Math.max(0.05, m.trimOutS - m.trimInS);
    out.push({ member: m, start: t, dur });
    t += dur;
  }
  return out;
}

const SCALE_STEP = 1.01;
const SCALE_STEP_FINE = 1.002;
const DRAG_FACTOR = 0.2;
const PRECISION_DRAG_FACTOR = 0.05;
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;

export function ReelPlayer({
  members,
  stage,
  playheadS,
  playing,
  muted,
  onSeek,
  onPlayingChange,
  onFraming,
  onResetFraming,
}: {
  members: ReelMember[];
  stage: { w: number; h: number };
  playheadS: number;
  playing: boolean;
  muted: boolean;
  onSeek: (s: number) => void;
  onPlayingChange: (p: boolean) => void;
  onFraming: (memberId: string, patch: Partial<ViewportTransform>) => void;
  onResetFraming: (memberId: string) => void;
}) {
  const layouts = reelLayout(members);
  const total = layouts.reduce((a, l) => a + l.dur, 0);
  const cur =
    layouts.find((l) => playheadS >= l.start && playheadS < l.start + l.dur) ??
    layouts[layouts.length - 1] ??
    null;
  const localTime = cur ? Math.max(0, playheadS - cur.start) : 0;
  const memberId = cur?.member.memberId ?? null;

  const boxRef = useRef<HTMLDivElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setNatural(null);
    const v = vidRef.current;
    if (!v) return;
    const onMeta = () => setNatural({ w: v.videoWidth, h: v.videoHeight });
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [memberId]);

  // Seek the picture to the playhead. Paused: exact (any divergence). Playing:
  // only on a LARGE jump — a user scrub — so the rAF's per-frame playhead
  // updates don't fight playback (which made scrubbing within the current
  // clip snap straight back). Waits for `loadeddata` so the frame paints.
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const tol = playing ? 0.35 : 0.05;
    const apply = () => {
      try {
        const want = Math.min(localTime, v.duration || localTime);
        if (Math.abs(v.currentTime - want) > tol) v.currentTime = want;
      } catch {
        /* pre-load */
      }
    };
    if (v.readyState >= 2) apply();
    else v.addEventListener("loadeddata", apply, { once: true });
  }, [localTime, memberId, playing]);

  // Playing: run the video, advance the global playhead, hop members.
  useEffect(() => {
    if (!playing || !cur) return;
    const v = vidRef.current;
    if (!v) return;
    const startEnd = cur.start + cur.dur;

    const start = () => {
      try {
        // Set muted BEFORE play() — an unmuted play() from an effect (not the
        // click's gesture stack) is blocked by the browser, which is why
        // "play did nothing". Muted playback is always allowed.
        v.muted = muted;
        if (Math.abs(v.currentTime - localTime) > 0.3) v.currentTime = localTime;
      } catch {
        /* pre-load */
      }
      void v.play().catch(() => undefined);
    };
    if (v.readyState >= 2) start();
    else v.addEventListener("canplay", start, { once: true });

    const tick = () => {
      const vv = vidRef.current;
      if (!vv) return;
      const reachedEnd = vv.currentTime >= cur.dur - 0.03 || vv.ended;
      if (reachedEnd) {
        if (startEnd >= total - 0.05) {
          onPlayingChange(false);
          onSeek(total);
          return;
        }
        onSeek(startEnd + 0.001); // hop to next member
        return;
      }
      onSeek(cur.start + vv.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      v.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, memberId]);

  // Keep muted state on the element.
  useEffect(() => {
    const v = vidRef.current;
    if (v) v.muted = muted;
  }, [muted, memberId]);

  // --- Framing geometry (contain-fit + viewport), matches the renderer. ---
  const nat = natural ?? { w: stage.w, h: stage.h };
  const s = Math.min(stage.w / nat.w, stage.h / nat.h);
  const coverRect = {
    dstX: (stage.w - nat.w * s) / 2,
    dstY: (stage.h - nat.h * s) / 2,
    dstW: nat.w * s,
    dstH: nat.h * s,
  };
  const vp = cur?.member.viewport ?? { scale: 1, x: 0, y: 0 };
  const placed = applyViewportTransform(coverRect, vp);
  // Position in PERCENT of the stage: the box is sized to the stage aspect,
  // so stage coords map 1:1 onto the box without needing its pixel width
  // (which was racy to measure and left the video at 0×0 → black).
  const css = {
    left: `${(placed.dstX / stage.w) * 100}%`,
    top: `${(placed.dstY / stage.h) * 100}%`,
    width: `${(placed.dstW / stage.w) * 100}%`,
    height: `${(placed.dstH / stage.h) * 100}%`,
  };

  const dragRef = useRef<{ lx: number; ly: number; x: number; y: number } | null>(
    null,
  );
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !memberId) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { lx: e.clientX, ly: e.clientY, x: vp.x, y: vp.y };
    },
    [memberId, vp.x, vp.y],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d || !memberId) return;
      const k = e.altKey ? PRECISION_DRAG_FACTOR : DRAG_FACTOR;
      // client-px → stage-px using the box's live width (box spans stage.w).
      const boxPxW = boxRef.current?.getBoundingClientRect().width || stage.w;
      const inv = (stage.w / boxPxW) || 1;
      const nx = d.x + (e.clientX - d.lx) * inv * k;
      const ny = d.y + (e.clientY - d.ly) * inv * k;
      d.x = nx;
      d.y = ny;
      d.lx = e.clientX;
      d.ly = e.clientY;
      onFraming(memberId, { x: nx, y: ny });
    },
    [memberId, onFraming, stage.w],
  );
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
    dragRef.current = null;
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !memberId) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.altKey ? SCALE_STEP_FINE : SCALE_STEP;
      const f = e.deltaY < 0 ? step : 1 / step;
      const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, vp.scale * f));
      if (next !== vp.scale) onFraming(memberId, { scale: next });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [vp.scale, memberId, onFraming]);

  if (!cur) {
    return (
      <div className="w-full max-w-3xl mx-auto aspect-video bg-black/90 rounded-md flex items-center justify-center">
        <span className="font-mono text-xs text-paper-hi/50 tracking-label uppercase">
          empty reel
        </span>
      </div>
    );
  }

  const isDefault = vp.scale === 1 && vp.x === 0 && vp.y === 0;

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => memberId && onResetFraming(memberId)}
        className="relative w-full bg-black overflow-hidden rounded-md select-none touch-none"
        style={{ aspectRatio: `${stage.w} / ${stage.h}`, cursor: "grab" }}
      >
        {cur.member.missing ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-danger">
            project deleted
          </div>
        ) : !cur.member.videoUrl ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-[11px] text-paper-hi/70">
            Can't read this project's video — open it once in its editor to
            grant access, then reopen the reel.
          </div>
        ) : (
          <video
            key={memberId ?? "none"}
            ref={vidRef}
            src={cur.member.videoUrl}
            playsInline
            muted
            preload="auto"
            className="absolute object-cover"
            style={{ ...css, pointerEvents: "none" }}
          />
        )}
        <CornerMarks rect={css} />
        {!isDefault && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (memberId) onResetFraming(memberId);
            }}
            className="absolute right-2 bottom-2 z-10 font-display text-[10px] tracking-label uppercase text-paper-hi/80 hover:text-paper-hi bg-black/45 px-1.5 py-0.5 rounded"
          >
            ↻ reset framing
          </button>
        )}
        <span className="absolute left-2 top-2 font-mono text-[10px] tabular text-paper-hi/70 bg-black/40 px-1 rounded">
          {cur.member.title} · {Math.round(vp.scale * 100)}%
        </span>
      </div>
    </div>
  );
}

function CornerMarks({
  rect,
}: {
  rect: { left: string; top: string; width: string; height: string };
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
      {(
        [
          { left: 0, top: 0, h: true },
          { left: 0, top: 0, h: false },
          { right: 0, top: 0, h: true },
          { right: 0, top: 0, h: false },
          { left: 0, bottom: 0, h: true },
          { left: 0, bottom: 0, h: false },
          { right: 0, bottom: 0, h: true },
          { right: 0, bottom: 0, h: false },
        ] as const
      ).map((m, i) => (
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
