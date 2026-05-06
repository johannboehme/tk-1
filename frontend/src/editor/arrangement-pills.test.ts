import { describe, expect, it } from "vitest";
import { activeCamAtArr, generatePills, reconcilePills } from "./arrangement-pills";
import type { Clip, Pill, Segment } from "./types";
import type { Cut } from "../storage/jobs-db";

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

/** Synthetic single-take inputs — mirrors what `synthesizeJobLoadShape`
 *  feeds into `loadJob` for direct-mode jobs. The arrangement-item id is
 *  the legacy `__default__` sentinel so pill ids stay stable across the
 *  refactor. */
const makeSyntheticSingleTake = (durationS: number) => ({
  arrangement: [{ id: "__default__", chunkId: "__default_chunk__" }],
  chunks: [
    {
      id: "__default_chunk__",
      startMs: 0,
      endMs: durationS * 1000,
      bpmOctaveShift: 0 as const,
      effectiveBpm: 0,
      beatsPerBar: 4,
      accepted: true,
      trimMode: "free" as const,
    },
  ],
});

describe("generatePills (single-take via synthetic arrangement)", () => {
  it("emits one pill per cam, ID anchored on the __default__ sentinel", () => {
    const cams: Clip[] = [
      makeVideoClip("cam-a", 0, 30),
      makeVideoClip("cam-b", 0, 45),
    ];
    // Single-take's synthetic chunk spans the WIDEST cam (max sourceDurationS)
    // — this is what synthesizeJobLoadShape produces when fed master duration.
    const { arrangement, chunks } = makeSyntheticSingleTake(45);
    const pills = generatePills(arrangement, chunks, cams);
    expect(pills.length).toBe(2);
    // cam-a clipped at its own range (30s); cam-b uses its full 45s.
    expect(pills[0]).toMatchObject({
      id: "cam-a::__default__",
      camId: "cam-a",
      arrStartS: 0,
      arrEndS: 30,
      sourceInS: 0,
      sourceOutS: 30,
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
    const userEditedPills: Pill[] = [
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
        userEdited: true,
      },
    ];
    const reconciled = reconcilePills(arr, chunks, cams, userEditedPills);
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

  it("regenerates pills without the userEdited flag (legacy / sync-stale)", () => {
    // Mode-agnostic rule: stored arr/source override fresh ONLY when the
    // user-edited flag is true. Pre-flag pills (or pills written before
    // sync resolved) are auto-derived and must follow the current
    // baseline.
    const stored: Pill[] = [
      {
        id: "c::a0",
        camId: "c",
        // Pre-sync stored values that no longer match clipRangeS.
        arrStartS: 99,
        arrEndS: 99,
        sourceInS: 99,
        sourceOutS: 99,
        originalArrStartS: 0,
        originalArrEndS: 2,
        originalSourceInS: 0,
        originalSourceOutS: 2,
        fromArrangementItemId: "a0",
        // No userEdited flag → treated as auto-generated.
      },
    ];
    const reconciled = reconcilePills(arr, chunks, cams, stored);
    // Fresh values win.
    expect(reconciled[0].arrStartS).toBe(0);
    expect(reconciled[0].arrEndS).toBe(2);
  });

  it("regenerates an unedited stored pill when sync changes its baseline", () => {
    // Pre-existing bug: a single-take pill saved before sync completed
    // (arrStartS=0, originalArrStartS=0). Sync resolves later to a non-zero
    // offset → fresh generation puts the pill at e.g. arr=2.896. Reconcile
    // would otherwise keep stored.arrStartS=0 and only refresh originals,
    // so the pill renders at 0 while the cuts strip / clipRangeS expect
    // 2.896. Single-take goes through the synthetic arrangement+chunk
    // (mirroring synthesizeJobLoadShape).
    const cam: Clip[] = [makeVideoClip("c", -2896, 100)];
    const synth = makeSyntheticSingleTake(100);
    const stored: Pill[] = [
      {
        id: "c::__default__",
        camId: "c",
        arrStartS: 0,
        arrEndS: 100,
        sourceInS: 0,
        sourceOutS: 100,
        originalArrStartS: 0,
        originalArrEndS: 100,
        originalSourceInS: 0,
        originalSourceOutS: 100,
        fromArrangementItemId: "__default__",
      },
    ];
    const reconciled = reconcilePills(synth.arrangement, synth.chunks, cam, stored);
    expect(reconciled.length).toBe(1);
    expect(reconciled[0].arrStartS).toBeCloseTo(2.896, 3);
    // Synthetic chunk spans [0, 100s]; cam-clip-vs-chunk intersection
    // ends at 2.896+100=102.896s in master, but the chunk caps at 100s,
    // so arrEndS = 100 (clipped by chunk bound).
    expect(reconciled[0].arrEndS).toBeCloseTo(100, 3);
  });

  it("ignores polluted stored pills (originals diverged from arr by previous reconcile)", () => {
    // Reload race: a previous reconcile cycle refreshed `originalArrStartS`
    // to the post-sync fresh value (2.896) but left `arrStartS=0`. Then the
    // pill got persisted in that polluted state. The unedited-heuristic
    // can no longer recognize it because arr ≠ original. Without the
    // userEdited flag, the pill is always regenerated.
    const cam: Clip[] = [makeVideoClip("c", -2896, 100)];
    const synth = makeSyntheticSingleTake(100);
    const stored: Pill[] = [
      {
        id: "c::__default__",
        camId: "c",
        arrStartS: 0,
        arrEndS: 100,
        sourceInS: 0,
        sourceOutS: 100,
        // Originals diverged from arr by a previous reconcile run.
        originalArrStartS: 2.896,
        originalArrEndS: 2.896 + 100,
        originalSourceInS: 0,
        originalSourceOutS: 100,
        fromArrangementItemId: "__default__",
      },
    ];
    const reconciled = reconcilePills(synth.arrangement, synth.chunks, cam, stored);
    expect(reconciled.length).toBe(1);
    expect(reconciled[0].arrStartS).toBeCloseTo(2.896, 3);
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

describe("activeCamAtArr — timeline-time cut isolation across duplicate pills", () => {
  // Bug 3 regression guard. Pre-refactor, `Cut.atTimeS` was master-time
  // and the resolver projected it via masterToArr — which scans by
  // master-time and returns the FIRST occurrence. So a cut placed
  // inside pill 1 also fired over pill 3 (a duplicate of pill 1's
  // chunk). Cuts are now timeline-time so the cut sits at one specific
  // timeline-position and only matches the pill that occupies it.

  function makePill(id: string, camId: string, arrStartS: number, arrEndS: number): Pill {
    return {
      id,
      camId,
      arrStartS,
      arrEndS,
      sourceInS: 0,
      sourceOutS: arrEndS - arrStartS,
      originalArrStartS: arrStartS,
      originalArrEndS: arrEndS,
      originalSourceInS: 0,
      originalSourceOutS: arrEndS - arrStartS,
    };
  }

  it("a cut at timeline-T fires only for the pill at that timeline slot", () => {
    // Two cams covering the entire song so cuts can switch freely.
    // cam-A spans [0, 15], cam-B spans [0, 15] (multi-lane). One cut
    // sequence: A → B inside pill 1 region, then back to A inside the
    // duplicate-source slot. The resolver must read each cut at its
    // exact timeline-position; pre-refactor, master-time projection
    // would have collapsed pill 1 and pill 3 onto the same cut state.
    const pills: Pill[] = [
      makePill("a-full", "cam-A", 0, 15),
      makePill("b-full", "cam-B", 0, 15),
    ];
    const cuts: Cut[] = [
      { atTimeS: 0, camId: "cam-A" },
      { atTimeS: 5, camId: "cam-B" },
      { atTimeS: 12, camId: "cam-A" }, // inside duplicate slot
    ];
    const segments: Segment[] = [
      { in: 0, out: 5 },
      { in: 50, out: 55 },
      { in: 0, out: 5 }, // master shared with seg 0
    ];
    expect(activeCamAtArr(cuts, 1, pills, segments)?.camId).toBe("cam-A");
    expect(activeCamAtArr(cuts, 7, pills, segments)?.camId).toBe("cam-B");
    expect(activeCamAtArr(cuts, 11, pills, segments)?.camId).toBe("cam-B"); // before t=12 override
    expect(activeCamAtArr(cuts, 13, pills, segments)?.camId).toBe("cam-A");
  });

  it("a cut at timeline-T does NOT fire over a duplicate pill at a different timeline slot", () => {
    // The smoking-gun assertion. Pre-refactor, master-time-anchored
    // cuts would project to the FIRST occurrence's arr-time — so a cut
    // placed conceptually "inside pill 3" (master 2.0) projected to
    // arr 2.0 (pill 1's slot) and there was no way to put a cut purely
    // inside pill 3.
    const pills: Pill[] = [
      makePill("a-1", "cam-A", 0, 5),
      makePill("b-1", "cam-B", 5, 10),
      makePill("a-dup", "cam-A", 10, 15),
      makePill("b-2", "cam-B", 15, 20),
    ];
    // User clicks while looking at the duplicate pill (timeline 12) and
    // sets a cut to cam-B there. Stored as `atTimeS: 12` (timeline-time).
    const cuts: Cut[] = [{ atTimeS: 12, camId: "cam-B" }];
    const segments: Segment[] = [
      { in: 0, out: 5 },
      { in: 50, out: 55 },
      { in: 0, out: 5 }, // duplicate of seg 0
      { in: 100, out: 105 },
    ];
    // Pill 1 (timeline 0..5): no cut yet → fall back to first covering
    // pill (cam-A). The cut at t=12 is in the future for the playhead
    // here and must not bleed back.
    expect(activeCamAtArr(cuts, 1, pills, segments)?.camId).toBe("cam-A");
    // Pill 3 duplicate slot (timeline 12): the cut is in scope, switch
    // to cam-B — but only IF a cam-B pill covers this slot. The pill at
    // timeline 12 is a-dup (cam-A); cam-B has no covering pill, so the
    // resolver's rule is "fall back to the first covering pill" which
    // is a-dup. Either outcome is acceptable here — the critical point
    // is that pill 1's slot (timeline 1) is NOT affected by this cut.
    const atDup = activeCamAtArr(cuts, 12, pills, segments);
    expect(atDup).not.toBeNull();
    // Pill 4 (timeline 17, cam-B): the cut is in scope, cam-B has a
    // covering pill — we get cam-B.
    expect(activeCamAtArr(cuts, 17, pills, segments)?.camId).toBe("cam-B");
  });
});
