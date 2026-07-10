//! Test-only synthetic signal helpers, shared by the drift and sync test
//! modules. Compiled only under `#[cfg(test)]` (see lib.rs).

use std::f32::consts::PI;

/// Deterministic pseudo-random "song": percussive notes (sharp broadband
/// noise-burst attack + exponentially decaying tone) with PRNG-chosen
/// continuous frequencies, durations and amplitudes.
///
/// Two properties matter for the drift/sync tests:
///   * aperiodic — continuous random frequencies and varied note lengths
///     mean windowed cross-correlation can't lock onto a bar-shifted
///     impostor the way it can on looped scale patterns;
///   * transient-rich — under clock drift the sustained-tone phase
///     decorrelates within a 10 s window (0.05 % drift = 5 ms of
///     intra-window slip, many periods), so per-window matching relies on
///     broadband attack transients exactly like it does on real music.
pub fn make_prng_song(duration_s: f32, sr: u32, seed: u64) -> Vec<f32> {
    // Tiny xorshift PRNG for determinism.
    let mut state = seed.max(1);
    let mut rand = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64 // uniform [0, 1)
    };
    let n = (duration_s * sr as f32) as usize;
    let mut y = vec![0.0f32; n];
    let mut i = 0usize;
    while i < n {
        let f = 180.0 + 700.0 * rand();
        let dur_s = 0.15 + 0.2 * rand();
        let amp = 0.2 + 0.3 * rand();
        let note_len = (dur_s * sr as f64) as usize;
        let attack_len = (0.015 * sr as f64) as usize;
        let end = (i + note_len).min(n);
        for j in i..end {
            let k = j - i;
            let t_note = k as f64 / sr as f64;
            // Pluck-like decaying tone.
            let mut v = amp * (-t_note / 0.06).exp() * (2.0 * PI as f64 * f * t_note).sin();
            if k < attack_len {
                // Sharp broadband attack transient.
                let noise = rand() * 2.0 - 1.0;
                let a = 1.0 - k as f64 / attack_len as f64;
                v += 0.9 * a * noise;
            }
            y[j] = v as f32;
        }
        i = end;
    }
    y
}

/// Linearly resample `y` into the clock domain of a recorder whose fitted
/// drift ratio (d query_time / d ref_time — the slope recovered by
/// `windowed_drift_refinement`) is `drift`:
///
///   out[j] = y[j / drift]
///
/// so an event at input time `t` lands at output time `drift * t`.
/// `drift > 1` → the query clock runs fast (more samples per real second,
/// output longer); `drift < 1` → it runs slow.
pub fn resample_with_drift(y: &[f32], drift: f64) -> Vec<f32> {
    assert!(!y.is_empty());
    let n_out = ((y.len() as f64 - 1.0) * drift).floor() as usize + 1;
    let mut out = Vec::with_capacity(n_out);
    for j in 0..n_out {
        let x = j as f64 / drift;
        let i0 = (x.floor() as usize).min(y.len() - 1);
        let i1 = (i0 + 1).min(y.len() - 1);
        let frac = (x - i0 as f64) as f32;
        out.push(y[i0] + (y[i1] - y[i0]) * frac);
    }
    out
}
