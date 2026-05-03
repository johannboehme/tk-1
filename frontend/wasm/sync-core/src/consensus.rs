//! Tier-3 fallback: chunked-PHAT consensus.
//!
//! When the global chroma+onset+PHAT stack lands on a "we're not sure"
//! state (peak-to-second-ratio near 1.0, PHAT PNR uniformly mediocre),
//! the chroma surface is essentially flat — every bar-shifted lag scores
//! about the same. Real-world materials that hit this regime: long-form
//! drum-heavy beat-making sessions captured through a room mic, concert
//! footage from an audience phone vs a clean main-mic master, anything
//! with strong rhythmic self-similarity and weak harmonic identity.
//!
//! The diagnostic that proved the underlying signal IS in the data:
//! split the reference (cleaner of the two signals) into N independent
//! chunks, run sample-level GCC-PHAT for each chunk against a wide
//! search window in the query, and bucket the resulting offsets. If a
//! single bucket collects most of the trustworthy chunks (high per-
//! chunk PNR), that bucket's median is the true offset — regardless of
//! what the global heuristic decided. This is essentially a democratic
//! vote across local sample-level alignments, which is far more robust
//! than any single global statistic on noisy-mic / repetitive material.
//!
//! Cost is bounded: each chunk's PHAT is FFT-sized to roughly
//! `next_pow2(chunk_seconds + 2*search_radius_seconds)` ≈ 1 M samples,
//! so 32 chunks ≈ 320 M ops. On a 16-min input this is well under 1 s
//! on a desktop CPU, dominated by the global chroma NCC pass.

use crate::phat::{gcc_phat, PHAT_BETA_DEFAULT};
use crate::salience::SalientAnchor;

/// Configuration for chunked-PHAT consensus.
#[derive(Debug, Clone, Copy)]
pub struct ChunkedConfig {
    /// Length of each reference chunk, in seconds.
    pub chunk_seconds: f32,
    /// How many chunks to sample (evenly spaced through ref). Energy-
    /// gated chunks below `min_chunk_rms` are skipped.
    pub n_chunks: usize,
    /// Half-width of the per-chunk lag-search window in query, in
    /// seconds. Wider = catches larger global offsets, but costs more
    /// FFT (window length grows linearly).
    pub search_radius_seconds: f32,
    /// Drop a chunk's vote if its PHAT PNR is below this. Anything
    /// below 6 is essentially noise.
    pub min_pnr: f32,
    /// Minimum number of chunks that must land in the same bucket for
    /// the consensus to fire. With 32 chunks and 100 ms buckets, 4
    /// agreeing chunks at PNR ≥ 6 each is already overwhelming
    /// evidence (random offsets across a 60 s search window have a
    /// ~1/600 chance of hitting any given 100 ms bucket).
    pub min_agreeing_chunks: usize,
    /// Bucket width (in ms) for clustering offsets. 100 ms is wide
    /// enough to absorb chunk-to-chunk wobble from local content
    /// variation, narrow enough that a true global offset doesn't get
    /// split across two buckets.
    pub bucket_ms: f32,
    /// Skip chunks whose RMS is below this (silent / near-silent).
    /// Avoids wasting FFTs on dead air.
    pub min_chunk_rms: f32,
}

impl Default for ChunkedConfig {
    fn default() -> Self {
        Self {
            chunk_seconds: 8.0,
            n_chunks: 32,
            search_radius_seconds: 30.0,
            min_pnr: 6.0,
            min_agreeing_chunks: 4,
            bucket_ms: 100.0,
            min_chunk_rms: 1e-3,
        }
    }
}

/// A single per-chunk vote.
#[derive(Debug, Clone, Copy)]
pub struct ChunkVote {
    /// Where in the reference this chunk started (sample index).
    pub ref_start_samples: u64,
    /// Global offset in algorithm convention (positive = query lags
    /// ref). Translated from chunk's local PHAT lag.
    pub offset_samples: i64,
    /// Peak-to-noise ratio of the chunk's PHAT result.
    pub pnr: f32,
    /// RMS energy of the chunk (skipped if below `min_chunk_rms`).
    pub rms: f32,
}

/// Outcome of consensus voting.
#[derive(Debug, Clone)]
pub struct ConsensusResult {
    /// Median offset across the agreeing chunks, in samples.
    pub offset_samples: i64,
    /// Per-chunk votes that fell in the winning bucket.
    pub agreeing_chunks: Vec<ChunkVote>,
    /// All chunks we attempted (including silent / low-PNR drops, with
    /// PNR=0 marking the drop). Useful for debugging / UI surfacing.
    pub all_chunks: Vec<ChunkVote>,
    /// Sum of PNRs across agreeing chunks. The headline confidence
    /// number — a single 30-PNR chunk and three 6-PNR chunks both
    /// produce strong consensuses, but sum-of-PNRs orders them
    /// reasonably.
    pub combined_pnr: f32,
}

/// Inner voting kernel: given an explicit list of `(ref_start, weight)`
/// chunk positions and a search radius around each, run GCC-PHAT for
/// every chunk against the query, bucket the resulting offsets, and
/// return the winning bucket if it meets the `min_agreeing_chunks`
/// threshold.
///
/// Both the uniform-chunked and the salient-anchor consensus paths
/// route through here; they only differ in how `ref_starts` are
/// selected.
fn vote_at_chunk_positions(
    ref_y: &[f32],
    query_y: &[f32],
    sample_rate: u32,
    ref_starts: &[usize],
    chunk_n: usize,
    radius_n: i64,
    cfg: &ChunkedConfig,
) -> Option<ConsensusResult> {
    let query_len_i = query_y.len() as i64;
    if ref_y.len() < chunk_n + 1 || query_y.len() < chunk_n + 1 {
        return None;
    }
    let min_q_window = chunk_n as i64 + (2.0 * sample_rate as f32) as i64;

    let mut votes: Vec<ChunkVote> = Vec::with_capacity(ref_starts.len());
    for &ref_start in ref_starts {
        if ref_start + chunk_n > ref_y.len() {
            continue;
        }
        let chunk = &ref_y[ref_start..ref_start + chunk_n];
        let rms = (chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32).sqrt();
        if rms < cfg.min_chunk_rms {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        let q_start = (ref_start as i64 - radius_n).max(0);
        let q_end = ((ref_start + chunk_n) as i64 + radius_n).min(query_len_i);
        if q_end - q_start < min_q_window {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }
        let q_slice = &query_y[q_start as usize..q_end as usize];

        let chunk_h = hann(chunk);
        let q_h = hann(q_slice);
        let phat = gcc_phat(&q_h, &chunk_h, PHAT_BETA_DEFAULT);
        if phat.is_empty() {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        let mut peak_idx = 0usize;
        let mut peak_val = f32::NEG_INFINITY;
        for (k, v) in phat.iter().enumerate() {
            if *v > peak_val {
                peak_val = *v;
                peak_idx = k;
            }
        }
        if !peak_val.is_finite() {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        let mut sum_sq = 0.0_f64;
        let mut count = 0usize;
        for (k, v) in phat.iter().enumerate() {
            if (k as i64 - peak_idx as i64).abs() <= 50 {
                continue;
            }
            let x = *v as f64;
            sum_sq += x * x;
            count += 1;
        }
        let std_floor = if count > 0 {
            (sum_sq / count as f64).sqrt() as f32
        } else {
            1e-9
        };
        let pnr = peak_val / std_floor.max(1e-9);

        // chunk content sits at q_start + (peak_idx - (chunk_n - 1)).
        // Algorithm-convention global offset (positive = query lags ref):
        //   master[t] = query[t - offset]
        //   chunk's master_t = ref_start, query position = ref_start - offset
        //   → offset = ref_start - chunk_pos_in_q_global
        let chunk_pos_in_q_window = peak_idx as i64 - (chunk_n as i64 - 1);
        let chunk_pos_in_q_global = q_start + chunk_pos_in_q_window;
        let global_offset_samples = ref_start as i64 - chunk_pos_in_q_global;

        votes.push(ChunkVote {
            ref_start_samples: ref_start as u64,
            offset_samples: global_offset_samples,
            pnr,
            rms,
        });
    }

    let bucket_samples = (cfg.bucket_ms / 1000.0 * sample_rate as f32) as i64;
    if bucket_samples <= 0 {
        return None;
    }
    use std::collections::HashMap;
    let mut buckets: HashMap<i64, Vec<ChunkVote>> = HashMap::new();
    for vote in votes.iter().filter(|v| v.pnr >= cfg.min_pnr) {
        let bucket = vote.offset_samples.div_euclid(bucket_samples);
        buckets.entry(bucket).or_default().push(*vote);
    }
    let (_winning_bucket, winning_votes) = buckets
        .into_iter()
        .max_by_key(|(_, v)| (v.len(), v.iter().map(|x| x.pnr as i64).sum::<i64>()))?;
    if winning_votes.len() < cfg.min_agreeing_chunks {
        return None;
    }

    let mut offsets: Vec<i64> = winning_votes.iter().map(|v| v.offset_samples).collect();
    offsets.sort();
    let median = offsets[offsets.len() / 2];
    let combined_pnr: f32 = winning_votes.iter().map(|v| v.pnr).sum();

    Some(ConsensusResult {
        offset_samples: median,
        agreeing_chunks: winning_votes,
        all_chunks: votes,
        combined_pnr,
    })
}

/// Run chunked-PHAT consensus voting on UNIFORMLY-SPACED reference
/// chunks. Used as a baseline / fallback when no salient-anchor list
/// is available. See `salient_phat_consensus` for the smarter version.
///
/// Returns `None` if no bucket has at least `cfg.min_agreeing_chunks`
/// trustworthy chunks.
pub fn chunked_phat_consensus(
    ref_y: &[f32],
    query_y: &[f32],
    sample_rate: u32,
    cfg: ChunkedConfig,
) -> Option<ConsensusResult> {
    let chunk_n = (cfg.chunk_seconds * sample_rate as f32) as usize;
    let radius_n = (cfg.search_radius_seconds * sample_rate as f32) as i64;
    if ref_y.len() < chunk_n + 1 {
        return None;
    }
    let usable = ref_y.len() - chunk_n;
    let mut ref_starts: Vec<usize> = Vec::with_capacity(cfg.n_chunks);
    for i in 0..cfg.n_chunks {
        let frac = (i as f32 + 0.5) / cfg.n_chunks as f32;
        ref_starts.push((frac * usable as f32) as usize);
    }
    vote_at_chunk_positions(ref_y, query_y, sample_rate, &ref_starts, chunk_n, radius_n, &cfg)
}

/// Run consensus voting on EXPLICIT salient anchors. Each anchor's
/// `center_samples` becomes the centre of an 8-second chunk; PHAT
/// searches for that chunk in the query within ±search_radius_seconds.
///
/// The caller is expected to:
///   - generate `anchors` from the cleaner of the two tracks (use
///     `salience::ref_is_cleaner` if unsure),
///   - pass the cleaner track as `ref_y` and the dirtier as `query_y`,
///   - pass a `coarse_offset_samples` from a prior alignment stage so
///     that PHAT only searches a tight corridor around the expected
///     match (much smaller than the global ±30 s default).
///
/// `coarse_offset_samples` is the ALGORITHM-convention offset
/// (positive = query lags ref). The function shifts the query search
/// window by this much before searching ±search_radius_seconds around
/// the shifted position, so the effective search corridor is
/// `coarse ± search_radius`.
pub fn salient_phat_consensus(
    ref_y: &[f32],
    query_y: &[f32],
    sample_rate: u32,
    anchors: &[SalientAnchor],
    coarse_offset_samples: i64,
    cfg: ChunkedConfig,
) -> Option<ConsensusResult> {
    if anchors.is_empty() {
        return None;
    }
    let chunk_n = (cfg.chunk_seconds * sample_rate as f32) as usize;
    let radius_n = (cfg.search_radius_seconds * sample_rate as f32) as i64;
    let half_chunk = (chunk_n / 2) as i64;
    let ref_len_i = ref_y.len() as i64;

    // Salient anchors point at the centre of an interesting event;
    // turn that into a `ref_start` such that the chunk is centred on
    // the anchor and stays within the ref signal.
    let mut ref_starts: Vec<usize> = Vec::with_capacity(anchors.len());
    for a in anchors {
        let center = a.center_samples as i64;
        let mut start = center - half_chunk;
        if start < 0 {
            start = 0;
        }
        if start + chunk_n as i64 > ref_len_i {
            start = ref_len_i - chunk_n as i64;
        }
        if start < 0 {
            continue;
        }
        ref_starts.push(start as usize);
    }
    if ref_starts.is_empty() {
        return None;
    }

    // Apply the coarse offset by shifting the query "view" by
    // coarse_offset_samples. We do that by pretending the query
    // starts coarse_offset_samples later — i.e. we pad the front of
    // the query with zeros (or trim it) so that, at the shifted index,
    // it lines up with the ref. Cheaper alternative: don't shift the
    // signal, instead bias the per-chunk q_start computation. We do
    // the latter by passing through a tiny wrapper.
    vote_at_chunk_positions_shifted(
        ref_y,
        query_y,
        sample_rate,
        &ref_starts,
        chunk_n,
        radius_n,
        coarse_offset_samples,
        &cfg,
    )
}

/// Same as `vote_at_chunk_positions` but biases the query search
/// window by `coarse_offset_samples`. Used by `salient_phat_consensus`
/// to keep the per-anchor search corridor tight around a prior coarse
/// estimate (e.g. from envelope or chroma).
fn vote_at_chunk_positions_shifted(
    ref_y: &[f32],
    query_y: &[f32],
    sample_rate: u32,
    ref_starts: &[usize],
    chunk_n: usize,
    radius_n: i64,
    coarse_offset_samples: i64,
    cfg: &ChunkedConfig,
) -> Option<ConsensusResult> {
    let query_len_i = query_y.len() as i64;
    if ref_y.len() < chunk_n + 1 || query_y.len() < chunk_n + 1 {
        return None;
    }
    let min_q_window = chunk_n as i64 + (2.0 * sample_rate as f32) as i64;

    let mut votes: Vec<ChunkVote> = Vec::with_capacity(ref_starts.len());
    for &ref_start in ref_starts {
        if ref_start + chunk_n > ref_y.len() {
            continue;
        }
        let chunk = &ref_y[ref_start..ref_start + chunk_n];
        let rms = (chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32).sqrt();
        if rms < cfg.min_chunk_rms {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        // Expected chunk position in query, given coarse offset:
        //   master[ref_start] aligns with query[ref_start - coarse_offset]
        let expected_q_pos = ref_start as i64 - coarse_offset_samples;
        let q_start = (expected_q_pos - radius_n).max(0);
        let q_end = (expected_q_pos + chunk_n as i64 + radius_n).min(query_len_i);
        if q_end - q_start < min_q_window {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }
        let q_slice = &query_y[q_start as usize..q_end as usize];

        let chunk_h = hann(chunk);
        let q_h = hann(q_slice);
        let phat = gcc_phat(&q_h, &chunk_h, PHAT_BETA_DEFAULT);
        if phat.is_empty() {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        let mut peak_idx = 0usize;
        let mut peak_val = f32::NEG_INFINITY;
        for (k, v) in phat.iter().enumerate() {
            if *v > peak_val {
                peak_val = *v;
                peak_idx = k;
            }
        }
        if !peak_val.is_finite() {
            votes.push(ChunkVote {
                ref_start_samples: ref_start as u64,
                offset_samples: 0,
                pnr: 0.0,
                rms,
            });
            continue;
        }

        let mut sum_sq = 0.0_f64;
        let mut count = 0usize;
        for (k, v) in phat.iter().enumerate() {
            if (k as i64 - peak_idx as i64).abs() <= 50 {
                continue;
            }
            let x = *v as f64;
            sum_sq += x * x;
            count += 1;
        }
        let std_floor = if count > 0 {
            (sum_sq / count as f64).sqrt() as f32
        } else {
            1e-9
        };
        let pnr = peak_val / std_floor.max(1e-9);

        let chunk_pos_in_q_window = peak_idx as i64 - (chunk_n as i64 - 1);
        let chunk_pos_in_q_global = q_start + chunk_pos_in_q_window;
        let global_offset_samples = ref_start as i64 - chunk_pos_in_q_global;

        votes.push(ChunkVote {
            ref_start_samples: ref_start as u64,
            offset_samples: global_offset_samples,
            pnr,
            rms,
        });
    }

    let bucket_samples = (cfg.bucket_ms / 1000.0 * sample_rate as f32) as i64;
    if bucket_samples <= 0 {
        return None;
    }
    use std::collections::HashMap;
    let mut buckets: HashMap<i64, Vec<ChunkVote>> = HashMap::new();
    for vote in votes.iter().filter(|v| v.pnr >= cfg.min_pnr) {
        let bucket = vote.offset_samples.div_euclid(bucket_samples);
        buckets.entry(bucket).or_default().push(*vote);
    }
    let (_winning_bucket, winning_votes) = buckets
        .into_iter()
        .max_by_key(|(_, v)| (v.len(), v.iter().map(|x| x.pnr as i64).sum::<i64>()))?;
    if winning_votes.len() < cfg.min_agreeing_chunks {
        return None;
    }

    let mut offsets: Vec<i64> = winning_votes.iter().map(|v| v.offset_samples).collect();
    offsets.sort();
    let median = offsets[offsets.len() / 2];
    let combined_pnr: f32 = winning_votes.iter().map(|v| v.pnr).sum();

    Some(ConsensusResult {
        offset_samples: median,
        agreeing_chunks: winning_votes,
        all_chunks: votes,
        combined_pnr,
    })
}

fn hann(y: &[f32]) -> Vec<f32> {
    let n = y.len();
    if n < 2 {
        return y.to_vec();
    }
    let denom = (n - 1) as f32;
    y.iter()
        .enumerate()
        .map(|(i, &v)| {
            let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / denom).cos());
            v * w
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_song(secs: f32, sr: u32) -> Vec<f32> {
        // Pseudo-random but deterministic broadband signal — an FFT-
        // friendly test pattern that exercises the phase-coherent
        // matcher without triggering chroma's harmonic-only assumptions.
        let n = (secs * sr as f32) as usize;
        let mut state: u64 = 0xdead_beef_1234_5678;
        let mut y = vec![0.0f32; n];
        for v in y.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *v = ((state as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.5;
        }
        y
    }

    #[test]
    fn consensus_recovers_known_offset_on_shifted_noise() {
        let sr = 22050u32;
        let song = make_song(60.0, sr);
        // ref = silence(0.5s) + song; query = song. Mirrors the
        // convention used by sync_audio_pcm's existing unit tests:
        // "+offset = query lags ref" → query's song event happens at
        // wall-clock 0 while ref's song event is at wall-clock +0.5 s,
        // so query started at wall-clock +0.5 s relative to ref → ref
        // started 500 ms first → +500 ms offset.
        let pad = (0.5 * sr as f32) as usize;
        let mut reference = vec![0.0f32; pad];
        reference.extend_from_slice(&song);
        let r = chunked_phat_consensus(&reference, &song, sr, ChunkedConfig::default())
            .expect("consensus should fire");
        let off_ms = r.offset_samples as f64 / sr as f64 * 1000.0;
        assert!(
            (off_ms - 500.0).abs() < 50.0,
            "consensus offset = {} ms (expected ~+500), agreeing={} combined_pnr={}",
            off_ms,
            r.agreeing_chunks.len(),
            r.combined_pnr
        );
        assert!(
            r.agreeing_chunks.len() >= 4,
            "should have ≥4 agreeing chunks, got {}",
            r.agreeing_chunks.len()
        );
    }

    #[test]
    fn consensus_returns_none_for_pure_silence() {
        let sr = 22050u32;
        let silence = vec![0.0f32; (10.0 * sr as f32) as usize];
        assert!(chunked_phat_consensus(&silence, &silence, sr, ChunkedConfig::default()).is_none());
    }

    #[test]
    fn consensus_combined_pnr_low_on_unrelated_signals() {
        let sr = 22050u32;
        let a = make_song(20.0, sr);
        // Different RNG seed = unrelated signal of same length.
        let mut state: u64 = 0xcafe_babe_8765_4321;
        let mut b = vec![0.0f32; a.len()];
        for v in b.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *v = ((state as f32 / u64::MAX as f32) * 2.0 - 1.0) * 0.5;
        }
        // Two unrelated signals: pure-noise PHAT cross-correlations
        // can still produce mid-PNR (~6–10) random alignments and a
        // handful might happen to fall in the same 100-ms bucket.
        // What matters is that the COMBINED PNR — the sum across the
        // winning bucket — stays well below the real-signal level
        // (real-world failing case: 1.3 k+; here we expect < 200).
        // The override criterion in sync.rs guards on combined_pnr,
        // so this test exercises the relevant safety property.
        let result = chunked_phat_consensus(&a, &b, sr, ChunkedConfig::default());
        if let Some(r) = result {
            assert!(
                r.combined_pnr < 200.0,
                "unrelated-signal consensus has unexpectedly high combined_pnr: {} ({} chunks)",
                r.combined_pnr,
                r.agreeing_chunks.len(),
            );
        }
    }
}
