//! Salient-anchor detection: find the moments in an audio signal that
//! are spectrally _unique_ relative to their local neighbourhood.
//!
//! Rationale: in long-form same-source audio (16-min beat-making
//! session, 90-min concert recording, etc.), most of the timeline is
//! repetitive — a 4-bar loop running for two minutes contributes no
//! information that distinguishes "bar 1" from "bar 8". The places
//! that DO distinguish are the rare events: a sample-try outside the
//! grid, a chord change at a section boundary, a brief silence between
//! sections, a live-performance phrase. These are the moments where
//! sample-precise alignment is both necessary and possible — a true
//! match locks in, every bar-shifted impostor falls apart.
//!
//! This module computes a per-frame _novelty_ score (how different is
//! this frame's spectrum from the local-neighbourhood average) and
//! returns the top-K peaks with a min-spacing constraint. The caller
//! then runs phase-precise PHAT alignment exclusively on those anchor
//! windows.
//!
//! Cross-track soundness: we always run salience detection on the
//! _cleaner_ of the two tracks (higher SNR / peak-to-rms ratio). Any
//! event present in the cleaner track is — by physical guarantee —
//! also present in the dirtier track (modulo room verb / mic EQ /
//! codec artifacts), since the dirty track is just a re-recording of
//! the same source. The reverse doesn't hold (speech, keyboard
//! clicks, applause picked up by a mic don't appear in the direct-
//! out source), so picking salient points on the dirty track would
//! risk anchoring on events that have no counterpart to align against.

use crate::chroma::{ChromaMatrix, HOP, N_PITCH_CLASSES};

/// Configuration for salient-anchor detection.
#[derive(Debug, Clone, Copy)]
pub struct SalienceConfig {
    /// How many anchor points to return at most. With 12 anchors at
    /// PHAT PNR ≥ 6 each, the consensus voting is overwhelmingly
    /// strong — random alignment can't reproduce 12 independent sample-
    /// level coincidences on the same offset.
    pub max_anchors: usize,
    /// Minimum spacing between anchor points, in seconds. Prevents
    /// piling up multiple anchors on the same salient event (a vocal
    /// phrase that lasts 2 s would otherwise generate 80 nearly-
    /// identical anchors).
    pub min_spacing_seconds: f32,
    /// Half-width (in seconds) of the local context window used for
    /// novelty computation. Frames are scored against the average
    /// chroma of frames within ±this many seconds. 5 s is a reasonable
    /// "what's happening around me right now" scope.
    pub context_radius_seconds: f32,
    /// Drop anchors whose novelty is below this fraction of the curve's
    /// peak. Keeps the consensus from including barely-salient frames
    /// just because the spacing constraint left them as the next-best
    /// candidates.
    pub min_relative_novelty: f32,
}

impl Default for SalienceConfig {
    fn default() -> Self {
        Self {
            max_anchors: 12,
            min_spacing_seconds: 5.0,
            context_radius_seconds: 5.0,
            min_relative_novelty: 0.3,
        }
    }
}

/// A chosen anchor: where in the signal it sits and how salient it is.
#[derive(Debug, Clone, Copy)]
pub struct SalientAnchor {
    /// Sample index of the anchor centre in the underlying audio.
    pub center_samples: u64,
    /// Novelty score at the chosen frame. Larger = more unique vs
    /// neighbourhood. Useful for caller-side weighting/ranking.
    pub novelty: f32,
}

/// Compute the per-frame novelty curve: for each chroma frame, the
/// L2 distance between its (already-L2-normalised) chroma vector and
/// the average chroma vector across a ±context_radius_seconds window.
///
/// Frames in repetitive sections will have small distance (their
/// content matches the local average); frames at section boundaries
/// or unique events will have large distance.
pub fn novelty_curve(chroma: &ChromaMatrix, sample_rate: u32, context_radius_seconds: f32) -> Vec<f32> {
    let n = chroma.n_frames;
    if n == 0 {
        return Vec::new();
    }
    let frames_per_sec = sample_rate as f32 / HOP as f32;
    let radius = (context_radius_seconds * frames_per_sec) as usize;
    if radius == 0 || radius >= n {
        return vec![0.0; n];
    }

    // Pre-compute prefix sums per chroma class so the local-context
    // mean is a single subtraction per frame rather than a 2*radius
    // loop. O(n) total.
    let mut prefix = vec![0.0f64; (n + 1) * N_PITCH_CLASSES];
    for c in 0..N_PITCH_CLASSES {
        let row = chroma.row(c);
        for t in 0..n {
            prefix[(t + 1) * N_PITCH_CLASSES + c] =
                prefix[t * N_PITCH_CLASSES + c] + row[t] as f64;
        }
    }

    let mut novelty = vec![0.0f32; n];
    for t in 0..n {
        let lo = t.saturating_sub(radius);
        let hi = (t + radius + 1).min(n);
        let win = (hi - lo) as f64;
        if win < 4.0 {
            continue;
        }
        let mut dist_sq = 0.0_f64;
        for c in 0..N_PITCH_CLASSES {
            let sum = prefix[hi * N_PITCH_CLASSES + c] - prefix[lo * N_PITCH_CLASSES + c];
            let mean = sum / win;
            let d = chroma.row(c)[t] as f64 - mean;
            dist_sq += d * d;
        }
        novelty[t] = dist_sq.sqrt() as f32;
    }
    novelty
}

/// Pick the top-K novelty peaks with a min-spacing constraint.
///
/// Greedy: sort frames by novelty descending; iterate, accept a frame
/// if no already-accepted frame is within `min_spacing_frames`. Stop
/// when we have `max_anchors` or run out of frames above the relative
/// threshold.
pub fn pick_anchors(
    novelty: &[f32],
    sample_rate: u32,
    cfg: SalienceConfig,
) -> Vec<SalientAnchor> {
    if novelty.is_empty() {
        return Vec::new();
    }
    let frames_per_sec = sample_rate as f32 / HOP as f32;
    let min_spacing = (cfg.min_spacing_seconds * frames_per_sec) as usize;
    let max_novelty = novelty.iter().copied().fold(0.0_f32, f32::max);
    if max_novelty <= 1e-9 {
        return Vec::new();
    }
    let cutoff = max_novelty * cfg.min_relative_novelty;

    let mut indexed: Vec<(usize, f32)> = novelty
        .iter()
        .enumerate()
        .filter(|(_, &v)| v >= cutoff)
        .map(|(i, &v)| (i, v))
        .collect();
    indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut accepted: Vec<(usize, f32)> = Vec::with_capacity(cfg.max_anchors);
    for (i, v) in indexed {
        if accepted.len() >= cfg.max_anchors {
            break;
        }
        let too_close = accepted
            .iter()
            .any(|(j, _)| (i as isize - *j as isize).unsigned_abs() < min_spacing.max(1));
        if too_close {
            continue;
        }
        accepted.push((i, v));
    }

    accepted
        .into_iter()
        .map(|(frame_idx, v)| SalientAnchor {
            center_samples: frame_idx as u64 * HOP as u64,
            novelty: v,
        })
        .collect()
}

/// Estimate which of two signals is "cleaner" by comparing their peak-
/// to-RMS ratio. Higher ratio = more headroom = more impulsive content
/// surviving the path = cleaner direct take. Returns `true` if `ref_y`
/// looks cleaner than `query_y`.
pub fn ref_is_cleaner(ref_y: &[f32], query_y: &[f32]) -> bool {
    let ratio = |y: &[f32]| -> f32 {
        if y.is_empty() {
            return 0.0;
        }
        let mut peak = 0.0_f32;
        let mut sum_sq = 0.0_f64;
        for &s in y {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
            sum_sq += (s as f64) * (s as f64);
        }
        let rms = (sum_sq / y.len() as f64).sqrt() as f32;
        if rms < 1e-9 {
            0.0
        } else {
            peak / rms
        }
    };
    ratio(ref_y) >= ratio(query_y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chroma::chroma_features;
    use std::f32::consts::PI;

    fn tone(freq: f32, secs: f32, sr: u32) -> Vec<f32> {
        let n = (secs * sr as f32) as usize;
        (0..n)
            .map(|i| 0.5 * (2.0 * PI * freq * i as f32 / sr as f32).sin())
            .collect()
    }

    fn make_track_with_unique_event(sr: u32) -> Vec<f32> {
        // 30 s of repeating pattern A, then 5 s of unique pattern B,
        // then another 30 s of pattern A. Novelty curve should peak in
        // the middle.
        let mut y: Vec<f32> = Vec::new();
        for _ in 0..15 {
            y.extend(tone(220.0, 1.0, sr));
            y.extend(tone(330.0, 1.0, sr));
        }
        // Unique segment: a different chord progression.
        for _ in 0..5 {
            y.extend(tone(440.0, 0.5, sr));
            y.extend(tone(550.0, 0.5, sr));
        }
        for _ in 0..15 {
            y.extend(tone(220.0, 1.0, sr));
            y.extend(tone(330.0, 1.0, sr));
        }
        y
    }

    #[test]
    fn novelty_peaks_at_section_boundary() {
        let sr = 22050u32;
        let y = make_track_with_unique_event(sr);
        let chroma = chroma_features(&y, sr);
        let nov = novelty_curve(&chroma, sr, 5.0);
        assert!(!nov.is_empty());
        // The unique segment starts at ~30 s and ends at ~35 s. With
        // 23 ms per chroma frame, that's frame indices ~1290..1505.
        // Find the global max.
        let (max_idx, max_val) = nov
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap();
        let max_seconds = max_idx as f32 * HOP as f32 / sr as f32;
        assert!(
            (28.0..38.0).contains(&max_seconds),
            "novelty peak at {} s (expected ~30-35 s), val={}",
            max_seconds,
            max_val
        );
    }

    #[test]
    fn anchors_respect_min_spacing() {
        let sr = 22050u32;
        let y = make_track_with_unique_event(sr);
        let chroma = chroma_features(&y, sr);
        let nov = novelty_curve(&chroma, sr, 5.0);
        let anchors = pick_anchors(
            &nov,
            sr,
            SalienceConfig {
                max_anchors: 5,
                min_spacing_seconds: 5.0,
                context_radius_seconds: 5.0,
                min_relative_novelty: 0.0,
            },
        );
        for i in 1..anchors.len() {
            for j in 0..i {
                let di = anchors[i].center_samples as i64 - anchors[j].center_samples as i64;
                let di_s = di.unsigned_abs() as f32 / sr as f32;
                assert!(di_s >= 4.9, "anchors {} and {} too close: {} s", i, j, di_s);
            }
        }
    }

    #[test]
    fn ref_is_cleaner_detects_higher_peak_to_rms() {
        let sr = 22050u32;
        // a = sparse impulses (high peak/RMS), b = continuous noise
        // (low peak/RMS).
        let mut a = vec![0.0f32; (5.0 * sr as f32) as usize];
        for i in 0..a.len() {
            if i % 4096 == 0 {
                a[i] = 1.0;
            }
        }
        let mut state: u64 = 1;
        let mut b = vec![0.0f32; a.len()];
        for v in b.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *v = ((state as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.3;
        }
        assert!(ref_is_cleaner(&a, &b));
        assert!(!ref_is_cleaner(&b, &a));
    }
}
