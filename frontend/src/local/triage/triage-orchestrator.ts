/**
 * Long-form Triage orchestration: wraps audio-loading + chunk-detection +
 * persistence behind a single async entry point.
 *
 * Lives one layer above `chunk-detect.ts` (the pure detector). Owns:
 *   - resolving the master-audio asset (handle or OPFS) → File → PCM
 *   - persisting the resulting `chunks[]` and `silenceConfig` on the job
 *   - returning the decoded PCM so the UI can hold it for live
 *     slider re-runs without redecoding
 */

import { loadAssetFile } from "../asset-source";
import { decodeAudioToMonoPcm } from "../codec";
import { jobsDb, type SilenceConfig } from "../../storage/jobs-db";
import { detectChunks, type ChunkDetectionResult } from "./chunk-detect";

/** Default silence parameters when a job has none persisted yet.
 *  Threshold ≈ -50 dBFS catches anything audibly above the noise floor
 *  without being so loose that recorder hiss looks like a chunk.
 *  Min-pause 1.5 s sits comfortably between "drum-fill gap" (200-500 ms,
 *  must NOT split) and "took a sip of water" (3+ s, MUST split). */
export const DEFAULT_SILENCE_CONFIG: SilenceConfig = {
  thresholdDb: -50,
  minPauseMs: 1500,
};

/** PCM target sample rate. Same value the Sync pipeline uses — 22 050 Hz
 *  gives a 11 kHz Nyquist which covers everything musically interesting
 *  while halving the byte cost vs 44 100 (88 MB → ~176 MB for 1 h). */
const PCM_SAMPLE_RATE = 22050;

export interface TriageStageProgress {
  stage: "decoding" | "detecting" | "persisting";
}

export interface RunChunkDetectionResult extends ChunkDetectionResult {
  /** Decoded master-audio PCM at PCM_SAMPLE_RATE. Returned so the
   *  UI can hold it across live silence-config tweaks without
   *  redecoding (the PCM is the slow part). Caller owns the buffer. */
  pcm: Float32Array;
  sampleRate: number;
}

export async function runChunkDetectionForJob(
  jobId: string,
  config: SilenceConfig = DEFAULT_SILENCE_CONFIG,
  opts: { onStage?: (p: TriageStageProgress) => void } = {},
): Promise<RunChunkDetectionResult> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.audioSource) {
    throw new Error("Job has no audio source — was it created before v3?");
  }

  opts.onStage?.({ stage: "decoding" });
  const file = await loadAssetFile({ source: job.audioSource });
  const decoded = await decodeAudioToMonoPcm(file, PCM_SAMPLE_RATE);

  opts.onStage?.({ stage: "detecting" });
  const detection = await detectChunks(decoded.pcm, decoded.sampleRate, config);

  opts.onStage?.({ stage: "persisting" });
  await jobsDb.updateJob(jobId, {
    chunks: detection.chunks,
    silenceConfig: config,
  });

  return {
    ...detection,
    pcm: decoded.pcm,
    sampleRate: decoded.sampleRate,
  };
}
