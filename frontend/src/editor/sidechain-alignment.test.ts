/**
 * Proves the sidechain scope can't drift from the timeline's audio lane.
 *
 * The scope draws the same window as the timeline and maps each column
 * arr→master the same way, then samples the master-indexed envelope. If
 * (a) the window math, (b) the arr→master mapping, and (c) the envelope's
 * time axis all match the timeline, then a transient lands at the same x in
 * both — at any zoom/scroll, deep into the track, across multi-segment /
 * multi-pill long-form. This test pins all three.
 */
import { describe, expect, test } from "vitest";
import type { Segment } from "./types";
import {
  arrToMaster,
  segmentArrStarts,
  timelineVisibleWindow,
  totalArrDuration,
} from "./arrangement-time";
import { buildLoudnessEnvelope } from "./fx/audio-envelope";
import { sampleEnv } from "./fx/modulation";

/** Replica of Timeline.tsx's inline `mapXToTime` arr→master projection — the
 *  ground truth the scope must match. */
function timelineInlineMap(arrT: number, segments: readonly Segment[]): number | null {
  const arrStarts = segmentArrStarts(segments);
  for (let i = 0; i < segments.length; i++) {
    const segArrIn = arrStarts[i];
    const segArrOut = segArrIn + Math.max(0, segments[i].out - segments[i].in);
    if (arrT >= segArrIn && arrT <= segArrOut) {
      return segments[i].in + (arrT - segArrIn);
    }
  }
  return null;
}

/** Replica of Timeline.tsx's visible-window math (the ground truth). */
function timelineWindow(arrTotal: number, zoom: number, scrollX: number) {
  const visibleDur = arrTotal / Math.max(1, zoom);
  const maxScroll = Math.max(0, arrTotal - visibleDur);
  const start = Math.max(0, Math.min(maxScroll, scrollX));
  return { startS: start, spanS: visibleDur };
}

// A long-form arrangement: reordered + duplicated master ranges.
const SEGMENTS: Segment[] = [
  { in: 100, out: 130 },
  { in: 0, out: 30 },
  { in: 200, out: 260 },
  { in: 100, out: 130 }, // duplicate of segment 0
];

describe("sidechain scope ↔ timeline alignment", () => {
  test("scope window == timeline window across zoom + scroll", () => {
    const arrTotal = totalArrDuration(SEGMENTS);
    for (const zoom of [1, 2, 5, 13.5, 100]) {
      for (const scroll of [0, 5, 40, 1e6 /* clamped */]) {
        const a = timelineVisibleWindow(arrTotal, zoom, scroll);
        const b = timelineWindow(arrTotal, zoom, scroll);
        expect(a.startS).toBeCloseTo(b.startS, 9);
        expect(a.spanS).toBeCloseTo(b.spanS, 9);
      }
    }
  });

  test("arr→master matches the timeline's inline projection in every segment", () => {
    const arrStarts = segmentArrStarts(SEGMENTS);
    for (let i = 0; i < SEGMENTS.length; i++) {
      const segArrIn = arrStarts[i];
      const len = SEGMENTS[i].out - SEGMENTS[i].in;
      // Sample interior points (avoid the shared seam endpoints).
      for (const f of [0.01, 0.25, 0.5, 0.75, 0.99]) {
        const arrT = segArrIn + f * len;
        const scope = arrToMaster(arrT, SEGMENTS);
        const timeline = timelineInlineMap(arrT, SEGMENTS);
        expect(timeline).not.toBeNull();
        expect(scope).toBeCloseTo(timeline as number, 9);
      }
    }
  });

  test("a transient lands at the same column in scope and timeline (deep, long-form)", () => {
    const sr = 22050;
    // Master PCM long enough to cover the segments' master ranges.
    const pcm = new Float32Array(sr * 270);
    // Put a transient at master 215s (inside segment 2: master 200..260).
    const mImpulseS = 215;
    const s = Math.round(mImpulseS * sr);
    for (let j = s; j < s + Math.round(sr * 0.008); j++) pcm[j] = 1;
    const env = buildLoudnessEnvelope(pcm, sr); // true-rate fps

    const arrTotal = totalArrDuration(SEGMENTS); // 30+30+60+30 = 150
    // The transient's arr-time: segment 2 starts at arr 60 (30+30), master 200.
    const arrOfImpulse = 60 + (mImpulseS - 200); // = 75
    // A zoomed window that contains it.
    const zoom = 10; // visibleDur = 15s
    const { startS: winStart, spanS } = timelineVisibleWindow(
      arrTotal,
      zoom,
      arrOfImpulse - 7.5, // scroll so the impulse sits mid-window
    );

    // SCOPE: scan columns, find the peak's fraction across the window.
    const COLS = 600;
    let bestFrac = -1;
    let best = -Infinity;
    for (let c = 0; c <= COLS; c++) {
      const frac = c / COLS;
      const arrT = winStart + frac * spanS;
      const v = sampleEnv(env, arrToMaster(arrT, SEGMENTS));
      if (v > best) {
        best = v;
        bestFrac = frac;
      }
    }
    // TIMELINE: the impulse's true fraction across the same window.
    const tlFrac = (arrOfImpulse - winStart) / spanS;

    // Same column within ~0.5% of the window width (≈ one env frame).
    expect(Math.abs(bestFrac - tlFrac)).toBeLessThan(0.01);
  });
});
