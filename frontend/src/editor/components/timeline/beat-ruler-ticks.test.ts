import { describe, expect, it } from "vitest";
import { buildRulerTicks, pickBarStride } from "./beat-ruler-ticks";

const BPM = 120;        // 0.5 s per beat, 2 s per bar (4/4)
const PHASE = 0;

describe("buildRulerTicks — visibility tied to zoom", () => {
  it("at low zoom, only bars are emitted", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 8,
      pxPerSec: 3, // 0.5 s × 3 = 1.5 px per beat → bars only
    });
    const kinds = new Set(ticks.map((t) => t.kind));
    expect(kinds).toEqual(new Set(["bar"]));
    // 4 bars in [0, 8] s at BPM=120 (bar = 2 s) → ticks at 0, 2, 4, 6, 8
    expect(ticks.map((t) => t.t)).toEqual([0, 2, 4, 6, 8]);
  });

  it("at medium zoom, bars + beats but no subdivisions", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 4,
      pxPerSec: 30, // 0.5 s × 30 = 15 px/beat → bars+beats only
    });
    const kinds = new Set(ticks.map((t) => t.kind));
    expect(kinds.has("bar")).toBe(true);
    expect(kinds.has("beat")).toBe(true);
    expect(kinds.has("div8")).toBe(false);
    expect(kinds.has("div16")).toBe(false);
  });

  it("at high zoom, subdivisions to 1/8 appear", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 1,
      pxPerSec: 80, // 0.5 s × 80 = 40 px/beat → +div8
    });
    const kinds = new Set(ticks.map((t) => t.kind));
    expect(kinds.has("div8")).toBe(true);
    expect(kinds.has("div16")).toBe(false);
  });

  it("at very high zoom, 1/16 subdivisions appear", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 0.5,
      pxPerSec: 200, // 0.5 s × 200 = 100 px/beat → +div8 +div16
    });
    const kinds = new Set(ticks.map((t) => t.kind));
    expect(kinds.has("div16")).toBe(true);
  });

  it("respects beatPhase offset (beat 0 sits at the phase, not at 0)", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 0.1,
      startS: 0,
      endS: 1.2,
      pxPerSec: 30,
    });
    const beats = ticks.filter((t) => t.kind === "beat" || t.kind === "bar");
    // First detectable beat is at 0.1 s, then 0.6 s, 1.1 s.
    expect(beats[0].t).toBeCloseTo(0.1, 6);
    expect(beats[1].t).toBeCloseTo(0.6, 6);
    expect(beats[2].t).toBeCloseTo(1.1, 6);
  });

  it("emits sequential bar numbers starting at 1 from beatPhase", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 8,
      pxPerSec: 30,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars[0].barNumber).toBe(1);
    expect(bars[1].barNumber).toBe(2);
    expect(bars[2].barNumber).toBe(3);
    // 4 bars at 0, 2, 4, 6 → barNumber 1..4 (8 itself = bar 5)
    expect(bars[bars.length - 1].barNumber).toBe(5);
  });

  it("clips to [startS, endS]", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 4,
      endS: 6,
      pxPerSec: 30,
    });
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.t).toBeGreaterThanOrEqual(4);
      expect(t.t).toBeLessThanOrEqual(6);
    }
  });

  it("does not draw any pre-phase ticks (intro silence stays empty)", () => {
    // The master audio leads with ~0.93 s of silence before the music
    // starts. Bar 1 must land on the first real beat — no negative-bar /
    // pre-phase ticks should appear in the silent intro.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 0.928,
      startS: 0,
      endS: 5,
      pxPerSec: 100, // ample zoom — every kind is enabled
    });
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.t).toBeGreaterThanOrEqual(0.928 - 1e-9);
    }
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars[0].t).toBeCloseTo(0.928, 6);
    expect(bars[0].barNumber).toBe(1);
  });

  it("returns empty for invalid bpm (null/zero/negative)", () => {
    for (const bpm of [null as unknown as number, 0, -120]) {
      expect(
        buildRulerTicks({ bpm, beatPhase: 0, startS: 0, endS: 4, pxPerSec: 30 }),
      ).toEqual([]);
    }
  });
});

describe("buildRulerTicks — non-4/4 time signatures", () => {
  it("places bar lines every `beatsPerBar` beats in 3/4", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 6,
      pxPerSec: 30,
      beatsPerBar: 3,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    // 3/4 at 120 BPM: bar = 1.5 s. Bars at 0, 1.5, 3.0, 4.5, 6.0.
    expect(bars.map((t) => t.t)).toEqual([0, 1.5, 3, 4.5, 6]);
    expect(bars.map((t) => t.barNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("renders the in-between beats in 3/4 as `beat` ticks (not bar)", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 1.5,
      pxPerSec: 30,
      beatsPerBar: 3,
    });
    const kinds = ticks.map((t) => `${t.t}:${t.kind}`);
    // bar @ 0; beat @ 0.5; beat @ 1.0; bar @ 1.5
    expect(kinds).toContain("0:bar");
    expect(kinds).toContain("0.5:beat");
    expect(kinds).toContain("1:beat");
    expect(kinds).toContain("1.5:bar");
  });

  it("places bar lines every 7 beats in 7/8 (= 3.5 s at 120 BPM)", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 7,
      pxPerSec: 30,
      beatsPerBar: 7,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([0, 3.5, 7]);
    expect(bars.map((t) => t.barNumber)).toEqual([1, 2, 3]);
  });
});

describe("buildRulerTicks — bar offset (anacrusis / pickup)", () => {
  it("renders pickup beats as beat ticks, not bar ticks", () => {
    // 4/4 at 120 BPM, pickup of 2 beats. Bar 1 at t=1.0.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 5,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 2,
    });
    // The two pickup positions (t=0, t=0.5) should be `beat`, not `bar`.
    const t0 = ticks.find((t) => Math.abs(t.t - 0) < 1e-6);
    const t05 = ticks.find((t) => Math.abs(t.t - 0.5) < 1e-6);
    expect(t0?.kind).toBe("beat");
    expect(t05?.kind).toBe("beat");
  });

  it("anchors bar 1 at `barOffsetBeats * beatPeriod` after the phase", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 5,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 2,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars[0].t).toBeCloseTo(1.0, 6);
    expect(bars[0].barNumber).toBe(1);
    expect(bars[1].t).toBeCloseTo(3.0, 6);
    expect(bars[1].barNumber).toBe(2);
  });

  it("does not emit bar ticks before the first downbeat (pickup ≠ bar 0)", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 5,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 2,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    for (const b of bars) {
      expect(b.t).toBeGreaterThanOrEqual(1.0 - 1e-9);
      // bar numbers must be ≥ 1 — pickup ticks are beat-kind, not bar-kind.
      expect(b.barNumber!).toBeGreaterThanOrEqual(1);
    }
  });

  it("an offset equal to beatsPerBar collapses back to no offset", () => {
    const a = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 5,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 0,
    });
    const b = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 5,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 4,
    });
    expect(b).toEqual(a);
  });
});

describe("buildRulerTicks — extendBeforePhase (grid projected left of anchor)", () => {
  it("emits bars before the phase with bar numbers ≤ 0", () => {
    // Anchor at 10 s, window 0..12 s. Bars every 2 s: t=0..12.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 10,
      startS: 0,
      endS: 12,
      pxPerSec: 30,
      extendBeforePhase: true,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(bars.map((t) => t.barNumber)).toEqual([-4, -3, -2, -1, 0, 1, 2]);
  });

  it("still renders in-between beats left of the anchor", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 10,
      startS: 8,
      endS: 10,
      pxPerSec: 30,
      extendBeforePhase: true,
    });
    const beats = ticks.filter((t) => t.kind === "beat");
    expect(beats.map((t) => t.t)).toEqual([8.5, 9, 9.5]);
  });

  it("combines with a pickup: bar 1 sits offset beats after the phase, bar 0 one bar earlier", () => {
    // Phase 5 s, 2-beat pickup at 120 BPM → bar 1 at 6 s, bar 0 at 4 s.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 5,
      startS: 0,
      endS: 10,
      pxPerSec: 30,
      beatsPerBar: 4,
      barOffsetBeats: 2,
      extendBeforePhase: true,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(bars.map((t) => t.barNumber)).toEqual([-2, -1, 0, 1, 2, 3]);
  });

  it("defaults to the editor behavior (no pre-phase ticks) when omitted", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: 10,
      startS: 0,
      endS: 12,
      pxPerSec: 30,
    });
    for (const t of ticks) expect(t.t).toBeGreaterThanOrEqual(10 - 1e-9);
  });
});

describe("buildRulerTicks — labelStride", () => {
  it("labels every bar at stride 1 (default)", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 8,
      pxPerSec: 30,
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(b.labeled).toBe(true);
  });

  it("labels only every Nth bar with 'auto' stride at low zoom, keeping bar 1 labeled", () => {
    // pxPerSec 7 → pxPerBar 14 → stride 4 (labels ≥ 56 px apart).
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 40,
      pxPerSec: 7,
      labelStride: "auto",
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.length).toBe(21); // bars 1..21 at 0,2,…,40 s
    for (const b of bars) {
      expect(b.labeled).toBe((b.barNumber! - 1) % 4 === 0);
    }
  });

  it("suppresses beats and subdivisions when the stride is > 1", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 40,
      pxPerSec: 7,
      labelStride: "auto",
    });
    const kinds = new Set(ticks.map((t) => t.kind));
    expect(kinds).toEqual(new Set(["bar"]));
  });

  it("drops unlabeled bars entirely when they'd sit closer than 6 px", () => {
    // pxPerSec 2 → pxPerBar 4 (< 6): only stride-labeled bars survive.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 120,
      pxPerSec: 2,
      labelStride: "auto",
    });
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(b.labeled).toBe(true);
  });

  it("returns nothing when bars would sit closer than a quarter pixel", () => {
    // pxPerSec 0.1 → pxPerBar 0.2 < 0.25 → tick soup guard kicks in.
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 600,
      pxPerSec: 0.1,
    });
    expect(ticks).toEqual([]);
  });
});

describe("pickBarStride", () => {
  it("is 1 when a bar already spans the label target", () => {
    expect(pickBarStride(56)).toBe(1);
    expect(pickBarStride(200)).toBe(1);
  });
  it("doubles until labeled bars sit ≥ 56 px apart", () => {
    expect(pickBarStride(28)).toBe(2);
    expect(pickBarStride(14)).toBe(4);
    expect(pickBarStride(13)).toBe(8);
  });
});

describe("buildRulerTicks — extensionSpan", () => {
  const opts = {
    bpm: BPM,
    beatPhase: 2,
    startS: 0,
    endS: 8,
    pxPerSec: 30,
    extendBeforePhase: true,
    extensionSpan: { startS: 2, endS: 6 },
  };

  it("flags ticks outside the half-open span [startS, endS) as extension", () => {
    const ticks = buildRulerTicks(opts);
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.t)).toEqual([0, 2, 4, 6, 8]);
    // The downbeat exactly at span end opens the NEXT bar → extension
    // (half-open chunk span — the boundary bar is not primary).
    expect(bars.map((t) => t.extension)).toEqual([true, false, false, true, true]);
  });

  it("flags beat ticks by the same half-open rule", () => {
    const ticks = buildRulerTicks(opts);
    const at = (t: number) => ticks.find((x) => Math.abs(x.t - t) < 1e-6)!;
    expect(at(2.5).extension).toBe(false);
    expect(at(5.5).extension).toBe(false);
    expect(at(6.5).extension).toBe(true);
    expect(at(1.5).extension).toBe(true);
  });

  it("emits no extension field when no span is given", () => {
    const ticks = buildRulerTicks({
      bpm: BPM,
      beatPhase: PHASE,
      startS: 0,
      endS: 4,
      pxPerSec: 30,
    });
    for (const t of ticks) expect(t.extension).toBeUndefined();
  });
});
