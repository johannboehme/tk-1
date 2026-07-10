import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEditorStore } from "./store";
import {
  buildPersistPatch,
  flushEditorStateNow,
  persistRelevantChanged,
  useAutoPersist,
} from "./useAutoPersist";
import { jobsDb, type LocalJob, type VideoAsset } from "../storage/jobs-db";

const baseJob: LocalJob = {
  id: "j1",
  title: null,
  videoFilename: "v.mp4",
  audioFilename: "a.wav",
  videos: [
    {
      id: "cam-1",
      filename: "v.mp4",
      opfsPath: "jobs/j1/cam-1.mp4",
      color: "#ff0",
      sync: { offsetMs: 250, driftRatio: 1, confidence: 0.9 },
    } satisfies VideoAsset,
  ],
  createdAt: 0,
};

const meta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 250,
  driftRatio: 1,
};

describe("buildPersistPatch", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  test("merges per-cam edits into the persisted videos[] entry", () => {
    useEditorStore.getState().loadJob(meta, {
      clips: [
        {
          id: "cam-1",
          filename: "v.mp4",
          color: "#ff0",
          sourceDurationS: 60,
          syncOffsetMs: 250,
          candidates: [
            { offsetMs: 250, confidence: 0.9, overlapFrames: 1024 },
            { offsetMs: 750, confidence: 0.5, overlapFrames: 800 },
          ],
        },
      ],
    });
    useEditorStore.getState().setClipSyncOverride("cam-1", -50);
    useEditorStore.getState().setClipStartOffset("cam-1", 0.25);
    useEditorStore.getState().setSelectedCandidateIdx("cam-1", 1);

    const patch = buildPersistPatch(useEditorStore.getState(), baseJob);
    const video0 = patch.videos?.[0] as VideoAsset;
    expect(video0.syncOverrideMs).toBe(-50);
    expect(video0.startOffsetS).toBe(0.25);
    expect(video0.selectedCandidateIdx).toBe(1);
    // Existing fields (filename, color, sync) preserved.
    expect(video0.filename).toBe("v.mp4");
    expect(video0.sync?.offsetMs).toBe(250);
  });

  test("includes trim, cuts, ui, bpm in the patch", () => {
    useEditorStore.getState().loadJob({
      ...meta,
      bpm: { value: 124, confidence: 0.8, phase: 0.05, manualOverride: false },
    });
    useEditorStore.getState().setTrim({ in: 1, out: 50 });
    useEditorStore.getState().setSnapMode("1/4");
    useEditorStore.getState().setLanesLocked(true);
    useEditorStore.getState().setBpm({ value: 130, manualOverride: true });

    const patch = buildPersistPatch(useEditorStore.getState(), baseJob);
    expect(patch.trim).toEqual({ in: 1, out: 50 });
    expect(patch.ui).toEqual({ snapMode: "1/4", lanesLocked: true });
    expect(patch.bpm?.value).toBe(130);
    expect(patch.bpm?.manualOverride).toBe(true);
    // Confidence + phase carry over from the previously detected values.
    expect(patch.bpm?.confidence).toBe(0.8);
    expect(patch.bpm?.phase).toBe(0.05);
  });

  test("persists the color grade + filter stack round-trip", () => {
    useEditorStore.getState().loadJob(meta);
    useEditorStore.getState().setColorGrade({ exposure: 0.3 });
    const id = useEditorStore.getState().addFilterSlot("vhs");
    useEditorStore.getState().setFilterParam(id, "tracking", 0.7);

    const patch = buildPersistPatch(useEditorStore.getState(), baseJob);
    expect(patch.colorGrade?.exposure).toBe(0.3);
    expect(patch.filterSlots).toHaveLength(1);
    expect(patch.filterSlots?.[0].kind).toBe("vhs");
    expect(patch.filterSlots?.[0].params.tracking).toBe(0.7);
  });

  test("leaves bpm undefined when none has been detected/set yet", () => {
    useEditorStore.getState().loadJob(meta);
    const patch = buildPersistPatch(useEditorStore.getState(), baseJob);
    expect(patch.bpm).toBeUndefined();
  });

  test("does not lose existing video fields when a clip is unknown", () => {
    useEditorStore.getState().loadJob(meta, {
      clips: [
        {
          id: "cam-2", // doesn't match baseJob.videos[0].id
          filename: "v.mp4",
          color: "#ff0",
          sourceDurationS: 60,
          syncOffsetMs: 250,
        },
      ],
    });
    const patch = buildPersistPatch(useEditorStore.getState(), baseJob);
    const video0 = patch.videos?.[0] as VideoAsset;
    // cam-1 in baseJob has no matching clip → unchanged
    expect(video0.id).toBe("cam-1");
    expect(video0.syncOverrideMs).toBeUndefined();
    expect(video0.startOffsetS).toBeUndefined();
  });
});

describe("persistRelevantChanged", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  test("no-op transition schedules nothing", () => {
    useEditorStore.getState().loadJob(meta);
    const s = useEditorStore.getState();
    expect(persistRelevantChanged(s, s)).toBe(false);
  });

  test("detects every field buildPersistPatch writes — incl. pills", () => {
    useEditorStore.getState().loadJob(meta);
    const prev = useEditorStore.getState();
    // A pill-only edit (move/trim on the timeline) must schedule a
    // persist — pills are part of the patch, and losing them on refresh
    // was exactly the bug this guards against.
    const withPills = { ...prev, pills: [...prev.pills] };
    expect(persistRelevantChanged(withPills, prev)).toBe(true);

    const withCuts = { ...prev, cuts: [...prev.cuts] };
    expect(persistRelevantChanged(withCuts, prev)).toBe(true);
    const withTrim = { ...prev, trim: { ...prev.trim } };
    expect(persistRelevantChanged(withTrim, prev)).toBe(true);
    const withFx = { ...prev, fx: [...prev.fx] };
    expect(persistRelevantChanged(withFx, prev)).toBe(true);
    const withVolume = { ...prev, audioVolume: prev.audioVolume + 0.1 };
    expect(persistRelevantChanged(withVolume, prev)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// #120 — the debounced write must flush, not vanish, when the editor leaves
// -----------------------------------------------------------------------------

describe("useAutoPersist — flush semantics (#120)", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drain the microtask queue so promise-chained (non-timer) work in
   *  the hook's flush path completes under fake timers. */
  async function drainMicrotasks(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  }

  function mockDb() {
    const getJob = vi
      .spyOn(jobsDb, "getJob")
      .mockResolvedValue({ ...baseJob });
    const updateJob = vi
      .spyOn(jobsDb, "updateJob")
      .mockImplementation(async (_id, patch) => ({ ...baseJob, ...patch }));
    return { getJob, updateJob };
  }

  test("persists after the debounce window on an ordinary edit", async () => {
    const { updateJob } = mockDb();
    const { unmount } = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta); // hydration — skipped
    });
    act(() => {
      useEditorStore.getState().setTrim({ in: 2, out: 30 });
    });
    expect(updateJob).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
      await drainMicrotasks();
    });
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob.mock.calls[0][1]).toMatchObject({
      trim: { in: 2, out: 30 },
    });
    unmount();
  });

  test("unmount before the debounce fires still persists the pending edit", async () => {
    const { updateJob } = mockDb();
    const { unmount } = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta);
    });
    act(() => {
      useEditorStore.getState().setTrim({ in: 5, out: 42 });
    });
    // Leave the editor 100 ms after the edit — well inside the 300 ms
    // debounce. The old cleanup discarded the timer and the edit.
    vi.advanceTimersByTime(100);
    unmount();
    await drainMicrotasks();
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob.mock.calls[0][1]).toMatchObject({
      trim: { in: 5, out: 42 },
    });
  });

  test("unmount without a pending edit writes nothing", async () => {
    const { updateJob } = mockDb();
    const { unmount } = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta);
    });
    unmount();
    await drainMicrotasks();
    expect(updateJob).not.toHaveBeenCalled();
  });

  test("flushEditorStateNow persists the full patch immediately and cancels the pending timer", async () => {
    const { updateJob } = mockDb();
    const { unmount } = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta);
    });
    act(() => {
      useEditorStore.getState().setTrim({ in: 1, out: 9 });
    });
    await flushEditorStateNow("j1");
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob.mock.calls[0][1]).toMatchObject({
      trim: { in: 1, out: 9 },
    });
    // The debounced timer must not double-write afterwards.
    await act(async () => {
      vi.advanceTimersByTime(600);
      await drainMicrotasks();
    });
    expect(updateJob).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("pagehide flushes a pending edit (tab close mid-debounce)", async () => {
    const { updateJob } = mockDb();
    const { unmount } = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta);
    });
    act(() => {
      useEditorStore.getState().setTrim({ in: 3, out: 33 });
    });
    window.dispatchEvent(new Event("pagehide"));
    await drainMicrotasks();
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob.mock.calls[0][1]).toMatchObject({
      trim: { in: 3, out: 33 },
    });
    unmount();
  });
});

// -----------------------------------------------------------------------------
// #124 — a failed IDB write must retry (and eventually surface), not vanish
// -----------------------------------------------------------------------------

describe("useAutoPersist — write-failure retry (#124)", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    // The retry path logs each failed attempt — keep test output clean.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function drainMicrotasks(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await drainMicrotasks();
    });
  }

  function mountWithEdit() {
    const hook = renderHook(() => useAutoPersist("j1"));
    act(() => {
      useEditorStore.getState().loadJob(meta); // hydration — skipped
    });
    act(() => {
      useEditorStore.getState().setTrim({ in: 2, out: 30 });
    });
    return hook;
  }

  test("a transient failure retries WITHOUT a further user change and lands the edit", async () => {
    vi.spyOn(jobsDb, "getJob").mockResolvedValue({ ...baseJob });
    const updateJob = vi
      .spyOn(jobsDb, "updateJob")
      .mockRejectedValueOnce(new DOMException("boom", "QuotaExceededError"))
      .mockImplementation(async (_id, patch) => ({ ...baseJob, ...patch }));

    const { unmount } = mountWithEdit();
    await advance(300); // debounce fires → attempt 1 fails
    expect(updateJob).toHaveBeenCalledTimes(1);

    // The user tweaks one knob and exports — the common case. No further
    // store change happens; the retry must be self-scheduled.
    await advance(5000);
    expect(updateJob.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastPatch = updateJob.mock.calls[updateJob.mock.calls.length - 1][1];
    expect(lastPatch).toMatchObject({ trim: { in: 2, out: 30 } });
    unmount();
  });

  test("retries are bounded and a persistent failure surfaces as an editor notice", async () => {
    vi.spyOn(jobsDb, "getJob").mockResolvedValue({ ...baseJob });
    const updateJob = vi
      .spyOn(jobsDb, "updateJob")
      .mockRejectedValue(new Error("connection closed"));

    const { unmount } = mountWithEdit();
    await advance(300);
    // Walk through every retry delay generously.
    for (let i = 0; i < 8; i++) await advance(10_000);

    const attempts = updateJob.mock.calls.length;
    expect(attempts).toBeGreaterThanOrEqual(2); // it did retry
    expect(attempts).toBeLessThanOrEqual(5); // …but not forever

    // The user gets a visible signal instead of a silent loss.
    const notice = useEditorStore.getState().notice;
    expect(notice).not.toBeNull();
    expect(notice!.message.toLowerCase()).toContain("sav");
    unmount();
  });

  test("a retry picks up fresher state when the user edited meanwhile", async () => {
    vi.spyOn(jobsDb, "getJob").mockResolvedValue({ ...baseJob });
    const updateJob = vi
      .spyOn(jobsDb, "updateJob")
      .mockRejectedValueOnce(new Error("transient"))
      .mockImplementation(async (_id, patch) => ({ ...baseJob, ...patch }));

    const { unmount } = mountWithEdit();
    await advance(300); // attempt 1 fails with trim {2,30}

    act(() => {
      useEditorStore.getState().setTrim({ in: 7, out: 55 });
    });
    await advance(10_000); // retry (and/or the new debounce) lands

    const lastPatch = updateJob.mock.calls[updateJob.mock.calls.length - 1][1];
    expect(lastPatch).toMatchObject({ trim: { in: 7, out: 55 } });
    unmount();
  });
});
