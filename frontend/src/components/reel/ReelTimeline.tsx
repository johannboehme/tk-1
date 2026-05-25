/**
 * Full-width reel timeline (bottom bar): transport + a proportional strip of
 * all members with a playhead that scrubs/plays the WHOLE reel. Click or drag
 * anywhere on the strip to seek; member blocks are sized by their runtime
 * share and tinted with their thumbnail so the cut reads at a glance.
 */
import { useRef } from "react";
import { reelLayout } from "./ReelPlayer";
import type { ReelMember } from "../../local/reel/reel-store";
import { formatDuration } from "../ProgressBar";

export function ReelTimeline({
  members,
  playheadS,
  playing,
  muted,
  selectedMemberId,
  onSeek,
  onTogglePlay,
  onToggleMute,
  onSelectMember,
}: {
  members: ReelMember[];
  playheadS: number;
  playing: boolean;
  muted: boolean;
  selectedMemberId: string | null;
  onSeek: (s: number) => void;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onSelectMember: (memberId: string) => void;
}) {
  const layouts = reelLayout(members);
  const total = layouts.reduce((a, l) => a + l.dur, 0) || 0.001;
  const stripRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seekToX = (clientX: number) => {
    const el = stripRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (clientX - r.left) / r.width;
    onSeek(Math.max(0, Math.min(1, x)) * total);
  };

  const pct = Math.max(0, Math.min(1, playheadS / total));

  return (
    <div className="flex items-center gap-3 px-3 sm:px-5 h-20 border-t border-rule bg-paper-hi">
      <button
        type="button"
        onClick={onTogglePlay}
        disabled={members.length === 0}
        aria-label={playing ? "Pause" : "Play"}
        className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-full bg-ink text-paper-hi hover:bg-hot disabled:opacity-30 transition-colors"
      >
        {playing ? (
          <span className="flex gap-[3px]">
            <span className="w-[3px] h-3.5 bg-current" />
            <span className="w-[3px] h-3.5 bg-current" />
          </span>
        ) : (
          <span
            className="ml-0.5"
            style={{
              width: 0,
              height: 0,
              borderTop: "7px solid transparent",
              borderBottom: "7px solid transparent",
              borderLeft: "11px solid currentColor",
            }}
          />
        )}
      </button>

      <div className="shrink-0 font-mono text-[11px] tabular text-ink-2 w-[92px] text-center">
        {formatDuration(playheadS)} / {formatDuration(total)}
      </div>

      <button
        type="button"
        onClick={onToggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        className="h-7 px-2 shrink-0 rounded-md font-mono text-[10px] tracking-label uppercase text-ink-2 hover:text-ink border border-rule"
      >
        {muted ? "MUTED" : "SOUND"}
      </button>

      {/* Proportional strip + playhead */}
      <div
        ref={stripRef}
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
            /* released */
          }
        }}
        className="relative flex-1 h-12 rounded-md overflow-hidden bg-sunken border border-rule cursor-ew-resize select-none touch-none flex"
      >
        {layouts.map((l) => {
          const w = (l.dur / total) * 100;
          const sel = l.member.memberId === selectedMemberId;
          return (
            <div
              key={l.member.memberId}
              onClick={(e) => {
                e.stopPropagation();
                onSelectMember(l.member.memberId);
              }}
              style={{
                width: `${w}%`,
                backgroundImage: l.member.posterUrl
                  ? `url(${l.member.posterUrl})`
                  : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
              className={[
                "relative h-full border-r border-black/30 last:border-r-0 overflow-hidden",
                sel ? "ring-1 ring-inset ring-hot" : "",
              ].join(" ")}
            >
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-black/10" />
              <span className="absolute bottom-0.5 left-1 right-1 font-display text-[10px] text-paper-hi truncate">
                {l.member.title}
              </span>
            </div>
          );
        })}
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-hot pointer-events-none"
          style={{ left: `${pct * 100}%` }}
        />
        <div
          className="absolute top-0 h-2.5 w-2.5 bg-hot rounded-full -translate-x-1/2 pointer-events-none"
          style={{ left: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}
