/**
 * Undo/redo history for the editor document slice (#69).
 *
 * The history module subscribes to the zustand store, coalesces bursts
 * of changes (drags, holds) into single entries via an idle window, and
 * restores snapshots through the store so auto-persist sees them.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useEditorStore } from "./store";
import {
  flushPendingHistory,
  initEditorHistory,
  redoEdit,
  resetEditorHistory,
  undoEdit,
} from "./history";
import { persistRelevantChanged } from "./useAutoPersist";
import type { Pill } from "./types";

const baseJobMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1,
  bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
};

const twoCams = [
  {
    id: "cam1",
    filename: "a.mp4",
    color: "#f00",
    sourceDurationS: 60,
    syncOffsetMs: 0,
  },
  {
    id: "cam2",
    filename: "b.mp4",
    color: "#0f0",
    sourceDurationS: 60,
    syncOffsetMs: 0,
  },
];

/** Advance past the idle window so the pending burst finalizes. */
function settle() {
  vi.advanceTimersByTime(1000);
}

function makePill(id: string, camId: string, arrStartS: number): Pill {
  const len = 5;
  return {
    id,
    camId,
    arrStartS,
    arrEndS: arrStartS + len,
    sourceInS: 0,
    sourceOutS: len,
    originalArrStartS: arrStartS,
    originalArrEndS: arrStartS + len,
    originalSourceInS: 0,
    originalSourceOutS: len,
  };
}

let dispose: (() => void) | null = null;

describe("editor history (undo/redo)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(baseJobMeta, { clips: twoCams });
    dispose = initEditorHistory();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    resetEditorHistory();
    vi.useRealTimers();
  });

  test("clearCuts is undoable and redoable", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 1, camId: "cam2" });
    s.addCut({ atTimeS: 2, camId: "cam1" });
    settle();
    const before = useEditorStore.getState().cuts;
    expect(before).toHaveLength(2);

    useEditorStore.getState().clearCuts();
    settle();
    expect(useEditorStore.getState().cuts).toHaveLength(0);

    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts).toEqual(before);

    expect(redoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts).toHaveLength(0);
  });

  test("clearAllFx + clearCuts in one burst is ONE entry (X-clear)", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 1, camId: "cam2" });
    s.addFx("vignette", 2, 3);
    settle();
    const cutsBefore = useEditorStore.getState().cuts;
    const fxBefore = useEditorStore.getState().fx;

    // commitXClear does exactly this — both wipes land in one burst.
    useEditorStore.getState().clearAllFx();
    useEditorStore.getState().clearCuts();
    settle();

    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts).toEqual(cutsBefore);
    expect(useEditorStore.getState().fx).toEqual(fxBefore);
    // The undo toast names both surfaces.
    expect(useEditorStore.getState().notice?.message).toMatch(/Undo/);
    expect(useEditorStore.getState().notice?.message).toMatch(/cuts/);
    expect(useEditorStore.getState().notice?.message).toMatch(/FX/);
  });

  test("rapid drag ticks coalesce into a single entry", () => {
    useEditorStore.getState().setPills([makePill("p1", "cam1", 0)]);
    settle();
    const s = useEditorStore.getState();
    // Simulate a pointer drag: many placement writes within the window.
    s.setPillArrPlacement("p1", 1);
    s.setPillArrPlacement("p1", 2);
    s.setPillArrPlacement("p1", 3);
    settle();
    expect(useEditorStore.getState().history.undoDepth).toBe(2); // setPills + drag
    expect(undoEdit()).toBe(true);
    const p = useEditorStore.getState().pills.find((x) => x.id === "p1");
    expect(p?.arrStartS).toBe(0);
  });

  test("a hold-paint gesture is one entry; finalize waits for gesture end", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 5, camId: "cam2" });
    settle();
    const before = useEditorStore.getState().cuts;

    s.beginHoldGesture("cam1", 1);
    s.addCut({ atTimeS: 1, camId: "cam1" });
    settle(); // gesture active — must NOT finalize yet
    expect(useEditorStore.getState().history.undoDepth).toBe(1);
    useEditorStore.getState().promoteHoldToPaint();
    useEditorStore.getState().overwriteCutsRange("cam1", 1, 3);
    useEditorStore.getState().overwriteCutsRange("cam1", 1, 6);
    const hold = useEditorStore.getState().holdGesture!;
    useEditorStore.getState().applyHoldRelease("cam1", 1, 6, hold.priorCuts);
    useEditorStore.getState().endHoldGesture();
    settle();

    expect(useEditorStore.getState().history.undoDepth).toBe(2);
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts).toEqual(before);
  });

  test("a cancelled hold produces no history entry", () => {
    const s = useEditorStore.getState();
    s.beginHoldGesture("cam1", 1);
    s.addCut({ atTimeS: 1, camId: "cam1" });
    useEditorStore.getState().cancelHold();
    settle();
    expect(useEditorStore.getState().history.undoDepth).toBe(0);
    expect(undoEdit()).toBe(false);
    expect(useEditorStore.getState().notice?.message).toMatch(/Nothing to undo/);
  });

  test("undo during an active gesture is a no-op", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    s.beginHoldGesture("cam1", 2);
    expect(undoEdit()).toBe(false);
    useEditorStore.getState().cancelHold();
  });

  test("quantize commit is a single undo entry", () => {
    const s = useEditorStore.getState();
    s.setSnapMode("1");
    s.addCut({ atTimeS: 0.7, camId: "cam2" });
    settle();
    useEditorStore.getState().buildAndStartQuantizePreview();
    useEditorStore.getState().commitQuantizePreview();
    settle();
    const snapped = useEditorStore.getState().cuts[0].atTimeS;
    expect(snapped).not.toBe(0.7);
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts[0].atTimeS).toBe(0.7);
  });

  test("undo marks the store dirty for auto-persist", () => {
    useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    useEditorStore.getState().clearCuts();
    settle();
    const before = useEditorStore.getState();
    expect(undoEdit()).toBe(true);
    const after = useEditorStore.getState();
    expect(persistRelevantChanged(after, before)).toBe(true);
  });

  test("a new edit clears the redo stack", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    useEditorStore.getState().clearCuts();
    settle();
    undoEdit();
    expect(useEditorStore.getState().history.redoDepth).toBe(1);
    // cam2 is active from t=1 after the undo — cut to cam1 so the store
    // actually records a change.
    useEditorStore.getState().addCut({ atTimeS: 3, camId: "cam1" });
    settle();
    expect(useEditorStore.getState().history.redoDepth).toBe(0);
    expect(redoEdit()).toBe(false);
  });

  test("history is bounded at 100 entries", () => {
    for (let i = 0; i < 110; i++) {
      useEditorStore.getState().setMasterAudioVolume(i % 2 === 0 ? 0.5 : 1.5);
      settle();
    }
    expect(useEditorStore.getState().history.undoDepth).toBe(100);
  });

  test("loop edits are undoable", () => {
    useEditorStore.getState().setLoop({ start: 1, end: 3 });
    settle();
    useEditorStore.getState().setLoop(null);
    settle();
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().playback.loop).toEqual({ start: 1, end: 3 });
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().playback.loop).toBeNull();
  });

  test("BPM override (grid) is undoable", () => {
    useEditorStore.getState().setBpm({ value: 99, manualOverride: true });
    settle();
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().jobMeta?.bpm?.value).toBe(120);
    expect(useEditorStore.getState().jobMeta?.bpm?.manualOverride).toBe(false);
  });

  test("clip trim restore merges per id; removed cams stay removed", () => {
    const s = useEditorStore.getState();
    s.setVideoClipTrim("cam1", 5, 30);
    settle();
    useEditorStore.getState().setVideoClipTrim("cam1", 10, 20);
    settle();
    // Remove cam2 AFTER the snapshots were taken; undo must not resurrect it.
    useEditorStore.getState().removeClip("cam2");
    settle();
    // Cam add/remove is a job-level operation — it creates NO entry.
    expect(useEditorStore.getState().history.undoDepth).toBe(2);
    expect(undoEdit()).toBe(true); // undo the second trim
    const cam1 = useEditorStore.getState().clips.find((c) => c.id === "cam1");
    expect(cam1 && "trimInS" in cam1 ? cam1.trimInS : null).toBe(5);
    expect(useEditorStore.getState().clips.find((c) => c.id === "cam2")).toBeUndefined();
  });

  test("restored cuts/pills referencing removed cams are filtered out", () => {
    const s = useEditorStore.getState();
    s.addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    useEditorStore.getState().clearCuts();
    settle();
    useEditorStore.getState().removeClip("cam2");
    settle();
    // Undo past the removal: the pre-clear snapshot holds a cam2 cut,
    // but cam2 no longer exists — the cut must not come back.
    undoEdit();
    undoEdit();
    expect(
      useEditorStore.getState().cuts.some((c) => c.camId === "cam2"),
    ).toBe(false);
  });

  test("display-dims and other non-document writes create no entries", () => {
    useEditorStore.getState().setClipDisplayDims("cam1", 640, 480);
    useEditorStore.getState().setCurrentTime(3);
    useEditorStore.getState().setZoom(4);
    settle();
    expect(useEditorStore.getState().history.undoDepth).toBe(0);
  });

  test("flushPendingHistory finalizes immediately (undo without waiting)", () => {
    useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
    flushPendingHistory();
    expect(useEditorStore.getState().history.undoDepth).toBe(1);
    // undoEdit also self-flushes: make an edit and undo it right away.
    useEditorStore.getState().clearCuts();
    expect(undoEdit()).toBe(true);
    expect(useEditorStore.getState().cuts).toHaveLength(1);
  });

  test("depths mirror into store.history for the transport buttons", () => {
    expect(useEditorStore.getState().history).toEqual({
      undoDepth: 0,
      redoDepth: 0,
    });
    useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    expect(useEditorStore.getState().history).toEqual({
      undoDepth: 1,
      redoDepth: 0,
    });
    undoEdit();
    expect(useEditorStore.getState().history).toEqual({
      undoDepth: 0,
      redoDepth: 1,
    });
    redoEdit();
    expect(useEditorStore.getState().history).toEqual({
      undoDepth: 1,
      redoDepth: 0,
    });
  });

  test("loading another job resets history", () => {
    useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
    settle();
    expect(useEditorStore.getState().history.undoDepth).toBe(1);
    useEditorStore
      .getState()
      .loadJob({ ...baseJobMeta, id: "j2" }, { clips: twoCams });
    expect(useEditorStore.getState().history.undoDepth).toBe(0);
    expect(undoEdit()).toBe(false);
  });
});
