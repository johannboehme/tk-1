/**
 * Tests for the audio-master hook — gapless loop via two-`<audio>`
 * ping-pong + WebAudio crossfade.
 *
 * The hook owns no DOM itself; the caller renders TWO `<audio>` tags
 * with refs and passes both refs + the audio URL to the hook. The hook
 * subscribes to the editor store and:
 *   - mirrors `activeAudio.currentTime` into `playback.currentTime`
 *     while playing,
 *   - calls play()/pause() in response to `playback.isPlaying`,
 *   - applies seekRequest by writing to the active element's currentTime,
 *   - reports duration once `loadedmetadata` fires on the A side,
 *   - within `LEAD_TIME_S` of `loop.end` (or `pendingWrapAt`) ARMS a
 *     sample-accurate gain crossfade in the AudioContext — the
 *     gapless wrap mechanism that this hook exists to provide.
 *
 * Importantly the hook does NOT touch any cam <video> element. The cams
 * are slaves of the store's currentTime — see VideoElementPool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useAudioMaster } from "./useAudioMaster";
import { useEditorStore } from "./store";

function flushAll(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface AudioMock {
  setDuration: (d: number) => void;
  fireLoadedMetadata: () => void;
  setCurrentTime: (t: number) => void;
  getCurrentTime: () => number;
  isPaused: () => boolean;
  playSpy: ReturnType<typeof vi.fn>;
  pauseSpy: ReturnType<typeof vi.fn>;
}

function mockMediaElement(audio: HTMLAudioElement): AudioMock {
  let curT = 0;
  let paused = true;
  let dur = NaN;
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => curT,
    set: (v: number) => {
      curT = v;
    },
  });
  Object.defineProperty(audio, "duration", {
    configurable: true,
    get: () => dur,
  });
  Object.defineProperty(audio, "paused", {
    configurable: true,
    get: () => paused,
  });
  const playSpy = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  const pauseSpy = vi.fn(() => {
    paused = true;
  });
  Object.defineProperty(audio, "play", {
    configurable: true,
    value: playSpy,
  });
  Object.defineProperty(audio, "pause", {
    configurable: true,
    value: pauseSpy,
  });
  return {
    setDuration: (d) => {
      dur = d;
    },
    fireLoadedMetadata: () => audio.dispatchEvent(new Event("loadedmetadata")),
    setCurrentTime: (t) => {
      curT = t;
    },
    getCurrentTime: () => curT,
    isPaused: () => paused,
    playSpy,
    pauseSpy,
  };
}

interface FakeAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
}

interface FakeGainNode {
  gain: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeAudioCtx {
  currentTime: number;
  state: "running" | "suspended" | "closed";
  destination: object;
  createMediaElementSource: ReturnType<typeof vi.fn>;
  createGain: () => FakeGainNode;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** Test handle: list of GainNodes created (in order). */
  gains: FakeGainNode[];
}

function makeFakeAudioParam(initial = 1): FakeAudioParam {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

function makeFakeGain(): FakeGainNode {
  return {
    gain: makeFakeAudioParam(1),
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
  };
}

function installFakeAudioContext(): { ctx: FakeAudioCtx; restore: () => void } {
  const ctx: FakeAudioCtx = {
    currentTime: 0,
    state: "running",
    destination: {},
    createMediaElementSource: vi.fn(() => ({
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    createGain: () => {
      const g = makeFakeGain();
      ctx.gains.push(g);
      return g;
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    gains: [],
  };
  // The hook calls `new AudioContext()`. Stub the constructor to
  // return our fake. Using globalThis so this works in jsdom.
  const Original = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext =
    function FakeAudioContextCtor() {
      return ctx;
    } as unknown as typeof AudioContext;
  return {
    ctx,
    restore: () => {
      (globalThis as { AudioContext?: unknown }).AudioContext = Original;
    },
  };
}

interface Refs {
  audioA: HTMLAudioElement;
  audioB: HTMLAudioElement;
  ready: boolean;
  duration: number | null;
}

function Harness({
  audioUrl,
  refs,
}: {
  audioUrl: string;
  refs: Refs;
}) {
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  const handle = useAudioMaster(
    { a: audioARef, b: audioBRef },
    audioUrl,
  );
  useEffect(() => {
    if (audioARef.current) refs.audioA = audioARef.current;
    if (audioBRef.current) refs.audioB = audioBRef.current;
    refs.ready = handle.isReady;
    refs.duration = handle.audioDuration;
  });
  return (
    <>
      <audio
        ref={audioARef}
        src={audioUrl}
        preload="auto"
        data-testid="master-audio-a"
      />
      <audio
        ref={audioBRef}
        src={audioUrl}
        preload="auto"
        data-testid="master-audio-b"
      />
    </>
  );
}

afterEach(() => {
  useEditorStore.getState().reset();
});

describe("useAudioMaster — two-element ping-pong + WebAudio crossfade", () => {
  let refs: Refs;
  let ctxHandle: ReturnType<typeof installFakeAudioContext>;
  beforeEach(() => {
    refs = {
      audioA: undefined as unknown as HTMLAudioElement,
      audioB: undefined as unknown as HTMLAudioElement,
      ready: false,
      duration: null,
    };
    ctxHandle = installFakeAudioContext();
  });
  afterEach(() => {
    ctxHandle.restore();
  });

  async function setup(jobDuration = 10) {
    useEditorStore.getState().loadJob({
      id: "j",
      fps: 30,
      duration: jobDuration,
      width: 100,
      height: 100,
      algoOffsetMs: 0,
      driftRatio: 1,
    });
    render(<Harness audioUrl="/x.wav" refs={refs} />);
    await flushAll();
    const mA = mockMediaElement(refs.audioA);
    const mB = mockMediaElement(refs.audioB);
    mA.setDuration(jobDuration);
    mB.setDuration(jobDuration);
    await act(async () => {
      mA.fireLoadedMetadata();
      await flushAll();
    });
    return { mA, mB };
  }

  it("reports loadedmetadata duration into the handle and store", async () => {
    const { mA } = await setup(5.5);
    expect(refs.ready).toBe(true);
    // setup() wired both elements to 5.5 — verify the A-side fired.
    expect(mA.getCurrentTime()).toBe(0);
    expect(refs.duration).toBeCloseTo(5.5, 6);
  });

  it("calls play() on the active (A) side when isPlaying flips to true", async () => {
    const { mA, mB } = await setup();
    await act(async () => {
      useEditorStore.getState().setPlaying(true);
      await flushAll();
    });
    expect(mA.playSpy).toHaveBeenCalled();
    expect(mA.isPaused()).toBe(false);
    // B remains paused (idle) until the first wrap.
    expect(mB.playSpy).not.toHaveBeenCalled();
    expect(mB.isPaused()).toBe(true);
  });

  it("pauses both elements when isPlaying flips to false", async () => {
    const { mA, mB } = await setup();
    await act(async () => {
      useEditorStore.getState().setPlaying(true);
      await flushAll();
    });
    await act(async () => {
      useEditorStore.getState().setPlaying(false);
      await flushAll();
    });
    expect(mA.pauseSpy).toHaveBeenCalled();
    expect(mA.isPaused()).toBe(true);
    expect(mB.isPaused()).toBe(true);
  });

  it("applies seekRequest by writing the active element's currentTime", async () => {
    const { mA, mB } = await setup();
    await act(async () => {
      useEditorStore.getState().seek(3.7);
      await flushAll();
    });
    expect(mA.getCurrentTime()).toBeCloseTo(3.7, 5);
    // Seek does NOT touch the idle (B) side.
    expect(mB.getCurrentTime()).toBe(0);
    expect(useEditorStore.getState().playback.seekRequest).toBeNull();
  });

  it("mirrors active element currentTime into playback.currentTime while playing", async () => {
    const { mA } = await setup();
    await act(async () => {
      useEditorStore.getState().setPlaying(true);
      await flushAll();
    });
    await act(async () => {
      mA.setCurrentTime(1.0);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    const t = useEditorStore.getState().playback.currentTime;
    expect(t).toBeCloseTo(1.0, 1);
  });

  it("auto-pauses when the master clock reaches duration", async () => {
    const { mA } = await setup(4);
    await act(async () => {
      useEditorStore.getState().setPlaying(true);
      await flushAll();
    });
    await act(async () => {
      mA.setCurrentTime(4.0);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
  });

  it("hook signature accepts a single refs object — no video ref leakage", () => {
    // Type-level guard: if useAudioMaster ever grows a videoRef
    // parameter or splits the audio refs out of the bundle, this
    // breaks. Length = 2: (refs, audioUrl).
    expect(useAudioMaster.length).toBe(2);
  });

  describe("loop wrap — gapless via WebAudio crossfade", () => {
    it("parks idle element at loop.start when a loop is set", async () => {
      const { mB } = await setup();
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 1, end: 3 });
        await flushAll();
      });
      // Idle (B) should be parked at loop.start.
      expect(mB.getCurrentTime()).toBeCloseTo(1, 5);
      expect(mB.isPaused()).toBe(true);
    });

    it("arms a crossfade in the AudioContext within the lead window before loop.end", async () => {
      const { mA } = await setup();
      const { ctx } = ctxHandle;
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 0, end: 2 });
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      // Advance master-time to within the 50 ms lead window.
      await act(async () => {
        mA.setCurrentTime(1.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // At least one gain should have a linearRampToValueAtTime
      // scheduled — the hallmark of an armed crossfade.
      const ramped = ctx.gains.some(
        (g) => (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      );
      expect(ramped).toBe(true);
    });

    it("plays the idle element when arming the crossfade (so its decoder is hot)", async () => {
      const { mA, mB } = await setup();
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 0, end: 2 });
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      mB.playSpy.mockClear();
      await act(async () => {
        mA.setCurrentTime(1.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // Idle was kicked into play() so it's running by the time the
      // gain ramp hits the wrap point.
      expect(mB.playSpy).toHaveBeenCalled();
    });

    it("after the crossfade completes, swaps roles and re-parks the former active at loop.start", async () => {
      const { mA, mB } = await setup();
      const { ctx } = ctxHandle;
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 0, end: 2 });
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      // Arm the crossfade.
      await act(async () => {
        mA.setCurrentTime(1.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      mA.pauseSpy.mockClear();
      // Advance the AudioContext clock past the wrap + crossfade.
      await act(async () => {
        ctx.currentTime = 100; // any time past fire+CROSSFADE_S
        // RAF tick observes the elapsed time and swaps roles.
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // Former active (A) was paused and re-parked at loop.start = 0.
      expect(mA.pauseSpy).toHaveBeenCalled();
      expect(mA.getCurrentTime()).toBeCloseTo(0, 5);
      // From the next tick on, currentTime is mirrored from B.
      void mB;
    });

    it("uses pendingWrapAt as the wrap point (OP-1 deferred loop-shift)", async () => {
      const { mA } = await setup();
      const { ctx } = ctxHandle;
      // Set a loop, then shiftLoop while paused so pendingWrapAt
      // gets populated. shiftLoop derives it from t outside new loop.
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 0, end: 2 });
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        // Move playhead near the start of the (current) loop, then
        // shift the loop so pendingWrapAt becomes the OLD loop.end.
        mA.setCurrentTime(0.5);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      await act(async () => {
        useEditorStore.getState().shiftLoop(1); // [0,2] → [2,4]
        await flushAll();
      });
      // pendingWrapAt should now be 2 (old loop.end). Approach it
      // from below — the lead-window arms even though loop.end is 4.
      ctx.gains.forEach((g) =>
        (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mockClear(),
      );
      await act(async () => {
        mA.setCurrentTime(1.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      const ramped = ctx.gains.some(
        (g) => (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      );
      expect(ramped).toBe(true);
    });

    it("user seek cancels any armed crossfade", async () => {
      const { mA } = await setup();
      const { ctx } = ctxHandle;
      await act(async () => {
        useEditorStore.getState().setLoop({ start: 0, end: 2 });
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      // Arm the crossfade.
      await act(async () => {
        mA.setCurrentTime(1.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      ctx.gains.forEach((g) =>
        (g.gain.cancelScheduledValues as ReturnType<typeof vi.fn>).mockClear(),
      );
      // User seeks somewhere far away.
      await act(async () => {
        useEditorStore.getState().seek(0.5);
        await flushAll();
      });
      // cancelScheduledValues must have been called on both gains as
      // part of the crossfade-cancel path.
      const cancelled = ctx.gains.filter(
        (g) => (g.gain.cancelScheduledValues as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      ).length;
      expect(cancelled).toBeGreaterThanOrEqual(2);
    });

    it("does not arm a crossfade when no loop is set", async () => {
      const { mA } = await setup();
      const { ctx } = ctxHandle;
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      await act(async () => {
        mA.setCurrentTime(5.0);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      const ramped = ctx.gains.some(
        (g) => (g.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      );
      expect(ramped).toBe(false);
    });
  });

  describe("arrangement-segment walker", () => {
    it("hops to the NEXT segment in arrangement order, not the first master-time match", async () => {
      // Arrangement: chunk-A → chunk-B → chunk-A again (same master range
      // [10,15] used twice). Without the authoritative segment-index in
      // the walker, the second hop's lookup would snap back to occurrence
      // #0 and we'd loop forever.
      const segs = [
        { in: 10, out: 15 },
        { in: 50, out: 55 },
        { in: 10, out: 15 }, // duplicate of segment 0
      ];
      const { mA, mB } = await setup(60);
      useEditorStore.getState().setArrangementSegments(segs);
      // Park playhead inside segment 0 just before its end so the
      // crossfade arms on the next tick.
      useEditorStore.getState().seek(10, { segmentIdxHint: 0 });
      await act(async () => {
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      // Drive master-time near the end of segment 0 so the walker arms.
      await act(async () => {
        mA.setCurrentTime(14.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // Idle (B) should be parked at next segment's in (= 50).
      expect(mB.getCurrentTime()).toBeCloseTo(50, 1);
    });

    it("user-seek with segmentIdxHint binds the walker to the requested occurrence", async () => {
      const segs = [
        { in: 10, out: 15 },
        { in: 10, out: 15 }, // duplicate
      ];
      const { mA, mB } = await setup(20);
      useEditorStore.getState().setArrangementSegments(segs);
      // Click on the duplicate occurrence (idx 1) at master 12.
      useEditorStore.getState().seek(12, { segmentIdxHint: 1 });
      await act(async () => {
        await flushAll();
      });
      await act(async () => {
        useEditorStore.getState().setPlaying(true);
        await flushAll();
      });
      // Drive near the end of segment 1 (= last segment). Walker should
      // schedule a pause-at-end (no further segment to hop into) — and
      // crucially NOT arm a crossfade hop because there's no nextSeg.
      await act(async () => {
        mA.setCurrentTime(14.97);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      // Idle was never re-parked at master 10 again — the walker treats
      // segment idx 1 as final.
      expect(mB.playSpy).not.toHaveBeenCalled();
    });

    it(
      "end of last segment does NOT swap roles (the loop-back bug). " +
        "The active element keeps playing past `out` until the timeout " +
        "fires — never the idle element parked at an earlier master-time.",
      async () => {
        // Arrangement of 2 segs where seg 1's `in` shares master with seg 0.
        // After hop seg 0 → seg 1, the now-idle is parked at seg 1.in.
        // Without this regression test, the walker fake-armed at end of
        // seg 1 and the swap kicked the idle back onto PROGRAM, snapping
        // master-time backwards by one chunk-length.
        const segs = [
          { in: 30, out: 40 }, // seg 0 master
          { in: 30, out: 40 }, // seg 1 master (duplicate of seg 0)
        ];
        const { mA, mB } = await setup(60);
        useEditorStore.getState().setArrangementSegments(segs);
        useEditorStore.getState().seek(30, { segmentIdxHint: 0 });
        await act(async () => {
          await flushAll();
        });
        await act(async () => {
          useEditorStore.getState().setPlaying(true);
          await flushAll();
        });
        // Drive through seg 0's end so the walker arms a real crossfade.
        await act(async () => {
          mA.setCurrentTime(39.97);
          await new Promise((r) =>
            requestAnimationFrame(() => r(undefined)),
          );
          await new Promise((r) =>
            requestAnimationFrame(() => r(undefined)),
          );
        });
        // Crossfade fires — verify idle (= mB) was used: it should have
        // been play()'d during arm and parked at seg 1.in (=30).
        expect(mB.playSpy).toHaveBeenCalled();
        // Now pretend the swap completed and we're playing seg 1 via mB.
        // Drive mB through seg 1's end. The fake-arm bug would set
        // state.armed which fires the swap block on the next tick, kick
        // mA (parked at master 30) onto active, and the walker would
        // observe master 30 — but mA was paused, so master-time would
        // freeze there until the pause timer fires.
        const mAStartCalls = mA.playSpy.mock.calls.length;
        await act(async () => {
          mB.setCurrentTime(39.97);
          await new Promise((r) =>
            requestAnimationFrame(() => r(undefined)),
          );
          await new Promise((r) =>
            requestAnimationFrame(() => r(undefined)),
          );
        });
        // mA must NOT be re-played as a new active during the end-pause
        // window. (One play() during arm of seg 0→1 is allowed; that's
        // mAStartCalls.) After we're in seg 1, mA stays paused.
        expect(mA.playSpy.mock.calls.length).toBe(mAStartCalls);
      },
    );
  });
});
