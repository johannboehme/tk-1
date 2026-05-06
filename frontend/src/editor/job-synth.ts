/**
 * Synthesize the editor's `arrangement / chunks / arrangementSegments`
 * triple from a `LocalJob`. The editor walks every job through the same
 * data model — long-form jobs use their persisted arrangement, single-take
 * jobs get a synthetic single-segment shape covering the full master
 * audio. Once that shape lands in the store, every helper in the editor
 * (segment walker, pill generator, time projections, loop clamping) runs
 * a single mode-agnostic path.
 *
 * Pure function — no IO, no React.
 */
import type { ArrangementItem, Chunk, LocalJob } from "../storage/jobs-db";
import { arrangementToSegments } from "../local/arrange/chunks-to-segments";
import type { Segment } from "./types";

/** Stable arrangement-item id for the synthetic single-take wrapper.
 *  Pill ids are `${camId}::${arrangementItemId}` ([arrangement-pills.ts]),
 *  so this MUST stay `__default__` to keep persisted pill edits on
 *  pre-refactor direct-mode jobs round-tripping after the unification. */
export const SYNTHETIC_ITEM_ID = "__default__";

/** Stable chunk id paired with the synthetic item. Distinct from
 *  `SYNTHETIC_ITEM_ID` because arrangement-item ids and chunk ids are
 *  separate namespaces in long-form. */
export const SYNTHETIC_CHUNK_ID = "__default_chunk__";

export interface JobLoadShape {
  arrangementSegments: Segment[];
  arrangement: ArrangementItem[];
  chunks: Chunk[];
}

export function synthesizeJobLoadShape(
  j: LocalJob,
  durationS: number,
): JobLoadShape {
  const isLongform =
    j.mode === "longform" &&
    Array.isArray(j.arrangement) &&
    j.arrangement.length > 0;

  if (isLongform) {
    const arrangement = j.arrangement!;
    const chunks = j.chunks ?? [];
    return {
      arrangementSegments: arrangementToSegments(arrangement, chunks),
      arrangement,
      chunks,
    };
  }

  const safeDur = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  return {
    arrangementSegments: [{ in: 0, out: safeDur }],
    arrangement: [{ id: SYNTHETIC_ITEM_ID, chunkId: SYNTHETIC_CHUNK_ID }],
    chunks: [
      {
        id: SYNTHETIC_CHUNK_ID,
        startMs: 0,
        endMs: Math.round(safeDur * 1000),
        bpmOctaveShift: 0,
        effectiveBpm: 0,
        beatsPerBar: 4,
        accepted: true,
        trimMode: "free",
      },
    ],
  };
}
