/**
 * Pill auto-generation, reconciliation, and active-pill resolution.
 *
 * The editor is uniformly pill-based. Every job runs through the same
 * `(arrangement × chunks × clips)` shape — long-form jobs feed their
 * persisted arrangement, single-take jobs synthesize a single
 * arrangement-item + chunk in `synthesizeJobLoadShape` so the pill
 * generator stays mode-agnostic.
 *
 * Pill ID `${camId}::${arrangementItemId}` round-trips user edits across
 * editor mounts; single-take jobs keep the legacy `__default__` item id
 * so pre-refactor persisted pill edits stay matched.
 *
 * Pure helpers — no store, no IO, no React.
 */
import type { ArrangementItem, Chunk, Cut } from "../storage/jobs-db";
import { camSourceTimeS } from "../local/timing/cam-time";
import {
  isImageClip,
  isVideoClip,
  clipRangeS,
  type Clip,
  type Pill,
  type Segment,
} from "./types";

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
 * Emits one pill per (cam × arrangement-item) intersection in playback
 * order. Single-take jobs come in with a synthetic single-item
 * arrangement (see `synthesizeJobLoadShape`) so this function stays
 * mode-agnostic — its only inputs are the same `(arrangement, chunks,
 * clips)` triple regardless of the job's source.
 *
 * Originals are baked in so the per-pill RESET action restores the
 * pill to the slot the editor would generate today.
 */
export function generatePills(
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
    // Mode-agnostic rule: stored values override fresh ONLY when the
    // user explicitly edited this pill (`userEdited === true`). Without
    // that flag, the pill is auto-derived from clips + sync + chunks —
    // any baseline shift (sync resolving, trim change, audio nudge) must
    // flow through to the pill, which means using fresh values.
    //
    // Pre-flag pills (no `userEdited`) are conservatively treated as
    // auto-generated. This drops any user edits made before the flag
    // was added, but those were already broken across reloads in many
    // cases (the previous heuristic mis-flagged unedited pills as edited
    // whenever a previous reconcile cycle had refreshed the originals).
    if (!stored || !stored.userEdited) return freshP;
    return {
      ...stored,
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
 *   2. Find the latest cut whose timeline-time ≤ arrT AND whose `camId`
 *      has a covering pill. That cam wins.
 *   3. If no cut applies, fall back to the FIRST covering pill.
 *   4. If no pill covers `arrT`, return null (= test pattern).
 *
 * Cuts are stored in timeline-time (`Cut.atTimeS` is now song-position,
 * not master-position). The legacy master-time → arr-time projection is
 * gone: when the same chunk repeats in the song, master-time can't tell
 * the occurrences apart, so a cut "at master 5.0" would have fired in
 * every duplicate. Storing in timeline-time means a cut placed inside
 * pill 1 fires only there, not in pill 3 (= duplicate). The migration
 * pass on Job-load converts old master-time cuts to first-occurrence
 * timeline-time so existing edits keep working.
 *
 * Returns the active pill so callers (compositor + Timeline) can pull
 * its source-time mapping without re-scanning.
 */
export function activeCamAtArr(
  cuts: readonly Cut[],
  arrT: number,
  pills: readonly Pill[],
  _segments: readonly Segment[],
): { camId: string; pill: Pill } | null {
  if (pills.length === 0) return null;
  const covering = pills.filter(
    (p) => arrT >= p.arrStartS && arrT < p.arrEndS,
  );
  if (covering.length === 0) return null;
  let chosen: { camId: string; pill: Pill } | null = null;
  let bestArrT = -Infinity;
  for (const cut of cuts) {
    const cutArr = cut.atTimeS;
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
