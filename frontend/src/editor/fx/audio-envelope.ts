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
 */
import type { AudioEnvelope } from "./modulation";

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
  const hop = Math.max(1, Math.round(sampleRate / fps));
  // The TRUE frame rate is sampleRate/hop, not the requested fps: hop is
  // rounded to whole samples (22050/120 = 183.75 → 184). Storing the
  // requested fps mis-times every sample by that rounding ratio (~0.14%),
  // which accumulates to hundreds of ms deep into a long track — the
  // sidechain peaks drifted off the timeline the further in you went.
  const outFps = sampleRate / hop;
  const half = Math.floor(hop / 2);
  const n = Math.max(1, Math.ceil(pcm.length / hop));
  const data = new Float32Array(n);
  let maxV = 0;
  for (let i = 0; i < n; i++) {
    // Window CENTRED on this bucket's timestamp (i*hop) so peaks don't lead.
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
  // Normalize so the loudest moment maps to 1 — thresholds then read in
  // intuitive 0..1 terms regardless of the master's absolute level.
  if (maxV > 0) {
    for (let i = 0; i < n; i++) data[i] /= maxV;
  }
  return { data, fps: outFps };
}
