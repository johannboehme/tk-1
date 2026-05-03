/**
 * Long-form Triage: chunk-detection orchestration.
 *
 * Given a decoded master-audio PCM, produces a list of `Chunk` candidates —
 * contiguous loud regions separated by user-controllable silence gaps,
 * each annotated with its detected BPM where the chunk is long enough
 * for tempo detection to be reliable.
 *
 * Pipeline:
 *   1. RMS envelope at 10 Hz (WASM, ~36 K samples for 1 h of audio)
 *   2. Silence-segments: invert the silence-gap mask, with user-tunable
 *      threshold + min-pause (WASM, sub-ms even on 1 h envelope)
 *   3. Per-chunk tempo: re-run the existing audio-analysis pipeline on
 *      the chunk's PCM slice. Skipped for chunks shorter than
 *      MIN_CHUNK_MS_FOR_BPM (autocorrelation needs at least a few bars
 *      to give a stable peak).
 *
 * Pure function — no IO, no DOM, no Worker. Caller decides whether to
 * run on the main thread (Triage UI live-re-running threshold sliders)
 * or in a Worker (initial detection on a 1 h file).
 */

import { analyzeAudio } from "../render/audio-analysis/analyze";
import type { Chunk, SilenceConfig } from "../../storage/jobs-db";

/** Resolution of the RMS-envelope used throughout Triage. One sample
 *  per 100 ms. Cheap to recompute, fine enough that the silence
 *  detector can localise gaps to within ~1 envelope sample. */
export const TRIAGE_ENVELOPE_HZ = 10;

/** Below this chunk length the autocorrelation tempo detector tends
 *  to lock onto sub-bar harmonics (e.g. report 200 BPM for a 2 s
 *  one-shot). Leave BPM undefined and let the user pick a Session
 *  default in the Triage UI. */
const MIN_CHUNK_MS_FOR_BPM = 4_000;

/** Tempo-confidence floor below which we ignore the autocorrelation
 *  pick and leave the chunk's BPM unset. Picked low — the chunk-level
 *  detector runs on relatively short windows where the runner-up peak
 *  tends to be close, so a strict cutoff would zero out most chunks. */
const MIN_TEMPO_CONFIDENCE = 0.05;

export interface ChunkDetectionResult {
  /** The detected chunks, sorted by start_ms. Default `accepted: true`
   *  so the Triage UI starts with everything kept; user toggles per
   *  chunk to drop. */
  chunks: Chunk[];
  /** RMS envelope at TRIAGE_ENVELOPE_HZ — exposed so the UI can render
   *  a waveform overview without recomputing it, and so re-running
   *  silence detection on threshold/min-pause changes can re-use it. */
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

/** Convert dBFS (-∞..0) to linear amplitude (0..1). The Triage slider
 *  surfaces dB to the user — this maps it down to the linear domain
 *  the WASM silence detector wants. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Build a chunk ID that's stable for the same boundary pair. Re-detection
 *  with different threshold/min-pause naturally produces different IDs;
 *  the Triage UI handles re-keying when the user mutates parameters. */
function chunkId(startMs: number, endMs: number): string {
  return `chunk-${startMs}-${endMs}`;
}

/**
 * Top-level: run the full detection pipeline.
 *
 * `silenceConfig.thresholdDb` is in dBFS (e.g. -50). `minPauseMs` is
 * in milliseconds (e.g. 1500 for "one-and-a-half-second pauses split
 * a chunk").
 */
export async function detectChunks(
  pcm: Float32Array,
  sampleRate: number,
  silenceConfig: SilenceConfig,
): Promise<ChunkDetectionResult> {
  const wasm = await loadSyncCore();

  const envelope = wasm.computeRmsEnvelope(pcm, sampleRate, TRIAGE_ENVELOPE_HZ);
  return detectChunksFromEnvelope(pcm, sampleRate, envelope, silenceConfig);
}

/**
 * Same as `detectChunks` but takes a pre-computed envelope. Fast path
 * for the Triage UI's live threshold/min-pause re-running — the
 * envelope is the slow part to compute (~ 100 ms for 1 h on M1) and
 * doesn't change when the silence parameters change.
 */
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

  // Per-chunk BPM is the slow part — analyzeAudio runs FFT + onset +
  // autocorrelation on each chunk's PCM slice. For a long session
  // with many chunks that easily blocks the main thread for tens of
  // seconds. Yielding to the event loop between chunks lets the
  // sync-progress UI keep updating + lets the user cancel without
  // the tab freezing.
  const chunks: Chunk[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const detectedBpm = detectChunkBpm(pcm, sampleRate, seg.start_ms, seg.end_ms);
    const effectiveBpm = detectedBpm ?? 0;
    chunks.push({
      id: chunkId(seg.start_ms, seg.end_ms),
      startMs: seg.start_ms,
      endMs: seg.end_ms,
      detectedBpm,
      bpmOctaveShift: 0,
      effectiveBpm,
      beatsPerBar: 4,
      accepted: true,
      trimMode: "auto",
    });
    // Yield every chunk so the event loop can paint a frame and
    // process input. setTimeout(0) ≈ 4ms minimum delay, fine for
    // long-form sessions where total chunk count is < 200.
    if (i % 2 === 1 && i < segments.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { chunks, envelope, envelopeHz: TRIAGE_ENVELOPE_HZ };
}

/** Run the existing per-track tempo detector against a chunk's PCM
 *  slice. Returns undefined when the chunk is too short to give a
 *  trustworthy BPM (the autocorrelation needs ~3-4 bars to lock). */
function detectChunkBpm(
  pcm: Float32Array,
  sampleRate: number,
  startMs: number,
  endMs: number,
): number | undefined {
  const lengthMs = endMs - startMs;
  if (lengthMs < MIN_CHUNK_MS_FOR_BPM) return undefined;

  const startSample = Math.floor((startMs / 1000) * sampleRate);
  const endSample = Math.min(pcm.length, Math.ceil((endMs / 1000) * sampleRate));
  if (endSample - startSample < sampleRate * 2) return undefined;

  const slice = pcm.subarray(startSample, endSample);
  try {
    const analysis = analyzeAudio(slice, sampleRate);
    if (!analysis.tempo || analysis.tempo.confidence < MIN_TEMPO_CONFIDENCE) {
      return undefined;
    }
    return analysis.tempo.bpm;
  } catch {
    return undefined;
  }
}
