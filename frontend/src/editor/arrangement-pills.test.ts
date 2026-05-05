import { describe, expect, it } from "vitest";
import {
  generateArrangementPills,
  reconcileArrangementPills,
} from "./arrangement-pills";
import type { Clip } from "./types";

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

describe("generateArrangementPills", () => {
  it("emits one pill per (cam × arrangement-item) intersection", () => {
    const cams: Clip[] = [
      makeVideoClip("cam-a", 0, 100), // anchor 0; covers master 0..100
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
    const pills = generateArrangementPills(arr, chunks, cams);
    expect(pills.length).toBe(4); // 2 cams × 2 chunks
    // First chunk arr-slot is [0, 2). cam-a maps to source 5..7.
    expect(pills[0]).toMatchObject({
      camId: "cam-a",
      arrStartS: 0,
      arrEndS: 2,
      sourceInS: 5,
      sourceOutS: 7,
      fromArrangementItemId: "a0",
    });
    // Second chunk arr-slot is [2, 7). cam-b maps to source 30..35.
    expect(pills[3]).toMatchObject({
      camId: "cam-b",
      arrStartS: 2,
      arrEndS: 7,
      sourceInS: 30,
      sourceOutS: 35,
      fromArrangementItemId: "a1",
    });
  });

  it("clips a cam to its visible master-time range", () => {
    // cam covers master 0..10. Chunk is master 8..12. Intersect is 8..10.
    const cams: Clip[] = [makeVideoClip("c", 0, 10)];
    const chunks = [
      { id: "c0", startMs: 8_000, endMs: 12_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    ];
    const arr = [{ id: "a0", chunkId: "c0" }];
    const pills = generateArrangementPills(arr, chunks, cams);
    expect(pills.length).toBe(1);
    // arr slot is [0, 4) — but the pill only covers [0, 2) because the
    // cam runs out at master 10.
    expect(pills[0].arrStartS).toBe(0);
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
    const pills = generateArrangementPills(arr, chunks, cams);
    expect(pills.length).toBe(2);
    expect(pills[0].arrStartS).toBe(0);
    expect(pills[0].arrEndS).toBe(2);
    expect(pills[0].fromArrangementItemId).toBe("a0");
    expect(pills[1].arrStartS).toBe(2);
    expect(pills[1].arrEndS).toBe(4);
    expect(pills[1].fromArrangementItemId).toBe("a1");
    // Both pills point at the same cam-source range — that's the whole
    // point of duplicates.
    expect(pills[0].sourceInS).toBe(pills[1].sourceInS);
    expect(pills[0].sourceOutS).toBe(pills[1].sourceOutS);
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
    const pills = generateArrangementPills(arr, chunks, cams);
    expect(pills.length).toBe(1);
    expect(pills[0].fromArrangementItemId).toBe("a0");
  });
});

describe("reconcileArrangementPills", () => {
  const cams: Clip[] = [makeVideoClip("c", 0, 100)];
  const chunks = [
    { id: "c0", startMs: 0, endMs: 2_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
    { id: "c1", startMs: 5_000, endMs: 7_000, bpmOctaveShift: 0 as const, effectiveBpm: 120, beatsPerBar: 4, accepted: true, trimMode: "auto" as const },
  ];
  const arr = [
    { id: "a0", chunkId: "c0" },
    { id: "a1", chunkId: "c1" },
  ];

  it("preserves user-edited pills by id and adopts new ones", () => {
    const userEdited = [
      {
        id: "c::a0",
        camId: "c",
        arrStartS: 0.5, // user dragged the pill 0.5s right
        arrEndS: 2.5,
        sourceInS: 0.2, // user trimmed front 200 ms off
        sourceOutS: 2,
        fromArrangementItemId: "a0",
      },
    ];
    const reconciled = reconcileArrangementPills(arr, chunks, cams, userEdited);
    expect(reconciled.length).toBe(2);
    // First pill: kept with user edits.
    expect(reconciled[0].arrStartS).toBe(0.5);
    expect(reconciled[0].sourceInS).toBe(0.2);
    // Second pill: freshly generated (user never touched it).
    expect(reconciled[1].id).toBe("c::a1");
    expect(reconciled[1].arrStartS).toBe(2);
  });

  it("drops stored pills whose arrangement-item disappeared", () => {
    const stored = [
      {
        id: "c::removed",
        camId: "c",
        arrStartS: 0,
        arrEndS: 1,
        sourceInS: 0,
        sourceOutS: 1,
        fromArrangementItemId: "removed",
      },
    ];
    const reconciled = reconcileArrangementPills(arr, chunks, cams, stored);
    expect(reconciled.find((p) => p.id === "c::removed")).toBeUndefined();
  });
});
