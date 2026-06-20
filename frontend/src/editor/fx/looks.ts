/**
 * Global color-grade engine — the "film stock" layer that sits UNDER the
 * punch-in accents and grades the whole video.
 *
 * Two halves live here, both pure (no DOM, no GPU):
 *   1. The ENGINE — a fixed vector of low-level color params (`GradeParams`)
 *      that the shared grade shader (WebGL2 / WebGPU / Canvas2D) consumes.
 *      Every param is a no-op at its default, so a look only "costs" the
 *      params it actually sets.
 *   2. The LOOK CATALOG — Instagram-inspired looks expressed as a sparse
 *      recipe (`Partial<GradeParams>`) on top of the engine, named in the
 *      app's own TE vocabulary (CLEAR / FROST / EMBER / …), each carrying a
 *      swatch colour for its UI chip.
 *
 * A `GradeSlot` (one stacked filter in the Overlays panel) carries a look +
 * a master STRENGTH (the BLEND) + four macro nudges (WARMTH / FADE / PUNCH /
 * GRAIN). `mergeGradeParams` folds slot → flat `GradeParams` vector, which
 * the descriptor builder hands to the shader as `FrameFx.params`.
 *
 * The shader computes the full graded colour G, then outputs
 * `mix(source, G, strength)` — so strength=0 is a literal identity pass and
 * stacking two slots = two serial passes (never an averaged param vector,
 * which would give mud).
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
};

export type GradeLookId =
  | "raw"
  | "clear"
  | "frost"
  | "ember"
  | "haze"
  | "blush"
  | "dusk"
  | "volt"
  | "mono"
  | "gold"
  | "super8";

export interface GradeLook {
  id: GradeLookId;
  /** UI display name (TE-native, not the Instagram brand). */
  label: string;
  /** Chip colour for the look's card swatch. */
  swatch: string;
  /** One-line character note (UI subtitle / tooltip). */
  blurb: string;
  /** Sparse recipe — only the params this look bends off identity. */
  params: Partial<GradeParams>;
}

/** Ordered look list — RAW first (the in-card bypass), then the catalog.
 *  Drives the look `<select>` order in the Overlays panel. */
export const GRADE_LOOK_IDS = [
  "raw",
  "clear",
  "frost",
  "ember",
  "haze",
  "blush",
  "dusk",
  "volt",
  "mono",
  "gold",
  "super8",
] as const satisfies readonly GradeLookId[];

export const GRADE_LOOKS: Record<GradeLookId, GradeLook> = {
  raw: {
    id: "raw",
    label: "RAW",
    swatch: "#6b6b6b",
    blurb: "no filter — straight through",
    params: {},
  },
  clear: {
    id: "clear",
    label: "CLEAR",
    swatch: "#c8ccd0",
    blurb: "neutral pop, no cast",
    params: { contrast: 0.15, vibrance: 0.25, saturation: 1.05, exposure: 0.04 },
  },
  frost: {
    id: "frost",
    label: "FROST",
    swatch: "#7fb3c8",
    blurb: "cool, crisp, high-key",
    params: {
      contrast: 0.35,
      temp: -0.22,
      saturation: 1.18,
      vibrance: 0.3,
      shadowTone: 0.3,
      highlightTone: -0.1,
      blackPoint: 0.05,
    },
  },
  ember: {
    id: "ember",
    label: "EMBER",
    swatch: "#d9603f",
    blurb: "warm and punchy",
    params: {
      temp: 0.35,
      vibrance: 0.45,
      saturation: 1.1,
      contrast: 0.3,
      highlightTone: 0.12,
      vignette: 0.18,
    },
  },
  haze: {
    id: "haze",
    label: "HAZE",
    swatch: "#c9c4bb",
    blurb: "washed, milky, dreamy",
    params: {
      contrast: -0.3,
      fade: 0.35,
      blackPoint: 0.18,
      saturation: 0.82,
      temp: -0.06,
      tint: 0.06,
      gamma: -0.12,
    },
  },
  blush: {
    id: "blush",
    label: "BLUSH",
    swatch: "#d8a0a8",
    blurb: "pastel rose, soft",
    params: {
      saturation: 0.8,
      vibrance: 0.2,
      temp: 0.1,
      tint: 0.22,
      fade: 0.18,
      contrast: -0.12,
      highlightTone: 0.18,
    },
  },
  dusk: {
    id: "dusk",
    label: "DUSK",
    swatch: "#c79a6a",
    blurb: "sun-bleached vintage",
    params: {
      temp: 0.28,
      tint: 0.18,
      saturation: 0.85,
      contrast: -0.12,
      fade: 0.3,
      blackPoint: 0.05,
      highlightTone: 0.1,
      shadowTone: -0.08,
    },
  },
  volt: {
    id: "volt",
    label: "VOLT",
    swatch: "#2a2a30",
    blurb: "dark, saturated, loud",
    params: {
      contrast: 0.55,
      saturation: 1.45,
      vibrance: 0.15,
      gamma: 0.18,
      temp: 0.08,
      vignette: 0.45,
    },
  },
  mono: {
    id: "mono",
    label: "MONO",
    swatch: "#d2d6da",
    blurb: "cool black & white",
    params: {
      saturation: 0,
      contrast: 0.3,
      exposure: 0.1,
      temp: -0.1,
      shadowTone: 0.18,
      blackPoint: 0.05,
      grain: 0.06,
    },
  },
  gold: {
    id: "gold",
    label: "GOLD",
    swatch: "#c79434",
    blurb: "golden cross-process",
    params: {
      temp: 0.22,
      tint: 0.12,
      contrast: 0.45,
      saturation: 1.15,
      highlightTone: 0.2,
      shadowTone: -0.15,
      splitWarm: 0.3,
      vignette: 0.55,
    },
  },
  super8: {
    id: "super8",
    label: "SUPER-8",
    swatch: "#b5793f",
    blurb: "home-movie film, grainy",
    params: {
      temp: 0.3,
      tint: 0.1,
      saturation: 0.95,
      contrast: 0.15,
      fade: 0.22,
      blackPoint: -0.04,
      splitWarm: 0.22,
      grain: 0.55,
      halation: 0.4,
      vignette: 0.3,
    },
  },
};

/**
 * One stacked global filter in the Overlays panel. A look + a master
 * strength (BLEND) + four macro nudges. `id` is stable for React keys and
 * becomes the grade FrameFx id.
 */
export interface GradeSlot {
  id: string;
  lookId: GradeLookId;
  /** Master dry/wet 0..1 (the BLEND / Amount slider). */
  strength: number;
  /** Macro nudges, each -1..1, 0 = look as authored. */
  warmth: number;
  fade: number;
  punch: number;
  grain: number;
}

/** A fresh slot the user can immediately tweak — a subtle visible look at
 *  full blend, macros neutral. */
export function defaultGradeSlot(id: string): GradeSlot {
  return { id, lookId: "clear", strength: 1, warmth: 0, fade: 0, punch: 0, grain: 0 };
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** How far each macro pushes its target engine param(s) at full deflection. */
const MACRO_GAIN = {
  warmth_temp: 0.5,
  fade_fade: 0.4,
  fade_black: 0.1,
  punch_contrast: 0.4,
  punch_vibrance: 0.5,
  grain_grain: 0.5,
} as const;

/**
 * Fold a slot into the flat engine vector the shader draws with:
 * defaults → look recipe → macro offsets → clamp, with strength carried
 * through as the master dry/wet. Pure + total: always returns every key.
 */
export function mergeGradeParams(slot: GradeSlot): GradeParams {
  const recipe = GRADE_LOOKS[slot.lookId]?.params ?? {};
  const p: GradeParams = { ...ENGINE_DEFAULTS, ...recipe };

  p.temp += slot.warmth * MACRO_GAIN.warmth_temp;
  p.fade += slot.fade * MACRO_GAIN.fade_fade;
  p.blackPoint += slot.fade * MACRO_GAIN.fade_black;
  p.contrast += slot.punch * MACRO_GAIN.punch_contrast;
  p.vibrance += slot.punch * MACRO_GAIN.punch_vibrance;
  p.grain += slot.grain * MACRO_GAIN.grain_grain;
  p.strength = slot.strength;

  // Clamp the full vector back into engine ranges so a maxed macro on a
  // hot look can never push a uniform out of bounds.
  for (const key of GRADE_PARAM_KEYS) {
    const [lo, hi] = GRADE_PARAM_RANGES[key];
    p[key] = clamp(p[key], lo, hi);
  }
  return p;
}

/** True when a slot would visibly change the frame — used by the descriptor
 *  builder to skip emitting a no-op grade pass. */
export function gradeSlotIsActive(slot: GradeSlot): boolean {
  return slot.lookId !== "raw" && slot.strength > 0;
}

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
