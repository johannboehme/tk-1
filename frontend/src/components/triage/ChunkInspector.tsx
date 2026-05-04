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
 * Body:
 *   1. KV grid — start/end/length/bars/anchor stats
 *   2. TRIM BY BAR — 2×2 grid extending each edge by one song-bar
 *   3. EDIT — Split at playhead, Join prev / next, Reset boundaries.
 *      All four are also bound to global shortcuts in the TransportBar.
 *
 * In the no-selection state the inspector becomes a small entry point
 * for "create a chunk in silence at the playhead" — TE-fans expect
 * that level of manual override and the surrounding chrome is the
 * natural place to host the trigger.
 *
 * No Keep/Drop buttons — the TransportBar is the sole accept/reject
 * surface (Enter/Backspace).
 */
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { BpmReadoutView } from "../../editor/components/BpmReadoutView";
import {
  JoinNextIcon,
  JoinPrevIcon,
  PlusIcon,
  RotateCwIcon,
  ScissorsIcon,
} from "../../editor/components/icons";
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
  const splitChunkAt = useTriageStore((s) => s.splitChunkAt);
  const joinChunks = useTriageStore((s) => s.joinChunks);
  const resetChunk = useTriageStore((s) => s.resetChunk);
  const insertChunkAtPlayhead = useTriageStore((s) => s.insertChunkAtPlayhead);
  // Subscribe to currentTime so canSplit stays live as the playhead
  // moves — without this the Split button would only refresh when
  // some other store-state change triggers a render.
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  const sortedIdx =
    focusedId !== null
      ? [...chunks].sort((a, b) => a.startMs - b.startMs).findIndex((c) => c.id === focusedId)
      : -1;
  const focused = focusedId ? chunks.find((c) => c.id === focusedId) ?? null : null;

  const sortedById = [...chunks].sort((a, b) => a.startMs - b.startMs);
  const focusedSortedIdx = sortedIdx;
  const hasPrev = focused != null && focusedSortedIdx > 0;
  const hasNext =
    focused != null && focusedSortedIdx >= 0 && focusedSortedIdx < sortedById.length - 1;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel h-full flex flex-col min-h-0">
      <header
        className="flex-none border-b border-rule px-3 py-2 flex items-center gap-3"
        style={{
          background:
            "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 60%, #DDD4BE 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.10)",
        }}
      >
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
        <NoSelection onInsert={() => insertChunkAtPlayhead()} />
      ) : (
        <ChunkBody
          chunk={focused}
          jobBpmValue={jobBpm?.value ?? null}
          beatsPerBar={beatsPerBar}
          onExtend={(back, fwd) => extendChunkBars(focused.id, back, fwd)}
          onSplit={() => splitChunkAt(focused.id, Math.round(currentTime * 1000))}
          onJoinPrev={() => joinChunks(focused.id, "prev")}
          onJoinNext={() => joinChunks(focused.id, "next")}
          onReset={() => resetChunk(focused.id)}
          canSplit={canSplitAtPlayhead(focused, currentTime)}
          canJoinPrev={hasPrev}
          canJoinNext={hasNext}
          canReset={canReset(focused)}
        />
      )}
    </section>
  );
}

function canSplitAtPlayhead(chunk: Chunk, currentTime: number): boolean {
  const t = currentTime * 1000;
  return t > chunk.startMs + 50 && t < chunk.endMs - 50;
}

function canReset(chunk: Chunk): boolean {
  if (chunk.originalStartMs == null || chunk.originalEndMs == null) return false;
  const startDelta = Math.abs(chunk.startMs - chunk.originalStartMs);
  const endDelta = Math.abs(chunk.endMs - chunk.originalEndMs);
  return startDelta > 1 || endDelta > 1;
}

function NoSelection({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4 text-center">
      <span className="font-mono text-[10px] tracking-label uppercase text-ink-3">
        ◇ no chunk selected
      </span>
      <ChunkyButton
        variant="secondary"
        size="sm"
        onClick={onInsert}
        title="Insert a new chunk at the playhead · N"
        iconLeft={<PlusIcon className="w-4 h-4" />}
      >
        New chunk here
      </ChunkyButton>
      <span className="font-mono text-[9px] tracking-label uppercase text-ink-3 max-w-[18ch] leading-snug">
        creates a one-bar chunk in the current silence gap
      </span>
    </div>
  );
}

interface BodyProps {
  chunk: Chunk;
  jobBpmValue: number | null;
  beatsPerBar: number;
  onExtend: (barsBack: number, barsFwd: number) => void;
  onSplit: () => void;
  onJoinPrev: () => void;
  onJoinNext: () => void;
  onReset: () => void;
  canSplit: boolean;
  canJoinPrev: boolean;
  canJoinNext: boolean;
  canReset: boolean;
}

function ChunkBody({
  chunk,
  jobBpmValue,
  beatsPerBar,
  onExtend,
  onSplit,
  onJoinPrev,
  onJoinNext,
  onReset,
  canSplit,
  canJoinPrev,
  canJoinNext,
  canReset,
}: BodyProps) {
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
      </div>

      {/* Bar extend / shrink — 2×2 grid of trim arrows. */}
      <Section
        title="TRIM BY BAR"
        right={canExtend ? "snap = bar" : "needs BPM"}
      >
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
      </Section>

      <Section
        title="EDIT"
        right={canSplit ? "playhead inside" : "playhead outside"}
      >
        <div className="flex flex-col gap-1.5">
          <ChunkyButton
            variant="secondary"
            size="xs"
            disabled={!canSplit}
            onClick={onSplit}
            title="Split at playhead · S"
            iconLeft={<ScissorsIcon className="w-3.5 h-3.5" />}
          >
            Split here
          </ChunkyButton>
          <div className="grid grid-cols-2 gap-1">
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canJoinPrev}
              onClick={onJoinPrev}
              title="Merge with previous chunk · J"
              iconLeft={<JoinPrevIcon className="w-3.5 h-3.5" />}
            >
              Join prev
            </ChunkyButton>
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canJoinNext}
              onClick={onJoinNext}
              title="Merge with next chunk · Shift+J"
              iconRight={<JoinNextIcon className="w-3.5 h-3.5" />}
            >
              Join next
            </ChunkyButton>
          </div>
          <ChunkyButton
            variant="secondary"
            size="xs"
            disabled={!canReset}
            onClick={onReset}
            title="Restore boundaries to last detection result"
            iconLeft={<RotateCwIcon className="w-3.5 h-3.5" />}
          >
            Reset
          </ChunkyButton>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-rule pt-2">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-display tracking-label uppercase text-[9px] text-ink-3">
          {title}
        </span>
        {right && (
          <span className="font-mono text-[9px] tabular text-ink-3">{right}</span>
        )}
      </div>
      {children}
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
