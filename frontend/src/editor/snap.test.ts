import { describe, it, expect } from "vitest";
import { snapTime, gridStepSeconds, type SnapMode } from "./snap";

const BPM = 120;
const PHASE = 0;

describe("snapTime — off mode", () => {
  it("is identity in off mode regardless of context", () => {
    expect(snapTime(1.234, "off", { bpm: BPM, beatPhase: PHASE })).toBe(1.234);
    expect(snapTime(0, "off", { bpm: null, beatPhase: PHASE })).toBe(0);
  });
});

describe("snapTime — grid modes", () => {
  it("snaps to nearest quarter (=beat) at 120 BPM", () => {
    const ctx = { bpm: BPM, beatPhase: PHASE };
    expect(snapTime(0.49, "1/4", ctx)).toBeCloseTo(0.5, 6);
    expect(snapTime(0.51, "1/4", ctx)).toBeCloseTo(0.5, 6);
    expect(snapTime(0.74, "1/4", ctx)).toBeCloseTo(0.5, 6);
    expect(snapTime(0.76, "1/4", ctx)).toBeCloseTo(1.0, 6);
  });

  it("snaps to nearest half-note", () => {
    const ctx = { bpm: BPM, beatPhase: PHASE };
    // half-note period = 1.0 s at 120 BPM
    expect(snapTime(0.4, "1/2", ctx)).toBeCloseTo(0, 6);
    expect(snapTime(0.6, "1/2", ctx)).toBeCloseTo(1, 6);
    expect(snapTime(1.49, "1/2", ctx)).toBeCloseTo(1, 6);
    expect(snapTime(1.51, "1/2", ctx)).toBeCloseTo(2, 6);
  });

  it("snaps to nearest whole-bar (4 beats in 4/4)", () => {
    const ctx = { bpm: BPM, beatPhase: PHASE };
    // bar = 4 beats = 2 s at 120 BPM
    expect(snapTime(0.9, "1", ctx)).toBeCloseTo(0, 6);
    expect(snapTime(1.1, "1", ctx)).toBeCloseTo(2, 6);
    expect(snapTime(2.9, "1", ctx)).toBeCloseTo(2, 6);
    expect(snapTime(3.1, "1", ctx)).toBeCloseTo(4, 6);
  });

  it("snaps to 1/8 (= half-beat at 120 BPM = 0.25 s)", () => {
    const ctx = { bpm: BPM, beatPhase: PHASE };
    expect(snapTime(0.12, "1/8", ctx)).toBeCloseTo(0.0, 6);
    expect(snapTime(0.13, "1/8", ctx)).toBeCloseTo(0.25, 6);
    expect(snapTime(0.37, "1/8", ctx)).toBeCloseTo(0.25, 6);
    expect(snapTime(0.38, "1/8", ctx)).toBeCloseTo(0.5, 6);
  });

  it("snaps to 1/16 (= quarter-beat = 0.125 s at 120 BPM)", () => {
    const ctx = { bpm: BPM, beatPhase: PHASE };
    expect(snapTime(0.06, "1/16", ctx)).toBeCloseTo(0.0, 6);
    expect(snapTime(0.07, "1/16", ctx)).toBeCloseTo(0.125, 6);
  });

  it("respects beatPhase offset (beat 0 is at the phase, not at 0)", () => {
    const ctx = { bpm: BPM, beatPhase: 0.1 };
    // first beat is at 0.1 s; quarters at 0.1, 0.6, 1.1, ...
    expect(snapTime(0.34, "1/4", ctx)).toBeCloseTo(0.1, 6);
    expect(snapTime(0.36, "1/4", ctx)).toBeCloseTo(0.6, 6);
  });

  it("falls back to identity when bpm is null", () => {
    const ctx = { bpm: null, beatPhase: 0 };
    for (const mode of ["1", "1/2", "1/4", "1/8", "1/16"] as const) {
      expect(snapTime(1.337, mode, ctx)).toBe(1.337);
    }
  });
});

describe("snapTime — match mode", () => {
  it("snaps to the nearest candidate position within threshold", () => {
    const ctx = {
      bpm: BPM,
      beatPhase: PHASE,
      candidatePositions: [0.5, 1.5, 3.0],
    };
    expect(snapTime(0.55, "match", ctx)).toBeCloseTo(0.5, 6);
    expect(snapTime(1.49, "match", ctx)).toBeCloseTo(1.5, 6);
    expect(snapTime(3.04, "match", ctx)).toBeCloseTo(3.0, 6);
  });

  it("returns identity if no candidates are within snap threshold", () => {
    const ctx = {
      bpm: BPM,
      beatPhase: PHASE,
      candidatePositions: [0.5, 1.5],
      matchThresholdS: 0.05,
    };
    // 1.0 is 0.5 away from both — outside threshold.
    expect(snapTime(1.0, "match", ctx)).toBe(1.0);
  });

  it("returns identity when no candidate list is provided", () => {
    expect(snapTime(2.5, "match", { bpm: BPM, beatPhase: PHASE })).toBe(2.5);
  });
});

describe("gridStepSeconds — helper", () => {
  it("converts a SnapMode to its step length in seconds", () => {
    expect(gridStepSeconds("1", BPM)).toBeCloseTo(2.0, 6); // bar = 2 s
    expect(gridStepSeconds("1/2", BPM)).toBeCloseTo(1.0, 6);
    expect(gridStepSeconds("1/4", BPM)).toBeCloseTo(0.5, 6);
    expect(gridStepSeconds("1/8", BPM)).toBeCloseTo(0.25, 6);
    expect(gridStepSeconds("1/16", BPM)).toBeCloseTo(0.125, 6);
    expect(gridStepSeconds("off", BPM)).toBeNull();
    expect(gridStepSeconds("match", BPM)).toBeNull();
  });

  it("returns null when bpm is null/zero", () => {
    expect(gridStepSeconds("1/4", null)).toBeNull();
    expect(gridStepSeconds("1/4", 0)).toBeNull();
  });

  it("uses beatsPerBar for bar-level steps when supplied", () => {
    // 3/4 at 120 BPM: bar = 3 beats = 1.5 s, half-bar = 0.75 s.
    expect(gridStepSeconds("1", BPM, 3)).toBeCloseTo(1.5, 6);
    expect(gridStepSeconds("1/2", BPM, 3)).toBeCloseTo(0.75, 6);
    // sub-beat steps are independent of beatsPerBar.
    expect(gridStepSeconds("1/4", BPM, 3)).toBeCloseTo(0.5, 6);
    expect(gridStepSeconds("1/8", BPM, 3)).toBeCloseTo(0.25, 6);
    expect(gridStepSeconds("1/16", BPM, 3)).toBeCloseTo(0.125, 6);
  });

  it("falls back to 4 beats per bar when beatsPerBar is omitted", () => {
    expect(gridStepSeconds("1", BPM)).toBeCloseTo(2.0, 6);
  });
});

describe("snapTime — non-4/4 time signatures", () => {
  it("snaps whole-bar in 3/4 (= 3 beats = 1.5 s at 120 BPM)", () => {
    const ctx = { bpm: BPM, beatPhase: 0, beatsPerBar: 3 };
    expect(snapTime(0.7, "1", ctx)).toBeCloseTo(0, 6);
    expect(snapTime(0.8, "1", ctx)).toBeCloseTo(1.5, 6);
    expect(snapTime(2.2, "1", ctx)).toBeCloseTo(1.5, 6);
    expect(snapTime(2.3, "1", ctx)).toBeCloseTo(3.0, 6);
  });

  it("snaps whole-bar in 7/8 (= 7 beats = 3.5 s at 120 BPM)", () => {
    const ctx = { bpm: BPM, beatPhase: 0, beatsPerBar: 7 };
    expect(snapTime(1.6, "1", ctx)).toBeCloseTo(0, 6);
    expect(snapTime(1.8, "1", ctx)).toBeCloseTo(3.5, 6);
  });

  it("leaves sub-beat snaps untouched by beatsPerBar", () => {
    const ctx3 = { bpm: BPM, beatPhase: 0, beatsPerBar: 3 };
    const ctx4 = { bpm: BPM, beatPhase: 0, beatsPerBar: 4 };
    expect(snapTime(0.51, "1/4", ctx3)).toBeCloseTo(0.5, 6);
    expect(snapTime(0.51, "1/4", ctx4)).toBeCloseTo(0.5, 6);
  });
});

describe("snapTime — bar offset (anacrusis / pickup)", () => {
  it("anchors whole-bar snap to bar 1 (= beat 0 + offset * period)", () => {
    // 4/4 at 120 BPM, pickup of 2 beats → bar 1 at t=1.0; bars at -1.0, 1.0, 3.0, 5.0.
    // Snaps go to the nearest of those.
    const ctx = {
      bpm: BPM,
      beatPhase: 0,
      beatsPerBar: 4,
      barOffsetBeats: 2,
    };
    expect(snapTime(-0.1, "1", ctx)).toBeCloseTo(-1.0, 6);
    expect(snapTime(0.4, "1", ctx)).toBeCloseTo(1.0, 6);
    expect(snapTime(1.9, "1", ctx)).toBeCloseTo(1.0, 6);
    expect(snapTime(2.1, "1", ctx)).toBeCloseTo(3.0, 6);
  });

  it("ignores bar offset for sub-beat snaps (those follow beatPhase)", () => {
    const ctx = {
      bpm: BPM,
      beatPhase: 0,
      beatsPerBar: 4,
      barOffsetBeats: 2,
    };
    expect(snapTime(0.51, "1/4", ctx)).toBeCloseTo(0.5, 6);
    expect(snapTime(0.13, "1/8", ctx)).toBeCloseTo(0.25, 6);
  });

  it("treats barOffsetBeats=0 the same as no offset", () => {
    const ctx0 = { bpm: BPM, beatPhase: 0, beatsPerBar: 4, barOffsetBeats: 0 };
    const ctxNone = { bpm: BPM, beatPhase: 0, beatsPerBar: 4 };
    for (const t of [0.4, 1.1, 2.3, 3.6]) {
      expect(snapTime(t, "1", ctx0)).toBeCloseTo(
        snapTime(t, "1", ctxNone),
        6,
      );
    }
  });
});

describe("snapTime — non-mode-dependent shape", () => {
  it("accepts every SnapMode without throwing", () => {
    const modes: SnapMode[] = ["off", "match", "1", "1/2", "1/4", "1/8", "1/16"];
    for (const m of modes) {
      expect(typeof snapTime(1.0, m, { bpm: BPM, beatPhase: 0 })).toBe("number");
    }
  });
});

describe("snapTime — degenerate bpm", () => {
  it("returns t unchanged for non-finite bpm instead of a broken grid", () => {
    for (const bpm of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const ctx = { bpm, beatPhase: 0 };
      expect(snapTime(1.23, "1/4", ctx)).toBe(1.23);
      expect(snapTime(1.23, "1", ctx)).toBe(1.23);
    }
  });
});
