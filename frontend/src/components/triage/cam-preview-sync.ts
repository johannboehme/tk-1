/**
 * Pure decision function for CamPreview's per-tick video-element sync.
 *
 * Given a master-timeline second and the cam's sync metadata, returns
 * what the preview should do: pause (cam hasn't started yet, or the
 * source has run out), or seek to a specific source-time.
 *
 * Sign convention follows `local/timing/cam-time.ts` and `clipRangeS`
 * in `editor/types.ts`: `sync.offsetMs > 0` means the cam started
 * recording BEFORE master t=0 (pre-roll), so at master t=0 the cam is
 * already at source-time `+offsetMs/1000`. The previous formula
 * `sourceT = masterT − offsetMs/1000` had the sign flipped, which
 * froze the preview for the entire pre-roll window and then started
 * playback from the cam's silence prelude — see the "Maria José" bug
 * report (sync.offsetMs ≈ +193 s, preview frozen for 3:13 then jumped).
 */

import { camSourceTimeS, type CamTimeRef } from "../../local/timing/cam-time";

export type CamPreviewAction =
  /** Cam isn't on screen yet (master playhead < cam's anchorS). */
  | { kind: "pause-before-start" }
  /** Cam's source has run out. Hold on its final frame. */
  | { kind: "pause-after-end"; sourceT: number }
  /** Cam IS on screen — seek the element to this source-time. */
  | { kind: "seek"; sourceT: number };

export interface CamPreviewSyncInput {
  /** Master-timeline position in seconds. */
  masterT: number;
  /** Combined `sync.offsetMs + syncOverrideMs` in milliseconds. */
  syncOffsetMs: number;
  /** Cam's source duration in seconds. Pass `null`/`undefined` when the
   *  duration isn't known yet (metadata still loading) — the caller
   *  treats the seek target as authoritative until it learns more. */
  sourceDurationS: number | null | undefined;
  /** Cam-clock vs master-clock ratio. Default 1. */
  driftRatio?: number;
}

/** End-of-source guard padding. Browsers fire `seeked` past `duration`
 *  inconsistently; staying 50 ms inside is enough to keep the last
 *  frame stable without losing any usable content. */
const END_GUARD_S = 0.05;

export function decideCamPreviewAction(
  input: CamPreviewSyncInput,
): CamPreviewAction {
  const ref: CamTimeRef = {
    // Positive sync offset → cam started before master t=0 → masterStartS
    // is negative (anchor sits to the LEFT of master t=0).
    masterStartS: -input.syncOffsetMs / 1000,
    driftRatio: input.driftRatio ?? 1,
  };
  const sourceT = camSourceTimeS(input.masterT, ref);

  if (sourceT < 0) return { kind: "pause-before-start" };

  const dur = input.sourceDurationS ?? null;
  if (dur != null && dur > 0 && sourceT > dur - END_GUARD_S) {
    return { kind: "pause-after-end", sourceT: Math.max(0, dur - END_GUARD_S) };
  }
  return { kind: "seek", sourceT };
}
