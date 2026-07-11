import { describe, expect, it } from "vitest";
import {
  buildClipMatchPositions,
  candidateIdxNearestStart,
  filterCandidatesByConfidence,
} from "./match-snap";
import type { MatchCandidate, VideoClip } from "../core/types";

const cands: MatchCandidate[] = [
  { offsetMs: 250, confidence: 0.9, overlapFrames: 1024 },
  { offsetMs: 750, confidence: 0.6, overlapFrames: 900 },
  { offsetMs: -250, confidence: 0.3, overlapFrames: 700 },
  { offsetMs: 1250, confidence: 0.15, overlapFrames: 500 },
];

const clip: VideoClip = {
  id: "cam-1",
  filename: "v.mp4",
  color: "#fff",
  sourceDurationS: 10,
  syncOffsetMs: 250,
  syncOverrideMs: 0,
  startOffsetS: 0,
  driftRatio: 1,
  candidates: cands,
  selectedCandidateIdx: 0,
};

describe("filterCandidatesByConfidence", () => {
  it("drops candidates below the threshold but keeps the rest", () => {
    const out = filterCandidatesByConfidence(cands, 0.4);
    expect(out.length).toBe(2);
    expect(out.map((c) => c.offsetMs)).toEqual([250, 750]);
  });

  it("with threshold 0 keeps everything", () => {
    expect(filterCandidatesByConfidence(cands, 0).length).toBe(cands.length);
  });

  it("preserves the original index order (so idx maps back unchanged)", () => {
    const out = filterCandidatesByConfidence(cands, 0.2);
    expect(out.map((c) => c.offsetMs)).toEqual([250, 750, -250]);
  });
});

describe("buildClipMatchPositions", () => {
  it("translates candidate offsets into master-timeline start positions", () => {
    const positions = buildClipMatchPositions(clip);
    // syncOverrideMs is 0 here, so startS = -offsetMs/1000.
    expect(positions).toEqual([
      { idx: 0, startS: -0.25 },
      { idx: 1, startS: -0.75 },
      { idx: 2, startS: 0.25 },
      { idx: 3, startS: -1.25 },
    ]);
  });

  it("incorporates the user override (syncOverrideMs adds to total sync)", () => {
    const overrideClip = { ...clip, syncOverrideMs: 100 };
    const positions = buildClipMatchPositions(overrideClip);
    // startS = -(offsetMs + 100)/1000
    expect(positions[0].startS).toBeCloseTo(-0.35, 6);
    expect(positions[1].startS).toBeCloseTo(-0.85, 6);
  });

  it("can apply a confidence threshold to omit weak candidates", () => {
    const positions = buildClipMatchPositions(clip, { confidenceThreshold: 0.4 });
    expect(positions).toEqual([
      { idx: 0, startS: -0.25 },
      { idx: 1, startS: -0.75 },
    ]);
  });
});

describe("candidateIdxNearestStart", () => {
  it("returns the idx of the candidate whose startS is closest to t", () => {
    const positions = buildClipMatchPositions(clip);
    expect(candidateIdxNearestStart(positions, -0.27)).toBe(0); // near -0.25
    expect(candidateIdxNearestStart(positions, -0.7)).toBe(1); // near -0.75
    expect(candidateIdxNearestStart(positions, 0.2)).toBe(2); // near 0.25
  });

  it("returns null when t is far from every candidate (outside threshold)", () => {
    const positions = buildClipMatchPositions(clip);
    expect(candidateIdxNearestStart(positions, 5.0, 0.25)).toBeNull();
  });

  it("uses the default threshold (0.4 s) when none provided", () => {
    const positions = buildClipMatchPositions(clip);
    expect(candidateIdxNearestStart(positions, -0.4)).toBe(0); // 0.15 away
    expect(candidateIdxNearestStart(positions, -0.6)).toBe(1); // 0.15 away from -0.75
    // 5.0 is far from every candidate → null even at the larger default.
    expect(candidateIdxNearestStart(positions, 5.0)).toBeNull();
  });
});
