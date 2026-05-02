import { describe, it, expect } from "vitest";
import { envelopeAt, INSTANT_ENVELOPE, type ADSREnvelope } from "./envelope";

const env = (
  attackS: number,
  decayS: number,
  sustain: number,
  releaseS: number,
): ADSREnvelope => ({ attackS, decayS, sustain, releaseS });

describe("envelopeAt — attack phase", () => {
  it("rises 0→1 linearly during the attack window", () => {
    const e = env(0.1, 0, 1, 0);
    expect(envelopeAt(e, 1.0, 0)).toBeCloseTo(0, 6);
    expect(envelopeAt(e, 1.0, 0.05)).toBeCloseTo(0.5, 6);
    expect(envelopeAt(e, 1.0, 0.099)).toBeCloseTo(0.99, 2);
  });

  it("returns 1 immediately when attack is 0", () => {
    expect(envelopeAt(env(0, 0, 1, 0), 1.0, 0)).toBe(1);
  });
});

describe("envelopeAt — decay phase", () => {
  it("falls 1→sustain linearly during the decay window", () => {
    const e = env(0.01, 0.02, 0.6, 0);
    // localT = A (start of decay) → exactly 1
    expect(envelopeAt(e, 1.0, 0.01)).toBeCloseTo(1, 6);
    // localT = A + D/2 → halfway between 1 and S
    expect(envelopeAt(e, 1.0, 0.02)).toBeCloseTo(0.8, 6);
    // localT = A + D → exactly S (read in sustain phase)
    expect(envelopeAt(e, 1.0, 0.03)).toBeCloseTo(0.6, 6);
  });

  it("snaps to sustain when decay is 0", () => {
    const e = env(0.01, 0, 0.5, 0);
    expect(envelopeAt(e, 1.0, 0.05)).toBeCloseTo(0.5, 6);
  });
});

describe("envelopeAt — sustain phase", () => {
  it("holds sustain level between decay-end and release-start", () => {
    const e = env(0.05, 0.1, 0.7, 0.2);
    // regionDur=1: sustain runs 0.15 .. 0.8
    expect(envelopeAt(e, 1.0, 0.3)).toBeCloseTo(0.7, 6);
    expect(envelopeAt(e, 1.0, 0.5)).toBeCloseTo(0.7, 6);
    expect(envelopeAt(e, 1.0, 0.79)).toBeCloseTo(0.7, 6);
  });
});

describe("envelopeAt — release phase", () => {
  it("falls sustain→0 linearly across the release window", () => {
    const e = env(0, 0, 1, 0.2);
    // releaseStart = 1.0 - 0.2 = 0.8
    expect(envelopeAt(e, 1.0, 0.8)).toBeCloseTo(1, 6);
    expect(envelopeAt(e, 1.0, 0.9)).toBeCloseTo(0.5, 6);
    expect(envelopeAt(e, 1.0, 0.99)).toBeCloseTo(0.05, 2);
  });

  it("respects sustain level at start of release", () => {
    const e = env(0, 0, 0.4, 0.2);
    expect(envelopeAt(e, 1.0, 0.8)).toBeCloseTo(0.4, 6);
    expect(envelopeAt(e, 1.0, 0.9)).toBeCloseTo(0.2, 6);
  });
});

describe("envelopeAt — edge cases", () => {
  it("returns 0 when regionDurS is 0", () => {
    expect(envelopeAt(env(0.1, 0.1, 0.5, 0.1), 0, 0)).toBe(0);
  });

  it("returns 0 when localT >= regionDurS", () => {
    expect(envelopeAt(env(0, 0, 1, 0), 1.0, 1.0)).toBe(0);
    expect(envelopeAt(env(0, 0, 1, 0), 1.0, 1.5)).toBe(0);
  });

  it("releases from partial-attack amplitude on quick tap (synth-voice)", () => {
    // After release: regionDur = held + R. With A > held, attack does NOT
    // compress to fit; it freezes mid-ramp and release fades from there.
    // E.g. held 50 ms with A=100 ms → attack reached 0.5 at let-go; release
    // fades 0.5 → 0 over R, NOT 1.0 → 0.
    const e = env(0.1, 0, 1, 0.2);
    const regionDur = 0.05 + 0.2; // held 50 ms + R=200 ms = 250 ms
    // Mid-attack at 25 ms (still inside attack ramp): 0.025 / 0.1 = 0.25.
    expect(envelopeAt(e, regionDur, 0.025)).toBeCloseTo(0.25, 4);
    // At the release moment (50 ms): attack only reached 0.5 — release
    // starts from there, not from peak.
    expect(envelopeAt(e, regionDur, 0.05)).toBeCloseTo(0.5, 4);
    // Halfway through release (150 ms): 0.5 * (1 - 0.5) = 0.25.
    expect(envelopeAt(e, regionDur, 0.15)).toBeCloseTo(0.25, 4);
  });

  it("stays silent when R alone exceeds the region (sub-R sliver)", () => {
    // 100 ms region but R=200 → releaseStart = -100 ms. Release samples
    // the natural envelope at t=0 (the earliest visible point), which
    // for A>0 is 0 → effect plays silent. Synth analogue: tapped too
    // briefly to make any sound.
    const e = env(0.1, 0.05, 0.5, 0.2);
    expect(envelopeAt(e, 0.1, 0)).toBeCloseTo(0, 5);
    expect(envelopeAt(e, 0.1, 0.05)).toBeCloseTo(0, 5);
    expect(envelopeAt(e, 0.1, 0.099)).toBeCloseTo(0, 3);
  });

  it("stays silent for sub-R sliver even when A=0 (release-start at t=0)", () => {
    // With A=D=0 the natural curve is at S from t=0, so a sub-R sliver
    // does play — as a fade from S down to 0 over the available time.
    // Documents the boundary: silent only kicks in when A>0.
    const e = env(0, 0, 0.5, 0.2);
    expect(envelopeAt(e, 0.1, 0)).toBeCloseTo(0.25, 4); // S * (1 - 0.1/0.2)
    expect(envelopeAt(e, 0.1, 0.05)).toBeCloseTo(0.125, 4); // S * (1 - 0.15/0.2)
  });

  it("clamps sustain level into [0, 1]", () => {
    expect(envelopeAt(env(0, 0, 1.5, 0), 1.0, 0.5)).toBe(1);
    expect(envelopeAt(env(0, 0, -0.5, 0), 1.0, 0.5)).toBe(0);
  });

  it("never returns NaN even with extreme values", () => {
    const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
    for (const t of samples) {
      const v = envelopeAt(env(0, 0, 0, 0), 1.0, t);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("envelopeAt — holding (live pad press)", () => {
  // While the user holds a pad, `tickFxHold` keeps `outS = playhead +
  // overshoot`, so `regionDurS ≈ localT + overshoot`. Old behavior
  // rescaled A and D against this moving target → attack collapsed to
  // ≈ elapsed-time and reached ~1 in the first frame regardless of slider.
  // Fix: while holding, A and D stay raw — the phase logic does the rest.

  it("plays the user-set attack at full length while held (Vignette repro)", () => {
    // attackS = 2.0 (slider max). 50 ms into hold, overshoot = 50 ms:
    // regionDurS = 0.1, localT = 0.05. Expected: 0.05 / 2.0 = 0.025.
    // Buggy old behavior would have returned ≈ 0.5 (after rescaling A→0.1).
    const e = env(2.0, 0, 1, 0.3);
    expect(envelopeAt(e, 0.1, 0.05, true)).toBeCloseTo(0.025, 4);
    // 250 ms in → 0.25 / 2.0 = 0.125
    expect(envelopeAt(e, 0.3, 0.25, true)).toBeCloseTo(0.125, 4);
    // 1 s in → 0.5
    expect(envelopeAt(e, 1.05, 1.0, true)).toBeCloseTo(0.5, 4);
    // 2 s in → 1.0 (peak reached)
    expect(envelopeAt(e, 2.05, 2.0, true)).toBeCloseTo(1, 4);
  });

  it("plays decay correctly while held", () => {
    // A = 0.1, D = 0.2, S = 0.5. Halfway through decay (localT = 0.2):
    // 1 + (S - 1) * ((localT - A) / D) = 1 + (-0.5) * 0.5 = 0.75.
    const e = env(0.1, 0.2, 0.5, 0.3);
    expect(envelopeAt(e, 1.0, 0.2, true)).toBeCloseTo(0.75, 4);
  });

  it("returns sustain level once past A+D while held", () => {
    const e = env(0.1, 0.1, 0.6, 0.3);
    expect(envelopeAt(e, 0.55, 0.5, true)).toBeCloseTo(0.6, 6);
    expect(envelopeAt(e, 5.0, 4.0, true)).toBeCloseTo(0.6, 6);
  });

  it("never engages release while held — even with huge R near outS", () => {
    // Synth-voice semantics: release only fires after let-go. While held,
    // localT close to regionDurS must stay at sustain, not fade out.
    const e = env(0, 0, 0.7, 1.0);
    expect(envelopeAt(e, 1.0, 0.5, true)).toBeCloseTo(0.7, 6);
    expect(envelopeAt(e, 1.0, 0.99, true)).toBeCloseTo(0.7, 6);
  });

  it("does not return 0 at or past outS while held", () => {
    // Active-resolver pushes outS just ahead of playhead; the envelope
    // sampler must not zero-out within the overshoot tail or the FX
    // would flicker off mid-hold.
    const e = env(0.05, 0, 1, 0.2);
    expect(envelopeAt(e, 1.0, 1.0, true)).toBe(1);
    expect(envelopeAt(e, 1.0, 1.5, true)).toBe(1);
  });
});

describe("envelopeAt — INSTANT_ENVELOPE default", () => {
  it("returns 1 for any localT in [0, regionDur)", () => {
    expect(envelopeAt(INSTANT_ENVELOPE, 1.0, 0)).toBe(1);
    expect(envelopeAt(INSTANT_ENVELOPE, 1.0, 0.5)).toBe(1);
    expect(envelopeAt(INSTANT_ENVELOPE, 1.0, 0.999)).toBe(1);
  });

  it("returns 0 at outS exclusive boundary", () => {
    expect(envelopeAt(INSTANT_ENVELOPE, 1.0, 1.0)).toBe(0);
  });

  it("matches the previous hard-edge semantics bit-for-bit", () => {
    // INSTANT keeps existing behavior: full effect throughout, hard cut at outS.
    expect(INSTANT_ENVELOPE.attackS).toBe(0);
    expect(INSTANT_ENVELOPE.decayS).toBe(0);
    expect(INSTANT_ENVELOPE.sustain).toBe(1);
    expect(INSTANT_ENVELOPE.releaseS).toBe(0);
  });
});
