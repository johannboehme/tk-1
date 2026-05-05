import { describe, expect, test } from "vitest";
import { nextLoopWrapMasterT, clampLoopToBounds } from "./arrangement-loop";
import type { Segment } from "./types";

describe("nextLoopWrapMasterT", () => {
  test("single synthetic segment (direct-mode equivalent) — arr-time == master-time", () => {
    const segs: Segment[] = [{ in: 0, out: 10 }];
    expect(nextLoopWrapMasterT({ start: 1, end: 5 }, segs)).toEqual({
      wrapAtMasterT: 5,
      wrapTargetMasterT: 1,
      wrapInSegIdx: 0,
      targetSegIdx: 0,
    });
  });

  test("synthetic segment with non-zero in (trim region) — projects through trim", () => {
    // Direct-mode after Phase 3 will use {in: trim.in, out: trim.out}.
    // Loop in arr-time {start: 0, end: 4} should map to master {6.4, 10.4}.
    const segs: Segment[] = [{ in: 6.4, out: 12 }];
    expect(nextLoopWrapMasterT({ start: 0, end: 4 }, segs)).toEqual({
      wrapAtMasterT: 10.4,
      wrapTargetMasterT: 6.4,
      wrapInSegIdx: 0,
      targetSegIdx: 0,
    });
  });

  test("multi-segment, loop fully within one segment", () => {
    const segs: Segment[] = [
      { in: 10, out: 15 },
      { in: 20, out: 25 },
    ];
    // arr-times: seg0 = [0..5], seg1 = [5..10]. loop = {1, 4} → master {11, 14}.
    expect(nextLoopWrapMasterT({ start: 1, end: 4 }, segs)).toEqual({
      wrapAtMasterT: 14,
      wrapTargetMasterT: 11,
      wrapInSegIdx: 0,
      targetSegIdx: 0,
    });
  });

  test("multi-segment, loop spans segment boundary", () => {
    const segs: Segment[] = [
      { in: 10, out: 15 },
      { in: 20, out: 25 },
    ];
    // arr=2 → seg0 master 12. arr=8 → seg1 master 23.
    expect(nextLoopWrapMasterT({ start: 2, end: 8 }, segs)).toEqual({
      wrapAtMasterT: 23,
      wrapTargetMasterT: 12,
      wrapInSegIdx: 1,
      targetSegIdx: 0,
    });
  });

  test("loop start exactly at segment boundary (half-open: arr=5 → seg1)", () => {
    const segs: Segment[] = [
      { in: 10, out: 15 },
      { in: 20, out: 25 },
    ];
    // arr=5 starts seg1, master 20. arr=8 → master 23.
    expect(nextLoopWrapMasterT({ start: 5, end: 8 }, segs)).toEqual({
      wrapAtMasterT: 23,
      wrapTargetMasterT: 20,
      wrapInSegIdx: 1,
      targetSegIdx: 1,
    });
  });

  test("loop end exactly at total arr duration → clamps to last segment", () => {
    const segs: Segment[] = [
      { in: 10, out: 15 },
      { in: 20, out: 25 },
    ];
    // totalArr = 10. loop.end = 10 hits half-open boundary; clamp to last seg.
    expect(nextLoopWrapMasterT({ start: 0, end: 10 }, segs)).toEqual({
      wrapAtMasterT: 25,
      wrapTargetMasterT: 10,
      wrapInSegIdx: 1,
      targetSegIdx: 0,
    });
  });

  test("duplicate chunks — wrap target tied to user's chosen output position, not first occurrence", () => {
    // Same master-range used twice in the arrangement.
    const segs: Segment[] = [
      { in: 5, out: 8 },
      { in: 5, out: 8 },
    ];
    // arr-times: seg0 = [0..3], seg1 = [3..6]. loop = {1, 5}: arr=1 → seg0
    // master 6, arr=5 → seg1 master 7. The walker must wrap at master=7
    // *while in seg1*, NOT also at master=7 in seg0.
    expect(nextLoopWrapMasterT({ start: 1, end: 5 }, segs)).toEqual({
      wrapAtMasterT: 7,
      wrapTargetMasterT: 6,
      wrapInSegIdx: 1,
      targetSegIdx: 0,
    });
  });

  test("empty segments → null (defensive — walker should never call with empty)", () => {
    expect(nextLoopWrapMasterT({ start: 0, end: 1 }, [])).toBeNull();
  });

  test("null loop → null", () => {
    const segs: Segment[] = [{ in: 0, out: 10 }];
    expect(nextLoopWrapMasterT(null, segs)).toBeNull();
  });
});

describe("clampLoopToBounds", () => {
  test("no segments + trim → behaves like legacy clampLoopRegion", () => {
    expect(
      clampLoopToBounds({ start: 1, end: 2 }, [], { in: 0, out: 5 }),
    ).toEqual({ start: 1, end: 2 });
    expect(
      clampLoopToBounds({ start: 4, end: 7 }, [], { in: 0, out: 5 }),
    ).toEqual({ start: 4, end: 5 });
    expect(
      clampLoopToBounds({ start: 10, end: 12 }, [], { in: 0, out: 5 }),
    ).toBeNull();
  });

  test("with segments → clamps to [0, totalArrDuration] (arr-time domain)", () => {
    const segs: Segment[] = [
      { in: 10, out: 15 },
      { in: 20, out: 25 },
    ];
    // totalArr = 10. trim is irrelevant in arr-mode.
    expect(
      clampLoopToBounds({ start: 1, end: 5 }, segs, { in: 0, out: 100 }),
    ).toEqual({ start: 1, end: 5 });
    expect(
      clampLoopToBounds({ start: 8, end: 15 }, segs, { in: 0, out: 100 }),
    ).toEqual({ start: 8, end: 10 });
    expect(
      clampLoopToBounds({ start: -2, end: 3 }, segs, { in: 0, out: 100 }),
    ).toEqual({ start: 0, end: 3 });
  });

  test("with segments + null loop → null", () => {
    const segs: Segment[] = [{ in: 10, out: 15 }];
    expect(clampLoopToBounds(null, segs, { in: 0, out: 5 })).toBeNull();
  });

  test("with segments + loop entirely outside arr range → null", () => {
    const segs: Segment[] = [{ in: 10, out: 15 }];
    // totalArr = 5. loop [10, 20] is past it.
    expect(
      clampLoopToBounds({ start: 10, end: 20 }, segs, { in: 0, out: 100 }),
    ).toBeNull();
  });

  test("with segments + degenerate loop after clamp → null", () => {
    const segs: Segment[] = [{ in: 10, out: 15 }];
    expect(
      clampLoopToBounds({ start: 5, end: 6 }, segs, { in: 0, out: 100 }),
    ).toBeNull();
  });
});
