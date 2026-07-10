//! Sliding-window drift refinement.
//!
//! Direct port of `app/pipeline/sync.py:_windowed_drift_refinement`.
//! Slides N windows of fixed length across the reference signal; for each
//! window, cross-correlates against a search slice of the query around the
//! coarse-aligned position; collects high-confidence matches; fits a line
//! through them to recover (offset, drift_ratio).

use crate::util::{median, polyfit_linear};
use crate::xcorr::correlate_full;

#[derive(Debug, Clone, Copy)]
pub struct DriftRefinementOutput {
    pub offset_samples: i64,
    pub drift_ratio: f64,
    /// Number of windows that produced a confident match.
    pub n_matches: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct DriftConfig {
    pub n_windows: usize,
    pub win_seconds: f32,
    pub search_radius_seconds: f32,
    pub min_peak_to_median: f32,
    pub min_rms: f32,
}

impl Default for DriftConfig {
    fn default() -> Self {
        Self {
            n_windows: 8,
            win_seconds: 10.0,
            search_radius_seconds: 5.0,
            min_peak_to_median: 6.0,
            min_rms: 0.005,
        }
    }
}

pub fn windowed_drift_refinement(
    ref_y: &[f32],
    query_y: &[f32],
    sr: u32,
    coarse_offset_samples: i64,
    cfg: DriftConfig,
) -> Option<DriftRefinementOutput> {
    let win_samples = (cfg.win_seconds * sr as f32) as usize;
    let radius_samples = (cfg.search_radius_seconds * sr as f32) as usize;
    if ref_y.len() < win_samples * 2 {
        return None;
    }
    let margin = (0.05 * ref_y.len() as f32) as usize;
    if ref_y.len() < 2 * margin + win_samples {
        return None;
    }
    let last_pos = ref_y.len() - margin - win_samples;
    if last_pos <= margin {
        return None;
    }

    let mut positions: Vec<usize> = Vec::with_capacity(cfg.n_windows);
    if cfg.n_windows == 1 {
        positions.push((margin + last_pos) / 2);
    } else {
        let step = (last_pos - margin) as f32 / (cfg.n_windows - 1) as f32;
        for k in 0..cfg.n_windows {
            positions.push(margin + (k as f32 * step) as usize);
        }
    }

    let mut matches: Vec<(f64, f64)> = Vec::new();

    for &p in &positions {
        let ref_w = &ref_y[p..p + win_samples];
        // RMS check.
        let rms = (ref_w.iter().map(|x| x * x).sum::<f32>() / win_samples as f32).sqrt();
        if rms < cfg.min_rms {
            continue;
        }

        // Search range in query around approx_q = p - coarse_offset.
        let approx_q = p as i64 - coarse_offset_samples;
        let q_lo = approx_q.saturating_sub(radius_samples as i64).max(0) as usize;
        let q_hi_raw = (approx_q + win_samples as i64 + radius_samples as i64).max(0) as usize;
        let q_hi = q_hi_raw.min(query_y.len());
        if q_hi <= q_lo + win_samples {
            continue;
        }
        let q_chunk = &query_y[q_lo..q_hi];

        // We want correlate(q_chunk, ref_w, mode="valid"), which produces
        // q_chunk.len() - ref_w.len() + 1 outputs. The output at index k
        // corresponds to q_chunk[k..k+win] · ref_w.
        let valid_len = q_chunk.len() - win_samples + 1;
        // Use FFT-based full correlation, then extract the valid region.
        // Full output length = q_chunk.len() + ref_w.len() - 1.
        // The "valid" region starts at index ref_w.len() - 1 and has length valid_len.
        let full = correlate_full(q_chunk, ref_w);
        let valid = &full[win_samples - 1..win_samples - 1 + valid_len];

        // Use absolute values, find peak and median.
        let abs: Vec<f32> = valid.iter().map(|x| x.abs()).collect();
        let med = median(&abs).max(1e-9);
        let mut peak_idx = 0usize;
        let mut peak_val = 0.0f32;
        for (i, &v) in abs.iter().enumerate() {
            if v > peak_val {
                peak_val = v;
                peak_idx = i;
            }
        }
        let peak_score = peak_val / med;
        if peak_score < cfg.min_peak_to_median {
            continue;
        }
        let q_pos = q_lo + peak_idx;
        matches.push((p as f64 / sr as f64, q_pos as f64 / sr as f64));
    }

    if matches.len() < 3 {
        return None;
    }

    let xs: Vec<f64> = matches.iter().map(|m| m.0).collect();
    let ys: Vec<f64> = matches.iter().map(|m| m.1).collect();
    let (drift, intercept_s) = polyfit_linear(&xs, &ys);
    // offset = ref_pos - query_pos = -intercept (at ref_pos = 0)
    let offset_samples = (-intercept_s * sr as f64).round() as i64;
    Some(DriftRefinementOutput {
        offset_samples,
        drift_ratio: drift,
        n_matches: matches.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testsig::{make_prng_song as make_song, resample_with_drift};

    #[test]
    fn refinement_recovers_pure_offset_no_drift() {
        let sr = 22050u32;
        let song = make_song(20.0, sr, 17);
        // Query is song delayed by 100 ms (offset_samples = 0 if query=ref offset is positive).
        // Convention: positive offset means query starts later in ref timeline.
        // We construct: ref = silence(0.1s) + song; query = song.
        let pad = (sr as f32 * 0.1) as usize;
        let mut reference = vec![0.0f32; pad];
        reference.extend_from_slice(&song);
        let query = song.clone();

        // coarse offset (ref leads query by 0.1s) → positive 2205.
        let cfg = DriftConfig::default();
        let r = windowed_drift_refinement(&reference, &query, sr, 2205, cfg)
            .expect("refinement should succeed");
        // drift ≈ 1, offset ≈ 2205.
        assert!(
            (r.drift_ratio - 1.0).abs() < 0.005,
            "drift = {}",
            r.drift_ratio
        );
        assert!(
            (r.offset_samples - 2205).abs() < (0.02 * sr as f64) as i64,
            "offset = {}",
            r.offset_samples
        );
    }

    /// The reason this module exists: recover a KNOWN non-1.0 clock drift.
    /// Consumer phones genuinely drift on long takes — 1.0005 is ≈ 45 ms of
    /// slip over a 90 s recording, plenty to visibly de-sync the tail — and
    /// `drift_ratio` is trusted unconditionally downstream (sync.rs) and
    /// applied multiplicatively to every frame lookup (edit.ts). A stub
    /// that never measures drift and returns 1.0 must fail here.
    ///
    /// Tolerances are the measured honest accuracy of the default config
    /// (8 windows × 10 s) on a 2-minute take, not wishes: across seeds the
    /// slope error envelope is ~±2.5e-4 (per-window matches carry a
    /// drift-proportional pivot ambiguity of up to ±win·|drift−1|), so we
    /// assert 3e-4 — still well below the 5e-4 distance of the smallest
    /// tested ratio from 1.0 — plus sign-and-magnitude so a "no drift"
    /// stub fails every case.
    #[test]
    fn refinement_recovers_known_drift_ratios() {
        let sr = 22050u32;
        let song = make_song(120.0, sr, 17);
        let pad_s = 0.2f64;
        let pad = (sr as f64 * pad_s) as usize;
        let mut reference = vec![0.0f32; pad];
        reference.extend_from_slice(&song);

        for &drift in &[0.9995f64, 1.0005, 1.002] {
            // Query = the same song, played on a clock that drifts by
            // `drift`, starting 0.2 s after the reference:
            //   query_time = drift * (ref_time - pad_s)
            // → fitted slope = drift, offset ≈ drift * pad samples.
            let query = resample_with_drift(&song, drift);
            // Coarse offset from the earlier pipeline stages — accurate to
            // well within the ±5 s search radius.
            let r = windowed_drift_refinement(
                &reference,
                &query,
                sr,
                pad as i64,
                DriftConfig::default(),
            )
            .unwrap_or_else(|| panic!("refinement should succeed at drift {drift}"));

            assert!(
                (r.drift_ratio - drift).abs() < 3e-4,
                "drift {} recovered as {} (err {:.2e})",
                drift,
                r.drift_ratio,
                (r.drift_ratio - drift).abs()
            );
            // Sign + magnitude: the recovered ratio must actually move off
            // 1.0 in the right direction, by at least 40 % of the truth.
            assert!(
                (r.drift_ratio - 1.0) * (drift - 1.0) > 0.0
                    && (r.drift_ratio - 1.0).abs() >= 0.4 * (drift - 1.0).abs(),
                "drift {} recovered as {} — no-drift-like result",
                drift,
                r.drift_ratio
            );
            // Offset: per-window pivot ambiguity puts an honest ±25 ms
            // envelope on the intercept; the pipeline itself only trusts
            // drift's offset when it agrees with PHAT within 50 ms.
            let expected_offset = (pad as f64 * drift).round() as i64;
            assert!(
                (r.offset_samples - expected_offset).abs() < (0.03 * sr as f64) as i64,
                "drift {}: offset = {} (expected ≈ {})",
                drift,
                r.offset_samples,
                expected_offset
            );
        }
    }
}
