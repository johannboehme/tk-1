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
import { useEffect, useRef, useState } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { BpmReadoutView } from "../../editor/components/BpmReadoutView";
import type { SnapMode } from "../../editor/snap";
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
import {
  joinFocusedGuarded,
  splitFocusedGuarded,
} from "../../local/triage/triage-guarded-actions";
import type { Chunk } from "../../storage/jobs-db";

const CONFORM_STATUS_LABEL: Record<string, string> = {
  ok: "✓ conformed",
  unchanged: "already in phase",
  "no-bpm": "no global BPM yet",
  "too-short": "no audio loaded",
  "no-beats": "no beats detected",
  "no-chunk": "",
};

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
  const resetChunk = useTriageStore((s) => s.resetChunk);
  const conformChunk = useTriageStore((s) => s.conformChunk);
  const revertConform = useTriageStore((s) => s.revertConform);
  const insertChunkAtPlayhead = useTriageStore((s) => s.insertChunkAtPlayhead);
  const seamActive = useTriageStore((s) => s.playback.seam !== null);
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

  // In seam mode the detail panel is replaced by a seam-specific one —
  // the normal chunk actions (insert / split / join / reset) don't apply
  // to auditioning a transition.
  if (seamActive) return <SeamInspector />;

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
          onSplit={() => void splitFocusedGuarded(Math.round(currentTime * 1000))}
          onCreate={() => insertChunkAtPlayhead()}
          onJoinPrev={() => void joinFocusedGuarded("prev")}
          onJoinNext={() => void joinFocusedGuarded("next")}
          onReset={() => resetChunk(focused.id)}
          onConform={() => conformChunk(focused.id)}
          onRevertConform={() => revertConform(focused.id)}
          canSplit={canSplitAtPlayhead(focused, currentTime)}
          canCreate={canCreateAtPlayhead(chunks, currentTime)}
          canJoinPrev={hasPrev}
          canJoinNext={hasNext}
          canReset={canReset(focused)}
          canRevertConform={focused.preConformSnapshot != null}
        />
      )}
    </section>
  );
}

function canSplitAtPlayhead(chunk: Chunk, currentTime: number): boolean {
  const t = currentTime * 1000;
  return t > chunk.startMs + 50 && t < chunk.endMs - 50;
}

/** A new chunk can be created at the playhead when it sits in empty space
 *  — i.e. inside no existing chunk. (insertChunkAtPlayhead guards the
 *  gap-size details.) */
function canCreateAtPlayhead(chunks: Chunk[], currentTime: number): boolean {
  const t = currentTime * 1000;
  return !chunks.some((c) => t > c.startMs && t < c.endMs);
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
  onCreate: () => void;
  onJoinPrev: () => void;
  onJoinNext: () => void;
  onReset: () => void;
  onConform: () => ReturnType<ReturnType<typeof useTriageStore.getState>["conformChunk"]>;
  onRevertConform: () => void;
  canSplit: boolean;
  canCreate: boolean;
  canJoinPrev: boolean;
  canJoinNext: boolean;
  canReset: boolean;
  canRevertConform: boolean;
}

function ChunkBody({
  chunk,
  jobBpmValue,
  beatsPerBar,
  onExtend,
  onSplit,
  onCreate,
  onJoinPrev,
  onJoinNext,
  onReset,
  onConform,
  onRevertConform,
  canSplit,
  canCreate,
  canJoinPrev,
  canJoinNext,
  canReset,
  canRevertConform,
}: BodyProps) {
  const lengthMs = chunk.endMs - chunk.startMs;
  const lengthS = lengthMs / 1000;
  const effBpm = effectiveChunkBpm(chunk, jobBpmValue);
  const bars = effBpm > 0 ? (lengthS * effBpm) / 60 / beatsPerBar : 0;
  const canExtend = effBpm > 0;
  const phaseS = chunkBeatPhaseS(chunk);
  const phaseDeltaMs = phaseS * 1000 - chunk.startMs;

  // Inline status for the Conform action: shows "✓ conformed · anchor
  // +N ms" with the actual shift on success (so the user can see WHAT
  // changed, not just that something happened), or the no-op reason on
  // failure. Auto-fades after 3 s.
  //
  // The button is also disabled while the analysis runs. STFT on a
  // long chunk blocks the main thread for a few hundred ms, during
  // which the click feels "dead" — easy to think nothing happened and
  // click again. We yield via setTimeout so React paints the disabled
  // state before we kick off the synchronous work.
  const [conformStatus, setConformStatus] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [isConforming, setIsConforming] = useState(false);
  const conformTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (conformTimer.current != null) window.clearTimeout(conformTimer.current);
    },
    [],
  );
  async function handleConform() {
    if (isConforming) return;
    setIsConforming(true);
    setConformStatus(null);
    if (conformTimer.current != null) window.clearTimeout(conformTimer.current);

    const beforeAnchor = chunk.audioStartMs ?? chunk.startMs;
    const beforeStart = chunk.startMs;
    const beforeEnd = chunk.endMs;

    // Wait for the background PCM decode to finish, if it's still in
    // flight. The Triage page kicks decode off async on the cached
    // path, so a fast click after entering Triage can land here with
    // no PCM yet.
    if (
      (useTriageStore.getState().pcm?.length ?? 0) === 0 &&
      useTriageStore.getState().pcmDecoding
    ) {
      setConformStatus({ kind: "success", message: "decoding audio…" });
      const start = Date.now();
      while (
        useTriageStore.getState().pcmDecoding &&
        Date.now() - start < 30_000
      ) {
        await new Promise((r) => window.setTimeout(r, 100));
      }
    }

    // Decode finished and produced no PCM → surface the actual reason
    // (file handle stale, codec unsupported, etc.) rather than the
    // generic "no audio loaded".
    const decodeError = useTriageStore.getState().pcmDecodeError;
    if (
      (useTriageStore.getState().pcm?.length ?? 0) === 0 &&
      decodeError != null
    ) {
      setConformStatus({
        kind: "error",
        message: `decode failed · ${decodeError}`,
      });
      setIsConforming(false);
      conformTimer.current = window.setTimeout(
        () => setConformStatus(null),
        5000,
      );
      return;
    }

    // Yield once so the disabled state paints before STFT blocks.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    {
      const status = onConform();
      if (status === "unchanged") {
        setConformStatus({ kind: "success", message: "already in phase" });
      } else if (status === "ok") {
        const after = useTriageStore
          .getState()
          .chunks.find((c) => c.id === chunk.id);
        if (after) {
          const anchorDelta = Math.round(
            (after.audioStartMs ?? after.startMs) - beforeAnchor,
          );
          const startDelta = Math.round(after.startMs - beforeStart);
          const endDelta = Math.round(after.endMs - beforeEnd);
          const parts: string[] = [];
          const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
          if (anchorDelta !== 0) parts.push(`anchor ${sign(anchorDelta)} ms`);
          if (startDelta !== 0) parts.push(`in ${sign(startDelta)} ms`);
          if (endDelta !== 0) parts.push(`out ${sign(endDelta)} ms`);
          const detail = parts.length > 0 ? ` · ${parts.join(", ")}` : " · no shift";
          setConformStatus({ kind: "success", message: `✓ conformed${detail}` });
        } else {
          setConformStatus({ kind: "success", message: "✓ conformed" });
        }
      } else {
        setConformStatus({
          kind: "error",
          message: CONFORM_STATUS_LABEL[status] ?? status,
        });
      }
      setIsConforming(false);
      conformTimer.current = window.setTimeout(
        () => setConformStatus(null),
        3000,
      );
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm">
      {/* Compact stat strip — five values laid out inline so the rest
       *  of the inspector (TRIM / EDIT) has room. Wraps on narrow
       *  inspector widths instead of pushing the buttons below the
       *  fold. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10.5px] font-mono tabular leading-tight">
        <Stat label="IN" value={formatTime(chunk.startMs / 1000)} />
        <Sep />
        <Stat label="OUT" value={formatTime(chunk.endMs / 1000)} />
        <Sep />
        <Stat label="LEN" value={`${lengthS.toFixed(1)}s`} />
        <Sep />
        <Stat label="BARS" value={bars > 0 ? `~${bars.toFixed(1)}` : "—"} />
        <Sep />
        <Stat
          label="ANCH"
          value={phaseDeltaMs > 1 ? `+${phaseDeltaMs.toFixed(0)}ms` : "0"}
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
        right={
          canSplit
            ? "playhead inside"
            : canCreate
              ? "empty — new chunk"
              : "playhead outside"
        }
      >
        <div className="flex flex-col gap-1.5">
          {/* Split when the playhead is inside the focused chunk; in empty
           *  space the same button creates a fresh chunk instead (so you
           *  can carve a second part out of an audio region you already
           *  trimmed away from). Disabled only when the playhead sits
           *  inside a *different* chunk. */}
          {canSplit ? (
            <ChunkyButton
              variant="secondary"
              size="xs"
              onClick={onSplit}
              title="Split at playhead · S"
              iconLeft={<ScissorsIcon className="w-3.5 h-3.5" />}
            >
              Split here
            </ChunkyButton>
          ) : (
            <ChunkyButton
              variant="secondary"
              size="xs"
              disabled={!canCreate}
              onClick={onCreate}
              title="Create a new chunk at the playhead · S"
              iconLeft={<PlusIcon className="w-3.5 h-3.5" />}
            >
              New chunk here
            </ChunkyButton>
          )}
          <div className="flex flex-col">
            <div className="grid grid-cols-2 gap-1">
              <ChunkyButton
                variant="secondary"
                size="xs"
                disabled={isConforming}
                onClick={handleConform}
                title="Re-fit this chunk's bar grid from its audio · C"
              >
                {isConforming ? "…" : "Conform"}
              </ChunkyButton>
              <ChunkyButton
                variant="secondary"
                size="xs"
                disabled={!canRevertConform}
                onClick={onRevertConform}
                title="Restore this chunk to its state before the last Conform"
              >
                Original
              </ChunkyButton>
            </div>
            {conformStatus && (
              <span
                className="font-mono text-[10px] tabular tracking-label mt-1 self-center text-center leading-tight"
                style={{
                  color:
                    conformStatus.kind === "success" ? "#7A5E1F" : "#B85450",
                  fontWeight: 700,
                }}
              >
                {conformStatus.message}
              </span>
            )}
          </div>
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

// ─── Seam-mode detail panel ──────────────────────────────────────────────

const SEAM_HOT = "#FF5722";

/** Direct nudge units — one button per grid step, no mode to pre-select.
 *  Labels match the DeckStrip snap plate (1 · 1/2 · 1/4 · 1/8 · 1/16) so
 *  the whole app speaks one grid vocabulary. */
const NUDGE_UNITS: { label: string; mode: SnapMode }[] = [
  { label: "1", mode: "1" },
  { label: "1/2", mode: "1/2" },
  { label: "1/4", mode: "1/4" },
  { label: "1/8", mode: "1/8" },
  { label: "1/16", mode: "1/16" },
];

/** Replaces the chunk detail panel while a seam preview is active. Shows
 *  the A→B pair with only the actions that make sense for tuning a
 *  transition: direct per-edge nudge buttons (A's out, B's in) for every
 *  grid unit, Conform each side onto its bar grid, and Swap. No insert /
 *  split / join / reset. */
function SeamInspector() {
  const seam = useTriageStore((s) => s.playback.seam);
  const chunks = useTriageStore((s) => s.chunks);
  const jobBpm = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const nudgeChunkEdge = useTriageStore((s) => s.nudgeChunkEdge);
  const conformChunk = useTriageStore((s) => s.conformChunk);
  const swapSeam = useTriageStore((s) => s.swapSeam);
  const closeSeam = useTriageStore((s) => s.closeSeam);

  const a = seam ? chunks.find((c) => c.id === seam.aId) ?? null : null;
  const b = seam?.bId ? chunks.find((c) => c.id === seam.bId) ?? null : null;
  if (!seam || !a) return null;

  const sorted = [...chunks].sort((x, y) => x.startMs - y.startMs);
  const idxOf = (id: string) => sorted.findIndex((c) => c.id === id) + 1;

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel h-full flex flex-col min-h-0">
      <header
        className="flex-none border-b border-rule px-3 py-2 flex items-center justify-between"
        style={{
          background:
            "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 60%, #DDD4BE 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.10)",
        }}
      >
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Seam · transition
        </span>
        <button
          type="button"
          onClick={() => closeSeam()}
          className="font-mono text-[9px] tracking-label uppercase text-ink-3 hover:text-ink px-1"
          title="Close seam preview · Esc"
        >
          ✕ close
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        <SeamLaneRow
          role="A"
          chunk={a}
          idx={idxOf(a.id)}
          jobBpm={jobBpm}
          beatsPerBar={beatsPerBar}
          onNudge={(mode, dir) => nudgeChunkEdge(a.id, "end", mode, dir)}
          onConform={() => conformChunk(a.id)}
        />

        <div className="text-center font-mono text-[9px] tracking-label uppercase text-ink-3">
          ↓ cut ↓
        </div>

        {b ? (
          <SeamLaneRow
            role="B"
            chunk={b}
            idx={idxOf(b.id)}
            jobBpm={jobBpm}
            beatsPerBar={beatsPerBar}
            onNudge={(mode, dir) => nudgeChunkEdge(b.id, "start", mode, dir)}
            onConform={() => conformChunk(b.id)}
          />
        ) : (
          <div className="rounded border border-dashed border-rule bg-paper-deep p-3 text-center font-mono text-[10px] tracking-label uppercase text-ink-3">
            ◇ pick B — click a chunk in the list
          </div>
        )}

        <Section title="TRANSITION">
          <ChunkyButton
            variant="secondary"
            size="xs"
            disabled={!b}
            onClick={() => swapSeam()}
            title="Swap A and B — audition the reverse transition"
          >
            ⇅ Swap A / B
          </ChunkyButton>
        </Section>
      </div>
    </section>
  );
}

function SeamLaneRow({
  role,
  chunk,
  idx,
  jobBpm,
  beatsPerBar,
  onNudge,
  onConform,
}: {
  role: "A" | "B";
  chunk: Chunk;
  idx: number;
  jobBpm: number | null;
  beatsPerBar: number;
  onNudge: (mode: SnapMode, dir: -1 | 1) => void;
  onConform: () => void;
}) {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  const bpm = effectiveChunkBpm(chunk, jobBpm);
  const bars = bpm > 0 ? ((endS - startS) * bpm) / 60 / beatsPerBar : 0;
  const canNudge = bpm > 0;

  return (
    <div className="rounded border border-rule bg-paper-deep p-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-display tracking-label uppercase text-[9px] shrink-0"
          style={{ color: SEAM_HOT }}
        >
          {role === "A" ? "A · out" : "B · in"}
        </span>
        <span className="font-mono text-[9px] tabular text-ink-3 truncate">
          #{idx.toString().padStart(2, "0")} · {formatTime(startS)}→
          {formatTime(endS)}
          {bars > 0 ? ` · ${bars.toFixed(1)} bars` : ""}
        </span>
        <ChunkyButton
          variant="secondary"
          size="xs"
          onClick={onConform}
          title="Re-fit this chunk's bar grid from its audio"
        >
          Conform
        </ChunkyButton>
      </div>
      <NudgeRow dir={-1} disabled={!canNudge} onNudge={onNudge} />
      <NudgeRow dir={1} disabled={!canNudge} onNudge={onNudge} />
    </div>
  );
}

/** A row of direct nudge buttons (one per grid unit) for one direction.
 *  Left rows move the edge earlier, right rows later — one click each,
 *  no mode to pre-select. */
function NudgeRow({
  dir,
  disabled,
  onNudge,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onNudge: (mode: SnapMode, dir: -1 | 1) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-display text-[9px] tracking-label uppercase text-ink-3 w-[4.5rem] shrink-0 whitespace-nowrap">
        {dir < 0 ? "◀ earlier" : "▶ later"}
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {NUDGE_UNITS.map(({ label, mode }) => (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => onNudge(mode, dir)}
            className="font-mono tabular text-[11px] leading-none w-12 py-1.5 rounded-[4px] border border-black/25 text-ink hover:brightness-[1.04] active:translate-y-px transition disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 100%)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.75), 0 1px 1px rgba(0,0,0,0.18)",
            }}
            title={`${dir < 0 ? "Earlier" : "Later"} by ${
              label === "1" ? "one bar" : label
            }`}
          >
            {label}
          </button>
        ))}
      </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="tracking-label text-ink-3 mr-1">{label}</span>
      <span className="text-ink">{value}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-ink-3">·</span>;
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
