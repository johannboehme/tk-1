/**
 * Selected-chunk inspector. Shows a compact LCD-strip with the chunk's
 * time-range, bar count + length, plus per-chunk BPM controls.
 *
 * BPM widgets:
 *   - The brass-plate BpmReadoutView at the top displays the
 *     song-global tempo and time-signature (mode of per-chunk
 *     detections). Click to override for the whole song.
 *   - Below the plate, three half/×1/double buttons override THIS
 *     chunk's tempo only (octave shift on the per-chunk detection) —
 *     useful when the auto-detector landed on the wrong octave for one
 *     fragment. Bar count + length recompute live.
 *
 * No Keep/Drop buttons — the TransportBar is the sole accept/reject
 * surface (shortcut Enter/Backspace) so users don't end up with three
 * places that all toggle the same flag.
 */
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { BpmReadoutView } from "../../editor/components/BpmReadoutView";
import {
  chunkBeatPhaseS,
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";
import type { Chunk } from "../../storage/jobs-db";

export function ChunkInspector() {
  const focusedId = useTriageStore((s) => s.focusedChunkId);
  const chunks = useTriageStore((s) => s.chunks);
  const jobBpm = useTriageStore((s) => s.jobBpm);
  const detectedBpm = useTriageStore((s) => s.detectedBpm);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const setJobBpm = useTriageStore((s) => s.setJobBpm);
  const resetBpm = useTriageStore((s) => s.resetBpmToDetected);
  const setBeatsPerBar = useTriageStore((s) => s.setBeatsPerBar);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  const extendChunkBars = useTriageStore((s) => s.extendChunkBars);
  const sortedIdx =
    focusedId !== null
      ? [...chunks].sort((a, b) => a.startMs - b.startMs).findIndex((c) => c.id === focusedId)
      : -1;
  const focused = focusedId ? chunks.find((c) => c.id === focusedId) ?? null : null;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Tempo + Selected
        </span>
        {focused && (
          <span className="font-mono text-[10px] tabular text-ink-3">
            {sortedIdx + 1} / {chunks.length}
          </span>
        )}
      </header>

      {/* Song-global BPM + time-signature plate. Always visible — even
       *  before a chunk is focused, the user might want to set the
       *  tempo manually. */}
      <div className="px-3 pt-3 pb-2 flex justify-center bg-paper-deep border-b border-rule">
        <BpmReadoutView
          bpm={jobBpm}
          detectedBpm={detectedBpm}
          beatsPerBar={beatsPerBar}
          onBpm={setJobBpm}
          onResetBpm={resetBpm}
          onBeatsPerBar={setBeatsPerBar}
        />
      </div>

      {!focused ? (
        <div className="p-4 text-center font-mono text-[11px] tracking-label uppercase text-ink-3">
          ◇ no chunk selected
        </div>
      ) : (
        <ChunkBody
          chunk={focused}
          jobBpmValue={jobBpm?.value ?? null}
          beatsPerBar={beatsPerBar}
          onUpdate={(patch) => updateChunk(focused.id, patch)}
          onExtend={(back, fwd) => extendChunkBars(focused.id, back, fwd)}
        />
      )}
    </section>
  );
}

interface BodyProps {
  chunk: Chunk;
  jobBpmValue: number | null;
  beatsPerBar: number;
  onUpdate: (patch: Partial<Chunk>) => void;
  onExtend: (barsBack: number, barsFwd: number) => void;
}

function ChunkBody({ chunk, jobBpmValue, beatsPerBar, onUpdate, onExtend }: BodyProps) {
  const lengthMs = chunk.endMs - chunk.startMs;
  const lengthS = lengthMs / 1000;
  const effBpm = effectiveChunkBpm(chunk, jobBpmValue);
  const bars = effBpm > 0 ? (lengthS * effBpm) / 60 / beatsPerBar : 0;
  const canExtend = effBpm > 0;
  const phaseS = chunkBeatPhaseS(chunk);
  const phaseDeltaMs = phaseS * 1000 - chunk.startMs;
  const usingChunkOctave = chunk.detectedBpm !== undefined && chunk.detectedBpm > 0;

  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <KV label="In" value={formatTime(chunk.startMs / 1000)} />
        <KV label="Out" value={formatTime(chunk.endMs / 1000)} />
        <KV label="Length" value={`${lengthS.toFixed(1)}s`} />
        <KV label="Bars" value={bars > 0 ? `≈ ${bars.toFixed(1)}` : "—"} />
        <KV
          label="Anchor"
          value={
            phaseDeltaMs > 1
              ? `+${phaseDeltaMs.toFixed(0)}ms`
              : "at start"
          }
        />
        <KV
          label="Tempo"
          value={
            effBpm > 0
              ? `${effBpm.toFixed(0)} BPM${chunk.bpmOctaveShift !== 0 ? ` (${chunk.bpmOctaveShift > 0 ? "×" : "÷"}2)` : ""}`
              : "—"
          }
        />
      </div>

      {/* Per-chunk octave-shift — useful when the per-chunk detector
       *  picked the wrong octave on one chunk. Only meaningful when
       *  the chunk has its own detection; otherwise it'd just be
       *  multiplying the global BPM, which the user can do at the
       *  brass plate up top. */}
      <div className="border-t border-rule pt-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
            Per-chunk octave
          </span>
          <span className="font-mono text-[10px] tabular text-ink-3">
            {usingChunkOctave ? "from per-chunk detection" : "no chunk detection"}
          </span>
        </div>
        <div className="flex gap-1.5">
          <ChunkyButton
            variant={chunk.bpmOctaveShift === -1 ? "primary" : "secondary"}
            size="xs"
            disabled={!usingChunkOctave}
            onClick={() =>
              onUpdate({
                bpmOctaveShift: chunk.bpmOctaveShift === -1 ? 0 : -1,
              })
            }
          >
            ÷2
          </ChunkyButton>
          <ChunkyButton
            variant={chunk.bpmOctaveShift === 0 ? "primary" : "secondary"}
            size="xs"
            disabled={!usingChunkOctave}
            onClick={() => onUpdate({ bpmOctaveShift: 0 })}
          >
            ×1
          </ChunkyButton>
          <ChunkyButton
            variant={chunk.bpmOctaveShift === 1 ? "primary" : "secondary"}
            size="xs"
            disabled={!usingChunkOctave}
            onClick={() =>
              onUpdate({
                bpmOctaveShift: chunk.bpmOctaveShift === 1 ? 0 : 1,
              })
            }
          >
            ×2
          </ChunkyButton>
        </div>
      </div>

      {/* Bar extend / shrink. */}
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
