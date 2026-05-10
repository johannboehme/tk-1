/**
 * Counts how many downstream edits would be lost if a Triage chunk,
 * an arrangement item, or a sync cam were removed. Drives ConfirmDialog
 * bodies so the user sees ("removes 3 cuts and 1 FX") before agreeing.
 *
 * "Affected by" semantics:
 *   - chunk removal: every arrangement-item that references the chunk
 *     vanishes; every pill on those items vanishes; every cut and fx
 *     whose timeline range overlaps a vanishing pill goes with them.
 *   - item removal: only the pills (across all cams) tied to that single
 *     item, and the cuts/fx overlapping their ranges.
 *   - cam removal: every pill on that cam, every cut on that cam, all fx
 *     (fx are not cam-scoped).
 */
import type {
  ArrangementItem,
  Cut,
  PillRecord,
  PunchFxRecord,
} from "../storage/jobs-db";

export interface EditsImpact {
  /** Number of arrangement items removed. Only meaningful for the chunk-
   *  removal counter; the per-item / per-cam counters always set this 0. */
  items: number;
  /** Number of cuts that fall inside a removed pill's [arrStartS, arrEndS). */
  cuts: number;
  /** Number of fx records whose [inS, outS] overlaps a removed pill range. */
  fx: number;
  /** Number of removed pills with `userEdited: true`. Counted separately
   *  because un-edited pills regenerate cleanly — only edited ones are
   *  "lost work" worth warning about. */
  userEditedPills: number;
}

const ZERO: EditsImpact = { items: 0, cuts: 0, fx: 0, userEditedPills: 0 };

/** All arrangement-item ids that reference the given chunk. */
export function arrangementItemsForChunk(
  chunkId: string,
  arrangement: readonly ArrangementItem[],
): string[] {
  return arrangement.filter((a) => a.chunkId === chunkId).map((a) => a.id);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function countCutsInRanges(cuts: readonly Cut[], ranges: readonly { startS: number; endS: number }[]): number {
  if (ranges.length === 0) return 0;
  let n = 0;
  for (const c of cuts) {
    for (const r of ranges) {
      if (c.atTimeS >= r.startS && c.atTimeS < r.endS) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

function countFxInRanges(
  fx: readonly PunchFxRecord[],
  ranges: readonly { startS: number; endS: number }[],
): number {
  if (ranges.length === 0) return 0;
  let n = 0;
  for (const f of fx) {
    for (const r of ranges) {
      if (rangesOverlap(f.inS, f.outS, r.startS, r.endS)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

export function countEditsAffectedByChunkRemoval(
  chunkId: string,
  arrangement: readonly ArrangementItem[],
  pills: readonly PillRecord[],
  cuts: readonly Cut[],
  fx: readonly PunchFxRecord[],
): EditsImpact {
  const itemIds = arrangementItemsForChunk(chunkId, arrangement);
  if (itemIds.length === 0) return { ...ZERO };
  const itemIdSet = new Set(itemIds);
  const removedPills = pills.filter(
    (p) => p.fromArrangementItemId !== undefined && itemIdSet.has(p.fromArrangementItemId),
  );
  const ranges = removedPills.map((p) => ({ startS: p.arrStartS, endS: p.arrEndS }));
  return {
    items: itemIds.length,
    cuts: countCutsInRanges(cuts, ranges),
    fx: countFxInRanges(fx, ranges),
    userEditedPills: removedPills.filter((p) => p.userEdited === true).length,
  };
}

export function countEditsAffectedByItemRemoval(
  itemId: string,
  pills: readonly PillRecord[],
  cuts: readonly Cut[],
  fx: readonly PunchFxRecord[],
): EditsImpact {
  const removedPills = pills.filter((p) => p.fromArrangementItemId === itemId);
  const ranges = removedPills.map((p) => ({ startS: p.arrStartS, endS: p.arrEndS }));
  return {
    items: 0,
    cuts: countCutsInRanges(cuts, ranges),
    fx: countFxInRanges(fx, ranges),
    userEditedPills: removedPills.filter((p) => p.userEdited === true).length,
  };
}

export function countEditsAffectedByCamRemoval(
  camId: string,
  pills: readonly PillRecord[],
  cuts: readonly Cut[],
  fx: readonly PunchFxRecord[],
): EditsImpact {
  const camPills = pills.filter((p) => p.camId === camId);
  return {
    items: 0,
    cuts: cuts.filter((c) => c.camId === camId).length,
    fx: fx.length === 0 ? 0 : 0,
    userEditedPills: camPills.filter((p) => p.userEdited === true).length,
  };
}

/**
 * Are two chunks always direct neighbours wherever they appear in the
 * arrangement? Used to decide whether a Triage-side merge can collapse
 * silently (always-adjacent → safe) or needs a confirm dialog (some
 * occurrence is isolated → user picks replace-all-with-merged or cancel).
 *
 * The check accepts either order — `[c1, c2]` and `[c2, c1]` both count
 * as adjacent. If either chunk is absent from the arrangement entirely,
 * there's nothing to confirm so we return true (vacuously safe).
 */
export function isAlwaysAdjacentInArrangement(
  chunkA: string,
  chunkB: string,
  arrangement: readonly ArrangementItem[],
): boolean {
  for (let i = 0; i < arrangement.length; i++) {
    const cur = arrangement[i].chunkId;
    if (cur !== chunkA && cur !== chunkB) continue;
    const other = cur === chunkA ? chunkB : chunkA;
    const prev = arrangement[i - 1]?.chunkId;
    const next = arrangement[i + 1]?.chunkId;
    if (prev !== other && next !== other) return false;
  }
  return true;
}
