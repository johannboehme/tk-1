/**
 * ADSR-Hüllkurve pro P-FX-Region. Wird im Render-Backend nach dem FX-Pass
 * als Wet/Dry-Crossfade angewendet (output = source*(1-e) + effected*e), so
 * dass die Hard-Edges an `inS`/`outS` weich werden, ohne dass jeder Effekt-
 * Kind eigene "off"-Definition kennt.
 *
 * Zeit-Encoding ist absolut (Sekunden). Wenn A+D+R die Region-Dauer
 * übersteigt, ist Release der "protected slot" — R bleibt wie gesetzt,
 * Attack+Decay werden auf den verbleibenden Raum (regionDurS - R)
 * proportional komprimiert (Sustain-Länge wird dann 0). Nur wenn R allein
 * die Region übersteigt, wird R selbst auf regionDurS geklemmt und A/D
 * auf 0 gesetzt. Beim Halten (holding=true) findet keine Fit-Skalierung
 * statt — A/D bleiben raw und Release wird nicht gesampled.
 */

export interface ADSREnvelope {
  /** Attack in seconds (0..2.0). Region peakt am Ende der Attack-Phase. */
  attackS: number;
  /** Decay in seconds (0..2.0). Fall von 1 auf Sustain-Level. */
  decayS: number;
  /** Sustain LEVEL, 0..1 (NICHT Dauer — Sustain hält bis Release-Start). */
  sustain: number;
  /** Release in seconds (0..3.0). Fall von Sustain-Level auf 0 bis outS. */
  releaseS: number;
}

/** Bit-Parity-Default: voller Effekt sofort an, harter Cut bei outS.
 *  Wird für PunchFx ohne `envelope`-Feld gelesen → Bestandsprojekte
 *  rendern bit-identisch zu vor V1. */
export const INSTANT_ENVELOPE: ADSREnvelope = Object.freeze({
  attackS: 0,
  decayS: 0,
  sustain: 1,
  releaseS: 0,
});

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Sampled die Hüllkurve bei lokaler Zeit `localT` (relativ zur Region-
 * Start `inS`). Returns ∈ [0, 1].
 *
 *  Phasen (zeitlich aufeinanderfolgend):
 *    [0, A)               Attack:   linear 0 → 1
 *    [A, A+D)             Decay:    linear 1 → S
 *    [A+D, regionDur-R)   Sustain:  konstant S
 *    [regionDur-R, regionDur)  Release: linear S → 0
 *    >= regionDur         Out:      0
 *
 *  `holding`: while the user is still holding the pad/key for this fx,
 *  the release phase MUST NOT engage — the effect should hold at sustain
 *  level until they let go, like a synth voice. While held, `outS` is
 *  the live-extended end-of-region (overshoots the playhead by a few ms)
 *  which would otherwise put us inside the release window the entire
 *  time and the effect would never settle into sustain.
 */
export function envelopeAt(
  env: ADSREnvelope,
  regionDurS: number,
  localT: number,
  holding = false,
): number {
  if (regionDurS <= 0) return 0;
  if (localT < 0) return 0;
  if (!holding && localT >= regionDurS) return 0;

  let A = env.attackS;
  let D = env.decayS;
  let R = env.releaseS;
  const S = clamp01(env.sustain);

  // Fit-to-region. Release is the protected slot — the user has just
  // let go and explicitly asked for a fade-out, so R stays R as much as
  // possible. Attack + Decay get compressed to fit the remaining space.
  // Only when even R alone exceeds the region (a sub-R sliver) do we
  // clamp R itself and zero out A/D.
  //
  // Only applies when NOT holding: while the pad is still down,
  // `regionDurS` tracks `localT + overshoot` (live-extended end-of-region,
  // see store.tickFxHold), so any rescaling here would dynamically squeeze
  // A onto the elapsed time and the attack would always reach ~1 within
  // the first frame, regardless of slider. Synth-voice semantics: while
  // held, A and D stay raw; the phase logic below handles the rest
  // (release is short-circuited out by the `if (holding) return S` at
  // the sustain check).
  if (!holding) {
    if (R >= regionDurS) {
      R = regionDurS;
      A = 0;
      D = 0;
    } else {
      const adSpace = regionDurS - R;
      const adSum = A + D;
      if (adSum > adSpace && adSum > 0) {
        const k = adSpace / adSum;
        A *= k;
        D *= k;
      }
    }
  }

  if (localT < A) return A > 0 ? localT / A : 1;
  if (localT < A + D) return D > 0 ? 1 + (S - 1) * ((localT - A) / D) : S;
  if (holding) return S;
  const releaseStart = regionDurS - R;
  if (localT < releaseStart) return S;
  return R > 0 ? S * (1 - (localT - releaseStart) / R) : 0;
}
