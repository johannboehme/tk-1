/**
 * Per-cam LaneHeader callbacks — identity stability + behavior.
 *
 * LaneHeader is memo()ed; handing it five fresh closures per Timeline
 * render (60 Hz during playback) would defeat the memo. The cache must
 * return the SAME function identities for a cam across renders, and the
 * handlers must reproduce the exact TAKE/reset/select semantics the
 * inline closures had (read the store via getState() at call time).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLaneCallbacksCache } from "./lane-callbacks";
import { useEditorStore } from "../../store";

const baseJobMeta = {
  id: "j-lane-cb",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1,
};

function loadTwoCams() {
  useEditorStore.getState().loadJob(baseJobMeta, {
    clips: [
      {
        id: "cam-1",
        filename: "a.mp4",
        color: "#E4572E",
        sourceDurationS: 60,
        syncOffsetMs: 0,
      },
      {
        id: "cam-2",
        filename: "b.mp4",
        color: "#2E86AB",
        sourceDurationS: 60,
        syncOffsetMs: 0,
      },
    ],
  });
}

describe("createLaneCallbacksCache", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    loadTwoCams();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeCache(onDelete?: (camId: string) => void) {
    return createLaneCallbacksCache(new Map(), () => onDelete);
  }

  test("returns identical callback objects for the same cam across calls", () => {
    const cache = makeCache();
    const a1 = cache("cam-1");
    const a2 = cache("cam-1");
    expect(a2).toBe(a1);
    expect(a2.onTakeStart).toBe(a1.onTakeStart);
    expect(a2.onTakeFinish).toBe(a1.onTakeFinish);
    expect(a2.onSelectClip).toBe(a1.onSelectClip);
    expect(a2.onReset).toBe(a1.onReset);
    expect(a2.onDelete).toBe(a1.onDelete);
    expect(cache("cam-2")).not.toBe(a1);
  });

  test("onSelectClip targets its cam", () => {
    const cache = makeCache();
    cache("cam-2").onSelectClip();
    expect(useEditorStore.getState().selectedClipId).toBe("cam-2");
  });

  test("onTakeStart fires the immediate cut and begins the hold", () => {
    // cam-2: a cut to the already-active cam (cam-1 covers t=0 onward)
    // is a no-op by design, so take the OTHER cam to observe the cut.
    const cache = makeCache();
    useEditorStore.getState().setPlayhead(3, 3);
    cache("cam-2").onTakeStart();
    const s = useEditorStore.getState();
    expect(s.holdGesture?.camId).toBe("cam-2");
    expect(s.holdGesture?.painting).toBe(false);
    expect(s.cuts.some((c) => c.camId === "cam-2")).toBe(true);
  });

  test("holding past 500 ms promotes to paint; finish applies and ends the hold", () => {
    const cache = makeCache();
    useEditorStore.getState().setPlayhead(3, 3);
    cache("cam-1").onTakeStart();
    vi.advanceTimersByTime(600);
    expect(useEditorStore.getState().holdGesture?.painting).toBe(true);
    useEditorStore.getState().setPlayhead(8, 8);
    cache("cam-1").onTakeFinish();
    expect(useEditorStore.getState().holdGesture).toBeNull();
  });

  test("a tap release (before promote) cancels the pending promote timer", () => {
    const cache = makeCache();
    useEditorStore.getState().setPlayhead(3, 3);
    cache("cam-1").onTakeStart();
    cache("cam-1").onTakeFinish();
    expect(useEditorStore.getState().holdGesture).toBeNull();
    vi.advanceTimersByTime(600);
    // Timer was cleared — no stale promote on a hold that ended.
    expect(useEditorStore.getState().holdGesture).toBeNull();
  });

  test("single-active-hold guard: a second cam's TAKE while one is held is ignored", () => {
    const cache = makeCache();
    useEditorStore.getState().setPlayhead(3, 3);
    cache("cam-1").onTakeStart();
    const cutsAfterFirst = useEditorStore.getState().cuts.length;
    cache("cam-2").onTakeStart();
    const s = useEditorStore.getState();
    expect(s.holdGesture?.camId).toBe("cam-1");
    expect(s.cuts.length).toBe(cutsAfterFirst);
  });

  test("stale onTakeFinish for a different cam does not touch the active hold", () => {
    const cache = makeCache();
    useEditorStore.getState().setPlayhead(3, 3);
    cache("cam-1").onTakeStart();
    cache("cam-2").onTakeFinish();
    expect(useEditorStore.getState().holdGesture?.camId).toBe("cam-1");
  });

  test("onReset reverts the cam's alignment override", () => {
    const cache = makeCache();
    useEditorStore.getState().setSelectedClipId("cam-1");
    useEditorStore.getState().setClipSyncOverride("cam-1", 120);
    cache("cam-1").onReset();
    const clip = useEditorStore.getState().clips.find((c) => c.id === "cam-1");
    expect(clip && "syncOverrideMs" in clip ? clip.syncOverrideMs : NaN).toBe(0);
  });

  test("onDelete resolves the CURRENT handler at call time (no stale prop capture)", () => {
    let handler: ((camId: string) => void) | undefined;
    const cache = createLaneCallbacksCache(new Map(), () => handler);
    const cb = cache("cam-1");
    cb.onDelete(); // no handler yet → no-op, no throw
    const spy = vi.fn();
    handler = spy;
    cb.onDelete(); // SAME function identity now reaches the new handler
    expect(spy).toHaveBeenCalledWith("cam-1");
  });
});
