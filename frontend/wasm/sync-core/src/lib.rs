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
pub mod ncc;
pub mod onset;
pub mod phat;
pub mod salience;
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
