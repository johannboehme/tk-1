import { describe, it, expect } from "vitest";
import { analyzeAudio, analyzeAudioFixedBpm } from "./analyze";

const SR = 22050;

/** Build a synthetic click-track at the given BPM, lasting `seconds`. Each
 *  click is a 5 ms decaying impulse on top of a low-amp white-noise floor. */
function buildClickTrack(bpm: number, seconds: number): Float32Array {
  const total = Math.round(SR * seconds);
  const beatPeriod = 60 / bpm;
  const beatStride = Math.round(beatPeriod * SR);
  const clickLen = Math.round(0.005 * SR);
  const pcm = new Float32Array(total);
  // White-noise floor (very low amplitude).
  for (let i = 0; i < total; i++) pcm[i] = (Math.random() - 0.5) * 0.01;

  for (let beat = 0; beat * beatStride + clickLen < total; beat++) {
    const start = beat * beatStride;
    for (let k = 0; k < clickLen; k++) {
      const env = Math.exp((-k / clickLen) * 4);
      // Short broadband impulse: sum a couple of sinusoids + noise burst.
      const tone =
        Math.sin((2 * Math.PI * 200 * k) / SR) +
        0.6 * Math.sin((2 * Math.PI * 1500 * k) / SR);
      pcm[start + k] += 0.8 * env * tone;
    }
  }
  return pcm;
}

describe("analyzeAudio — pure pipeline", () => {
  it("populates the basic shape and bands for a normal-length track", () => {
    const pcm = buildClickTrack(120, 8); // 8 seconds, 120 BPM
    const a = analyzeAudio(pcm, SR);
    expect(a.version).toBe(3);
    expect(a.sampleRate).toBe(SR);
    expect(a.duration).toBeCloseTo(8, 1);
    expect(a.bands.bass.length).toBeGreaterThan(0);
    expect(a.bands.bass.length).toBe(a.bands.mids.length);
    expect(a.bands.bass.length).toBe(a.rms.length);
    expect(a.bands.bass.length).toBe(a.onsetStrength.length);
  });

  it("detects 120 BPM ± 2 from a 4-on-the-floor click track", () => {
    const pcm = buildClickTrack(120, 12);
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    expect(a.tempo!.bpm).toBeGreaterThan(118);
    expect(a.tempo!.bpm).toBeLessThan(122);
  });

  it("detects 90 BPM ± 2 from a slower click track", () => {
    const pcm = buildClickTrack(90, 14);
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    expect(a.tempo!.bpm).toBeGreaterThan(88);
    expect(a.tempo!.bpm).toBeLessThan(92);
  });

  it("picks the half-time tempo when both 85 and 170 BPM autocorrelate", () => {
    // Lo-fi hip-hop / swing pattern: a strong kick on every beat at
    // 85 BPM, plus a softer hat on every off-beat (twice the rate =
    // 170 BPM events). The autocorrelation surface has peaks at
    // BOTH lags and the unprior'd picker used to land on 170/180
    // because it sums the on-beat-AC into the doubled-tempo lag's
    // vote. The Rayleigh prior at ~110 BPM pulls the answer back
    // toward the perceptually-correct slower octave.
    const seconds = 16;
    const total = Math.round(SR * seconds);
    const pcm = new Float32Array(total);
    for (let i = 0; i < total; i++) pcm[i] = (Math.random() - 0.5) * 0.01;
    const beatStride = Math.round((60 / 85) * SR);
    const halfStride = Math.round((60 / 170) * SR);
    const clickLen = Math.round(0.005 * SR);
    // Strong kick on every beat (85 BPM).
    for (let beat = 0; beat * beatStride + clickLen < total; beat++) {
      const start = beat * beatStride;
      for (let k = 0; k < clickLen; k++) {
        const env = Math.exp((-k / clickLen) * 4);
        pcm[start + k] += 0.9 * env * Math.sin((2 * Math.PI * 80 * k) / SR);
      }
    }
    // Softer hat on every off-beat (= every position at 170 BPM that
    // ISN'T already a kick).
    for (let h = 0; h * halfStride + clickLen < total; h++) {
      if (h % 2 === 0) continue; // skip kicks
      const start = h * halfStride;
      for (let k = 0; k < clickLen; k++) {
        const env = Math.exp((-k / clickLen) * 4);
        pcm[start + k] += 0.4 * env * Math.sin((2 * Math.PI * 6000 * k) / SR);
      }
    }
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    expect(a.tempo!.bpm).toBeGreaterThan(80);
    expect(a.tempo!.bpm).toBeLessThan(95);
  });

  it("emits beats roughly every beat-period (count near duration*bpm/60)", () => {
    const pcm = buildClickTrack(120, 10);
    const a = analyzeAudio(pcm, SR);
    expect(a.beats.length).toBeGreaterThan(15);
    expect(a.beats.length).toBeLessThan(25);
  });

  it("makes downbeats every 4th beat (4/4 fixed)", () => {
    const pcm = buildClickTrack(120, 12);
    const a = analyzeAudio(pcm, SR);
    expect(a.downbeats.length).toBe(Math.ceil(a.beats.length / 4));
    if (a.beats.length >= 5) {
      expect(a.downbeats[0]).toBeCloseTo(a.beats[0], 6);
      expect(a.downbeats[1]).toBeCloseTo(a.beats[4], 6);
    }
  });

  it("finds onsets close to the actual click positions (~0.5 s spacing)", () => {
    const pcm = buildClickTrack(120, 6);
    const a = analyzeAudio(pcm, SR);
    expect(a.onsets.length).toBeGreaterThan(8);
    // Spectral-flux can't see the very first click (it's at the window edge),
    // so onsets[0] corresponds to a later click — but spacing must be ~beat.
    if (a.onsets.length >= 3) {
      const d0 = a.onsets[1] - a.onsets[0];
      const d1 = a.onsets[2] - a.onsets[1];
      expect(d0).toBeGreaterThan(0.4);
      expect(d0).toBeLessThan(0.6);
      expect(d1).toBeGreaterThan(0.4);
      expect(d1).toBeLessThan(0.6);
    }
  });

  it("returns the empty-shape skeleton for too-short audio", () => {
    const pcm = new Float32Array(SR / 50); // ~20 ms — way below 4 frames
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).toBeNull();
    expect(a.beats.length).toBe(0);
    expect(a.bands.bass.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Phase + BPM precision (regression refit through detected beats).
  //
  // The autocorrelation-derived `tempo.bpm` is quantized to one frame per
  // beat-period (~8 BPM resolution at 120 BPM, partly mitigated by parabolic
  // refinement) and `tempo.phase` only searches the first beat-period for
  // the strongest onset — so an audio file that starts with silence (e.g.
  // a recording that began before the music) gets phase=0, which leaves
  // every snap target floating somewhere off the actual beats.
  //
  // The DP beat-tracker correctly finds individual beats throughout the
  // track, so a least-squares fit through them recovers both the true
  // BPM (averaged over many beats) and the true phase (= position of the
  // first real beat).
  // ──────────────────────────────────────────────────────────────────────

  it("finds the right phase even when the track starts with silence", () => {
    // 0.85 s of silence, then 6 s of 120 BPM clicks (period 0.5 s). The
    // intro is deliberately *not* a multiple of the beat period — so a
    // broken phase=0 result lands clearly off the click grid (0.85 mod
    // 0.5 = 0.35 s) and would fail the assertion below.
    const intro = 0.85;
    const clicks = buildClickTrack(120, 6);
    const pcm = new Float32Array(Math.round(SR * intro) + clicks.length);
    pcm.set(clicks, Math.round(SR * intro));
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    const period = 60 / a.tempo!.bpm;
    const phase = a.tempo!.phase;
    // Phase should be on the click grid: clicks are at intro + k*period.
    // Distance to the nearest grid line must stay within one analysis hop
    // (~33 ms) — definitely NOT 1.0 s like the bug produces.
    const offset = phase - intro;
    const mod = ((offset % period) + period) % period;
    const distToGrid = Math.min(mod, period - mod);
    expect(distToGrid).toBeLessThan(1 / a.framesPerSec);
    // Sanity: phase must be inside the first few beats of the actual music,
    // not anchored to t=0 (a 1 s mistake is wildly outside tolerance).
    expect(phase).toBeGreaterThan(intro - 2 * period);
    expect(phase).toBeLessThan(intro + 2 * period);
  });

  it("BPM is precise enough to avoid accumulating beat-grid drift", () => {
    // Long click track at exactly 120 BPM. After regression-refit, the
    // detected BPM must be within 0.1 BPM of truth so the grid does not
    // visibly drift apart from the actual beats over time.
    const targetBpm = 120;
    const seconds = 30;
    const pcm = buildClickTrack(targetBpm, seconds);
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    expect(Math.abs(a.tempo!.bpm - targetBpm)).toBeLessThan(0.1);
  });

  it("ignores silent intro: audioStartS lands on the first hit, not on FP-noise", () => {
    // 5 s of dead-silence (zero PCM — what an OP-1 / digital recorder
    // outputs before the operator hits play), then 6 s of clicks. Without
    // gating the silent stretch, spectral-flux quantization noise gets
    // peak-picked into evenly-spaced "onsets" at ~120 BPM and the DP
    // beat-tracker happily anchors Bar 1 inside the silence.
    const intro = 5.0;
    const clicks = buildClickTrack(120, 6);
    const pcm = new Float32Array(Math.round(SR * intro) + clicks.length);
    pcm.set(clicks, Math.round(SR * intro));
    const a = analyzeAudio(pcm, SR);

    expect(a.tempo).not.toBeNull();
    // audioStartS must land near (slightly before) the first real click.
    expect(a.audioStartS).toBeGreaterThan(intro - 0.2);
    expect(a.audioStartS).toBeLessThan(intro + 0.2);
    // No detected beat is allowed to sit in the silent intro.
    for (const b of a.beats) {
      expect(b).toBeGreaterThanOrEqual(intro - 0.1);
    }
    // tempo.phase lands on (or right after) the first real beat.
    expect(a.tempo!.phase).toBeGreaterThan(intro - 0.1);
    expect(a.tempo!.phase).toBeLessThan(intro + 1.0);
  });

  it("does not gate non-silent material: audioStartS stays at 0", () => {
    // Continuous (low-amplitude) noise from t=0 simulates a track with
    // ambient material throughout — must NOT be treated as a silent
    // intro, even though its RMS is well below the music.
    const pcm = buildClickTrack(120, 12);
    // buildClickTrack already mixes white noise across the whole span.
    const a = analyzeAudio(pcm, SR);
    expect(a.audioStartS).toBeLessThan(0.1);
  });

  it("grid (phase + k·period) tracks detected beats with no accumulating drift", () => {
    // For a steady click track every detected beat must be within one hop of
    // SOME grid line phase + k·period — no accumulating shear over time.
    // We check nearest-grid-line (not beats[i] ≡ phase+i·period) because
    // the DP tracker may miss beat 1 and start from beat 2; after phase
    // anchoring, beats[i] and phase+i·period are offset by one period but
    // each beat still lies on a grid line.
    const pcm = buildClickTrack(120, 20);
    const a = analyzeAudio(pcm, SR);
    expect(a.tempo).not.toBeNull();
    const period = 60 / a.tempo!.bpm;
    const phase = a.tempo!.phase;
    const tol = 1 / a.framesPerSec; // one hop ≈ 33 ms
    let maxResid = 0;
    for (const b of a.beats) {
      const k = Math.round((b - phase) / period);
      const nearest = phase + k * period;
      const r = Math.abs(b - nearest);
      if (r > maxResid) maxResid = r;
    }
    expect(maxResid).toBeLessThan(tol);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase-only refit at a fixed period.
//
// Used by Triage's "Conform" action: the user has already fixed the global
// BPM (via majority vote across chunks or manual override), and just wants
// the bar-grid phase of one chunk re-detected from its current audio range.
// The period is held; only the phase residual is fit. More robust than the
// joint period+phase refit when a chunk's local BPM detection would
// disagree with the global decision.
// ────────────────────────────────────────────────────────────────────────────

describe("analyzeAudioFixedBpm — phase-only refit", () => {
  it("recovers a known phase offset within one analysis hop", () => {
    // 0.137 s of silence, then 8 s of 120 BPM clicks. With BPM held at
    // 120, the LS-fit phase should land on the click grid (any
    // phase + k*period is equivalent — same grid). Tolerance is one
    // analysis hop (~33 ms at fps=30) — the resolution of the
    // spectral-flux peak picker before sub-frame refinement averages out.
    const intro = 0.137;
    const clicks = buildClickTrack(120, 8);
    const pcm = new Float32Array(Math.round(SR * intro) + clicks.length);
    pcm.set(clicks, Math.round(SR * intro));
    const result = analyzeAudioFixedBpm(pcm, SR, 120, 4);
    expect(result).not.toBeNull();
    const period = 60 / 120;
    const offset = result!.phaseS - intro;
    const mod = ((offset % period) + period) % period;
    const distToGrid = Math.min(mod, period - mod);
    // 1/30 ≈ 33 ms; same tolerance the analyzeAudio test uses.
    expect(distToGrid).toBeLessThan(1 / 30);
  });

  it("returns a finite phase even when fixedBpm slightly disagrees with audio", () => {
    // Audio is at 115 BPM, caller passes 120. Period is held; phase is
    // best-effort (the residuals won't average down to zero noise, but
    // the function must still return *something* without throwing).
    const pcm = buildClickTrack(115, 8);
    const result = analyzeAudioFixedBpm(pcm, SR, 120, 4);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.phaseS)).toBe(true);
  });

  it("returns null on too-short input", () => {
    const pcm = new Float32Array(SR / 50); // ~20 ms
    const result = analyzeAudioFixedBpm(pcm, SR, 120, 4);
    expect(result).toBeNull();
  });

  it("returns null when fixedBpm is non-positive", () => {
    const pcm = buildClickTrack(120, 8);
    expect(analyzeAudioFixedBpm(pcm, SR, 0, 4)).toBeNull();
    expect(analyzeAudioFixedBpm(pcm, SR, -120, 4)).toBeNull();
  });

  it("falls back to the first onset when there aren't enough beats for an LS-fit", () => {
    // 600 ms of mostly silence with a single click at ~100 ms. The DP
    // beat-tracker can't chain beats from a single peak, but we should
    // still return a phase anchored on that one onset — better than
    // nothing for the user's "Conform" workflow on short fragments.
    const totalSamples = Math.round(SR * 0.6);
    const pcm = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) pcm[i] = (Math.random() - 0.5) * 0.005;
    const clickStart = Math.round(SR * 0.1);
    const clickLen = Math.round(0.005 * SR);
    for (let k = 0; k < clickLen; k++) {
      const env = Math.exp((-k / clickLen) * 4);
      pcm[clickStart + k] += 0.8 * env * Math.sin((2 * Math.PI * 200 * k) / SR);
    }
    const result = analyzeAudioFixedBpm(pcm, SR, 120, 4);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.phaseS)).toBe(true);
    // Phase should land near the click position (~100 ms) within one
    // analysis hop. Confidence is low because we couldn't verify the
    // period from multiple beats.
    expect(Math.abs(result!.phaseS - 0.1)).toBeLessThan(1 / 30);
    expect(result!.confidence).toBeLessThan(0.5);
  });

});
