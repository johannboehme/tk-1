/**
 * Build a normalized master-amplitude envelope from decoded mono PCM.
 *
 * This is the signal the sidechain follower reads AND the sidechain widget
 * draws — so it must line up with the timeline's audio lane. The timeline
 * draws a min/max PEAK waveform, so we use a PEAK (max-abs) envelope here
 * too (not RMS): the envelope's peaks then sit exactly on the loudest
 * samples — i.e. on the kick transients — at the same time the timeline
 * shows them. RMS smeared the energy into the note body and read off from
 * the transient, which made the scope's peaks land a beat-fraction away
 * from the timeline's.
 *
 * Each bucket is CENTRED on its timestamp (window [center-½hop, center+½hop])
 * rather than starting at it, so a transient lands on its own column instead
 * of leading by up to a full window. Sampled per master-audio second;
 * computed once at load and shared by the live renderer, export worker, and
 * the widget.
 *
 * Two builders share one bucket kernel:
 *   - `buildLoudnessEnvelope` — synchronous, for workers and short tracks.
 *   - `buildLoudnessEnvelopeAsync` — chunked with event-loop yields, for the
 *     editor's main thread (an hour-long master is ~79 M samples; the single
 *     pass is a 100-300 ms block that would freeze the preview/audio-walker
 *     rAF if it landed while the user is already playing).
 */
import { yieldToEventLoop } from "../../local/waveform/build-pyramid-async";
import type { AudioEnvelope } from "./modulation";

/** Derived per-build constants shared by the sync and async builders. */
function envelopeLayout(pcmLength: number, sampleRate: number, fps: number) {
  const hop = Math.max(1, Math.round(sampleRate / fps));
  // The TRUE frame rate is sampleRate/hop, not the requested fps: hop is
  // rounded to whole samples (22050/120 = 183.75 → 184). Storing the
  // requested fps mis-times every sample by that rounding ratio (~0.14%),
  // which accumulates to hundreds of ms deep into a long track — the
  // sidechain peaks drifted off the timeline the further in you went.
  const outFps = sampleRate / hop;
  const half = Math.floor(hop / 2);
  const n = Math.max(1, Math.ceil(pcmLength / hop));
  return { hop, outFps, half, n };
}

/** Fill peak buckets [bStart, bEnd) and return the max peak seen there.
 *  Window CENTRED on each bucket's timestamp (i*hop) so peaks don't lead. */
function fillPeakBuckets(
  pcm: Float32Array,
  hop: number,
  half: number,
  data: Float32Array,
  bStart: number,
  bEnd: number,
): number {
  let maxV = 0;
  for (let i = bStart; i < bEnd; i++) {
    const center = i * hop;
    const start = Math.max(0, center - half);
    const end = Math.min(pcm.length, center + half);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = pcm[j] < 0 ? -pcm[j] : pcm[j];
      if (a > peak) peak = a;
    }
    data[i] = peak;
    if (peak > maxV) maxV = peak;
  }
  return maxV;
}

/** Normalize so the loudest moment maps to 1 — thresholds then read in
 *  intuitive 0..1 terms regardless of the master's absolute level. */
function normalizeInPlace(data: Float32Array, maxV: number): void {
  if (maxV <= 0) return;
  for (let i = 0; i < data.length; i++) data[i] /= maxV;
}

/**
 * @param pcm Mono samples (e.g. the editor's 22.05 kHz decode).
 * @param sampleRate Samples per second of `pcm`.
 * @param fps Output frames per second (curve resolution). 120 keeps the
 *            transient within ~one column of the timeline's peak.
 */
export function buildLoudnessEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  fps = 120,
): AudioEnvelope {
  if (pcm.length === 0 || sampleRate <= 0) {
    return { data: new Float32Array(0), fps };
  }
  const { hop, outFps, half, n } = envelopeLayout(pcm.length, sampleRate, fps);
  const data = new Float32Array(n);
  const maxV = fillPeakBuckets(pcm, hop, half, data, 0, n);
  normalizeInPlace(data, maxV);
  return { data, fps: outFps };
}

export interface BuildLoudnessEnvelopeAsyncOpts {
  /** Output frames per second (curve resolution). Default 120. */
  fps?: number;
  /** PCM samples scanned per macrotask before yielding. Default ~2M. */
  chunkSamples?: number;
  onProgress?: (frac: number) => void;
}

/**
 * Chunked variant of {@link buildLoudnessEnvelope}: scans the PCM in bucket
 * chunks, yielding to the event loop between them (same MessageChannel
 * pattern as buildPeakPyramidAsync), so the preview rAF and the audio
 * walker keep ticking while a long master is processed in the background.
 * Same result as the sync builder — verified in tests. Short clips still
 * complete in a single chunk.
 */
export async function buildLoudnessEnvelopeAsync(
  pcm: Float32Array,
  sampleRate: number,
  opts: BuildLoudnessEnvelopeAsyncOpts = {},
): Promise<AudioEnvelope> {
  const fps = opts.fps ?? 120;
  if (pcm.length === 0 || sampleRate <= 0) {
    opts.onProgress?.(1);
    return { data: new Float32Array(0), fps };
  }
  const { hop, outFps, half, n } = envelopeLayout(pcm.length, sampleRate, fps);
  const chunkBuckets = Math.max(
    1,
    Math.floor((opts.chunkSamples ?? 2_000_000) / hop),
  );
  const data = new Float32Array(n);
  let maxV = 0;
  for (let b = 0; b < n; b += chunkBuckets) {
    const bEnd = Math.min(n, b + chunkBuckets);
    const chunkMax = fillPeakBuckets(pcm, hop, half, data, b, bEnd);
    if (chunkMax > maxV) maxV = chunkMax;
    opts.onProgress?.(bEnd / n);
    if (bEnd < n) await yieldToEventLoop();
  }
  normalizeInPlace(data, maxV);
  return { data, fps: outFps };
}
