/**
 * Translate an `arrangement[]` (with `chunks[]` lookup) into a list of
 * master-time segments that can drop straight into `EditSpec.segments`
 * and into the editor's segment-aware `useAudioMaster` walker.
 *
 * One arrangement-item → one segment with `{in, out}` from the chunk's
 * master-time bounds. Duplicates (same chunkId appearing N times in the
 * arrangement) become N independent segments — the renderer concatenates
 * them in order, so playing the same chunk twice yields the same audio
 * twice in the output. Identical-content segments are NOT coalesced
 * (the user's intent is to repeat them, not to over-decode and skip).
 *
 * Pure function — no IO.
 */
import type { ArrangementItem, Chunk } from "../../storage/jobs-db";
import type { Segment } from "../../editor/types";

export interface ChunkSegmentOptions {
  /** Trim end-of-chunk by this many ms before the segment cuts to next.
   *  Used to avoid the silence gap at chunk boundaries leaking through
   *  the audio crossfade — the chunk-detector is generous on minPause,
   *  so the natural endpoint of a chunk often has a fade-tail. Default 0. */
  endTrimMs?: number;
}

/** Convert an arrangement into a flat array of segments. */
export function arrangementToSegments(
  arrangement: readonly ArrangementItem[],
  chunks: readonly Chunk[],
  opts: ChunkSegmentOptions = {},
): Segment[] {
  const lookup = new Map(chunks.map((c) => [c.id, c]));
  const segments: Segment[] = [];
  const endTrimS = (opts.endTrimMs ?? 0) / 1000;
  for (const item of arrangement) {
    const ck = lookup.get(item.chunkId);
    if (!ck) continue;
    const inS = ck.startMs / 1000;
    const outS = ck.endMs / 1000 - endTrimS;
    if (outS <= inS) continue;
    segments.push({ in: inS, out: outS });
  }
  return segments;
}

/** Sum the length of all segments in seconds. Useful for the editor's
 *  "total output time" readouts and for the LCD on the arrange page. */
export function totalSegmentDurationS(segments: readonly Segment[]): number {
  let total = 0;
  for (const seg of segments) total += Math.max(0, seg.out - seg.in);
  return total;
}
