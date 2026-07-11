import { describe, expect, it } from "vitest";
import {
  decidePillPointerDown,
  type PillHitZone,
  type PillPointerDecision,
} from "./pill-pointer";
import type { SnapMode } from "../../../core/snap";

const ZONES: PillHitZone[] = ["left", "right", "body", "reset"];
const SNAP_MODES: SnapMode[] = ["off", "match", "1", "1/2", "1/4", "1/8", "1/16"];

function decide(over: {
  zone?: PillHitZone;
  loopActive?: boolean;
  lanesLocked?: boolean;
  snapMode?: SnapMode;
}): PillPointerDecision {
  return decidePillPointerDown({
    zone: over.zone ?? "body",
    loopActive: over.loopActive ?? false,
    lanesLocked: over.lanesLocked ?? true,
    snapMode: over.snapMode ?? "off",
  });
}

describe("decidePillPointerDown", () => {
  // ── THE project invariant (regressed once as a user-reported bug):
  // while a loop is engaged, clicking a pill selects it but NEVER
  // seeks — a seek outside the loop region makes the audio walker's
  // immediate-wrap yank playback back to loop.start, so the picked
  // pill could never be auditioned.
  describe("loop active → select only, never seek", () => {
    it("locked pill click with loop active selects without seek or drag", () => {
      const d = decide({ lanesLocked: true, loopActive: true, zone: "body" });
      expect(d).toEqual({ kind: "select", seek: false, drag: null });
    });

    it("no combination of zone/lock/snap seeks while a loop is active", () => {
      for (const zone of ZONES) {
        for (const lanesLocked of [true, false]) {
          for (const snapMode of SNAP_MODES) {
            const d = decide({ zone, lanesLocked, loopActive: true, snapMode });
            if (d.kind === "select") {
              expect(d.seek).toBe(false);
            }
          }
        }
      }
    });
  });

  describe("locked lanes (default)", () => {
    it("pill click without loop scrubs: select + seek + playhead drag", () => {
      const d = decide({ lanesLocked: true, loopActive: false });
      expect(d).toEqual({ kind: "select", seek: true, drag: "playhead" });
    });

    it("edge zones behave like body under lock (no trim drag)", () => {
      for (const zone of ["left", "right"] as const) {
        expect(decide({ lanesLocked: true, loopActive: false, zone })).toEqual({
          kind: "select",
          seek: true,
          drag: "playhead",
        });
      }
    });
  });

  describe("unlocked lanes", () => {
    it("left edge starts trim-in drag, no seek", () => {
      expect(decide({ lanesLocked: false, zone: "left" })).toEqual({
        kind: "select",
        seek: false,
        drag: "pill-trim-in",
      });
    });

    it("right edge starts trim-out drag, no seek", () => {
      expect(decide({ lanesLocked: false, zone: "right" })).toEqual({
        kind: "select",
        seek: false,
        drag: "pill-trim-out",
      });
    });

    it("body starts pill-move drag, no seek", () => {
      expect(decide({ lanesLocked: false, zone: "body" })).toEqual({
        kind: "select",
        seek: false,
        drag: "pill-move",
      });
    });

    it("body with MATCH snap promotes to cam-track-move", () => {
      expect(
        decide({ lanesLocked: false, zone: "body", snapMode: "match" }),
      ).toEqual({ kind: "select", seek: false, drag: "cam-track-move" });
    });

    it("MATCH promotion applies only to the body zone", () => {
      expect(
        decide({ lanesLocked: false, zone: "left", snapMode: "match" }),
      ).toEqual({ kind: "select", seek: false, drag: "pill-trim-in" });
      expect(
        decide({ lanesLocked: false, zone: "right", snapMode: "match" }),
      ).toEqual({ kind: "select", seek: false, drag: "pill-trim-out" });
    });

    it("unlocked drags never seek regardless of loop", () => {
      for (const zone of ["left", "right", "body"] as const) {
        for (const loopActive of [true, false]) {
          const d = decide({ lanesLocked: false, zone, loopActive });
          expect(d.kind).toBe("select");
          if (d.kind === "select") expect(d.seek).toBe(false);
        }
      }
    });
  });

  describe("reset button", () => {
    it("fires regardless of lock state, loop, and snap mode", () => {
      for (const lanesLocked of [true, false]) {
        for (const loopActive of [true, false]) {
          for (const snapMode of SNAP_MODES) {
            expect(
              decide({ zone: "reset", lanesLocked, loopActive, snapMode }),
            ).toEqual({ kind: "reset-pill" });
          }
        }
      }
    });
  });
});
