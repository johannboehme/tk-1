//! sync-core: Audio-Sync-Algorithmus, kompiliert zu WASM.
//!
//! Public API surface:
//!   * `version()` — sanity check that the WASM module loaded.
//!   * `sync_audio_pcm_js(ref_pcm, query_pcm, sample_rate)` — runs the full
//!     pipeline (chroma → xcorr → optional DTW → sliding-window drift
//!     refinement) and returns a JS object matching the `SyncResult` shape.

pub mod chroma;
pub mod consensus;
pub mod drift;
pub mod dtw;
pub mod envelope;
pub mod mel;
pub mod ncc;
pub mod onset;
pub mod phat;
pub mod salience;
pub mod silence;
pub mod sync;
pub mod util;
pub mod xcorr;

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "sync-core/0.1.0".to_string()
}

#[derive(Serialize)]
struct SyncResultDto {
    offset_ms: f64,
    confidence: f64,
    drift_ratio: f64,
    method: String,
    warning: Option<String>,
    candidates: Vec<MatchCandidateDto>,
    /// Primary peak / second-highest peak. >1.5 = comfortable margin.
    /// `null` (≈ infinity) when no runner-up exists. Serialized as a
    /// finite number on the JS side; we cap infinity at a large sentinel
    /// so JSON survives the round-trip.
    peak_to_second_ratio: f64,
    /// Primary peak / median correlation over valid lags.
    peak_to_noise: f64,
    /// GCC-PHAT peak-to-noise ratio. 0 means PHAT was skipped or
    /// rejected; >20 = sharp same-source phase coherence.
    phat_pnr: f64,
}

#[derive(Serialize)]
struct MatchCandidateDto {
    offset_ms: f64,
    confidence: f64,
    overlap_frames: u32,
}

/// JSON's number type cannot represent ±infinity — `serde_json` writes
/// it as `null`, which then deserializes to `null` on the JS side and
/// gets coerced to 0 by careless arithmetic. Cap at a large finite
/// sentinel so the JSON is always a number; the UI treats anything
/// above this as "saturated / unique peak" anyway.
const SATURATED_RATIO: f64 = 1.0e6;

fn finite_or_saturated(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        SATURATED_RATIO
    }
}

impl From<sync::SyncResult> for SyncResultDto {
    fn from(r: sync::SyncResult) -> Self {
        Self {
            offset_ms: r.offset_ms,
            confidence: r.confidence,
            drift_ratio: r.drift_ratio,
            method: r.method,
            warning: r.warning,
            candidates: r
                .candidates
                .iter()
                .map(|c| MatchCandidateDto {
                    offset_ms: c.offset_ms,
                    confidence: c.confidence,
                    overlap_frames: c.overlap_frames,
                })
                .collect(),
            peak_to_second_ratio: finite_or_saturated(r.peak_to_second_ratio),
            peak_to_noise: finite_or_saturated(r.peak_to_noise),
            phat_pnr: finite_or_saturated(r.phat_pnr),
        }
    }
}

// -----------------------------------------------------------------------------
// Triage (long-form session footage) — chunk detection helpers.
// -----------------------------------------------------------------------------

/// Compute the RMS envelope of a PCM buffer at `envelope_hz` Hz.
/// One sample per `(1000 / envelope_hz)` ms. Used by the Triage UI as
/// the basis for silence detection + waveform overview rendering.
#[wasm_bindgen(js_name = computeRmsEnvelope)]
pub fn compute_rms_envelope_js(
    pcm: &[f32],
    sample_rate: u32,
    envelope_hz: f32,
) -> Vec<f32> {
    envelope::rms_envelope(pcm, sample_rate, envelope_hz)
}

#[derive(Serialize)]
struct AudioChunkDto {
    start_ms: u32,
    end_ms: u32,
}

/// Detect contiguous audio chunks in an RMS envelope. The envelope can
/// be cached and re-passed when the user nudges the threshold or
/// min-pause sliders — re-running silence detection on a 1h envelope
/// is cheap (sub-ms) compared to recomputing the envelope itself.
///
/// `threshold_lin` is linear amplitude (not dB). Typical values:
/// 1e-3 (≈ -60 dBFS) to 3e-2 (≈ -30 dBFS).
#[derive(Serialize)]
struct MelSpecDto {
    /// Frame-major u8 data, length = `n_mels * n_frames`.
    data: Vec<u8>,
    n_mels: u32,
    n_frames: u32,
}

/// Compute a mel-spectrogram of a PCM snippet, returned as u8 grayscale
/// suitable for direct rendering into a Canvas2D `ImageData`.
///
/// `n_mels` typical: 64. `fps` typical: 30 (≈ 33 ms hop).
#[wasm_bindgen(js_name = melSpectrogram)]
pub fn mel_spectrogram_js(
    pcm: &[f32],
    sample_rate: u32,
    n_mels: u32,
    fps: u32,
) -> Result<JsValue, JsValue> {
    let (data, n_frames) = mel::mel_spectrogram(pcm, sample_rate, n_mels as usize, fps);
    let dto = MelSpecDto {
        data,
        n_mels,
        n_frames: n_frames as u32,
    };
    serde_wasm_bindgen::to_value(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Compute a 12-bin pitch-class profile (chroma) of a PCM snippet,
/// averaged across time. Drives the Arrange page's per-chunk KEY tag
/// via Krumhansl-Schmuckler matching on the JS side. Class 0 = C.
#[wasm_bindgen(js_name = chromaProfile)]
pub fn chroma_profile_js(pcm: &[f32], sample_rate: u32) -> Vec<f32> {
    let m = chroma::chroma_features(pcm, sample_rate);
    if m.n_frames == 0 {
        return vec![0.0; chroma::N_PITCH_CLASSES];
    }
    // Time-average each pitch class. The matrix is row-major: row c
    // spans [c * n_frames, (c+1) * n_frames). We average and re-L2-
    // normalize so the JS-side Krumhansl-Schmuckler profiles compare
    // against a unit-magnitude vector.
    let mut profile = vec![0.0f32; chroma::N_PITCH_CLASSES];
    for c in 0..chroma::N_PITCH_CLASSES {
        let row = m.row(c);
        let mut sum = 0.0f32;
        for &v in row {
            sum += v;
        }
        profile[c] = sum / m.n_frames as f32;
    }
    let mut norm = 0.0f32;
    for &v in profile.iter() {
        norm += v * v;
    }
    norm = norm.sqrt();
    if norm > 1e-9 {
        for v in profile.iter_mut() {
            *v /= norm;
        }
    }
    profile
}

#[wasm_bindgen(js_name = silenceSegments)]
pub fn silence_segments_js(
    envelope: &[f32],
    envelope_hz: f32,
    threshold_lin: f32,
    min_pause_ms: f32,
) -> Result<JsValue, JsValue> {
    let chunks = silence::silence_segments(envelope, envelope_hz, threshold_lin, min_pause_ms);
    let dto: Vec<AudioChunkDto> = chunks
        .into_iter()
        .map(|c| AudioChunkDto {
            start_ms: c.start_ms,
            end_ms: c.end_ms,
        })
        .collect();
    serde_wasm_bindgen::to_value(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name = syncAudioPcm)]
pub fn sync_audio_pcm_js(
    ref_pcm: &[f32],
    query_pcm: &[f32],
    sample_rate: u32,
) -> Result<JsValue, JsValue> {
    let opts = sync::SyncOptions {
        sr: sample_rate,
        ..Default::default()
    };
    let result = sync::sync_audio_pcm(ref_pcm, query_pcm, opts);
    let dto = SyncResultDto::from(result);
    serde_wasm_bindgen::to_value(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Same as `syncAudioPcm` but invokes `progress(stage, fraction)`
/// between each pipeline stage. Lets the caller render a smooth
/// progress bar (otherwise the pipeline blocks for ~5 s with no
/// updates).
#[wasm_bindgen(js_name = syncAudioPcmWithProgress)]
pub fn sync_audio_pcm_with_progress_js(
    ref_pcm: &[f32],
    query_pcm: &[f32],
    sample_rate: u32,
    progress: &js_sys::Function,
) -> Result<JsValue, JsValue> {
    let opts = sync::SyncOptions {
        sr: sample_rate,
        ..Default::default()
    };
    let cb = |stage: &str, frac: f64| {
        // Errors from the callback are intentionally swallowed —
        // pipeline correctness shouldn't depend on the UI thread
        // accepting the message.
        let _ = progress.call2(
            &JsValue::NULL,
            &JsValue::from_str(stage),
            &JsValue::from_f64(frac),
        );
    };
    let result = sync::sync_audio_pcm_with_progress(ref_pcm, query_pcm, opts, &cb);
    let dto = SyncResultDto::from(result);
    serde_wasm_bindgen::to_value(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
}
