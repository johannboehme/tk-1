import { describe, expect, it } from "vitest";
import {
  ENGINE_DEFAULTS,
  GRADE_PARAM_KEYS,
  GRADE_PARAM_RANGES,
  defaultColorGrade,
  gradeColor,
  gradeIsIdentity,
} from "./looks";

describe("grade engine — param model", () => {
  it("ENGINE_DEFAULTS is the identity grade (strength aside)", () => {
    expect(ENGINE_DEFAULTS.exposure).toBe(0);
    expect(ENGINE_DEFAULTS.contrast).toBe(0);
    expect(ENGINE_DEFAULTS.saturation).toBe(1);
    expect(ENGINE_DEFAULTS.temp).toBe(0);
    expect(ENGINE_DEFAULTS.fade).toBe(0);
    expect(ENGINE_DEFAULTS.shadowsLift).toBe(0);
    expect(ENGINE_DEFAULTS.highlightsGain).toBe(0);
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

describe("defaultColorGrade / gradeIsIdentity", () => {
  it("defaultColorGrade is a fresh copy of the identity vector", () => {
    const g = defaultColorGrade();
    expect(g).toEqual(ENGINE_DEFAULTS);
    expect(g).not.toBe(ENGINE_DEFAULTS); // fresh object
  });

  it("gradeIsIdentity is true for the default, false once a param moves", () => {
    expect(gradeIsIdentity(defaultColorGrade())).toBe(true);
    expect(gradeIsIdentity({ ...defaultColorGrade(), exposure: 0.2 })).toBe(false);
    expect(gradeIsIdentity({ ...defaultColorGrade(), shadowsLift: 0.1 })).toBe(false);
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
    expect(r).toBeGreaterThan(0.4);

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

  it("shadowsLift opens the darks but barely touches the brights", () => {
    const p = { ...ENGINE_DEFAULTS, shadowsLift: 1 };
    const darkLift = gradeColor(0.1, 0.1, 0.1, p, 0)[0] - 0.1;
    const brightLift = gradeColor(0.9, 0.9, 0.9, p, 0)[0] - 0.9;
    expect(darkLift).toBeGreaterThan(0.05);
    expect(brightLift).toBeLessThan(darkLift * 0.5);
  });

  it("highlightsGain boosts the brights but barely touches the darks", () => {
    const p = { ...ENGINE_DEFAULTS, highlightsGain: 1 };
    const brightGain = gradeColor(0.9, 0.9, 0.9, p, 0)[0] - 0.9;
    const darkGain = gradeColor(0.1, 0.1, 0.1, p, 0)[0] - 0.1;
    expect(brightGain).toBeGreaterThan(0.02);
    expect(Math.abs(darkGain)).toBeLessThan(brightGain * 0.5);
  });

  it("output is clamped to [0,1]", () => {
    const [r, g, b] = gradeColor(1, 1, 1, { ...ENGINE_DEFAULTS, exposure: 1, contrast: 1 }, 0);
    for (const v of [r, g, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
