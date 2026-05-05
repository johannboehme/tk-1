/**
 * Pure audio-analysis pipeline. No DOM, no Worker — drives off a Float32Array
 * mono PCM buffer at a known sample rate and returns a fully-populated
 * AudioAnalysis. Deterministic; tested with canned signals.
 *
 * Pipeline:
 *   PCM → STFT (n_fft=2048, hop=sr/30, Hann) → mag spectrogram
 *       → 4-band log-spaced energy
 *       → spectral-flux onset envelope + peak-pick
 *       → per-band peak-picks
 *       → RMS (time-domain, hop-aligned)
 *       → autocorrelation tempo (with octave voting) — coarse seed only
 *       → DP beat-tracking (Ellis 2007 — cost = -onset + α·log²(period/Δ))
 *       → least-squares refit of (period, phase) through detected beats:
 *         the autocorrelation peak is quantized (~8 BPM at 120 BPM, partly
 *         mitigated by parabolic refinement) and the autocorrelation phase
 *         only sees the first beat-period — so for any track that doesn't
 *         start on the downbeat, the refit is what makes the snap-grid
 *         actually line up with the music
 *       → downbeats every 4th beat (4/4 fixed in V1)
 *
 * Frame-to-time convention: every event time uses the window-CENTER of its
 * STFT frame, i.e. `(i*hop + N_FFT/2) / sr`. Reporting the window-start
 * (`i*hop / sr`) would put every onset/beat ~46 ms early at sr=22050.
 */
import FFT from "fft.js";
import { ANALYSIS_VERSION } from "./types";
import type { AudioAnalysis, BandSet, Tempo } from "./types";

const N_FFT = 2048;
const TARGET_FRAMES_PER_SEC = 30;

// 4-band cutoff frequencies in Hz (geometric-ish coverage of musical content).
const BAND_LIMITS = {
  bass: [20, 200],
  lowMids: [200, 800],
  mids: [800, 3000],
  highs: [3000, 12000],
} as const;

// Tempo search range (BPM).
const MIN_BPM = 60;
const MAX_BPM = 200;

// Beat-tracking weight on the period prior (higher = more rigid tempo).
const BEAT_PRIOR_ALPHA = 100;

// Perceptual-tempo prior centre (BPM). Autocorrelation peaks tend to
// alias across tempo octaves: a track at 85 BPM shows a strong peak at
// 170 BPM too (every onset = 2 × 85), and the unweighted picker
// frequently lands on the wrong octave. A Rayleigh prior centred near
// the typical music range (~100–110 BPM) softly biases the picker
// toward perceptually-natural tempos without hard-cutting any region
// of the search space — drum'n'bass at 170 still wins if its AC is
// strong enough, but a lo-fi-hip-hop track that quietly autocorrelates
// at 180 lands on its true 90 BPM. Klapuri / Davies-style construction.
const TEMPO_PRIOR_SIGMA_BPM = 110;
const TEMPO_PRIOR_NORM = Math.exp(0.5); // so prior(σ) = 1.

/** Rayleigh-shaped weighting in [0, 1]; peaks at σ. */
function tempoPrior(bpm: number): number {
  const sigma = TEMPO_PRIOR_SIGMA_BPM;
  const x = bpm / sigma;
  return TEMPO_PRIOR_NORM * x * Math.exp(-(x * x) / 2);
}

export interface AnalyzeOptions {
  /** Override frames-per-second target (default 30). Mostly for tests. */
  framesPerSec?: number;
}

export function analyzeAudio(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): AudioAnalysis {
  const fps = opts.framesPerSec ?? TARGET_FRAMES_PER_SEC;
  const hopSize = Math.max(1, Math.round(sampleRate / fps));
  const framesPerSec = sampleRate / hopSize;
  const totalFrames = Math.max(0, Math.floor((pcm.length - N_FFT) / hopSize) + 1);
  const duration = pcm.length / sampleRate;

  if (totalFrames < 4) {
    // Audio too short for meaningful analysis. Return empty-but-shaped object.
    return emptyAnalysis(sampleRate, duration, hopSize, framesPerSec);
  }

  // Frame i represents the STFT window starting at sample i*hop. We report
  // its time as the window CENTER so an onset that lights up frame i is
  // dated where the energy actually is, not at the leading edge of the
  // analysis window. Using window-start would bias every event ~N_FFT/(2·sr)
  // earlier than truth (~46 ms at sr=22050, N_FFT=2048).
  const halfWinS = N_FFT / (2 * sampleRate);
  const frameToSec = (i: number): number => i / framesPerSec + halfWinS;

  // STFT magnitude spectrogram (totalFrames × (N_FFT/2 + 1))
  const mag = stftMagnitude(pcm, N_FFT, hopSize, totalFrames);

  // Per-band energy time-series.
  const bands = bandEnergies(mag, sampleRate, N_FFT);

  // RMS (time-domain).
  const rms = computeRms(pcm, hopSize, totalFrames, N_FFT);

  // Spectral-flux onset envelope (sum of positive frame-to-frame magnitude
  // differences across all bins, log-compressed to tame loud bursts). We
  // need this both for the onset/beat pipeline AND for audio-start
  // detection — silence has flux ≈ 0 (mag is zero so the log-difference
  // doesn't fire), so the first real musical event is also the first
  // place onset strength rises off the floor.
  const onsetStrength = spectralFlux(mag);

  // Audio-start: where the actual performance begins. For OP-1 / hardware
  // synth recordings the operator hits "play" some seconds after starting
  // capture, so the file leads with absolute silence. Without skipping the
  // silent intro, the DP beat-tracker periodically backtracks into that
  // silence and reports imaginary "beats" anchoring Bar 1 in the wrong
  // place.
  //
  // Two-stage detection: only treat the file as having a silent intro
  // when its first 300 ms sit at the floating-point floor (true digital
  // silence — what hardware recorders output before play is hit). For
  // every other case — continuous pad, loud-from-t=0, room tone — keep
  // audioStartFrame = 0 so we don't accidentally lop off non-percussive
  // material that just doesn't trigger the onset detector.
  const audioStartFrame = detectAudioStartFrame(rms, onsetStrength, framesPerSec);
  const audioStartS = frameToSec(audioStartFrame);

  // Zero out the part of the onset envelope that lies in the silent intro
  // so the peak-picker, autocorrelation, and beat-tracker all see "nothing
  // happens here". For tracks without a silent intro audioStartFrame is 0
  // and the gate is a no-op.
  for (let i = 0; i < audioStartFrame && i < onsetStrength.length; i++) {
    onsetStrength[i] = 0;
  }

  // Peak-pick onsets on the global flux + per band. Per-band envelopes are
  // gated the same way so onsetsByBand stays consistent with the global
  // onsets list.
  const onsets = pickOnsetFrames(onsetStrength, framesPerSec).map(frameToSec);
  const onsetsByBand: BandSet = {
    bass: pickOnsetFrames(maskFirst(diffPositive(bands.bass), audioStartFrame), framesPerSec).map(frameToSec),
    lowMids: pickOnsetFrames(maskFirst(diffPositive(bands.lowMids), audioStartFrame), framesPerSec).map(frameToSec),
    mids: pickOnsetFrames(maskFirst(diffPositive(bands.mids), audioStartFrame), framesPerSec).map(frameToSec),
    highs: pickOnsetFrames(maskFirst(diffPositive(bands.highs), audioStartFrame), framesPerSec).map(frameToSec),
  };

  // Coarse tempo seed via onset-strength autocorrelation. The phase it
  // returns is unreliable for tracks that don't start on the downbeat —
  // we replace it via the regression refit below, but the autocorrelation
  // peak is what gets the DP beat-tracker into the right octave.
  const seedTempo = detectTempo(onsetStrength, framesPerSec);

  // Beat-tracking via DP over the onset envelope, given the tempo. Gate
  // it on the audio-start frame so the DP can't periodically backtrack
  // into the silent intro and report imaginary "beats" there.
  const beatFrames = seedTempo
    ? trackBeatFrames(onsetStrength, framesPerSec, seedTempo, audioStartFrame)
    : [];
  // Sub-frame refinement: the DP tracker reports beats as integer frame
  // indices, so when the music's true period sits between two integer
  // values (e.g. 14.985 frames at 30 fps for a real 120 BPM track),
  // every beat snaps to the nearer integer and the regression slope
  // picks up a few-percent quantization bias. Parabolic-fit each peak
  // against its two neighbours to recover ~0.1-frame resolution.
  const beats = beatFrames.map((f) => frameToSec(refineBeatFrame(onsetStrength, f)));

  // Regression refit: solve (period, phase) such that beats[k] ≈ phase + k·period
  // by least squares. Averaging across many beats gives sub-frame precision
  // and — crucially — recovers the true phase from the actual beat positions
  // instead of the autocorrelation's first-period-only search.
  let tempo = seedTempo && beats.length >= 2
    ? refineTempoFromBeats(beats, seedTempo)
    : seedTempo;

  // Phase anchor: when the file has a confirmed silent intro (audioStartS > 0),
  // the music genuinely begins at audioStartS. The DP tracker's 2-period
  // initialization window means its chain sometimes starts on beat 2 rather
  // than beat 1, making the regression report phase = audioStartS + 1·period
  // instead of audioStartS — so Bar 1 appears one beat late in the ruler.
  // Walk the phase backward by whole periods until it sits within ±½ period
  // of audioStartS, anchoring Bar 1 at the actual music start.
  if (tempo && audioStartS > 0) {
    const period = 60 / tempo.bpm;
    let p = tempo.phase;
    while (p > audioStartS + period / 2) p -= period;
    while (p < audioStartS - period / 2) p += period;
    tempo = { ...tempo, phase: p };
  }

  // Time signature isn't part of the analysis output — the user picks it
  // (BpmReadout time-sig chip). This `downbeats` field is a 4/4 best-effort
  // for downstream consumers that don't read JobMeta.beatsPerBar; the
  // visible bar grid in the editor is rebuilt live from beats + the user's
  // time signature, so this fallback is only there for backwards-compat.
  const downbeats = beats.filter((_, i) => i % 4 === 0);

  return {
    version: ANALYSIS_VERSION,
    sampleRate,
    duration,
    audioStartS,
    hopSize,
    framesPerSec,
    bands,
    rms,
    onsetStrength,
    onsets,
    onsetsByBand,
    beats,
    downbeats,
    tempo,
  };
}

/**
 * Decide whether the file leads with true digital silence (a hardware
 * recorder running before the operator pressed play) and if so, find
 * the frame of the first significant onset.
 *
 * - SILENCE_RMS = 1e-4 (~-80 dBFS). Below the noise floor of any analog
 *   path; only digital silence sits this low. If the first 300 ms cross
 *   this even once we treat the track as already-running.
 * - SIGNIFICANT_ONSET = 0.1. Onset strength is normalized [0, 1]; a real
 *   musical event clears this comfortably.
 * - Backoff of 30 ms so the leading edge of the first transient isn't
 *   clipped by the gate.
 */
const SILENCE_RMS = 1e-4;
const SIGNIFICANT_ONSET = 0.1;
const SILENT_INTRO_PROBE_S = 0.3;

function detectAudioStartFrame(
  rms: number[],
  onsetStrength: number[],
  framesPerSec: number,
): number {
  if (rms.length === 0 || onsetStrength.length === 0) return 0;

  // Probe the first ~300 ms. Any frame above the silence floor means the
  // file is already playing audio at t=0 — don't gate.
  const probeFrames = Math.max(1, Math.round(SILENT_INTRO_PROBE_S * framesPerSec));
  for (let i = 0; i < Math.min(probeFrames, rms.length); i++) {
    if (rms[i] > SILENCE_RMS) return 0;
  }

  // Silent intro confirmed — find where the music kicks in.
  const backoff = Math.max(1, Math.round(0.03 * framesPerSec));
  for (let i = 0; i < onsetStrength.length; i++) {
    if (onsetStrength[i] > SIGNIFICANT_ONSET) {
      return Math.max(0, i - backoff);
    }
  }
  return 0;
}

function maskFirst(arr: number[], n: number): number[] {
  if (n <= 0) return arr;
  const out = arr.slice();
  for (let i = 0; i < n && i < out.length; i++) out[i] = 0;
  return out;
}

/**
 * Parabolic-interpolate the local onset-strength peak around `idx` to a
 * fractional frame position. The DP beat-tracker quantizes every beat to
 * an integer frame; without this refinement the regression slope picks
 * up systematic bias whenever the true beat-period falls between two
 * integer frame counts (e.g. 120 BPM at 30 fps = 14.985 frames). Result
 * is clamped to ±0.5 frames so a misaligned peak can't drag a beat onto
 * the wrong side of the next analysis window.
 */
function refineBeatFrame(strength: number[], idx: number): number {
  if (idx <= 0 || idx >= strength.length - 1) return idx;
  const ym1 = strength[idx - 1];
  const y0 = strength[idx];
  const yp1 = strength[idx + 1];
  // Only refine when idx is actually a local maximum — otherwise the
  // parabolic fit slides the beat onto a neighbour that wasn't the
  // tracker's choice for a reason.
  if (y0 < ym1 || y0 < yp1) return idx;
  const denom = ym1 - 2 * y0 + yp1;
  if (denom === 0) return idx;
  const offset = (0.5 * (ym1 - yp1)) / denom;
  return idx + Math.max(-0.5, Math.min(0.5, offset));
}

// ────────────────────────────────────────────────────────────────────────────
// STFT
// ────────────────────────────────────────────────────────────────────────────

function stftMagnitude(
  pcm: Float32Array,
  nFft: number,
  hop: number,
  totalFrames: number,
): Float32Array[] {
  const fft = new FFT(nFft);
  const win = hannWindow(nFft);
  const winnedFrame = new Array<number>(nFft);
  const out = fft.createComplexArray() as number[];
  const numBins = nFft / 2 + 1;
  const frames: Float32Array[] = new Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    const start = i * hop;
    for (let j = 0; j < nFft; j++) {
      winnedFrame[j] = pcm[start + j] * win[j];
    }
    fft.realTransform(out, winnedFrame);
    // realTransform fills indices 0 .. nFft-1 of the interleaved complex array
    // with the unique half of the spectrum (bins 0 .. nFft/2-1, plus Nyquist
    // at index nFft (re only)). We compute magnitudes for bins 0..nFft/2.
    const m = new Float32Array(numBins);
    for (let k = 0; k < nFft / 2; k++) {
      const re = out[2 * k];
      const im = out[2 * k + 1];
      m[k] = Math.sqrt(re * re + im * im);
    }
    // Nyquist bin (purely real, stored at index nFft of the layout).
    const nyqRe = out[nFft] ?? 0;
    m[nFft / 2] = Math.abs(nyqRe);
    frames[i] = m;
  }
  return frames;
}

function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

// ────────────────────────────────────────────────────────────────────────────
// Band energies
// ────────────────────────────────────────────────────────────────────────────

function bandEnergies(
  mag: Float32Array[],
  sampleRate: number,
  nFft: number,
): BandSet {
  const numBins = nFft / 2 + 1;
  const binToHz = sampleRate / nFft;
  const ranges = (Object.keys(BAND_LIMITS) as Array<keyof typeof BAND_LIMITS>).map(
    (k) => {
      const [lo, hi] = BAND_LIMITS[k];
      const loBin = Math.max(1, Math.floor(lo / binToHz));
      const hiBin = Math.min(numBins - 1, Math.ceil(hi / binToHz));
      return { key: k, loBin, hiBin };
    },
  );

  const result: BandSet = {
    bass: new Array(mag.length),
    lowMids: new Array(mag.length),
    mids: new Array(mag.length),
    highs: new Array(mag.length),
  };

  for (let f = 0; f < mag.length; f++) {
    for (const { key, loBin, hiBin } of ranges) {
      let acc = 0;
      const m = mag[f];
      for (let k = loBin; k <= hiBin; k++) acc += m[k] * m[k];
      result[key][f] = Math.sqrt(acc / Math.max(1, hiBin - loBin + 1));
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// RMS
// ────────────────────────────────────────────────────────────────────────────

function computeRms(
  pcm: Float32Array,
  hop: number,
  totalFrames: number,
  windowLen: number,
): number[] {
  const rms = new Array<number>(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    let acc = 0;
    const start = i * hop;
    for (let j = 0; j < windowLen; j++) {
      const v = pcm[start + j];
      acc += v * v;
    }
    rms[i] = Math.sqrt(acc / windowLen);
  }
  return rms;
}

// ────────────────────────────────────────────────────────────────────────────
// Spectral-flux onset envelope
// ────────────────────────────────────────────────────────────────────────────

function spectralFlux(mag: Float32Array[]): number[] {
  const out = new Array<number>(mag.length).fill(0);
  if (mag.length < 2) return out;
  const numBins = mag[0].length;
  // Log-compress before differencing so transients (|ΔlogE|) dominate.
  let prev = logCompress(mag[0]);
  for (let f = 1; f < mag.length; f++) {
    const cur = logCompress(mag[f]);
    let acc = 0;
    for (let k = 0; k < numBins; k++) {
      const d = cur[k] - prev[k];
      if (d > 0) acc += d;
    }
    out[f] = acc;
    prev = cur;
  }
  // Normalize 0..1 (max).
  let maxV = 0;
  for (const v of out) if (v > maxV) maxV = v;
  if (maxV > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= maxV;
  }
  return out;
}

function logCompress(m: Float32Array): Float32Array {
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = Math.log1p(m[i] * 1000);
  return out;
}

function diffPositive(arr: number[]): number[] {
  const out = new Array<number>(arr.length).fill(0);
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    out[i] = d > 0 ? d : 0;
  }
  let maxV = 0;
  for (const v of out) if (v > maxV) maxV = v;
  if (maxV > 0) for (let i = 0; i < out.length; i++) out[i] /= maxV;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Peak-picking
// ────────────────────────────────────────────────────────────────────────────

function pickOnsetFrames(strength: number[], framesPerSec: number): number[] {
  if (strength.length < 4) return [];
  // Min-distance ≈ 50 ms; threshold = max(absThr, mean+std).
  const minDist = Math.max(1, Math.round(0.05 * framesPerSec));
  let mean = 0;
  for (const v of strength) mean += v;
  mean /= strength.length;
  let varAcc = 0;
  for (const v of strength) varAcc += (v - mean) ** 2;
  const std = Math.sqrt(varAcc / strength.length);
  const thr = Math.max(0.1, mean + 0.5 * std);

  const peaks: number[] = [];
  for (let i = 1; i < strength.length - 1; i++) {
    const v = strength[i];
    if (v < thr) continue;
    if (v <= strength[i - 1] || v <= strength[i + 1]) continue;
    if (peaks.length > 0 && i - peaks[peaks.length - 1] < minDist) {
      // Replace previous if this peak is stronger.
      if (v > strength[peaks[peaks.length - 1]]) {
        peaks[peaks.length - 1] = i;
      }
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

// ────────────────────────────────────────────────────────────────────────────
// Tempo via autocorrelation
// ────────────────────────────────────────────────────────────────────────────

function detectTempo(strength: number[], framesPerSec: number): Tempo | null {
  if (strength.length < framesPerSec * 2) return null;

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * framesPerSec));
  const maxLag = Math.min(
    strength.length - 1,
    Math.ceil((60 / MIN_BPM) * framesPerSec),
  );
  if (maxLag <= minLag) return null;

  // Demean for cleaner autocorrelation.
  let mean = 0;
  for (const v of strength) mean += v;
  mean /= strength.length;
  const demean = strength.map((v) => v - mean);

  const ac = new Array<number>(maxLag + 1).fill(0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    const lim = strength.length - lag;
    for (let i = 0; i < lim; i++) acc += demean[i] * demean[i + lag];
    ac[lag] = acc / Math.max(1, lim);
  }

  // Octave voting: combine ac[lag] with ac[2*lag] and ac[lag/2] (downscaled)
  // to bias toward the perceptual tempo and avoid tempo-half/double errors.
  // Then multiply by a Rayleigh-shaped tempo prior so the picker softly
  // prefers musically-typical tempos without hard-cutting fast or slow
  // material — see TEMPO_PRIOR_SIGMA_BPM rationale at top of file.
  const voted = new Array<number>(maxLag + 1).fill(0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let v = ac[lag];
    if (2 * lag <= maxLag) v += 0.5 * ac[2 * lag];
    if (lag % 2 === 0) v += 0.3 * ac[lag / 2];
    const bpm = (60 / lag) * framesPerSec;
    voted[lag] = v * tempoPrior(bpm);
  }

  // Pick the peak.
  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (voted[lag] > bestVal) {
      bestVal = voted[lag];
      bestLag = lag;
    }
  }
  if (bestVal <= 0) return null;

  // Confidence: peak height vs second-best peak (≥ 30 BPM apart).
  const minSepFrames = Math.max(1, Math.round((60 / 30) * framesPerSec * 0));
  let runnerUp = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) <= 2 + minSepFrames) continue;
    if (voted[lag] > runnerUp) runnerUp = voted[lag];
  }
  const confidence = runnerUp > 0 ? Math.min(1, 1 - runnerUp / bestVal) : 0.5;

  // Refine by parabolic interpolation around the peak.
  const refinedLag = parabolicRefine(voted, bestLag);
  const periodS = refinedLag / framesPerSec;
  const bpm = 60 / periodS;

  // Phase: index of the strongest onset in the first beat-period.
  const firstWin = Math.round(refinedLag);
  let phaseIdx = 0;
  let phaseVal = -Infinity;
  for (let i = 0; i < Math.min(firstWin, strength.length); i++) {
    if (strength[i] > phaseVal) {
      phaseVal = strength[i];
      phaseIdx = i;
    }
  }
  const phase = phaseIdx / framesPerSec;

  return { bpm, confidence, phase };
}

function parabolicRefine(arr: number[], i: number): number {
  if (i <= 0 || i >= arr.length - 1) return i;
  const ym1 = arr[i - 1];
  const y0 = arr[i];
  const yp1 = arr[i + 1];
  const denom = ym1 - 2 * y0 + yp1;
  if (denom === 0) return i;
  const offset = (0.5 * (ym1 - yp1)) / denom;
  return i + offset;
}

// ────────────────────────────────────────────────────────────────────────────
// Beat-tracking (Ellis 2007 simplified)
// ────────────────────────────────────────────────────────────────────────────

function trackBeatFrames(
  strength: number[],
  framesPerSec: number,
  tempo: Tempo,
  startFrame = 0,
): number[] {
  const periodFrames = (60 / tempo.bpm) * framesPerSec;
  const localScore = strength.slice();

  // DP: at each frame i ≥ startFrame, compute the best cumulative score
  // reaching i, assuming the previous beat is approximately periodFrames
  // ago. Anything before startFrame stays at -Infinity so the chain can't
  // walk back into the silent intro during backtracking.
  const cum = new Array<number>(strength.length).fill(-Infinity);
  const back = new Array<number>(strength.length).fill(-1);
  const startWindow = Math.max(1, Math.round(2 * periodFrames));

  for (let i = startFrame; i < strength.length; i++) {
    if (i < startFrame + startWindow) {
      cum[i] = localScore[i];
      back[i] = -1;
      continue;
    }
    // Search a window around (i - periodFrames) for the best previous beat.
    const center = Math.round(periodFrames);
    const windowHalf = Math.max(2, Math.round(periodFrames * 0.25));
    let bestCum = -Infinity;
    let bestPrev = -1;
    for (let dt = center - windowHalf; dt <= center + windowHalf; dt++) {
      const p = i - dt;
      if (p < startFrame) continue;
      // Cost: log²(period_actual / period_target) — Ellis-style.
      const ratio = dt / periodFrames;
      const cost = Math.log(ratio) ** 2;
      const candidate = cum[p] - BEAT_PRIOR_ALPHA * cost;
      if (candidate > bestCum) {
        bestCum = candidate;
        bestPrev = p;
      }
    }
    cum[i] = localScore[i] + (bestCum === -Infinity ? 0 : bestCum);
    back[i] = bestPrev;
  }

  // Find best ending frame in the last beat-window of the track.
  const tailStart = Math.max(startFrame, strength.length - Math.ceil(periodFrames));
  let endIdx = -1;
  let endVal = -Infinity;
  for (let i = tailStart; i < strength.length; i++) {
    if (cum[i] > endVal) {
      endVal = cum[i];
      endIdx = i;
    }
  }
  if (endIdx < 0) return [];

  // Backtrack — back[]=-1 marks the chain start, so the loop exits there.
  const beatsRev: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    beatsRev.push(cur);
    cur = back[cur];
  }
  beatsRev.reverse();
  return beatsRev;
}

// ────────────────────────────────────────────────────────────────────────────
// Tempo refinement via least-squares regression on detected beats.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Recover the true (period, phase) from the detected beats. Naive
 * least-squares through every beat is sensitive to a single bad
 * detection — if the DP-tracker drops or doubles a beat anywhere in the
 * chain (its ±25% period window allows that) the slope absorbs the gap
 * and biases BPM by ~0.2 across the rest of the track, compounding into
 * ≈100 ms of cut-vs-beat drift over a minute.
 *
 * The interval distribution on real music isn't symmetric either — it
 * has a long right tail (~3-5 % of intervals land 1 frame late because
 * the onset peak ekes one window further than the true beat). The mean
 * picks that bias up; the **median** ignores it. So: period = median of
 * consecutive-beat intervals; phase = mean residual of (beats[k] − k·period)
 * so phase noise still averages out across all beats.
 */
function refineTempoFromBeats(beats: number[], seed: Tempo): Tempo {
  if (beats.length < 2) return seed;

  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  // Median for an even-length list: average of the two middle values.
  const mid = sorted.length >> 1;
  const period =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  if (!isFinite(period) || period <= 0) return seed;
  const bpm = 60 / period;

  // Phase: mean of residuals (beats[k] - k·period). Robust phase given a
  // robust period — averaging over all beats keeps the noise floor low
  // even though we trimmed when computing the period.
  let phaseSum = 0;
  for (let k = 0; k < beats.length; k++) phaseSum += beats[k] - k * period;
  const phase = phaseSum / beats.length;

  // Sanity check: if the trimmed mean lands somewhere absurd, keep the
  // seed BPM but still adopt the new phase from the actual beats.
  if (bpm < 30 || bpm > 240) {
    return { ...seed, phase: beats[0] };
  }

  return {
    bpm,
    confidence: seed.confidence,
    phase,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase-only refit at a fixed period.
//
// Triage's "Conform" action needs to re-detect the bar-grid phase of one
// chunk while keeping the song-global BPM untouched. The full analyzeAudio
// pipeline jointly refits period+phase from detected beats, which would
// override the global decision. Here we hold the period and fit only the
// phase: residual mean of (beats[k] − k · fixedPeriod).
//
// Inputs:
//   - pcm: mono Float32Array
//   - sampleRate: Hz
//   - fixedBpm: the global BPM to hold as the period
//   - beatsPerBar: time-signature numerator (currently unused — kept for
//     symmetry with the chunk model and future per-bar refinements)
//
// Returns null when the chunk is too short for meaningful analysis or when
// fewer than 2 beats are detected (no slope to anchor).
// ────────────────────────────────────────────────────────────────────────────

export interface FixedBpmAnalysis {
  /** Master-time-relative seconds: where the bar-grid anchor lies in the
   *  PCM slice's coordinate frame. Add the slice's master-time offset to
   *  get a master-time anchor. */
  phaseS: number;
  /** All detected beat times (PCM-relative seconds). */
  beats: number[];
  /** 0..1 — proxy for how cleanly the residuals clustered around the
   *  fixed period. 1 = beats sit exactly on `phase + k·period`; lower
   *  means the audio's tempo disagrees with `fixedBpm`. */
  confidence: number;
}

export function analyzeAudioFixedBpm(
  pcm: Float32Array,
  sampleRate: number,
  fixedBpm: number,
  _beatsPerBar: number,
  opts: AnalyzeOptions = {},
): FixedBpmAnalysis | null {
  if (!fixedBpm || fixedBpm <= 0 || !Number.isFinite(fixedBpm)) return null;
  const fps = opts.framesPerSec ?? TARGET_FRAMES_PER_SEC;
  const hopSize = Math.max(1, Math.round(sampleRate / fps));
  const framesPerSec = sampleRate / hopSize;
  const totalFrames = Math.max(0, Math.floor((pcm.length - N_FFT) / hopSize) + 1);
  if (totalFrames < 4) return null;

  const halfWinS = N_FFT / (2 * sampleRate);
  const frameToSec = (i: number): number => i / framesPerSec + halfWinS;

  const mag = stftMagnitude(pcm, N_FFT, hopSize, totalFrames);
  const onsetStrength = spectralFlux(mag);

  // DP beat-tracking with the fixed period. We don't run autocorrelation
  // — the global BPM is the period seed, full stop.
  const seedTempo: Tempo = { bpm: fixedBpm, confidence: 1, phase: 0 };
  const beatFrames = trackBeatFrames(onsetStrength, framesPerSec, seedTempo, 0);

  // Fallback path — too few beats for a meaningful LS-fit (very short
  // chunk, sparse hits, percussive-only material). Use the first
  // detected onset as the phase anchor: better than refusing to
  // re-fit at all, since the user has explicitly asked for a re-grid.
  // Confidence reflects that we couldn't verify the period.
  if (beatFrames.length < 2) {
    const onsetFrames = pickOnsetFrames(onsetStrength, framesPerSec);
    if (onsetFrames.length === 0) return null;
    const phaseS = frameToSec(onsetFrames[0]);
    return { phaseS, beats: [phaseS], confidence: 0.2 };
  }

  const beats = beatFrames.map((f) => frameToSec(refineBeatFrame(onsetStrength, f)));

  const period = 60 / fixedBpm;

  // Phase = mean of residuals (beats[k] − k · period). Robust under
  // missed/extra beats only insofar as the residuals stay clustered;
  // the test for that is the residual std-dev → confidence below.
  let phaseSum = 0;
  for (let k = 0; k < beats.length; k++) phaseSum += beats[k] - k * period;
  const phase = phaseSum / beats.length;

  // Confidence: the residuals (after subtracting the modular grid) should
  // cluster tightly around 0. We compute std-dev of the residuals modulo
  // period (folded into [-period/2, +period/2]) and map to a 0..1
  // confidence — tighter cluster = higher confidence. A perfect grid
  // gives std=0 → confidence=1; uniform-random residuals give
  // std≈period/sqrt(12) → confidence≈0.
  let varAcc = 0;
  for (let k = 0; k < beats.length; k++) {
    const resid = beats[k] - k * period - phase;
    // Fold into [-period/2, +period/2] so adjacent grid lines don't
    // inflate the variance via wrap-around.
    const folded = ((resid + period / 2) % period + period) % period - period / 2;
    varAcc += folded * folded;
  }
  const std = Math.sqrt(varAcc / beats.length);
  const stdMax = period / Math.sqrt(12); // ≈ uniform-random baseline
  const confidence = Math.max(0, Math.min(1, 1 - std / stdMax));

  return { phaseS: phase, beats, confidence };
}

// ────────────────────────────────────────────────────────────────────────────
// Empty-shape helper
// ────────────────────────────────────────────────────────────────────────────

function emptyAnalysis(
  sampleRate: number,
  duration: number,
  hopSize: number,
  framesPerSec: number,
): AudioAnalysis {
  const empty: BandSet = { bass: [], lowMids: [], mids: [], highs: [] };
  return {
    version: ANALYSIS_VERSION,
    sampleRate,
    duration,
    audioStartS: 0,
    hopSize,
    framesPerSec,
    bands: empty,
    rms: [],
    onsetStrength: [],
    onsets: [],
    onsetsByBand: empty,
    beats: [],
    downbeats: [],
    tempo: null,
  };
}
