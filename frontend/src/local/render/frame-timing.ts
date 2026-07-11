/**
 * Frame planning + output-timestamp math for the segment export loop.
 *
 * Why cumulative targets (issue #107): the exported audio is the master
 * PCM cut sample-exactly per segment and concatenated, so its length is
 * (to within one sample) the exact kept duration. If the video loop
 * emits `round(segDur * fps)` frames per segment INDEPENDENTLY, every
 * segment contributes up to ±1/(2·fps) of A/V offset — and long-form
 * arrangements are made of dozens of chunks with IDENTICAL bar-grid
 * durations, so the errors all round the same direction and add up
 * (~16.7 ms per chunk at 30 fps → audible lip-sync error within ~3
 * boundaries, ~0.5 s after 30). Planning against the cumulative kept
 * duration makes per-segment errors cancel: the video length tracks the
 * audio length within half a frame at EVERY boundary, forever.
 *
 * Pure, no IO — unit-tested in frame-timing.test.ts.
 */

/**
 * Per-segment output frame counts such that after segment k the total
 * emitted frames equal `round(cumulativeKeptS(k) * fps)`. Segments with
 * non-positive duration get 0 frames. Counts are never negative.
 */
export function planSegmentFrames(
  segments: readonly { in: number; out: number }[],
  fps: number,
): number[] {
  const counts: number[] = [];
  let keptS = 0;
  let framesPlanned = 0;
  for (const seg of segments) {
    keptS += Math.max(0, seg.out - seg.in);
    const target = Math.round(keptS * fps);
    const n = Math.max(0, target - framesPlanned);
    counts.push(n);
    framesPlanned += n;
  }
  return counts;
}

/**
 * Output timestamp (µs) of frame `frameIndex` at `fps`. Rounds the
 * EXACT product instead of multiplying a pre-rounded per-frame duration
 * — `k * round(1e6/fps)` truncates 33333.33 µs to 33333 µs at 30 fps
 * and drifts ~18 ms per 30 min of output.
 */
export function outputTimestampUs(frameIndex: number, fps: number): number {
  return Math.round((frameIndex * 1_000_000) / fps);
}
