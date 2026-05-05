import { describe, it, expect } from "vitest";
import { autoFollowScrollX } from "./triage-auto-follow";

describe("autoFollowScrollX", () => {
  const audioDuration = 600; // 10 min

  it("returns null when the chunk is already fully visible", () => {
    expect(
      autoFollowScrollX({
        chunkStartS: 110,
        chunkEndS: 130,
        viewStartS: 100,
        viewEndS: 200,
        audioDuration,
      }),
    ).toBeNull();
  });

  it("centres a chunk that sits to the right of the current view", () => {
    // Chunk at [400, 420], visible window [100, 200] (100s wide).
    // Centre: 410, view should land at 410 - 50 = 360.
    expect(
      autoFollowScrollX({
        chunkStartS: 400,
        chunkEndS: 420,
        viewStartS: 100,
        viewEndS: 200,
        audioDuration,
      }),
    ).toBe(360);
  });

  it("centres a chunk that sits to the left of the current view", () => {
    // Chunk at [10, 30], visible window [200, 300] (100s wide).
    // Centre: 20, view would want 20 - 50 = -30, clamped to 0.
    expect(
      autoFollowScrollX({
        chunkStartS: 10,
        chunkEndS: 30,
        viewStartS: 200,
        viewEndS: 300,
        audioDuration,
      }),
    ).toBe(0);
  });

  it("clamps to the right edge when centring would scroll past audio end", () => {
    // Chunk at [580, 590], visible window [100, 200] (100s wide), audio 600s.
    // Centre: 585 - 50 = 535. Max scroll: 600 - 100 = 500. Clamp → 500.
    expect(
      autoFollowScrollX({
        chunkStartS: 580,
        chunkEndS: 590,
        viewStartS: 100,
        viewEndS: 200,
        audioDuration,
      }),
    ).toBe(500);
  });

  it("for chunks longer than the view, puts the chunk start at the left edge", () => {
    // Chunk at [300, 500] (200s long), visible window 100s wide.
    expect(
      autoFollowScrollX({
        chunkStartS: 300,
        chunkEndS: 500,
        viewStartS: 0,
        viewEndS: 100,
        audioDuration,
      }),
    ).toBe(300);
  });

  it("returns null when the visible window is degenerate (zero or negative)", () => {
    expect(
      autoFollowScrollX({
        chunkStartS: 0,
        chunkEndS: 10,
        viewStartS: 100,
        viewEndS: 100,
        audioDuration,
      }),
    ).toBeNull();
  });

  it("returns null when the chunk straddles the view but not fully (partial visibility skipped)", () => {
    // Trick: this assertion documents that partial visibility still
    // triggers a re-centre — the user wants to see the WHOLE focused
    // chunk, not just a sliver.
    // Chunk [180, 220], visible [100, 200]. Right edge clipped.
    // Result: centre 200 - 50 = 150.
    expect(
      autoFollowScrollX({
        chunkStartS: 180,
        chunkEndS: 220,
        viewStartS: 100,
        viewEndS: 200,
        audioDuration,
      }),
    ).toBe(150);
  });
});
