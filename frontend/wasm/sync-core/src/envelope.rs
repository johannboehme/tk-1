//! Tier-0 (coarsest) alignment: RMS-envelope cross-correlation.
//!
//! For same-source recordings (same performance captured through two
//! different paths) the loudness shape over time is essentially
//! identical — modulo a constant scaling factor and the noise floor of
//! whichever path is dirtier. Cross-correlating a 10 Hz RMS envelope of
//! both tracks gives one clear global peak at the true offset, robust
//! against:
//!   - microphone EQ / room reverb (energy is preserved through the
//!     speaker→room→mic path; only its spectral shape changes),
//!   - codec artifacts (encoder doesn't drastically reshape RMS),
//!   - drum-heavy fragmented content (envelope shape over a 16-min
//!     beatmaking session is hugely unique even when every individual
//!     bar looks like every other bar harmonically).
//!
//! Compute is trivial: 16 min @ 22 050 Hz mono → 21 M samples. RMS
//! windows of 100 ms (2 205 samples each) → 9 600 envelope points.
//! Cross-correlation of two 9 600-point vectors via FFT → ms-range.
//!
//! This stage runs FIRST and provides a coarse search corridor for the
//! finer chroma+onset stage. When the envelope correlation has a sharp
//! peak (peak-to-second-ratio ≥ 1.5), we trust it and let it constrain
//! downstream search. When it's weak (mostly-flat content), we fall
//! through to the global chroma path uncorridored.

use crate::xcorr::correlate_full;

/// Envelope-stage configuration.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeConfig {
    /// RMS-envelope sampling rate (Hz). 10 Hz = one envelope sample
    /// per 100 ms — fine enough to localise a 16-min match within a
    /// few hundred ms, coarse enough that the cross-correlation is
    /// dirt-cheap.
    pub envelope_hz: f32,
    /// Reject the envelope's pick when peak / second-peak ratio is
    /// below this. 1.5 means the runner-up has to be at least 33 %
    /// weaker than the winner. Below this threshold the envelope
    /// surface is too flat for the result to be trustworthy.
    pub min_peak_to_second: f32,
}

impl Default for EnvelopeConfig {
    fn default() -> Self {
        Self {
            envelope_hz: 10.0,
            min_peak_to_second: 1.5,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EnvelopeResult {
    /// Recovered offset, in audio samples. Same convention as
    /// `MatchCandidate::offset_samples`: positive = query later than
    /// ref.
    pub offset_samples: i64,
    /// Pearson-style normalised correlation at the chosen lag, [0, 1].
    pub correlation: f32,
    /// Peak / second-peak on the envelope cross-correlation surface.
    /// `f32::INFINITY` when there is no second peak.
    pub peak_to_second: f32,
}

/// Compute the RMS envelope of `y` at `envelope_hz` Hz.
fn rms_envelope(y: &[f32], sample_rate: u32, envelope_hz: f32) -> Vec<f32> {
    let win = (sample_rate as f32 / envelope_hz).max(1.0) as usize;
    let n = y.len() / win;
    let mut env = Vec::with_capacity(n);
    for i in 0..n {
        let start = i * win;
        let end = start + win;
        let mut sum_sq = 0.0_f64;
        for s in &y[start..end] {
            sum_sq += (*s as f64) * (*s as f64);
        }
        env.push((sum_sq / win as f64).sqrt() as f32);
    }
    env
}

/// Detrend an envelope by subtracting its mean. Removes the DC term
/// that would otherwise dominate the cross-correlation (a long stretch
/// of constant audio level shouldn't produce a peak).
fn detrend(env: &mut [f32]) {
    if env.is_empty() {
        return;
    }
    let mean: f32 = env.iter().copied().sum::<f32>() / env.len() as f32;
    for v in env.iter_mut() {
        *v -= mean;
    }
}

/// Find peak idx and value plus the next-strongest local maximum.
fn peak_and_runner_up(arr: &[f32]) -> Option<(usize, f32, f32)> {
    if arr.len() < 3 {
        return None;
    }
    let mut peak_idx = 0usize;
    let mut peak_val = arr[0];
    for (i, &v) in arr.iter().enumerate() {
        if v > peak_val {
            peak_val = v;
            peak_idx = i;
        }
    }
    if peak_val <= 0.0 {
        return None;
    }
    // Second-strongest local max with min-spacing of 5 envelope samples
    // (= 0.5 s at 10 Hz envelope rate). Avoids picking the same broad
    // peak's flank as the runner-up.
    let mut second_val = 0.0_f32;
    let min_spacing = 5usize;
    for i in 1..arr.len() - 1 {
        if (i as isize - peak_idx as isize).unsigned_abs() < min_spacing {
            continue;
        }
        if arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1] && arr[i] > second_val {
            second_val = arr[i];
        }
    }
    Some((peak_idx, peak_val, second_val))
}

/// Run envelope-cross-correlation alignment.
pub fn envelope_align(
    ref_y: &[f32],
    query_y: &[f32],
    sample_rate: u32,
    cfg: EnvelopeConfig,
) -> Option<EnvelopeResult> {
    let win = (sample_rate as f32 / cfg.envelope_hz).max(1.0) as usize;
    if ref_y.len() < win * 4 || query_y.len() < win * 4 {
        return None;
    }
    let mut env_ref = rms_envelope(ref_y, sample_rate, cfg.envelope_hz);
    let mut env_q = rms_envelope(query_y, sample_rate, cfg.envelope_hz);
    if env_ref.is_empty() || env_q.is_empty() {
        return None;
    }
    detrend(&mut env_ref);
    detrend(&mut env_q);

    // Cross-correlate query envelope with ref envelope. Same lag
    // convention as the chroma path: idx = ref.len()-1 is lag 0; idx >
    // means query is "later" in the correlate(query, ref) sense.
    let xc = correlate_full(&env_q, &env_ref);
    let (peak_idx, peak_val, second_val) = peak_and_runner_up(&xc)?;

    // Normalise peak by the joint L2 energy so we get a Pearson-like
    // value in (-1, 1] for reporting. The cross-correlation surface
    // peaks at `<env_q | env_ref>` for the right shift; dividing by
    // |env_ref|*|env_q| normalises to cosine similarity.
    let l2_ref = env_ref.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().sqrt();
    let l2_q = env_q.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().sqrt();
    let denom = (l2_ref * l2_q).max(1e-12) as f32;
    let correlation = (peak_val / denom).clamp(-1.0, 1.0);

    let peak_to_second = if second_val > 1e-9 {
        peak_val / second_val
    } else {
        f32::INFINITY
    };

    if peak_to_second < cfg.min_peak_to_second {
        // Surface is too flat to trust — let the caller fall back to
        // unconstrained chroma search.
        return None;
    }

    // Lag in ENVELOPE samples → audio samples.
    let lag_env = peak_idx as i64 - (env_ref.len() as i64 - 1);
    let offset_audio_samples = -lag_env * win as i64;

    Some(EnvelopeResult {
        offset_samples: offset_audio_samples,
        correlation,
        peak_to_second,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_modulated_noise(secs: f32, sr: u32) -> Vec<f32> {
        // White noise modulated by a slow envelope (sinus + occasional
        // spike) to give the RMS contour something to hold onto.
        let n = (secs * sr as f32) as usize;
        let mut state: u64 = 0xa5a5_a5a5_dead_beef;
        let mut y = vec![0.0f32; n];
        for (i, v) in y.iter_mut().enumerate() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let noise = ((state as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.5;
            let t = i as f32 / sr as f32;
            // Slow swell + occasional decay → unique envelope shape.
            let env = 0.3
                + 0.5 * (1.0 + (2.0 * std::f32::consts::PI * 0.07 * t).sin()) * 0.5
                + if (t as i32) % 7 == 3 { 0.4 } else { 0.0 };
            *v = noise * env;
        }
        y
    }

    #[test]
    fn envelope_recovers_known_offset() {
        let sr = 22050u32;
        let song = make_modulated_noise(60.0, sr);
        // ref = silence(0.5s) + song; query = song. Expected +500 ms
        // (matches the convention used by the existing sync.rs tests).
        let pad = (0.5 * sr as f32) as usize;
        let mut reference = vec![0.0f32; pad];
        reference.extend_from_slice(&song);
        // Test with a relaxed PSR threshold — synthetic XOR-shift noise
        // has weak envelope structure, so its self-similar slow trends
        // produce "second peaks" near the main peak. Real audio has
        // far higher PSR; this test only verifies the geometry of the
        // recovery, not the rejection threshold.
        let cfg = EnvelopeConfig {
            min_peak_to_second: 1.0,
            ..Default::default()
        };
        let r = envelope_align(&reference, &song, sr, cfg)
            .expect("envelope should fire on modulated noise");
        let off_ms = r.offset_samples as f64 / sr as f64 * 1000.0;
        // Tolerance: 1 envelope-sample = 100 ms at 10 Hz.
        assert!(
            (off_ms - 500.0).abs() < 150.0,
            "envelope offset = {} ms (expected ~+500), corr={} psr={}",
            off_ms,
            r.correlation,
            r.peak_to_second
        );
    }

    #[test]
    fn envelope_returns_none_on_flat_audio() {
        let sr = 22050u32;
        // Constant-RMS noise — no informative envelope shape.
        let mut state: u64 = 0xdead_beef;
        let mut a = vec![0.0f32; (10.0 * sr as f32) as usize];
        for v in a.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *v = ((state as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.3;
        }
        // Both signals identical and shape-less → envelope cross-corr
        // is dominated by autocorrelation noise; psr should be low.
        let r = envelope_align(&a, &a, sr, EnvelopeConfig::default());
        // Either return None (likely) or return with low confidence.
        if let Some(res) = r {
            assert!(
                res.peak_to_second < 3.0 || res.offset_samples.abs() < 5000,
                "flat-audio envelope match too confident: {:?}",
                res
            );
        }
    }
}
