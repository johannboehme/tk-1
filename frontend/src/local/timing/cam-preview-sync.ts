/**
 * Pure decision function for CamPreview's per-tick video-element sync.
 *
 * Given a master-timeline second and the cam's sync metadata, returns
 * what the preview should do: pause (cam hasn't started yet, or the
 * source has run out), seek (snap to a specific source-time), or hold
 * (let the element play naturally — small natural drift is fine).
 *
 * Sign convention follows `local/timing/cam-time.ts` and `clipRangeS`
 * in `editor/types.ts`: `sync.offsetMs > 0` means the cam started
 * recording BEFORE master t=0 (pre-roll), so at master t=0 the cam is
 * already at source-time `+offsetMs/1000`. The previous formula
 * `sourceT = masterT − offsetMs/1000` had the sign flipped, which
 * froze the preview for the entire pre-roll window and then started
 * playback from the cam's silence prelude — see the "Maria José" bug
 * report (sync.offsetMs ≈ +193 s, preview frozen for 3:13 then jumped).
 *
 * Stutter avoidance: native `<video>` decodes from the closest keyframe
 * after every `currentTime = X`. On a multi-GB phone recording that
 * takes 100–400 ms, during which the audio playhead keeps advancing.
 * If we re-issue a seek every tick because `|video.currentTime − sourceT|`
 * exceeds a tight threshold, we tear the decoder open every frame and
 * playback never recovers. Strategy:
 *   • Master jumps (user click, loop wrap, focusChunk): always seek
 *     with a precise threshold — these are user-meaningful resyncs.
 *   • Natural advance: only correct catastrophic drift, otherwise hold
 *     and let the element play freely. Browsers keep audio + a muted
 *     `<video>` close enough on their own clock for triage purposes,
 *     and small natural drift is invisible.
 *   • Caller is expected to skip the action when `videoEl.seeking` so
 *     we don't stack seeks on a still-decoding element.
 */

import { camSourceTimeS, type CamTimeRef } from "./cam-time";

export type CamPreviewAction =
  /** Cam isn't on screen yet (master playhead < cam's anchorS). */
  | { kind: "pause-before-start" }
  /** Cam's source has run out. Hold on its final frame. */
  | { kind: "pause-after-end"; sourceT: number }
  /** Drift is small and tick was a natural advance — let the element
   *  play through without re-seeking. Caller MUST NOT touch
   *  `videoEl.currentTime`. */
  | { kind: "hold"; sourceT: number }
  /** Cam IS on screen and a hard `currentTime = sourceT` is required. */
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
  /** The video element's last reported `currentTime` (in source-time
   *  seconds). Pass `null` when the element hasn't reported a time yet
   *  (initial tick) — the caller will get a `seek` so the element
   *  snaps to the current target on first contact. */
  videoCurrentTimeS: number | null;
  /** Master-time at the previous tick. `null` on the first tick. Used
   *  to classify the tick: a meaningful jump (focusChunk, loop wrap,
   *  scrub) versus a natural ~16 ms forward advance. */
  prevMasterT: number | null;
}

/** End-of-source guard padding. Browsers fire `seeked` past `duration`
 *  inconsistently; staying 50 ms inside is enough to keep the last
 *  frame stable without losing any usable content. */
const END_GUARD_S = 0.05;

/** Forward jump above this counts as user-initiated (chunk-list click,
 *  scrub, focusRelative). Natural RAF-driven advance is ≤ ~16 ms; even
 *  a sleepy tab returning typically advances by < 100 ms before the
 *  audio's RAF resumes. 500 ms sits comfortably between those regimes. */
const JUMP_FORWARD_S = 0.5;

/** Any backward delta beyond this threshold counts as a jump. (Loop
 *  wrap goes from chunk.endMs → chunk.startMs — sharply backward. Tiny
 *  backward jitter from `<audio>.currentTime` reading at slightly
 *  different points during a tick should NOT trip this.) */
const JUMP_BACKWARD_S = 0.02;

/** Drift threshold on a "this is a jump" tick — tight, the user
 *  expects the preview to be at the right frame after they click. */
const JUMP_DRIFT_THRESHOLD_S = 0.05;

/** Drift threshold during natural advance. Generous — the browser
 *  keeps audio + video closely aligned via its own clock; we only
 *  step in for catastrophic drift (e.g. tab throttle aftermath, long
 *  GC pause). Anything smaller than this is below perception and
 *  corrects itself as the element keeps decoding forward. */
const NATURAL_DRIFT_THRESHOLD_S = 0.5;

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

  // First contact (or element hasn't reported a time yet) → snap once.
  if (input.videoCurrentTimeS == null || input.prevMasterT == null) {
    return { kind: "seek", sourceT };
  }

  const drift = Math.abs(input.videoCurrentTimeS - sourceT);
  const masterDelta = input.masterT - input.prevMasterT;
  const isJump =
    masterDelta > JUMP_FORWARD_S || masterDelta < -JUMP_BACKWARD_S;

  if (isJump) {
    return drift > JUMP_DRIFT_THRESHOLD_S
      ? { kind: "seek", sourceT }
      : { kind: "hold", sourceT };
  }
  return drift > NATURAL_DRIFT_THRESHOLD_S
    ? { kind: "seek", sourceT }
    : { kind: "hold", sourceT };
}
