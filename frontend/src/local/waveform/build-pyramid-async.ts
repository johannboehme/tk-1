/**
 * Chunked, yielding build of the peak pyramid. Level 0 scans every PCM sample
 * (O(N)); for hour-long recordings (~79 M samples) doing that inline at
 * decode/open time would jank the UI. This processes level 0 in bucket chunks,
 * yielding to the event loop between them, then pools the (cheap) higher levels
 * synchronously. Short clips still complete in a single chunk.
 *
 * Same result as the sync `buildPeakPyramid` — verified in tests.
 */
import {
  type BuildPyramidOpts,
  type PeakPyramid,
  type PyramidLevel,
  PEAK_FLOOR,
  PYRAMID_VERSION,
  fillLevel0,
  globalPeakOf,
  poolUp,
} from "./peak-pyramid";

export interface BuildPyramidAsyncOpts extends BuildPyramidOpts {
  /** Samples processed per macrotask before yielding. Default ~2M (~90ms). */
  chunkSamples?: number;
  onProgress?: (frac: number) => void;
}

/** Yield to the event loop without the setTimeout 4ms clamp where possible. */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function buildPeakPyramidAsync(
  pcm: Float32Array,
  sampleRate: number,
  opts: BuildPyramidAsyncOpts = {},
): Promise<PeakPyramid> {
  const base = opts.baseSamplesPerBucket ?? 64;
  const withRms = opts.withRms ?? false;
  const minBuckets = opts.minBuckets ?? 64;
  const chunkBuckets = Math.max(
    1,
    Math.floor((opts.chunkSamples ?? 2_000_000) / base),
  );

  if (pcm.length === 0) {
    opts.onProgress?.(1);
    return {
      version: PYRAMID_VERSION,
      sampleRate,
      sampleCount: 0,
      durationS: 0,
      baseSamplesPerBucket: base,
      globalPeak: PEAK_FLOOR,
      levels: [],
    };
  }

  const bucketCount = Math.ceil(pcm.length / base);
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  const rms = withRms ? new Float32Array(bucketCount) : undefined;

  for (let b = 0; b < bucketCount; b += chunkBuckets) {
    const bEnd = Math.min(bucketCount, b + chunkBuckets);
    fillLevel0(pcm, base, withRms, min, max, rms, b, bEnd);
    opts.onProgress?.(bEnd / bucketCount);
    if (bEnd < bucketCount) await yieldToEventLoop();
  }

  const lvl0: PyramidLevel = {
    min,
    max,
    rms,
    samplesPerBucket: base,
    bucketCount,
  };
  return {
    version: PYRAMID_VERSION,
    sampleRate,
    sampleCount: pcm.length,
    durationS: pcm.length / sampleRate,
    baseSamplesPerBucket: base,
    globalPeak: globalPeakOf(lvl0),
    levels: poolUp(lvl0, minBuckets),
  };
}
