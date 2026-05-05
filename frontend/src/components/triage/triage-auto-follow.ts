/**
 * Auto-follow logic for the Triage timeline: when the user changes which
 * chunk is focused (via Shift+Arrow, the chunk list, or any other source
 * that mutates `focusedChunkId`), pan the timeline so the chunk is
 * visible. Don't pan if it already fits end-to-end in the current view —
 * that would yank the user's scroll position around for no reason after
 * they directly clicked a visible chunk.
 *
 * Pure function — easy to test, no React deps. The TriageTimeline
 * component wraps this in a `useEffect` keyed on `focusedChunkId`.
 */

export interface AutoFollowInput {
  /** Master-time start of the chunk to follow (seconds). */
  chunkStartS: number;
  /** Master-time end of the chunk to follow (seconds). */
  chunkEndS: number;
  /** Currently visible time window — left edge (seconds). */
  viewStartS: number;
  /** Currently visible time window — right edge (seconds). */
  viewEndS: number;
  /** Total length of the master audio (seconds). */
  audioDuration: number;
}

/**
 * Compute the new `scrollX` (left-edge time, seconds) so the focused
 * chunk is visible. Returns `null` when no scroll is needed because the
 * chunk already fits inside the view.
 *
 * Strategy:
 * - Already fully visible → null (don't disturb the view).
 * - Chunk longer than the visible window → put its start in view (so the
 *   beginning is visible; the loop region's left edge anchors the eye).
 * - Otherwise → centre the chunk in the view.
 *
 * Result is clamped to `[0, audioDuration - visibleDuration]` so we never
 * scroll past either end of the audio.
 */
export function autoFollowScrollX(input: AutoFollowInput): number | null {
  const { chunkStartS, chunkEndS, viewStartS, viewEndS, audioDuration } = input;
  const visibleDuration = viewEndS - viewStartS;
  if (!Number.isFinite(visibleDuration) || visibleDuration <= 0) return null;

  // Already fully visible — leave the view alone.
  if (chunkStartS >= viewStartS && chunkEndS <= viewEndS) return null;

  const chunkDuration = Math.max(0, chunkEndS - chunkStartS);
  let scrollX: number;
  if (chunkDuration >= visibleDuration) {
    scrollX = chunkStartS;
  } else {
    const chunkCentre = (chunkStartS + chunkEndS) / 2;
    scrollX = chunkCentre - visibleDuration / 2;
  }

  const maxScroll = Math.max(0, audioDuration - visibleDuration);
  return Math.max(0, Math.min(maxScroll, scrollX));
}
