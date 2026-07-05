/**
 * Pure snap helper. Used by every drag handler in the timeline (playhead,
 * cam-clip move, trim handles, cut-set) so snap behaviour is consistent
 * regardless of *how* the user changes a time value.
 *
 * The grid is anchored at `beatPhase` (= where beat 0 sits). Bar-level
 * snaps use `beatsPerBar` (default 4) and an optional `barOffsetBeats`
 * pickup so a song with anacrusis still snaps to its actual downbeats.
 * Sub-beat snaps (1/4, 1/8, 1/16) ignore the bar machinery — they're
 * fractions of a beat and rest on `beatPhase` directly.
 */

export type SnapMode = "off" | "match" | "1" | "1/2" | "1/4" | "1/8" | "1/16";

export interface SnapCtx {
  /** BPM as detected (or user-overridden). null disables grid modes. */
  bpm: number | null;
  /** Time of beat 0 in seconds. Sub-beat grids are anchored here; bar-
   *  level grids are anchored at `beatPhase + barOffsetBeats * beatPeriod`. */
  beatPhase: number;
  /** Beats per bar (4/4 → 4, 3/4 → 3, …). Default 4. Only affects bar
   *  and half-bar snap. */
  beatsPerBar?: number;
  /** Anacrusis / pickup, in beats. 0 by default. Shifts the bar anchor
   *  forward by `n * beatPeriod` so a 2-beat pickup in 4/4 lands bar 1
   *  on the third detected beat. */
  barOffsetBeats?: number;
  /** When in "match" mode, the candidate positions in master-timeline
   *  seconds that the cursor should snap to. */
  candidatePositions?: number[];
  /** Snap threshold for "match" mode (seconds). Default 0.25 s — generous
   *  so the user finds the candidate even with shaky pointer movement. */
  matchThresholdS?: number;
}

const DEFAULT_MATCH_THRESHOLD_S = 0.25;
const DEFAULT_BEATS_PER_BAR = 4;

/** Convert a SnapMode to its grid-step length in seconds, or null if the
 *  mode doesn't define a fixed step (off / match). */
export function gridStepSeconds(
  mode: SnapMode,
  bpm: number | null,
  beatsPerBar: number = DEFAULT_BEATS_PER_BAR,
): number | null {
  if (!bpm || bpm <= 0 || !Number.isFinite(bpm)) return null;
  const beatS = 60 / bpm;
  const bpb = beatsPerBar > 0 ? beatsPerBar : DEFAULT_BEATS_PER_BAR;
  switch (mode) {
    case "1":
      return beatS * bpb;
    case "1/2":
      return (beatS * bpb) / 2;
    case "1/4":
      return beatS;
    case "1/8":
      return beatS / 2;
    case "1/16":
      return beatS / 4;
    default:
      return null;
  }
}

/** Snap a time `t` (seconds) to the active grid / candidate set. */
export function snapTime(t: number, mode: SnapMode, ctx: SnapCtx): number {
  if (mode === "off") return t;

  if (mode === "match") {
    const list = ctx.candidatePositions;
    if (!list || list.length === 0) return t;
    const thr = ctx.matchThresholdS ?? DEFAULT_MATCH_THRESHOLD_S;
    let best = t;
    let bestDist = thr;
    for (const c of list) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  // Grid modes.
  const bpb = ctx.beatsPerBar ?? DEFAULT_BEATS_PER_BAR;
  const step = gridStepSeconds(mode, ctx.bpm, bpb);
  if (step === null) return t;

  // Bar/half-bar grids ride on the bar anchor (= beat 0 + pickup);
  // sub-beat grids ride on beat 0 directly. Without that split the
  // pickup would offset the 1/4 grid too, which is musically wrong —
  // pickup beats are real beats, only the *bar count* is shifted.
  const beatPhase = ctx.beatPhase ?? 0;
  const barLevel = mode === "1" || mode === "1/2";
  let anchor = beatPhase;
  if (barLevel && ctx.bpm && ctx.bpm > 0) {
    const offset = ctx.barOffsetBeats ?? 0;
    anchor = beatPhase + offset * (60 / ctx.bpm);
  }
  const k = Math.round((t - anchor) / step);
  return anchor + k * step;
}
