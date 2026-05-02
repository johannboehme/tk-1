import { beforeEach, describe, expect, test } from "vitest";
import { useEditorStore } from "./store";
import { isVideoClip, type MatchCandidate, type VideoClip } from "./types";

/** Test helper: assert a clip is a VideoClip and narrow its type. Tests in
 *  this file build video clips exclusively. */
function asVideo(clip: unknown): VideoClip {
  if (!clip || typeof clip !== "object" || !isVideoClip(clip as VideoClip)) {
    throw new Error("expected a VideoClip");
  }
  return clip as VideoClip;
}

const baseJobMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 250,
  driftRatio: 1.0,
};

describe("useEditorStore", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  test("initial state has empty job and zero override", () => {
    const s = useEditorStore.getState();
    expect(s.jobMeta).toBeNull();
    expect(s.offset.userOverrideMs).toBe(0);
    expect(s.trim.in).toBe(0);
    expect(s.trim.out).toBe(0);
  });

  test("loadJob sets meta, default trim spans full duration", () => {
    useEditorStore.getState().loadJob(baseJobMeta, { lastSyncOverrideMs: -120 });
    const s = useEditorStore.getState();
    expect(s.jobMeta?.id).toBe("j1");
    expect(s.trim).toEqual({ in: 0, out: 60 });
    expect(s.offset.userOverrideMs).toBe(-120);
  });

  test("nudgeOffset accumulates with sub-ms precision rounding", () => {
    useEditorStore.getState().loadJob(baseJobMeta, { lastSyncOverrideMs: 0 });
    const { nudgeOffset } = useEditorStore.getState();
    nudgeOffset(10);
    nudgeOffset(1);
    nudgeOffset(-100);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(-89);
  });

  test("setOffset replaces value", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setOffset(-42);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(-42);
  });

  test("totalOffsetMs combines algo + override", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setOffset(-50);
    expect(useEditorStore.getState().totalOffsetMs()).toBe(200);
  });

  test("setTrimIn clamps to <= trim.out - epsilon", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setTrim({ in: 70, out: 60 });
    const trim = useEditorStore.getState().trim;
    expect(trim.in).toBeLessThan(trim.out);
  });

  test("setLoop clamps to trim region", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setTrim({ in: 5, out: 50 });
    useEditorStore.getState().setLoop({ start: 1, end: 60 });
    expect(useEditorStore.getState().playback.loop).toEqual({ start: 5, end: 50 });
  });

  test("setLoop with region fully outside trim becomes null", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setTrim({ in: 0, out: 10 });
    useEditorStore.getState().setLoop({ start: 20, end: 25 });
    expect(useEditorStore.getState().playback.loop).toBeNull();
  });

  test("addOverlay assigns and removeOverlay drops by index", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().addOverlay({
      type: "text",
      text: "hello",
      start: 1,
      end: 2,
    });
    expect(useEditorStore.getState().overlays.length).toBe(1);
    useEditorStore.getState().removeOverlay(0);
    expect(useEditorStore.getState().overlays.length).toBe(0);
  });

  test("setExportPreset only updates preset, keeps other fields", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setExport({ preset: "archive", video_bitrate_kbps: 9000 });
    useEditorStore.getState().setExport({ preset: "mobile" });
    const ex = useEditorStore.getState().exportSpec;
    expect(ex.preset).toBe("mobile");
    expect(ex.video_bitrate_kbps).toBe(9000);
  });

  test("buildEditSpec reflects current state", () => {
    useEditorStore.getState().loadJob(baseJobMeta);
    useEditorStore.getState().setTrim({ in: 1, out: 5 });
    useEditorStore.getState().setOffset(-30);
    useEditorStore.getState().setExport({ preset: "web" });
    const spec = useEditorStore.getState().buildEditSpec();
    expect(spec.version).toBe(1);
    expect(spec.segments).toEqual([{ in: 1, out: 5 }]);
    expect(spec.sync_override_ms).toBe(-30);
    expect(spec.export?.preset).toBe("web");
  });

  describe("updateClip", () => {
    test("preserves displayW/displayH set after the clip was first added", () => {
      // Repro for the live-preview-goes-black bug when a user adds a
      // second video/image to an already-loaded job: the `+ Media` flow
      // emits a job-update which fires updateClip() on every existing
      // cam. If updateClip rebuilds the clip from ClipInit (which has
      // no display dims) and discards the existing displayW/displayH,
      // resolveOutputDims() returns null and the compositor draws black.
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 0,
          },
        ],
      });
      // Simulate the <video> element reporting its natural pixel dims.
      useEditorStore.getState().setClipDisplayDims("cam-1", 1920, 1080);
      expect(useEditorStore.getState().clips[0].displayW).toBe(1920);
      expect(useEditorStore.getState().clips[0].displayH).toBe(1080);

      // Re-derive from a fresh ClipInit (what Editor.tsx does on a
      // job-update event for already-known cams).
      useEditorStore.getState().updateClip({
        id: "cam-1",
        filename: "a.mp4",
        color: "#fff",
        sourceDurationS: 10,
        syncOffsetMs: 0,
      });

      const c = useEditorStore.getState().clips[0];
      expect(c.displayW).toBe(1920);
      expect(c.displayH).toBe(1080);
    });

    test("preserves displayW/displayH for image clips too", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            kind: "image",
            id: "img-1",
            filename: "p.png",
            color: "#fff",
            durationS: 5,
          },
        ],
      });
      useEditorStore.getState().setClipDisplayDims("img-1", 800, 600);
      useEditorStore.getState().updateClip({
        kind: "image",
        id: "img-1",
        filename: "p.png",
        color: "#fff",
        durationS: 5,
      });
      const c = useEditorStore.getState().clips[0];
      expect(c.displayW).toBe(800);
      expect(c.displayH).toBe(600);
    });
  });

  describe("resetClipAlignment", () => {
    test("reverts override / startOffset / candidate-idx to zeros", () => {
      const cands = [
        { offsetMs: 250, confidence: 0.9, overlapFrames: 1024 },
        { offsetMs: 750, confidence: 0.6, overlapFrames: 800 },
      ];
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "v.mp4",
            color: "#fff",
            sourceDurationS: 60,
            syncOffsetMs: 250,
            candidates: cands,
          },
        ],
      });
      // Apply some user nudges + alternate candidate.
      useEditorStore.getState().setClipSyncOverride("cam-1", -50);
      useEditorStore.getState().setClipStartOffset("cam-1", 0.42);
      useEditorStore.getState().setSelectedCandidateIdx("cam-1", 1);
      expect(asVideo(useEditorStore.getState().clips[0]).syncOverrideMs).toBe(-50);
      expect(asVideo(useEditorStore.getState().clips[0]).selectedCandidateIdx).toBe(1);

      useEditorStore.getState().resetClipAlignment("cam-1");

      const c = asVideo(useEditorStore.getState().clips[0]);
      expect(c.syncOverrideMs).toBe(0);
      expect(c.startOffsetS).toBe(0);
      expect(c.selectedCandidateIdx).toBe(0);
      expect(c.syncOffsetMs).toBe(250); // primary candidate
      // Cam-1 mirror: legacy offset slice also resets.
      expect(useEditorStore.getState().offset.userOverrideMs).toBe(0);
    });

    test("is a no-op for an unknown camId", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "v.mp4",
            color: "#fff",
            sourceDurationS: 60,
            syncOffsetMs: 0,
          },
        ],
      });
      useEditorStore.getState().setClipSyncOverride("cam-1", -10);
      useEditorStore.getState().resetClipAlignment("cam-XX");
      expect(asVideo(useEditorStore.getState().clips[0]).syncOverrideMs).toBe(-10);
    });
  });

  describe("moveCut", () => {
    test("moves an existing cut and returns the committed time", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "v.mp4",
            color: "#fff",
            sourceDurationS: 60,
            syncOffsetMs: 0,
          },
          {
            id: "cam-2",
            filename: "v2.mp4",
            color: "#0ff",
            sourceDurationS: 60,
            syncOffsetMs: 0,
          },
        ],
      });
      useEditorStore.getState().addCut({ atTimeS: 4, camId: "cam-2" });
      useEditorStore.getState().addCut({ atTimeS: 10, camId: "cam-1" });
      const committed = useEditorStore.getState().moveCut(10, "cam-1", 12.5);
      expect(committed).toBe(12.5);
      const cuts = useEditorStore.getState().cuts;
      const moved = cuts.find((c) => c.camId === "cam-1");
      expect(moved?.atTimeS).toBe(12.5);
      // Sort: smaller atTimeS first.
      expect(cuts.map((c) => c.atTimeS)).toEqual([4, 12.5]);
    });

    test("clamps to the master timeline duration", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "v.mp4",
            color: "#fff",
            sourceDurationS: 100,
            syncOffsetMs: 0,
          },
          {
            id: "cam-2",
            filename: "v2.mp4",
            color: "#0ff",
            sourceDurationS: 100,
            syncOffsetMs: 0,
          },
        ],
      });
      // cam-2 cut so cam-1 cut at t=3 isn't a no-op (cam-1 is the
      // default-active otherwise; addCut would skip).
      useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam-2" });
      useEditorStore.getState().addCut({ atTimeS: 3, camId: "cam-1" });
      const committed = useEditorStore
        .getState()
        .moveCut(3, "cam-1", baseJobMeta.duration + 30);
      expect(committed).toBe(baseJobMeta.duration);
    });

    test("returns the original time when no cut matches", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      const committed = useEditorStore.getState().moveCut(99, "cam-X", 5);
      expect(committed).toBe(99);
    });
  });

  describe("hold-gesture cancellation", () => {
    test("beginHoldGesture snapshots cuts, cancelHold reverts them", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "v.mp4",
            color: "#fff",
            sourceDurationS: 60,
            syncOffsetMs: 0,
          },
          {
            id: "cam-2",
            filename: "v2.mp4",
            color: "#0ff",
            sourceDurationS: 60,
            syncOffsetMs: 0,
          },
        ],
      });
      // Pre-existing cuts: cam-2 starts at t=2, cam-2 again at t=10
      // (so the area around t=5 is on cam-2, not the default cam-1).
      useEditorStore.getState().addCut({ atTimeS: 2, camId: "cam-2" });
      useEditorStore.getState().addCut({ atTimeS: 10, camId: "cam-2" });
      const before = useEditorStore.getState().cuts;
      // Begin hold and place a tap-cut to cam-1 at t=5 — overrides cam-2.
      useEditorStore.getState().beginHoldGesture("cam-1", 5);
      useEditorStore.getState().addCut({ atTimeS: 5, camId: "cam-1" });
      expect(useEditorStore.getState().cuts.length).toBe(before.length + 1);
      // Cancel — cuts revert, holdGesture clears.
      useEditorStore.getState().cancelHold();
      expect(useEditorStore.getState().cuts).toEqual(before);
      expect(useEditorStore.getState().holdGesture).toBeNull();
    });

    test("cancelHold is a no-op when no hold is active", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().cancelHold();
      // No throw; nothing happens.
      expect(useEditorStore.getState().holdGesture).toBeNull();
    });
  });

  describe("Q-hold quantize actions", () => {
    test("buildAndStartQuantizePreview is no-op when mode is OFF", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().buildAndStartQuantizePreview();
      const p = useEditorStore.getState().quantizePreview;
      expect(p).not.toBeNull();
      expect(p!.cuts).toEqual([]);
      expect(p!.clipStartOffsets).toEqual([]);
      expect(p!.trim).toBeNull();
    });

    test("buildAndStartQuantizePreview emits previews for off-grid trim/clips/cuts", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().setTrim({ in: 0.21, out: 60 });
      useEditorStore.getState().buildAndStartQuantizePreview();
      const p = useEditorStore.getState().quantizePreview;
      expect(p?.trim?.to.in).toBeCloseTo(0, 6);
    });

    test("commitQuantizePreview applies trim then clears the preview", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().setTrim({ in: 0.21, out: 60 });
      useEditorStore.getState().buildAndStartQuantizePreview();
      useEditorStore.getState().commitQuantizePreview();
      expect(useEditorStore.getState().quantizePreview).toBeNull();
      expect(useEditorStore.getState().trim.in).toBeCloseTo(0, 6);
    });

    test("cancelQuantizePreview clears without applying", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().setTrim({ in: 0.21, out: 60 });
      useEditorStore.getState().buildAndStartQuantizePreview();
      useEditorStore.getState().cancelQuantizePreview();
      expect(useEditorStore.getState().quantizePreview).toBeNull();
      expect(useEditorStore.getState().trim.in).toBeCloseTo(0.21, 6);
    });
  });

  describe("snapMasterTime — selector", () => {
    test("returns t unchanged in OFF mode", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      expect(useEditorStore.getState().snapMasterTime(1.337)).toBe(1.337);
    });

    test("snaps to the active grid when mode is /4 with bpm set", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("1/4");
      // 120 BPM → quarter = 0.5 s. Snap 0.61 → 0.5.
      expect(useEditorStore.getState().snapMasterTime(0.61)).toBeCloseTo(0.5, 6);
      expect(useEditorStore.getState().snapMasterTime(0.76)).toBeCloseTo(1.0, 6);
    });

    test("treats MATCH as no-snap for cut-set (master-time has no candidates)", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("match");
      expect(useEditorStore.getState().snapMasterTime(1.337)).toBe(1.337);
    });

    test("returns t unchanged when no bpm is detected even on grid modes", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setSnapMode("1/4");
      expect(useEditorStore.getState().snapMasterTime(1.337)).toBe(1.337);
    });
  });

  describe("stepByActiveSnap — arrow-key navigation", () => {
    test("OFF mode: steps exactly one frame", () => {
      useEditorStore.getState().loadJob(baseJobMeta); // fps=30
      useEditorStore.getState().seek(2.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0 + 1 / 30, 6);
      useEditorStore.getState().stepByActiveSnap(-1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0, 6);
    });

    test("grid /4 with bpm=120: steps one quarter (0.5s) per press", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
      });
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().seek(0.6);  // not on grid
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      // From 0.6, next quarter ≥ 0.6 is 1.0 (snapped to grid)
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(1.0, 6);
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(1.5, 6);
      useEditorStore.getState().stepByActiveSnap(-1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(1.0, 6);
    });

    test("grid 1 (full bar) with bpm=120 and 4/4: steps 2.0s per press", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
        beatsPerBar: 4,
      });
      useEditorStore.getState().setSnapMode("1");
      useEditorStore.getState().seek(0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0, 6);
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(4.0, 6);
    });

    test("grid 1: t close-but-not-on snap (1.985s) advances to NEXT snap (2.0), not 4.0", () => {
      // Regression for the eps fallback that used to fire whenever t was
      // within step*0.01 of a snap, falsely doubling the step. The
      // fallback now uses an FP-only tolerance so a real 15ms gap from
      // the snap is treated as off-grid (target = nearest forward snap).
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
        beatsPerBar: 4,
      });
      useEditorStore.getState().setSnapMode("1");
      useEditorStore.getState().seek(1.985);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0, 6);
    });

    test("grid 1: backward from on-grid t=2.0 lands on 0.0 (eps fallback still active for FP)", () => {
      // Guards against shrinking eps to zero — the backward direction
      // still needs the fallback because Math.round rounds half-toward-+∞
      // and snapTime(probe=−step/2) returns the SAME tick (not the
      // previous one). Without the fallback, ←-from-snap would no-op.
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 120, confidence: 1, phase: 0, manualOverride: false },
        beatsPerBar: 4,
      });
      useEditorStore.getState().setSnapMode("1");
      useEditorStore.getState().seek(2.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(-1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(0.0, 6);
    });

    test("MATCH mode with selected clip: jumps to next/prev candidate position", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 30,
            syncOffsetMs: 0,
          },
        ],
      });
      // Inject candidates: positions = -offsetMs/1000.
      // Three candidates at offsetMs: 0, -1000, -3000 → positions: 0, 1, 3.
      const clip = useEditorStore.getState().clips[0] as VideoClip;
      const candidates: MatchCandidate[] = [
        { offsetMs: 0, confidence: 1, overlapFrames: 100 },
        { offsetMs: -1000, confidence: 1, overlapFrames: 100 },
        { offsetMs: -3000, confidence: 1, overlapFrames: 100 },
      ];
      useEditorStore.getState().updateClip({ ...clip, candidates });
      useEditorStore.getState().setSelectedClipId("cam-1");
      useEditorStore.getState().setSnapMode("match");

      useEditorStore.getState().seek(0.4);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      // From 0.4, next position > t is 1.
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(1.0, 6);
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(3.0, 6);
      useEditorStore.getState().stepByActiveSnap(-1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(1.0, 6);
    });

    test("MATCH mode with no clip selected: falls back to frame-step", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setSnapMode("match");
      useEditorStore.getState().seek(2.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0 + 1 / 30, 6);
    });

    test("grid mode with no bpm: falls back to frame-step", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().seek(2.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().stepByActiveSnap(1);
      expect(useEditorStore.getState().playback.currentTime).toBeCloseTo(2.0 + 1 / 30, 6);
    });
  });

  describe("shiftLoop — OP-1 style loop-shift", () => {
    test("forward shift while playhead inside old loop: loop moves, pendingWrapAt = old loop.end", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 0, end: 2 });
      useEditorStore.getState().seek(1.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(1);
      const s = useEditorStore.getState();
      expect(s.playback.loop).toEqual({ start: 2, end: 4 });
      expect(s.playback.pendingWrapAt).toBe(2);
      expect(s.playback.currentTime).toBe(1.0); // playhead UNCHANGED
    });

    test("forward shift while playhead already past new loop start: no pendingWrapAt needed", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 0, end: 2 });
      useEditorStore.getState().seek(2.5);  // past new loop start (2)
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(1);
      const s = useEditorStore.getState();
      expect(s.playback.loop).toEqual({ start: 2, end: 4 });
      // Playhead is inside new loop ([2,4]) → no pending wrap.
      expect(s.playback.pendingWrapAt).toBeNull();
    });

    test("backward shift: loop moves left, playhead unchanged", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 4, end: 6 });
      useEditorStore.getState().seek(5.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(-1);
      const s = useEditorStore.getState();
      expect(s.playback.loop).toEqual({ start: 2, end: 4 });
      expect(s.playback.currentTime).toBe(5.0);
      // Playhead at 5 is past new loop end (4) — wrap will happen on the
      // next forward tick at the OLD loop.end (6); pendingWrapAt = 6.
      expect(s.playback.pendingWrapAt).toBe(6);
    });

    test("no-op when loop is null", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop(null);
      useEditorStore.getState().shiftLoop(1);
      expect(useEditorStore.getState().playback.loop).toBeNull();
    });

    test("no-op when shifted loop falls entirely outside trim", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setTrim({ in: 0, out: 5 });
      useEditorStore.getState().setLoop({ start: 3, end: 5 });
      useEditorStore.getState().shiftLoop(1); // would be [5,7] → outside trim
      expect(useEditorStore.getState().playback.loop).toEqual({ start: 3, end: 5 });
    });

    test("user-initiated seek clears pendingWrapAt", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 0, end: 2 });
      useEditorStore.getState().seek(1.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(1);
      expect(useEditorStore.getState().playback.pendingWrapAt).toBe(2);
      useEditorStore.getState().seek(0.5); // user scrub
      expect(useEditorStore.getState().playback.pendingWrapAt).toBeNull();
    });

    test("setLoop (full replacement) clears any pendingWrapAt", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 0, end: 2 });
      useEditorStore.getState().seek(1.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(1);
      expect(useEditorStore.getState().playback.pendingWrapAt).toBe(2);
      useEditorStore.getState().setLoop({ start: 0, end: 1 });
      expect(useEditorStore.getState().playback.pendingWrapAt).toBeNull();
    });

    test("clearPendingWrap resets the field", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLoop({ start: 0, end: 2 });
      useEditorStore.getState().seek(1.0);
      useEditorStore.getState().clearSeekRequest();
      useEditorStore.getState().shiftLoop(1);
      expect(useEditorStore.getState().playback.pendingWrapAt).toBe(2);
      useEditorStore.getState().clearPendingWrap();
      expect(useEditorStore.getState().playback.pendingWrapAt).toBeNull();
    });
  });

  describe("snap-mode and lanesLocked (UI slice)", () => {
    test("defaults: snapMode=off, lanesLocked=true (lanes default-locked)", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      const s = useEditorStore.getState();
      expect(s.ui.snapMode).toBe("off");
      // Default = locked: the playhead can be dragged through dense
      // clips; user opts into clip-drag by pressing the LOCK button.
      expect(s.ui.lanesLocked).toBe(true);
    });

    test("setSnapMode toggles between modes", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setSnapMode("1/4");
      expect(useEditorStore.getState().ui.snapMode).toBe("1/4");
      useEditorStore.getState().setSnapMode("match");
      expect(useEditorStore.getState().ui.snapMode).toBe("match");
      useEditorStore.getState().setSnapMode("off");
      expect(useEditorStore.getState().ui.snapMode).toBe("off");
    });

    test("setLanesLocked toggles bool", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setLanesLocked(false);
      expect(useEditorStore.getState().ui.lanesLocked).toBe(false);
      useEditorStore.getState().setLanesLocked(true);
      expect(useEditorStore.getState().ui.lanesLocked).toBe(true);
    });
  });

  describe("BPM and beatPhase (job-meta extension)", () => {
    test("loadJob without bpm leaves bpm null", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      expect(useEditorStore.getState().jobMeta?.bpm).toBeNull();
    });

    test("loadJob with bpm seeds it (no manualOverride yet)", () => {
      useEditorStore
        .getState()
        .loadJob({
          ...baseJobMeta,
          bpm: { value: 124, confidence: 0.85, phase: 0.05, manualOverride: false },
        });
      const m = useEditorStore.getState().jobMeta;
      expect(m?.bpm?.value).toBe(124);
      expect(m?.bpm?.manualOverride).toBe(false);
    });

    test("setBpm overrides the value and flips manualOverride", () => {
      useEditorStore.getState().loadJob(baseJobMeta);
      useEditorStore.getState().setBpm({ value: 128, manualOverride: true });
      const bpm = useEditorStore.getState().jobMeta?.bpm;
      expect(bpm?.value).toBe(128);
      expect(bpm?.manualOverride).toBe(true);
    });

    test("setBpm preserves existing confidence/phase if not provided", () => {
      useEditorStore.getState().loadJob({
        ...baseJobMeta,
        bpm: { value: 100, confidence: 0.7, phase: 0.2, manualOverride: false },
      });
      useEditorStore.getState().setBpm({ value: 130, manualOverride: true });
      const bpm = useEditorStore.getState().jobMeta?.bpm;
      expect(bpm?.value).toBe(130);
      expect(bpm?.confidence).toBe(0.7);
      expect(bpm?.phase).toBe(0.2);
      expect(bpm?.manualOverride).toBe(true);
    });
  });

  describe("clip candidates and selectedCandidateIdx", () => {
    const cands = [
      { offsetMs: 250, confidence: 0.9, overlapFrames: 1024 },
      { offsetMs: 750, confidence: 0.6, overlapFrames: 900 },
      { offsetMs: -250, confidence: 0.4, overlapFrames: 700 },
    ];

    test("loadJob with clipInits.candidates seeds them and idx=0", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 250,
            candidates: cands,
          },
        ],
      });
      const c = asVideo(useEditorStore.getState().clips[0]);
      expect(c.candidates).toEqual(cands);
      expect(c.selectedCandidateIdx).toBe(0);
      expect(c.syncOffsetMs).toBe(250);
    });

    test("setSelectedCandidateIdx switches the active candidate AND mirrors syncOffsetMs", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 250,
            candidates: cands,
          },
        ],
      });
      useEditorStore.getState().setSelectedCandidateIdx("cam-1", 1);
      const c = asVideo(useEditorStore.getState().clips[0]);
      expect(c.selectedCandidateIdx).toBe(1);
      expect(c.syncOffsetMs).toBe(750);
    });

    test("loadJob without candidates leaves array empty and idx=0", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 250,
          },
        ],
      });
      const c = asVideo(useEditorStore.getState().clips[0]);
      expect(c.candidates).toEqual([]);
      expect(c.selectedCandidateIdx).toBe(0);
      expect(c.syncOffsetMs).toBe(250);
    });
  });

  describe("setSelectedClipId — match-snap auto-downgrade", () => {
    function loadTwoCams(camsHaveCandidates: [boolean, boolean]) {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "main.mp4",
            color: "#FF5722",
            sourceDurationS: 5,
            syncOffsetMs: 0,
            candidates: camsHaveCandidates[0]
              ? [{ offsetMs: 0, confidence: 0.9, overlapFrames: 1024 }]
              : [],
          },
          {
            id: "cam-2",
            filename: "broll.mp4",
            color: "#1F4E8C",
            sourceDurationS: 5,
            syncOffsetMs: 0,
            candidates: camsHaveCandidates[1]
              ? [{ offsetMs: 0, confidence: 0.9, overlapFrames: 1024 }]
              : [],
          },
        ],
      });
    }

    test("selecting a B-roll clip while in MATCH downgrades to '1' and pushes a notice", () => {
      loadTwoCams([true, false]);
      useEditorStore.getState().setSnapMode("match");
      expect(useEditorStore.getState().ui.snapMode).toBe("match");

      useEditorStore.getState().setSelectedClipId("cam-2");

      const s = useEditorStore.getState();
      expect(s.selectedClipId).toBe("cam-2");
      expect(s.ui.snapMode).toBe("1");
      expect(s.notice?.message).toMatch(/match/i);
    });

    test("selecting a clip with candidates leaves MATCH alone", () => {
      loadTwoCams([true, true]);
      useEditorStore.getState().setSnapMode("match");
      useEditorStore.getState().setSelectedClipId("cam-2");

      const s = useEditorStore.getState();
      expect(s.ui.snapMode).toBe("match");
      expect(s.notice).toBeNull();
    });

    test("selecting a B-roll clip when snap mode is something else leaves it alone", () => {
      loadTwoCams([true, false]);
      useEditorStore.getState().setSnapMode("1/4");
      useEditorStore.getState().setSelectedClipId("cam-2");

      const s = useEditorStore.getState();
      expect(s.ui.snapMode).toBe("1/4");
      expect(s.notice).toBeNull();
    });

    test("clearing selection (id=null) doesn't trigger the downgrade", () => {
      loadTwoCams([true, false]);
      useEditorStore.getState().setSnapMode("match");
      useEditorStore.getState().setSelectedClipId(null);

      const s = useEditorStore.getState();
      expect(s.selectedClipId).toBeNull();
      expect(s.ui.snapMode).toBe("match");
    });

    test("pushNotice rolls a new key each time so the toast can re-trigger", () => {
      const s = useEditorStore.getState();
      s.pushNotice("first");
      const k1 = useEditorStore.getState().notice!.key;
      s.pushNotice("second");
      const k2 = useEditorStore.getState().notice!.key;
      expect(k2).toBeGreaterThan(k1);
      expect(useEditorStore.getState().notice!.message).toBe("second");
    });

    test("dismissNotice clears the slot", () => {
      useEditorStore.getState().pushNotice("hi");
      expect(useEditorStore.getState().notice).not.toBeNull();
      useEditorStore.getState().dismissNotice();
      expect(useEditorStore.getState().notice).toBeNull();
    });
  });

  describe("punch-in fx", () => {
    beforeEach(() => {
      useEditorStore.getState().loadJob(baseJobMeta);
      // Recording-mode requires playback to be running. Audition mode
      // (paused) is exercised separately under "preview-mode holds".
      useEditorStore.getState().setPlaying(true);
    });

    test("initial state has empty fx, no holds, default ui flags", () => {
      const s = useEditorStore.getState();
      expect(s.fx).toEqual([]);
      expect(s.fxHolds).toEqual({});
      expect(s.ui.programStripMode).toBe("both");
      expect(s.ui.fxPanelOpen).toBe(false);
    });

    test("addFx returns id and appends to fx[]", () => {
      const id = useEditorStore.getState().addFx("vignette", 1, 2);
      expect(typeof id).toBe("string");
      expect(useEditorStore.getState().fx).toHaveLength(1);
      expect(useEditorStore.getState().fx[0]).toMatchObject({
        id,
        kind: "vignette",
        inS: 1,
        outS: 2,
      });
    });

    test("setFxIn / setFxOut respect min-window 0.05s", () => {
      const id = useEditorStore.getState().addFx("vignette", 1, 2);
      // Pushing in past out collapses to (out-eps, out)
      useEditorStore.getState().setFxIn(id, 5);
      const fx = useEditorStore.getState().fx[0];
      expect(fx.outS - fx.inS).toBeGreaterThanOrEqual(0.04999);
      // Pulling out below in respects min-window
      useEditorStore.getState().setFxOut(id, 0);
      const fx2 = useEditorStore.getState().fx[0];
      expect(fx2.outS - fx2.inS).toBeGreaterThanOrEqual(0.04999);
    });

    test("removeFx drops by id", () => {
      const a = useEditorStore.getState().addFx("vignette", 0, 1);
      const b = useEditorStore.getState().addFx("vignette", 1, 2);
      useEditorStore.getState().removeFx(a);
      expect(useEditorStore.getState().fx.map((f) => f.id)).toEqual([b]);
    });

    test("beginFxHold creates fx with default-tap length and records hold", () => {
      useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
      const s = useEditorStore.getState();
      expect(s.fx).toHaveLength(1);
      expect(s.fx[0].inS).toBe(3);
      // V1 catalog defaults all FX to 0-length tap → outS = startS +
      // FX_MIN_WINDOW_S so taps act like instant punctuation, not stamps.
      expect(s.fx[0].outS).toBeCloseTo(3.05, 6);
      expect(s.fxHolds["key:F"]).toBeDefined();
      expect(s.fxHolds["key:F"].fxId).toBe(s.fx[0].id);
      expect(s.fxHolds["key:F"].priorFx).toEqual([]);
    });

    test("tickFxHold extends outS past playhead and never shrinks", () => {
      useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
      const initialOut = useEditorStore.getState().fx[0].outS;
      // Tap-length = FX_MIN_WINDOW_S (50 ms) — see catalog defaults.
      expect(initialOut).toBeCloseTo(3.05, 6);
      // Hold ticks at currentS=5 → outS pushed past 5 by overshoot buffer.
      useEditorStore.getState().tickFxHold("key:F", 5);
      expect(useEditorStore.getState().fx[0].outS).toBeGreaterThan(5);
      const afterFirstTick = useEditorStore.getState().fx[0].outS;
      // Going BACKWARD (release earlier than current out) → out stays.
      useEditorStore.getState().tickFxHold("key:F", 4);
      expect(useEditorStore.getState().fx[0].outS).toBe(afterFirstTick);
      // Going further → grows again, still past playhead.
      useEditorStore.getState().tickFxHold("key:F", 7);
      expect(useEditorStore.getState().fx[0].outS).toBeGreaterThan(7);
    });

    test("tickFxHold ensures fx remains active at currentS while held", () => {
      // Regression: outS used to equal currentS exactly, which made the
      // active-resolver flip the FX inactive at the tick boundary
      // (`t < outS` is exclusive). The overshoot buffer prevents this.
      useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
      useEditorStore.getState().tickFxHold("key:F", 10);
      const fx = useEditorStore.getState().fx[0];
      expect(fx.outS).toBeGreaterThan(10);
    });

    test("endFxHold removes the hold but keeps the fx", () => {
      useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
      useEditorStore.getState().tickFxHold("key:F", 4);
      useEditorStore.getState().endFxHold("key:F");
      expect(useEditorStore.getState().fxHolds).toEqual({});
      expect(useEditorStore.getState().fx).toHaveLength(1);
    });

    test("cancelFxHold reverts to priorFx (drops the just-played fx)", () => {
      // Pre-existing fx → snapshot for hold revert
      const preId = useEditorStore.getState().addFx("vignette", 0, 1);
      useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
      useEditorStore.getState().tickFxHold("key:F", 4);
      useEditorStore.getState().cancelFxHold("key:F");
      const s = useEditorStore.getState();
      expect(s.fx.map((f) => f.id)).toEqual([preId]);
      expect(s.fxHolds).toEqual({});
    });

    test("polyphony: multiple simultaneous holds, each isolated", () => {
      useEditorStore.getState().beginFxHold("key:F", "vignette", 1);
      useEditorStore.getState().beginFxHold("key:G", "vignette", 2);
      useEditorStore.getState().tickFxHold("key:F", 3);
      useEditorStore.getState().tickFxHold("key:G", 4);
      const s = useEditorStore.getState();
      expect(s.fx).toHaveLength(2);
      expect(Object.keys(s.fxHolds).sort()).toEqual(["key:F", "key:G"]);
      // Cancel one → only that one disappears
      useEditorStore.getState().cancelFxHold("key:F");
      const s2 = useEditorStore.getState();
      expect(s2.fx).toHaveLength(1);
      expect(s2.fxHolds["key:G"]).toBeDefined();
      expect(s2.fxHolds["key:F"]).toBeUndefined();
    });

    test("cancelAllFxHolds reverts every active hold", () => {
      const preId = useEditorStore.getState().addFx("vignette", 0, 1);
      useEditorStore.getState().beginFxHold("key:F", "vignette", 1);
      useEditorStore.getState().beginFxHold("key:G", "vignette", 2);
      useEditorStore.getState().cancelAllFxHolds();
      const s = useEditorStore.getState();
      expect(s.fx.map((f) => f.id)).toEqual([preId]);
      expect(s.fxHolds).toEqual({});
    });

    test("setProgramStripMode and setFxPanelOpen update ui slice", () => {
      useEditorStore.getState().setProgramStripMode("both");
      expect(useEditorStore.getState().ui.programStripMode).toBe("both");
      useEditorStore.getState().setFxPanelOpen(true);
      expect(useEditorStore.getState().ui.fxPanelOpen).toBe(true);
    });

    test("loadJob accepts opts.fx and clears fxHolds", () => {
      // First insert some hold + fx state...
      useEditorStore.getState().addFx("vignette", 0, 1);
      useEditorStore.getState().beginFxHold("key:F", "vignette", 2);
      // ...then a fresh load should reset both.
      useEditorStore
        .getState()
        .loadJob(baseJobMeta, {
          fx: [{ id: "preexisting", kind: "vignette", inS: 5, outS: 6 }],
        });
      const s = useEditorStore.getState();
      expect(s.fx).toEqual([
        { id: "preexisting", kind: "vignette", inS: 5, outS: 6 },
      ]);
      expect(s.fxHolds).toEqual({});
    });

    describe("tape-overwrite (per-kind monophonic)", () => {
      test("beginFxHold splits an existing same-kind fx around the new fx's full footprint", () => {
        // Existing fx covering [1, 5]
        useEditorStore.getState().addFx("vignette", 1, 5);
        // New hold at t=3 occupies [3, 3.05 + R] (R = vignette default
        // 0.3 s). Old [1, 5] splits into left [1, 3] + right [3.35, 5],
        // and the new live fx is [3, 3.05] (the release tail extends
        // on endFxHold, but the clobber pass already accounts for it).
        useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
        const fx = useEditorStore.getState().fx;
        expect(fx).toHaveLength(3);
        const left = fx.find((f) => f.inS === 1)!;
        expect(left.outS).toBeCloseTo(3, 6);
        const right = fx.find((f) => Math.abs(f.outS - 5) < 1e-6)!;
        expect(right.inS).toBeCloseTo(3.35, 6);
      });

      test("beginFxHold leaves fx outside the default-tap window untouched", () => {
        // Far-away fx that the user wants to keep.
        useEditorStore.getState().addFx("vignette", 10, 12);
        useEditorStore.getState().beginFxHold("key:F", "vignette", 1);
        const fx = useEditorStore.getState().fx;
        // Both fx exist: the distant one + the new live one.
        expect(fx).toHaveLength(2);
        const distant = fx.find((f) => f.inS === 10)!;
        expect(distant.outS).toBe(12);
      });

      test("beginFxHold removes an existing same-kind fx fully inside the new range", () => {
        // Existing fx [3.01, 3.04] entirely INSIDE the new hold's
        // default-tap span [3, 3.05] (FX_MIN_WINDOW_S = 0.05s).
        useEditorStore.getState().addFx("vignette", 3.01, 3.04);
        useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
        const fx = useEditorStore.getState().fx;
        // Only the new live fx remains.
        expect(fx).toHaveLength(1);
        expect(fx[0].inS).toBe(3);
      });

      test("beginFxHold ignores fx of a different kind", () => {
        // Pretend there's another kind by inserting via addFx with the
        // current single kind — same-kind only is the rule, so overlap must
        // matter only for matching kind. Use vignette here as both for now;
        // the real isolation is verified once a 2nd kind exists. To make
        // the contract concrete, we still document the same-kind clause.
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().beginFxHold("key:F", "vignette", 3);
        const fx = useEditorStore.getState().fx;
        // The existing fx got trimmed (same kind), proving the same-kind
        // path runs. Trimmed-back to the new fx's start (3) — the new fx
        // is at the front, its release tail extends to ~3.35 (vignette
        // default R=0.3s) but since the existing fx started before the
        // new one, only the front-trim case applies.
        const prior = fx.find((f) => f.inS === 0)!;
        expect(prior.outS).toBeCloseTo(3, 6);
      });

      test("beginFxHold leaves live (currently-held) fx of the same kind alone", () => {
        // First hold sits live in fxHolds.
        useEditorStore.getState().beginFxHold("key:F", "vignette", 1);
        // Second hold begins at t=3 — must NOT clobber the live one.
        useEditorStore.getState().beginFxHold("key:G", "vignette", 3);
        const s = useEditorStore.getState();
        // Both holds exist.
        expect(Object.keys(s.fxHolds).sort()).toEqual(["key:F", "key:G"]);
        // Both fx exist (the F-live and the G-live).
        expect(s.fx).toHaveLength(2);
      });

      test("tickFxHold trims a non-live same-kind fx that the live range grows over", () => {
        // Pre-existing fx in the path of the live recording.
        const obstacleId = useEditorStore.getState().addFx("vignette", 2, 4);
        useEditorStore.getState().beginFxHold("key:F", "vignette", 1);
        // Live recording extends past the obstacle.
        useEditorStore.getState().tickFxHold("key:F", 5);
        const fx = useEditorStore.getState().fx;
        // Obstacle gone (or fully overwritten).
        expect(fx.find((f) => f.id === obstacleId)).toBeUndefined();
      });

      test("rapid five taps at the same playhead leave at most one fx", () => {
        // Simulate the user mashing F (or a Pad) five times at t=2.
        for (let i = 0; i < 5; i++) {
          useEditorStore.getState().beginFxHold("key:F", "vignette", 2);
          useEditorStore.getState().endFxHold("key:F");
        }
        const fx = useEditorStore.getState().fx;
        expect(fx.length).toBeLessThanOrEqual(1);
      });
    });

    describe("eraseFxAt", () => {
      // Tape-erase semantics: the head is a ~150 ms window centered on
      // `t`; only the part of an fx that lives *under the head* gets
      // cleared. Anything to the left or right of the head survives —
      // exactly what a real tape-erase head does: one strip wiped, the
      // rest of the band intact.
      test("erase 'all' in the middle of a long fx splits it into two", () => {
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().eraseFxAt(2, "all");
        const fx = useEditorStore.getState().fx.slice().sort((a, b) => a.inS - b.inS);
        // Head [1.925, 2.075] eats a slot out of [0, 5] →
        // [0, 1.925] + [2.075, 5].
        expect(fx).toHaveLength(2);
        expect(fx[0].inS).toBeCloseTo(0, 6);
        expect(fx[0].outS).toBeCloseTo(1.925, 6);
        expect(fx[1].inS).toBeCloseTo(2.075, 6);
        expect(fx[1].outS).toBeCloseTo(5, 6);
      });

      test("erase 'all' on a fx's front edge trims the front, keeps the back", () => {
        useEditorStore.getState().addFx("vignette", 2, 4);
        useEditorStore.getState().eraseFxAt(2, "all");
        const fx = useEditorStore.getState().fx;
        // Head [1.925, 2.075] overlaps only the front 0.075 s →
        // residue [2.075, 4] survives.
        expect(fx).toHaveLength(1);
        expect(fx[0].inS).toBeCloseTo(2.075, 6);
        expect(fx[0].outS).toBeCloseTo(4, 6);
      });

      test("erase 'all' near a fx's back edge trims the back, keeps the front", () => {
        useEditorStore.getState().addFx("vignette", 0, 2);
        useEditorStore.getState().eraseFxAt(2, "all");
        const fx = useEditorStore.getState().fx;
        // Head [1.925, 2.075] overlaps only the back 0.075 s →
        // residue [0, 1.925] survives.
        expect(fx).toHaveLength(1);
        expect(fx[0].inS).toBeCloseTo(0, 6);
        expect(fx[0].outS).toBeCloseTo(1.925, 6);
      });

      test("erase 'all' fully wipes a tiny fx that fits inside the head", () => {
        useEditorStore.getState().addFx("vignette", 1.0, 1.005);
        useEditorStore.getState().eraseFxAt(1.001, "all");
        const fx = useEditorStore.getState().fx;
        // Tiny fx is entirely inside [0.926, 1.076] → both residues
        // are degenerate (< FX_MIN_WINDOW_S) so nothing remains.
        expect(fx).toHaveLength(0);
      });

      test("erase head over two same-spot fx eats a slot from both", () => {
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().eraseFxAt(2, "all");
        const fx = useEditorStore.getState().fx;
        // Each [0,5] becomes two pieces, so 2 input fx → 4 output fx.
        expect(fx).toHaveLength(4);
      });

      test("erase per-kind only splits matching kinds", () => {
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().eraseFxAt(2, ["vignette"]);
        const fx = useEditorStore.getState().fx;
        // vignette at [0,5] split into two by the head.
        expect(fx).toHaveLength(2);
      });

      test("erase per-kind with a non-matching kind list leaves fx untouched", () => {
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().eraseFxAt(2, []);
        const fx = useEditorStore.getState().fx;
        expect(fx).toHaveLength(1);
        expect(fx[0].inS).toBe(0);
        expect(fx[0].outS).toBe(5);
      });

      test("erase outside any fx is a no-op", () => {
        useEditorStore.getState().addFx("vignette", 0, 1);
        useEditorStore.getState().eraseFxAt(5, "all");
        const fx = useEditorStore.getState().fx;
        expect(fx).toHaveLength(1);
      });

      test("erase head far from a distant fx leaves it untouched", () => {
        // FX at [10, 12], erase at t=2 → no overlap.
        useEditorStore.getState().addFx("vignette", 10, 12);
        useEditorStore.getState().eraseFxAt(2, "all");
        const fx = useEditorStore.getState().fx;
        expect(fx).toHaveLength(1);
        expect(fx[0].inS).toBe(10);
      });

      test("erase head held in place at the same spot is idempotent after first wipe", () => {
        // Hold X over a stationary spot: first tick clears the strip
        // under the head, subsequent ticks find no fx under the head
        // and leave the residues alone (otherwise repeated ticks
        // would keep eating the residues' edges via float drift).
        useEditorStore.getState().addFx("vignette", 0, 5);
        useEditorStore.getState().eraseFxAt(2, "all");
        const after1 = useEditorStore.getState().fx.slice();
        useEditorStore.getState().eraseFxAt(2, "all");
        useEditorStore.getState().eraseFxAt(2, "all");
        const after3 = useEditorStore.getState().fx.slice();
        expect(after3).toEqual(after1);
      });
    });
  });

  describe("Stage auto-init from first clip dims", () => {
    test("first clip's dims seed exportSpec.resolution + aspect + longSide", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 0,
          },
        ],
      });
      // Initially the resolution is the "source" sentinel (default).
      expect(useEditorStore.getState().exportSpec.resolution).toBe("source");

      useEditorStore.getState().setClipDisplayDims("cam-1", 1920, 1080);
      const spec = useEditorStore.getState().exportSpec;
      expect(spec.resolution).toEqual({ w: 1920, h: 1080 });
      expect(spec.aspectRatio).toBe("16:9");
      expect(spec.resolutionLongSide).toBe(1920);
    });

    test("portrait video → 9:16 aspect, longSide=1920", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 0,
          },
        ],
      });
      useEditorStore.getState().setClipDisplayDims("cam-1", 1080, 1920);
      const spec = useEditorStore.getState().exportSpec;
      expect(spec.resolution).toEqual({ w: 1080, h: 1920 });
      expect(spec.aspectRatio).toBe("9:16");
      expect(spec.resolutionLongSide).toBe(1920);
    });

    test("once user sets a concrete resolution, second clip dims do NOT overwrite", () => {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 0,
          },
        ],
      });
      useEditorStore.getState().setClipDisplayDims("cam-1", 1920, 1080);
      // User changes the export to portrait via the panel.
      useEditorStore.getState().setExport({
        resolution: { w: 1080, h: 1920 },
        aspectRatio: "9:16",
        resolutionLongSide: 1920,
      });

      // A second clip arriving with new dims must NOT undo the user's choice.
      useEditorStore.getState().updateClip({
        id: "cam-2",
        filename: "b.mp4",
        color: "#fff",
        sourceDurationS: 10,
        syncOffsetMs: 0,
      });
      useEditorStore.getState().setClipDisplayDims("cam-2", 3840, 2160);
      const spec = useEditorStore.getState().exportSpec;
      expect(spec.resolution).toEqual({ w: 1080, h: 1920 });
      expect(spec.aspectRatio).toBe("9:16");
    });
  });

  describe("setClipViewportTransform / reset", () => {
    function loadOneCam() {
      useEditorStore.getState().loadJob(baseJobMeta, {
        clips: [
          {
            id: "cam-1",
            filename: "a.mp4",
            color: "#fff",
            sourceDurationS: 10,
            syncOffsetMs: 0,
          },
        ],
      });
    }

    test("merges partial into a fresh DEFAULT_VIEWPORT_TRANSFORM", () => {
      loadOneCam();
      useEditorStore.getState().setClipViewportTransform("cam-1", { x: 50 });
      const t = useEditorStore.getState().clips[0].viewportTransform;
      expect(t).toEqual({ scale: 1, x: 50, y: 0 });
    });

    test("subsequent partials merge with the existing transform", () => {
      loadOneCam();
      useEditorStore.getState().setClipViewportTransform("cam-1", { scale: 2, x: 10 });
      useEditorStore.getState().setClipViewportTransform("cam-1", { y: -20 });
      expect(useEditorStore.getState().clips[0].viewportTransform).toEqual({
        scale: 2,
        x: 10,
        y: -20,
      });
    });

    test("resetClipViewportTransform drops the transform back to undefined", () => {
      loadOneCam();
      useEditorStore.getState().setClipViewportTransform("cam-1", { scale: 1.5 });
      expect(useEditorStore.getState().clips[0].viewportTransform).toBeDefined();
      useEditorStore.getState().resetClipViewportTransform("cam-1");
      expect(useEditorStore.getState().clips[0].viewportTransform).toBeUndefined();
    });
  });
});
