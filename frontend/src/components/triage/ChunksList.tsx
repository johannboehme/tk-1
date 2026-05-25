/**
 * Compact chunk overview list. Read-only navigation aid — tap a row to
 * focus the chunk in the timeline. The timeline itself is the visual
 * source of truth for status; this list is for linear scanning of long
 * sessions and a glanceable accept/reject summary.
 *
 * Auto-scrolls the focused chunk into view (with neighbours visible
 * above and below) any time focus moves — clicking, arrow keys, or
 * playback advancing. Mirrors the FilmStrip auto-centre pattern from
 * Arrange so the user keeps a stable spatial anchor.
 *
 * No inline Keep/Drop buttons — actions live on the TransportBar
 * (Enter/Backspace) so the user always knows where to go.
 */
import { useEffect, useRef } from "react";
import {
  chunkPassesFilter,
  useTriageStore,
} from "../../local/triage/triage-store";
import { buildSequence } from "../../local/triage/triage-sequence";
import type { Chunk } from "../../storage/jobs-db";

const HOT_COLOR = "#FF5722";
const BRASS_COLOR = "#C9A95A";

export function ChunksList() {
  const chunks = useTriageStore((s) => s.chunks);
  const focusedId = useTriageStore((s) => s.focusedChunkId);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const seam = useTriageStore((s) => s.playback.seam);
  const setSeamB = useTriageStore((s) => s.setSeamB);
  const openSeam = useTriageStore((s) => s.openSeam);
  const closeSeam = useTriageStore((s) => s.closeSeam);
  const seamStep = useTriageStore((s) => s.seamStep);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const jobBpmValue = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const sequencePlaying = useTriageStore(
    (s) => s.playback.mode === "sequence" && s.playback.isPlaying,
  );

  const sorted = [...chunks].sort((a, b) => a.startMs - b.startMs);
  const keptCount = sorted.filter(
    (c) =>
      c.accepted && chunkPassesFilter(c, minChunkBars, jobBpmValue, beatsPerBar),
  ).length;

  // Seam stepping availability (kept chunks only): a transition needs A
  // plus a following chunk, so A can step within [0, kept-2].
  const seamSeq = seam
    ? buildSequence(chunks, minChunkBars, jobBpmValue, beatsPerBar)
    : [];
  const seamIdxA = seam ? seamSeq.findIndex((c) => c.id === seam.aId) : -1;
  const canSeamPrev = seamIdxA > 0;
  const canSeamNext = seamIdxA >= 0 && seamIdxA < seamSeq.length - 2;

  const listRef = useRef<HTMLUListElement | null>(null);
  // Auto-scroll focused row into view with a comfortable offset so the
  // user always sees a couple of neighbours above and below — far less
  // disorienting than centring exactly on the row.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !focusedId) return;
    const row = list.querySelector<HTMLElement>(
      `[data-chunk-row="${focusedId}"]`,
    );
    if (!row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowTop = rowRect.top - listRect.top;
    const rowBottom = rowRect.bottom - listRect.top;
    // Already fully visible → leave the list alone (mirrors the timeline's
    // auto-follow). This stops the list from jumping on every sequence
    // advance when the next chunk is already on screen.
    if (rowTop >= 0 && rowBottom <= list.clientHeight) return;
    // Off-screen → bring it in with ~30 % headroom so a couple of
    // siblings stay visible above the focused row.
    const targetRowOffsetWithinList = rowTop + list.scrollTop;
    const offset = Math.max(48, list.clientHeight * 0.3);
    list.scrollTo({
      top: targetRowOffsetWithinList - offset,
      behavior: "smooth",
    });
  }, [focusedId]);

  if (sorted.length === 0) {
    return (
      <section className="rounded-md border border-rule bg-paper-hi p-4 text-center font-mono text-[10px] tracking-label uppercase text-ink-3">
        ◇ no chunks — adjust threshold
      </section>
    );
  }

  return (
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel flex flex-col h-full min-h-0">
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
          Chunks · {sorted.length}
        </span>
        <div className="flex items-center gap-2">
          {/* Seam preview — opens the transition editor on the focused
           *  chunk (= A); then click a row to set B. Lives here so it sits
           *  next to the list it operates on (not by the snap plate). */}
          <button
            type="button"
            onClick={() =>
              seam ? closeSeam() : focusedId && openSeam(focusedId)
            }
            disabled={!seam && !focusedId}
            className="font-display tracking-label uppercase text-[9px] px-1.5 py-0.5 rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            style={
              seam
                ? { background: HOT_COLOR, color: "#1A1612", borderColor: HOT_COLOR }
                : { borderColor: "rgba(0,0,0,0.2)", color: "#5D5546" }
            }
            title={
              seam
                ? "Close seam preview · Esc"
                : "Seam preview — audition the transition from the focused chunk · T"
            }
            aria-pressed={seam != null}
          >
            Seam
          </button>
          {seam && (
            <div className="flex items-center gap-0.5">
              <SeamStepButton
                dir={-1}
                disabled={!canSeamPrev}
                onClick={() => seamStep(-1)}
              />
              <SeamStepButton
                dir={1}
                disabled={!canSeamNext}
                onClick={() => seamStep(1)}
              />
            </div>
          )}
          <span className="font-mono text-[10px] tabular text-ink-3">
            {keptCount} kept
          </span>
        </div>
      </header>
      <ul ref={listRef} className="flex-1 min-h-0 overflow-y-auto">
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
              nowPlaying={sequencePlaying && chunk.id === focusedId}
              // In seam mode the list picks the in-coming chunk B; A is
              // the chunk the seam was opened on (seam.aId).
              seamRole={
                seam
                  ? chunk.id === seam.aId
                    ? "A"
                    : chunk.id === seam.bId
                      ? "B"
                      : null
                  : null
              }
              effectivelyAccepted={chunk.accepted && passes}
              filteredOut={chunk.accepted && !passes}
              onFocus={() =>
                seam ? setSeamB(chunk.id) : focusChunk(chunk.id)
              }
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
  /** Currently sounding in sequence playback (focused + sequence + playing). */
  nowPlaying: boolean;
  /** This chunk's role in an active seam preview, if any. */
  seamRole: "A" | "B" | null;
  effectivelyAccepted: boolean;
  filteredOut: boolean;
  onFocus: () => void;
}

function ChunkRow({
  chunk,
  index,
  focused,
  nowPlaying,
  seamRole,
  effectivelyAccepted,
  filteredOut,
  onFocus,
}: RowProps) {
  const lengthS = (chunk.endMs - chunk.startMs) / 1000;
  const stateStripe = effectivelyAccepted ? HOT_COLOR : "#5D5546";
  const rowBg = focused
    ? effectivelyAccepted
      ? "bg-hot/15"
      : "bg-paper-deep"
    : "bg-paper-hi hover:bg-paper-deep";

  return (
    <li
      data-chunk-row={chunk.id}
      className={`relative grid grid-cols-[4px_1fr] items-center gap-2 border-b border-rule/60 px-2 py-1.5 cursor-pointer transition-colors ${rowBg}`}
      style={
        focused
          ? {
              outline: `2px solid ${HOT_COLOR}`,
              outlineOffset: -2,
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.35)",
              zIndex: 10,
            }
          : undefined
      }
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
          {nowPlaying && (
            <span
              className="shrink-0 self-center text-[8px] leading-none"
              style={{ color: HOT_COLOR }}
              aria-label="Now playing"
              title="Now playing"
            >
              ▶
            </span>
          )}
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
          {seamRole && (
            <span
              className="font-mono text-[8px] tracking-label uppercase px-1 rounded"
              style={{
                background: seamRole === "A" ? HOT_COLOR : BRASS_COLOR,
                color: "#1A1612",
              }}
              aria-label={seamRole === "A" ? "Seam A (out)" : "Seam B (in)"}
            >
              {seamRole}
            </span>
          )}
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

/** Prev/next button to step the seam pair to the adjacent transition.
 *  Only shown while a seam preview is active. */
function SeamStepButton({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="font-mono text-[10px] leading-none px-1.5 py-1 rounded border border-black/20 text-ink-2 transition-colors hover:bg-paper-deep disabled:opacity-30 disabled:cursor-not-allowed"
      title={dir === 1 ? "Next transition" : "Previous transition"}
      aria-label={dir === 1 ? "Next transition" : "Previous transition"}
    >
      {dir === 1 ? "▶" : "◀"}
    </button>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
