/**
 * Triage audio playback — gapless loop via two-`<audio>` ping-pong +
 * WebAudio gain-crossfade. Same pattern as the editor's `useAudioMaster`,
 * scoped down to what Triage needs (no A/B-bypass, no audio-volume
 * coupling).
 *
 * Why dual-element: a single-element loop wrap is `currentTime = X`
 * which always interrupts the decoder and produces an audible click.
 * Triage loops chunks for review — the user listens to a chunk repeat
 * many times to decide keep/drop. Even one click per loop wrap turns
 * the screen unusable. Dual-element with a 8 ms WebAudio gain ramp
 * is sample-accurate and below click-perception thresholds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTriageStore } from "../../local/triage/triage-store";
import {
  buildSequence,
  nextSequenceId,
  resolveSeamWindow,
  seamHopTarget,
} from "../../local/triage/triage-sequence";
import { resolveJobAssetUrl } from "../../local/jobs";

/** Seconds before the loop wrap point at which the crossfade is
 *  armed. The idle element is `play()`'d at this point so it's
 *  running by the time the gain ramp hits. 50 ms is conservative —
 *  `<audio>.play()` → first sample is typically 10–30 ms. */
const LEAD_TIME_S = 0.05;

/** Crossfade duration. 8 ms is below click-perception (~10 ms) for
 *  most material yet long enough to absorb inter-element decode
 *  jitter. */
const CROSSFADE_S = 0.008;

interface AudioGraph {
  ctx: AudioContext;
  srcA: MediaElementAudioSourceNode;
  srcB: MediaElementAudioSourceNode;
  gainA: GainNode;
  gainB: GainNode;
  master: GainNode;
}

interface PingPongState {
  active: "A" | "B";
  armed: {
    fireAtCtxTime: number;
    fromSide: "A" | "B";
    /** Sequence walker: chunk id to advance focus to when the crossfade
     *  fires. null = current chunk was the last one (just stop, no swap).
     *  Absent for plain loop wraps. */
    seqNextId?: string | null;
    /** Seam loop: which window to switch to when the crossfade fires. */
    seamNextPhase?: "A" | "B";
  } | null;
  /** Seam loop: which window is currently playing (A-tail or B-head). */
  seamPhase: "A" | "B";
}

type Branch = "continue" | "loop" | "sequence" | "seam";

// MediaElementAudioSourceNode permanently captures its source element
// — calling createMediaElementSource twice for the same element throws.
// React 18 StrictMode runs effects twice in dev, so cache the graph.
const graphCache = new WeakMap<HTMLAudioElement, AudioGraph>();

export function TriageAudioMaster() {
  const aRef = useRef<HTMLAudioElement | null>(null);
  const bRef = useRef<HTMLAudioElement | null>(null);
  return (
    <>
      <audio ref={aRef} preload="auto" style={{ display: "none" }} />
      <audio ref={bRef} preload="auto" style={{ display: "none" }} />
      <Driver aRef={aRef} bRef={bRef} />
    </>
  );
}

function Driver({
  aRef,
  bRef,
}: {
  aRef: React.RefObject<HTMLAudioElement | null>;
  bRef: React.RefObject<HTMLAudioElement | null>;
}) {
  const jobId = useTriageStore((s) => s.jobId);
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const loop = useTriageStore((s) => s.playback.loop);
  const setPlaying = useTriageStore((s) => s.setPlaying);
  const tickTime = useTriageStore((s) => s.tickTime);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const graphRef = useRef<AudioGraph | null>(null);
  const stateRef = useRef<PingPongState>({ active: "A", armed: null, seamPhase: "A" });
  const branchRef = useRef<Branch>("continue");
  const rafRef = useRef<number | null>(null);

  // Resolve URL.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let revokeMe: string | null = null;
    void resolveJobAssetUrl(jobId, "audio").then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revokeMe = url;
      setAudioUrl(url);
    });
    return () => {
      cancelled = true;
      if (revokeMe) URL.revokeObjectURL(revokeMe);
    };
  }, [jobId]);

  // Apply URL to both elements + reset readiness.
  useEffect(() => {
    setIsReady(false);
    if (audioUrl && aRef.current) aRef.current.src = audioUrl;
    if (audioUrl && bRef.current) bRef.current.src = audioUrl;
  }, [audioUrl, aRef, bRef]);

  // Wait for A-side metadata so we know we can build the graph.
  useEffect(() => {
    const a = aRef.current;
    if (!a) return;
    function onLoaded() {
      setIsReady(true);
    }
    a.addEventListener("loadedmetadata", onLoaded);
    if (a.readyState >= 1) onLoaded();
    return () => {
      a.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [aRef, audioUrl]);

  // Build / reuse the WebAudio graph.
  useEffect(() => {
    const a = aRef.current;
    const b = bRef.current;
    if (!a || !b || !isReady) return;
    if (graphRef.current) return;

    const cached = graphCache.get(a);
    if (cached) {
      graphRef.current = cached;
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    let srcA: MediaElementAudioSourceNode;
    let srcB: MediaElementAudioSourceNode;
    try {
      srcA = ctx.createMediaElementSource(a);
      srcB = ctx.createMediaElementSource(b);
    } catch {
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
    master.gain.value = 1;
    srcA.connect(gainA).connect(master);
    srcB.connect(gainB).connect(master);
    master.connect(ctx.destination);
    const graph: AudioGraph = { ctx, srcA, srcB, gainA, gainB, master };
    graphCache.set(a, graph);
    graphRef.current = graph;
    stateRef.current = { active: "A", armed: null, seamPhase: "A" };
  }, [aRef, bRef, isReady]);

  // Resume the AudioContext on the first interaction (browser
  // autoplay policy).
  useEffect(() => {
    if (!isPlaying) return;
    const g = graphRef.current;
    if (g && g.ctx.state === "suspended") {
      void g.ctx.resume().catch(() => undefined);
    }
  }, [isPlaying]);

  const activeEl = useCallback((): HTMLAudioElement | null => {
    return stateRef.current.active === "A" ? aRef.current : bRef.current;
  }, [aRef, bRef]);
  const idleEl = useCallback((): HTMLAudioElement | null => {
    return stateRef.current.active === "A" ? bRef.current : aRef.current;
  }, [aRef, bRef]);

  // Mirror play/pause onto the active element.
  useEffect(() => {
    const el = activeEl();
    if (!el) return;
    if (isPlaying) {
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }, [isPlaying, activeEl, setPlaying]);

  // Park the idle element at loop.start whenever the loop region
  // changes. Resets any armed crossfade.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    cancelArmed(g, stateRef.current);
    if (!loop) return;
    const idle = idleEl();
    if (!idle) return;
    try {
      idle.pause();
      idle.currentTime = clampSeek(loop.start, idle.duration);
    } catch {
      /* not ready */
    }
  }, [loop, idleEl]);

  // Honor seek requests from the store. We compare to the active
  // element's currentTime to avoid feedback loops with our own RAF tick.
  useEffect(() => {
    const unsub = useTriageStore.subscribe((s, prev) => {
      if (s.playback.currentTime === prev.playback.currentTime) return;
      const el = activeEl();
      if (!el) return;
      if (
        Math.abs(el.currentTime - s.playback.currentTime) > 0.05 &&
        Number.isFinite(el.duration)
      ) {
        try {
          el.currentTime = clampSeek(s.playback.currentTime, el.duration);
        } catch {
          /* ignore */
        }
        cancelArmed(graphRef.current, stateRef.current);
      }
    });
    return unsub;
  }, [activeEl]);

  // RAF loop: broadcast time + arm crossfade near loop boundary.
  useEffect(() => {
    function tick() {
      const g = graphRef.current;
      const a = aRef.current;
      const b = bRef.current;
      if (g && a && b) {
        const cur = stateRef.current;
        const active = cur.active === "A" ? a : b;
        const idle = cur.active === "A" ? b : a;
        const t = active.currentTime;
        const state = useTriageStore.getState();
        const pb = state.playback;
        // Push time to store (throttled by ~10 ms) — all modes.
        if (Math.abs(pb.currentTime - t) > 0.01) {
          tickTime(t);
        }

        // Pick the active branch. When it changes (mode cycled mid-play)
        // cancel any armed crossfade so it can't fire into the new
        // geometry.
        const branch: Branch = pb.seam
          ? "seam"
          : pb.mode === "sequence"
            ? "sequence"
            : pb.mode === "loop" && pb.loop
              ? "loop"
              : "continue";
        if (branchRef.current !== branch) {
          cancelArmed(g, cur);
          // Entering seam always starts in the A-tail window.
          if (branch === "seam") cur.seamPhase = "A";
          branchRef.current = branch;
        }

        if (branch === "seam") {
          // Loop a window straddling the A→B cut:
          //   [loopIn → A.end] (A) → hop → [B.start → loopOut] (B) → wrap.
          // A.end / B.start are read fresh (live trims); loopIn / loopOut
          // are the ephemeral brackets. Same crossfade for both hops.
          const win = pb.seam ? resolveSeamWindow(pb.seam, state.chunks) : null;
          if (win && cur.armed === null) {
            // Derive the audition window from the playhead so a user seek
            // into either lane updates which side we're on. Disjoint
            // windows are unambiguous; on overlap keep the tracked phase.
            const inA = t >= win.loopInS - 0.01 && t <= win.aEndS + 0.05;
            const inB = t >= win.bStartS - 0.05 && t <= win.loopOutS + 0.01;
            if (inA && !inB) cur.seamPhase = "A";
            else if (inB && !inA) cur.seamPhase = "B";
          }
          if (win && pb.isPlaying && cur.armed === null) {
            const { armAtS, seekToS, nextPhase } = seamHopTarget(
              win,
              cur.seamPhase,
            );
            const remaining = armAtS - t;
            if (remaining > 0 && remaining < LEAD_TIME_S) {
              try {
                idle.currentTime = clampSeek(seekToS, idle.duration);
              } catch {
                /* ignore */
              }
              void idle.play().catch(() => undefined);
              const fireCtxT = g.ctx.currentTime + remaining;
              scheduleCrossfade(g, cur.active, fireCtxT);
              cur.armed = {
                fireAtCtxTime: fireCtxT,
                fromSide: cur.active,
                seamNextPhase: nextPhase,
              };
            } else if (t >= armAtS + 0.05) {
              // Missed the lead window (dropped frame, or a live trim
              // moved the boundary behind the playhead) — hard-jump +
              // flip phase so the loop recovers.
              try {
                active.currentTime = clampSeek(seekToS, active.duration);
              } catch {
                /* ignore */
              }
              cur.seamPhase = nextPhase;
            }
          }
          // Crossfade fired — swap active + flip window. Runs regardless
          // of isPlaying so a stale armed flag clears on pause.
          if (
            cur.armed &&
            cur.armed.seamNextPhase &&
            g.ctx.currentTime >= cur.armed.fireAtCtxTime + CROSSFADE_S
          ) {
            active.pause();
            cur.active = cur.active === "A" ? "B" : "A";
            cur.seamPhase = cur.armed.seamNextPhase;
            cur.armed = null;
          }
        } else if (branch === "loop") {
          const lp = pb.loop!;
          // Loop arming.
          if (cur.armed === null && pb.isPlaying) {
            const remaining = lp.end - t;
            if (remaining > 0 && remaining < LEAD_TIME_S) {
              // Park idle at loop.start and play it; schedule the
              // crossfade to fire at ctx-time = now + remaining.
              try {
                idle.currentTime = clampSeek(lp.start, idle.duration);
              } catch {
                /* ignore */
              }
              void idle.play().catch(() => undefined);
              const fireCtxT = g.ctx.currentTime + remaining;
              scheduleCrossfade(g, cur.active, fireCtxT);
              cur.armed = { fireAtCtxTime: fireCtxT, fromSide: cur.active };
            }
          }
          // Crossfade has fired — swap active + re-park old active at
          // loop.start for the next wrap.
          if (cur.armed && g.ctx.currentTime >= cur.armed.fireAtCtxTime + CROSSFADE_S) {
            active.pause();
            try {
              active.currentTime = clampSeek(lp.start, active.duration);
            } catch {
              /* ignore */
            }
            cur.active = cur.active === "A" ? "B" : "A";
            cur.armed = null;
          }
          // Out-of-loop safety net: if the active element ran past
          // loop.end without an armed crossfade (e.g. dropped frame),
          // emergency hard-seek back to start.
          if (t >= lp.end + 0.05 && pb.isPlaying) {
            try {
              active.currentTime = clampSeek(lp.start, active.duration);
            } catch {
              /* ignore */
            }
          }
        } else if (branch === "sequence") {
          // Walk the kept chunks chronologically, hopping from each
          // chunk's endMs to the next chunk's startMs with the same
          // gapless crossfade. Identity is `focusedChunkId` (not time),
          // so duplicate master-times can't collapse the walker.
          const seq = buildSequence(
            state.chunks,
            state.minChunkBars,
            state.jobBpm?.value ?? null,
            state.beatsPerBar,
          );
          const curId = state.focusedChunkId;
          const curIdx = curId ? seq.findIndex((c) => c.id === curId) : -1;
          if (pb.isPlaying && cur.armed === null) {
            if (curIdx === -1) {
              // Focus drifted off the kept set mid-play → stop. (Start
              // positioning is handled synchronously in setPlaying.)
              state.setPlaying(false);
            } else {
              const curChunk = seq[curIdx];
              const remaining = curChunk.endMs / 1000 - t;
              if (remaining > 0 && remaining < LEAD_TIME_S) {
                const nextId = nextSequenceId(seq, curId);
                const fireCtxT = g.ctx.currentTime + remaining;
                if (nextId) {
                  const nextChunk = seq[curIdx + 1];
                  try {
                    idle.currentTime = clampSeek(
                      nextChunk.startMs / 1000,
                      idle.duration,
                    );
                  } catch {
                    /* ignore */
                  }
                  void idle.play().catch(() => undefined);
                  scheduleCrossfade(g, cur.active, fireCtxT);
                  cur.armed = {
                    fireAtCtxTime: fireCtxT,
                    fromSide: cur.active,
                    seqNextId: nextId,
                  };
                } else {
                  // Last kept chunk — stop at its end (no loop in
                  // sequence). Arm with a null target to block re-arming;
                  // a timer does the actual pause at the chunk end.
                  cur.armed = {
                    fireAtCtxTime: fireCtxT,
                    fromSide: cur.active,
                    seqNextId: null,
                  };
                  window.setTimeout(
                    () => useTriageStore.getState().setPlaying(false),
                    Math.max(0, remaining * 1000),
                  );
                }
              }
            }
          }
          // Crossfade fired — swap + advance the walker (no currentTime
          // write; the idle element already carried the playhead to the
          // next chunk's start). Runs regardless of isPlaying so a
          // last-chunk armed flag clears.
          if (cur.armed && g.ctx.currentTime >= cur.armed.fireAtCtxTime + CROSSFADE_S) {
            if (cur.armed.seqNextId != null) {
              active.pause();
              cur.active = cur.active === "A" ? "B" : "A";
              state.sequenceAdvance(cur.armed.seqNextId);
            }
            cur.armed = null;
          }
        }
        // continue: time broadcast only — no arming, no wrap.
      }
      rafRef.current = window.requestAnimationFrame(tick);
    }
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [aRef, bRef, tickTime]);

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clampSeek(target: number, duration: number): number {
  if (!Number.isFinite(target)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, target);
  return Math.max(0, Math.min(duration, target));
}

function scheduleCrossfade(g: AudioGraph, fromSide: "A" | "B", fireCtxT: number) {
  const fromGain = fromSide === "A" ? g.gainA : g.gainB;
  const toGain = fromSide === "A" ? g.gainB : g.gainA;
  fromGain.gain.cancelScheduledValues(fireCtxT);
  toGain.gain.cancelScheduledValues(fireCtxT);
  fromGain.gain.setValueAtTime(1, fireCtxT);
  toGain.gain.setValueAtTime(0, fireCtxT);
  fromGain.gain.linearRampToValueAtTime(0, fireCtxT + CROSSFADE_S);
  toGain.gain.linearRampToValueAtTime(1, fireCtxT + CROSSFADE_S);
}

function cancelArmed(graph: AudioGraph | null, state: PingPongState) {
  if (!graph || !state.armed) {
    state.armed = null;
    return;
  }
  const t = graph.ctx.currentTime;
  graph.gainA.gain.cancelScheduledValues(t);
  graph.gainB.gain.cancelScheduledValues(t);
  // Restore the static configuration: active = 1, idle = 0.
  if (state.active === "A") {
    graph.gainA.gain.setValueAtTime(1, t);
    graph.gainB.gain.setValueAtTime(0, t);
  } else {
    graph.gainA.gain.setValueAtTime(0, t);
    graph.gainB.gain.setValueAtTime(1, t);
  }
  state.armed = null;
}

