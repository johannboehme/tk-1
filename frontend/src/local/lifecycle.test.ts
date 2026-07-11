/**
 * Unit tests for the quota-prune planner (#64).
 *
 * `planQuotaPrune` is the pure core of the consent-based storage guard:
 * given the prune candidates (finished projects with their measured OPFS
 * sizes) and the current usage/quota, it picks the oldest-first subset
 * whose deletion would bring usage back under the low-water mark. The
 * result is what the consent dialog shows the user — nothing outside the
 * returned plan may ever be deleted.
 */
import { describe, expect, test } from "vitest";
import { planQuotaPrune, type PruneCandidate } from "./lifecycle";

function cand(
  id: string,
  createdAt: number,
  bytes: number,
): PruneCandidate {
  return { id, title: id, createdAt, bytes };
}

describe("planQuotaPrune", () => {
  test("returns empty when usage is below the high-water mark", () => {
    const plan = planQuotaPrune([cand("a", 1, 50)], 79, 100);
    expect(plan).toEqual([]);
  });

  test("returns empty when quota is unknown (0)", () => {
    expect(planQuotaPrune([cand("a", 1, 50)], 90, 0)).toEqual([]);
  });

  test("picks the oldest candidates first, only as many as needed", () => {
    // usage 90 / quota 100 → need to free 30 (down to the 60 low-water).
    const plan = planQuotaPrune(
      [cand("newest", 30, 40), cand("oldest", 10, 20), cand("mid", 20, 15)],
      90,
      100,
    );
    // oldest (20) + mid (15) = 35 ≥ 30 — newest is spared.
    expect(plan.map((p) => p.id)).toEqual(["oldest", "mid"]);
  });

  test("stops as soon as one candidate frees enough", () => {
    const plan = planQuotaPrune(
      [cand("old-big", 10, 35), cand("newer", 20, 30)],
      90,
      100,
    );
    expect(plan.map((p) => p.id)).toEqual(["old-big"]);
  });

  test("returns all candidates when even everything is not enough (best effort)", () => {
    const plan = planQuotaPrune(
      [cand("a", 10, 5), cand("b", 20, 5)],
      95,
      100,
    );
    expect(plan.map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("returns empty when there are no candidates", () => {
    expect(planQuotaPrune([], 90, 100)).toEqual([]);
  });
});
