import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./store";
import type { Pill } from "./types";

const makePill = (overrides: Partial<Pill> = {}): Pill => ({
  id: "p1",
  camId: "cam-a",
  arrStartS: 0,
  arrEndS: 5,
  sourceInS: 0,
  sourceOutS: 5,
  originalArrStartS: 0,
  originalArrEndS: 5,
  originalSourceInS: 0,
  originalSourceOutS: 5,
  fromArrangementItemId: "a0",
  ...overrides,
});

describe("pill mutation actions", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    // Seed a clip so setPills's cam-id validation doesn't drop our pills.
    useEditorStore.setState({
      clips: [
        {
          kind: "video",
          id: "cam-a",
          filename: "cam-a.mp4",
          color: "#abc",
          sourceDurationS: 60,
          syncOffsetMs: 0,
          syncOverrideMs: 0,
          startOffsetS: 0,
          driftRatio: 1,
          candidates: [],
          selectedCandidateIdx: 0,
        },
      ],
    });
  });

  describe("setPillArrPlacement", () => {
    it("shifts arrStartS/arrEndS preserving duration; clamps below 0", () => {
      const p = makePill({ arrStartS: 5, arrEndS: 10 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().setPillArrPlacement("p1", 8);
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(8);
      expect(useEditorStore.getState().pills[0].arrEndS).toBe(13);
      // Clamp below 0 keeps the duration intact.
      useEditorStore.getState().setPillArrPlacement("p1", -3);
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(0);
      expect(useEditorStore.getState().pills[0].arrEndS).toBe(5);
    });
  });

  describe("setPillLeftEdgeArrStartS", () => {
    it("advances sourceInS by the same delta", () => {
      const p = makePill({ arrStartS: 5, arrEndS: 10, sourceInS: 1 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().setPillLeftEdgeArrStartS("p1", 6);
      const after = useEditorStore.getState().pills[0];
      expect(after.arrStartS).toBe(6);
      expect(after.sourceInS).toBeCloseTo(2, 6);
    });

    it("clamps to the right edge minus 50 ms", () => {
      const p = makePill({ arrStartS: 0, arrEndS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().setPillLeftEdgeArrStartS("p1", 10);
      // Right edge stays at 5 → clamp to 4.95.
      expect(useEditorStore.getState().pills[0].arrStartS).toBeCloseTo(4.95, 6);
    });
  });

  describe("setPillRightEdgeArrEndS", () => {
    it("retreats sourceOutS by the same delta", () => {
      const p = makePill({ arrStartS: 0, arrEndS: 5, sourceOutS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().setPillRightEdgeArrEndS("p1", 4);
      const after = useEditorStore.getState().pills[0];
      expect(after.arrEndS).toBe(4);
      expect(after.sourceOutS).toBeCloseTo(4, 6);
    });
  });

  describe("resetPill", () => {
    it("restores arr/source to originals", () => {
      const p = makePill({
        arrStartS: 12,
        arrEndS: 17,
        sourceInS: 3,
        sourceOutS: 8,
        originalArrStartS: 0,
        originalArrEndS: 5,
        originalSourceInS: 0,
        originalSourceOutS: 5,
      });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().resetPill("p1");
      expect(useEditorStore.getState().pills[0]).toMatchObject({
        arrStartS: 0,
        arrEndS: 5,
        sourceInS: 0,
        sourceOutS: 5,
      });
    });
  });

  describe("nudgePillSourceMs", () => {
    it("shifts sourceIn/Out by deltaMs preserving duration", () => {
      const p = makePill({ sourceInS: 2, sourceOutS: 7 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().nudgePillSourceMs("p1", 100);
      const after = useEditorStore.getState().pills[0];
      expect(after.sourceInS).toBeCloseTo(2.1, 6);
      expect(after.sourceOutS).toBeCloseTo(7.1, 6);
    });

    it("clamps sourceInS below 0", () => {
      const p = makePill({ sourceInS: 0.05, sourceOutS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().nudgePillSourceMs("p1", -200);
      expect(useEditorStore.getState().pills[0].sourceInS).toBe(0);
    });
  });

  describe("nudgeCamSourceMs", () => {
    it("shifts every pill of the cam in lockstep", () => {
      const a = makePill({ id: "a", camId: "cam-a", sourceInS: 1, sourceOutS: 3 });
      const b = makePill({ id: "b", camId: "cam-a", sourceInS: 5, sourceOutS: 7 });
      const c = makePill({ id: "c", camId: "cam-b", sourceInS: 0, sourceOutS: 2 });
      useEditorStore.setState({
        clips: [
          ...useEditorStore.getState().clips,
          {
            kind: "video",
            id: "cam-b",
            filename: "cam-b.mp4",
            color: "#def",
            sourceDurationS: 60,
            syncOffsetMs: 0,
            syncOverrideMs: 0,
            startOffsetS: 0,
            driftRatio: 1,
            candidates: [],
            selectedCandidateIdx: 0,
          },
        ],
      });
      useEditorStore.getState().setPills([a, b, c]);
      useEditorStore.getState().nudgeCamSourceMs("cam-a", 50);
      const pills = useEditorStore.getState().pills;
      expect(pills.find((p) => p.id === "a")?.sourceInS).toBeCloseTo(1.05, 6);
      expect(pills.find((p) => p.id === "b")?.sourceInS).toBeCloseTo(5.05, 6);
      // Other cam untouched.
      expect(pills.find((p) => p.id === "c")?.sourceInS).toBe(0);
    });
  });

  describe("undo / redo via commitPillEdit", () => {
    it("undoPillEdit restores the snapshot pushed before the change", () => {
      const p = makePill({ arrStartS: 0, arrEndS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().commitPillEdit();
      useEditorStore.getState().setPillArrPlacement("p1", 7);
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(7);
      useEditorStore.getState().undoPillEdit();
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(0);
    });

    it("redoPillEdit re-applies the undone change", () => {
      const p = makePill({ arrStartS: 0, arrEndS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().commitPillEdit();
      useEditorStore.getState().setPillArrPlacement("p1", 7);
      useEditorStore.getState().undoPillEdit();
      useEditorStore.getState().redoPillEdit();
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(7);
    });

    it("commitPillEdit clears the redo future", () => {
      const p = makePill({ arrStartS: 0, arrEndS: 5 });
      useEditorStore.getState().setPills([p]);
      // Commit + edit + undo gives us a populated redo future.
      useEditorStore.getState().commitPillEdit();
      useEditorStore.getState().setPillArrPlacement("p1", 3);
      useEditorStore.getState().undoPillEdit();
      expect(useEditorStore.getState().pillFuture.length).toBe(1);
      // A new commit clears it — the user took a fresh branch.
      useEditorStore.getState().commitPillEdit();
      expect(useEditorStore.getState().pillFuture.length).toBe(0);
    });

    it("undo with empty history is a no-op", () => {
      const p = makePill({ arrStartS: 5 });
      useEditorStore.getState().setPills([p]);
      useEditorStore.getState().undoPillEdit();
      expect(useEditorStore.getState().pills[0].arrStartS).toBe(5);
    });
  });
});
