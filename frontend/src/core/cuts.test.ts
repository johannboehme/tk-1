import { describe, it, expect } from "vitest";
import { activeCamAt, type CamRange } from "./cuts";
import type { Cut } from "../storage/jobs-db";

const cam = (id: string, startS: number, endS: number): CamRange => ({
  id,
  startS,
  endS,
});

describe("activeCamAt", () => {
  describe("empty cuts list", () => {
    it("returns null when there are no cams at all", () => {
      expect(activeCamAt([], 5, [])).toBeNull();
    });

    it("returns the only cam when it has material at t", () => {
      expect(activeCamAt([], 5, [cam("a", 0, 10)])).toBe("a");
    });

    it("returns null when the only cam has no material at t", () => {
      expect(activeCamAt([], 15, [cam("a", 0, 10)])).toBeNull();
    });

    it("returns the first cam (by index) that has material at t", () => {
      const cams = [cam("a", 20, 30), cam("b", 0, 10), cam("c", 5, 15)];
      // t=7 is in b and c; b comes first by index → b wins
      expect(activeCamAt([], 7, cams)).toBe("b");
    });
  });

  describe("with cuts", () => {
    const cams = [cam("a", 0, 20), cam("b", 0, 20)];

    it("uses the latest cut whose atTimeS ≤ t", () => {
      const cuts: Cut[] = [
        { atTimeS: 0, camId: "a" },
        { atTimeS: 5, camId: "b" },
      ];
      expect(activeCamAt(cuts, 6, cams)).toBe("b");
    });

    it("treats the cut boundary inclusively (atTimeS === t means cut applies)", () => {
      const cuts: Cut[] = [{ atTimeS: 5, camId: "b" }];
      expect(activeCamAt(cuts, 5, cams)).toBe("b");
    });

    it("falls back to default when t is before any cut", () => {
      const cuts: Cut[] = [{ atTimeS: 5, camId: "b" }];
      // t=2 is before the first cut → use default (first cam by index with material)
      expect(activeCamAt(cuts, 2, cams)).toBe("a");
    });

    it("falls back to first-cam-with-material if the chosen cam has no material at t", () => {
      const camsLimited = [cam("a", 0, 20), cam("b", 0, 5)];
      const cuts: Cut[] = [{ atTimeS: 0, camId: "b" }];
      // cut says b, but b ends at 5; t=7 → fall back to a (first cam with material)
      expect(activeCamAt(cuts, 7, camsLimited)).toBe("a");
    });

    it("returns null when neither the cut target nor any other cam has material", () => {
      const camsLimited = [cam("a", 0, 5), cam("b", 0, 5)];
      const cuts: Cut[] = [{ atTimeS: 0, camId: "a" }];
      expect(activeCamAt(cuts, 10, camsLimited)).toBeNull();
    });

    it("ignores cuts to a non-existent camId (treats as if not there)", () => {
      const cuts: Cut[] = [
        { atTimeS: 0, camId: "a" },
        { atTimeS: 5, camId: "ghost" }, // unknown cam
      ];
      // ghost cut is ignored → still on a (last valid cut)
      expect(activeCamAt(cuts, 7, cams)).toBe("a");
    });

    it("works with unsorted cuts input (defensive)", () => {
      const cuts: Cut[] = [
        { atTimeS: 10, camId: "a" },
        { atTimeS: 5, camId: "b" },
        { atTimeS: 0, camId: "a" },
      ];
      expect(activeCamAt(cuts, 7, cams)).toBe("b");
      expect(activeCamAt(cuts, 12, cams)).toBe("a");
    });

    it("returns the cut target even when another cam also has material (priority over default)", () => {
      const cuts: Cut[] = [{ atTimeS: 0, camId: "b" }];
      // both a and b have material; cut says b → b wins, no fallback to first
      expect(activeCamAt(cuts, 5, cams)).toBe("b");
    });
  });

  describe("interval semantics", () => {
    it("treats the cam endS as exclusive — t === endS means no material", () => {
      expect(activeCamAt([], 10, [cam("a", 0, 10)])).toBeNull();
    });

    it("treats the cam startS as inclusive — t === startS means material", () => {
      expect(activeCamAt([], 5, [cam("a", 5, 15)])).toBe("a");
    });
  });
});
