/**
 * Persisted waveform peak-pyramid: cache-or-compute, keyed per job in IDB.
 *
 * The pyramid is precomputed once in the sync step (where the master PCM is
 * already decoded) and cached, so Triage shows the high-res waveform instantly
 * instead of rebuilding it on every open. Jobs synced before this existed fall
 * back to the lazy in-memory build in the timeline components.
 *
 * Mirrors the audio-analysis cache shape. The payload (a PeakPyramid) carries
 * its own `version` and `sampleRate`, so the cache check is a thin guard.
 */
import { jobsDb } from "../../storage/jobs-db";
import { type PeakPyramid, PYRAMID_VERSION } from "./peak-pyramid";
import { buildPeakPyramidAsync } from "./build-pyramid-async";

/** Base bucket size for the persisted pyramid (≈2.9 ms at 22050 Hz). */
export const PYRAMID_BASE_SAMPLES = 64;

export async function getCachedPyramid(
  jobId: string,
  sampleRate: number,
): Promise<PeakPyramid | undefined> {
  const cached = await jobsDb.getWaveformPyramid<PeakPyramid>(jobId);
  if (
    cached &&
    cached.version === PYRAMID_VERSION &&
    cached.sampleRate === sampleRate
  ) {
    return cached;
  }
  return undefined;
}

export async function savePyramid(
  jobId: string,
  pyramid: PeakPyramid,
): Promise<void> {
  await jobsDb.saveWaveformPyramid(jobId, pyramid);
}

/**
 * Return the cached pyramid, or build it from the PCM (chunked, off the hot
 * path) and persist it. Safe to call repeatedly — a present, version-matched
 * cache short-circuits the build.
 */
export async function getOrComputePyramid(
  jobId: string,
  pcm: Float32Array,
  sampleRate: number,
): Promise<PeakPyramid> {
  const cached = await getCachedPyramid(jobId, sampleRate);
  if (cached) return cached;
  const fresh = await buildPeakPyramidAsync(pcm, sampleRate, {
    baseSamplesPerBucket: PYRAMID_BASE_SAMPLES,
  });
  await savePyramid(jobId, fresh);
  return fresh;
}
