import { beforeEach, describe, expect, test } from "vitest";
import { useEditorStore } from "./store";
import { buildPersistPatch } from "./useAutoPersist";
import type { LocalJob, VideoAsset } from "../storage/jobs-db";

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
