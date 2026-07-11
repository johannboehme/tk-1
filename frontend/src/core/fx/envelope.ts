/**
 * ADSR-Hüllkurve pro P-FX-Region. Wird im Render-Backend nach dem FX-Pass
 * als Wet/Dry-Crossfade angewendet (output = source*(1-e) + effected*e), so
 * dass die Hard-Edges an `inS`/`outS` weich werden, ohne dass jeder Effekt-
 * Kind eigene "off"-Definition kennt.
 *
 * Synth-Voice-Semantik: A, D, R bleiben unverändert wie der User sie
 * gesetzt hat — keine Stauchung auf die Region. Tippt der User kürzer
 * als A, friert die Attack mid-ramp ein und Release fadet vom erreichten
 * Pegel (nicht vom Peak) auf 0. Wenn R länger ist als die Region, beginnt
 * das Release effektiv vor t=0 → Effekt bleibt stumm (echter Synth: zu
 * kurz angespielt zum Hören).
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
 *  Phasen (zeitlich aufeinanderfolgend, A/D/R = User-Werte, ungestaucht):
 *    [0, A)                       Attack:   linear 0 → 1
 *    [A, A+D)                     Decay:    linear 1 → S
 *    [A+D, regionDurS - R)        Sustain:  konstant S
 *    [regionDurS - R, regionDurS) Release:  linear releaseAmp → 0
 *    >= regionDurS                Out:      0
 *
 *  `releaseAmp` ist die natürliche Hüllkurven-Amplitude am Moment des
 *  Release-Beginns (`regionDurS - R`). Tippt der User kürzer als A,
 *  bricht die Attack mid-ramp ab und Release fadet von dem Teilpegel —
 *  exakt wie eine Synth-Voice. Sub-R-Sliver (regionDurS < R, üblicherweise
 *  nur durch manuelles Trimmen) lässt releaseStart < 0 werden und die
 *  Hüllkurve sampled am Punkt 0 → 0 → Effekt stumm.
 *
 *  `holding`: solange der User den Pad/Key hält, läuft nur die natürliche
 *  Kurve (Attack→Decay→Sustain), Release engagiert nicht. Wichtig, weil
 *  während des Haltens `outS` ein paar ms vor den Playhead geschoben wird
 *  (siehe store.tickFxHold) — sonst säßen wir permanent im Release-Window.
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

  const A = env.attackS;
  const D = env.decayS;
  const R = env.releaseS;
  const S = clamp01(env.sustain);

  // Natürliche Hüllkurven-Amplitude bei lokaler Zeit `t` — ohne Release.
  // Hierfür werden A und D NICHT auf die Region gestaucht; eine kurz
  // angespielte Note bricht ihre Attack mid-ramp ab.
  const ampAt = (t: number): number => {
    if (t < A) return A > 0 ? t / A : 1;
    if (t < A + D) return D > 0 ? 1 + (S - 1) * ((t - A) / D) : S;
    return S;
  };

  if (holding) return ampAt(localT);

  const releaseStart = regionDurS - R;
  if (localT < releaseStart) return ampAt(localT);
  if (R <= 0) return 0;
  const releaseAmp = ampAt(Math.max(0, releaseStart));
  return releaseAmp * (1 - (localT - releaseStart) / R);
}
