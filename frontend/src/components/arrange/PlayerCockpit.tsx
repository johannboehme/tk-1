/**
 * PlayerCockpit — the dashboard above the Film Strip.
 *
 * Contains the cam-preview viewfinder on the left and an LCD display
 * on the right. The LCD reports total time, total bars, current item
 * index, and a small REC-style indicator when playback is running.
 *
 * Mobile collapses to a single row: tiny preview + slimmer LCD.
 */
import { useMemo } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { CamPreviewArrange } from "./CamPreviewArrange";

/** PlayerCockpit is fully responsive — no `compact` prop. The cam
 *  preview shrinks via internal Tailwind breakpoints, and the LCD
 *  drops the "NOW" field at narrow widths. */
export function PlayerCockpit() {
  const arrangement = useArrangeStore((s) => s.arrangement);
  const chunks = useArrangeStore((s) => s.chunks);
  // Compute totals here instead of subscribing to s.totalDurationMs() —
  // method calls inside selectors return fresh values every render and
  // wreck zustand's reference-equality short-circuit.
  const totalDurationMs = useMemo(() => {
    const lookup = new Map(chunks.map((c) => [c.id, c.endMs - c.startMs]));
    let total = 0;
    for (const item of arrangement) total += lookup.get(item.chunkId) ?? 0;
    return total;
  }, [arrangement, chunks]);
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const currentItemId = useArrangeStore((s) => s.playback.currentItemId);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const items = arrangement;
  const itemIdx = currentItemId
    ? items.findIndex((a) => a.id === currentItemId) + 1
    : 0;

  return (
    <section className="flex items-stretch gap-2 sm:gap-3">
      <CamPreviewArrange />
      <Lcd
        totalDurationMs={totalDurationMs}
        itemIdx={itemIdx}
        itemCount={items.length}
        isPlaying={isPlaying}
        jobBpm={jobBpm}
      />
    </section>
  );
}

function Lcd({
  totalDurationMs,
  itemIdx,
  itemCount,
  isPlaying,
  jobBpm,
}: {
  totalDurationMs: number;
  itemIdx: number;
  itemCount: number;
  isPlaying: boolean;
  jobBpm: number | null;
}) {
  const currentTime = useArrangeStore((s) => s.playback.currentTime);
  return (
    <div
      className="flex-1 relative rounded-md border border-rule overflow-hidden"
      style={{
        background:
          "linear-gradient(180deg, #0E0D0B 0%, #181613 50%, #0E0D0B 100%)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.6), 0 1px 4px rgba(0,0,0,0.5) inset",
      }}
    >
      {/* Subtle pixel scanline + warm orange glow */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.18) 3px, transparent 4px)",
          mixBlendMode: "multiply",
        }}
      />
      <div className="relative px-3 py-2 sm:py-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3 sm:gap-5 min-w-0 flex-wrap">
          <LcdField
            label="TOTAL"
            value={formatMs(totalDurationMs)}
            big
          />
          <span className="hidden sm:inline-flex items-baseline">
            <LcdField label="NOW" value={formatTime(currentTime)} />
          </span>
          <LcdField
            label="ITEM"
            value={itemCount === 0 ? "—" : `${itemIdx.toString().padStart(2, "0")}/${itemCount.toString().padStart(2, "0")}`}
          />
          <span className="hidden sm:inline-flex items-baseline">
            <LcdField label="BPM" value={jobBpm ? jobBpm.toFixed(0) : "—"} />
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPlaying ? (
            <span
              className="font-display text-[9px] sm:text-[10px] tracking-label uppercase font-bold flex items-center gap-1"
              style={{
                color: "#FF5722",
                textShadow:
                  "0 0 8px rgba(255,87,34,0.85), 0 0 12px rgba(255,87,34,0.45)",
              }}
            >
              <span
                aria-hidden
                className="block w-1.5 h-1.5 rounded-full animate-pulse"
                style={{
                  background: "#FF5722",
                  boxShadow: "0 0 6px rgba(255,87,34,1)",
                }}
              />
              PLAY
            </span>
          ) : (
            <span
              className="font-display text-[9px] sm:text-[10px] tracking-label uppercase text-paper-hi/40"
              style={{ textShadow: "0 0 3px rgba(255,255,255,0.1)" }}
            >
              READY
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LcdField({
  label,
  value,
  big = false,
}: {
  label: string;
  value: string;
  big?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0">
      <span
        className="font-display text-[8px] tracking-label uppercase text-paper-hi/40 leading-none"
      >
        {label}
      </span>
      <span
        className={`font-mono tabular leading-none ${big ? "text-base sm:text-lg" : "text-xs sm:text-sm"}`}
        style={{
          color: "#FF8A4F",
          textShadow:
            "0 0 8px rgba(255,87,34,0.7), 0 0 14px rgba(255,87,34,0.35)",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function formatMs(ms: number): string {
  return formatTime(ms / 1000);
}
