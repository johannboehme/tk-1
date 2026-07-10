/**
 * Regression pins for the shared ping-pong transport glue (Triage +
 * Arrange). These effects were previously duplicated line-for-line in
 * useTriageAudio / useArrangeAudio; the tests pin the extracted
 * behavior: URL resolve + revoke, readiness via A-side metadata,
 * engine build, play/pause mirroring onto the ACTIVE element, and
 * external-seek handling (write active + cancel armed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { usePingPongTransport } from "./use-pingpong-transport";
import type { PingPongEngine } from "./pingpong-engine";

vi.mock("../jobs", () => ({
  resolveJobAssetUrl: vi.fn(() =>
    Promise.resolve("blob:http://localhost/job-audio"),
  ),
}));

function flushAll(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─── Mocks (same shape as pingpong-engine.test.ts) ─────────────────────

function mockMediaElement(audio: HTMLAudioElement) {
  let curT = 0;
  let paused = true;
  let dur = 100;
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
  Object.defineProperty(audio, "play", { configurable: true, value: playSpy });
  Object.defineProperty(audio, "pause", {
    configurable: true,
    value: pauseSpy,
  });
  return {
    setDuration: (d: number) => {
      dur = d;
    },
    setCurrentTime: (t: number) => {
      curT = t;
    },
    getCurrentTime: () => curT,
    isPaused: () => paused,
    playSpy,
    pauseSpy,
    fireLoadedMetadata: () => audio.dispatchEvent(new Event("loadedmetadata")),
  };
}

function installFakeAudioContext() {
  const gains: Array<{ gain: Record<string, ReturnType<typeof vi.fn>> }> = [];
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: {},
    createMediaElementSource: vi.fn(() => ({
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    createGain: () => {
      const g = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
          setTargetAtTime: vi.fn(),
        },
        connect: vi.fn().mockReturnThis(),
        disconnect: vi.fn(),
      };
      gains.push(g as never);
      return g;
    },
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const Original = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext =
    function FakeAudioContextCtor() {
      return ctx;
    } as unknown as typeof AudioContext;
  return {
    ctx,
    gains,
    restore: () => {
      (globalThis as { AudioContext?: unknown }).AudioContext = Original;
    },
  };
}

// ─── Harness ───────────────────────────────────────────────────────────

interface Out {
  engine: PingPongEngine<{ tag: string }> | null;
  isReady: boolean;
  a: HTMLAudioElement | null;
  b: HTMLAudioElement | null;
  externalTimeCb: ((tS: number) => void) | null;
}

function Harness({
  jobId,
  isPlaying,
  onPlayRejected,
  out,
}: {
  jobId: string | null;
  isPlaying: boolean;
  onPlayRejected: () => void;
  out: Out;
}) {
  const aRef = useRef<HTMLAudioElement | null>(null);
  const bRef = useRef<HTMLAudioElement | null>(null);
  const { engineRef, isReady } = usePingPongTransport<{ tag: string }>({
    aRef,
    bRef,
    jobId,
    isPlaying,
    onPlayRejected,
    subscribeExternalTime: (cb) => {
      out.externalTimeCb = cb;
      return () => {
        out.externalTimeCb = null;
      };
    },
  });
  useEffect(() => {
    out.engine = engineRef.current;
    out.isReady = isReady;
    out.a = aRef.current;
    out.b = bRef.current;
  });
  return (
    <>
      <audio ref={aRef} data-testid="a" />
      <audio ref={bRef} data-testid="b" />
    </>
  );
}

let restoreCtx: () => void;
let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const handle = installFakeAudioContext();
  restoreCtx = handle.restore;
  revokeSpy = vi.fn();
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeSpy,
  });
});

afterEach(() => {
  restoreCtx();
});

async function setup(opts: { isPlaying?: boolean } = {}) {
  const out: Out = {
    engine: null,
    isReady: false,
    a: null,
    b: null,
    externalTimeCb: null,
  };
  const onPlayRejected = vi.fn();
  const view = render(
    <Harness
      jobId="job-1"
      isPlaying={opts.isPlaying ?? false}
      onPlayRejected={onPlayRejected}
      out={out}
    />,
  );
  await act(async () => {
    await flushAll();
  });
  const mA = mockMediaElement(out.a!);
  const mB = mockMediaElement(out.b!);
  await act(async () => {
    mA.fireLoadedMetadata();
    await flushAll();
  });
  return { out, mA, mB, view, onPlayRejected };
}

describe("usePingPongTransport", () => {
  it("resolves the job audio URL and applies it to BOTH elements", async () => {
    const { out } = await setup();
    expect(out.a!.src).toContain("blob:");
    expect(out.b!.src).toContain("blob:");
    expect(out.a!.src).toBe(out.b!.src);
  });

  it("flips isReady and builds the engine once A-side metadata arrives", async () => {
    const { out } = await setup();
    expect(out.isReady).toBe(true);
    expect(out.engine).not.toBeNull();
    expect(out.engine!.activeEl).toBe(out.a);
  });

  it("mirrors play/pause onto the ACTIVE element only", async () => {
    const { out, mA, mB, view } = await setup();
    view.rerender(
      <Harness
        jobId="job-1"
        isPlaying={true}
        onPlayRejected={() => undefined}
        out={out}
      />,
    );
    await act(async () => {
      await flushAll();
    });
    expect(mA.playSpy).toHaveBeenCalled();
    expect(mB.playSpy).not.toHaveBeenCalled();
    view.rerender(
      <Harness
        jobId="job-1"
        isPlaying={false}
        onPlayRejected={() => undefined}
        out={out}
      />,
    );
    await act(async () => {
      await flushAll();
    });
    expect(mA.pauseSpy).toHaveBeenCalled();
  });

  it("reports a rejected play() so the store can flip isPlaying back", async () => {
    const { out, mA, view, onPlayRejected } = await setup();
    mA.playSpy.mockImplementation(() =>
      Promise.reject(new Error("autoplay blocked")),
    );
    view.rerender(
      <Harness
        jobId="job-1"
        isPlaying={true}
        onPlayRejected={onPlayRejected}
        out={out}
      />,
    );
    await act(async () => {
      await flushAll();
    });
    expect(onPlayRejected).toHaveBeenCalled();
  });

  it("applies external seeks to the active element and cancels an armed crossfade", async () => {
    const { out, mA } = await setup();
    const eng = out.engine!;
    eng.armCrossfade({ distS: 0.03, targetS: 5, payload: { tag: "w" } });
    expect(eng.isArmed).toBe(true);
    mA.setCurrentTime(1);
    out.externalTimeCb!(42);
    expect(mA.getCurrentTime()).toBeCloseTo(42, 6);
    expect(eng.isArmed).toBe(false);
  });

  it("ignores external time within the RAF feedback threshold (no seek loop)", async () => {
    const { out, mA } = await setup();
    mA.setCurrentTime(10);
    const eng = out.engine!;
    eng.armCrossfade({ distS: 0.03, targetS: 5, payload: { tag: "w" } });
    out.externalTimeCb!(10.02); // within 50 ms of the element clock
    expect(mA.getCurrentTime()).toBe(10);
    expect(eng.isArmed).toBe(true); // NOT cancelled
  });

  it("revokes the object URL on unmount", async () => {
    const { view } = await setup();
    view.unmount();
    expect(revokeSpy).toHaveBeenCalledWith("blob:http://localhost/job-audio");
  });
});
