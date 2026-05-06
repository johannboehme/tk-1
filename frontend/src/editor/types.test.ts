import { describe, it, expect } from "vitest";
import {
  clipRangeS,
  groupPillsIntoLanes,
  isImageClip,
  isVideoClip,
  segmentsToAudioLane,
  MASTER_AUDIO_ID,
  type ImageClip,
  type Pill,
  type Segment,
  type VideoClip,
} from "./types";

describe("clipRangeS — Video", () => {
  it("computes startS = -syncOffset/1000 for a perfectly aligned cam", () => {
    const clip: VideoClip = {
      kind: "video",
      id: "cam-1",
      filename: "v.mp4",
      color: "#fff",
      sourceDurationS: 10,
      syncOffsetMs: 0,
      syncOverrideMs: 0,
      startOffsetS: 0,
      driftRatio: 1,
      candidates: [],
      selectedCandidateIdx: 0,
    };
    expect(clipRangeS(clip)).toEqual({ anchorS: 0, startS: 0, endS: 10 });
  });

  it("applies sync override + start offset", () => {
    const clip: VideoClip = {
      kind: "video",
      id: "cam-1",
      filename: "v.mp4",
      color: "#fff",
      sourceDurationS: 10,
      syncOffsetMs: 500,
      syncOverrideMs: -100,
      startOffsetS: 0.2,
      driftRatio: 1,
      candidates: [],
      selectedCandidateIdx: 0,
    };
    // -(500 - 100)/1000 + 0.2 = -0.4 + 0.2 = -0.2
    expect(clipRangeS(clip).anchorS).toBeCloseTo(-0.2, 6);
    expect(clipRangeS(clip).startS).toBeCloseTo(-0.2, 6);
    expect(clipRangeS(clip).endS).toBeCloseTo(9.8, 6);
  });

  // Trim is the in-point / out-point of a true cut: the visible
  // [startS, endS] range narrows, but anchorS — where the cam's
  // source-time 0 lives on the master timeline — must NOT move.
  // Otherwise the live preview's <video> currentTime computation
  // (VideoElementPool) plays from source frame 0 instead of frame trimInS.
  it("trimInS narrows startS but anchorS stays put", () => {
    const clip: VideoClip = {
      kind: "video",
      id: "cam-1",
      filename: "v.mp4",
      color: "#fff",
      sourceDurationS: 10,
      syncOffsetMs: 0,
      syncOverrideMs: 0,
      startOffsetS: 0,
      driftRatio: 1,
      candidates: [],
      selectedCandidateIdx: 0,
      trimInS: 2,
    };
    const r = clipRangeS(clip);
    expect(r.anchorS).toBeCloseTo(0, 6);
    expect(r.startS).toBeCloseTo(2, 6);
    expect(r.endS).toBeCloseTo(10, 6);
  });

  it("trimOutS narrows endS but anchorS stays put", () => {
    const clip: VideoClip = {
      kind: "video",
      id: "cam-1",
      filename: "v.mp4",
      color: "#fff",
      sourceDurationS: 10,
      syncOffsetMs: 0,
      syncOverrideMs: 0,
      startOffsetS: 0,
      driftRatio: 1,
      candidates: [],
      selectedCandidateIdx: 0,
      trimOutS: 7,
    };
    const r = clipRangeS(clip);
    expect(r.anchorS).toBeCloseTo(0, 6);
    expect(r.startS).toBeCloseTo(0, 6);
    expect(r.endS).toBeCloseTo(7, 6);
  });

  it("trim combines with sync override — anchor still derived from sync only", () => {
    const clip: VideoClip = {
      kind: "video",
      id: "cam-1",
      filename: "v.mp4",
      color: "#fff",
      sourceDurationS: 10,
      syncOffsetMs: 500,
      syncOverrideMs: 0,
      startOffsetS: 0,
      driftRatio: 1,
      candidates: [],
      selectedCandidateIdx: 0,
      trimInS: 1.5,
      trimOutS: 8,
    };
    const r = clipRangeS(clip);
    // -(500)/1000 = -0.5 → anchorS = -0.5; visible = [-0.5+1.5, -0.5+8] = [1.0, 7.5]
    expect(r.anchorS).toBeCloseTo(-0.5, 6);
    expect(r.startS).toBeCloseTo(1.0, 6);
    expect(r.endS).toBeCloseTo(7.5, 6);
  });
});

describe("clipRangeS — Image", () => {
  it("uses startOffsetS + durationS verbatim", () => {
    const clip: ImageClip = {
      kind: "image",
      id: "cam-2",
      filename: "still.png",
      color: "#fff",
      durationS: 5,
      startOffsetS: 12.5,
    };
    expect(clipRangeS(clip)).toEqual({ anchorS: 12.5, startS: 12.5, endS: 17.5 });
  });

  it("startS = 0 when the image sits at the timeline origin", () => {
    const clip: ImageClip = {
      kind: "image",
      id: "cam-2",
      filename: "still.png",
      color: "#fff",
      durationS: 3,
      startOffsetS: 0,
    };
    expect(clipRangeS(clip)).toEqual({ anchorS: 0, startS: 0, endS: 3 });
  });
});

describe("type guards", () => {
  const video: VideoClip = {
    kind: "video",
    id: "cam-1",
    filename: "v.mp4",
    color: "#fff",
    sourceDurationS: 10,
    syncOffsetMs: 0,
    syncOverrideMs: 0,
    startOffsetS: 0,
    driftRatio: 1,
    candidates: [],
    selectedCandidateIdx: 0,
  };
  const image: ImageClip = {
    kind: "image",
    id: "cam-2",
    filename: "still.png",
    color: "#fff",
    durationS: 5,
    startOffsetS: 0,
  };

  it("isVideoClip identifies video clips and rejects images", () => {
    expect(isVideoClip(video)).toBe(true);
    expect(isVideoClip(image)).toBe(false);
  });

  it("isImageClip identifies image clips and rejects videos", () => {
    expect(isImageClip(video)).toBe(false);
    expect(isImageClip(image)).toBe(true);
  });

  it("treats a VideoClip with kind undefined (legacy) as video", () => {
    const legacy = { ...video, kind: undefined } as VideoClip;
    expect(isVideoClip(legacy)).toBe(true);
    expect(isImageClip(legacy)).toBe(false);
  });
});

describe("segmentsToAudioLane", () => {
  it("maps a single segment to a single pill covering [0, span)", () => {
    const segs: Segment[] = [{ in: 5, out: 12 }];
    const pills = segmentsToAudioLane(segs);
    expect(pills).toHaveLength(1);
    expect(pills[0]).toMatchObject({
      sourceRef: MASTER_AUDIO_ID,
      sourceInS: 5,
      sourceOutS: 12,
      timelineStartS: 0,
      timelineEndS: 7,
    });
  });

  it("packs multiple segments contiguously on the timeline", () => {
    const segs: Segment[] = [
      { in: 0, out: 3 },
      { in: 10, out: 15 },
      { in: 30, out: 31 },
    ];
    const pills = segmentsToAudioLane(segs);
    expect(pills.map((p) => [p.timelineStartS, p.timelineEndS])).toEqual([
      [0, 3],
      [3, 8],
      [8, 9],
    ]);
  });

  it("preserves duplicate-source segments as distinct pills", () => {
    // Same chunk appearing twice in the arrangement → two pills with the
    // same source-window but distinct ids and distinct timeline windows.
    const segs: Segment[] = [
      { in: 0, out: 4, chunkId: "c-1" },
      { in: 10, out: 12 },
      { in: 0, out: 4, chunkId: "c-1" },
    ];
    const pills = segmentsToAudioLane(segs);
    expect(pills).toHaveLength(3);
    expect(pills[0].id).not.toBe(pills[2].id);
    expect(pills[0].sourceInS).toBe(0);
    expect(pills[2].sourceInS).toBe(0);
    expect(pills[0].timelineStartS).toBe(0);
    expect(pills[2].timelineStartS).toBe(6);
  });
});

describe("groupPillsIntoLanes", () => {
  function pill(id: string, camId: string, arrStartS: number, arrEndS: number): Pill {
    return {
      id,
      camId,
      arrStartS,
      arrEndS,
      sourceInS: 0,
      sourceOutS: arrEndS - arrStartS,
      originalArrStartS: arrStartS,
      originalArrEndS: arrEndS,
      originalSourceInS: 0,
      originalSourceOutS: arrEndS - arrStartS,
    };
  }

  it("groups pills by camId and sorts each lane by arrStartS", () => {
    const pills: Pill[] = [
      pill("p2", "cam-A", 5, 10),
      pill("p1", "cam-A", 0, 5),
      pill("p3", "cam-B", 0, 10),
    ];
    const lanes = groupPillsIntoLanes(pills);
    const a = lanes.find((l) => l.id === "cam-A")!;
    const b = lanes.find((l) => l.id === "cam-B")!;
    expect(a.pills.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(b.pills.map((p) => p.id)).toEqual(["p3"]);
  });

  it("preserves duplicate-source pills (same camId, different timeline slots)", () => {
    const pills: Pill[] = [
      pill("a-1", "cam-A", 0, 5),
      pill("a-1-dup", "cam-A", 10, 15),
    ];
    const lanes = groupPillsIntoLanes(pills);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].pills).toHaveLength(2);
  });
});
