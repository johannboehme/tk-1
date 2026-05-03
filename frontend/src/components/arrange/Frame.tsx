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

  return (
    <button
      ref={wrapperRef}
      type="button"
      onClick={onFocus}
      onContextMenu={onContextMenu}
      className="relative block shrink-0 select-none"
      style={{
        width,
        height,
        background:
          "linear-gradient(180deg, #1A1816 0%, #0F0E0C 50%, #1A1816 100%)",
        outline: focused ? "2px solid #2F6FED" : undefined,
        outlineOffset: focused ? -2 : undefined,
        zIndex: focused ? 5 : isCurrentItem ? 4 : 1,
      }}
      title={`#${index + 1} · chunk ${chunk.id} · ${bars.toFixed(1)} bars · ${lengthS.toFixed(2)}s`}
    >
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

      {/* Bottom label band: chunk index + bar count. The cam-color
       *  hairline separates the band from the image, making the cam
       *  identity readable at a glance. */}
      <div
        className="absolute inset-x-0 bottom-0 px-1.5 flex items-center justify-between"
        style={{
          height: 12,
          background: "rgba(0,0,0,0.55)",
          borderTop: `2px solid ${camColor}`,
        }}
      >
        <span className="font-display text-[8.5px] font-semibold tracking-label uppercase text-paper-hi/95 leading-none">
          #{(index + 1).toString().padStart(2, "0")}
        </span>
        <span className="font-mono text-[8.5px] tabular text-paper-hi/75 leading-none">
          {bars.toFixed(bars >= 10 ? 0 : 1)}br
        </span>
      </div>

      {/* When this frame is the one currently playing, glow its top
       *  edge with the cam's color — that's the on-air tell. */}
      {isCurrentItem && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[2px]"
          style={{
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
