/**
 * Pure helpers for the timeline's MATCH snap mode.
 *
 * Each cam's `candidates[]` are alternative *global offsets* the WASM
 * matcher considered. In the editor we project them into master-timeline
 * start-positions (so the user can drag a clip and snap onto where it
 * would land if the matcher had picked candidate `k` instead of the
 * top-confidence one). After a snap, we update `selectedCandidateIdx`
 * (which mirrors `syncOffsetMs`) and zero out `startOffsetS` so the cam
 * sits exactly on the candidate's implied position.
 */
import type { MatchCandidate, VideoClip } from "../core/types";

/** Default threshold for filtering low-confidence candidates *when the
 *  caller asks for filtering*. The default in the helpers themselves is
 *  no filtering — callers opt in via `confidenceThreshold`. Lowered to
 *  0.2 because the WASM matcher's sample-level Pearson scores often sit
 *  in the 0.2–0.4 range even for plausible alternates; a stricter cut
 *  was hiding real candidates. */
export const DEFAULT_MATCH_CONFIDENCE_THRESHOLD = 0.2;
const DEFAULT_NEAREST_THRESHOLD_S = 0.4;

export interface MatchPosition {
  /** Index back into `clip.candidates`. Stable even when filtering. */
  idx: number;
  /** Master-timeline start position (seconds) the clip would assume if
   *  this candidate were selected with no extra startOffset. */
  startS: number;
}

export interface BuildMatchPositionsOpts {
  /** Drop candidates below this confidence (0..1). Default: 0.25. */
  confidenceThreshold?: number;
}

export function filterCandidatesByConfidence(
  candidates: MatchCandidate[],
  threshold: number = DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
): MatchCandidate[] {
  return candidates.filter((c) => c.confidence >= threshold);
}

/** Compute the start-positions implied by the cam's candidates, given
 *  the user's current syncOverrideMs (which stays applied on top of
 *  whichever candidate is chosen). Pass `confidenceThreshold` to drop
 *  weak candidates (default: keep all). */
export function buildClipMatchPositions(
  clip: VideoClip,
  opts: BuildMatchPositionsOpts = {},
): MatchPosition[] {
  const thr = opts.confidenceThreshold ?? 0;
  const out: MatchPosition[] = [];
  for (let i = 0; i < clip.candidates.length; i++) {
    const c = clip.candidates[i];
    if (c.confidence < thr) continue;
    const totalMs = c.offsetMs + clip.syncOverrideMs;
    out.push({ idx: i, startS: -totalMs / 1000 });
  }
  return out;
}

/** Return the candidate idx whose start-position is closest to `t`,
 *  or null if no candidate is within `thresholdS`. */
export function candidateIdxNearestStart(
  positions: MatchPosition[],
  t: number,
  thresholdS: number = DEFAULT_NEAREST_THRESHOLD_S,
): number | null {
  let bestIdx: number | null = null;
  let bestDist = thresholdS;
  for (const p of positions) {
    const d = Math.abs(p.startS - t);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = p.idx;
    }
  }
  return bestIdx;
}
