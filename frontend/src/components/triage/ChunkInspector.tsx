/**
 * Selected-chunk inspector. Shows when a chunk is focused; displays
 * its time-range, BPM, bar-count, and accept toggle. Half-time/double-
 * time octave-shift buttons next to the BPM readout.
 *
 * Phase-3 v1: minimal but functional. Per-chunk SnapModeButtons +
 * Bar-extend (`[`/`]` equivalents) come in the next pass once the
 * core layout is stable.
 */
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import {
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";
import type { Chunk } from "../../storage/jobs-db";

export function ChunkInspector() {
  const focusedId = useTriageStore((s) => s.focusedChunkId);
  const chunks = useTriageStore((s) => s.chunks);
  const sessionBpm = useTriageStore((s) => s.sessionBpmOverride);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  const extendChunkBars = useTriageStore((s) => s.extendChunkBars);
  const acceptFocused = useTriageStore((s) => s.acceptFocused);
  const rejectFocused = useTriageStore((s) => s.rejectFocused);
  const sortedIdx =
    focusedId !== null
      ? [...chunks].sort((a, b) => a.startMs - b.startMs).findIndex((c) => c.id === focusedId)
      : -1;
  const focused = focusedId ? chunks.find((c) => c.id === focusedId) ?? null : null;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Selected chunk
        </span>
        {focused && (
          <span className="font-mono text-[10px] tabular text-ink-3">
            {sortedIdx + 1} / {chunks.length}
          </span>
        )}
      </header>

      {!focused ? (
        <div className="p-4 text-center font-mono text-[11px] tracking-label uppercase text-ink-3">
          ◇ no chunk selected
        </div>
      ) : (
        <ChunkBody
          chunk={focused}
          sessionBpm={sessionBpm}
          onAccept={() => acceptFocused(false)}
          onReject={() => rejectFocused(false)}
          onUpdate={(patch) => updateChunk(focused.id, patch)}
          onExtend={(back, fwd) => extendChunkBars(focused.id, back, fwd)}
        />
      )}
    </section>
  );
}

interface BodyProps {
  chunk: Chunk;
  sessionBpm: number | null;
  onAccept: () => void;
  onReject: () => void;
  onUpdate: (patch: Partial<Chunk>) => void;
  onExtend: (barsBack: number, barsFwd: number) => void;
}

function ChunkBody({ chunk, sessionBpm, onAccept, onReject, onUpdate, onExtend }: BodyProps) {
  const lengthMs = chunk.endMs - chunk.startMs;
  const lengthS = lengthMs / 1000;
  const effectiveBpm = effectiveChunkBpm(chunk, sessionBpm);
  const bars = effectiveBpm > 0 ? (lengthS * effectiveBpm) / 60 / chunk.beatsPerBar : 0;
  const canExtend = effectiveBpm > 0;

  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <KV label="In" value={formatTime(chunk.startMs / 1000)} />
        <KV label="Out" value={formatTime(chunk.endMs / 1000)} />
        <KV label="Length" value={`${lengthS.toFixed(1)}s`} />
        <KV label="Bars" value={bars > 0 ? `≈ ${bars.toFixed(1)}` : "—"} />
      </div>

      {/* BPM with octave shift */}
      <div className="border-t border-rule pt-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
            BPM
          </span>
          <span className="font-mono tabular text-ink">
            {chunk.detectedBpm ? effectiveBpm.toFixed(1) : "—"}
            {chunk.bpmOctaveShift !== 0 && (
              <span className="text-ink-3 ml-1">
                ({chunk.bpmOctaveShift > 0 ? "×" : "÷"}2)
              </span>
            )}
          </span>
        </div>
        {chunk.detectedBpm && (
          <div className="flex gap-1.5">
            <ChunkyButton
              variant={chunk.bpmOctaveShift === -1 ? "primary" : "secondary"}
              size="xs"
              onClick={() =>
                onUpdate({
                  bpmOctaveShift: chunk.bpmOctaveShift === -1 ? 0 : -1,
                  effectiveBpm:
                    chunk.detectedBpm! * Math.pow(2, chunk.bpmOctaveShift === -1 ? 0 : -1),
                })
              }
            >
              ÷2
            </ChunkyButton>
            <ChunkyButton
              variant={chunk.bpmOctaveShift === 0 ? "primary" : "secondary"}
              size="xs"
              onClick={() =>
                onUpdate({ bpmOctaveShift: 0, effectiveBpm: chunk.detectedBpm! })
              }
            >
              ×1
            </ChunkyButton>
            <ChunkyButton
              variant={chunk.bpmOctaveShift === 1 ? "primary" : "secondary"}
              size="xs"
              onClick={() =>
                onUpdate({
                  bpmOctaveShift: chunk.bpmOctaveShift === 1 ? 0 : 1,
                  effectiveBpm:
                    chunk.detectedBpm! * Math.pow(2, chunk.bpmOctaveShift === 1 ? 0 : 1),
                })
              }
            >
              ×2
            </ChunkyButton>
          </div>
        )}
      </div>

      {/* Bar extend / shrink — modulates chunk boundaries by one bar
       *  at the chunk's effective BPM. Disabled when no BPM info. */}
      <div className="border-t border-rule pt-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
            Trim by bar
          </span>
          <span className="font-mono text-[10px] tabular text-ink-3">
            {canExtend ? "snap = bar" : "needs BPM"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="grid grid-cols-2 gap-1">
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canExtend}
              onClick={() => onExtend(1, 0)}
              title="Extend start back by one bar"
              aria-label="Extend chunk start back"
            >
              ⟸ in
            </ChunkyButton>
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canExtend}
              onClick={() => onExtend(-1, 0)}
              title="Pull start forward by one bar"
              aria-label="Pull chunk start forward"
            >
              in ⟹
            </ChunkyButton>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canExtend}
              onClick={() => onExtend(0, -1)}
              title="Pull end back by one bar"
              aria-label="Pull chunk end back"
            >
              ⟸ out
            </ChunkyButton>
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canExtend}
              onClick={() => onExtend(0, 1)}
              title="Extend end forward by one bar"
              aria-label="Extend chunk end forward"
            >
              out ⟹
            </ChunkyButton>
          </div>
        </div>
      </div>

      {/* Accept / Reject */}
      <div className="border-t border-rule pt-2 flex gap-2">
        <ChunkyButton
          variant={chunk.accepted ? "primary" : "secondary"}
          size="sm"
          onClick={onAccept}
          fullWidth
          title="Keep this chunk · Enter"
        >
          Keep
        </ChunkyButton>
        <ChunkyButton
          variant={!chunk.accepted ? "primary" : "secondary"}
          size="sm"
          onClick={onReject}
          fullWidth
          title="Drop this chunk · Backspace"
        >
          Drop
        </ChunkyButton>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="font-display tracking-label uppercase text-[9px] text-ink-3">
        {label}
      </span>
      <span className="font-mono tabular text-ink text-right">{value}</span>
    </>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
