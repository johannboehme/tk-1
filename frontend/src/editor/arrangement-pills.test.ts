import { describe, expect, it } from "vitest";
import { generatePills, reconcilePills } from "./arrangement-pills";
import type { Clip, Pill } from "./types";

const makeVideoClip = (
  id: string,
  syncOffsetMs: number,
  sourceDurationS: number,
): Clip => ({
  kind: "video",
  id,
  filename: `${id}.mp4`,
  color: "#abcdef",
  sourceDurationS,
  syncOffsetMs,
  syncOverrideMs: 0,
  startOffsetS: 0,
  driftRatio: 1,
  candidates: [],
  selectedCandidateIdx: 0,
});

describe("generatePills (single-take = no arrangement)", () => {
  it("emits one pill per cam covering its full master range", () => {
    const cams: Clip[] = [
      makeVideoClip("cam-a", 0, 30),
      makeVideoClip("cam-b", 0, 45),
    ];
    const pills = generatePills([], [], cams);
    expect(pills.length).toBe(2);
    expect(pills[0]).toMatchObject({
      id: "cam-a::__default__",
      camId: "cam-a",
      arrStartS: 0,
      arrEndS: 30,
      sourceInS: 0,
      sourceOutS: 30,
      originalArrStartS: 0,
      originalArrEndS: 30,
      originalSourceInS: 0,
      originalSourceOutS: 30,
      fromArrangementItemId: "__default__",
    });
    expect(pills[1].id).toBe("cam-b::__default__");
    expect(pills[1].arrEndS).toBe(45);
  });
});

describe("generatePills (long-form = arrangement)", () => {
  it("emits one pill per (cam × arrangement-item) intersection", () => {
    const cams: Clip[] = [
      makeVideoClip("cam-a", 0, 100),
      makeVideoClip("cam-b", 0, 100),
    ];
    const chunks = [
      { id: "c0", startMs: 5_000, endMs: 7_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
      { id: "c1", startMs: 30_000, endMs: 35_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    ];
    const arr = [
      { id: "a0", chunkId: "c0" },
      { id: "a1", chunkId: "c1" },
    ];
    const pills = generatePills(arr, chunks, cams);
    expect(pills.length).toBe(4);
    expect(pills[0]).toMatchObject({
      id: "cam-a::a0",
      camId: "cam-a",
      arrStartS: 0,
      arrEndS: 2,
      sourceInS: 5,
      sourceOutS: 7,
      originalArrStartS: 0,
      originalArrEndS: 2,
      originalSourceInS: 5,
      originalSourceOutS: 7,
      fromArrangementItemId: "a0",
    });
    expect(pills[3]).toMatchObject({
      camId: "cam-b",
      arrStartS: 2,
      arrEndS: 7,
      sourceInS: 30,
      sourceOutS: 35,
    });
  });

  it("clips a cam to its visible master-time range", () => {
    const cams: Clip[] = [makeVideoClip("c", 0, 10)];
    const chunks = [
      { id: "c0", startMs: 8_000, endMs: 12_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    ];
    const arr = [{ id: "a0", chunkId: "c0" }];
    const pills = generatePills(arr, chunks, cams);
    expect(pills.length).toBe(1);
    expect(pills[0].arrEndS).toBe(2);
    expect(pills[0].sourceInS).toBe(8);
    expect(pills[0].sourceOutS).toBe(10);
  });

  it("emits pills in playback order, accumulating arr-time across duplicates", () => {
    const cams: Clip[] = [makeVideoClip("c", 0, 100)];
    const chunks = [
      { id: "c0", startMs: 0, endMs: 2_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    ];
    const arr = [
      { id: "a0", chunkId: "c0" },
      { id: "a1", chunkId: "c0" }, // duplicate
    ];
    const pills = generatePills(arr, chunks, cams);
    expect(pills.length).toBe(2);
    expect(pills[0].arrStartS).toBe(0);
    expect(pills[0].arrEndS).toBe(2);
    expect(pills[0].fromArrangementItemId).toBe("a0");
    expect(pills[1].arrStartS).toBe(2);
    expect(pills[1].arrEndS).toBe(4);
    expect(pills[1].fromArrangementItemId).toBe("a1");
  });

  it("skips arrangement-items whose chunk no longer exists", () => {
    const cams: Clip[] = [makeVideoClip("c", 0, 100)];
    const chunks = [
      { id: "c0", startMs: 0, endMs: 2_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    ];
    const arr = [
      { id: "a0", chunkId: "c0" },
      { id: "a-orphan", chunkId: "GONE" },
    ];
    const pills = generatePills(arr, chunks, cams);
    expect(pills.length).toBe(1);
    expect(pills[0].fromArrangementItemId).toBe("a0");
  });
});

describe("reconcilePills", () => {
  const cams: Clip[] = [makeVideoClip("c", 0, 100)];
  const chunks = [
    { id: "c0", startMs: 0, endMs: 2_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    { id: "c1", startMs: 5_000, endMs: 7_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
  ];
  const arr = [
    { id: "a0", chunkId: "c0" },
    { id: "a1", chunkId: "c1" },
  ];

  it("preserves user-edited arr/source on stored pills, refreshes originals", () => {
    const userEdited: Pill[] = [
      {
        id: "c::a0",
        camId: "c",
        arrStartS: 0.5,
        arrEndS: 2.5,
        sourceInS: 0.2,
        sourceOutS: 2,
        originalArrStartS: 99,
        originalArrEndS: 99,
        originalSourceInS: 99,
        originalSourceOutS: 99,
        fromArrangementItemId: "a0",
      },
    ];
    const reconciled = reconcilePills(arr, chunks, cams, userEdited);
    expect(reconciled.length).toBe(2);
    // First pill: user-edited values stay.
    expect(reconciled[0].arrStartS).toBe(0.5);
    expect(reconciled[0].sourceInS).toBe(0.2);
    // ...but originals are refreshed to the CURRENT auto-derived values.
    expect(reconciled[0].originalArrStartS).toBe(0);
    expect(reconciled[0].originalArrEndS).toBe(2);
    expect(reconciled[0].originalSourceInS).toBe(0);
    expect(reconciled[0].originalSourceOutS).toBe(2);
    // Second pill: freshly generated.
    expect(reconciled[1].id).toBe("c::a1");
    expect(reconciled[1].arrStartS).toBe(2);
  });

  it("regenerates an unedited stored pill when sync changes its baseline", () => {
    // Pre-existing bug: a single-take pill saved before sync completed
    // (arrStartS=0, originalArrStartS=0). Sync resolves later to a non-zero
    // offset → fresh generation puts the pill at e.g. arr=2.896. Reconcile
    // would otherwise keep stored.arrStartS=0 and only refresh originals,
    // so the pill renders at 0 while the cuts strip / clipRangeS expect
    // 2.896. If the user hasn't edited the pill (stored matches its own
    // originals), we trust the fresh auto-derived values.
    const cam: Clip[] = [makeVideoClip("c", -2896, 100)];
    const stored: Pill[] = [
      {
        id: "c::__default__",
        camId: "c",
        // Generated when sync was still 0 → at the master origin.
        arrStartS: 0,
        arrEndS: 100,
        sourceInS: 0,
        sourceOutS: 100,
        // Originals match stored — pill is auto-derived, never user-edited.
        originalArrStartS: 0,
        originalArrEndS: 100,
        originalSourceInS: 0,
        originalSourceOutS: 100,
        fromArrangementItemId: "__default__",
      },
    ];
    // No arrangement → falls through to generateDefaultPills which uses
    // the current clipRangeS — that's the value we expect to win.
    const reconciled = reconcilePills([], [], cam, stored);
    expect(reconciled.length).toBe(1);
    expect(reconciled[0].arrStartS).toBeCloseTo(2.896, 3);
    expect(reconciled[0].arrEndS).toBeCloseTo(2.896 + 100, 3);
  });

  it("drops stored pills whose arrangement-item disappeared", () => {
    const stored: Pill[] = [
      {
        id: "c::removed",
        camId: "c",
        arrStartS: 0,
        arrEndS: 1,
        sourceInS: 0,
        sourceOutS: 1,
        originalArrStartS: 0,
        originalArrEndS: 1,
        originalSourceInS: 0,
        originalSourceOutS: 1,
        fromArrangementItemId: "removed",
      },
    ];
    const reconciled = reconcilePills(arr, chunks, cams, stored);
    expect(reconciled.find((p) => p.id === "c::removed")).toBeUndefined();
  });
});
