/**
 * Long-form Triage: chunk-detection orchestration.
 *
 * Given a decoded master-audio PCM, produces a list of `Chunk` candidates —
 * contiguous loud regions separated by user-controllable silence gaps,
 * each annotated with its own audio-start onset + detected tempo.
 *
 * Why per-chunk and not whole-file detection: long-form sessions are
 * built out of independent musical fragments — sample tests, finger
 * drumming, time-stretched loops — so running tempo detection on the
 * whole audio gets averaged into noise. Each chunk is its own self-
 * contained musical phrase; detect there, then aggregate. The mode of
 * the per-chunk BPMs becomes the song's global tempo (the user can
 * override it). Per-chunk values stay around so the user can flag
 * outliers (octave-shift the detector got wrong, etc.).
 *
 * Chunks are NOT timeline-aligned to each other — each has its own
 * `audioStartMs`, the master-time offset where its first downbeat
 * actually lands. The bar grid in the Triage UI is drawn per-chunk
 * anchored at that point.
 *
 * Pipeline:
 *   1. RMS envelope at 10 Hz (WASM, ~36 K samples for 1 h of audio)
 *   2. Silence-segments via WASM
 *   3. Per-chunk `analyzeAudio()` on the PCM slice → tempo + audioStart
 *      (skipped for chunks below MIN_CHUNK_MS_FOR_BPM)
 *
 * Pure function — no IO, no DOM, no Worker.
 */

import { analyzeAudio } from "../render/audio-analysis/analyze";
import type { Chunk, SilenceConfig } from "../../storage/jobs-db";
import { MIN_CHUNK_MS_FOR_BPM, snapChunkEndToBar } from "./chunk-bar-grid";

export { MIN_CHUNK_MS_FOR_BPM, snapChunkEndToBar };

export const TRIAGE_ENVELOPE_HZ = 10;

/** Tempo-confidence floor below which the autocorrelation pick is
 *  ignored. Picked low — chunk-level windows are short, the runner-up
 *  peak tends to be close. */
const MIN_TEMPO_CONFIDENCE = 0.05;

export interface ChunkDetectionResult {
  chunks: Chunk[];
  envelope: Float32Array;
  envelopeHz: number;
}

interface SyncCoreModule {
  default(): Promise<unknown>;
  computeRmsEnvelope(pcm: Float32Array, sampleRate: number, envelopeHz: number): Float32Array;
  silenceSegments(
    envelope: Float32Array,
    envelopeHz: number,
    thresholdLin: number,
    minPauseMs: number,
  ): Array<{ start_ms: number; end_ms: number }>;
}

let modulePromise: Promise<SyncCoreModule> | null = null;

async function loadSyncCore(): Promise<SyncCoreModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = (await import(
        "../../../wasm/sync-core/pkg/sync_core.js"
      )) as unknown as SyncCoreModule;
      await mod.default();
      return mod;
    })();
  }
  return modulePromise;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function chunkId(startMs: number, endMs: number): string {
  return `chunk-${startMs}-${endMs}`;
}

export async function detectChunks(
  pcm: Float32Array,
  sampleRate: number,
  silenceConfig: SilenceConfig,
): Promise<ChunkDetectionResult> {
  const wasm = await loadSyncCore();
  const envelope = wasm.computeRmsEnvelope(pcm, sampleRate, TRIAGE_ENVELOPE_HZ);
  return detectChunksFromEnvelope(pcm, sampleRate, envelope, silenceConfig);
}

/** Same as `detectChunks` but takes a pre-computed envelope. Fast path
 *  for the Triage UI's live threshold/min-pause re-running — the
 *  envelope is the slow part to compute and doesn't change when the
 *  silence parameters change. */
export async function detectChunksFromEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  envelope: Float32Array,
  silenceConfig: SilenceConfig,
): Promise<ChunkDetectionResult> {
  const wasm = await loadSyncCore();
  const thresholdLin = dbToLinear(silenceConfig.thresholdDb);
  const segments = wasm.silenceSegments(
    envelope,
    TRIAGE_ENVELOPE_HZ,
    thresholdLin,
    silenceConfig.minPauseMs,
  );

  const chunks: Chunk[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const chunkAnalysis = pcm.length > 0
      ? analyzeChunk(pcm, sampleRate, seg.start_ms, seg.end_ms)
      : null;
    const audioStartMs = chunkAnalysis?.audioStartMs ?? seg.start_ms;
    // Auto-bar-align the chunk end. The bar grid is anchored on
    // `audioStartMs` (= first downbeat); snapping end-of-chunk to the
    // nearest preceding whole bar means a default-Triage handoff
    // already produces rhythm-aligned segments — the user can hit
    // "continue" without re-trimming every chunk by hand.
    const snappedEndMs = snapChunkEndToBar(
      seg.start_ms,
      seg.end_ms,
      audioStartMs,
      chunkAnalysis?.bpm,
      4,
    );
    chunks.push({
      id: chunkId(seg.start_ms, snappedEndMs),
      startMs: seg.start_ms,
      endMs: snappedEndMs,
      detectedBpm: chunkAnalysis?.bpm,
      bpmOctaveShift: 0,
      effectiveBpm: chunkAnalysis?.bpm ?? 0,
      audioStartMs,
      beatsPerBar: 4,
      accepted: true,
      trimMode: "auto",
      // Snapshot the boundaries this chunk was born with — the Reset
      // button restores them. Subsequent re-detections (slider changes)
      // also overwrite these, since "what the detector says" is the
      // user's reference frame; manual splits/joins/inserts seed their
      // own snapshots. Originals reflect the bar-aligned boundary so
      // RESET keeps the rhythmic alignment too.
      originalStartMs: seg.start_ms,
      originalEndMs: snappedEndMs,
      originalAudioStartMs: audioStartMs,
    });
    // Yield to event loop every 2 chunks so long-form sessions don't
    // freeze the UI during initial detection.
    if (i % 2 === 1 && i < segments.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { chunks, envelope, envelopeHz: TRIAGE_ENVELOPE_HZ };
}

interface ChunkAnalysis {
  bpm: number | undefined;
  /** Absolute master-audio time (ms) of the chunk's first detected
   *  onset. Used to anchor the chunk's bar grid in the UI. */
  audioStartMs: number;
}

/** Run the existing tempo + onset detector against a chunk's PCM
 *  slice. Returns null when the chunk is too short. */
function analyzeChunk(
  pcm: Float32Array,
  sampleRate: number,
  startMs: number,
  endMs: number,
): ChunkAnalysis | null {
  const lengthMs = endMs - startMs;
  if (lengthMs < MIN_CHUNK_MS_FOR_BPM) return null;
  const startSample = Math.floor((startMs / 1000) * sampleRate);
  const endSample = Math.min(pcm.length, Math.ceil((endMs / 1000) * sampleRate));
  if (endSample - startSample < sampleRate * 2) return null;
  const slice = pcm.subarray(startSample, endSample);
  try {
    const analysis = analyzeAudio(slice, sampleRate);
    const bpm =
      analysis.tempo && analysis.tempo.confidence >= MIN_TEMPO_CONFIDENCE
        ? analysis.tempo.bpm
        : undefined;
    // analysis.audioStartS is relative to the slice; convert back to
    // master-audio time by adding the chunk's startMs.
    const audioStartMs = startMs + analysis.audioStartS * 1000;
    return { bpm, audioStartMs };
  } catch {
    return null;
  }
}

/** Aggregate the per-chunk detected BPMs into a single song-global
 *  value. Picks the BPM that the most chunks agree on (rounded to the
 *  nearest integer); ties broken by total confidence (sum of
 *  contributing chunks' confidence). Returns null when no chunk had a
 *  detectable tempo. */
export function pickGlobalBpm(
  chunks: ReadonlyArray<{ detectedBpm?: number; endMs: number; startMs: number }>,
): { value: number; confidence: number } | null {
  // Bucket by rounded BPM; track the source confidences (use chunk
  // duration as a soft confidence proxy when nothing better — longer
  // chunks vote louder).
  const buckets = new Map<number, { count: number; weight: number }>();
  for (const c of chunks) {
    if (!c.detectedBpm || c.detectedBpm <= 0) continue;
    const key = Math.round(c.detectedBpm);
    const weight = Math.max(1, (c.endMs - c.startMs) / 1000);
    const bucket = buckets.get(key) ?? { count: 0, weight: 0 };
    bucket.count += 1;
    bucket.weight += weight;
    buckets.set(key, bucket);
  }
  if (buckets.size === 0) return null;
  let bestKey = 0;
  let bestCount = 0;
  let bestWeight = 0;
  for (const [key, b] of buckets) {
    if (
      b.count > bestCount ||
      (b.count === bestCount && b.weight > bestWeight)
    ) {
      bestKey = key;
      bestCount = b.count;
      bestWeight = b.weight;
    }
  }
  // Confidence = fraction of voting chunks that agreed on the winner.
  const totalCount = Array.from(buckets.values()).reduce((a, b) => a + b.count, 0);
  return { value: bestKey, confidence: bestCount / totalCount };
}
