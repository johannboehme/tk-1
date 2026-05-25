/**
 * Per-member frame scrubber: the member's timeline thumbnail strip
 * (`frames-{cam}.webp`) as a filmstrip with a draggable playhead. Scrubbing
 * reports a source-time the preview seeks to, so framing is judged against
 * real frames pulled from the video.
 */
import { useRef } from "react";

export function ReelScrubber({
  posterUrl,
  durationS,
  value,
  onScrub,
}: {
  posterUrl: string | null;
  durationS: number;
  value: number;
  onScrub: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dur = Math.max(0.001, durationS);
  const pct = Math.max(0, Math.min(1, value / dur));

  const seekToX = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (clientX - r.left) / r.width;
    onScrub(Math.max(0, Math.min(1, x)) * dur);
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekToX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) seekToX(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }}
      className="relative h-12 rounded-md overflow-hidden cursor-ew-resize bg-sunken border border-rule select-none touch-none"
      style={
        posterUrl
          ? { backgroundImage: `url(${posterUrl})`, backgroundSize: "100% 100%" }
          : undefined
      }
    >
      {/* sprocket tint so it reads as a filmstrip even without thumbnails */}
      {!posterUrl && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] tracking-label uppercase text-ink-3">
          no thumbnails
        </div>
      )}
      <div
        className="absolute top-0 bottom-0 w-[2px] bg-hot pointer-events-none"
        style={{ left: `${pct * 100}%` }}
      />
      <div
        className="absolute top-0 h-2.5 w-2.5 bg-hot rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
        style={{ left: `${pct * 100}%`, top: 0 }}
      />
      <span className="absolute right-1 bottom-1 font-mono text-[10px] tabular text-paper-hi bg-black/45 px-1 rounded pointer-events-none">
        {value.toFixed(1)}s
      </span>
    </div>
  );
}
