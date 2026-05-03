/**
 * Vertical scrollable list of chunks. Primary mobile interaction
 * surface; on desktop it's auxiliary to the timeline.
 *
 * Each row: chunk index, time-range, length, BPM, accept-state. Tap
 * to focus (also scrolls + starts loop). Inline keep/drop buttons.
 */
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useTriageStore } from "../../local/triage/triage-store";
import type { Chunk } from "../../storage/jobs-db";

export function ChunksList() {
  const chunks = useTriageStore((s) => s.chunks);
  const focusedId = useTriageStore((s) => s.focusedChunkId);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const updateChunk = useTriageStore((s) => s.updateChunk);

  const sorted = [...chunks].sort((a, b) => a.startMs - b.startMs);

  if (sorted.length === 0) {
    return (
      <div className="rounded-md border border-rule bg-paper-hi p-6 text-center font-mono text-[11px] tracking-label uppercase text-ink-3">
        ◇ no chunks detected — adjust threshold or min-pause
      </div>
    );
  }

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Chunks · {sorted.length}
        </span>
      </header>
      <ul className="max-h-[60vh] overflow-y-auto">
        {sorted.map((chunk, i) => (
          <ChunkRow
            key={chunk.id}
            chunk={chunk}
            index={i}
            focused={chunk.id === focusedId}
            onFocus={() => focusChunk(chunk.id)}
            onAccept={() => updateChunk(chunk.id, { accepted: true })}
            onReject={() => updateChunk(chunk.id, { accepted: false })}
          />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  chunk: Chunk;
  index: number;
  focused: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function ChunkRow({ chunk, index, focused, onFocus, onAccept, onReject }: RowProps) {
  const lengthS = (chunk.endMs - chunk.startMs) / 1000;
  const effectiveBpm = chunk.detectedBpm
    ? chunk.detectedBpm * Math.pow(2, chunk.bpmOctaveShift)
    : null;

  // Solid colors per state — no opacity tricks. Background tints the
  // entire row so accept/reject is unmissable scanning the list.
  const rowBg = chunk.accepted
    ? focused
      ? "bg-hot/15"
      : "bg-paper-hi"
    : focused
      ? "bg-paper-deep"
      : "bg-paper-deep";
  const stateStripe = chunk.accepted ? "#FF5722" : "#5D5546";

  return (
    <li
      className={`relative grid grid-cols-[6px_1fr_auto] items-center gap-3 border-b border-rule/60 px-3 py-2.5 cursor-pointer transition-colors ${rowBg} ${
        focused ? "outline outline-2 outline-cobalt outline-offset-[-2px] z-10" : "hover:bg-paper-deep"
      } min-h-[60px]`}
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
      {/* State stripe — full color, no transparency */}
      <span
        className="self-stretch w-1.5 rounded-sm"
        style={{ background: stateStripe }}
        aria-hidden
      />

      {/* Body */}
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="font-display font-semibold text-xs tracking-label uppercase text-ink shrink-0">
            #{(index + 1).toString().padStart(2, "0")}
          </span>
          <span className="font-mono tabular text-xs text-ink truncate">
            {formatTime(chunk.startMs / 1000)} → {formatTime(chunk.endMs / 1000)}
          </span>
          {!chunk.accepted && (
            <span
              className="font-mono text-[9px] tracking-label uppercase text-paper-hi bg-ink-2 px-1 rounded shrink-0"
              aria-label="Dropped"
            >
              DROPPED
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] tabular text-ink-3">
          <span>{lengthS.toFixed(1)}s</span>
          {effectiveBpm && (
            <>
              <span>·</span>
              <span>
                {effectiveBpm.toFixed(0)} BPM
                {chunk.bpmOctaveShift !== 0 && (
                  <span className="ml-0.5 text-ink-3">
                    ({chunk.bpmOctaveShift > 0 ? "×" : "÷"}2)
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Inline accept/reject — visible always so the user doesn't
       *  have to focus first to act. */}
      <div className="flex gap-1.5 shrink-0">
        {chunk.accepted ? (
          <ChunkyButton
            variant="secondary"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
            title="Drop"
            aria-label="Drop chunk"
          >
            Drop
          </ChunkyButton>
        ) : (
          <ChunkyButton
            variant="primary"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
            title="Keep"
            aria-label="Keep chunk"
          >
            Keep
          </ChunkyButton>
        )}
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
