import { describe, expect, it } from "vitest";
import { buildQuantizePreview } from "./quantize";
import type { Cut } from "../storage/jobs-db";
import type { PunchFx } from "./fx/types";

const BPM = 120;
const PHASE = 0;

describe("buildQuantizePreview — empty modes are no-ops", () => {
  it("returns empty preview when mode is OFF", () => {
    const preview = buildQuantizePreview(
      { cuts: [{ atTimeS: 0.31, camId: "cam-1" }] },
      "off",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(preview.cuts).toEqual([]);
    expect(preview.fxs).toEqual([]);
  });

  it("returns empty preview when mode is MATCH (no time-grid)", () => {
    const preview = buildQuantizePreview(
      { cuts: [{ atTimeS: 0.31, camId: "cam-1" }] },
      "match",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(preview.cuts).toEqual([]);
    expect(preview.fxs).toEqual([]);
  });

  it("returns empty preview when bpm is null (grid is undefined)", () => {
    const preview = buildQuantizePreview(
      { cuts: [{ atTimeS: 0.31, camId: "cam-1" }] },
      "1/4",
      { bpm: null, beatPhase: 0 },
    );
    expect(preview.cuts).toEqual([]);
  });
});

describe("buildQuantizePreview — quantizes cuts to the grid", () => {
  it("only emits from/to pairs for off-grid markers (on-grid skipped)", () => {
    const cuts: Cut[] = [
      { atTimeS: 0.5, camId: "cam-1" }, // on-grid (= beat 1 at 120 BPM)
      { atTimeS: 0.61, camId: "cam-1" }, // off-grid → snap to 0.5
      { atTimeS: 1.0, camId: "cam-1" }, // on-grid (beat 2)
      { atTimeS: 1.27, camId: "cam-1" }, // off-grid → snap to 1.5 (1.27 closer to 1.5? 1.0->0.27, 1.5->0.23)
    ];
    const preview = buildQuantizePreview({ cuts }, "1/4", {
      bpm: BPM,
      beatPhase: PHASE,
    });
    expect(preview.cuts.length).toBe(2);
    const fromTimes = preview.cuts.map((c) => c.from).sort((a, b) => a - b);
    expect(fromTimes).toEqual([0.61, 1.27]);
  });
});

describe("buildQuantizePreview — quantizes fx in/out", () => {
  const fx = (id: string, inS: number, outS: number): PunchFx => ({
    id,
    kind: "vignette",
    inS,
    outS,
  });

  it("snaps fx.inS and fx.outS independently when off-grid", () => {
    const preview = buildQuantizePreview(
      {
        cuts: [],
        fx: [fx("a", 0.21, 1.27)], // both off-grid (beat = 0.5 at 120 BPM)
      },
      "1/4",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(preview.fxs).toBeDefined();
    expect(preview.fxs).toHaveLength(1);
    const ch = preview.fxs![0];
    expect(ch.id).toBe("a");
    expect(ch.in!.from).toBeCloseTo(0.21, 6);
    expect(ch.in!.to).toBeCloseTo(0, 6);
    expect(ch.out!.from).toBeCloseTo(1.27, 6);
    expect(ch.out!.to).toBeCloseTo(1.5, 6);
  });

  it("on-grid fx are skipped entirely", () => {
    const preview = buildQuantizePreview(
      {
        cuts: [],
        fx: [fx("a", 0.5, 1.0)], // on-grid (1/4 at 120 BPM)
      },
      "1/4",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(preview.fxs).toEqual([]);
  });

  it("emits only the side that's off-grid", () => {
    const preview = buildQuantizePreview(
      {
        cuts: [],
        fx: [fx("a", 0.5, 1.27)], // in on-grid, out off-grid
      },
      "1/4",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(preview.fxs).toHaveLength(1);
    expect(preview.fxs![0].in).toBeUndefined();
    expect(preview.fxs![0].out!.to).toBeCloseTo(1.5, 6);
  });

  it("returns empty fxs when state.fx omitted (back-compat)", () => {
    const preview = buildQuantizePreview({ cuts: [] }, "1/4", {
      bpm: BPM,
      beatPhase: PHASE,
    });
    // fxs may be undefined or [] — test for both shapes.
    expect(preview.fxs ?? []).toEqual([]);
  });
});

describe("buildQuantizePreview — scope is cuts + fx ONLY (#70)", () => {
  it("the preview type carries no clip-start or trim deltas", () => {
    // Quantize must never touch auto-synced cam start offsets (that
    // would break the A/V sync the app computes) or the master trim.
    // The preview shape itself guarantees it: only cuts + fxs exist.
    const preview = buildQuantizePreview(
      { cuts: [{ atTimeS: 0.61, camId: "cam-1" }] },
      "1/4",
      { bpm: BPM, beatPhase: PHASE },
    );
    expect(Object.keys(preview).sort()).toEqual(["cuts", "fxs"]);
  });
});
