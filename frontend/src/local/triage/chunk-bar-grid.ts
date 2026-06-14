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
  // Snap-up slop. Two systematic effects make a chunk that is musically
  // exactly N bars long measure a hair SHORT of N·barMs here, which would
  // wrongly shed its last bar:
  //   - `audioStartMs` is the first onset dated at its STFT window CENTER
  //     (≈ +46 ms at sr=22050), while the raw `endMs` is a silence
  //     boundary with no such offset — so (endMs − audioStartMs) runs ~46 ms
  //     short of the true content span.
  //   - silence trimming and FP division shave a few more ms.
  // Absorb a fixed 60 ms (expressed in bars) before flooring. 60 ms is
  // shorter than a 32nd note at any sane tempo, so it can never promote a
  // chunk across a *real* bar boundary (that needs > half a bar of audio);
  // it only rescues a chunk that already fills ~all of its last bar. Also
  // keeps Conform idempotent: re-snapping an already-snapped chunk lands on
  // the same bar instead of shedding one each pass.
  const SNAP_SLOP_MS = 60;
  const biasBars = SNAP_SLOP_MS / barMs;
  const barsPastFirstBeat = Math.floor((endMs - audioStartMs) / barMs + biasBars);
  const snapped = audioStartMs + barsPastFirstBeat * barMs;
  // Defensive lower bound — never snap below `startMs + half a bar`,
  // even when audioStartMs is past the chunk's loud region's center
  // (rare but possible in noisy detections).
  if (snapped <= startMs + barMs / 2) return endMs;
  return Math.round(snapped);
}
