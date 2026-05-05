import { describe, it, expect } from "vitest";
import {
  arrToMaster,
  clampArr,
  masterToArr,
  mastersToArrAll,
  segmentArrStarts,
  segmentIndexAtArr,
  segmentIndexAtMaster,
  sliceByArrSegments,
  totalArrDuration,
} from "./arrangement-time";

const SEGS = [
  { in: 10, out: 20 }, // arr 0..10
  { in: 50, out: 65 }, // arr 10..25
  { in: 30, out: 35 }, // arr 25..30 (out-of-order: simulates user reorder)
];

describe("arrangement-time helpers", () => {
  it("totalArrDuration sums segment lengths and ignores zero/negative", () => {
    expect(totalArrDuration([])).toBe(0);
    expect(totalArrDuration(SEGS)).toBe(30);
    expect(
      totalArrDuration([
        { in: 5, out: 5 }, // zero-length is filtered out
        { in: 0, out: 3 },
      ]),
    ).toBe(3);
  });

  it("masterToArr passes through when no segments", () => {
    expect(masterToArr(42, [])).toBe(42);
  });

  it("masterToArr maps inside a segment correctly", () => {
    expect(masterToArr(10, SEGS)).toBe(0); // segment-1 in
    expect(masterToArr(15, SEGS)).toBe(5); // mid segment-1
    expect(masterToArr(50, SEGS)).toBe(10); // segment-2 in
    expect(masterToArr(64, SEGS)).toBe(24); // 14 into segment-2
    expect(masterToArr(30, SEGS)).toBe(25); // segment-3 in
    expect(masterToArr(34, SEGS)).toBe(29); // mid segment-3
  });

  it("masterToArr returns first match on duplicates", () => {
    const dup = [
      { in: 10, out: 20 }, // arr 0..10
      { in: 10, out: 20 }, // arr 10..20 (duplicate)
    ];
    expect(masterToArr(15, dup)).toBe(5); // first match
  });

  it("masterToArr snaps to nearest edge for out-of-segment master-time", () => {
    // master 5 is before any segment; nearest edge = segment-1.in (master 10)
    // → arr 0.
    expect(masterToArr(5, SEGS)).toBe(0);
    // master 25 is in the gap between seg-1 (out=20) and seg-2 (in=50);
    // nearest edge = seg-1.out (dist 5) → arr 10.
    expect(masterToArr(25, SEGS)).toBe(10);
    // master 100 is past everything; nearest edge = seg-2.out (dist 35) →
    // arr 25.
    expect(masterToArr(100, SEGS)).toBe(25);
  });

  it("arrToMaster passes through when no segments", () => {
    expect(arrToMaster(42, [])).toBe(42);
  });

  it("arrToMaster maps boundary + interior correctly", () => {
    expect(arrToMaster(0, SEGS)).toBe(10);
    expect(arrToMaster(5, SEGS)).toBe(15);
    expect(arrToMaster(10, SEGS)).toBe(50); // crossing boundary
    expect(arrToMaster(25, SEGS)).toBe(30);
    expect(arrToMaster(29, SEGS)).toBe(34);
  });

  it("arrToMaster clamps out-of-range to nearest seg edge", () => {
    expect(arrToMaster(-5, SEGS)).toBe(10);
    expect(arrToMaster(1000, SEGS)).toBe(35);
  });

  it("masterToArr ↔ arrToMaster round-trip inside segments", () => {
    for (const masterT of [10.5, 19.99, 50, 60, 30, 34.5]) {
      const arr = masterToArr(masterT, SEGS);
      const round = arrToMaster(arr, SEGS);
      expect(round).toBeCloseTo(masterT, 6);
    }
  });

  it("segmentIndexAtMaster honours half-open intervals", () => {
    expect(segmentIndexAtMaster(10, SEGS)).toBe(0);
    expect(segmentIndexAtMaster(20, SEGS)).toBe(-1); // out is exclusive
    expect(segmentIndexAtMaster(50, SEGS)).toBe(1);
    expect(segmentIndexAtMaster(30, SEGS)).toBe(2);
    expect(segmentIndexAtMaster(0, SEGS)).toBe(-1);
  });

  it("segmentIndexAtArr handles edges + past-end", () => {
    expect(segmentIndexAtArr(0, SEGS)).toBe(0);
    expect(segmentIndexAtArr(10, SEGS)).toBe(1);
    expect(segmentIndexAtArr(30, SEGS)).toBe(-1); // past end
    expect(segmentIndexAtArr(-1, SEGS)).toBe(-1);
  });

  it("clampArr keeps inside [0, total]", () => {
    expect(clampArr(-3, SEGS)).toBe(0);
    expect(clampArr(15, SEGS)).toBe(15);
    expect(clampArr(50, SEGS)).toBe(30);
    expect(clampArr(5, [])).toBe(5);
  });

  it("segmentArrStarts produces cumulative starts", () => {
    expect(segmentArrStarts(SEGS)).toEqual([0, 10, 25]);
    expect(segmentArrStarts([])).toEqual([]);
  });

  it("mastersToArrAll passes through when no segments", () => {
    expect(mastersToArrAll(7, [])).toEqual([7]);
  });

  it("mastersToArrAll yields one entry per occurrence", () => {
    expect(mastersToArrAll(15, SEGS)).toEqual([5]);
    const dup = [
      { in: 10, out: 20 },
      { in: 50, out: 60 },
      { in: 10, out: 20 }, // duplicate
    ];
    // master 15 lands in chunk-A (arr 5) and chunk-A again (arr 25)
    expect(mastersToArrAll(15, dup)).toEqual([5, 25]);
  });

  it("mastersToArrAll skips master-times that fall in gaps", () => {
    expect(mastersToArrAll(25, SEGS)).toEqual([]); // master 25 is between segs 1 and 2
  });

  it("sliceByArrSegments returns single passthrough for empty segments", () => {
    expect(sliceByArrSegments(3, 9, [])).toEqual([
      { masterStartS: 3, masterEndS: 9, arrStartS: 3, arrEndS: 9 },
    ]);
  });

  it("sliceByArrSegments emits one slice per intersecting segment", () => {
    // cam covers master 5..70. segments are 10..20, 50..65, 30..35.
    const slices = sliceByArrSegments(5, 70, SEGS);
    expect(slices).toEqual([
      { masterStartS: 10, masterEndS: 20, arrStartS: 0, arrEndS: 10 },
      { masterStartS: 50, masterEndS: 65, arrStartS: 10, arrEndS: 25 },
      { masterStartS: 30, masterEndS: 35, arrStartS: 25, arrEndS: 30 },
    ]);
  });

  it("sliceByArrSegments clips partial overlaps", () => {
    // cam covers master 12..55 — partial on chunk-A (12..20) and chunk-B
    // (50..55), and full of chunk-C since C is at master 30..35 inside the
    // cam range.
    const slices = sliceByArrSegments(12, 55, SEGS);
    expect(slices).toEqual([
      { masterStartS: 12, masterEndS: 20, arrStartS: 2, arrEndS: 10 },
      { masterStartS: 50, masterEndS: 55, arrStartS: 10, arrEndS: 15 },
      { masterStartS: 30, masterEndS: 35, arrStartS: 25, arrEndS: 30 },
    ]);
  });
});
