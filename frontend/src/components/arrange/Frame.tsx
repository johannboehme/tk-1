/**
 * Frame — a single arrangement item rendered as a film-strip frame.
 *
 * Visually a 35mm-film frame: black gutter top + bottom (where the
 * sprocket holes live in the parent strip), the chunk's mid-frame
 * thumbnail in the middle, and a label band at the very bottom with
 * chunk index + bar count.
 *
 * Cam-color stripe inside the bottom edge — small but unmistakable so
 * the user can scan a long strip and read which cam dominates each
 * region.
 */
import { useEffect, useRef, useState } from "react";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";
import { useChunkThumbnail } from "./useChunkThumbnail";

interface FrameProps {
  jobId: string | null;
  cam: VideoAsset | null;
  chunk: Chunk;
  index: number;
  bars: number;
  width: number;
  height: number;
  focused: boolean;
  isCurrentItem: boolean;
  /** Optional spectral fingerprint colour (hsl) for the mini-dot in
   *  the label band. Falls back to neutral grey when unknown. */
  spectralColor?: string;
  onFocus: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function Frame({
  jobId,
  cam,
  chunk,
  index,
  bars,
  width,
  height,
  focused,
  isCurrentItem,
  spectralColor,
  onFocus,
  onContextMenu,
}: FrameProps) {
  const wrapperRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);

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
      { rootMargin: "150px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const thumb = useChunkThumbnail(jobId, cam, chunk, visible);
  const camColor = cam?.color ?? "#FF5722";
  const lengthS = (chunk.endMs - chunk.startMs) / 1000;

  // Tile-count shown in the image area: wider frames carry more
  // copies of the thumbnail, faking the "multiple still frames in a
  // long strip-region" feel without actually decoding more frames.
  const tileCount = width >= 170 ? 3 : width >= 130 ? 2 : 1;

  // Skeuomorphic selection tell: layered box-shadow chain reads as a
  // brass clamp gripping the cell — outer hot ring + inner brass
  // hairline + soft phosphor halo. Pulses when selected-but-not-playing
  // so selected+playing co-exist as distinct signals.
  const focusedShadow = [
    "0 0 0 2px #FF5722",
    "0 0 0 3px rgba(255,222,195,0.5) inset",
    "0 0 16px 2px rgba(255,87,34,0.45)",
  ].join(", ");

  return (
    <button
      ref={wrapperRef}
      type="button"
      onClick={onFocus}
      onContextMenu={onContextMenu}
      className={`relative block shrink-0 select-none ${
        focused && !isCurrentItem ? "animate-frame-pulse" : ""
      }`}
      style={{
        width,
        height,
        background:
          "linear-gradient(180deg, #1A1816 0%, #0F0E0C 50%, #1A1816 100%)",
        boxShadow: focused ? focusedShadow : undefined,
        zIndex: focused ? 5 : isCurrentItem ? 4 : 1,
      }}
      title={`#${index + 1} · chunk ${chunk.id} · ${bars.toFixed(1)} bars · ${lengthS.toFixed(2)}s`}
    >
      {/* Selection tooth — a small bevelled trapezoid on the top edge.
       *  Reads as a 3D pip clamping the frame, not a flat sticker. */}
      {focused && (
        <span
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            top: -5,
            left: "50%",
            transform: "translateX(-50%)",
            width: 12,
            height: 6,
            clipPath: "polygon(50% 100%, 0 0, 100% 0)",
            background:
              "linear-gradient(180deg, #FF6A2A 0%, #FF5722 60%, #C8401A 100%)",
            filter: "drop-shadow(0 -2px 5px rgba(255,87,34,0.8))",
          }}
        />
      )}
      {/* Image well — flush to the frame edges in horizontal direction
       *  (no gutter), small black bars top/bottom for the film aesthetic. */}
      <div
        className="absolute left-0 right-0 overflow-hidden"
        style={{
          top: 6,
          bottom: 14,
          display: "grid",
          gridTemplateColumns: `repeat(${tileCount}, 1fr)`,
          gap: 1,
        }}
      >
        {Array.from({ length: tileCount }).map((_, i) => (
          <div
            key={i}
            className="relative h-full overflow-hidden bg-sunken-soft"
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
              <FrameImageEmpty failed={thumb.failed} camColor={camColor} />
            )}
          </div>
        ))}
      </div>

      {/* Bottom label band: chunk index + spectral mini-dot + bar count.
       *  The cam-color hairline separates the band from the image so the
       *  cam identity stays scannable. The spectral dot is the third
       *  datum — a 6px disc whose hue encodes the chunk's audio
       *  fingerprint. Black rim + faint white halo keep it legible
       *  whatever its colour. */}
      <div
        className="absolute inset-x-0 bottom-0 px-1.5 flex items-center justify-between gap-1.5"
        style={{
          height: 12,
          background: "rgba(0,0,0,0.55)",
          borderTop: `2px solid ${camColor}`,
        }}
      >
        <span className="font-display text-[8.5px] font-semibold tracking-label uppercase text-paper-hi/95 leading-none">
          #{(index + 1).toString().padStart(2, "0")}
        </span>
        <span
          aria-hidden
          className="block w-[6px] h-[6px] rounded-full shrink-0"
          style={{
            background: spectralColor ?? "#666",
            boxShadow:
              "0 0 0 0.5px rgba(0,0,0,0.6), 0 0 4px rgba(255,255,255,0.06)",
          }}
        />
        <span className="font-mono text-[8.5px] tabular text-paper-hi/75 leading-none">
          {bars.toFixed(bars >= 10 ? 0 : 1)}br
        </span>
      </div>

      {/* When this frame is the one currently playing, glow its top
       *  edge with the cam's color — inset by 4px so it reads as a
       *  separate tell from the focused tooth. */}
      {isCurrentItem && (
        <span
          aria-hidden
          className="absolute top-0 h-[3px]"
          style={{
            left: 4,
            right: 4,
            background: camColor,
            boxShadow: `0 0 8px ${camColor}`,
          }}
        />
      )}
    </button>
  );
}

function FrameImageEmpty({
  failed,
  camColor,
}: {
  failed: boolean;
  camColor: string;
}) {
  if (failed) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        <span
          className="font-mono text-[7px] tracking-label uppercase text-paper-hi/40 text-center px-1"
        >
          no frame
        </span>
      </div>
    );
  }
  return (
    <div
      className="absolute inset-0"
      style={{
        background: `linear-gradient(135deg, ${camColor}25 0%, transparent 80%)`,
      }}
    />
  );
}
