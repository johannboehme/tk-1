//! Diagnostic harness for one specific match failure case.
//!
//! Reads two raw f32-LE PCM files (mono, sample_rate Hz) and dumps every
//! intermediate signal we have on the matcher: full-pipeline result, top-K
//! NCC candidates, chroma confidence at a "known truth" offset, PHAT
//! refinement at that truth, and the onset envelope's contribution.
//!
//! Used to figure out *why* the matcher picked the wrong lag on a real
//! noisy-mic vs clean-master beatmaking session, before deciding what to
//! change in the algorithm.
//!
//! Run:  cargo run --release --example diagnose_match -- \
//!       /tmp/sync_diag/ref.f32 /tmp/sync_diag/query.f32 -1170

use std::env;
use std::fs;
use std::io::Read;
use std::path::Path;

use sync_core::chroma::{self, ChromaMatrix, HOP, N_PITCH_CLASSES};
use sync_core::ncc::{align_with_onset, score_lag_1d};
use sync_core::onset::onset_envelope;
use sync_core::phat::{gcc_phat, phat_refine, PHAT_BETA_DEFAULT};
use sync_core::sync::{sync_audio_pcm, SyncOptions};
use sync_core::util::peak_normalize;
use sync_core::xcorr::correlate_full;

const SR: u32 = 22050;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "usage: {} <ref.f32> <query.f32> [known_truth_ms]",
            args[0]
        );
        std::process::exit(1);
    }
    let ref_path = &args[1];
    let query_path = &args[2];
    let truth_ms: Option<f64> = args.get(3).and_then(|s| s.parse().ok());

    let ref_pcm = read_f32le(Path::new(ref_path)).expect("read ref");
    let query_pcm = read_f32le(Path::new(query_path)).expect("read query");

    println!("=== sync-core diagnostic run ===");
    println!(
        "ref    : {} samples = {:.3} s   ({})",
        ref_pcm.len(),
        ref_pcm.len() as f64 / SR as f64,
        ref_path
    );
    println!(
        "query  : {} samples = {:.3} s   ({})",
        query_pcm.len(),
        query_pcm.len() as f64 / SR as f64,
        query_path
    );
    if let Some(t) = truth_ms {
        println!("truth  : {:+.3} ms (user-reported manual nudge)", t);
    }
    println!();

    // ---- Stage 1: full pipeline -------------------------------------------------
    println!("[1] Full pipeline (sync_audio_pcm)");
    let result = sync_audio_pcm(&ref_pcm, &query_pcm, SyncOptions::default());
    println!("  method        : {}", result.method);
    println!("  offset_ms     : {:+.3}", result.offset_ms);
    println!("  confidence    : {:.4}", result.confidence);
    println!("  drift_ratio   : {:.6}", result.drift_ratio);
    println!(
        "  peak_to_2nd   : {}",
        fmt_ratio(result.peak_to_second_ratio)
    );
    println!(
        "  peak_to_noise : {}",
        fmt_ratio(result.peak_to_noise)
    );
    println!("  phat_pnr      : {}", fmt_ratio(result.phat_pnr));
    if let Some(w) = &result.warning {
        println!("  warning       : {}", w);
    }
    if let Some(t) = truth_ms {
        let err = result.offset_ms - t;
        println!("  err_vs_truth  : {:+.3} ms", err);
    }
    println!();

    println!(
        "  candidates ({} returned, primary first):",
        result.candidates.len()
    );
    println!(
        "    {:>3}  {:>11}  {:>7}  {:>10}  {:>11}",
        "rk", "offset_ms", "score", "overlap_fr", "Δtruth_ms"
    );
    for (i, c) in result.candidates.iter().enumerate() {
        let dt = truth_ms.map(|t| c.offset_ms - t);
        println!(
            "    {:>3}  {:>+11.2}  {:>7.4}  {:>10}  {:>+11}",
            i,
            c.offset_ms,
            c.confidence,
            c.overlap_frames,
            dt.map(|d| format!("{:+.2}", d))
                .unwrap_or_else(|| "-".into())
        );
    }
    println!();

    // ---- Stage 2: deeper candidate dump (raw align_with_onset, K=200) -----------
    println!("[2] Deep candidate dump — align_with_onset(max_alternates=200)");
    let mut ref_y = ref_pcm.clone();
    let mut query_y = query_pcm.clone();
    peak_normalize(&mut ref_y);
    peak_normalize(&mut query_y);

    let cr = chroma::chroma_features(&ref_y, SR);
    let cq = chroma::chroma_features(&query_y, SR);
    println!(
        "  chroma frames: ref={}  query={}  hop_seconds={:.4}",
        cr.n_frames,
        cq.n_frames,
        HOP as f64 / SR as f64
    );

    let onset_r = onset_envelope(&ref_y, SR);
    let onset_q = onset_envelope(&query_y, SR);
    println!(
        "  onset frames: ref={}  query={}",
        onset_r.len(),
        onset_q.len()
    );
    let onset_r_energy: f32 = onset_r.iter().map(|x| x * x).sum::<f32>().sqrt();
    let onset_q_energy: f32 = onset_q.iter().map(|x| x * x).sum::<f32>().sqrt();
    println!(
        "  onset L2 energy: ref={:.3}  query={:.3}",
        onset_r_energy, onset_q_energy
    );
    println!();

    let report = align_with_onset(&cr, &cq, &onset_r, &onset_q, SR, 200);
    if let Some(report) = report {
        println!("  primary  offset={:+.3} ms  ncc={:.4}", offset_to_ms(report.primary.offset_samples), report.primary.ncc);
        println!(
            "  PSR={}  PNR(median)={}",
            fmt_ratio(report.discrimination.peak_to_second_ratio as f64),
            fmt_ratio(report.discrimination.peak_to_noise as f64)
        );
        println!();

        let mut combined: Vec<_> = std::iter::once(&report.primary)
            .chain(report.alternates.iter())
            .collect();
        combined.sort_by(|a, b| {
            b.ncc
                .partial_cmp(&a.ncc)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        println!("  Top {} candidates by chroma NCC:", combined.len());
        println!(
            "    {:>3}  {:>11}  {:>7}  {:>10}  {:>11}",
            "rk", "offset_ms", "ncc", "overlap_fr", "Δtruth_ms"
        );
        for (i, c) in combined.iter().enumerate().take(30) {
            let off_ms = offset_to_ms(c.offset_samples);
            let dt = truth_ms.map(|t| off_ms - t);
            println!(
                "    {:>3}  {:>+11.2}  {:>7.4}  {:>10}  {:>11}",
                i,
                off_ms,
                c.ncc,
                c.overlap_frames,
                dt.map(|d| format!("{:+.2}", d))
                    .unwrap_or_else(|| "-".into())
            );
        }
        println!();

        // If a known truth is given, find the closest candidate to it.
        if let Some(t) = truth_ms {
            let target_samples = (t / 1000.0 * SR as f64).round() as i64;
            let nearest = combined.iter().enumerate().min_by_key(|(_, c)| {
                (c.offset_samples - target_samples).abs() as u64
            });
            if let Some((rank, c)) = nearest {
                println!(
                    "  Nearest candidate to truth ({:+.0} ms): rank #{} at {:+.2} ms (Δ={:+.2} ms), ncc={:.4}",
                    t,
                    rank,
                    offset_to_ms(c.offset_samples),
                    offset_to_ms(c.offset_samples) - t,
                    c.ncc
                );
            } else {
                println!(
                    "  No candidate within the dump range was returned for truth {:+.0} ms",
                    t
                );
            }
            println!();
        }
    } else {
        println!("  align_with_onset returned None");
        println!();
    }

    // ---- Stage 3: chroma cosine + onset Pearson at truth -----------------------
    if let Some(t) = truth_ms {
        let truth_samples = (t / 1000.0 * SR as f64).round() as i64;
        println!("[3] Direct probes at truth offset ({:+.0} ms = {} samples)", t, truth_samples);

        // Chroma cosine over the overlap.
        let chroma_cos = chroma_cosine_at_offset(&cr, &cq, truth_samples);
        println!("  chroma cosine over overlap        : {:.4}", chroma_cos);

        // Onset Pearson.
        let onset_pear = score_lag_1d(&onset_q, &onset_r, truth_samples, SR, HOP, 1.0);
        println!("  onset envelope Pearson at truth   : {:.4}", onset_pear);

        // Same probes at the matcher's primary pick.
        let primary_samples = (result.offset_ms / 1000.0 * SR as f64).round() as i64;
        let chroma_cos_primary = chroma_cosine_at_offset(&cr, &cq, primary_samples);
        let onset_pear_primary = score_lag_1d(&onset_q, &onset_r, primary_samples, SR, HOP, 1.0);
        println!(
            "  chroma cosine at PRIMARY ({:+.0} ms): {:.4}",
            result.offset_ms, chroma_cos_primary
        );
        println!(
            "  onset Pearson at PRIMARY              : {:.4}",
            onset_pear_primary
        );
        println!();

        // ---- Stage 4: PHAT manual probe at truth -------------------------------
        println!("[4] PHAT refinement at truth offset");
        match phat_refine(&ref_y, &query_y, SR, truth_samples) {
            Some(r) => println!(
                "  PHAT at truth seed: refined={:+.3} ms  pnr={:.2}  Δseed={:+} samples",
                offset_to_ms(r.offset_samples),
                r.pnr,
                r.offset_samples - truth_samples
            ),
            None => println!("  PHAT REJECTED at truth seed (PNR < 6 or window doesn't fit)"),
        }
        // Also run PHAT at primary for comparison.
        match phat_refine(&ref_y, &query_y, SR, primary_samples) {
            Some(r) => println!(
                "  PHAT at PRIMARY seed: refined={:+.3} ms  pnr={:.2}",
                offset_to_ms(r.offset_samples),
                r.pnr
            ),
            None => println!("  PHAT REJECTED at PRIMARY seed"),
        }
        // Probe a bunch of seeds spaced through the truth neighborhood.
        println!("  Sweep PHAT around truth (seed ms, refined, pnr):");
        for delta_ms in [-2000, -1500, -1300, -1170, -1000, -800, -500, 0, 500, 1170] {
            let seed = (delta_ms as f64 / 1000.0 * SR as f64).round() as i64;
            match phat_refine(&ref_y, &query_y, SR, seed) {
                Some(r) => println!(
                    "    seed={:+5} ms  refined={:+9.3} ms  pnr={:>10.2}",
                    delta_ms,
                    offset_to_ms(r.offset_samples),
                    r.pnr
                ),
                None => println!("    seed={:+5} ms  REJECTED", delta_ms),
            }
        }
        println!();

        // ---- Stage 5: NCC profile near truth ----------------------------------
        println!("[5] Chroma NCC profile around truth (raw, normalized by sqrt(overlap))");
        let cr_mask = active_mask(&cr);
        let cq_mask = active_mask(&cq);
        let raw = raw_chroma_correlation(&cr, &cq);
        let overlaps = correlate_full(&cq_mask, &cr_mask);
        let mut sorted_local: Vec<(i64, f32, f32, f32)> = Vec::new();
        let truth_idx = (cr.n_frames as i64 - 1) - (-truth_samples / HOP as i64);
        let radius_frames = (5.0 * SR as f32 / HOP as f32) as i64; // ±5 s
        let lo = (truth_idx - radius_frames).max(0) as usize;
        let hi = ((truth_idx + radius_frames) as usize).min(raw.len() - 1);
        for idx in lo..=hi {
            let lag_frames = idx as i64 - (cr.n_frames as i64 - 1);
            let off_samples = -lag_frames * HOP as i64;
            let off_ms = off_samples as f64 / SR as f64 * 1000.0;
            let ov = overlaps[idx].max(0.0);
            let ncc = if ov > 0.0 { raw[idx] / ov.sqrt() } else { 0.0 };
            sorted_local.push((off_samples, ncc, ov, raw[idx]));
            // Print every ~50 ms.
            let ms_per_frame = HOP as f64 / SR as f64 * 1000.0;
            if (off_ms - t).abs() < 100.0 || ((idx - lo) % 4 == 0) {
                if (off_ms - t).abs() < 100.0 {
                    println!(
                        "    [near truth]  off={:+9.3} ms  ncc={:.4}  ov={:>6.0}  raw={:.2}",
                        off_ms, ncc, ov, raw[idx]
                    );
                } else if ms_per_frame * (radius_frames as f64) > 0.0 {
                    // print sparsely for context
                    println!(
                        "    [        ]    off={:+9.3} ms  ncc={:.4}  ov={:>6.0}",
                        off_ms, ncc, ov
                    );
                }
            }
        }
        println!();

        // Where is the local max around truth?
        if let Some(peak) = sorted_local
            .iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        {
            let off_ms = peak.0 as f64 / SR as f64 * 1000.0;
            println!(
                "  Local max in ±5 s window around truth: off={:+.2} ms  ncc={:.4}  Δtruth={:+.2} ms",
                off_ms,
                peak.1,
                off_ms - t
            );
        }
        println!();
    }

    // ---- Stage 5b: onset xcorr profile around truth ----------------------------
    if let Some(t) = truth_ms {
        println!("[5b] Onset cross-correlation profile around truth");
        let onset_corr = correlate_full(&onset_q, &onset_r);
        let onset_l2 = (onset_r.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>()
            * onset_q.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>())
            .sqrt() as f32;
        let n_ref = onset_r.len() as i64;
        let truth_idx = (n_ref - 1) - (-(t / 1000.0 * SR as f64).round() as i64 / HOP as i64);
        let radius = (5.0 * SR as f32 / HOP as f32) as i64;
        let lo = (truth_idx - radius).max(0) as usize;
        let hi = ((truth_idx + radius) as usize).min(onset_corr.len() - 1);
        // Find local max in this window.
        let mut peak_idx = lo;
        let mut peak_val = onset_corr[lo];
        let mut trough = onset_corr[lo];
        for k in lo..=hi {
            if onset_corr[k] > peak_val {
                peak_val = onset_corr[k];
                peak_idx = k;
            }
            if onset_corr[k] < trough {
                trough = onset_corr[k];
            }
        }
        let pi64: i64 = peak_idx as i64;
        let lag_frames = pi64 - (n_ref - 1);
        let off_ms = (-lag_frames * HOP as i64) as f64 / SR as f64 * 1000.0;
        let pearson_at_peak = peak_val / onset_l2.max(1e-9);
        println!(
            "  onset window [{:+.0}, {:+.0}] ms: peak at {:+.2} ms (Δtruth={:+.2}), pearson={:.5}, trough={:.4}",
            (-(radius * HOP as i64) as f64 / SR as f64 * 1000.0),
            ((radius * HOP as i64) as f64 / SR as f64 * 1000.0),
            off_ms,
            off_ms - t,
            pearson_at_peak,
            trough / onset_l2.max(1e-9)
        );

        // also global onset peak
        let mut g_idx = 0usize;
        let mut g_val = onset_corr[0];
        for k in 0..onset_corr.len() {
            if onset_corr[k] > g_val {
                g_val = onset_corr[k];
                g_idx = k;
            }
        }
        let g_lag = g_idx as i64 - (n_ref - 1);
        let g_off_ms = (-g_lag * HOP as i64) as f64 / SR as f64 * 1000.0;
        println!(
            "  GLOBAL onset peak: {:+.2} ms (Δtruth={:+.2}), pearson={:.5}",
            g_off_ms,
            g_off_ms - t,
            g_val / onset_l2.max(1e-9)
        );
        println!();
    }

    // ---- Stage 7: chunked local PHAT (consensus voting) -----------------------
    // For each chunk in master, slide it against a window of query (centered on
    // the chunk's natural position, ± 30 s) using gcc_phat directly. Take the
    // peak's lag, convert to global offset, log it.
    println!("[7] Chunked local PHAT against ±30 s of query (consensus voting)");
    let chunk_seconds = 8.0_f32;
    let search_radius_s = 30.0_f32;
    let n_chunks = 32;
    let chunk_n = (chunk_seconds * SR as f32) as usize;
    let radius_n = (search_radius_s * SR as f32) as i64;
    let ref_len = ref_y.len();
    let query_len_i = query_y.len() as i64;
    if ref_len > chunk_n {
        let mut chunk_lags: Vec<(f64, f32, f64, f32)> = Vec::new(); // (offset_ms, pnr, ref_t_s, energy)
        let usable = ref_len - chunk_n;
        for i in 0..n_chunks {
            let frac = (i as f32 + 0.5) / n_chunks as f32;
            let ref_start = (frac * usable as f32) as usize;
            let chunk = &ref_y[ref_start..ref_start + chunk_n];
            let energy: f32 = (chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32).sqrt();
            if energy < 1e-3 {
                continue;
            }
            // Query window centered on ref_start (chunk's natural position),
            // wide enough to catch any plausible global offset.
            let q_start = (ref_start as i64 - radius_n).max(0);
            let q_end = ((ref_start + chunk_n) as i64 + radius_n).min(query_len_i);
            if q_end - q_start < chunk_n as i64 + (2.0 * SR as f32) as i64 {
                continue;
            }
            let q_slice = &query_y[q_start as usize..q_end as usize];

            // Apply Hann to both for cleaner phase.
            let chunk_h = hann(chunk);
            let q_h = hann(q_slice);
            let phat = gcc_phat(&q_h, &chunk_h, PHAT_BETA_DEFAULT);
            // Lag convention from gcc_phat docstring:
            // result[k = chunk.len() - 1] is lag 0 → "query lines up with chunk"
            // index k − (chunk.len() - 1) = position of chunk's start in query window
            // Find peak.
            let mut peak_idx = 0usize;
            let mut peak_val = f32::NEG_INFINITY;
            for (k, v) in phat.iter().enumerate() {
                if *v > peak_val {
                    peak_val = *v;
                    peak_idx = k;
                }
            }
            // PNR (excluding ±50 around peak)
            let mut sum_sq = 0.0_f64;
            let mut count = 0_usize;
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
            // global_offset: query[t] aligns with ref[t - global_offset].
            // chunk lives at ref[ref_start..ref_start+chunk_n] and at query[chunk_pos_in_q_global..]
            // so query[chunk_pos_in_q_global] = ref[ref_start] → query[t] = ref[t - global_offset]
            // → ref[t - global_offset] at t = chunk_pos_in_q_global is ref[ref_start]
            // → t - global_offset = ref_start
            // → global_offset = chunk_pos_in_q_global - ref_start
            let global_off_samples = chunk_pos_in_q_global - ref_start as i64;
            let off_ms = global_off_samples as f64 / SR as f64 * 1000.0;
            chunk_lags.push((off_ms, pnr, ref_start as f64 / SR as f64, energy));
        }
        chunk_lags.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        println!("  Per-chunk results (sorted by PNR):");
        println!(
            "    {:>6}  {:>11}  {:>8}  {:>11}  {:>7}",
            "ref_t_s", "offset_ms", "pnr", "Δtruth_ms", "energy"
        );
        for (off_ms, pnr, ref_t, energy) in &chunk_lags {
            let dt = truth_ms.map(|t| off_ms - t);
            println!(
                "    {:>6.1}  {:>+11.2}  {:>8.2}  {:>11}  {:>7.4}",
                ref_t,
                off_ms,
                pnr,
                dt.map(|d| format!("{:+.2}", d))
                    .unwrap_or_else(|| "-".into()),
                energy,
            );
        }
        // Histogram of offsets in coarse buckets.
        if !chunk_lags.is_empty() {
            let mut buckets: std::collections::BTreeMap<i64, (usize, f64)> = Default::default();
            for (off_ms, pnr, _, _) in &chunk_lags {
                let bucket = ((*off_ms / 100.0).round()) as i64; // 100-ms buckets
                let entry = buckets.entry(bucket).or_default();
                entry.0 += 1;
                entry.1 += *pnr as f64;
            }
            println!("  Offset histogram (100-ms buckets, only buckets with ≥1 chunk):");
            let mut bvec: Vec<(i64, usize, f64)> = buckets
                .iter()
                .map(|(b, (n, sp))| (*b, *n, *sp))
                .collect();
            bvec.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.partial_cmp(&a.2).unwrap()));
            for (b, n, sp) in bvec.iter().take(15) {
                let center_ms = (*b as f64) * 100.0;
                let dt = truth_ms.map(|t| center_ms - t);
                println!(
                    "    {:>+9.0} ms : {} chunks (sum_pnr={:.1})  Δtruth={}",
                    center_ms,
                    n,
                    sp,
                    dt.map(|d| format!("{:+.0}", d))
                        .unwrap_or_else(|| "-".into())
                );
            }

            // Median over all chunks regardless of PNR.
            let mut all_offs: Vec<f64> = chunk_lags.iter().map(|(o, _, _, _)| *o).collect();
            all_offs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let med = all_offs[all_offs.len() / 2];
            println!("  Median over ALL chunks: {:+.2} ms", med);

            // Median over high-PNR chunks (top 25%).
            let mut sorted_by_pnr: Vec<&(f64, f32, f64, f32)> = chunk_lags.iter().collect();
            sorted_by_pnr.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
            let top_n = (sorted_by_pnr.len() / 4).max(1);
            let top: Vec<f64> = sorted_by_pnr[..top_n].iter().map(|x| x.0).collect();
            let mut top_sorted = top.clone();
            top_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let top_med = top_sorted[top_sorted.len() / 2];
            println!(
                "  Median over top {} chunks by PNR: {:+.2} ms",
                top_n, top_med
            );
            if let Some(t) = truth_ms {
                println!("  Truth: {:+.0} ms — Δ all={:+.2}, Δ top={:+.2}", t, med - t, top_med - t);
            }
        }
    }
    println!();

    // ---- Stage 6: global NCC stats ---------------------------------------------
    println!("[6] Global chroma NCC statistics");
    let cr_mask = active_mask(&cr);
    let cq_mask = active_mask(&cq);
    let cr_active: f32 = cr_mask.iter().sum();
    let cq_active: f32 = cq_mask.iter().sum();
    println!(
        "  active frames: ref={:.0}/{}  ({:.1}%)  query={:.0}/{}  ({:.1}%)",
        cr_active,
        cr.n_frames,
        100.0 * cr_active / cr.n_frames as f32,
        cq_active,
        cq.n_frames,
        100.0 * cq_active / cq.n_frames as f32
    );
    println!();

    println!("done.");
}

fn read_f32le(path: &Path) -> std::io::Result<Vec<f32>> {
    let mut f = fs::File::open(path)?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    if bytes.len() % 4 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file {} not multiple of 4 bytes", path.display()),
        ));
    }
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(samples)
}

fn offset_to_ms(samples: i64) -> f64 {
    samples as f64 / SR as f64 * 1000.0
}

fn fmt_ratio(r: f64) -> String {
    if !r.is_finite() || r > 1e5 {
        "  ∞".into()
    } else if r >= 100.0 {
        format!("{:.0}", r)
    } else {
        format!("{:.2}", r)
    }
}

fn active_mask(c: &ChromaMatrix) -> Vec<f32> {
    let mut mask = vec![0.0f32; c.n_frames];
    for t in 0..c.n_frames {
        for d in 0..N_PITCH_CLASSES {
            if c.row(d)[t].abs() > 0.0 {
                mask[t] = 1.0;
                break;
            }
        }
    }
    mask
}

fn raw_chroma_correlation(cr: &ChromaMatrix, cq: &ChromaMatrix) -> Vec<f32> {
    let n_full = cr.n_frames + cq.n_frames - 1;
    let mut accum = vec![0.0f32; n_full];
    for d in 0..N_PITCH_CLASSES {
        let c = correlate_full(cq.row(d), cr.row(d));
        for (i, v) in c.iter().enumerate() {
            accum[i] += v;
        }
    }
    accum
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

fn chroma_cosine_at_offset(cr: &ChromaMatrix, cq: &ChromaMatrix, offset_samples: i64) -> f64 {
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
