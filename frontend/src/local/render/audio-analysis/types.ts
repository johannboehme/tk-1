/**
 * AudioAnalysis: das Ergebnis der Vorab-Analyse des Master-Audios.
 *
 * Wird einmal pro Master-Audio berechnet (Spectral-Flux Onsets,
 * Autokorrelations-Tempo, DP-Beat-Tracking nach Ellis 2007) und in IDB
 * gecacht. Reproduzierbar — gleicher PCM-Input liefert deterministisch
 * gleiche Werte. Beat-Phase + BPM treiben die Beat-Ruler-Anzeige und das
 * Snap-Grid; Onsets/Bands sind für künftige audio-reaktive Effekte
 * vorbereitet (im Editor-Sub-Feature aktuell nicht visualisiert).
 */
export interface BandSet {
  bass: number[];
  lowMids: number[];
  mids: number[];
  highs: number[];
}

export interface Tempo {
  /** Detected tempo in beats per minute. */
  bpm: number;
  /** Heuristic confidence 0..1 (peak height of the autocorrelation,
   *  normalized against the second-best peak). */
  confidence: number;
  /** Phase of beat 0 in seconds (i.e. when the first beat occurs). */
  phase: number;
  /** How steadily the beats hold a single tempo, 0..1. Derived from the
   *  spread of adjacent-beat intervals: 1 ≈ metronome-tight, low ≈ rubato
   *  or a tempo change mid-segment. Used to down-weight free-played /
   *  drifting regions when voting on a song-global BPM. Optional — absent
   *  on a seed tempo that has no beat track yet. */
  stability?: number;
}

/**
 * Bump when the analysis algorithm changes in a way that should invalidate
 * cached results (e.g. v1→v2: phase + bpm now derived from least-squares
 * regression through detected beats; window-center frame timing;
 * v3→v4: bpm now from a long-baseline Theil-Sen slope through the beats
 * instead of the median adjacent interval, removing frame-grid quantization
 * bias; tempo.stability added).
 */
export const ANALYSIS_VERSION = 4;
export type AnalysisVersion = typeof ANALYSIS_VERSION;

export interface AudioAnalysis {
  version: AnalysisVersion;
  sampleRate: number;
  /** Total duration of the analyzed audio in seconds. */
  duration: number;
  /** When the actual performance starts in the master audio (seconds).
   *  Detected via RMS threshold when the file leads with a clearly silent
   *  intro (e.g. an OP-1 recording started before the operator hit play).
   *  Returns 0 when the audio is non-silent throughout. Beat / onset
   *  detection runs only on samples ≥ this point so the grid can't anchor
   *  on spectral-flux quantization noise during the intro silence. */
  audioStartS: number;
  /** Samples between consecutive analysis frames (hop). */
  hopSize: number;
  /** = sampleRate / hopSize — frames per second of the time-series fields. */
  framesPerSec: number;
  /** Per-frame energy in four logarithmic bands. Length = total frames. */
  bands: BandSet;
  /** Per-frame RMS amplitude (time-domain), smoothed. Length = total frames. */
  rms: number[];
  /** Spectral-flux onset envelope, normalized 0..1. Length = total frames. */
  onsetStrength: number[];
  /** Discrete onset times (seconds). Peak-picked from onsetStrength. */
  onsets: number[];
  /** Per-band onset times (kick / snare / hihat approximation). */
  onsetsByBand: BandSet;
  /** Detected beat times in seconds. Empty if tempo could not be detected. */
  beats: number[];
  /** Every 4th beat (4/4 assumption). */
  downbeats: number[];
  /** Tempo metadata. null when no tempo could be detected. */
  tempo: Tempo | null;
}
