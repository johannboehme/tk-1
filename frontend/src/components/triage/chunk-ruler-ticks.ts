/**
 * Triage-side projections of the canonical bar/beat grid builder
 * (`editor/components/timeline/beat-ruler-ticks.ts`). Both Triage rulers
 * anchor bar 1 on the focused chunk's own audio-start onset (chunks start
 * on a downbeat by construction) and project the grid across the whole
 * window so outward trims have visible snap targets.
 */
import {
  buildRulerTicks,
  type RulerTick,
} from "../../editor/components/timeline/beat-ruler-ticks";
import {
  chunkBeatPhaseS,
  effectiveChunkBpm,
} from "../../local/triage/triage-store";

/** The chunk fields the grid needs — satisfied by `Chunk`. */
export interface ChunkGridSource {
  startMs: number;
  endMs: number;
  audioStartMs?: number;
  detectedBpm?: number;
  effectiveBpm: number;
}

/** Full-detail grid for one chunk: adaptive label stride, beats and
 *  1/8–1/16 subdivisions by zoom, `extension` on ticks outside the
 *  chunk's half-open [startMs, endMs) span. */
export function buildChunkGridTicks(
  chunk: ChunkGridSource,
  jobBpm: number | null,
  beatsPerBar: number,
  startS: number,
  endS: number,
  pxPerSec: number,
): RulerTick[] {
  const bpm = effectiveChunkBpm(chunk, jobBpm);
  if (bpm <= 0 || beatsPerBar <= 0) return [];
  return buildRulerTicks({
    bpm,
    beatPhase: chunkBeatPhaseS(chunk),
    startS,
    endS,
    pxPerSec,
    beatsPerBar,
    extendBeforePhase: true,
    labelStride: "auto",
    extensionSpan: { startS: chunk.startMs / 1000, endS: chunk.endMs / 1000 },
  });
}

export interface SeamTick {
  tS: number;
  downbeat: boolean;
  /** Bar number — only on stride-labeled downbeats. */
  bar: number | null;
}

/** SeamStrip's slim ruler: the same grid reduced to downbeats + beats
 *  (no 1/8–1/16 clutter in the 14 px lane header). */
export function buildSeamBarTicks(
  chunk: ChunkGridSource,
  jobBpm: number | null,
  beatsPerBar: number,
  winStartS: number,
  winEndS: number,
  pxPerSec: number,
): SeamTick[] {
  return buildChunkGridTicks(
    chunk,
    jobBpm,
    beatsPerBar,
    winStartS,
    winEndS,
    pxPerSec,
  )
    .filter((t) => t.kind === "bar" || t.kind === "beat")
    .map((t) => ({
      tS: t.t,
      downbeat: t.kind === "bar",
      bar: t.kind === "bar" && t.labeled ? (t.barNumber ?? null) : null,
    }));
}
