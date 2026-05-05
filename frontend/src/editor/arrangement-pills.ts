/**
 * Pill auto-generation, reconciliation, and active-pill resolution.
 *
 * The editor is uniformly pill-based. Every job — long-form arrangement
 * or single-take — renders through `pills[]`. The generator below
 * produces one pill per editing slot:
 *
 *   - Long-form jobs (arrangement non-empty): one pill per
 *     (cam × arrangement-item) intersection. Pill ID
 *     `${camId}::${arrangementItemId}` round-trips user edits across
 *     editor mounts.
 *
 *   - Single-take jobs (arrangement empty): one pill per cam covering
 *     the cam's full visible master-time range. Pill ID
 *     `${camId}::__default__`.
 *
 * Pure helpers — no store, no IO, no React.
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

/** Single-take pill id sentinel. Stable so reconcile keeps user edits
 *  across editor mounts even when the job has no arrangement. */
const DEFAULT_ITEM_ID = "__default__";

/** Tolerance for pill-dirtiness comparisons. Anything sub-millisecond
 *  is rounding noise, not a user edit. */
const DIRTY_EPS_S = 1e-3;

/** True when a pill's arr-window or source-trim has been edited off its
 *  auto-generated baseline. Drives the floating ↺ reset-button on the
 *  canvas, the lane-header reset enable-state, and the per-pill RESET
 *  button in the OptionsPanel — one source of truth for "needs reset". */
export function isPillDirty(p: Pill): boolean {
  return (
    Math.abs(p.arrStartS - p.originalArrStartS) > DIRTY_EPS_S ||
    Math.abs(p.arrEndS - p.originalArrEndS) > DIRTY_EPS_S ||
    Math.abs(p.sourceInS - p.originalSourceInS) > DIRTY_EPS_S ||
    Math.abs(p.sourceOutS - p.originalSourceOutS) > DIRTY_EPS_S
  );
}

/**
 * Build the editor's pill list from the persisted job state.
 *
 * Dispatches on whether the job carries an arrangement:
 *   - `arrangement.length > 0` → emit one pill per (cam × item)
 *     intersection in playback order.
 *   - empty / missing arrangement → emit one pill per cam, anchored
 *     at the cam's full master-time range. arr-time == master-time
 *     in this case (no segment-walker mapping).
 *
 * Originals are baked in so the per-pill RESET action restores the
 * pill to the slot the editor would generate today.
 */
export function generatePills(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  clips: readonly Clip[],
): Pill[] {
  if (arrangement.length === 0 || chunks.length === 0) {
    return generateDefaultPills(clips);
  }
  return generateArrangementPills(arrangement, chunks, clips);
}

function generateDefaultPills(clips: readonly Clip[]): Pill[] {
  const out: Pill[] = [];
  for (const clip of clips) {
    const range = clipRangeS(clip);
    if (range.endS <= range.startS) continue;
    if (isImageClip(clip)) {
      out.push(makePill({
        camId: clip.id,
        itemId: DEFAULT_ITEM_ID,
        arrStartS: range.startS,
        arrEndS: range.endS,
        sourceInS: 0,
        sourceOutS: clip.durationS,
      }));
      continue;
    }
    if (!isVideoClip(clip)) continue;
    const sourceInS = clip.trimInS ?? 0;
    const sourceOutS = clip.trimOutS ?? clip.sourceDurationS;
    out.push(makePill({
      camId: clip.id,
      itemId: DEFAULT_ITEM_ID,
      arrStartS: range.startS,
      arrEndS: range.endS,
      sourceInS,
      sourceOutS,
    }));
  }
  return out;
}

function generateArrangementPills(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  clips: readonly Clip[],
): Pill[] {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const out: Pill[] = [];
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
        out.push(makePill({
          camId: clip.id,
          itemId: item.id,
          arrStartS: arrCursor,
          arrEndS: arrCursor + chunkLenS,
          sourceInS: 0,
          sourceOutS: chunkLenS,
        }));
        continue;
      }
      if (!isVideoClip(clip)) continue;
      const clipRange = clipRangeS(clip);
      const interIn = Math.max(clipRange.startS, chunkInS);
      const interOut = Math.min(clipRange.endS, chunkOutS);
      if (interOut <= interIn) continue;
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
      out.push(makePill({
        camId: clip.id,
        itemId: item.id,
        arrStartS: arrSubStart,
        arrEndS: arrSubEnd,
        sourceInS,
        sourceOutS,
      }));
    }
    arrCursor += chunkLenS;
  }
  return out;
}

function makePill(args: {
  camId: string;
  itemId: string;
  arrStartS: number;
  arrEndS: number;
  sourceInS: number;
  sourceOutS: number;
}): Pill {
  return {
    id: `${args.camId}::${args.itemId}`,
    camId: args.camId,
    arrStartS: args.arrStartS,
    arrEndS: args.arrEndS,
    sourceInS: args.sourceInS,
    sourceOutS: args.sourceOutS,
    originalArrStartS: args.arrStartS,
    originalArrEndS: args.arrEndS,
    originalSourceInS: args.sourceInS,
    originalSourceOutS: args.sourceOutS,
    fromArrangementItemId: args.itemId,
  };
}

/**
 * Reconcile a stored pill list against the current arrangement+cam state.
 *
 * Algorithm:
 *   1. Generate the fresh pill list from the current job state.
 *   2. For each fresh pill, look up a stored pill by id. If found,
 *      keep the stored arr/source values (= user edits), but refresh
 *      the originals to the fresh pill's values. That way RESET
 *      always returns to "what the editor would generate now",
 *      reflecting any chunk reorder / cam re-sync the user did since
 *      the pill was first created.
 *   3. Stored pills whose id has no fresh counterpart are dropped:
 *      the cam or arrangement-item they came from no longer exists,
 *      so the pill no longer has a home on the song.
 */
export function reconcilePills(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  clips: readonly Clip[],
  storedPills: readonly Pill[],
): Pill[] {
  const fresh = generatePills(arrangement, chunks, clips);
  if (storedPills.length === 0) return fresh;
  const storedById = new Map(storedPills.map((p) => [p.id, p]));
  return fresh.map((freshP) => {
    const stored = storedById.get(freshP.id);
    if (!stored) return freshP;
    // If the stored pill matches its own stored originals (within eps),
    // it was never user-edited — sync changes or other clip-derived
    // shifts that move the auto-baseline should flow through. Keeping
    // the stored arr/source values would otherwise leave the pill
    // "stuck" at the old baseline (e.g. arrStartS=0 from a save that
    // happened before sync resolved a non-zero offset), which the user
    // reads as a phantom edit.
    const wasUnedited =
      Math.abs(stored.arrStartS - stored.originalArrStartS) < DIRTY_EPS_S &&
      Math.abs(stored.arrEndS - stored.originalArrEndS) < DIRTY_EPS_S &&
      Math.abs(stored.sourceInS - stored.originalSourceInS) < DIRTY_EPS_S &&
      Math.abs(stored.sourceOutS - stored.originalSourceOutS) < DIRTY_EPS_S;
    if (wasUnedited) return freshP;
    return {
      ...stored,
      // Refresh originals to current auto-derived values so RESET
      // takes the user back to "what the editor would generate now".
      originalArrStartS: freshP.originalArrStartS,
      originalArrEndS: freshP.originalArrEndS,
      originalSourceInS: freshP.originalSourceInS,
      originalSourceOutS: freshP.originalSourceOutS,
    };
  });
}


/**
 * Resolve which cam is on PROGRAM at song-time `arrT`.
 *
 * Rules:
 *   1. Find every pill that covers `arrT`.
 *   2. Find the latest cut whose master-time maps to an arr-time ≤ arrT
 *      AND whose `camId` has a covering pill. That cam wins.
 *   3. If no cut applies, fall back to the FIRST covering pill.
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
