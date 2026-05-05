/**
 * Polaroid — a single chunk-card.
 *
 * Used in two contexts:
 *   1. Contact-Sheet (source pool): chunky, has +ADD button, shows
 *      usage-count badge.
 *   2. (Internally) the FilmStrip uses a sister component that shares
 *      the develop-in look but lays out as a length-proportional frame.
 *
 * Visual: cream paper-stock card with a glossy "image well" and a
 * label strip at the bottom. The image fades in with a Polaroid
 * develop-in filter (saturate 0 → 1, brightness 0.4 → 1).
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";
import { useChunkThumbnail } from "./useChunkThumbnail";
import { useArrangeStore } from "../../local/arrange/arrange-store";

interface PolaroidProps {
  jobId: string | null;
  cam: VideoAsset | null;
  chunk: Chunk;
  /** Index in the source-pool list. */
  index: number;
  bars: number;
  usage: number;
  /** Optional spectral fingerprint colour (hsl). Drives the right-edge
   *  stripe so users can spot similar-sounding chunks at a glance. */
  spectralColor?: string;
  onAdd: () => void;
  onPreview: () => void;
  /** True when the chunk's mini player-loop is the active focus. */
  active?: boolean;
}

export function Polaroid({
  jobId,
  cam,
  chunk,
  index,
  bars,
  usage,
  spectralColor,
  onAdd,
  onPreview,
  active = false,
}: PolaroidProps) {
  const [visible, setVisible] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // IntersectionObserver — extract the thumbnail only after the card
  // scrolls into view, so a 30-chunk pool doesn't pre-decode 30 videos
  // on page load.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const thumb = useChunkThumbnail(jobId, cam, chunk, visible);
  const lengthS = (chunk.endMs - chunk.startMs) / 1000;
  const camColor = cam?.color ?? "#FF5722";

  // Drag-from-Polaroid → drop-on-Strip. We start the drag on
  // pointerdown but only after the user has moved past a small
  // threshold — that way a plain click still routes to the preview
  // handler instead of being eaten by the drag gesture.
  const beginChunkDrag = useArrangeStore((s) => s.beginChunkDrag);
  const isDragSource = useArrangeStore(
    (s) => s.drag?.chunkId === chunk.id,
  );
  const dragArmedRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  // Tracks whether the most recent pointer-gesture moved past the drag
  // threshold. We use this to swallow the click event that the
  // browser fires after pointerup, so the preview-loop handler doesn't
  // fire when the user actually meant to drag.
  const draggedRef = useRef(false);
  const DRAG_THRESHOLD_PX = 5;

  function onPointerDownDragArm(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    // Don't arm on the +ADD button — let it click normally.
    const target = e.target as HTMLElement;
    if (target.closest("[data-no-drag]")) return;
    dragArmedRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };
    draggedRef.current = false;
  }
  function onPointerMoveDragArm(e: React.PointerEvent) {
    const armed = dragArmedRef.current;
    if (!armed || armed.pointerId !== e.pointerId) return;
    const dx = e.clientX - armed.startX;
    const dy = e.clientY - armed.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    dragArmedRef.current = null;
    draggedRef.current = true;
    beginChunkDrag({
      chunkId: chunk.id,
      thumbUrl: thumb.url,
      camColor,
      cursorX: e.clientX,
      cursorY: e.clientY,
    });
  }
  function onPointerUpDragArm() {
    dragArmedRef.current = null;
  }
  function onClickGuarded() {
    if (draggedRef.current) {
      // The pointer-gesture became a drag — don't preview.
      draggedRef.current = false;
      return;
    }
    onPreview();
  }

  return (
    <motion.div
      ref={wrapperRef}
      whileHover={{ y: -3, rotate: -0.5 }}
      transition={{ duration: 0.15 }}
      className={`relative shrink-0 w-[124px] select-none rounded-md border border-rule/70 bg-paper-hi shadow-emboss ${active ? "ring-2 ring-cobalt ring-offset-1 ring-offset-paper" : ""} ${isDragSource ? "opacity-40" : ""}`}
      style={{
        // Polaroid stock = warm off-white with subtle paper texture
        background:
          "linear-gradient(180deg, #FBF7EE 0%, #F2EDE2 100%)",
        // Touch action: prevent native scroll on the polaroid so a
        // touch-drag can hand off to the chunk-drag controller.
        touchAction: "none",
      }}
      onClick={onClickGuarded}
      onPointerDown={onPointerDownDragArm}
      onPointerMove={onPointerMoveDragArm}
      onPointerUp={onPointerUpDragArm}
      onPointerCancel={onPointerUpDragArm}
      role="button"
      aria-label={`Chunk ${index + 1}, ${bars.toFixed(1)} bars`}
    >
      {/* Image well — slight inset, dark "frame" so the develop-in
       *  filter has somewhere to fade up from. */}
      <div
        className="relative mx-2 mt-2 overflow-hidden rounded-sm bg-sunken"
        style={{ aspectRatio: "16 / 9" }}
      >
        {thumb.url ? (
          <img
            src={thumb.url}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              filter: thumb.isDeveloping
                ? "saturate(0) brightness(0.45) contrast(0.7) sepia(0.4)"
                : "none",
              transition: "filter 800ms ease-out",
            }}
          />
        ) : (
          <PolaroidEmpty failed={thumb.failed} camColor={camColor} />
        )}
        {/* Spectral fingerprint stripe — 3px on the right edge of the
         *  image well, fading at top + bottom so it doesn't slam into
         *  the corners. Reads as part of the photograph rather than a
         *  bolt-on label. */}
        {spectralColor && (
          <span
            aria-hidden
            className="absolute right-0 top-0 bottom-0 w-[3px] pointer-events-none"
            style={{
              background: spectralColor,
              maskImage:
                "linear-gradient(180deg, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(180deg, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%)",
            }}
          />
        )}
      </div>

      {/* Label strip — chunk meta + add affordance */}
      <div className="px-2 pb-2 pt-1.5">
        <div className="flex items-baseline justify-between gap-1">
          <span className="font-display text-[10px] font-semibold tracking-label uppercase text-ink">
            #{(index + 1).toString().padStart(2, "0")}
          </span>
          <span className="font-mono text-[9px] tabular text-ink-3">
            {bars.toFixed(bars >= 10 ? 0 : 1)}br · {formatTime(lengthS)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1.5">
          <UsageDots count={usage} />
          <button
            type="button"
            data-no-drag
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center rounded border border-hot/60 bg-hot text-paper-hi font-display font-semibold text-[9px] tracking-label uppercase shadow-emboss transition-colors hover:bg-hot-pressed"
            style={{ height: 20, paddingInline: 6 }}
            title="Insert into film strip at cursor"
            aria-label="Insert chunk into arrangement"
          >
            + add
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function PolaroidEmpty({
  failed,
  camColor,
}: {
  failed: boolean;
  camColor: string;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center">
      {failed ? (
        <span
          className="font-mono text-[9px] tracking-label uppercase text-paper-hi/70"
          title="Frame extraction failed — could be a codec quirk or a chunk outside the cam's recorded range. The chunk is still usable; only the preview is missing."
        >
          no preview
        </span>
      ) : (
        <DevelopingIndicator color={camColor} />
      )}
    </div>
  );
}

function DevelopingIndicator({ color }: { color: string }) {
  // Subtle pulsing dots — "the photo is still developing in the dark"
  return (
    <span aria-label="developing" className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1 w-1 rounded-full"
          style={{ background: color }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.2,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  );
}

function UsageDots({ count }: { count: number }) {
  if (count <= 0) {
    return (
      <span className="font-mono text-[9px] tabular tracking-label uppercase text-ink-3">
        unused
      </span>
    );
  }
  // Cap visual dots at 3, then add ×N
  const dots = Math.min(count, 3);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`Used ${count} time${count === 1 ? "" : "s"}`}
    >
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          className="block h-1.5 w-1.5 rounded-full bg-hot"
          aria-hidden
        />
      ))}
      {count > 3 && (
        <span className="ml-0.5 font-mono text-[9px] tabular text-ink-2">
          ×{count}
        </span>
      )}
    </span>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
