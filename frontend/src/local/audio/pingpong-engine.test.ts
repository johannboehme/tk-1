/**
 * Tests for the shared dual-`<audio>` ping-pong engine — the one
 * gapless-crossfade transport used by the Editor (useAudioMaster),
 * Triage (useTriageAudio) and Arrange (useArrangeAudio).
 *
 * The engine owns the WebAudio graph (per-element cached for React 18
 * StrictMode), the active/idle side bookkeeping, crossfade arming/
 * firing/cancelling, and idle parking. The per-screen walkers (loop /
 * seam / sequence / arrangement-segments) stay in the hooks and feed
 * the engine decisions per RAF tick.
 *
 * These tests pin the wave-1 scheduling fixes at the engine level:
 *   - #80/#104: arming parks the idle a lead-window EARLY
 *     (armParkMasterT) so its clock sits on the target when the ramp
 *     fires — not at the target itself (which clipped every downbeat).
 *   - #76-adjacent: negative distS (stall-overshoot arming) fires the
 *     crossfade immediately and parks AT the target.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CROSSFADE_S,
  LEAD_TIME_S,
  armParkMasterT,
  getOrCreatePingPongEngine,
  type PingPongEngine,
} from "./pingpong-engine";

// ─── Mocks (same shape as useAudioMaster.test.tsx) ─────────────────────

interface AudioMock {
  el: HTMLAudioElement;
  setDuration: (d: number) => void;
  setCurrentTime: (t: number) => void;
  getCurrentTime: () => number;
  isPaused: () => boolean;
  playSpy: ReturnType<typeof vi.fn>;
  pauseSpy: ReturnType<typeof vi.fn>;
}

function mockMediaElement(): AudioMock {
  const audio = document.createElement("audio");
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
  Object.defineProperty(audio, "play", { configurable: true, value: playSpy });
  Object.defineProperty(audio, "pause", {
    configurable: true,
    value: pauseSpy,
  });
  return {
    el: audio,
    setDuration: (d) => {
      dur = d;
    },
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
  gains: FakeGainNode[];
}

function makeFakeGain(): FakeGainNode {
  return {
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

interface Payload {
  tag: string;
}

function setup(opts: { initialMasterGain?: number } = {}) {
  const handle = installFakeAudioContext();
  const mA = mockMediaElement();
  const mB = mockMediaElement();
  mA.setDuration(100);
  mB.setDuration(100);
  const res = getOrCreatePingPongEngine<Payload>(mA.el, mB.el, opts);
  if (!res.ok) throw new Error(`engine build failed: ${res.error}`);
  return {
    engine: res.engine as PingPongEngine<Payload>,
    mA,
    mB,
    ctx: handle.ctx,
    restore: handle.restore,
    // gains in creation order: A, B, master
    gainA: handle.ctx.gains[0],
    gainB: handle.ctx.gains[1],
    master: handle.ctx.gains[2],
  };
}

let restoreCtx: (() => void) | null = null;
beforeEach(() => {
  restoreCtx?.();
  restoreCtx = null;
});

// ─── armParkMasterT (ported regression pins, #80/#104) ─────────────────

describe("armParkMasterT — idle pre-roll compensation (#80/#104)", () => {
  it("parks the lead window EARLY so the clock sits on the target at fire time", () => {
    expect(armParkMasterT(12, 0.03)).toBeCloseTo(11.97, 9);
    expect(armParkMasterT(110, 0.048)).toBeCloseTo(109.952, 9);
  });

  it("negative dist (stall-overshoot arm, fires immediately) parks at the target", () => {
    expect(armParkMasterT(905, -0.04)).toBe(905);
    expect(armParkMasterT(905, 0)).toBe(905);
  });

  it("clamps to 0 near the start of the file", () => {
    expect(armParkMasterT(0.02, 0.05)).toBe(0);
  });
});

// ─── Graph construction + cache ────────────────────────────────────────

describe("getOrCreatePingPongEngine", () => {
  it("builds the graph: A audible, B muted, master at the initial gain", () => {
    const s = setup({ initialMasterGain: 0.5 });
    restoreCtx = s.restore;
    expect(s.ctx.createMediaElementSource).toHaveBeenCalledTimes(2);
    expect(s.gainA.gain.value).toBe(1);
    expect(s.gainB.gain.value).toBe(0);
    expect(s.master.gain.value).toBe(0.5);
    expect(s.engine.active).toBe("A");
    expect(s.engine.activeEl).toBe(s.mA.el);
    expect(s.engine.idleEl).toBe(s.mB.el);
  });

  it("clamps the initial master gain into [0, 1]", () => {
    const s = setup({ initialMasterGain: 1.7 });
    restoreCtx = s.restore;
    expect(s.master.gain.value).toBe(1);
  });

  it("returns the cached engine for the same element pair (StrictMode double-invoke)", () => {
    const s = setup();
    restoreCtx = s.restore;
    const again = getOrCreatePingPongEngine<Payload>(s.mA.el, s.mB.el);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.engine).toBe(s.engine);
    expect(again.fresh).toBe(false);
    // No second AudioContext / MediaElementSource wiring.
    expect(s.ctx.createMediaElementSource).toHaveBeenCalledTimes(2);
  });

  it("reports fresh=true only on first construction", () => {
    const handle = installFakeAudioContext();
    restoreCtx = handle.restore;
    const mA = mockMediaElement();
    const mB = mockMediaElement();
    const first = getOrCreatePingPongEngine(mA.el, mB.el);
    expect(first.ok && first.fresh).toBe(true);
  });

  it("surfaces AudioContext construction failure as an error", () => {
    const Original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext =
      function ThrowingCtor() {
        throw new Error("nope");
      } as unknown as typeof AudioContext;
    const mA = mockMediaElement();
    const mB = mockMediaElement();
    const res = getOrCreatePingPongEngine(mA.el, mB.el);
    (globalThis as { AudioContext?: unknown }).AudioContext = Original;
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("nope");
  });

  it("closes the context and errors when createMediaElementSource throws", () => {
    const handle = installFakeAudioContext();
    restoreCtx = handle.restore;
    handle.ctx.createMediaElementSource.mockImplementation(() => {
      throw new Error("already captured");
    });
    const mA = mockMediaElement();
    const mB = mockMediaElement();
    const res = getOrCreatePingPongEngine(mA.el, mB.el);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("already captured");
    expect(handle.ctx.close).toHaveBeenCalled();
  });
});

// ─── Crossfade arming ──────────────────────────────────────────────────

describe("armCrossfade", () => {
  it("parks the idle a lead-window EARLY, plays it, and schedules both ramps (#80/#104)", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 7;
    s.engine.armCrossfade({
      distS: 0.03,
      targetS: 12,
      payload: { tag: "wrap" },
    });
    // Idle parked EARLY: target − distS.
    expect(s.mB.getCurrentTime()).toBeCloseTo(11.97, 6);
    expect(s.mB.playSpy).toHaveBeenCalled();
    expect(s.engine.isArmed).toBe(true);
    // Ramps anchored at fireAt = now + distS.
    const fireAt = 7 + 0.03;
    expect(s.gainA.gain.setValueAtTime).toHaveBeenCalledWith(1, fireAt);
    expect(s.gainA.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      fireAt + CROSSFADE_S,
    );
    expect(s.gainB.gain.setValueAtTime).toHaveBeenCalledWith(0, fireAt);
    expect(s.gainB.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1,
      fireAt + CROSSFADE_S,
    );
  });

  it("negative distS (stall overshoot) fires immediately and parks AT the target", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 3;
    s.engine.armCrossfade({
      distS: -0.04,
      targetS: 90.5,
      payload: { tag: "hop" },
    });
    expect(s.mB.getCurrentTime()).toBeCloseTo(90.5, 6);
    expect(s.gainB.gain.setValueAtTime).toHaveBeenCalledWith(0, 3);
    // fireAt clamps to now.
    expect(s.gainB.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1,
      3 + CROSSFADE_S,
    );
  });

  it("skips the idle seek when it already sits within 10 ms of the park point", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.mB.setCurrentTime(11.995);
    const before = s.mB.getCurrentTime();
    s.engine.armCrossfade({ distS: 0, targetS: 12, payload: { tag: "w" } });
    expect(s.mB.getCurrentTime()).toBe(before);
  });

  it("does not call play() on an idle that is already running", () => {
    const s = setup();
    restoreCtx = s.restore;
    void s.mB.el.play();
    s.mB.playSpy.mockClear();
    s.engine.armCrossfade({ distS: 0.02, targetS: 5, payload: { tag: "w" } });
    expect(s.mB.playSpy).not.toHaveBeenCalled();
  });

  it("clamps the park seek into the element duration", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.engine.armCrossfade({
      distS: 0,
      targetS: 500, // duration is 100
      payload: { tag: "w" },
    });
    expect(s.mB.getCurrentTime()).toBe(100);
  });
});

describe("armWithoutCrossfade (end-of-arrangement sentinel)", () => {
  it("sets armed without touching gains or the idle element", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 4;
    s.engine.armWithoutCrossfade({ distS: 0.03, payload: { tag: "end" } });
    expect(s.engine.isArmed).toBe(true);
    expect(s.mB.playSpy).not.toHaveBeenCalled();
    expect(s.gainA.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(s.gainB.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    // Still "fires" (payload retrievable) after the window elapses.
    s.ctx.currentTime = 4 + 0.03 + CROSSFADE_S;
    expect(s.engine.consumeFired()?.payload.tag).toBe("end");
    expect(s.engine.isArmed).toBe(false);
  });
});

// ─── Fire detection + side swap ────────────────────────────────────────

describe("consumeFired / swapSides", () => {
  it("returns null while unarmed and before the crossfade completes", () => {
    const s = setup();
    restoreCtx = s.restore;
    expect(s.engine.consumeFired()).toBeNull();
    s.ctx.currentTime = 10;
    s.engine.armCrossfade({ distS: 0.04, targetS: 2, payload: { tag: "w" } });
    // Not yet: ramp completes at 10.04 + CROSSFADE_S.
    s.ctx.currentTime = 10.04 + CROSSFADE_S / 2;
    expect(s.engine.consumeFired()).toBeNull();
    expect(s.engine.isArmed).toBe(true);
  });

  it("returns the payload once ctx-time passes fireAt + CROSSFADE_S and clears armed", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 10;
    s.engine.armCrossfade({ distS: 0.04, targetS: 2, payload: { tag: "w" } });
    s.ctx.currentTime = 10.04 + CROSSFADE_S;
    const fired = s.engine.consumeFired();
    expect(fired?.payload.tag).toBe("w");
    expect(s.engine.isArmed).toBe(false);
    // Consuming again yields nothing.
    expect(s.engine.consumeFired()).toBeNull();
  });

  it("swapSides pauses the former active, flips roles, and re-parks it at the given time", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.mA.setCurrentTime(15.02);
    void s.mB.el.play();
    s.engine.swapSides(2);
    expect(s.engine.active).toBe("B");
    expect(s.engine.activeEl).toBe(s.mB.el);
    expect(s.engine.idleEl).toBe(s.mA.el);
    expect(s.mA.pauseSpy).toHaveBeenCalled();
    expect(s.mA.getCurrentTime()).toBeCloseTo(2, 6);
  });

  it("swapSides without a re-park target leaves the former active's clock alone", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.mA.setCurrentTime(15.02);
    s.engine.swapSides();
    expect(s.engine.active).toBe("B");
    expect(s.mA.getCurrentTime()).toBeCloseTo(15.02, 6);
  });

  it("a full wrap cycle arms the SECOND crossfade with the roles flipped", () => {
    const s = setup();
    restoreCtx = s.restore;
    // First wrap: A → B.
    s.ctx.currentTime = 10;
    s.engine.armCrossfade({ distS: 0.02, targetS: 2, payload: { tag: "w1" } });
    s.ctx.currentTime = 20;
    expect(s.engine.consumeFired()?.payload.tag).toBe("w1");
    s.engine.swapSides(2);
    s.gainA.gain.setValueAtTime.mockClear();
    s.gainB.gain.setValueAtTime.mockClear();
    s.gainA.gain.linearRampToValueAtTime.mockClear();
    s.gainB.gain.linearRampToValueAtTime.mockClear();
    // Second wrap arms from B (now active) down, A (idle) up.
    s.engine.armCrossfade({ distS: 0.02, targetS: 2, payload: { tag: "w2" } });
    expect(s.gainB.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      20.02 + CROSSFADE_S,
    );
    expect(s.gainA.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1,
      20.02 + CROSSFADE_S,
    );
    // And the idle that got parked/played is now the A side.
    expect(s.mA.getCurrentTime()).toBeCloseTo(armParkMasterT(2, 0.02), 6);
  });
});

// ─── Cancel ────────────────────────────────────────────────────────────

describe("cancelArmed", () => {
  it("is a no-op when nothing is armed", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.engine.cancelArmed();
    expect(s.gainA.gain.cancelScheduledValues).not.toHaveBeenCalled();
    expect(s.gainB.gain.cancelScheduledValues).not.toHaveBeenCalled();
  });

  it("cancels scheduled ramps and snaps gains back to the active side", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 5;
    s.engine.armCrossfade({ distS: 0.04, targetS: 2, payload: { tag: "w" } });
    s.ctx.currentTime = 5.01;
    s.engine.cancelArmed();
    expect(s.engine.isArmed).toBe(false);
    expect(s.gainA.gain.cancelScheduledValues).toHaveBeenCalledWith(5.01);
    expect(s.gainB.gain.cancelScheduledValues).toHaveBeenCalledWith(5.01);
    // Active is still A → A back to 1, B to 0.
    expect(s.gainA.gain.setValueAtTime).toHaveBeenCalledWith(1, 5.01);
    expect(s.gainB.gain.setValueAtTime).toHaveBeenCalledWith(0, 5.01);
  });

  it("snaps to the FLIPPED config after a swap", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.engine.swapSides();
    s.ctx.currentTime = 8;
    s.engine.armCrossfade({ distS: 0.04, targetS: 2, payload: { tag: "w" } });
    s.engine.cancelArmed();
    // Active is B → B snaps to 1, A to 0.
    expect(s.gainB.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 8);
    expect(s.gainA.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 8);
  });
});

// ─── Parking, seeking, transport helpers ───────────────────────────────

describe("parkIdle / seekActive / pauseBoth / snapGainsToActive", () => {
  it("parkIdle pauses the idle element and seeks it to the clamped target", () => {
    const s = setup();
    restoreCtx = s.restore;
    void s.mB.el.play();
    s.engine.parkIdle(42);
    expect(s.mB.isPaused()).toBe(true);
    expect(s.mB.getCurrentTime()).toBeCloseTo(42, 6);
  });

  it("seekActive writes the active element's clock (clamped) and reports success", () => {
    const s = setup();
    restoreCtx = s.restore;
    expect(s.engine.seekActive(3.7)).toBe(true);
    expect(s.mA.getCurrentTime()).toBeCloseTo(3.7, 6);
    expect(s.mB.getCurrentTime()).toBe(0);
  });

  it("seekActive reports failure when the element throws (not ready)", () => {
    const s = setup();
    restoreCtx = s.restore;
    Object.defineProperty(s.mA.el, "currentTime", {
      configurable: true,
      get: () => 0,
      set: () => {
        throw new Error("not ready");
      },
    });
    expect(s.engine.seekActive(3.7)).toBe(false);
  });

  it("pauseBoth pauses both elements", () => {
    const s = setup();
    restoreCtx = s.restore;
    void s.mA.el.play();
    void s.mB.el.play();
    s.engine.pauseBoth();
    expect(s.mA.isPaused()).toBe(true);
    expect(s.mB.isPaused()).toBe(true);
  });

  it("snapGainsToActive resets both gains to the current side config", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 9;
    s.engine.snapGainsToActive();
    expect(s.gainA.gain.cancelScheduledValues).toHaveBeenCalledWith(9);
    expect(s.gainA.gain.setValueAtTime).toHaveBeenCalledWith(1, 9);
    expect(s.gainB.gain.setValueAtTime).toHaveBeenCalledWith(0, 9);
  });
});

describe("resumeContext / setMasterVolume", () => {
  it("resumes only a suspended context", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.engine.resumeContext();
    expect(s.ctx.resume).not.toHaveBeenCalled();
    s.ctx.state = "suspended";
    s.engine.resumeContext();
    expect(s.ctx.resume).toHaveBeenCalled();
  });

  it("setMasterVolume clamps and ramps via setTargetAtTime (zipper-noise free)", () => {
    const s = setup();
    restoreCtx = s.restore;
    s.ctx.currentTime = 2;
    s.engine.setMasterVolume(1.4);
    expect(s.master.gain.cancelScheduledValues).toHaveBeenCalledWith(2);
    expect(s.master.gain.setTargetAtTime).toHaveBeenCalledWith(1, 2, 0.01);
    s.engine.setMasterVolume(-0.3);
    expect(s.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 2, 0.01);
  });
});

describe("constants", () => {
  it("exports the canonical lead/crossfade windows (previously duplicated x3)", () => {
    expect(LEAD_TIME_S).toBe(0.05);
    expect(CROSSFADE_S).toBe(0.008);
  });
});
