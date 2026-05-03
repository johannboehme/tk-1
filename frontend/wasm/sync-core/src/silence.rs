//! Stille-Erkennung auf einer pre-computed RMS-Envelope.
//!
//! Wird vom Long-Form-Triage-Workflow benutzt um in einer 1h+
//! Session-Aufnahme die musikalischen Bereiche von den Pausen zu
//! trennen — der User kuratiert dann pro Bereich, ob er ihn behalten
//! will. Der Algorithmus arbeitet bewusst auf der Hüllkurve (typisch
//! 10 Hz, eine Sample pro 100 ms) statt auf rohen PCM, so dass eine
//! 1h Aufnahme 36 000 Werte hat und live re-runnable bleibt wenn
//! der User Threshold + Min-Pause justiert.
//!
//! Kein Onset-Backoff hier (anders als `audioStartS` in der
//! Editor-Audio-Analyse): das ist ein anderer Job. Die Triage-UI
//! erlaubt dem User pro Chunk Bar-Snap-Trim — der ersetzt die
//! Onset-Backoff-Heuristik durch einen direkten User-Eingriff.

/// Ein erkannter Audio-Bereich (zwischen Pausen) in Master-Audio-
/// Millisekunden.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioChunk {
    pub start_ms: u32,
    pub end_ms: u32,
}

/// Erkennt zusammenhängende Audio-Chunks in einer RMS-Envelope.
///
/// Logik:
///   1. Pro Envelope-Sample: ist sie `> threshold_lin`?
///   2. Audio-State: solange Werte über dem Threshold liegen, sind wir
///      in einem Chunk.
///   3. Pause-State: Werte ≤ Threshold beenden den Chunk *nicht*
///      sofort. Erst wenn die Pause länger als `min_pause_ms` wird,
///      wird der vorherige Chunk geschlossen.
///   4. Eine kürzere Pause (z.B. 200 ms zwischen zwei Drum-Hits) bleibt
///      Teil desselben Chunks — vermeidet ungewollte Mikro-Splits.
///
/// `threshold_lin` ist linear (nicht dB) — die UI rechnet vorher um.
/// Werte typisch 1e-3 (≈ -60 dBFS) bis 3e-2 (≈ -30 dBFS).
///
/// Garantiert: alle zurückgegebenen Chunks haben `end_ms > start_ms`,
/// und sie sind nach `start_ms` aufsteigend sortiert ohne Überlappung.
pub fn silence_segments(
    envelope: &[f32],
    envelope_hz: f32,
    threshold_lin: f32,
    min_pause_ms: f32,
) -> Vec<AudioChunk> {
    if envelope.is_empty() || envelope_hz <= 0.0 {
        return Vec::new();
    }
    let ms_per_sample = 1000.0 / envelope_hz;
    let min_pause_samples = (min_pause_ms / ms_per_sample).ceil().max(1.0) as usize;

    let mut chunks: Vec<AudioChunk> = Vec::new();
    // Active chunk start (in envelope samples). None when we're in
    // a confirmed silence stretch.
    let mut chunk_start: Option<usize> = None;
    // Counter for consecutive sub-threshold samples since the last
    // above-threshold one. Only triggers a chunk-close when it crosses
    // `min_pause_samples`.
    let mut silence_run: usize = 0;
    // The last sample-index that was above threshold while a chunk
    // was active — that's where the chunk *ends* (we don't want the
    // trailing sub-threshold tail to inflate `end_ms`).
    let mut last_loud_idx: usize = 0;

    for (i, &v) in envelope.iter().enumerate() {
        if v > threshold_lin {
            if chunk_start.is_none() {
                chunk_start = Some(i);
            }
            silence_run = 0;
            last_loud_idx = i;
        } else if chunk_start.is_some() {
            silence_run += 1;
            if silence_run >= min_pause_samples {
                // Confirmed pause — close the chunk at last_loud_idx.
                let start = chunk_start.unwrap();
                push_chunk(&mut chunks, start, last_loud_idx, ms_per_sample);
                chunk_start = None;
                silence_run = 0;
            }
        }
    }

    // Tail: file ended while a chunk was still open — close it at the
    // last loud sample (or at the file end if everything stayed loud).
    if let Some(start) = chunk_start {
        let end = if last_loud_idx > start {
            last_loud_idx
        } else {
            envelope.len() - 1
        };
        push_chunk(&mut chunks, start, end, ms_per_sample);
    }

    chunks
}

fn push_chunk(out: &mut Vec<AudioChunk>, start_idx: usize, end_idx: usize, ms_per_sample: f32) {
    // +1 on end so a chunk covering only sample `i` reads as having
    // `ms_per_sample` ms of duration, not zero.
    let start_ms = (start_idx as f32 * ms_per_sample).round() as u32;
    let end_ms = ((end_idx + 1) as f32 * ms_per_sample).round() as u32;
    if end_ms > start_ms {
        out.push(AudioChunk { start_ms, end_ms });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an envelope at 10 Hz where each segment is `(value, secs)`.
    /// Result: a flat-step envelope, one sample per 100 ms.
    fn build_envelope(steps: &[(f32, f32)], envelope_hz: f32) -> Vec<f32> {
        let mut v = Vec::new();
        for &(amp, secs) in steps {
            let n = (secs * envelope_hz).round() as usize;
            for _ in 0..n {
                v.push(amp);
            }
        }
        v
    }

    #[test]
    fn empty_envelope_returns_no_chunks() {
        let chunks = silence_segments(&[], 10.0, 0.01, 1500.0);
        assert!(chunks.is_empty());
    }

    #[test]
    fn all_silence_returns_no_chunks() {
        let env = vec![0.0001f32; 100]; // 10 s at 10 Hz, all under threshold
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert!(chunks.is_empty(), "got {:?}", chunks);
    }

    #[test]
    fn single_loud_block_returns_one_chunk() {
        // 2 s loud, all above threshold.
        let env = build_envelope(&[(0.1, 2.0)], 10.0);
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].start_ms, 0);
        // 20 envelope samples × 100 ms = 2000 ms — but our exclusive-
        // end convention means end_idx=19 → end_ms=2000.
        assert_eq!(chunks[0].end_ms, 2000);
    }

    #[test]
    fn loud_silence_loud_with_long_gap_returns_two_chunks() {
        // 1 s loud, 2 s silence, 1 s loud. min_pause = 1.5 s → the
        // gap is long enough to split.
        let env = build_envelope(&[(0.1, 1.0), (0.0001, 2.0), (0.1, 1.0)], 10.0);
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert_eq!(chunks.len(), 2, "got {:?}", chunks);
        assert_eq!(chunks[0].start_ms, 0);
        assert!(chunks[0].end_ms <= 1100, "first chunk end: {}", chunks[0].end_ms);
        assert!(chunks[1].start_ms >= 2900, "second chunk start: {}", chunks[1].start_ms);
        assert!(chunks[1].end_ms <= 4100, "second chunk end: {}", chunks[1].end_ms);
    }

    #[test]
    fn short_gap_below_min_pause_does_not_split() {
        // 1 s loud, 0.5 s silence, 1 s loud. min_pause = 1.5 s → gap
        // too short to count as silence; everything is one chunk.
        let env = build_envelope(&[(0.1, 1.0), (0.0001, 0.5), (0.1, 1.0)], 10.0);
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert_eq!(chunks.len(), 1, "got {:?}", chunks);
        assert_eq!(chunks[0].start_ms, 0);
        assert!(chunks[0].end_ms >= 2400, "chunk end: {}", chunks[0].end_ms);
    }

    #[test]
    fn lower_threshold_keeps_quiet_audio_in_chunk() {
        // 0.005 amplitude — between two threshold values.
        let env = build_envelope(&[(0.005, 1.0)], 10.0);
        // Strict threshold 0.01 → quiet audio is "silence" → no chunk.
        let strict = silence_segments(&env, 10.0, 0.01, 500.0);
        assert!(strict.is_empty(), "strict={:?}", strict);
        // Loose threshold 0.001 → quiet audio is "loud enough" → one chunk.
        let loose = silence_segments(&env, 10.0, 0.001, 500.0);
        assert_eq!(loose.len(), 1, "loose={:?}", loose);
    }

    #[test]
    fn trailing_silence_is_trimmed_from_chunk_end() {
        // 1 s loud, 2 s silence (long enough to confirm pause), then
        // file ends. Chunk should end at the last loud sample, not
        // include the silent tail.
        let env = build_envelope(&[(0.1, 1.0), (0.0001, 2.0)], 10.0);
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].end_ms <= 1100, "chunk end: {}", chunks[0].end_ms);
    }

    #[test]
    fn chunk_open_at_eof_is_closed() {
        // Loud audio runs to the end of the file (no trailing silence).
        let env = build_envelope(&[(0.0001, 0.5), (0.1, 1.5)], 10.0);
        let chunks = silence_segments(&env, 10.0, 0.01, 1500.0);
        assert_eq!(chunks.len(), 1, "got {:?}", chunks);
        assert!(chunks[0].start_ms >= 400 && chunks[0].start_ms <= 600);
        // 0.5s silence + 1.5s loud → end ≈ 2000 ms
        assert!(chunks[0].end_ms >= 1900 && chunks[0].end_ms <= 2100);
    }

    #[test]
    fn longform_smoke_three_sections_with_realistic_pauses() {
        // Mimic a beat-making session: idle → 30 s loop → quick break (3 s) →
        // 45 s build → silence (10 s) → 60 s full song. min_pause = 5 s.
        let env = build_envelope(
            &[
                (0.0001, 5.0),  // intro silence
                (0.05, 30.0),   // section 1
                (0.0001, 3.0),  // short break — under min_pause, glued
                (0.05, 45.0),   // section 1 cont. (same chunk)
                (0.0001, 10.0), // long break — confirmed pause
                (0.08, 60.0),   // section 2
                (0.0001, 5.0),  // tail silence
            ],
            10.0,
        );
        let chunks = silence_segments(&env, 10.0, 0.01, 5000.0);
        // 2 chunks: first one spans both sub-sections (3s gap is too short),
        // second one is the 60s song.
        assert_eq!(chunks.len(), 2, "got {:?}", chunks);
        // First chunk should cover roughly 5s..83s (section 1 + short gap + section 1 cont.)
        assert!(chunks[0].start_ms >= 4000 && chunks[0].start_ms <= 6000);
        assert!(chunks[0].end_ms >= 80_000 && chunks[0].end_ms <= 85_000);
        // Second chunk roughly 93s..153s.
        assert!(chunks[1].start_ms >= 92_000 && chunks[1].start_ms <= 95_000);
        assert!(chunks[1].end_ms >= 150_000 && chunks[1].end_ms <= 155_000);
    }
}
