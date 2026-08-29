/**
 * Playback-stall detector — the missing third failure channel of the
 * `<audio>` transport.
 *
 * The ping-pong engine's error telemetry covers exactly two cases:
 * `play()` REJECTING (autoplay policy) and the element firing `error`
 * (resource error). There is a third state neither catches: the element
 * accepts the src, fires `loadstart`, and then never delivers a byte —
 * `readyState` stays 0, `play()`'s promise stays PENDING forever (per
 * spec it only settles when playback actually starts or aborts), and no
 * `error` ever fires. Observed in the wild with a wedged Chrome media
 * pipeline: the store says "playing", the clock sits frozen, and the UI
 * has no way to tell the difference. This detector closes that gap by
 * watching the one signal that cannot lie: does the active element's
 * clock move while the store intends playback?
 *
 * Pure sample-feeder — no timers, no DOM. Callers (useAudioMaster,
 * use-pingpong-transport) drive it from a polling interval and decide
 * what a stall means for their screen. ANY clock change counts as
 * progress, including backward jumps: loop wraps and crossfade hops
 * legitimately rewind the active element's currentTime.
 */

/** Clock frozen for this long while the store says "playing" → stall.
 *  Comfortably above one polling interval and above the engine's play()
 *  startup latency (10–30 ms), well below "user reaches for the bug
 *  tracker". End-of-material races don't reach it: the walkers'
 *  end-pause timers flip isPlaying off within LEAD_TIME_S of the clock
 *  stopping. */
export const STALL_AFTER_MS = 1500;

/** How often the wiring effects sample the clock. Background-tab timer
 *  throttling can stretch this arbitrarily — harmless, because a late
 *  sample of a HEALTHY clock still differs from the previous one and
 *  resets the baseline; only a genuinely frozen clock accumulates. */
export const STALL_POLL_MS = 250;

export interface StallDetector {
  /** Feed one clock sample. Returns true when the clock has not changed
   *  for at least `stallAfterMs` of wall time. The first sample after
   *  construction/reset only establishes the baseline (never a stall). */
  sample(mediaTimeS: number, nowMs: number): boolean;
  /** Forget the baseline — call when playback intent flips so a pause →
   *  play cycle re-arms cleanly instead of inheriting a stale window. */
  reset(): void;
}

export function createStallDetector(
  stallAfterMs: number = STALL_AFTER_MS,
): StallDetector {
  let lastT: number | null = null;
  let lastChangeAtMs = 0;
  return {
    sample(mediaTimeS, nowMs) {
      if (lastT === null || mediaTimeS !== lastT) {
        lastT = mediaTimeS;
        lastChangeAtMs = nowMs;
        return false;
      }
      return nowMs - lastChangeAtMs >= stallAfterMs;
    },
    reset() {
      lastT = null;
      lastChangeAtMs = 0;
    },
  };
}
