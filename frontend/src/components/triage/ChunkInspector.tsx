/**
 * Selected-chunk inspector.
 *
 * Header carries BOTH the section title (with current chunk index) AND
 * the song-global BpmReadoutView brass plate — so the user always sees
 * + can override the global tempo right where they read the chunk's
 * derived bar count. The brass plate is the canonical edit surface for
 * BPM and time-signature; clicking the LCD opens an in-line editor with
 * ÷2 / ×2 keys for fast octave correction.
 *
 * Body shows per-chunk fields (start/end/length/bars, anchor, effective
 * tempo) plus a per-chunk octave override and the trim-by-bar buttons.
 * Body scrolls if it overflows.
 *
 * No Keep/Drop buttons — the TransportBar is the sole accept/reject
 * surface (Enter/Backspace).
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
  const extendChunkBars = useTriageStore((s) => s.extendChunkBars);
  const sortedIdx =
    focusedId !== null
      ? [...chunks].sort((a, b) => a.startMs - b.startMs).findIndex((c) => c.id === focusedId)
      : -1;
  const focused = focusedId ? chunks.find((c) => c.id === focusedId) ?? null : null;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel h-full flex flex-col min-h-0">
      <header className="flex-none bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
            Selected
          </span>
          {focused && (
            <span className="font-mono text-[10px] tabular text-ink-3">
              {sortedIdx + 1} / {chunks.length}
            </span>
          )}
        </div>
        <div className="flex-1" />
        <BpmReadoutView
          bpm={jobBpm}
          detectedBpm={detectedBpm}
          beatsPerBar={beatsPerBar}
          onBpm={setJobBpm}
          onResetBpm={resetBpm}
          onBeatsPerBar={setBeatsPerBar}
        />
      </header>

      {!focused ? (
        <div className="flex-1 grid place-items-center p-4 text-center font-mono text-[11px] tracking-label uppercase text-ink-3">
          ◇ no chunk selected
        </div>
      ) : (
        <ChunkBody
          chunk={focused}
          jobBpmValue={jobBpm?.value ?? null}
          beatsPerBar={beatsPerBar}
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
  onExtend: (barsBack: number, barsFwd: number) => void;
}

function ChunkBody({ chunk, jobBpmValue, beatsPerBar, onExtend }: BodyProps) {
  const lengthMs = chunk.endMs - chunk.startMs;
  const lengthS = lengthMs / 1000;
  const effBpm = effectiveChunkBpm(chunk, jobBpmValue);
  const bars = effBpm > 0 ? (lengthS * effBpm) / 60 / beatsPerBar : 0;
  const canExtend = effBpm > 0;
  const phaseS = chunkBeatPhaseS(chunk);
  const phaseDeltaMs = phaseS * 1000 - chunk.startMs;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <KV label="In" value={formatTime(chunk.startMs / 1000)} />
        <KV label="Out" value={formatTime(chunk.endMs / 1000)} />
        <KV label="Length" value={`${lengthS.toFixed(1)}s`} />
        <KV label="Bars" value={bars > 0 ? `≈ ${bars.toFixed(1)}` : "—"} />
        <KV
          label="Anchor"
          value={phaseDeltaMs > 1 ? `+${phaseDeltaMs.toFixed(0)}ms` : "at start"}
        />
        <KV
          label="Tempo"
          value={
            effBpm > 0
              ? `${effBpm.toFixed(0)}${chunk.bpmOctaveShift !== 0 ? ` (${chunk.bpmOctaveShift > 0 ? "×" : "÷"}2)` : ""}`
              : "—"
          }
        />
      </div>

      {/* Bar extend / shrink — 2×2 grid of trim arrows. */}
      <div className="border-t border-rule pt-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="font-display tracking-label uppercase text-[9px] text-ink-3">
            TRIM BY BAR
          </span>
          <span className="font-mono text-[9px] tabular text-ink-3">
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
