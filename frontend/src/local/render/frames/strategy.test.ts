import { describe, expect, it } from "vitest";
import { planTileStrip } from "./strategy";

describe("planTileStrip — adaptive sampling", () => {
  it("uses 0.5s step for short videos (≤60s)", () => {
    const plan = planTileStrip({ durationS: 30, sourceWidth: 1920, sourceHeight: 1080 });
    expect(plan.timestampsS.length).toBe(60); // 30 / 0.5
    // Centred sampling: first tile at 0.25s.
    expect(plan.timestampsS[0]).toBeCloseTo(0.25, 5);
    expect(plan.timestampsS[plan.timestampsS.length - 1]).toBeLessThan(30);
  });

  it("uses 1s step for medium videos (≤600s) up to the maxTiles cap", () => {
    // 120 / 1.0 = 120 raw tiles → capped to default maxTiles=100.
    const plan = planTileStrip({ durationS: 120, sourceWidth: 1920, sourceHeight: 1080 });
    expect(plan.timestampsS.length).toBe(100);

    // Below the cap, we get the natural step.
    const sub = planTileStrip({ durationS: 90, sourceWidth: 1920, sourceHeight: 1080 });
    expect(sub.timestampsS.length).toBe(90);
  });

  it("uses 5s step for long videos (10–30 min)", () => {
    const plan = planTileStrip({ durationS: 1200, sourceWidth: 1920, sourceHeight: 1080 });
    // 1200 / 5 = 240 → would exceed maxTiles=100 default → cap kicks in.
    expect(plan.timestampsS.length).toBeLessThanOrEqual(100);
  });

  it("uses 10s step for very long videos (>30 min)", () => {
    const plan = planTileStrip({ durationS: 3600, sourceWidth: 1920, sourceHeight: 1080 });
    // 3600 / 10 = 360 → cap kicks in.
    expect(plan.timestampsS.length).toBeLessThanOrEqual(100);
  });

  it("caps tile count at maxTiles by widening the step", () => {
    const plan = planTileStrip({
      durationS: 1200,
      sourceWidth: 1920,
      sourceHeight: 1080,
      maxTiles: 200,
    });
    expect(plan.timestampsS.length).toBe(200);
    // Last tile is somewhere within the source duration.
    expect(plan.timestampsS[plan.timestampsS.length - 1]).toBeLessThan(1200);
    expect(plan.timestampsS[plan.timestampsS.length - 1]).toBeGreaterThan(1100);
  });

  it("default cap is 100 tiles", () => {
    const plan = planTileStrip({
      durationS: 10_000,
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(plan.timestampsS.length).toBe(100);
  });

  it("derives tile width from source aspect (landscape)", () => {
    const plan = planTileStrip({ durationS: 30, sourceWidth: 1920, sourceHeight: 1080 });
    // 80 * (1920/1080) ≈ 142 → rounded to even → 142.
    expect(plan.tileWidth).toBe(142);
    expect(plan.tileHeight).toBe(80);
  });

  it("derives tile width from source aspect (portrait)", () => {
    const plan = planTileStrip({ durationS: 30, sourceWidth: 1080, sourceHeight: 1920 });
    // 80 * (1080/1920) = 45 → rounded to even → 44.
    expect(plan.tileWidth).toBe(44);
    expect(plan.tileHeight).toBe(80);
  });

  it("derives tile width from source aspect (square)", () => {
    const plan = planTileStrip({ durationS: 30, sourceWidth: 1080, sourceHeight: 1080 });
    expect(plan.tileWidth).toBe(80);
  });

  it("returns empty plan for zero duration", () => {
    const plan = planTileStrip({ durationS: 0, sourceWidth: 1920, sourceHeight: 1080 });
    expect(plan.timestampsS).toEqual([]);
  });

  it("respects custom tileHeight", () => {
    const plan = planTileStrip({
      durationS: 30,
      sourceWidth: 1920,
      sourceHeight: 1080,
      tileHeight: 120,
    });
    expect(plan.tileHeight).toBe(120);
    // 120 * (1920/1080) ≈ 213 → rounded to even → 212.
    expect(plan.tileWidth).toBe(212);
  });
});
