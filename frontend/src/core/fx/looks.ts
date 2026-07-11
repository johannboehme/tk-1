/**
 * Color-grade engine — the corrective/creative grade applied to the whole
 * video, UNDER the opinionated filters and the punch-in accents.
 *
 * Pure (no DOM, no GPU): a fixed vector of low-level color params
 * (`GradeParams`) the shared grade shader (WebGL2 / WebGPU / Canvas2D)
 * consumes. Every param is a no-op at its default, so the grade only "costs"
 * the params the user actually moves. The Color-grade UI surfaces these
 * directly (Exposure / Contrast / Black / Fade · Saturation / Temperature /
 * Tint · Shadows-lift / Midtones-gamma / Highlights-gain) — there is exactly
 * ONE grade per project (`colorGrade` on the store), not a stack of looks.
 *
 * `gradeColor` is the canonical CPU port of the same pipeline, used by the
 * Canvas2D backend and as the GPU-parity reference. The recognizable LOOKS
 * (VHS, Super-8, Sepia, …) are separate per-kind filters (see ./catalog),
 * NOT presets of this engine.
 */

/** The low-level grade vector. Param order here is the canonical order the
 *  shader uniforms + WebGPU struct fields follow. */
export interface GradeParams {
  /** Linear brightness lift before tone. */
  exposure: number;
  /** S-curve contrast about mid-grey. */
  contrast: number;
  /** Luma-weighted chroma. 1 = unchanged, 0 = grayscale. */
  saturation: number;
  /** Saturation that protects already-saturated pixels + skin (the pop). */
  vibrance: number;
  /** Warm/cool (R up, B down). */
  temp: number;
  /** Green/magenta, orthogonal to temp. */
  tint: number;
  /** Push warm(-)/cool(+) colour into the shadows. */
  shadowTone: number;
  /** Push colour into the highlights; pairs with shadowTone. */
  highlightTone: number;
  /** One-knob teal-shadows + amber-highlights cinematic split. */
  splitWarm: number;
  /** Crush(-) / float(+) the lower toe before fade. */
  blackPoint: number;
  /** Lift blacks toward a tinted matte floor (the washed-film gestalt). */
  fade: number;
  /** Midtone bend without touching the ends. */
  gamma: number;
  /** Baked radial corner darken (avoids spending a punch-in slot). */
  vignette: number;
  /** Animated luma-hash grain, frame-coherent. */
  grain: number;
  /** Warm highlight bloom/glow for super-8 + faded-print. */
  halation: number;
  /** Master dry/wet — mix(source, graded, strength). Also the BLEND. */
  strength: number;
  /** Lift the shadows toward grey (luminance, shadow-masked) — the
   *  "Shadows" wheel of a lift/gamma/gain grade. */
  shadowsLift: number;
  /** Gain the highlights (luminance, highlight-masked) — the "Highlights"
   *  wheel of a lift/gamma/gain grade. */
  highlightsGain: number;
}

/** Canonical param order — drives shader uniform iteration + WGSL struct
 *  field order. Keep in sync with grade.frag.ts / grade.wgsl.ts. */
export const GRADE_PARAM_KEYS = [
  "exposure",
  "contrast",
  "saturation",
  "vibrance",
  "temp",
  "tint",
  "shadowTone",
  "highlightTone",
  "splitWarm",
  "blackPoint",
  "fade",
  "gamma",
  "vignette",
  "grain",
  "halation",
  "strength",
  "shadowsLift",
  "highlightsGain",
] as const satisfies readonly (keyof GradeParams)[];

/** Storage range per param. Used to validate look recipes + clamp merges. */
export const GRADE_PARAM_RANGES: Record<keyof GradeParams, readonly [number, number]> = {
  exposure: [-1, 1],
  contrast: [-1, 1],
  saturation: [0, 2],
  vibrance: [-1, 1],
  temp: [-1, 1],
  tint: [-1, 1],
  shadowTone: [-1, 1],
  highlightTone: [-1, 1],
  splitWarm: [0, 1],
  blackPoint: [-0.2, 0.2],
  fade: [0, 1],
  gamma: [-1, 1],
  vignette: [0, 1],
  grain: [0, 1],
  halation: [0, 1],
  strength: [0, 1],
  shadowsLift: [-1, 1],
  highlightsGain: [-1, 1],
};

/** Identity grade — every param a no-op (strength=1 = full wet of a no-op,
 *  which is still identity). */
export const ENGINE_DEFAULTS: GradeParams = {
  exposure: 0,
  contrast: 0,
  saturation: 1,
  vibrance: 0,
  temp: 0,
  tint: 0,
  shadowTone: 0,
  highlightTone: 0,
  splitWarm: 0,
  blackPoint: 0,
  fade: 0,
  gamma: 0,
  vignette: 0,
  grain: 0,
  halation: 0,
  strength: 1,
  shadowsLift: 0,
  highlightsGain: 0,
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Canonical CPU port of the grade pixel pipeline — the same operations, in
 * the same order, with the same constants as grade.frag.ts / grade.wgsl.ts
 * (grain excluded; it needs per-frame hashing the CPU path skips). Powers
 * the Canvas2D backend (live fallback + offline export) so the look survives
 * to the rendered file, and serves as the unit-testable reference the GPU
 * shaders are kept in parity with.
 *
 * Input + output channels are 0..1. `d` is the normalised corner distance
 * (0 = centre, 1 = corner) for the vignette term. Returns the GRADED colour
 * BEFORE the strength mix — callers blend `mix(source, graded, strength)`.
 */
export function gradeColor(
  r: number,
  g: number,
  b: number,
  p: GradeParams,
  d: number,
): [number, number, number] {
  let cr = r;
  let cg = g;
  let cb = b;
  // exposure
  const ex = Math.pow(2, p.exposure);
  cr *= ex; cg *= ex; cb *= ex;
  // matte floor (fade + blackPoint)
  const floorLift = p.fade * 0.18 + Math.max(p.blackPoint, 0) * 0.5;
  cr = cr * (1 - floorLift) + floorLift;
  cg = cg * (1 - floorLift) + floorLift;
  cb = cb * (1 - floorLift) + floorLift;
  const crush = Math.max(-p.blackPoint, 0) * 0.3;
  cr -= crush; cg -= crush; cb -= crush;
  // shadows lift (luminance, shadow-masked) — lift-before-curve
  const lLift = cr * 0.299 + cg * 0.587 + cb * 0.114;
  const sWl = 1 - smoothstep(0, 0.5, lLift);
  const lift = p.shadowsLift * 0.15 * sWl;
  cr += lift; cg += lift; cb += lift;
  // contrast
  cr = (cr - 0.5) * (1 + p.contrast) + 0.5;
  cg = (cg - 0.5) * (1 + p.contrast) + 0.5;
  cb = (cb - 0.5) * (1 + p.contrast) + 0.5;
  // gamma
  const ginv = 1 / (1 + p.gamma * 0.6);
  cr = Math.pow(Math.max(cr, 0), ginv);
  cg = Math.pow(Math.max(cg, 0), ginv);
  cb = Math.pow(Math.max(cb, 0), ginv);
  // temp / tint
  cr += p.temp * 0.1; cb -= p.temp * 0.1;
  cr += p.tint * 0.05; cb += p.tint * 0.05; cg -= p.tint * 0.05;
  // split tone
  const l = cr * 0.299 + cg * 0.587 + cb * 0.114;
  const sW = 1 - smoothstep(0, 0.5, l);
  const hW = smoothstep(0.5, 1, l);
  cr -= p.shadowTone * 0.1 * sW; cb += p.shadowTone * 0.1 * sW;
  cr += p.highlightTone * 0.1 * hW; cb -= p.highlightTone * 0.1 * hW;
  cr -= p.splitWarm * 0.08 * sW; cb += p.splitWarm * 0.1 * sW;
  cr += p.splitWarm * 0.1 * hW; cb -= p.splitWarm * 0.08 * hW;
  // highlights gain (luminance, highlight-masked)
  const gain = 1 + p.highlightsGain * 0.25 * hW;
  cr *= gain; cg *= gain; cb *= gain;
  // saturation + vibrance
  const l2 = cr * 0.299 + cg * 0.587 + cb * 0.114;
  cr = l2 + (cr - l2) * p.saturation;
  cg = l2 + (cg - l2) * p.saturation;
  cb = l2 + (cb - l2) * p.saturation;
  const mx = Math.max(cr, cg, cb);
  const mn = Math.min(cr, cg, cb);
  const vs = 1 + p.vibrance * (1 - (mx - mn));
  cr = l2 + (cr - l2) * vs;
  cg = l2 + (cg - l2) * vs;
  cb = l2 + (cb - l2) * vs;
  // vignette
  const vatt = 1 - p.vignette * smoothstep(0.5, 1, d);
  cr *= vatt; cg *= vatt; cb *= vatt;
  // halation (warm highlight glow)
  const hl = Math.max(l2 - 0.6, 0) * 2.5;
  cr += p.halation * hl * 0.3; cg += p.halation * hl * 0.12; cb += p.halation * hl * 0.04;
  return [clamp(cr, 0, 1), clamp(cg, 0, 1), clamp(cb, 0, 1)];
}

/** A fresh, neutral color grade (the identity vector). */
export function defaultColorGrade(): GradeParams {
  return { ...ENGINE_DEFAULTS };
}

/** True when a grade vector is the identity (every param at its default) —
 *  lets the descriptor builder skip emitting a no-op grade pass. */
export function gradeIsIdentity(p: GradeParams): boolean {
  for (const k of GRADE_PARAM_KEYS) {
    if (p[k] !== ENGINE_DEFAULTS[k]) return false;
  }
  return true;
}
