/**
 * Pure logic for Triage transport modes, sequential playback and seam
 * (transition) auditioning. No React, no audio — plain data in, plain
 * data out — so the playback walker is unit-testable without an
 * AudioContext. The driver (`useTriageAudio`) and store consume these.
 */
import type { Chunk } from "../../storage/jobs-db";
import { effectiveChunkBpm, isChunkEffectivelyAccepted } from "./triage-store";

/** Triage transport mode. Replaces the old `loopEnabled` boolean.
 *  - continue: linear master-audio playback, ignores chunk boundaries.
 *  - loop:     loop the focused chunk forever.
 *  - sequence: play all kept chunks chronologically, gapless, stop at end. */
export type TriageMode = "continue" | "loop" | "sequence";

/** Loop region (master-audio seconds) implied by the current mode +
 *  focused chunk. Only `loop` mode produces a region; everything else
 *  plays without bouncing. */
export function loopForMode(
  mode: TriageMode,
  focused: Chunk | null,
): { start: number; end: number } | null {
  if (mode !== "loop" || !focused) return null;
  return { start: focused.startMs / 1000, end: focused.endMs / 1000 };
}

/** The chunks a sequence walker plays: kept (effectively-accepted) only,
 *  in chronological order. Dropped + filtered-out chunks are skipped.
 *  Pure — no mutation of the input array. */
export function buildSequence(
  chunks: Chunk[],
  minChunkBars: number,
  jobBpm: number | null,
  beatsPerBar: number,
): Chunk[] {
  return chunks
    .filter((c) =>
      isChunkEffectivelyAccepted(c, minChunkBars, jobBpm, beatsPerBar),
    )
    .sort((a, b) => a.startMs - b.startMs);
}

/** Next chunk id after `currentId` in a sequence. null at the end, when
 *  `currentId` isn't in the sequence, or for an empty/null input. */
export function nextSequenceId(
  seq: Chunk[],
  currentId: string | null,
): string | null {
  if (currentId == null) return null;
  const idx = seq.findIndex((c) => c.id === currentId);
  if (idx < 0 || idx + 1 >= seq.length) return null;
  return seq[idx + 1].id;
}

// ─── Seam (transition) auditioning ──────────────────────────────────────

/** Ephemeral pairing for the seam editor. `A.end` / `B.start` are NOT
 *  stored here — they're the chunks' own trims (persisted via
 *  updateChunk). Only the loop brackets + which chunks are paired live
 *  here. `bId` is null until the user picks B. */
export interface TriageSeam {
  aId: string;
  bId: string | null;
  /** Audition loop start, master-time seconds inside A. */
  loopInS: number;
  /** Audition loop end, master-time seconds inside B. */
  loopOutS: number;
}

/** The four master-time edges the seam loop plays:
 *  [loopInS → aEndS] (A) then [bStartS → loopOutS] (B), repeat. */
export interface SeamWindow {
  loopInS: number;
  aEndS: number;
  bStartS: number;
  loopOutS: number;
}

/** Resolve the seam window from the ephemeral pairing + the chunks'
 *  CURRENT trims (read fresh so live A.end / B.start edits take effect).
 *  Clamps the loop brackets so the window can never invert. Returns null
 *  when B isn't chosen yet or a referenced chunk is gone — the engine
 *  then plays nothing. */
export function resolveSeamWindow(
  seam: TriageSeam,
  chunks: Chunk[],
): SeamWindow | null {
  if (!seam.bId) return null;
  const a = chunks.find((c) => c.id === seam.aId);
  const b = chunks.find((c) => c.id === seam.bId);
  if (!a || !b) return null;
  const aStartS = a.startMs / 1000;
  const aEndS = a.endMs / 1000;
  const bStartS = b.startMs / 1000;
  const bEndS = b.endMs / 1000;
  // loopIn must sit inside A and before its end; fall back to A.start.
  const loopInS =
    seam.loopInS >= aStartS && seam.loopInS < aEndS ? seam.loopInS : aStartS;
  // loopOut must sit inside B and after its start; fall back to B.end.
  const loopOutS =
    seam.loopOutS > bStartS && seam.loopOutS <= bEndS ? seam.loopOutS : bEndS;
  return { loopInS, aEndS, bStartS, loopOutS };
}

/** Where the current phase arms its crossfade and where it hops to.
 *  Phase A: play to A.end, hop to B.start, become phase B.
 *  Phase B: play to loopOut, wrap to loopIn, become phase A. */
export function seamHopTarget(
  win: SeamWindow,
  phase: "A" | "B",
): { armAtS: number; seekToS: number; nextPhase: "A" | "B" } {
  if (phase === "A") {
    return { armAtS: win.aEndS, seekToS: win.bStartS, nextPhase: "B" };
  }
  return { armAtS: win.loopOutS, seekToS: win.loopInS, nextPhase: "A" };
}

/** Default audition-bracket span (seconds) for a freshly-opened seam —
 *  ~2 bars at the chunk's tempo, or 2 s when no tempo is known. */
export function seamSpanS(
  chunk: Chunk,
  jobBpm: number | null,
  beatsPerBar: number,
): number {
  const bpm = effectiveChunkBpm(chunk, jobBpm);
  if (bpm > 0 && beatsPerBar > 0) return (60 / bpm) * beatsPerBar * 2;
  return 2;
}
