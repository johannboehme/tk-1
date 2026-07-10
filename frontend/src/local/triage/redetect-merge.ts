/**
 * Re-detection merge — reconciles a freshly detected chunk list against
 * the chunks the user has been curating.
 *
 * Why this exists: the Threshold / Min-pause sliders re-run silence
 * detection on the cached envelope. The envelope is quantized at 10 Hz,
 * so ANY parameter change moves nearly every chunk edge by at least one
 * 100 ms sample — an exact-boundary match would treat every re-detected
 * chunk as brand new, resurrecting DROPped chunks, wiping KEEPs, and
 * (via the persist hook's id-based arrangement diff) emptying the
 * user's film strip. Instead we match by overlap:
 *
 *   - Detector-born chunks (`trimMode === "auto"`): each fresh chunk is
 *     matched to the auto chunk it overlaps most (greedy, biggest
 *     overlap first, each side matched at most once). A match requires
 *     the overlap to cover at least half of the shorter of the two —
 *     less than that is a different region, not a shifted boundary.
 *     Matched fresh chunks inherit id / accepted / bpmOctaveShift, and
 *     fall back to the prev chunk's analysis (BPM, bar-grid anchor)
 *     when the fresh detection ran without PCM.
 *   - User-shaped chunks (`trimMode !== "auto"`: manual trims, splits,
 *     joins, slices, inserts, conforms) are preserved verbatim. Fresh
 *     chunks that substantially overlap one are dropped — the user has
 *     already curated that region and their version wins.
 *   - Fresh chunks with no counterpart are genuinely new regions and
 *     come in as the detector made them (accepted, fresh id).
 *   - Prev auto chunks with no fresh counterpart vanished from the
 *     segmentation and are removed.
 *
 * Pure function — no store access, no IO.
 */
import type { Chunk } from "../../storage/jobs-db";

/** Overlap (ms) between two chunks; 0 when disjoint. */
function overlapMs(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function lengthMs(c: { startMs: number; endMs: number }): number {
  return Math.max(0, c.endMs - c.startMs);
}

/** A chunk the user has shaped by hand — trim, split, join, slice,
 *  insert or conform all leave `trimMode !== "auto"`; only detector
 *  output (and Reset) carries "auto". */
export function isUserShapedChunk(c: Chunk): boolean {
  return c.trimMode !== "auto";
}

/** Minimum share of the SHORTER chunk that must be covered for a fresh
 *  detector chunk to count as "the same chunk, boundaries shifted". */
const MATCH_MIN_OVERLAP_FRACTION = 0.5;

/** A fresh chunk is dropped in favour of an overlapping user-shaped
 *  chunk when the overlap covers at least this share of the fresh
 *  chunk … */
const USER_OCCUPIED_FRESH_FRACTION = 0.25;
/** … or at least this share of the user chunk (the fresh chunk swallows
 *  the user's curated region). */
const USER_OCCUPIED_USER_FRACTION = 0.5;

export function mergeRedetectedChunks(
  prevChunks: readonly Chunk[],
  freshChunks: readonly Chunk[],
): Chunk[] {
  const userShaped = prevChunks.filter(isUserShapedChunk);
  const autoPrev = prevChunks.filter((c) => !isUserShapedChunk(c));

  // 1. Fresh chunks that land on a user-curated region are dropped —
  //    the user's version of that region wins verbatim.
  const contested = (fresh: Chunk): boolean =>
    userShaped.some((u) => {
      const ov = overlapMs(fresh, u);
      if (ov <= 0) return false;
      return (
        ov >= USER_OCCUPIED_FRESH_FRACTION * lengthMs(fresh) ||
        ov >= USER_OCCUPIED_USER_FRACTION * lengthMs(u)
      );
    });
  const candidates = freshChunks.filter((f) => !contested(f));

  // 2. Greedy max-overlap matching between fresh candidates and prev
  //    auto chunks. Biggest overlap first so the dominant half of a
  //    split region inherits the identity; each side matches once.
  interface Pair {
    freshIdx: number;
    prevIdx: number;
    overlap: number;
  }
  const pairs: Pair[] = [];
  for (let fi = 0; fi < candidates.length; fi++) {
    for (let pi = 0; pi < autoPrev.length; pi++) {
      const ov = overlapMs(candidates[fi], autoPrev[pi]);
      if (ov <= 0) continue;
      const shorter = Math.min(lengthMs(candidates[fi]), lengthMs(autoPrev[pi]));
      if (shorter <= 0 || ov < MATCH_MIN_OVERLAP_FRACTION * shorter) continue;
      pairs.push({ freshIdx: fi, prevIdx: pi, overlap: ov });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);
  const matchedFresh = new Map<number, number>(); // freshIdx → prevIdx
  const takenPrev = new Set<number>();
  for (const p of pairs) {
    if (matchedFresh.has(p.freshIdx) || takenPrev.has(p.prevIdx)) continue;
    matchedFresh.set(p.freshIdx, p.prevIdx);
    takenPrev.add(p.prevIdx);
  }

  // 3. Assemble: user chunks verbatim + fresh chunks (with carried-over
  //    identity/decisions where matched).
  const merged: Chunk[] = candidates.map((fresh, fi) => {
    const prevIdx = matchedFresh.get(fi);
    if (prevIdx === undefined) return fresh;
    return carryOver(autoPrev[prevIdx], fresh);
  });

  const out = [...userShaped, ...merged];
  // Defensive id dedup: a fresh chunk born with the same boundary-derived
  // id as a surviving prev chunk (rare, but possible when a trimmed chunk
  // kept its birth id) must not produce duplicate keys. User chunks are
  // first in `out`, so they win.
  const seen = new Set<string>();
  const deduped = out.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return deduped.sort((a, b) => a.startMs - b.startMs);
}

/** Fresh geometry wins (the detector's new parameters legitimately
 *  reshape untouched chunks), but identity + the user's decisions and —
 *  when the fresh detection ran without PCM — the prev analysis carry
 *  over. */
function carryOver(prev: Chunk, fresh: Chunk): Chunk {
  return {
    ...fresh,
    id: prev.id,
    accepted: prev.accepted,
    bpmOctaveShift: prev.bpmOctaveShift,
    detectedBpm: fresh.detectedBpm ?? prev.detectedBpm,
    detectedBpmConfidence: fresh.detectedBpm
      ? fresh.detectedBpmConfidence
      : prev.detectedBpmConfidence,
    detectedBpmStability: fresh.detectedBpm
      ? fresh.detectedBpmStability
      : prev.detectedBpmStability,
    effectiveBpm: fresh.detectedBpm ? fresh.effectiveBpm : prev.effectiveBpm,
    audioStartMs: fresh.detectedBpm ? fresh.audioStartMs : prev.audioStartMs ?? fresh.audioStartMs,
  };
}
