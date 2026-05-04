/**
 * Master-clock hook — gapless loop via two-`<audio>` ping-pong + WebAudio
 * crossfade. Replaces the older single-`<audio>` design where loop wrap
 * was a `currentTime`-seek (never gapless on HTMLMediaElement; the
 * browser pauses the decoder to repoint, audible click).
 *
 * Architecture:
 *   The caller mounts TWO hidden `<audio>` elements with the same `src`,
 *   passes both refs in. The hook:
 *
 *     - Builds one shared `AudioContext`. Each `<audio>` is wrapped in a
 *       `MediaElementAudioSourceNode` → individual `GainNode` →
 *       `masterGain` → `destination`.
 *     - Picks one side as "active" (audible). Plays via the active
 *       element. The idle element is `paused` and parked at
 *       `loop.start` when a loop is set.
 *     - Per RAF tick, reads `activeEl.currentTime` and mirrors it into
 *       `playback.currentTime`. Within `LEAD_TIME_S` of `loop.end` (or
 *       `pendingWrapAt`), arms a sample-accurate crossfade in the
 *       AudioContext: schedules `linearRampToValueAtTime(...)` on both
 *       gains so that AT the wrap point the audible source flips from
 *       active → idle over `CROSSFADE_S`.
 *     - The crossfade fires entirely on the audio render thread —
 *       independent of main-thread CPU pressure. After it fires the
 *       hook swaps roles, re-parks the now-idle (formerly active) side
 *       at `loop.start`, and clears any `pendingWrapAt`.
 *
 *   Memory cost: two `<audio>` elements + their decoder buffers.
 *   Constant — does NOT decode the file into RAM, so 1h+ takes work
 *   the same as 5-min songs.
 *
 * Why two elements: each `<audio>` element has independent decoder +
 * output buffer. Switching the audible source via gain crossfade is
 * gapless because neither decoder is interrupted at the wrap point.
 * A single-element seek (`el.currentTime = X`) ALWAYS interrupts the
 * decoder and is audible. Crossfade window (5–10ms) is far below
 * click-perception thresholds for musical material.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "./store";
import { shouldArmCrossfade, loopWrapTime } from "./OffsetScheduler";
import { attachLoopGlitchProbe, isProbeEnabled } from "./audio-glitch-probe";

export interface AudioMasterHandle {
  isReady: boolean;
  audioDuration: number | null;
  error: string | null;
}

/** Seconds before the wrap point at which we ARM the crossfade. The
 *  idle element is `play()`'d at this point so it's running by the
 *  time the gain ramp hits. 50 ms is conservative — `<audio>.play()`
 *  → first sample is typically 10–30 ms. */
const LEAD_TIME_S = 0.05;

/** Crossfade duration. 8 ms is below click-perception (~10 ms) for
 *  most material yet long enough to absorb any inter-element decode
 *  jitter (sub-millisecond). */
const CROSSFADE_S = 0.008;

interface AudioRefs {
  a: React.RefObject<HTMLAudioElement | null>;
  b: React.RefObject<HTMLAudioElement | null>;
}

interface AudioGraph {
  ctx: AudioContext;
  srcA: MediaElementAudioSourceNode;
  srcB: MediaElementAudioSourceNode;
  gainA: GainNode;
  gainB: GainNode;
  master: GainNode;
}

/**
 * Cache of WebAudio graphs keyed by the A-side `<audio>` element.
 *
 * `MediaElementAudioSourceNode` permanently captures its source
 * element — calling `createMediaElementSource` twice for the same
 * element throws. React 18 StrictMode runs effects twice in dev, so a
 * naive teardown-then-rebuild on cleanup would crash the second time.
 *
 * Solution: cache the graph keyed by the A-side ref. On the second
 * effect invocation we reuse the cached graph instead of rebuilding.
 * The WeakMap entries auto-clean when the audio element is GC'd
 * (i.e. when the component truly unmounts and React releases the ref),
 * so this doesn't leak across editor mount/unmount cycles.
 *
 * The AudioContext intentionally is NOT closed on effect cleanup.
 * Closing it would render the cached source nodes unusable for the
 * StrictMode re-mount; the context is naturally garbage-collected
 * when the audio elements (and thus the graph) become unreachable.
 */
const graphCache = new WeakMap<HTMLAudioElement, AudioGraph>();

interface PingPongState {
  /** Which side is currently audible (gain ramped to 1). */
  active: "A" | "B";
  /** Crossfade scheduled but not yet fired. `fireAtCtxTime` is
   *  `audioContext.currentTime` at which the gain ramps START.
   *  `wrapTarget` overrides the post-fire seek destination for
   *  arrangement-segment hops (where we land at the next segment's
   *  `in` instead of the current loop's `start`). `nextSegmentIdx`
   *  is the index we're hopping INTO — used by the walker so it
   *  advances explicitly through duplicate segments instead of
   *  re-deriving from master-time (which would lock into the FIRST
   *  matching duplicate forever). */
  armed:
    | {
        fireAtCtxTime: number;
        fromSide: "A" | "B";
        wrapTarget?: number;
        nextSegmentIdx?: number;
      }
    | null;
  /** The arrangement segment we're currently playing through. Tracked
   *  as authoritative state — set by user-seek (re-derived from master
   *  time), advanced on every crossfade-hop. Without this the walker
   *  would re-scan segments[] on every tick and pick the FIRST match,
   *  which loops forever when a chunk is duplicated in the arrangement
   *  (segments[0].master == segments[2].master → after hopping to
   *  index 2 the lookup snaps back to 0). null = direct-mode or pre-
   *  first-tick. */
  currentSegmentIdx: number | null;
}

export function useAudioMaster(
  refs: AudioRefs,
  audioUrl: string | null,
): AudioMasterHandle {
  const [isReady, setIsReady] = useState(false);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPlaying = useEditorStore((s) => s.playback.isPlaying);
  const seekRequest = useEditorStore((s) => s.playback.seekRequest);
  const audioVolume = useEditorStore((s) => s.audioVolume);
  const loop = useEditorStore((s) => s.playback.loop);

  const graphRef = useRef<AudioGraph | null>(null);
  const stateRef = useRef<PingPongState>({
    active: "A",
    armed: null,
    currentSegmentIdx: null,
  });
  const rafRef = useRef<number | null>(null);
  /** Pending seek that arrived before the audio reported metadata.
   *  Replayed once `loadedmetadata` fires on the active element. */
  const pendingSeekRef = useRef<number | null>(null);

  // Stable wrappers so React doesn't recreate effects on every render.
  const refsStable = useMemo(() => refs, [refs.a, refs.b]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset readiness whenever the URL changes.
  useEffect(() => {
    setIsReady(false);
    setAudioDuration(null);
    setError(null);
  }, [audioUrl]);

  // loadedmetadata on the A side: master duration + initial readiness.
  // We treat A as the canonical metadata source — both elements load
  // the same URL so their durations match.
  useEffect(() => {
    const a = refsStable.a.current;
    if (!a) return;
    function onLoaded() {
      const el = refsStable.a.current;
      if (!el) return;
      setAudioDuration(Number.isFinite(el.duration) ? el.duration : null);
      setIsReady(true);
      const pending = pendingSeekRef.current;
      if (pending !== null) {
        try {
          el.currentTime = clampSeek(pending, el.duration);
        } catch {
          /* element not ready */
        }
        pendingSeekRef.current = null;
      }
    }
    function onError() {
      setError(a?.error?.message ?? "audio error");
    }
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("error", onError);
    if (a.readyState >= 1) onLoaded();
    return () => {
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("error", onError);
    };
  }, [refsStable.a, audioUrl]);

  // Build the WebAudio graph once both elements are mounted. Idempotent
  // under React 18 StrictMode (which double-invokes effects in dev): a
  // module-level WeakMap caches the graph by the A-side element so the
  // second effect run reuses the existing context instead of trying to
  // re-wrap an already-captured `<audio>` (which would throw).
  useEffect(() => {
    const a = refsStable.a.current;
    const b = refsStable.b.current;
    if (!a || !b) return;
    if (graphRef.current) return;

    const cached = graphCache.get(a);
    if (cached) {
      graphRef.current = cached;
      // Don't reset active/armed — playback may already be in flight.
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "AudioContext failed");
      return;
    }
    let srcA: MediaElementAudioSourceNode;
    let srcB: MediaElementAudioSourceNode;
    try {
      srcA = ctx.createMediaElementSource(a);
      srcB = ctx.createMediaElementSource(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MediaElementSource failed");
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
      return;
    }
    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    const master = ctx.createGain();
    gainA.gain.value = 1;
    gainB.gain.value = 0;
    master.gain.value = clampVolume(audioVolume);
    srcA.connect(gainA).connect(master);
    srcB.connect(gainB).connect(master);
    master.connect(ctx.destination);
    const graph: AudioGraph = { ctx, srcA, srcB, gainA, gainB, master };
    graphCache.set(a, graph);
    graphRef.current = graph;
    stateRef.current = { active: "A", armed: null, currentSegmentIdx: null };

    if (isProbeEnabled()) {
      void attachLoopGlitchProbe(ctx, master).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[loop-glitch-probe]", err);
      });
    }
    // No teardown returned — see graphCache JSDoc. The context is
    // GC'd alongside the audio elements when the component truly
    // unmounts.
  }, [refsStable.a, refsStable.b]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror master volume onto the master GainNode (with a tiny ramp to
  // avoid zipper noise on slider drag).
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const t = g.ctx.currentTime;
    g.master.gain.cancelScheduledValues(t);
    g.master.gain.setTargetAtTime(clampVolume(audioVolume), t, 0.01);
  }, [audioVolume]);

  // Apply seek requests. The seek hits the ACTIVE element only; the
  // idle element is re-parked separately (see loop effect).
  useEffect(() => {
    if (seekRequest === null) return;
    const a = refsStable.a.current;
    const b = refsStable.b.current;
    const clear = useEditorStore.getState().clearSeekRequest;
    if (!a || !b || !isReady) {
      pendingSeekRef.current = seekRequest;
      clear();
      return;
    }
    const active = stateRef.current.active === "A" ? a : b;
    try {
      active.currentTime = clampSeek(seekRequest, active.duration);
    } catch {
      pendingSeekRef.current = seekRequest;
    }
    // Cancel any armed crossfade — user seek invalidates it (the loop
    // boundary may now be far away or behind us).
    cancelArmedCrossfade(graphRef.current, stateRef.current);
    // Re-bind currentSegmentIdx — prefer the caller-supplied
    // `seekSegmentIdxHint` (the only correct answer when the master-time
    // appears in multiple segments) and fall back to a master-time scan
    // when no hint is given. Without this, a click on a duplicate
    // chunk's second occurrence would bounce the playhead back onto
    // occurrence #1.
    const stateNow = useEditorStore.getState();
    const segs = stateNow.arrangementSegments;
    const hint = stateNow.playback.seekSegmentIdxHint;
    if (segs.length > 0) {
      if (hint != null && hint >= 0 && hint < segs.length) {
        stateRef.current.currentSegmentIdx = hint;
      } else {
        let idx = -1;
        for (let i = 0; i < segs.length; i++) {
          if (seekRequest >= segs[i].in && seekRequest < segs[i].out) {
            idx = i;
            break;
          }
        }
        stateRef.current.currentSegmentIdx = idx === -1 ? null : idx;
      }
    } else {
      stateRef.current.currentSegmentIdx = null;
    }
    clear();
  }, [seekRequest, isReady, refsStable.a, refsStable.b]);

  // When the loop region changes (or is unset), park the idle element
  // at the new loop.start and reset any armed crossfade. This handles
  // user-IN/OUT, OP-1 loop-shift, and loop-clear in one path.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    cancelArmedCrossfade(g, stateRef.current);
    if (!loop) return;
    const idleEl =
      stateRef.current.active === "A"
        ? refsStable.b.current
        : refsStable.a.current;
    if (!idleEl) return;
    try {
      idleEl.currentTime = clampSeek(loop.start, idleEl.duration);
    } catch {
      /* not ready yet — next tick will catch up */
    }
    if (!idleEl.paused) {
      try {
        idleEl.pause();
      } catch {
        /* ignore */
      }
    }
  }, [loop, refsStable.a, refsStable.b]);

  /** Stop the per-frame loop. Idempotent. */
  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Play / pause + RAF mirror loop. Resumes the AudioContext on play
  // (autoplay policy: must be inside a user gesture; the transport-bar
  // click handler is the typical caller of setPlaying(true)).
  useEffect(() => {
    const g = graphRef.current;
    const a = refsStable.a.current;
    const b = refsStable.b.current;
    if (!g || !a || !b || !isReady) return;

    if (!isPlaying) {
      stopRaf();
      // Defensive pause both sides + cancel any pending fade. Reset
      // gains so the next play() starts cleanly with the active side
      // audible.
      cancelArmedCrossfade(g, stateRef.current);
      const active = stateRef.current.active;
      if (!a.paused) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
      if (!b.paused) {
        try {
          b.pause();
        } catch {
          /* ignore */
        }
      }
      const tNow = g.ctx.currentTime;
      g.gainA.gain.cancelScheduledValues(tNow);
      g.gainB.gain.cancelScheduledValues(tNow);
      g.gainA.gain.setValueAtTime(active === "A" ? 1 : 0, tNow);
      g.gainB.gain.setValueAtTime(active === "B" ? 1 : 0, tNow);
      return;
    }

    // Resume the context if a previous setPlaying(false) had no effect
    // on it. resume() is idempotent.
    if (g.ctx.state === "suspended") {
      g.ctx.resume().catch(() => {
        /* user-gesture timing issue — surface but don't crash */
      });
    }

    const activeEl = stateRef.current.active === "A" ? a : b;
    activeEl.play().catch((err) => {
      setError(err instanceof Error ? err.message : "audio.play() failed");
    });

    function tick() {
      const graph = graphRef.current;
      const refA = refsStable.a.current;
      const refB = refsStable.b.current;
      if (!graph || !refA || !refB) {
        rafRef.current = null;
        return;
      }
      const store = useEditorStore.getState();
      if (!store.playback.isPlaying) {
        rafRef.current = null;
        return;
      }
      const dur = store.jobMeta?.duration ?? Infinity;
      const state = stateRef.current;
      const active = state.active === "A" ? refA : refB;
      const idle = state.active === "A" ? refB : refA;
      const t = active.currentTime;

      // Auto-pause at master end.
      if (t >= dur) {
        store.setCurrentTime(dur);
        store.setPlaying(false);
        rafRef.current = null;
        return;
      }
      store.setCurrentTime(t);

      // Has an armed crossfade fired already? Detect by
      // audioContext.currentTime — on the audio render thread the
      // ramp completed at fireAtCtxTime + CROSSFADE_S, so any tick
      // observing that bound has already heard the swap.
      if (
        state.armed &&
        graph.ctx.currentTime >= state.armed.fireAtCtxTime + CROSSFADE_S
      ) {
        // Swap roles. The new idle = the former active, which is
        // still playing past the wrap point and must be paused +
        // re-parked at the wrap target (loop.start for normal loops,
        // wrapTarget for arrangement-segment hops) so it's ready for
        // the NEXT wrap.
        const wrapLoop = store.playback.loop;
        const armedTarget = state.armed.wrapTarget;
        const armedNextSegmentIdx = state.armed.nextSegmentIdx;
        const formerActive = active;
        state.active = state.active === "A" ? "B" : "A";
        state.armed = null;
        // Authoritative segment-walker advance: the listener is now
        // hearing the segment whose `in` we crossfaded into. Stamp it
        // into state so the next tick's segment lookup doesn't snap
        // backward to a duplicate of an earlier chunk that happens to
        // share the same master-time range.
        if (armedNextSegmentIdx !== undefined) {
          state.currentSegmentIdx = armedNextSegmentIdx;
        }
        try {
          formerActive.pause();
        } catch {
          /* ignore */
        }
        if (armedTarget != null) {
          try {
            formerActive.currentTime = clampSeek(
              armedTarget,
              formerActive.duration,
            );
          } catch {
            /* ignore */
          }
        } else if (wrapLoop) {
          try {
            formerActive.currentTime = clampSeek(
              wrapLoop.start,
              formerActive.duration,
            );
          } catch {
            /* ignore */
          }
        }
        // Clear any pendingWrapAt — the deferred wrap just happened.
        if (store.playback.pendingWrapAt != null) {
          store.clearPendingWrap();
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ─── Arrangement-segment walker ───────────────────────────────────
      // When the editor was opened from a long-form Arrange handoff, the
      // store carries a list of `arrangementSegments` (in master-time).
      // Playback should walk them in order, gapless-hopping at each
      // segment boundary instead of streaming straight through the
      // master audio. Direct-mode jobs leave this empty and the legacy
      // loop logic below runs as before.
      //
      // The walker uses an AUTHORITATIVE state.currentSegmentIdx instead
      // of re-deriving from master-time on every tick — duplicate chunks
      // (same master-time range used multiple times in the arrangement)
      // share master-time bounds, so a "scan-for-first-match" lookup
      // would lock the playback into the first occurrence forever. The
      // index advances on each crossfade hop and re-binds on user-seek.
      const segs = store.arrangementSegments;
      if (segs.length > 0) {
        let curIdx = state.currentSegmentIdx ?? -1;
        // Validate the cached index — if master-time has drifted out of
        // its window (e.g. browser nudged currentTime past the end while
        // we were waiting on a frame), fall back to a scan.
        if (curIdx >= 0 && curIdx < segs.length) {
          const seg = segs[curIdx];
          if (t < seg.in - 1e-3 || t >= seg.out) curIdx = -1;
        } else {
          curIdx = -1;
        }
        if (curIdx === -1) {
          for (let i = 0; i < segs.length; i++) {
            if (t >= segs[i].in - 1e-3 && t < segs[i].out) {
              curIdx = i;
              break;
            }
          }
          if (curIdx !== -1) state.currentSegmentIdx = curIdx;
        }
        if (curIdx === -1) {
          // The playhead is in a "gap" between segments (or before the
          // first one). Hard-seek to the next segment's start, or pause
          // when we've fallen past the last segment.
          let nextIdx = -1;
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].in > t) {
              nextIdx = i;
              break;
            }
          }
          if (nextIdx === -1) {
            // Past the last segment — stop.
            store.setPlaying(false);
            state.currentSegmentIdx = null;
            rafRef.current = null;
            return;
          }
          const target = segs[nextIdx].in;
          try {
            active.currentTime = clampSeek(target, active.duration);
          } catch {
            /* ignore */
          }
          state.currentSegmentIdx = nextIdx;
          store.setCurrentTime(target);
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        const curSeg = segs[curIdx];
        const nextSeg = segs[curIdx + 1] ?? null;
        if (state.armed === null) {
          const distToEnd = curSeg.out - t;
          if (distToEnd > 0 && distToEnd <= LEAD_TIME_S) {
            const fireAtCtxTime = graph.ctx.currentTime + distToEnd;
            if (nextSeg) {
              try {
                if (Math.abs(idle.currentTime - nextSeg.in) > 0.01) {
                  idle.currentTime = clampSeek(nextSeg.in, idle.duration);
                }
              } catch {
                /* ignore */
              }
              if (idle.paused) {
                idle.play().catch(() => undefined);
              }
              const activeGain = state.active === "A" ? graph.gainA : graph.gainB;
              const idleGain = state.active === "A" ? graph.gainB : graph.gainA;
              activeGain.gain.cancelScheduledValues(graph.ctx.currentTime);
              idleGain.gain.cancelScheduledValues(graph.ctx.currentTime);
              activeGain.gain.setValueAtTime(1, fireAtCtxTime);
              activeGain.gain.linearRampToValueAtTime(0, fireAtCtxTime + CROSSFADE_S);
              idleGain.gain.setValueAtTime(0, fireAtCtxTime);
              idleGain.gain.linearRampToValueAtTime(1, fireAtCtxTime + CROSSFADE_S);
              state.armed = {
                fireAtCtxTime,
                fromSide: state.active,
                wrapTarget: nextSeg.in,
                nextSegmentIdx: curIdx + 1,
              };
            } else {
              // Last segment — no hop, just pause when we hit the end.
              window.setTimeout(() => {
                useEditorStore.getState().setPlaying(false);
              }, Math.max(0, distToEnd * 1000));
              // Fake-arm so we don't re-arm next tick.
              state.armed = {
                fireAtCtxTime,
                fromSide: state.active,
              };
            }
          }
        }
        // Skip the legacy loop arming below — segment-walk owns the
        // crossfade scheduling for arrangement playback.
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Should we arm a crossfade now? Pure helper makes the rule
      // testable in isolation.
      const lp = store.playback.loop;
      const pendingWrapAt = store.playback.pendingWrapAt;
      if (
        lp &&
        shouldArmCrossfade({
          masterT: t,
          loop: lp,
          pendingWrapAt,
          leadTimeS: LEAD_TIME_S,
          alreadyArmed: state.armed != null,
        })
      ) {
        const wrapT = loopWrapTime(lp, pendingWrapAt) ?? lp.end;
        // Distance to wrap in master-time. AudioContext-time advances
        // at the same rate as master-time (no playbackRate mod), so
        // the offset translates 1:1.
        const distToWrap = Math.max(0, wrapT - t);
        const fireAtCtxTime = graph.ctx.currentTime + distToWrap;

        // Park idle element at loop.start and start it playing so its
        // decoder is producing samples by the time the gain ramp hits.
        try {
          if (Math.abs(idle.currentTime - lp.start) > 0.01) {
            idle.currentTime = clampSeek(lp.start, idle.duration);
          }
        } catch {
          /* ignore */
        }
        if (idle.paused) {
          idle.play().catch(() => undefined);
        }

        // Schedule the gain ramps. setValueAtTime "anchors" the ramp's
        // start value at fireAtCtxTime — without this anchor, the ramp
        // begins from now, which would slowly fade during the lead
        // window instead of at the wrap point.
        const activeGain = state.active === "A" ? graph.gainA : graph.gainB;
        const idleGain = state.active === "A" ? graph.gainB : graph.gainA;
        activeGain.gain.cancelScheduledValues(graph.ctx.currentTime);
        idleGain.gain.cancelScheduledValues(graph.ctx.currentTime);
        activeGain.gain.setValueAtTime(1, fireAtCtxTime);
        activeGain.gain.linearRampToValueAtTime(0, fireAtCtxTime + CROSSFADE_S);
        idleGain.gain.setValueAtTime(0, fireAtCtxTime);
        idleGain.gain.linearRampToValueAtTime(1, fireAtCtxTime + CROSSFADE_S);

        state.armed = { fireAtCtxTime, fromSide: state.active };
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopRaf();
      if (a && !a.paused) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
      if (b && !b.paused) {
        try {
          b.pause();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isReady]);

  return { isReady, audioDuration, error };
}

function clampSeek(t: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, t);
  return Math.max(0, Math.min(duration, t));
}

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function cancelArmedCrossfade(
  graph: AudioGraph | null,
  state: PingPongState,
): void {
  if (!graph || !state.armed) return;
  const t = graph.ctx.currentTime;
  graph.gainA.gain.cancelScheduledValues(t);
  graph.gainB.gain.cancelScheduledValues(t);
  // Snap gains back to current active/idle config.
  graph.gainA.gain.setValueAtTime(state.active === "A" ? 1 : 0, t);
  graph.gainB.gain.setValueAtTime(state.active === "B" ? 1 : 0, t);
  state.armed = null;
}
