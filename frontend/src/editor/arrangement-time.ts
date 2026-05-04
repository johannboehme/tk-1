/**
 * Arrangement-time ↔ master-time helpers.
 *
 * The long-form workflow turns a session of master-audio time (the source
 * recording's clock) into a song made of N selected segments played
 * back-to-back. The user thinks in **arrangement-time** — a continuous
 * 0..totalDuration line where every pixel is something they will hear.
 * Internally, everything that's anchored to the source media (cuts, fx,
 * cam-sync, video-element pool) stays in **master-time** because that's
 * where source frames live.
 *
 * These helpers are the only conversion point between the two clocks.
 * Pure, no IO, no React. Cheap O(N) walks over segments — the typical
 * arrangement is 5–50 segments so a binary search isn't worth the code.
 *
 * Sign + edge conventions:
 *   - Segments are master-time `{in, out}` half-open ranges (in inclusive,
 *     out exclusive); `arrangementToSegments` already enforces `out > in`.
 *   - Segments may be in any order in the array (the arrangement is the
 *     user's playback order). Master-time CAN go backwards or repeat
 *     between consecutive segments — this is the whole point of
 *     "play chunk B, then chunk A, then chunk B again".
 *   - Empty `segments` → every helper returns the input unchanged
 *     (preserves direct-mode call sites that call these unconditionally).
 *   - The output of `masterToArr` is the arr-time of the FIRST segment
 *     that contains the master-time. If the same master-time appears in
 *     multiple segments (duplicates in the arrangement), the first one's
 *     arr-time wins. Callers that need "the segment we're currently
 *     playing" should keep their own segment-index state — the walker
 *     already does.
 */
import type { Segment } from "./types";

/** Sum of all segment durations. Equals the user-visible song length. */
export function totalArrDuration(segments: readonly Segment[]): number {
  let sum = 0;
  for (const seg of segments) {
    const len = seg.out - seg.in;
    if (len > 0) sum += len;
  }
  return sum;
}

/** Convert a master-time to arrangement-time.
 *
 *  Walks segments in playback order, accumulating their lengths. Returns
 *  the arr-time at which the master-time first appears in the playback.
 *  When the master-time falls in a gap (between segments) — or before the
 *  first / after the last — returns the arr-time of the nearest segment
 *  edge, which keeps UI cursors locked to a playable position.
 *
 *  Empty `segments` → returns `masterT` unchanged.
 */
export function masterToArr(
  masterT: number,
  segments: readonly Segment[],
): number {
  if (segments.length === 0) return masterT;
  let cursor = 0;
  let nearestEdgeArr: number | null = null;
  let nearestEdgeDist = Infinity;
  for (const seg of segments) {
    const len = Math.max(0, seg.out - seg.in);
    if (masterT >= seg.in && masterT < seg.out) {
      return cursor + (masterT - seg.in);
    }
    // Track the nearest segment edge as a fallback for masterT-in-gap.
    const distIn = Math.abs(masterT - seg.in);
    if (distIn < nearestEdgeDist) {
      nearestEdgeDist = distIn;
      nearestEdgeArr = cursor;
    }
    const distOut = Math.abs(masterT - seg.out);
    if (distOut < nearestEdgeDist) {
      nearestEdgeDist = distOut;
      nearestEdgeArr = cursor + len;
    }
    cursor += len;
  }
  return nearestEdgeArr ?? cursor;
}

/** Convert an arrangement-time to master-time.
 *
 *  Walks segments accumulating lengths until we cross `arrT`; returns
 *  the master-time at that point inside the segment. Out-of-range arr-times
 *  clamp to first segment's `in` (negative arr) or last segment's `out`
 *  (past total).
 *
 *  Empty `segments` → returns `arrT` unchanged.
 */
export function arrToMaster(
  arrT: number,
  segments: readonly Segment[],
): number {
  if (segments.length === 0) return arrT;
  if (arrT <= 0) return segments[0].in;
  let cursor = 0;
  for (const seg of segments) {
    const len = Math.max(0, seg.out - seg.in);
    if (arrT < cursor + len) {
      return seg.in + (arrT - cursor);
    }
    cursor += len;
  }
  // Past the last segment — clamp to last segment's out.
  const last = segments[segments.length - 1];
  return last.out;
}

/** Find the index of the segment that contains `masterT`, or -1.
 *  When the arrangement has duplicates (same master-time in multiple
 *  segments), returns the first match. */
export function segmentIndexAtMaster(
  masterT: number,
  segments: readonly Segment[],
): number {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (masterT >= seg.in && masterT < seg.out) return i;
  }
  return -1;
}

/** Find the index of the segment that contains `arrT`, or -1.
 *  Half-open interval — arr-time exactly equal to total duration
 *  returns -1 (past last segment). Use clampArrToPlayable when you
 *  need a sticky-to-end seek. */
export function segmentIndexAtArr(
  arrT: number,
  segments: readonly Segment[],
): number {
  if (arrT < 0) return -1;
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const len = Math.max(0, segments[i].out - segments[i].in);
    if (arrT < cursor + len) return i;
    cursor += len;
  }
  return -1;
}

/** Clamp an arrangement-time to [0, totalDuration]. Useful for seek
 *  inputs that should never escape the arrangement. */
export function clampArr(
  arrT: number,
  segments: readonly Segment[],
): number {
  if (segments.length === 0) return arrT;
  const total = totalArrDuration(segments);
  if (arrT < 0) return 0;
  if (arrT > total) return total;
  return arrT;
}

/** Cumulative arrangement-time at the START of each segment. Useful when
 *  you need to draw splice marks or compute the arrangement bounds. */
export function segmentArrStarts(
  segments: readonly Segment[],
): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const seg of segments) {
    starts.push(cursor);
    cursor += Math.max(0, seg.out - seg.in);
  }
  return starts;
}

/** All arrangement-times at which `masterT` is visited during playback.
 *  Used by the timeline to draw cuts/fx that live in master-time but appear
 *  at every arr-position the audio walker plays them — i.e. once per
 *  occurrence of the chunk in the arrangement. Empty `segments` → `[masterT]`. */
export function mastersToArrAll(
  masterT: number,
  segments: readonly Segment[],
): number[] {
  if (segments.length === 0) return [masterT];
  const result: number[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = Math.max(0, seg.out - seg.in);
    if (masterT >= seg.in && masterT < seg.out) {
      result.push(cursor + (masterT - seg.in));
    }
    cursor += len;
  }
  return result;
}

/** A slice of a master-time range projected onto arrangement-time.
 *  `arrStartS`/`arrEndS` is contiguous (no gaps inside a segment), so a
 *  consumer can draw it as a single rectangle on a piece-wise-linear
 *  timeline without further math. */
export interface ArrSlice {
  masterStartS: number;
  masterEndS: number;
  arrStartS: number;
  arrEndS: number;
}

/** Project a master-time range onto arrangement-time. Returns one slice
 *  per segment the range intersects (in playback order, so duplicates of
 *  the same chunk yield N slices). Empty `segments` → a single passthrough
 *  slice that mirrors the input range to itself, which keeps direct-mode
 *  call sites unchanged. */
export function sliceByArrSegments(
  masterStartS: number,
  masterEndS: number,
  segments: readonly Segment[],
): ArrSlice[] {
  if (segments.length === 0) {
    return [
      {
        masterStartS,
        masterEndS,
        arrStartS: masterStartS,
        arrEndS: masterEndS,
      },
    ];
  }
  const slices: ArrSlice[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const len = Math.max(0, seg.out - seg.in);
    const interIn = Math.max(masterStartS, seg.in);
    const interOut = Math.min(masterEndS, seg.out);
    if (interOut > interIn) {
      const offsetIn = interIn - seg.in;
      const offsetOut = interOut - seg.in;
      slices.push({
        masterStartS: interIn,
        masterEndS: interOut,
        arrStartS: cursor + offsetIn,
        arrEndS: cursor + offsetOut,
      });
    }
    cursor += len;
  }
  return slices;
}
