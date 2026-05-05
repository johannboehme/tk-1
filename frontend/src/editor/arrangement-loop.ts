/**
 * Loop-region helpers that work uniformly in direct-mode (single track,
 * arr-time == master-time passthrough) and arrangement-mode (composed
 * timeline of N segments). The user thinks of the loop as in/out markers
 * on the composed "tape" — these helpers project that intent down to the
 * master-time clock the audio walker runs on.
 *
 * Pure, no IO. The walker calls `nextLoopWrapMasterT` per tick to know
 * where the next wrap fires; the store calls `clampLoopToBounds` so the
 * user can't drag a loop outside the playable region.
 */
import type { Segment } from "./types";
import type { LoopRegion, TrimRegion } from "./OffsetScheduler";
import { clampLoopRegion } from "./OffsetScheduler";
import {
  arrToMaster,
  segmentIndexAtArr,
  totalArrDuration,
} from "./arrangement-time";

export interface LoopWrapGeometry {
  /** Master-time at which the wrap fires (= arr-time of `loop.end`
   *  projected into its containing segment). */
  wrapAtMasterT: number;
  /** Master-time the idle <audio> should be parked at — where the loop
   *  re-enters playback. */
  wrapTargetMasterT: number;
  /** Index of the segment in which the wrap fires. The walker uses this
   *  to skip wrap-arming while the playhead is still in an earlier
   *  segment (segment-hop comes first). */
  wrapInSegIdx: number;
  /** Index of the segment that contains `loop.start` — used as the
   *  authoritative `nextSegmentIdx` after the crossfade swaps so the
   *  walker doesn't re-derive from master-time and pick a duplicate. */
  targetSegIdx: number;
}

/** Project an arr-time loop into master-time wrap geometry, given the
 *  current arrangement segments. Returns null when there's no loop or
 *  no segments to walk. Loop is assumed already clamped to
 *  `[0, totalArrDuration]` by `clampLoopToBounds`. */
export function nextLoopWrapMasterT(
  loop: LoopRegion | null,
  segments: readonly Segment[],
): LoopWrapGeometry | null {
  if (!loop) return null;
  if (segments.length === 0) return null;

  // Half-open intervals: arr-time exactly == totalArrDuration falls past
  // the last segment in `segmentIndexAtArr`. The wrap MUST fire inside
  // a real segment, so clamp to the last index. arrToMaster handles the
  // value side correctly (clamps to `last.out`).
  let wrapInSegIdx = segmentIndexAtArr(loop.end, segments);
  if (wrapInSegIdx === -1) wrapInSegIdx = segments.length - 1;

  let targetSegIdx = segmentIndexAtArr(loop.start, segments);
  // Symmetric guard — loop.start clamped to 0 should map to seg 0; this
  // is only here so a caller passing an unclamped loop doesn't crash.
  if (targetSegIdx === -1) targetSegIdx = 0;

  return {
    wrapAtMasterT: arrToMaster(loop.end, segments),
    wrapTargetMasterT: arrToMaster(loop.start, segments),
    wrapInSegIdx,
    targetSegIdx,
  };
}

/** Mode-aware clamp. With segments → clamp to `[0, totalArrDuration]`.
 *  Without → fall back to legacy trim-clamp. Returns null when the loop
 *  collapses to zero length. */
export function clampLoopToBounds(
  loop: LoopRegion | null,
  segments: readonly Segment[],
  trim: TrimRegion,
): LoopRegion | null {
  if (!loop) return null;
  if (segments.length === 0) return clampLoopRegion(loop, trim);
  const total = totalArrDuration(segments);
  const start = Math.max(0, loop.start);
  const end = Math.min(total, loop.end);
  if (end <= start) return null;
  return { start, end };
}
