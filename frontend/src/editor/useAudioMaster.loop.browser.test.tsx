/**
 * Browser-mode regression pin for the long-form loop walker — real
 * Chromium, real `<audio>` elements, real AudioContext.
 *
 * The jsdom suite drives the two-element ping-pong against instant,
 * synchronous audio mocks: `currentTime` assignment lands immediately
 * and `play()` resolves with zero latency. The failure modes that
 * produced the user-reported "long-form loop plays audio offset
 * relative to the chunk markers" bug live exactly in what those mocks
 * hide — async seek settle, `play()` startup latency eating into the
 * 50 ms lead window, gain-ramp timing vs. actual decoder position.
 *
 * This test builds a long-form arrangement (non-zero master `in`
 * offsets + a duplicate chunk), sets a loop spanning a chunk seam, and
 * plays through several REAL wraps while asserting per animation frame
 * that the audible master-time matches the arr-time the UI displays:
 *
 *     |playback.currentTime − arrToMaster(playback.timelineT)| < TOL
 *
 * (`currentTime` is mirrored from the audible element each tick, so a
 * walker desync — stale segment index, extrapolated playhead running
 * into un-arranged master territory, duplicate-chunk snap-back — shows
 * up as a fat divergence here.) Samples within a small window around
 * seams/loop edges are exempt: the playhead legitimately extrapolates
 * for 1–2 frames while an armed crossfade waits to fire.
 *
 * The loop-glitch probe (audio-glitch-probe.ts) is attached via its
 * opt-in flag and must report zero click events — a wrap that regresses
 * to a seek-on-active or fires against a still-seeking idle element
 * produces a sample-to-sample step the worklet flags.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { userEvent } from "@vitest/browser/context";
import { useAudioMaster } from "./useAudioMaster";
import { useEditorStore } from "./store";
import { arrToMaster, segmentArrStarts, totalArrDuration } from "./arrangement-time";
import type { Segment } from "./types";

// This suite deliberately observes LIVE async playback (RAF ticks, audio
// thread crossfades) — act()-wrapping would defeat its purpose. Tell
// React not to warn about un-act'ed updates from the harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  false;

const SR = 22050;

/** Smooth mono sine — loud enough that a hard discontinuity would trip
 *  the glitch probe's 0.3 threshold, smooth enough that correct
 *  crossfades stay far below it. */
function makeSinePcm(durationS: number): Float32Array {
  const n = Math.floor(durationS * SR);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return pcm;
}

/** 16-bit mono WAV blob (same layout as the editor-load bench helper). */
function pcmToWav(pcm: Float32Array): Blob {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

interface HarnessRefs {
  ready: boolean;
  error: string | null;
}

function Harness({
  audioUrl,
  refs,
}: {
  audioUrl: string;
  refs: HarnessRefs;
}) {
  const a = useRef<HTMLAudioElement>(null);
  const b = useRef<HTMLAudioElement>(null);
  const handle = useAudioMaster({ a, b }, audioUrl);
  useEffect(() => {
    refs.ready = handle.isReady;
    refs.error = handle.error;
  });
  return (
    <>
      <audio ref={a} src={audioUrl} preload="auto" />
      <audio ref={b} src={audioUrl} preload="auto" />
      <button
        type="button"
        data-testid="play"
        onClick={() => useEditorStore.getState().setPlaying(true)}
      >
        Play
      </button>
    </>
  );
}

function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const poll = () => {
      if (cond()) {
        resolve();
        return;
      }
      if (performance.now() - t0 > timeoutMs) {
        reject(new Error(`timed out waiting for: ${label}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

interface FrameSample {
  arr: number;
  master: number;
}

interface RunResult {
  samples: FrameSample[];
  wraps: number;
  landings: number[];
}

/** Sample the store playhead per animation frame until `done(result)`
 *  or the deadline. Wraps = timelineT jumping backwards by > 0.5 s. */
function samplePlayback(
  done: (r: RunResult) => boolean,
  deadlineMs: number,
): Promise<RunResult> {
  const result: RunResult = { samples: [], wraps: 0, landings: [] };
  let prevArr: number | null = null;
  return new Promise((resolve) => {
    const t0 = performance.now();
    function frame() {
      const pb = useEditorStore.getState().playback;
      if (pb.isPlaying) {
        const arr = pb.timelineT;
        const master = pb.currentTime;
        if (prevArr !== null && prevArr - arr > 0.5) {
          result.wraps += 1;
          result.landings.push(arr);
        }
        prevArr = arr;
        result.samples.push({ arr, master });
      }
      if (done(result) || performance.now() - t0 > deadlineMs) {
        resolve(result);
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

/** Clock-coherence violations: samples where the audible master-time
 *  diverges from the arr-time the UI displays. Samples within
 *  `seamMarginS` (arr) of a segment seam or loop edge are exempt — the
 *  playhead legitimately extrapolates for a frame or two while an armed
 *  crossfade waits to fire on the audio thread. */
function coherenceViolations(
  samples: FrameSample[],
  segs: Segment[],
  extraBoundaries: number[],
  seamMarginS = 0.15,
  tolS = 0.045,
): FrameSample[] {
  const boundaries = [
    ...segmentArrStarts(segs),
    totalArrDuration(segs),
    ...extraBoundaries,
  ];
  return samples.filter((s) => {
    if (boundaries.some((b) => Math.abs(s.arr - b) < seamMarginS)) {
      return false;
    }
    return Math.abs(s.master - arrToMaster(s.arr, segs)) > tolS;
  });
}

// Long-form shape: unique chunks with fat master gaps + a duplicate.
//   A  master [10,13) → arr [0,3)
//   B  master [30,33) → arr [3,6)
//   A' master [10,13) → arr [6,9)   (duplicate of A)
const SEGS: Segment[] = [
  { in: 10, out: 13 },
  { in: 30, out: 33 },
  { in: 10, out: 13 },
];

async function setupPlaying(refs: HarnessRefs): Promise<{
  url: string;
  cleanup: () => void;
}> {
  // Opt the glitch probe in BEFORE the graph is built.
  window.__tk1ProbeGlitches = true;
  window.__loopGlitches = [];

  const url = URL.createObjectURL(pcmToWav(makeSinePcm(60)));
  useEditorStore.getState().loadJob({
    id: "browser-loop",
    fps: 30,
    duration: 60,
    width: 100,
    height: 100,
    algoOffsetMs: 0,
    driftRatio: 1,
  });
  const view = render(<Harness audioUrl={url} refs={refs} />);
  // RTL's render() re-enables the act environment — turn it back off,
  // updates from live playback are exactly what we're here to observe.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
  await waitFor(() => refs.ready, 10_000, "audio metadata");
  useEditorStore.getState().setArrangementSegments(SEGS);
  return {
    url,
    cleanup: () => {
      useEditorStore.getState().setPlaying(false);
      view.unmount();
      URL.revokeObjectURL(url);
      delete window.__tk1ProbeGlitches;
    },
  };
}

async function pressPlay(refs: HarnessRefs): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="play"]',
  );
  if (!btn) throw new Error("play button not rendered");
  // Trusted user gesture — unlocks autoplay + AudioContext.resume().
  await userEvent.click(btn);
  await waitFor(
    () =>
      useEditorStore.getState().playback.isPlaying &&
      useEditorStore.getState().playback.currentTime > 0,
    5_000,
    `playback to start (handle.error: ${refs.error})`,
  );
}

afterEach(() => {
  useEditorStore.getState().reset();
});

describe("useAudioMaster loop scheduling — real Chromium, real <audio> (#83)", () => {
  it(
    "loop across a chunk seam survives 3 wraps with audio matching the markers",
    { timeout: 45_000 },
    async () => {
      const refs: HarnessRefs = { ready: false, error: null };
      const { cleanup } = await setupPlaying(refs);
      try {
        // Loop arr [2, 4]: start 2 s into A (master 12), end 1 s into B
        // (master 31) — spans the A/B seam with non-trivial offsets.
        const loop = { start: 2, end: 4 };
        useEditorStore.getState().seek(12, { segmentIdxHint: 0 });
        useEditorStore.getState().setLoop(loop);
        expect(useEditorStore.getState().playback.loop).toEqual(loop);
        await pressPlay(refs);

        const run = await samplePlayback((r) => r.wraps >= 3, 20_000);

        expect(refs.error).toBeNull();
        expect(run.wraps).toBeGreaterThanOrEqual(3);
        // Every wrap must land the playhead at loop.start (small forward
        // slack: the landing sample is 1–2 frames after the audio-thread
        // flip; slight backward slack: the idle is parked a lead-window
        // early to compensate media-element pre-roll).
        for (const landing of run.landings) {
          expect(landing).toBeGreaterThan(loop.start - 0.06);
          expect(landing).toBeLessThan(loop.start + 0.3);
        }
        // Audible master-time tracks the displayed arr-time everywhere
        // outside the small seam windows. This is the pin for the
        // reported "loop audio offset vs chunk markers" bug: a stale
        // walker index or a hop into un-arranged territory diverges by
        // whole seconds here.
        const bad = coherenceViolations(run.samples, SEGS, [
          loop.start,
          loop.end,
        ]);
        expect(
          bad,
          `master/arr divergence on ${bad.length}/${run.samples.length} frames; first: ${JSON.stringify(bad[0])}`,
        ).toEqual([]);
        // Gapless guarantee: the probe heard no clicks.
        expect(window.__loopGlitches ?? []).toEqual([]);
      } finally {
        cleanup();
      }
    },
  );

  it(
    "chunk hops walk seam → duplicate chunk gaplessly with a coherent clock",
    { timeout: 30_000 },
    async () => {
      const refs: HarnessRefs = { ready: false, error: null };
      const { cleanup } = await setupPlaying(refs);
      try {
        // No loop. Start 2.5 s in (0.5 s before the A/B seam) and walk
        // through B into the duplicate A' — the walker must advance by
        // segment INDEX (master-time returns to A's range for A').
        useEditorStore.getState().seek(12.5, { segmentIdxHint: 0 });
        await pressPlay(refs);

        const run = await samplePlayback(
          (r) => r.samples.length > 0 && r.samples[r.samples.length - 1].arr >= 7,
          20_000,
        );

        expect(refs.error).toBeNull();
        const lastArr = run.samples[run.samples.length - 1]?.arr ?? -1;
        // Reached the duplicate occurrence (arr >= 7 is 1 s into A').
        expect(lastArr).toBeGreaterThanOrEqual(7);
        // No wrap-like jumps backward — a duplicate-chunk snap-back to
        // occurrence #1 would register as a wrap here.
        expect(run.wraps).toBe(0);
        const bad = coherenceViolations(run.samples, SEGS, []);
        expect(
          bad,
          `master/arr divergence on ${bad.length}/${run.samples.length} frames; first: ${JSON.stringify(bad[0])}`,
        ).toEqual([]);
        expect(window.__loopGlitches ?? []).toEqual([]);
      } finally {
        cleanup();
      }
    },
  );
});
