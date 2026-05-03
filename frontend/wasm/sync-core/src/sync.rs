//! Top-level orchestrator: takes two PCM mono buffers, returns a SyncResult.
//!
//! Mirrors `app/pipeline/sync.py:sync_audio` 1:1 in structure.

use crate::chroma::{self, ChromaMatrix, HOP, N_PITCH_CLASSES};
use crate::consensus::{chunked_phat_consensus, salient_phat_consensus, ChunkedConfig};
use crate::drift::{windowed_drift_refinement, DriftConfig};
use crate::dtw::dtw_drift;
use crate::envelope::{envelope_align, EnvelopeConfig, EnvelopeResult};
use crate::ncc::{align_with_onset, MatchCandidate};
use crate::onset::onset_envelope;
use crate::phat::phat_refine;
use crate::salience::{novelty_curve, pick_anchors, ref_is_cleaner, SalienceConfig};
use crate::util::peak_normalize;
use crate::xcorr::correlate_full;

#[derive(Debug, Clone)]
pub struct SyncResult {
    pub offset_ms: f64,
    pub confidence: f64,
    pub drift_ratio: f64,
    pub method: String,
    pub warning: Option<String>,
    /// Alternate match candidates with NCC ≥ 60 % of the primary's. Sorted
    /// descending by NCC. Used by the editor for snap-to-alternate-match.
    pub candidates: Vec<MatchCandidateOut>,
    /// Primary peak / second-highest peak on the ranking surface. >1.5 ≈
    /// comfortable margin; ≈1.0 means the runner-up is essentially as
    /// strong as the pick (UI should warn). `f64::INFINITY` when no
    /// runner-up exists. Surfaced from `AlignmentReport::discrimination`.
    pub peak_to_second_ratio: f64,
    /// Primary peak / median correlation over the valid-overlap region.
    /// "How exceptional is the chosen lag." `f64::INFINITY` for
    /// degenerate inputs.
    pub peak_to_noise: f64,
    /// GCC-PHAT peak-to-noise ratio when the Stage-B refinement ran;
    /// `0.0` if PHAT was skipped (low chroma confidence) or rejected
    /// (PNR below the trust threshold). Same-source same-mic recordings
    /// typically score 30–100; cover/different-performance pairs are
    /// near the floor.
    pub phat_pnr: f64,
}

#[derive(Debug, Clone)]
pub struct MatchCandidateOut {
    pub offset_ms: f64,
    pub confidence: f64,
    pub overlap_frames: u32,
}

impl From<&MatchCandidate> for MatchCandidateOut {
    fn from(c: &MatchCandidate) -> Self {
        // Use the actual SR — passed in via a closure or recomputed here.
        // This conversion lives in `sync_audio_pcm` where SR is in scope.
        Self {
            offset_ms: 0.0,
            confidence: c.ncc as f64,
            overlap_frames: c.overlap_frames,
        }
    }
}

fn cand_to_out(c: &MatchCandidate, sr: u32) -> MatchCandidateOut {
    MatchCandidateOut {
        offset_ms: c.offset_samples as f64 / sr as f64 * 1000.0,
        confidence: c.ncc as f64,
        overlap_frames: c.overlap_frames,
    }
}

/// Cosine confidence between two L2-normalized chroma matrices at a given lag.
fn chroma_confidence_at_offset(cr: &ChromaMatrix, cq: &ChromaMatrix, offset_samples: i64) -> f64 {
    if cr.n_frames == 0 || cq.n_frames == 0 {
        return 0.0;
    }
    let lag_frames = -((offset_samples as f64) / HOP as f64).round() as i64;
    let start_i = (-lag_frames).max(0) as usize;
    let end_i = (cr.n_frames as i64).min(cq.n_frames as i64 - lag_frames) as i64;
    if end_i <= start_i as i64 {
        return 0.0;
    }
    let end_i = end_i as usize;
    let mut sum = 0.0f64;
    let n = end_i - start_i;
    for i in start_i..end_i {
        let qi = (i as i64 + lag_frames) as usize;
        let mut dot = 0.0f32;
        for c in 0..N_PITCH_CLASSES {
            dot += cr.row(c)[i] * cq.row(c)[qi];
        }
        sum += dot as f64;
    }
    let mean = sum / n as f64;
    mean.clamp(0.0, 1.0)
}

fn chroma_alignment(cr: &ChromaMatrix, cq: &ChromaMatrix) -> (i64, f64) {
    if cr.n_frames == 0 || cq.n_frames == 0 {
        return (0, 0.0);
    }
    let n_full = cr.n_frames + cq.n_frames - 1;
    let mut accum = vec![0.0f32; n_full];
    for d in 0..N_PITCH_CLASSES {
        // correlate(cq[d], cr[d], mode="full") — note query first, ref second
        let c = correlate_full(cq.row(d), cr.row(d));
        for (i, v) in c.iter().enumerate() {
            accum[i] += v;
        }
    }
    let mut peak_idx = 0usize;
    let mut peak_val = f32::NEG_INFINITY;
    for (i, &v) in accum.iter().enumerate() {
        if v > peak_val {
            peak_val = v;
            peak_idx = i;
        }
    }
    let lag_frames = peak_idx as i64 - (cr.n_frames as i64 - 1);
    let offset_samples = -lag_frames * HOP as i64;
    let confidence = chroma_confidence_at_offset(cr, cq, offset_samples);
    (offset_samples, confidence)
}

#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    pub sr: u32,
    pub confidence_threshold: f64,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            sr: 22050,
            confidence_threshold: 0.4,
        }
    }
}

/// Progress-callback signature: `(stage_name, fraction_0_to_1)`. The
/// fraction is monotonically non-decreasing across calls within a
/// single `sync_audio_pcm_with_progress` invocation. Stage names are
/// stable: `"normalize"`, `"envelope"`, `"chroma"`, `"onset"`,
/// `"ncc"`, `"phat"`, `"consensus"`, `"drift"`, `"done"`.
pub type ProgressFn<'a> = &'a dyn Fn(&str, f64);

/// Backwards-compatible entrypoint: same as
/// `sync_audio_pcm_with_progress` but with no progress reporting.
pub fn sync_audio_pcm(ref_pcm: &[f32], query_pcm: &[f32], opts: SyncOptions) -> SyncResult {
    sync_audio_pcm_with_progress(ref_pcm, query_pcm, opts, &|_, _| {})
}

/// Like `sync_audio_pcm` but invokes `progress(stage, frac)` between
/// each pipeline stage so the caller can render a smooth bar instead
/// of a 1.5-s "frozen at 40 %" gap. The callback is invoked from the
/// SAME thread sync is running on (i.e. the worker thread in the WASM
/// build) — it should be a cheap closure that just enqueues a message
/// to the UI thread.
pub fn sync_audio_pcm_with_progress(
    ref_pcm: &[f32],
    query_pcm: &[f32],
    opts: SyncOptions,
    progress: ProgressFn,
) -> SyncResult {
    if ref_pcm.is_empty() || query_pcm.is_empty() {
        return SyncResult {
            offset_ms: 0.0,
            confidence: 0.0,
            drift_ratio: 1.0,
            method: "chroma".to_string(),
            warning: Some("Empty audio".to_string()),
            candidates: Vec::new(),
            peak_to_second_ratio: f64::INFINITY,
            peak_to_noise: f64::INFINITY,
            phat_pnr: 0.0,
        };
    }

    progress("normalize", 0.0);
    let mut ref_y = ref_pcm.to_vec();
    let mut query_y = query_pcm.to_vec();
    peak_normalize(&mut ref_y);
    peak_normalize(&mut query_y);

    // Tier 0: RMS-envelope cross-correlation. Cheap, robust against
    // mic EQ / room verb / codec artefacts, and excels exactly where
    // chroma+onset gets confused — long-form same-source material with
    // strong rhythmic self-similarity but a unique loudness shape.
    // When it returns a confident pick (peak_to_second ≥ threshold) we
    // use its offset both as a sanity-check on later stages and as the
    // coarse seed for the salient-anchor PHAT consensus's narrow
    // search corridor.
    progress("envelope", 0.05);
    let envelope_result: Option<EnvelopeResult> =
        envelope_align(&ref_y, &query_y, opts.sr, EnvelopeConfig::default());

    progress("chroma", 0.15);
    let cr = chroma::chroma_features(&ref_y, opts.sr);
    let cq = chroma::chroma_features(&query_y, opts.sr);

    // Primary alignment uses NCC + onset-envelope fusion + multi-candidate
    // peak picking. The onset envelope is folded into the NCC array
    // BEFORE peak picking so it can promote a true-but-quiet chroma peak
    // over a wrong-but-loud one (self-similar bar boundaries in
    // repetitive music are the classic failure case).
    progress("onset", 0.25);
    let onset_ref = onset_envelope(&ref_y, opts.sr);
    let onset_query = onset_envelope(&query_y, opts.sr);
    progress("ncc", 0.35);
    let report = align_with_onset(
        &cr,
        &cq,
        &onset_ref,
        &onset_query,
        opts.sr,
        /*max_alternates=*/ 10,
    );

    let (mut lag, mut confidence, mut candidates, peak_to_second, peak_to_noise) =
        match report {
            Some(r) => {
                // Primary stays whatever chroma+onset picked. Sample-level
                // Pearson re-ranking was tried and made primaries WORSE on
                // real music (raw audio inner product is too sensitive to
                // amplitude/noise differences) — but the same scoring is a
                // useful confidence reading on each surfaced candidate, so
                // the UI's snap-to-alternate-match list can rank them.
                let mut cands: Vec<MatchCandidateOut> = std::iter::once(&r.primary)
                    .chain(r.alternates.iter())
                    .map(|c| {
                        let mut out = cand_to_out(c, opts.sr);
                        let sample =
                            sample_level_pearson(&ref_y, &query_y, c.offset_samples);
                        // Surface the higher of chroma-NCC and sample-NCC so
                        // alts that look strong at the audio level are visibly
                        // ranked higher in the snap UI.
                        out.confidence = (sample as f64).max(c.ncc as f64);
                        out
                    })
                    .collect();
                let primary_lag = r.primary.offset_samples;
                let primary_conf = r.primary.ncc as f64;
                if let Some(p) = cands.get_mut(0) {
                    p.confidence = primary_conf;
                }
                (
                    primary_lag,
                    primary_conf,
                    cands,
                    r.discrimination.peak_to_second_ratio as f64,
                    r.discrimination.peak_to_noise as f64,
                )
            }
            None => (0, 0.0, Vec::new(), f64::INFINITY, f64::INFINITY),
        };
    let mut method = "ncc+onset".to_string();
    let mut drift = 1.0f64;
    let mut warning: Option<String> = None;

    // Mark in the method string when envelope's pick disagreed with
    // chroma's by more than an envelope sample (~100ms). Useful debug
    // signal in the UI without overriding anything yet — Tier 3
    // (consensus) decides the actual override.
    if let Some(env) = envelope_result.as_ref() {
        let env_ms = env.offset_samples as f64 / opts.sr as f64 * 1000.0;
        let chroma_ms = lag as f64 / opts.sr as f64 * 1000.0;
        if (env_ms - chroma_ms).abs() < 200.0 {
            method = "envelope+ncc+onset".to_string();
        } else {
            method = "ncc+onset(envelope-conflict)".to_string();
        }
    }

    if confidence < opts.confidence_threshold {
        method = "ncc+onset+dtw".to_string();
        let cr_dtw = compute_chroma_with_hop(&ref_y, opts.sr, 1024);
        let cq_dtw = compute_chroma_with_hop(&query_y, opts.sr, 1024);
        let (offset_dtw, drift_dtw) = dtw_drift(&cr_dtw, &cq_dtw, 1024);
        let lag_dtw = offset_dtw.round() as i64;
        let conf_dtw = chroma_confidence_at_offset(&cr, &cq, lag_dtw);
        if conf_dtw > confidence {
            lag = lag_dtw;
            confidence = conf_dtw;
            drift = drift_dtw;
        }
    }

    // Tier 2: GCC-PHAT sample-level refinement. Whitening makes the
    // cross-spectrum carry phase only, so the IFFT peaks like a delta
    // function at the true sample lag for same-source pairs — orders
    // of magnitude sharper than chroma+onset and the only stage
    // capable of telling beat-aligned impostors apart on repetitive
    // material (techno / house / hip-hop loops where every kick lines
    // up at every alternate).
    //
    // Multi-seed: chroma+onset's argmax can land on an onset-boosted
    // beat-shifted lag while the *true* lag sits one row down in the
    // alternates list with a slightly higher chroma-only NCC. We run
    // PHAT against the primary AND the top-K alternates and keep the
    // result with the highest PNR — PHAT's PNR contrast between right
    // and wrong seed is so extreme (real-music bench: 2.3e8 vs 50
    // for the house-loop +100 ms case) that this is unambiguous.
    progress("phat", 0.55);
    let mut phat_pnr = 0.0_f64;
    if confidence >= opts.confidence_threshold {
        let primary_phat = phat_refine(&ref_y, &query_y, opts.sr, lag);
        // When the primary's PHAT peak is unambiguous (PNR ≥ 100), the
        // chroma seed was right and there's nothing to gain from
        // probing alternates — trying them on perfectly periodic
        // material (e.g. a 2.5 s-period synthetic test fixture) just
        // introduces ties between equally-phase-coherent shifts. We
        // only multi-seed when the primary's phase coherence looks
        // shaky, which is exactly where chroma+onset's onset-boost may
        // have walked the picker off the true lag (real-music bench:
        // house-loop pos-100ms — primary PNR ≈ 50, alt[0] PNR ≈ 2e8).
        const PHAT_TRUST_PNR: f32 = 100.0;
        // Margin an alternate's PHAT PNR must beat the primary's by to
        // override it. The legitimate "alt is the truth" cases we want
        // to catch (real-music bench house-loop: alt PNR ≈ 2e8 vs
        // primary ≈ 50, ratio 4 M : 1) clear this trivially. The
        // failure mode it guards against is mic-noisy long-form
        // material where every PHAT seed lands near PNR ≈ 10 and a
        // marginal-numerically-larger alt walks the lag off a correct
        // chroma primary onto a self-similar bar shift (15-min beat-
        // making session: primary PNR 10.0, alt PNR 10.78, ratio 1.08
        // — algorithm walks 1.1 s off the true offset).
        const PHAT_ALT_DOMINANCE: f32 = 1.5;
        let primary_strong = primary_phat
            .as_ref()
            .map(|r| r.pnr >= PHAT_TRUST_PNR)
            .unwrap_or(false);

        let best = if primary_strong {
            primary_phat
        } else {
            let mut best = primary_phat;
            // candidates[0] mirrors the primary; skip(1) picks up
            // genuine alternates. 4 alternates is enough to break the
            // beat-shifted-impostor pattern without burning an FFT on
            // tail entries we'll never trust.
            for c in candidates.iter().skip(1).take(4) {
                let cand_lag = (c.offset_ms / 1000.0 * opts.sr as f64).round() as i64;
                // Skip near-duplicates of seeds we've already tried.
                let too_close = best
                    .as_ref()
                    .map(|p| (p.offset_samples - cand_lag).abs() <= opts.sr as i64 / 10)
                    .unwrap_or(false)
                    || (cand_lag - lag).abs() <= opts.sr as i64 / 10;
                if too_close {
                    continue;
                }
                if let Some(r) = phat_refine(&ref_y, &query_y, opts.sr, cand_lag) {
                    best = match best {
                        None => Some(r),
                        Some(prev) if r.pnr > prev.pnr * PHAT_ALT_DOMINANCE => Some(r),
                        Some(prev) => Some(prev),
                    };
                }
            }
            best
        };
        if let Some(r) = best {
            lag = r.offset_samples;
            phat_pnr = r.pnr as f64;
            method.push_str("+phat");
        }
    }

    // Tier 3: Salient-anchor PHAT consensus.
    //
    // Picks the K most spectrally-unique 8-second windows in the
    // CLEANER of the two tracks (= higher peak-to-RMS ratio = direct
    // take rather than mic-recording), runs sample-level GCC-PHAT for
    // each, and bucket-votes the resulting offsets. By construction:
    //   - salient anchors sit on events that don't repeat elsewhere
    //     in the track, so they CAN'T fall on a bar-shifted impostor;
    //   - the cleaner track is used as the reference because anything
    //     present there is guaranteed (modulo verb / EQ / codec) to
    //     also be present in the dirtier track, while the reverse
    //     doesn't hold (mic captures speech / clicks / room noise that
    //     don't exist in the direct take);
    //   - the search corridor for each anchor is narrowed by the
    //     coarse offset that envelope+chroma already produced, so we
    //     spend our compute budget on the narrow region where the
    //     answer actually lives.
    //
    // Triggering: only run if the prior stages look uncertain (low
    // peak-to-second-ratio and low PHAT PNR). When they look confident
    // we save the compute.
    const CONSENSUS_PSR_TRIGGER: f64 = 1.5;
    const CONSENSUS_PNR_TRIGGER: f64 = 30.0;
    const CONSENSUS_OVERRIDE_DELTA_MS: f64 = 25.0;
    // Minimum sum-of-PNRs across the winning bucket before the
    // consensus is allowed to OVERRIDE the chroma+PHAT pick. Pure
    // unrelated-noise inputs can still produce a "winning bucket" by
    // chance with combined_pnr < 200; real same-source matches hit
    // 1 k+ easily. This threshold separates the two regimes.
    const CONSENSUS_OVERRIDE_MIN_PNR: f32 = 200.0;
    let consensus_needed = peak_to_second < CONSENSUS_PSR_TRIGGER && phat_pnr < CONSENSUS_PNR_TRIGGER;
    if consensus_needed {
        progress("consensus", 0.70);
        // Pick anchors on the cleaner of the two tracks. If ref is
        // cleaner, the chroma we already computed has the salience
        // signal we need; otherwise we re-run on query.
        let ref_clean = ref_is_cleaner(&ref_y, &query_y);
        let (anchor_track, target_track, anchor_chroma) = if ref_clean {
            (&ref_y, &query_y, &cr)
        } else {
            (&query_y, &ref_y, &cq)
        };
        let nov = novelty_curve(anchor_chroma, opts.sr, 5.0);
        let anchors = pick_anchors(&nov, opts.sr, SalienceConfig::default());

        // Coarse seed for the narrow PHAT corridor: prefer envelope's
        // pick (most robust against drum-heavy material) over the
        // chroma lag, but fall back to chroma if envelope didn't fire.
        // The seed is in algorithm convention (positive = query lags
        // ref). When the cleaner track is `query` instead of `ref`,
        // we invert the sign because salient_phat_consensus's first
        // arg is treated as "ref" internally.
        let coarse_seed_global = envelope_result
            .as_ref()
            .map(|e| e.offset_samples)
            .unwrap_or(lag);
        let coarse_seed_for_consensus = if ref_clean {
            coarse_seed_global
        } else {
            -coarse_seed_global
        };

        // Tighter corridor than the global ±30 s default — coarse
        // seed is already accurate to ~100 ms.
        let mut salient_cfg = ChunkedConfig::default();
        salient_cfg.search_radius_seconds = 2.0;
        salient_cfg.n_chunks = anchors.len(); // unused but consistent

        let consensus = if !anchors.is_empty() {
            salient_phat_consensus(
                anchor_track,
                target_track,
                opts.sr,
                &anchors,
                coarse_seed_for_consensus,
                salient_cfg,
            )
        } else {
            None
        };

        // Fallback to uniform chunked when salience didn't yield
        // useful anchors (very homogeneous material, very short
        // clips). Uniform chunked uses a wider search corridor since
        // it doesn't have the seed structure baked in.
        let consensus = consensus.or_else(|| {
            chunked_phat_consensus(&ref_y, &query_y, opts.sr, ChunkedConfig::default())
        });

        if let Some(c) = consensus {
            // If we ran on the cleaner track being `query`, the
            // returned offset is in the swapped convention — flip it
            // back to the algorithm's standard "+ = query lags ref".
            let consensus_offset_samples = if ref_clean {
                c.offset_samples
            } else {
                -c.offset_samples
            };
            let consensus_off_ms = consensus_offset_samples as f64 / opts.sr as f64 * 1000.0;
            let current_off_ms = lag as f64 / opts.sr as f64 * 1000.0;
            let delta_ms = (consensus_off_ms - current_off_ms).abs();
            let consensus_strong = c.combined_pnr >= CONSENSUS_OVERRIDE_MIN_PNR;
            if delta_ms > CONSENSUS_OVERRIDE_DELTA_MS && consensus_strong {
                lag = consensus_offset_samples;
                if let Some(p) = candidates.get_mut(0) {
                    p.offset_ms = consensus_off_ms;
                }
                method.push_str("+consensus");
                phat_pnr = c.combined_pnr as f64;
            } else if delta_ms <= CONSENSUS_OVERRIDE_DELTA_MS && consensus_strong {
                method.push_str("+consensus(confirm)");
            }
        }
    }

    // Drift refinement. Two roles:
    //   - estimate `drift_ratio` (slope of the windowed linear fit) —
    //     this is the only thing PHAT can't tell us, so we always
    //     consume it when drift refinement runs;
    //   - estimate the absolute offset — useful when PHAT was skipped
    //     or rejected, but actively HARMFUL when PHAT already locked
    //     onto a sample-precise lag. On real hip-hop / jazz material
    //     drift's per-window xcorr can lock onto a bar-aligned beat
    //     ~234 ms off and walk the lag away from PHAT's correct
    //     answer (real-music bench: pos-2000ms regression). So the
    //     offset side of drift's output is only honored when PHAT
    //     didn't produce a trustworthy result.
    progress("drift", 0.92);
    if confidence >= opts.confidence_threshold {
        if let Some(refined) =
            windowed_drift_refinement(&ref_y, &query_y, opts.sr, lag, DriftConfig::default())
        {
            let phat_locked = phat_pnr > 0.0;
            // Sanity floor on offset-replacement: must agree with seed
            // within 1 s. When PHAT succeeded the bar is much tighter
            // (50 ms) — we're refining a sample-level number, not
            // searching for it.
            let offset_tolerance = if phat_locked {
                (0.05 * opts.sr as f32) as i64
            } else {
                opts.sr as i64
            };
            let diff = (refined.offset_samples - lag).abs();
            if diff <= offset_tolerance {
                lag = refined.offset_samples;
            }
            // Always trust drift_ratio: even when we keep PHAT's lag,
            // the slope of drift's linear fit captures audio-clock
            // mismatch that PHAT alone can't see.
            drift = refined.drift_ratio;
            method.push_str("+drift");
            if let Some(p) = candidates.get_mut(0) {
                p.offset_ms = lag as f64 / opts.sr as f64 * 1000.0;
            }
        }
    }

    if (drift - 1.0).abs() > 0.001 {
        let msg = format!("Audio drift detected: {:.4}%", (drift - 1.0) * 100.0);
        warning = Some(match warning {
            Some(prev) => format!("{}; {}", prev, msg),
            None => msg,
        });
    }

    if confidence < 0.3 {
        let msg = "Low sync confidence — preview before sharing".to_string();
        warning = Some(match warning {
            Some(prev) => format!("{}; {}", prev, msg),
            None => msg,
        });
    }

    progress("done", 1.0);
    let offset_ms = (lag as f64 / opts.sr as f64) * 1000.0;
    SyncResult {
        offset_ms,
        confidence,
        drift_ratio: drift,
        method,
        warning,
        candidates,
        peak_to_second_ratio: peak_to_second,
        peak_to_noise,
        phat_pnr,
    }
}

/// Pearson-style normalized correlation of two PCM signals at a specific
/// integer-sample lag. Returns a value in [-1, 1]; ≥ 0 means the signals
/// are positively correlated over the overlap region.
///
/// Used as the disambiguator after chroma+onset peak picking. Chroma
/// rewards beat-grid-aligned positions equally for repetitive music;
/// sample-level inner product is much more sensitive to where transients
/// actually fall (a one-beat shift drops correlation toward zero).
///
/// Implementation: O(N) loop. Skips the work entirely if the overlap
/// would be tiny (< 0.5 s).
fn sample_level_pearson(ref_y: &[f32], query_y: &[f32], lag_samples: i64) -> f32 {
    let n_r = ref_y.len() as i64;
    let n_q = query_y.len() as i64;
    let start = (-lag_samples).max(0);
    let end = n_r.min(n_q - lag_samples);
    if end <= start {
        return 0.0;
    }
    let n = (end - start) as usize;
    if n < 11_025 {
        return 0.0;
    } // < 0.5 s @ 22050 Hz
    let mut dot = 0.0_f64;
    let mut sum_r2 = 0.0_f64;
    let mut sum_q2 = 0.0_f64;
    for i in start..end {
        let r = ref_y[i as usize] as f64;
        let q = query_y[(i + lag_samples) as usize] as f64;
        dot += r * q;
        sum_r2 += r * r;
        sum_q2 += q * q;
    }
    let denom = (sum_r2 * sum_q2).sqrt();
    if denom < 1e-12 {
        0.0
    } else {
        (dot / denom).clamp(-1.0, 1.0) as f32
    }
}

/// Like `chroma_features` but with configurable hop. Used for the DTW path.
/// Re-implements the inner loop; shares the constants/window logic.
fn compute_chroma_with_hop(y: &[f32], sr: u32, hop: usize) -> ChromaMatrix {
    use realfft::RealFftPlanner;

    const N_FFT: usize = 2048;
    if y.len() < N_FFT {
        return ChromaMatrix {
            data: Vec::new(),
            n_frames: 0,
        };
    }
    let n_frames = (y.len() - N_FFT) / hop + 1;

    let mut window = vec![0.0f32; N_FFT];
    for i in 0..N_FFT {
        let arg = std::f32::consts::PI * (i as f32) / ((N_FFT - 1) as f32);
        window[i] = arg.sin().powi(2);
    }
    let n_bins = N_FFT / 2 + 1;
    let mut bin_to_class: Vec<i32> = vec![-1; n_bins];
    let bin_hz = sr as f32 / N_FFT as f32;
    let a4 = 440.0_f32;
    for k in 1..n_bins {
        let f = (k as f32) * bin_hz;
        if !(30.0..=8000.0).contains(&f) {
            continue;
        }
        let semis = 12.0 * (f / a4).log2();
        let note = (semis.round() as i32) + 69;
        bin_to_class[k] = ((note % 12) + 12) % 12;
    }
    let mut planner: RealFftPlanner<f32> = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(N_FFT);
    let mut input = r2c.make_input_vec();
    let mut output = r2c.make_output_vec();

    let mut data = vec![0.0f32; N_PITCH_CLASSES * n_frames];
    for frame in 0..n_frames {
        let start = frame * hop;
        let end = start + N_FFT;
        if end > y.len() {
            break;
        }
        for i in 0..N_FFT {
            input[i] = y[start + i] * window[i];
        }
        r2c.process(&mut input, &mut output).expect("fft");
        let mut bins = [0.0f32; N_PITCH_CLASSES];
        for k in 1..n_bins {
            let class = bin_to_class[k];
            if class < 0 {
                continue;
            }
            let re = output[k].re;
            let im = output[k].im;
            bins[class as usize] += (re * re + im * im).sqrt();
        }
        let mut norm = 0.0f32;
        for &b in bins.iter() {
            norm += b * b;
        }
        norm = norm.sqrt();
        if norm > 1e-9 {
            for c in 0..N_PITCH_CLASSES {
                data[c * n_frames + frame] = bins[c] / norm;
            }
        }
    }
    ChromaMatrix { data, n_frames }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn make_tone_segment(freq: f32, secs: f32, sr: u32) -> Vec<f32> {
        let n = (secs * sr as f32) as usize;
        let mut y = vec![0.0f32; n];
        for i in 0..n {
            y[i] = 0.5 * (2.0 * PI * freq * (i as f32) / sr as f32).sin();
        }
        y
    }

    fn make_song(secs: f32, sr: u32) -> Vec<f32> {
        // 5 different tones, each 0.5 s.
        let scale = [220.0, 261.6, 329.6, 391.99, 466.16];
        let mut y: Vec<f32> = Vec::new();
        let mut i = 0;
        while (y.len() as f32) < secs * sr as f32 {
            let f = scale[i % scale.len()];
            y.extend(make_tone_segment(f, 0.5, sr));
            i += 1;
        }
        y.truncate((secs * sr as f32) as usize);
        y
    }

    #[test]
    fn identical_inputs_yield_offset_zero_high_confidence() {
        let sr = 22050;
        let song = make_song(8.0, sr);
        let r = sync_audio_pcm(&song, &song, SyncOptions::default());
        assert!(r.offset_ms.abs() < 50.0, "offset_ms = {}", r.offset_ms);
        assert!(r.confidence > 0.85, "confidence = {}", r.confidence);
    }

    #[test]
    fn detects_known_positive_offset() {
        let sr = 22050u32;
        let song = make_song(8.0, sr);
        // ref = silence(400ms) + song; query = song. Offset should be +400ms.
        let pad = (0.4 * sr as f32) as usize;
        let mut reference = vec![0.0f32; pad];
        reference.extend_from_slice(&song);
        let r = sync_audio_pcm(&reference, &song, SyncOptions::default());
        assert!(
            (r.offset_ms - 400.0).abs() < 60.0,
            "offset_ms = {} (expected ~400)",
            r.offset_ms
        );
    }
}
