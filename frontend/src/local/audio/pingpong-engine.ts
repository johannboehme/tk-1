/**
 * Shared dual-`<audio>` ping-pong engine — the gapless-crossfade
 * transport behind the Editor (useAudioMaster), Triage (useTriageAudio)
 * and Arrange (useArrangeAudio) playback hooks.
 *
 * Why two elements: each `<audio>` has an independent decoder + output
 * buffer. A single-element wrap is `el.currentTime = X`, which ALWAYS
 * interrupts the decoder and produces an audible click. Instead the
 * engine keeps one side "active" (audible) and one "idle" (muted,
 * parked at the next target); shortly before a wrap/hop it pre-plays
 * the idle at gain 0 and schedules sample-accurate gain ramps in the
 * AudioContext so the audible source flips ON the audio render thread —
 * independent of main-thread CPU pressure.
 *
 * The engine owns exactly the machinery all three screens share:
 *
 *   - WebAudio graph construction + per-element cache (React 18
 *     StrictMode double-invokes effects; `createMediaElementSource`
 *     permanently captures its element and throws on a second call)
 *   - active/idle side bookkeeping
 *   - `armCrossfade` (park idle with pre-roll compensation, kick its
 *     decoder, schedule the gain ramps), `armWithoutCrossfade`
 *     (end-of-material sentinel), `consumeFired`, `cancelArmed`
 *   - parking / seeking / play-pause / master-volume plumbing
 *
 * What stays in the hooks: the per-screen walkers (editor loop +
 * arrangement segments, triage loop / seam / sequence, arrange
 * arrangement / preview-loop) — they feed the engine decisions per RAF
 * tick and interpret the armed payload when a crossfade fires. The
 * payload type is generic because the walkers advance different state
 * (segment index / chunk id / arrangement item id).
 */
import { clampSeek } from "../../lib/clamp";

/** Seconds before the wrap point at which a crossfade is ARMED. The
 *  idle element is `play()`'d at this point so it's running by the
 *  time the gain ramp hits. 50 ms is conservative — `<audio>.play()`
 *  → first sample is typically 10–30 ms. */
export const LEAD_TIME_S = 0.05;

/** Crossfade duration. 8 ms is below click-perception (~10 ms) for
 *  most material yet long enough to absorb any inter-element decode
 *  jitter (sub-millisecond). */
export const CROSSFADE_S = 0.008;

export type Side = "A" | "B";

export interface AudioGraph {
  ctx: AudioContext;
  srcA: MediaElementAudioSourceNode;
  srcB: MediaElementAudioSourceNode;
  gainA: GainNode;
  gainB: GainNode;
  master: GainNode;
}

/** Where to park the idle element at ARM time.
 *
 *  The idle is play()'d the moment the crossfade is armed, but only
 *  becomes audible when the gain ramp fires up to `distS` (≤ LEAD_TIME_S)
 *  later — a MediaElementAudioSourceNode keeps pulling samples at gain 0,
 *  so the element's clock advances through the whole lead window. Parking
 *  exactly AT the target made the audible content land at
 *  `target + (distS − playStartupLatency)`: every loop pass clipped the
 *  first ~20–40 ms of loop.start (the downbeat — loops are beat-anchored)
 *  and every chunk seam clipped the incoming chunk's head. Compensate by
 *  parking the lead window EARLY so the clock sits on the target when the
 *  ramp fires. The residual error is the play() startup latency (typically
 *  10–30 ms), now pointing at the material BEFORE the target — for musical
 *  material far less audible than a clipped transient. Negative `distS`
 *  (stall-overshoot arming — the crossfade fires immediately) parks at
 *  the target itself. */
export function armParkMasterT(targetMasterT: number, distS: number): number {
  return Math.max(0, targetMasterT - Math.max(0, distS));
}

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

interface Armed<P> {
  /** `ctx.currentTime` at which the gain ramps START. */
  fireAtCtxTime: number;
  fromSide: Side;
  /** Walker-specific data interpreted by the hook when the fade fires. */
  payload: P;
}

export class PingPongEngine<P = undefined> {
  readonly graph: AudioGraph;
  private readonly elA: HTMLAudioElement;
  private readonly elB: HTMLAudioElement;
  private side: Side = "A";
  private armedState: Armed<P> | null = null;

  constructor(graph: AudioGraph, a: HTMLAudioElement, b: HTMLAudioElement) {
    this.graph = graph;
    this.elA = a;
    this.elB = b;
  }

  /** Which side is currently audible (gain at 1). */
  get active(): Side {
    return this.side;
  }

  get activeEl(): HTMLAudioElement {
    return this.side === "A" ? this.elA : this.elB;
  }

  get idleEl(): HTMLAudioElement {
    return this.side === "A" ? this.elB : this.elA;
  }

  get isArmed(): boolean {
    return this.armedState !== null;
  }

  /** Arm a sample-accurate gain crossfade from the active onto the idle
   *  element: seeks the idle to the pre-roll-compensated park position
   *  (see `armParkMasterT`), kicks its decoder via play(), and schedules
   *  the gain ramps so the audible flip happens AT the target (`distS`
   *  from now) on the audio render thread. Negative `distS` (a RAF
   *  stall carried the playhead past the boundary) fires immediately. */
  armCrossfade(opts: { distS: number; targetS: number; payload: P }): void {
    const g = this.graph;
    const fireAtCtxTime = g.ctx.currentTime + Math.max(0, opts.distS);
    const parkT = armParkMasterT(opts.targetS, opts.distS);
    const idle = this.idleEl;
    try {
      if (Math.abs(idle.currentTime - parkT) > 0.01) {
        idle.currentTime = clampSeek(parkT, idle.duration);
      }
    } catch {
      /* ignore — element not ready; the ramp still flips the gains and
         the caller re-parks on the next wrap */
    }
    if (idle.paused) idle.play().catch(() => undefined);
    const activeGain = this.side === "A" ? g.gainA : g.gainB;
    const idleGain = this.side === "A" ? g.gainB : g.gainA;
    activeGain.gain.cancelScheduledValues(g.ctx.currentTime);
    idleGain.gain.cancelScheduledValues(g.ctx.currentTime);
    activeGain.gain.setValueAtTime(1, fireAtCtxTime);
    activeGain.gain.linearRampToValueAtTime(0, fireAtCtxTime + CROSSFADE_S);
    idleGain.gain.setValueAtTime(0, fireAtCtxTime);
    idleGain.gain.linearRampToValueAtTime(1, fireAtCtxTime + CROSSFADE_S);
    this.armedState = { fireAtCtxTime, fromSide: this.side, payload: opts.payload };
  }

  /** Arm WITHOUT scheduling any gain ramps or touching the idle element.
   *  Used as an end-of-material sentinel: it blocks re-arming during the
   *  lead window while a `setTimeout(setPlaying(false))` does the actual
   *  stop. Crucially this must NOT be a fake crossfade — firing a real
   *  swap at the end of the material would kick the idle (parked at an
   *  earlier target) onto PROGRAM and snap the playhead backwards. */
  armWithoutCrossfade(opts: { distS: number; payload: P }): void {
    this.armedState = {
      fireAtCtxTime: this.graph.ctx.currentTime + Math.max(0, opts.distS),
      fromSide: this.side,
      payload: opts.payload,
    };
  }

  /** Poll for a completed crossfade. On the audio render thread the ramp
   *  completed at `fireAtCtxTime + CROSSFADE_S`, so any tick observing
   *  that bound has already HEARD the swap. Returns the armed payload
   *  (and clears the armed state) exactly once per fired crossfade; the
   *  caller decides what to do (usually `swapSides` + walker advance). */
  consumeFired(): { payload: P } | null {
    const armed = this.armedState;
    if (!armed) return null;
    if (this.graph.ctx.currentTime < armed.fireAtCtxTime + CROSSFADE_S) {
      return null;
    }
    this.armedState = null;
    return { payload: armed.payload };
  }

  /** Flip active/idle roles after a fired crossfade: pauses the former
   *  active (still playing past the wrap point) and optionally re-parks
   *  it at `reparkFormerActiveAtS` so it's ready for the NEXT wrap. */
  swapSides(reparkFormerActiveAtS?: number): void {
    const former = this.activeEl;
    this.side = this.side === "A" ? "B" : "A";
    try {
      former.pause();
    } catch {
      /* ignore */
    }
    if (reparkFormerActiveAtS != null) {
      try {
        former.currentTime = clampSeek(reparkFormerActiveAtS, former.duration);
      } catch {
        /* ignore */
      }
    }
  }

  /** Cancel an armed (not yet fired) crossfade: user seek, loop change,
   *  pause, walker-branch switch. Cancels the scheduled ramps and snaps
   *  both gains back to the current active/idle configuration. */
  cancelArmed(): void {
    if (!this.armedState) return;
    this.snapGainsToActive();
    this.armedState = null;
  }

  /** Reset both gains to the static configuration (active = 1, idle = 0),
   *  discarding any scheduled ramps. */
  snapGainsToActive(): void {
    const g = this.graph;
    const t = g.ctx.currentTime;
    g.gainA.gain.cancelScheduledValues(t);
    g.gainB.gain.cancelScheduledValues(t);
    g.gainA.gain.setValueAtTime(this.side === "A" ? 1 : 0, t);
    g.gainB.gain.setValueAtTime(this.side === "B" ? 1 : 0, t);
  }

  /** Pause the idle element and park its clock at `tS` (clamped), ready
   *  for the next wrap into that position. */
  parkIdle(tS: number): void {
    const idle = this.idleEl;
    try {
      if (!idle.paused) idle.pause();
    } catch {
      /* ignore */
    }
    try {
      idle.currentTime = clampSeek(tS, idle.duration);
    } catch {
      /* not ready yet — the next arm re-parks */
    }
  }

  /** Seek the ACTIVE element (the one the user hears). Returns false when
   *  the element rejected the write (metadata not loaded yet) so callers
   *  can stash the seek and replay it later. */
  seekActive(tS: number): boolean {
    const active = this.activeEl;
    try {
      active.currentTime = clampSeek(tS, active.duration);
      return true;
    } catch {
      return false;
    }
  }

  /** Play the active element. Autoplay-policy rejections propagate to the
   *  caller (each screen reacts differently: surface an error / flip the
   *  store's isPlaying back). */
  playActive(): Promise<void> {
    return this.activeEl.play();
  }

  pauseBoth(): void {
    for (const el of [this.elA, this.elB]) {
      if (!el.paused) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Resume a suspended AudioContext (browser autoplay policy — must be
   *  called from within a user gesture). Idempotent. */
  resumeContext(): void {
    if (this.graph.ctx.state === "suspended") {
      this.graph.ctx.resume().catch(() => {
        /* user-gesture timing issue — not fatal */
      });
    }
  }

  /** Mirror a master-volume value onto the master GainNode with a tiny
   *  ramp to avoid zipper noise on slider drag. Clamped into [0, 1]. */
  setMasterVolume(v: number): void {
    const g = this.graph;
    const t = g.ctx.currentTime;
    g.master.gain.cancelScheduledValues(t);
    g.master.gain.setTargetAtTime(clampVolume(v), t, 0.01);
  }
}

export type EngineBuildResult<P> =
  | { ok: true; engine: PingPongEngine<P>; fresh: boolean }
  | { ok: false; error: string };

/**
 * Engine cache keyed by the A-side `<audio>` element.
 *
 * `MediaElementAudioSourceNode` permanently captures its source element —
 * calling `createMediaElementSource` twice for the same element throws.
 * React 18 StrictMode runs effects twice in dev, so a naive teardown-
 * then-rebuild on cleanup would crash the second time. The cache returns
 * the existing engine (graph AND ping-pong side state — playback may be
 * in flight) for a repeated build against the same elements. WeakMap
 * entries auto-clean when the audio element is GC'd, so this doesn't
 * leak across screen mount/unmount cycles.
 *
 * The AudioContext intentionally is NOT closed on effect cleanup:
 * closing it would render the cached source nodes unusable for the
 * StrictMode re-mount; it is garbage-collected together with the
 * elements when the engine becomes unreachable.
 */
const engineCache = new WeakMap<HTMLAudioElement, PingPongEngine<unknown>>();

export function getOrCreatePingPongEngine<P = undefined>(
  a: HTMLAudioElement,
  b: HTMLAudioElement,
  opts: { initialMasterGain?: number } = {},
): EngineBuildResult<P> {
  const cached = engineCache.get(a);
  if (cached) {
    return { ok: true, engine: cached as PingPongEngine<P>, fresh: false };
  }
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AudioContext failed",
    };
  }
  let srcA: MediaElementAudioSourceNode;
  let srcB: MediaElementAudioSourceNode;
  try {
    srcA = ctx.createMediaElementSource(a);
    srcB = ctx.createMediaElementSource(b);
  } catch (err) {
    try {
      void ctx.close();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "MediaElementSource failed",
    };
  }
  const gainA = ctx.createGain();
  const gainB = ctx.createGain();
  const master = ctx.createGain();
  gainA.gain.value = 1;
  gainB.gain.value = 0;
  master.gain.value = clampVolume(opts.initialMasterGain ?? 1);
  srcA.connect(gainA).connect(master);
  srcB.connect(gainB).connect(master);
  master.connect(ctx.destination);
  const graph: AudioGraph = { ctx, srcA, srcB, gainA, gainB, master };
  const engine = new PingPongEngine<P>(graph, a, b);
  engineCache.set(a, engine as PingPongEngine<unknown>);
  return { ok: true, engine, fresh: true };
}
