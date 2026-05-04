//! Mel-spectrogram für Per-Chunk-Glance-Display in Arrange.
//!
//! Pure DSP: STFT → mel-filter-bank → log-power → uint8. Output ist
//! frame-major: alle `n_mels` Werte für Frame 0, dann für Frame 1, etc.
//! Der Canvas2D-Renderer im Frontend mapped 0..255 auf einen Phosphor-
//! Color-Stop und zeichnet das via `putImageData`.
//!
//! Auslegung bewusst klein: 64 mel bins × 30 fps ist genug für einen
//! 100-200 px breiten LCD-Mini-Spec, aber klein genug dass ein 10 s
//! Chunk ~20 KB belegt — gut cachebar in IDB.

use realfft::{num_complex::Complex, RealFftPlanner, RealToComplex};
use std::sync::Arc;

const N_FFT: usize = 2048;
/// Floor in dB unter dem Peak, alles drunter wird zu 0 geklippt.
/// 80 dB Range ist OP-1-äquivalenter "viel sichtbares Detail ohne
/// Visualisierung-zerschießendem Floor-Noise"-Sweetspot.
const DB_RANGE: f32 = 80.0;
/// Linear amplitude floor zur Vermeidung von log(0).
const EPS: f32 = 1e-10;

/// Berechnet das Mel-Spectrogram eines PCM-Snippets.
///
/// * `pcm` — mono PCM samples in [-1, 1].
/// * `sample_rate` — samples/sec (z.B. 22050).
/// * `n_mels` — Anzahl mel-bins (Empfehlung 64).
/// * `fps` — output frame-rate (Empfehlung 30 = ~33 ms hop).
///
/// Output: `Vec<u8>` mit `n_mels * n_frames` Werten, frame-major.
/// Ein Wert ist `0..=255` mit `255` = peak-energy (= 0 dB), `0` =
/// `-DB_RANGE` dB oder leiser. Linear in dB, gut zum Mappen auf einen
/// Phosphor-Color-Stop.
///
/// Returns `(data, n_frames)`. Wenn pcm zu kurz für ein einziges
/// FFT-Window ist, wird ein einzelner Frame zero-padded.
pub fn mel_spectrogram(
    pcm: &[f32],
    sample_rate: u32,
    n_mels: usize,
    fps: u32,
) -> (Vec<u8>, usize) {
    if pcm.is_empty() || sample_rate == 0 || n_mels == 0 || fps == 0 {
        return (Vec::new(), 0);
    }
    let hop = ((sample_rate as f32) / (fps as f32)).max(1.0).round() as usize;
    let n_frames = if pcm.len() >= N_FFT {
        // Number of full hops that fit: floor((len - N_FFT) / hop) + 1.
        ((pcm.len() - N_FFT) / hop) + 1
    } else {
        // Always emit at least one (zero-padded) frame so callers
        // always get a non-empty visualisation for tiny snippets.
        1
    };

    let window = hann_window(N_FFT);
    let mel_bank = build_mel_filter_bank(n_mels, N_FFT, sample_rate);

    let mut planner: RealFftPlanner<f32> = RealFftPlanner::<f32>::new();
    let r2c: Arc<dyn RealToComplex<f32>> = planner.plan_fft_forward(N_FFT);
    let mut fft_in = vec![0.0f32; N_FFT];
    let mut fft_out: Vec<Complex<f32>> = r2c.make_output_vec();

    let n_bins_pos = N_FFT / 2 + 1;
    let mut power_spec = vec![0.0f32; n_bins_pos];
    // Cache linear mel-energies — log+normalisation happens after the
    // full pass so we can pin the dB scale to the actual signal peak.
    let mut all_lin: Vec<f32> = Vec::with_capacity(n_mels * n_frames);
    let mut peak_lin = 0.0f32;

    for f in 0..n_frames {
        let start = f * hop;
        for i in 0..N_FFT {
            let s = start + i;
            let x = if s < pcm.len() { pcm[s] } else { 0.0 };
            fft_in[i] = x * window[i];
        }
        if r2c.process(&mut fft_in, &mut fft_out).is_err() {
            for _ in 0..n_mels {
                all_lin.push(0.0);
            }
            continue;
        }
        for (k, c) in fft_out.iter().enumerate() {
            power_spec[k] = c.norm_sqr();
        }
        for m in 0..n_mels {
            let filt = &mel_bank[m];
            let mut sum = 0.0f32;
            for &(k, w) in filt {
                sum += power_spec[k] * w;
            }
            if sum > peak_lin {
                peak_lin = sum;
            }
            all_lin.push(sum);
        }
    }

    // Pure silence (peak below DSP-floor) → all zero, no fake gradient.
    // SILENCE_FLOOR is well below any real audible signal but well above
    // FFT roundoff, so genuine quiet content still renders.
    const SILENCE_FLOOR: f32 = 1e-9;
    if peak_lin < SILENCE_FLOOR {
        return (vec![0u8; n_mels * n_frames], n_frames);
    }
    let peak_db = 10.0 * peak_lin.log10();
    let floor_db = peak_db - DB_RANGE;
    let mut out = Vec::with_capacity(n_mels * n_frames);
    for &lin in all_lin.iter() {
        let db = 10.0 * (lin + EPS).log10();
        let norm = ((db - floor_db) / DB_RANGE).clamp(0.0, 1.0);
        out.push((norm * 255.0).round() as u8);
    }
    (out, n_frames)
}

fn hann_window(n: usize) -> Vec<f32> {
    if n <= 1 {
        return vec![1.0; n];
    }
    let denom = (n - 1) as f32;
    (0..n)
        .map(|i| 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / denom).cos())
        .collect()
}

/// Slaney-style triangular mel-filter-bank — represented as sparse
/// `(bin_index, weight)` pairs per filter to keep the inner loop tight
/// (most filters touch only ~10-50 bins).
fn build_mel_filter_bank(
    n_mels: usize,
    n_fft: usize,
    sample_rate: u32,
) -> Vec<Vec<(usize, f32)>> {
    let n_bins_pos = n_fft / 2 + 1;
    let f_min = 0.0f32;
    let f_max = (sample_rate as f32) * 0.5;

    let mel_min = hz_to_mel(f_min);
    let mel_max = hz_to_mel(f_max);

    // n_mels + 2 mel-spaced points: low-edge, n_mels centers, high-edge.
    let n_pts = n_mels + 2;
    let mut mel_pts = Vec::with_capacity(n_pts);
    for i in 0..n_pts {
        let t = i as f32 / (n_pts - 1) as f32;
        mel_pts.push(mel_min + t * (mel_max - mel_min));
    }
    let hz_pts: Vec<f32> = mel_pts.iter().map(|&m| mel_to_hz(m)).collect();
    // Map Hz centers to FFT bin indices (continuous).
    let bin_pts: Vec<f32> = hz_pts
        .iter()
        .map(|&hz| hz * (n_fft as f32) / (sample_rate as f32))
        .collect();

    let mut bank: Vec<Vec<(usize, f32)>> = Vec::with_capacity(n_mels);
    for m in 0..n_mels {
        let lo = bin_pts[m];
        let center = bin_pts[m + 1];
        let hi = bin_pts[m + 2];
        let mut row: Vec<(usize, f32)> = Vec::new();
        // Slaney normalisation: divide by mel-bandwidth so taller (high-
        // frequency) filters don't dominate. enorm = 2 / (hi_hz - lo_hz).
        let lo_hz = hz_pts[m];
        let hi_hz = hz_pts[m + 2];
        let enorm = if hi_hz > lo_hz { 2.0 / (hi_hz - lo_hz) } else { 1.0 };
        let lo_i = lo.floor() as usize;
        let hi_i = (hi.ceil() as usize).min(n_bins_pos - 1);
        for k in lo_i..=hi_i {
            let kf = k as f32;
            let w = if kf <= lo || kf >= hi {
                0.0
            } else if kf <= center {
                (kf - lo) / (center - lo).max(1e-6)
            } else {
                (hi - kf) / (hi - center).max(1e-6)
            };
            if w > 0.0 {
                row.push((k, w * enorm));
            }
        }
        bank.push(row);
    }
    bank
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}
fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_sine(freq: f32, sr: u32, secs: f32) -> Vec<f32> {
        let n = (sr as f32 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let (data, n_frames) = mel_spectrogram(&[], 22050, 64, 30);
        assert!(data.is_empty());
        assert_eq!(n_frames, 0);
    }

    #[test]
    fn pure_sine_concentrates_in_one_mel_bin() {
        // 1 kHz sine for 1 s @ 22050 Hz
        let pcm = synth_sine(1000.0, 22050, 1.0);
        let n_mels = 64;
        let (data, n_frames) = mel_spectrogram(&pcm, 22050, n_mels, 30);
        assert!(n_frames > 20, "should have ~30 frames for 1s, got {}", n_frames);
        assert_eq!(data.len(), n_mels * n_frames);
        // Find argmax of mid-frame.
        let mid = n_frames / 2;
        let frame = &data[mid * n_mels..(mid + 1) * n_mels];
        let (argmax, &peak) = frame
            .iter()
            .enumerate()
            .max_by_key(|(_, &v)| v)
            .unwrap();
        // 1 kHz at sr=22050 falls in mel-bin index that's well above
        // the bottom and well below the top.
        assert!(argmax > 5 && argmax < n_mels - 5, "argmax={}", argmax);
        assert_eq!(peak, 255, "peak should saturate at 255 for clean sine");
        // Energy should be concentrated: very few bins close to peak.
        let near_peak = frame.iter().filter(|&&v| v > 200).count();
        assert!(
            near_peak < 8,
            "sine should be narrow-band, near_peak={}",
            near_peak,
        );
    }

    #[test]
    fn silence_yields_zero_or_low_values() {
        let pcm = vec![0.0f32; 22050];
        let (data, n_frames) = mel_spectrogram(&pcm, 22050, 64, 30);
        assert!(n_frames > 0);
        // All bins essentially at floor.
        let max = data.iter().copied().max().unwrap_or(0);
        assert!(max <= 1, "silence should be near-zero, got max={}", max);
    }

    #[test]
    fn white_noise_distributes_across_bins() {
        // Pseudo-random white noise via a tiny LCG so the test stays
        // deterministic without bringing in `rand`.
        let mut state: u32 = 0xdead_beef;
        let pcm: Vec<f32> = (0..22050)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                ((state >> 9) as f32 / (1 << 23) as f32) - 1.0
            })
            .map(|x| x * 0.3)
            .collect();
        let n_mels = 64;
        let (data, n_frames) = mel_spectrogram(&pcm, 22050, n_mels, 30);
        let mid = n_frames / 2;
        let frame = &data[mid * n_mels..(mid + 1) * n_mels];
        // Spread test: at least 60% of bins should be above floor (>0).
        let above_floor = frame.iter().filter(|&&v| v > 0).count();
        assert!(
            above_floor >= (n_mels * 6) / 10,
            "noise should excite many bins, above_floor={}/{}",
            above_floor,
            n_mels,
        );
    }

    #[test]
    fn output_length_matches_n_mels_times_n_frames() {
        let pcm = synth_sine(440.0, 22050, 0.5);
        let n_mels = 32;
        let (data, n_frames) = mel_spectrogram(&pcm, 22050, n_mels, 30);
        assert_eq!(data.len(), n_mels * n_frames);
    }

    #[test]
    fn very_short_input_emits_one_frame() {
        // 100 samples — far less than N_FFT=2048
        let pcm = vec![0.5f32; 100];
        let n_mels = 16;
        let (data, n_frames) = mel_spectrogram(&pcm, 22050, n_mels, 30);
        assert_eq!(n_frames, 1);
        assert_eq!(data.len(), n_mels);
    }
}
