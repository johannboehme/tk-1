/**
 * Pure bar-grid helpers used by chunk-detection (auto-bar-align after
 * detection) and by the Triage store (Conform action). Kept in their own
 * file so callers that only need the math don't pull in `chunk-detect.ts`'s
 * WASM imports.
 */

/** Below this chunk length the autocorrelation tempo detector tends to
 *  lock onto sub-bar harmonics. Threshold detection still finds the
 *  chunk; we just skip the BPM step. */
export const MIN_CHUNK_MS_FOR_BPM = 4_000;

/** Snap a chunk's `endMs` down to the nearest whole-bar boundary anchored
 *  on its first onset (`audioStartMs`). Chunks already start on a
 *  downbeat by construction (the Triage bar-grid is anchored on
 *  `audioStartMs`); this aligns the END so a default-Triage handoff
 *  produces fully bar-aligned segments without the user having to
 *  hand-trim each chunk in/out marker. Returns the original `endMs`
 *  when bpm is unavailable, when the snap would collapse the chunk
 *  below half a bar, or when the chunk is too short for at least one
 *  bar. */
export function snapChunkEndToBar(
  startMs: number,
  endMs: number,
  audioStartMs: number,
  bpm: number | undefined,
  beatsPerBar: number,
): number {
  if (!bpm || bpm <= 0) return endMs;
  const barMs = (60_000 / bpm) * beatsPerBar;
  if (!Number.isFinite(barMs) || barMs <= 0) return endMs;
  // The chunk must contain at least one full bar past the first onset
  // for a bar-snap to be meaningful — otherwise we'd snap it to its
  // own start and effectively kill the chunk. Fall back to raw endMs.
  if (endMs - audioStartMs < barMs) return endMs;
  // FP epsilon: at non-power-of-two BPMs (e.g. 180 → 1333.33 ms/bar)
  // a chunk that's exactly N bars long can divide to N − 1e-4 or so.
  // Without the bias, every Conform on an already-snapped chunk would
  // shed one bar from the end. The bias is small enough that it can't
  // cross a real bar boundary.
  const FP_BIAS = 1e-3;
  const barsPastFirstBeat = Math.floor((endMs - audioStartMs) / barMs + FP_BIAS);
  const snapped = audioStartMs + barsPastFirstBeat * barMs;
  // Defensive lower bound — never snap below `startMs + half a bar`,
  // even when audioStartMs is past the chunk's loud region's center
  // (rare but possible in noisy detections).
  if (snapped <= startMs + barMs / 2) return endMs;
  return Math.round(snapped);
}
