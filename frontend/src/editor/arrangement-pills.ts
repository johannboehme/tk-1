/**
 * Pill auto-generation + active-pill resolution.
 *
 * For each (cam × arrangement-item) pair, intersect the cam's master-time
 * range with the chunk's master-time range. If the intersection has any
 * length, emit one pill anchored to that arrangement-item's slot on the
 * song timeline. The result is the FRESH initial pill list — user edits
 * (move/trim) ride on top via the store and survive arrangement reorders
 * as long as the underlying arrangement-item id stays.
 *
 * Pure helper. No store, no IO, no React.
 */
import type { ArrangementItem, Chunk, Cut } from "../storage/jobs-db";
import { camSourceTimeS } from "../local/timing/cam-time";
import { masterToArr } from "./arrangement-time";
import {
  clipRangeS,
  isImageClip,
  isVideoClip,
  type Clip,
  type Pill,
  type Segment,
} from "./types";

/**
 * Build the initial pill list for a long-form editor session.
 *
 * Walks the arrangement in playback order accumulating arr-time. For each
 * item-of-arrangement and each cam, intersects the cam's master-time
 * range with the chunk's `[startMs, endMs)`. Image clips have no source
 * time (no decode pipeline), so they get one pill spanning the whole
 * chunk — the renderer will treat their source as a single bitmap.
 *
 * Pill ID convention: `${camId}::${arrangementItemId}` so user-edited
 * pills (mutated trim/placement) round-trip across editor mounts.
 */
export function generateArrangementPills(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  clips: readonly Clip[],
): Pill[] {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const pills: Pill[] = [];
  let arrCursor = 0;
  for (const item of arrangement) {
    const chunk = chunkById.get(item.chunkId);
    if (!chunk) continue;
    const chunkInS = chunk.startMs / 1000;
    const chunkOutS = chunk.endMs / 1000;
    const chunkLenS = chunkOutS - chunkInS;
    if (chunkLenS <= 0) continue;
    for (const clip of clips) {
      if (isImageClip(clip)) {
        // Image cam: no master-time anchor, just spans the chunk's slot.
        pills.push({
          id: `${clip.id}::${item.id}`,
          camId: clip.id,
          arrStartS: arrCursor,
          arrEndS: arrCursor + chunkLenS,
          sourceInS: 0,
          sourceOutS: chunkLenS,
          fromArrangementItemId: item.id,
        });
        continue;
      }
      if (!isVideoClip(clip)) continue;
      const clipRange = clipRangeS(clip);
      const interIn = Math.max(clipRange.startS, chunkInS);
      const interOut = Math.min(clipRange.endS, chunkOutS);
      if (interOut <= interIn) continue;
      // Translate the master-time intersection into the cam's source-time
      // (= what frame-strip / video element offset to fetch).
      const sourceInS = camSourceTimeS(interIn, {
        masterStartS: clipRange.anchorS,
        driftRatio: clip.driftRatio,
      });
      const sourceOutS = camSourceTimeS(interOut, {
        masterStartS: clipRange.anchorS,
        driftRatio: clip.driftRatio,
      });
      const arrSubStart = arrCursor + (interIn - chunkInS);
      const arrSubEnd = arrCursor + (interOut - chunkInS);
      pills.push({
        id: `${clip.id}::${item.id}`,
        camId: clip.id,
        arrStartS: arrSubStart,
        arrEndS: arrSubEnd,
        sourceInS,
        sourceOutS,
        fromArrangementItemId: item.id,
      });
    }
    arrCursor += chunkLenS;
  }
  return pills;
}

/**
 * Reconcile a stored pills list against the current arrangement.
 *
 * On editor re-load we want user pill edits (move / trim) to survive,
 * but new arrangement-items added after the user left need fresh pills.
 * Algorithm:
 *   1. Generate the fresh "default" pill list from the current
 *      arrangement+chunks+cams.
 *   2. For each fresh pill, look up a stored pill with the same id
 *      (stored pills carry `${camId}::${arrangementItemId}`). If found,
 *      keep the stored pill — user edits ride.
 *   3. Stored pills whose id has no fresh counterpart are dropped: the
 *      arrangement-item they came from no longer exists, so the pill
 *      no longer has a home on the song.
 */
export function reconcileArrangementPills(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  clips: readonly Clip[],
  storedPills: readonly Pill[],
): Pill[] {
  const fresh = generateArrangementPills(arrangement, chunks, clips);
  if (storedPills.length === 0) return fresh;
  const storedById = new Map(storedPills.map((p) => [p.id, p]));
  return fresh.map((p) => storedById.get(p.id) ?? p);
}

/**
 * Resolve which cam is on PROGRAM at song-time `arrT`.
 *
 * Rules (mirrors `activeCamAt` from cuts.ts but in arr-time + pill space):
 *   1. Find every pill that covers `arrT` (= cam availability at this
 *      song position).
 *   2. Find the latest cut whose master-time maps to an arr-time ≤ arrT
 *      AND whose `camId` has a covering pill. That cam wins.
 *   3. If no cut applies, fall back to the FIRST covering pill (in
 *      `pills[]` order — the loadJob auto-generation emits them in
 *      cam-list order so this matches direct-mode's "first cam wins"
 *      tiebreaker).
 *   4. If no pill covers `arrT`, return null (= test pattern).
 *
 * Returns the active pill so callers (compositor + Timeline) can pull
 * its source-time mapping without re-scanning.
 */
export function activeCamAtArr(
  cuts: readonly Cut[],
  arrT: number,
  pills: readonly Pill[],
  segments: readonly Segment[],
): { camId: string; pill: Pill } | null {
  if (pills.length === 0) return null;
  const covering = pills.filter(
    (p) => arrT >= p.arrStartS && arrT < p.arrEndS,
  );
  if (covering.length === 0) return null;
  // Cuts are stored in master-time; map each to arr-time via the active
  // segment list. (For direct-mode `segments` is empty and masterToArr
  // is identity, so this still works without an arr-mode caller.)
  let chosen: { camId: string; pill: Pill } | null = null;
  let bestArrT = -Infinity;
  for (const cut of cuts) {
    const cutArr = masterToArr(cut.atTimeS, segments);
    if (cutArr > arrT) continue;
    if (cutArr <= bestArrT) continue;
    const pill = covering.find((p) => p.camId === cut.camId);
    if (!pill) continue;
    bestArrT = cutArr;
    chosen = { camId: cut.camId, pill };
  }
  if (chosen) return chosen;
  return { camId: covering[0].camId, pill: covering[0] };
}
