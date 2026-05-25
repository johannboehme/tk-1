import { describe, expect, test } from "vitest";
import { clampSegmentsToContent } from "./clamp-segments";

describe("clampSegmentsToContent", () => {
  test("drops the trailing test-pattern gap when audio outruns video", () => {
    // 60 s audio segment, but the cam only covers 0–30 s.
    const out = clampSegmentsToContent(
      [{ in: 0, out: 60 }],
      [{ startS: 0, endS: 30 }],
    );
    expect(out).toEqual([{ in: 0, out: 30 }]);
  });

  test("clamps a clip-trimmed cam to its visible window", () => {
    const out = clampSegmentsToContent(
      [{ in: 0, out: 60 }],
      [{ startS: 5, endS: 25 }],
    );
    expect(out).toEqual([{ in: 5, out: 25 }]);
  });

  test("leaves segments fully inside content untouched", () => {
    const segs = [{ in: 2, out: 20 }];
    expect(clampSegmentsToContent(segs, [{ startS: 0, endS: 30 }])).toEqual(segs);
  });

  test("spans multiple cams (union extent)", () => {
    const out = clampSegmentsToContent(
      [{ in: 0, out: 100 }],
      [
        { startS: 0, endS: 30 },
        { startS: 28, endS: 50 },
      ],
    );
    expect(out).toEqual([{ in: 0, out: 50 }]);
  });

  test("preserves extra fields on the segment", () => {
    const out = clampSegmentsToContent(
      [{ in: 0, out: 60, chunkId: "c1" }],
      [{ startS: 0, endS: 30 }],
    );
    expect(out).toEqual([{ in: 0, out: 30, chunkId: "c1" }]);
  });

  test("falls back to original when the clamp would be empty", () => {
    const segs = [{ in: 0, out: 10 }];
    // Content entirely after the segment window → no overlap → fallback.
    expect(clampSegmentsToContent(segs, [{ startS: 50, endS: 60 }])).toEqual(segs);
  });

  test("no cams → unchanged", () => {
    const segs = [{ in: 0, out: 10 }];
    expect(clampSegmentsToContent(segs, [])).toEqual(segs);
  });
});
