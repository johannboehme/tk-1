/**
 * Sequential gapless playback for the Arrange page.
 *
 * Walks the user's `arrangement[]` from item to item: when the active
 * chunk's master-time `endMs` is reached, hop to the next item's
 * `startMs` via the same dual-element ping-pong + WebAudio gain
 * crossfade pattern Triage uses. The crossfade buys gapless transitions
 * even when the next item is at a totally different point in the
 * master audio.
 *
 * The hop logic doesn't care about the chunk's "logical" duration —
 * only the master-time range. The Editor's render path uses the same
 * arrangement to build a multi-segment EditSpec.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { resolveJobAssetUrl } from "../../local/jobs";

const LEAD_TIME_S = 0.05;
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
  armed: { fireAtCtxTime: number; fromSide: "A" | "B"; nextItemId: string | null } | null;
}

const graphCache = new WeakMap<HTMLAudioElement, AudioGraph>();

export function ArrangeAudioMaster() {
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
  const jobId = useArrangeStore((s) => s.jobId);
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const tickTime = useArrangeStore((s) => s.tickTime);
  const setCurrentItemId = useArrangeStore((s) => s.setCurrentItemId);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const graphRef = useRef<AudioGraph | null>(null);
  const stateRef = useRef<PingPongState>({ active: "A", armed: null });
  const rafRef = useRef<number | null>(null);

  // Resolve master audio URL.
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

  useEffect(() => {
    setIsReady(false);
    if (audioUrl && aRef.current) aRef.current.src = audioUrl;
    if (audioUrl && bRef.current) bRef.current.src = audioUrl;
  }, [audioUrl, aRef, bRef]);

  useEffect(() => {
    const a = aRef.current;
    if (!a) return;
    function onLoaded() {
      setIsReady(true);
    }
    a.addEventListener("loadedmetadata", onLoaded);
    if (a.readyState >= 1) onLoaded();
    return () => a.removeEventListener("loadedmetadata", onLoaded);
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
    stateRef.current = { active: "A", armed: null };
  }, [aRef, bRef, isReady]);

  // Resume context on first play (browser autoplay policy).
  useEffect(() => {
    if (!isPlaying) return;
    const g = graphRef.current;
    if (g && g.ctx.state === "suspended") {
      void g.ctx.resume().catch(() => undefined);
    }
  }, [isPlaying]);

  const activeEl = useCallback(
    (): HTMLAudioElement | null =>
      stateRef.current.active === "A" ? aRef.current : bRef.current,
    [aRef, bRef],
  );

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

  // Honor user-initiated seeks by syncing the active element.
  useEffect(() => {
    const unsub = useArrangeStore.subscribe((s, prev) => {
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

  // Main RAF loop: broadcast time, walk arrangement, arm crossfades.
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

        const state = useArrangeStore.getState();
        // Broadcast time.
        if (Math.abs(state.playback.currentTime - t) > 0.01) {
          tickTime(t);
        }

        // Resolve current arrangement item — the one whose master-time
        // range covers `t`.
        const items = state.arrangement;
        const chunkById = new Map(state.chunks.map((c) => [c.id, c]));
        let currentItemIdx = -1;
        for (let i = 0; i < items.length; i++) {
          const ck = chunkById.get(items[i].chunkId);
          if (!ck) continue;
          if (t * 1000 >= ck.startMs && t * 1000 <= ck.endMs) {
            currentItemIdx = i;
            break;
          }
        }
        const curItemId =
          currentItemIdx >= 0 ? items[currentItemIdx].id : null;
        if (state.playback.currentItemId !== curItemId) {
          setCurrentItemId(curItemId);
        }

        // Arm crossfade-hop near current item's end.
        if (state.playback.isPlaying && cur.armed === null && currentItemIdx >= 0) {
          const curChunk = chunkById.get(items[currentItemIdx].chunkId);
          const nextItem = items[currentItemIdx + 1];
          const nextChunk = nextItem ? chunkById.get(nextItem.chunkId) : null;
          if (curChunk) {
            const remaining = curChunk.endMs / 1000 - t;
            if (remaining > 0 && remaining < LEAD_TIME_S) {
              if (nextChunk) {
                // Hop to the next chunk's start.
                try {
                  idle.currentTime = clampSeek(
                    nextChunk.startMs / 1000,
                    idle.duration,
                  );
                } catch {
                  /* ignore */
                }
                void idle.play().catch(() => undefined);
                const fireCtxT = g.ctx.currentTime + remaining;
                scheduleCrossfade(g, cur.active, fireCtxT);
                cur.armed = {
                  fireAtCtxTime: fireCtxT,
                  fromSide: cur.active,
                  nextItemId: nextItem?.id ?? null,
                };
              } else {
                // Last item — stop at end (don't loop in arrange).
                // Schedule a pause that fires after the current chunk end.
                window.setTimeout(() => {
                  setPlaying(false);
                }, Math.max(0, remaining * 1000));
                cur.armed = {
                  fireAtCtxTime: g.ctx.currentTime + remaining,
                  fromSide: cur.active,
                  nextItemId: null,
                };
              }
            }
          }
        }

        // Crossfade fired — swap roles.
        if (
          cur.armed &&
          g.ctx.currentTime >= cur.armed.fireAtCtxTime + CROSSFADE_S
        ) {
          if (cur.armed.nextItemId !== null) {
            active.pause();
            cur.active = cur.active === "A" ? "B" : "A";
          }
          cur.armed = null;
        }
      }
      rafRef.current = window.requestAnimationFrame(tick);
    }
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [aRef, bRef, tickTime, setCurrentItemId, setPlaying]);

  return null;
}

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
  if (state.active === "A") {
    graph.gainA.gain.setValueAtTime(1, t);
    graph.gainB.gain.setValueAtTime(0, t);
  } else {
    graph.gainA.gain.setValueAtTime(0, t);
    graph.gainB.gain.setValueAtTime(1, t);
  }
  state.armed = null;
}
