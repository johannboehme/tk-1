/**
 * Pure transforms applied to the persisted arrangement when a Triage
 * action mutates the chunk list in a non-trivial way (split with
 * replacement, merge of two chunks).
 *
 * Pure on purpose: caller hands in the current arrangement + the chunk
 * ids before/after, gets back the new arrangement. No store / IDB
 * coupling so the logic is fully unit-testable. Persistence sits at the
 * call site (`triage-guarded-actions.ts`).
 */
import type { ArrangementItem } from "../../storage/jobs-db";

export type SplitReplacement = "a" | "b" | "both";

let counter = 0;
function freshArrId(chunkId: string): string {
  counter += 1;
  return `arr-${chunkId}-${Date.now()}-${counter}`;
}

/**
 * Apply the user's split-replacement choice to the arrangement.
 *
 * Convention: after `splitChunkAt(originalId, ...)`, the LEFT half keeps
 * `originalId` (=> "Part A") and the RIGHT half gets `newRightId`.
 *
 *   - "a"    — keep arrangement as-is. Existing items still point at
 *              originalId, which now describes Part A. Part B sits in
 *              the Polaroid pool only.
 *   - "b"    — replace every occurrence's chunkId with `newRightId`.
 *              Part A sits in the pool only.
 *   - "both" — for each occurrence of the original chunk, follow it
 *              with a fresh item pointing at the right half. Plays
 *              [A, B] back-to-back wherever the original used to play.
 */
export function applySplitToArrangement(
  arrangement: readonly ArrangementItem[],
  originalChunkId: string,
  newRightChunkId: string,
  mode: SplitReplacement,
): ArrangementItem[] {
  if (mode === "a") return arrangement as ArrangementItem[];

  if (mode === "b") {
    let touched = false;
    const next = arrangement.map((it) => {
      if (it.chunkId !== originalChunkId) return it;
      touched = true;
      return { ...it, chunkId: newRightChunkId };
    });
    return touched ? next : (arrangement as ArrangementItem[]);
  }

  // mode === "both"
  const out: ArrangementItem[] = [];
  let touched = false;
  for (const it of arrangement) {
    out.push(it);
    if (it.chunkId === originalChunkId) {
      out.push({ id: freshArrId(newRightChunkId), chunkId: newRightChunkId });
      touched = true;
    }
  }
  return touched ? out : (arrangement as ArrangementItem[]);
}

/**
 * Apply a Triage merge to the arrangement.
 *
 * Convention: `joinChunks(focusedId, direction)` keeps `focusedId` as
 * the merged chunk's id; the neighbour's id (`removedChunkId`) is
 * gone from the chunks list afterwards.
 *
 * The transform handles both adjacency configurations uniformly:
 *
 *   - any two adjacent items whose chunkIds are {merged, removed} (in
 *     either order) collapse to a single item carrying mergedChunkId.
 *   - any standalone item whose chunkId is `removedChunkId` becomes a
 *     standalone item with `mergedChunkId`. (User answered: "Replace
 *     all with merged" — this is the consistent interpretation across
 *     adjacent + isolated cases.)
 *   - everything else passes through.
 */
export function applyMergeToArrangement(
  arrangement: readonly ArrangementItem[],
  mergedChunkId: string,
  removedChunkId: string,
): ArrangementItem[] {
  // Cheap escape: nothing references either id.
  if (
    !arrangement.some((it) => it.chunkId === mergedChunkId || it.chunkId === removedChunkId)
  ) {
    return arrangement as ArrangementItem[];
  }

  const out: ArrangementItem[] = [];
  let touched = false;
  let i = 0;
  while (i < arrangement.length) {
    const cur = arrangement[i];
    const next = arrangement[i + 1];
    const isAdjacentPair =
      next != null &&
      ((cur.chunkId === mergedChunkId && next.chunkId === removedChunkId) ||
        (cur.chunkId === removedChunkId && next.chunkId === mergedChunkId));
    if (isAdjacentPair) {
      // Collapse to a single merged item. Keep the FIRST item's id so
      // editor pills tied to that arrangement-item id round-trip.
      out.push({ ...cur, chunkId: mergedChunkId });
      i += 2;
      touched = true;
      continue;
    }
    if (cur.chunkId === removedChunkId) {
      out.push({ ...cur, chunkId: mergedChunkId });
      touched = true;
    } else {
      out.push(cur);
    }
    i += 1;
  }
  return touched ? out : (arrangement as ArrangementItem[]);
}
