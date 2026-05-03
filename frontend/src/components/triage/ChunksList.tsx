/**
 * Compact chunk overview list. Read-only navigation aid — tap a row to
 * focus the chunk in the timeline. The timeline itself is the visual
 * source of truth for status; this list is for linear scanning of long
 * sessions and a glanceable accept/reject summary.
 *
 * No inline Keep/Drop buttons — actions live on the TransportBar
 * (Enter/Backspace) so the user always knows where to go.
 */
import {
  chunkPassesFilter,
  useTriageStore,
} from "../../local/triage/triage-store";
import type { Chunk } from "../../storage/jobs-db";

export function ChunksList() {
  const chunks = useTriageStore((s) => s.chunks);
  const focusedId = useTriageStore((s) => s.focusedChunkId);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const jobBpmValue = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);

  const sorted = [...chunks].sort((a, b) => a.startMs - b.startMs);
  const keptCount = sorted.filter(
    (c) =>
      c.accepted && chunkPassesFilter(c, minChunkBars, jobBpmValue, beatsPerBar),
  ).length;

  if (sorted.length === 0) {
    return (
      <section className="rounded-md border border-rule bg-paper-hi p-4 text-center font-mono text-[10px] tracking-label uppercase text-ink-3">
        ◇ no chunks — adjust threshold
      </section>
    );
  }

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel flex flex-col h-full min-h-0">
      <header className="flex-none bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Chunks · {sorted.length}
        </span>
        <span className="font-mono text-[10px] tabular text-ink-3">
          {keptCount} kept
        </span>
      </header>
      <ul className="flex-1 min-h-0 overflow-y-auto">
        {sorted.map((chunk, i) => {
          const passes = chunkPassesFilter(
            chunk,
            minChunkBars,
            jobBpmValue,
            beatsPerBar,
          );
          return (
            <ChunkRow
              key={chunk.id}
              chunk={chunk}
              index={i}
              focused={chunk.id === focusedId}
              effectivelyAccepted={chunk.accepted && passes}
              filteredOut={chunk.accepted && !passes}
              onFocus={() => focusChunk(chunk.id)}
            />
          );
        })}
      </ul>
    </section>
  );
}

interface RowProps {
  chunk: Chunk;
  index: number;
  focused: boolean;
  effectivelyAccepted: boolean;
  filteredOut: boolean;
  onFocus: () => void;
}

function ChunkRow({
  chunk,
  index,
  focused,
  effectivelyAccepted,
  filteredOut,
  onFocus,
}: RowProps) {
  const lengthS = (chunk.endMs - chunk.startMs) / 1000;
  const stateStripe = effectivelyAccepted ? "#FF5722" : "#5D5546";
  const rowBg = focused
    ? effectivelyAccepted
      ? "bg-hot/15"
      : "bg-paper-deep"
    : "bg-paper-hi hover:bg-paper-deep";

  return (
    <li
      className={`relative grid grid-cols-[4px_1fr] items-center gap-2 border-b border-rule/60 px-2 py-1.5 cursor-pointer transition-colors ${rowBg} ${
        focused ? "outline outline-2 outline-cobalt outline-offset-[-2px] z-10" : ""
      }`}
      onClick={onFocus}
      role="button"
      aria-pressed={focused}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      <span
        className="self-stretch w-1 rounded-sm"
        style={{ background: stateStripe }}
        aria-hidden
      />
      <div className="min-w-0 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-display font-semibold text-[10px] tracking-label uppercase text-ink shrink-0">
            #{(index + 1).toString().padStart(2, "0")}
          </span>
          <span className="font-mono tabular text-[10px] text-ink shrink-0">
            {formatTime(chunk.startMs / 1000)}
          </span>
          <span className="font-mono text-[10px] text-ink-3 shrink-0" aria-hidden>
            →
          </span>
          <span className="font-mono tabular text-[10px] text-ink shrink-0">
            {formatTime(chunk.endMs / 1000)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] tabular text-ink-3 shrink-0">
          <span>{lengthS.toFixed(1)}s</span>
          {!chunk.accepted && (
            <span
              className="font-mono text-[8px] tracking-label uppercase text-paper-hi bg-ink-2 px-1 rounded"
              aria-label="Dropped"
            >
              DROP
            </span>
          )}
          {filteredOut && (
            <span
              className="font-mono text-[8px] tracking-label uppercase text-paper-hi bg-ink-3 px-1 rounded"
              aria-label="Filtered out by min-bars"
              title="Below the active min-bars filter"
            >
              FILT
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
