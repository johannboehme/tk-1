import { describe, expect, test } from "vitest";
import {
  classifyIOTarget,
  imageInAtPlayhead,
  imageOutAtPlayhead,
  videoSourceTimeAtPlayhead,
} from "./io-points";
import type { ImageClip, VideoClip } from "./types";

function makeVideo(p: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: "video",
    id: "cam-1",
    filename: "cam1.mp4",
    color: "#f00",
    sourceDurationS: 60,
    syncOffsetMs: 0,
    syncOverrideMs: 0,
    startOffsetS: 0,
    driftRatio: 1,
    candidates: [],
    selectedCandidateIdx: 0,
    ...p,
  };
}

function makeImage(p: Partial<ImageClip> = {}): ImageClip {
  return {
    kind: "image",
    id: "img-1",
    filename: "still.png",
    color: "#0f0",
    durationS: 5,
    startOffsetS: 10,
    ...p,
  };
}

describe("classifyIOTarget", () => {
  test("loop wins over selection", () => {
    const video = makeVideo();
    const target = classifyIOTarget({
      loop: { start: 1, end: 2 },
      selectedClipId: video.id,
      clips: [video],
    });
    expect(target.kind).toBe("loop");
  });

  test("video clip selected → video target", () => {
    const video = makeVideo();
    const target = classifyIOTarget({
      loop: null,
      selectedClipId: video.id,
      clips: [video],
    });
    expect(target.kind).toBe("video");
    if (target.kind === "video") {
      expect(target.clip.id).toBe(video.id);
    }
  });

  test("image clip selected → image target", () => {
    const img = makeImage();
    const target = classifyIOTarget({
      loop: null,
      selectedClipId: img.id,
      clips: [img],
    });
    expect(target.kind).toBe("image");
    if (target.kind === "image") {
      expect(target.clip.id).toBe(img.id);
    }
  });

  test("no selection → master", () => {
    expect(
      classifyIOTarget({ loop: null, selectedClipId: null, clips: [] }).kind,
    ).toBe("master");
  });

  test("selectedId not present in clips → master", () => {
    const v = makeVideo();
    expect(
      classifyIOTarget({
        loop: null,
        selectedClipId: "ghost",
        clips: [v],
      }).kind,
    ).toBe("master");
  });

  test("master-audio sentinel id (not in clips list) → master", () => {
    const v = makeVideo();
    expect(
      classifyIOTarget({
        loop: null,
        selectedClipId: "__master_audio__",
        clips: [v],
      }).kind,
    ).toBe("master");
  });
});

describe("videoSourceTimeAtPlayhead", () => {
  test("zero sync, zero offset → master t = source t", () => {
    const v = makeVideo();
    expect(videoSourceTimeAtPlayhead(v, 12.5)).toBeCloseTo(12.5, 6);
  });

  test("syncOffsetMs shifts anchor — source time is master − anchor", () => {
    // syncOffsetMs = 1000ms means master audio delayed by 1s vs video,
    // so video starts BEFORE master t=0 → anchorS = -1.
    // At master t=2, source t = 2 - (-1) = 3.
    const v = makeVideo({ syncOffsetMs: 1000 });
    expect(videoSourceTimeAtPlayhead(v, 2)).toBeCloseTo(3, 6);
  });

  test("trimInS does not move the anchor", () => {
    // Even with trimInS=4, source-time at master playhead is unchanged
    // (anchor stays fixed; trimInS only narrows the visible range).
    const v = makeVideo({ trimInS: 4, trimOutS: 30 });
    expect(videoSourceTimeAtPlayhead(v, 7)).toBeCloseTo(7, 6);
  });

  test("startOffsetS shifts anchor positively", () => {
    // startOffsetS=2 → anchor = 0 + 2 = 2; at master t=5, source = 3.
    const v = makeVideo({ startOffsetS: 2 });
    expect(videoSourceTimeAtPlayhead(v, 5)).toBeCloseTo(3, 6);
  });

  test("syncOverrideMs adds to anchor", () => {
    // total sync = (500 + 250) ms = 0.75s → anchor = -0.75.
    // At master t=1, source = 1.75.
    const v = makeVideo({ syncOffsetMs: 500, syncOverrideMs: 250 });
    expect(videoSourceTimeAtPlayhead(v, 1)).toBeCloseTo(1.75, 6);
  });
});

describe("imageInAtPlayhead", () => {
  test("playhead inside pill → left edge moves, right edge fixed", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 }); // [10..15]
    const r = imageInAtPlayhead(img, 12);
    expect(r.startOffsetS).toBeCloseTo(12, 6);
    expect(r.durationS).toBeCloseTo(3, 6);
  });

  test("playhead before pill → image extends backward", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 }); // [10..15]
    const r = imageInAtPlayhead(img, 4);
    expect(r.startOffsetS).toBeCloseTo(4, 6);
    expect(r.durationS).toBeCloseTo(11, 6); // 15 - 4
  });

  test("playhead past right edge → clamp to origRight - 0.1", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 }); // [10..15]
    const r = imageInAtPlayhead(img, 20);
    expect(r.startOffsetS).toBeCloseTo(14.9, 6);
    expect(r.durationS).toBeCloseTo(0.1, 6);
  });

  test("playhead exactly at right edge → clamp to origRight - 0.1", () => {
    const img = makeImage({ startOffsetS: 0, durationS: 5 }); // [0..5]
    const r = imageInAtPlayhead(img, 5);
    expect(r.startOffsetS).toBeCloseTo(4.9, 6);
    expect(r.durationS).toBeCloseTo(0.1, 6);
  });
});

describe("imageOutAtPlayhead", () => {
  test("playhead inside pill → returns playhead - startOffsetS", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 }); // [10..15]
    expect(imageOutAtPlayhead(img, 13)).toBeCloseTo(3, 6);
  });

  test("playhead beyond right edge → grows duration", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 });
    expect(imageOutAtPlayhead(img, 25)).toBeCloseTo(15, 6);
  });

  test("playhead before startOffsetS → negative duration (caller clamps)", () => {
    const img = makeImage({ startOffsetS: 10, durationS: 5 });
    expect(imageOutAtPlayhead(img, 4)).toBeCloseTo(-6, 6);
  });
});
