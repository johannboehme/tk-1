/**
 * Build a normalized master-loudness envelope from decoded mono PCM.
 *
 * This is the signal the sidechain follower reads (and the sidechain widget
 * draws): a windowed RMS over time, normalized to 0..1, indexed by
 * master-audio seconds. Computed ONCE at load (the editor already decodes
 * the master PCM for the timeline waveform) and stored, so the live
 * renderer, the export worker, and the widget all sample the same curve.
 *
 * RMS (not peak) because it tracks perceived loudness — kicks and sustained
 * energy read sensibly, isolated sample spikes don't dominate.
 */
import type { AudioEnvelope } from "./modulation";

/**
 * @param pcm Mono samples (e.g. the editor's 22.05 kHz decode).
 * @param sampleRate Samples per second of `pcm`.
 * @param fps Output frames per second (curve resolution). 60 keeps
 *            transients crisp while staying cheap.
 */
export function buildLoudnessEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  fps = 60,
): AudioEnvelope {
  if (pcm.length === 0 || sampleRate <= 0) {
    return { data: new Float32Array(0), fps };
  }
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const n = Math.max(1, Math.floor(pcm.length / hop));
  const data = new Float32Array(n);
  let maxV = 0;
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    const end = Math.min(pcm.length, start + hop);
    let sum = 0;
    for (let j = start; j < end; j++) {
      const v = pcm[j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    data[i] = rms;
    if (rms > maxV) maxV = rms;
  }
  // Normalize so the loudest moment maps to 1 — thresholds then read in
  // intuitive 0..1 terms regardless of the master's absolute level.
  if (maxV > 0) {
    for (let i = 0; i < n; i++) data[i] /= maxV;
  }
  return { data, fps };
}
