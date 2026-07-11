/**
 * Shared time-mapping primitives. Both the live preview and the offline
 * render *must* call these — anywhere we ask "given a master-timeline
 * second, which source frame of which cam should be on screen?" we go
 * through `camSourceTimeS`. That way the preview the user finetunes
 * against and the file that comes out of the render produce the same
 * frame at the same master-time, by construction.
 *
 * Sign + drift convention:
 *
 *   masterStartS — where this cam's source-time 0 lands on the master
 *                  timeline. Negative when the cam started recording
 *                  before the master audio ("pre-roll"), positive when
 *                  the cam started later. Computed in `clipRangeS()`
 *                  and mirrored in jobs.ts when building render input.
 *
 *   driftRatio   — how the cam's recording clock relates to the master.
 *                  driftRatio > 1 means the cam recorded *more* source-
 *                  seconds than the master in the same wall-clock period
 *                  — i.e. cam clock ran faster than master clock. So at
 *                  master-time T the cam is at source-time
 *                  `(T − masterStartS) · driftRatio`.
 *
 * The whole pipeline treats master audio as the canonical timeline.
 * Cam lookups bend to it; the audio is never time-stretched. This is
 * the only sane choice for multi-cam where each cam can carry a
 * different driftRatio.
 */

export interface CamTimeRef {
  /** Position of this cam's source-time 0 on the master timeline (seconds). */
  masterStartS: number;
  /** Cam-clock vs. master-clock ratio. Default 1 = no drift. */
  driftRatio: number;
}

/**
 * Source-time of `cam` corresponding to a given master-timeline second.
 *
 * Pure. Always callable. The caller decides what to do when the result
 * lies outside the cam's `[0, sourceDurationS]` range — typical behaviour
 * is to fall back to a placeholder frame, but this helper doesn't impose
 * that policy.
 */
export function camSourceTimeS(masterT: number, cam: CamTimeRef): number {
  return (masterT - cam.masterStartS) * cam.driftRatio;
}

/**
 * Microsecond version for callers that talk to WebCodecs / mp4-muxer.
 * Rounds down to a whole microsecond — VideoFrame timestamps are integer
 * micros, and dropping the fractional part keeps "next frame at or
 * before this time" lookups idempotent at hop boundaries.
 */
export function camSourceTimeUs(masterT: number, cam: CamTimeRef): number {
  return Math.floor(camSourceTimeS(masterT, cam) * 1_000_000);
}
