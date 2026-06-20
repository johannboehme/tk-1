import { describe, expect, it } from "vitest";
import {
  ENGINE_DEFAULTS,
  GRADE_LOOK_IDS,
  GRADE_LOOKS,
  GRADE_PARAM_KEYS,
  GRADE_PARAM_RANGES,
  defaultGradeSlot,
  gradeColor,
  mergeGradeParams,
  type GradeLookId,
  type GradeParams,
} from "./looks";

describe("grade engine — param model", () => {
  it("ENGINE_DEFAULTS is the identity grade (strength aside)", () => {
    expect(ENGINE_DEFAULTS.exposure).toBe(0);
    expect(ENGINE_DEFAULTS.contrast).toBe(0);
    expect(ENGINE_DEFAULTS.saturation).toBe(1);
    expect(ENGINE_DEFAULTS.temp).toBe(0);
    expect(ENGINE_DEFAULTS.fade).toBe(0);
    expect(ENGINE_DEFAULTS.strength).toBe(1);
  });

  it("every param key has a range and a default within it", () => {
    for (const key of GRADE_PARAM_KEYS) {
      const range = GRADE_PARAM_RANGES[key];
      expect(range, `range for ${key}`).toBeDefined();
      const def = ENGINE_DEFAULTS[key];
      expect(def, `default for ${key}`).toBeGreaterThanOrEqual(range[0]);
      expect(def, `default for ${key}`).toBeLessThanOrEqual(range[1]);
    }
  });
});

describe("grade engine — look catalog", () => {
  it("RAW is the first look and is identity (empty recipe)", () => {
    expect(GRADE_LOOK_IDS[0]).toBe("raw");
    expect(Object.keys(GRADE_LOOKS.raw.params)).toHaveLength(0);
  });

  it("ships the agreed TE-named looks", () => {
    const expected: GradeLookId[] = [
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
    ];
    expect(GRADE_LOOK_IDS).toEqual(expected);
  });

  it("every look has a label, a swatch colour, and an entry in GRADE_LOOKS", () => {
    for (const id of GRADE_LOOK_IDS) {
      const look = GRADE_LOOKS[id];
      expect(look, id).toBeDefined();
      expect(look.id).toBe(id);
      expect(look.label.length).toBeGreaterThan(0);
      expect(look.swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("every look recipe stays within engine ranges", () => {
    for (const id of GRADE_LOOK_IDS) {
      const recipe = GRADE_LOOKS[id].params;
      for (const [key, value] of Object.entries(recipe)) {
        const range = GRADE_PARAM_RANGES[key as keyof GradeParams];
        expect(range, `${id}.${key} has a range`).toBeDefined();
        expect(value, `${id}.${key} >= min`).toBeGreaterThanOrEqual(range[0]);
        expect(value, `${id}.${key} <= max`).toBeLessThanOrEqual(range[1]);
      }
    }
  });
});

describe("mergeGradeParams", () => {
  const slot = defaultGradeSlot("s1");

  it("returns a complete vector — every engine key present, no undefined", () => {
    const p = mergeGradeParams({ ...slot, lookId: "ember" });
    for (const key of GRADE_PARAM_KEYS) {
      expect(p[key], key).toBeTypeOf("number");
      expect(Number.isFinite(p[key]), key).toBe(true);
    }
  });

  it("RAW look with neutral macros is the identity vector (strength aside)", () => {
    const p = mergeGradeParams({ ...slot, lookId: "raw", strength: 0.5 });
    for (const key of GRADE_PARAM_KEYS) {
      if (key === "strength") continue;
      expect(p[key], key).toBe(ENGINE_DEFAULTS[key]);
    }
    expect(p.strength).toBe(0.5);
  });

  it("applies a look recipe on top of defaults", () => {
    const p = mergeGradeParams({ ...slot, lookId: "ember", warmth: 0, punch: 0, fade: 0, grain: 0 });
    // EMBER pushes warmth (temp) and saturation up vs identity.
    expect(p.temp).toBeGreaterThan(0);
    expect(p.vibrance).toBeGreaterThan(0);
  });

  it("WARMTH macro pushes temperature up, PUNCH pushes contrast + vibrance", () => {
    const base = mergeGradeParams({ ...slot, lookId: "raw" });
    const warm = mergeGradeParams({ ...slot, lookId: "raw", warmth: 1 });
    const punched = mergeGradeParams({ ...slot, lookId: "raw", punch: 1 });
    expect(warm.temp).toBeGreaterThan(base.temp);
    expect(punched.contrast).toBeGreaterThan(base.contrast);
    expect(punched.vibrance).toBeGreaterThan(base.vibrance);
  });

  it("FADE macro lifts fade, GRAIN macro lifts grain", () => {
    const base = mergeGradeParams({ ...slot, lookId: "raw" });
    const faded = mergeGradeParams({ ...slot, lookId: "raw", fade: 1 });
    const grainy = mergeGradeParams({ ...slot, lookId: "raw", grain: 1 });
    expect(faded.fade).toBeGreaterThan(base.fade);
    expect(grainy.grain).toBeGreaterThan(base.grain);
  });

  it("clamps every output param into its engine range", () => {
    // Stack a hot look with maxed macros — nothing may exceed its range.
    const p = mergeGradeParams({
      id: "s1",
      lookId: "volt",
      strength: 5,
      warmth: 9,
      fade: 9,
      punch: 9,
      grain: 9,
    });
    for (const key of GRADE_PARAM_KEYS) {
      const range = GRADE_PARAM_RANGES[key];
      expect(p[key], `${key} >= min`).toBeGreaterThanOrEqual(range[0]);
      expect(p[key], `${key} <= max`).toBeLessThanOrEqual(range[1]);
    }
    expect(p.strength).toBe(1); // clamped from 5
  });

  it("defaultGradeSlot is a neutral, ready-to-tweak slot", () => {
    const s = defaultGradeSlot("abc");
    expect(s.id).toBe("abc");
    expect(GRADE_LOOK_IDS).toContain(s.lookId);
    expect(s.strength).toBeGreaterThan(0);
    expect(s.warmth).toBe(0);
    expect(s.fade).toBe(0);
    expect(s.punch).toBe(0);
    expect(s.grain).toBe(0);
  });
});

describe("gradeColor — canonical CPU reference (mirrors the shaders)", () => {
  it("is the identity at engine defaults (centre pixel)", () => {
    const [r, g, b] = gradeColor(0.4, 0.6, 0.2, ENGINE_DEFAULTS, 0);
    expect(r).toBeCloseTo(0.4, 5);
    expect(g).toBeCloseTo(0.6, 5);
    expect(b).toBeCloseTo(0.2, 5);
  });

  it("exposure brightens, saturation=0 collapses to grey", () => {
    const [r] = gradeColor(0.4, 0.4, 0.4, { ...ENGINE_DEFAULTS, exposure: 1 }, 0);
    expect(r).toBeGreaterThan(0.4); // *2 then clamp

    const grey = gradeColor(0.8, 0.2, 0.1, { ...ENGINE_DEFAULTS, saturation: 0 }, 0);
    expect(grey[0]).toBeCloseTo(grey[1], 5);
    expect(grey[1]).toBeCloseTo(grey[2], 5);
  });

  it("warm temp lifts red over blue", () => {
    const [r, , b] = gradeColor(0.5, 0.5, 0.5, { ...ENGINE_DEFAULTS, temp: 1 }, 0);
    expect(r).toBeGreaterThan(b);
  });

  it("vignette darkens the corner (d=1) but not the centre (d=0)", () => {
    const p = { ...ENGINE_DEFAULTS, vignette: 1 };
    const centre = gradeColor(0.7, 0.7, 0.7, p, 0);
    const corner = gradeColor(0.7, 0.7, 0.7, p, 1);
    expect(corner[0]).toBeLessThan(centre[0]);
    expect(centre[0]).toBeCloseTo(0.7, 5);
  });

  it("output is clamped to [0,1]", () => {
    const [r, g, b] = gradeColor(1, 1, 1, { ...ENGINE_DEFAULTS, exposure: 1, contrast: 1 }, 0);
    for (const v of [r, g, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
