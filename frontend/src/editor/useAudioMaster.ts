/**
 * Master-clock hook — gapless loop via the shared two-`<audio>`
 * ping-pong + WebAudio crossfade engine (local/audio/pingpong-engine).
 * Replaces the older single-`<audio>` design where loop wrap was a
 * `currentTime`-seek (never gapless on HTMLMediaElement; the browser
 * pauses the decoder to repoint, audible click).
 *
 * Architecture:
 *   The caller mounts TWO hidden `<audio>` elements with the same `src`,
 *   passes both refs in. The PingPongEngine owns the WebAudio graph
 *   (per-element cached — StrictMode safe), the active/idle side
 *   bookkeeping and the crossfade arming/firing mechanics. This hook
 *   owns the EDITOR's walker on top:
 *
 *     - Per RAF tick, reads `activeEl.currentTime` and mirrors it into
 *       `playback.currentTime` (+ the arr-time pill position derived
 *       from the authoritative segment index).
 *     - Walks `arrangementSegments` with an authoritative
 *       `currentSegmentIdx` (duplicate chunks share master-time ranges,
 *       so time-scan lookups are forbidden — see PingPongState docs).
 *     - Within `LEAD_TIME_S` of a loop wrap / segment seam (or
 *       `pendingWrapAt`), asks the engine to arm a sample-accurate
 *       crossfade; when the engine reports it fired, advances the
 *       walker and re-parks the former active element.
 *
 *   Memory cost: two `<audio>` elements + their decoder buffers.
 *   Constant — does NOT decode the file into RAM, so 1h+ takes work
 *   the same as 5-min songs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "./store";
import { nextLoopWrapMasterT } from "./arrangement-loop";
import {
  arrToMaster,
  segmentArrStarts,
  segmentIndexAtArr,
} from "../core/arrangement-time";
import { attachLoopGlitchProbe, isProbeEnabled } from "./audio-glitch-probe";
import { clampSeek } from "../lib/clamp";
import {
  LEAD_TIME_S,
  getOrCreatePingPongEngine,
  type PingPongEngine,
} from "../local/audio/pingpong-engine";

// Re-exported so regression tests (and future walkers) can pin the
// pre-roll compensation math where it has historically been imported.
export { armParkMasterT } from "../local/audio/pingpong-engine";

export interface AudioMasterHandle {
  isReady: boolean;
  audioDuration: number | null;
  error: string | null;
}

interface AudioRefs {
  a: React.RefObject<HTMLAudioElement | null>;
  b: React.RefObject<HTMLAudioElement | null>;
}

/** Payload the walker attaches to an armed crossfade. Interpreted when
 *  the engine reports the fade fired. */
interface EditorArmPayload {
  /** Post-fire seek destination for the former active element —
   *  loop.start (as master-time) for wraps, the next segment's `in`
   *  for arrangement-segment hops. */
  wrapTarget: number;
  /** The segment index we're hopping INTO — used by the walker so it
   *  advances explicitly through duplicate segments instead of
   *  re-deriving from master-time (which would lock into the FIRST
   *  matching duplicate forever). */
  nextSegmentIdx: number | undefined;
}

interface WalkerState {
  /** The arrangement segment we're currently playing through. Tracked
   *  as authoritative state — set by user-seek (re-derived from master
   *  time), advanced on every crossfade-hop. Without this the walker
   *  would re-scan segments[] on every tick and pick the FIRST match,
   *  which loops forever when a chunk is duplicated in the arrangement
   *  (segments[0].master == segments[2].master → after hopping to
   *  index 2 the lookup snaps back to 0). null = direct-mode or pre-
   *  first-tick. */
  currentSegmentIdx: number | null;
  /** End-of-arrangement pause-timeout handle. The walker schedules
   *  setPlaying(false) when the playhead approaches the END of the LAST
   *  segment (no further chunk to crossfade into). Crucially we do NOT
   *  fake-arm a crossfade for this case — that would trigger the swap
   *  block, kick the idle (parked at the previous wrapTarget) onto
   *  PROGRAM, and snap the playhead back to that idle's master-time.
   *  When the previous hop landed on a duplicate of an early chunk this
   *  presents as the song "looping back to the start" right before the
   *  pause, which is the bug the user hit. Cancelled on user-seek + on
   *  isPlaying flip + on loop changes so a manual scrub back into the
   *  arrangement doesn't fire a stale pause. */
  endPauseTimer: ReturnType<typeof setTimeout> | null;
  /** Index of the segment for which `endPauseTimer` was scheduled. The
   *  walker checks this before re-scheduling on every tick during the
   *  LEAD_TIME window. */
  endPauseSegmentIdx: number | null;
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

  const engineRef = useRef<PingPongEngine<EditorArmPayload> | null>(null);
  const walkerRef = useRef<WalkerState>({
    currentSegmentIdx: null,
    endPauseTimer: null,
    endPauseSegmentIdx: null,
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
        // Replay onto the ACTIVE side. The ping-pong state survives URL
        // changes (the engine is cached per element), so after an odd
        // number of crossfade swaps the audible element is B — writing
        // the stashed seek to A would land it on the muted idle and the
        // playhead would silently resume from B's stale position.
        const eng = engineRef.current;
        const active = eng ? eng.activeEl : refsStable.a.current;
        if (active) {
          try {
            active.currentTime = clampSeek(pending, active.duration);
          } catch {
            /* element not ready */
          }
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

  // Build (or reuse) the shared ping-pong engine once both elements are
  // mounted. Idempotent under React 18 StrictMode — the engine module
  // caches per element, so the second effect run reuses the existing
  // graph instead of re-wrapping an already-captured `<audio>`.
  useEffect(() => {
    const a = refsStable.a.current;
    const b = refsStable.b.current;
    if (!a || !b) return;
    if (engineRef.current) return;

    const res = getOrCreatePingPongEngine<EditorArmPayload>(a, b, {
      initialMasterGain: audioVolume,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    engineRef.current = res.engine;
    if (!res.fresh) {
      // Cached engine (StrictMode re-run) — don't reset the walker,
      // playback may already be in flight.
      return;
    }
    walkerRef.current = {
      currentSegmentIdx: null,
      endPauseTimer: null,
      endPauseSegmentIdx: null,
    };
    if (isProbeEnabled()) {
      void attachLoopGlitchProbe(
        res.engine.graph.ctx,
        res.engine.graph.master,
      ).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[loop-glitch-probe]", err);
      });
    }
    // No teardown returned — see the engine-cache JSDoc. The context is
    // GC'd alongside the audio elements when the component truly
    // unmounts.
  }, [refsStable.a, refsStable.b]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror master volume onto the master GainNode (with a tiny ramp to
  // avoid zipper noise on slider drag).
  useEffect(() => {
    engineRef.current?.setMasterVolume(audioVolume);
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
    const eng = engineRef.current;
    const active = eng ? eng.activeEl : a;
    try {
      active.currentTime = clampSeek(seekRequest, active.duration);
    } catch {
      pendingSeekRef.current = seekRequest;
    }
    // Cancel any armed crossfade — user seek invalidates it (the loop
    // boundary may now be far away or behind us).
    cancelEndPause(walkerRef.current);
    eng?.cancelArmed();
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
        walkerRef.current.currentSegmentIdx = hint;
      } else {
        let idx = -1;
        for (let i = 0; i < segs.length; i++) {
          if (seekRequest >= segs[i].in && seekRequest < segs[i].out) {
            idx = i;
            break;
          }
        }
        walkerRef.current.currentSegmentIdx = idx === -1 ? null : idx;
      }
    } else {
      walkerRef.current.currentSegmentIdx = null;
    }
    clear();
  }, [seekRequest, isReady, refsStable.a, refsStable.b]);

  // When the loop region changes (or is unset), park the idle element
  // at the new loop.start and reset any armed crossfade. This handles
  // user-IN/OUT, OP-1 loop-shift, and loop-clear in one path.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    cancelEndPause(walkerRef.current);
    eng.cancelArmed();
    if (!loop) return;
    // `loop.start` is arr-time on the composed tape; the <audio> clock is
    // master-time. Project before parking — Identity for single-take, but
    // off by the segment offset in long-form (the tick re-parks at the
    // correct wrapTargetMasterT before any crossfade, so this was masked,
    // but parking the right master-time up front avoids a cold-decoder
    // attack if a wrap fires immediately after the loop is set).
    const parkMasterT = arrToMaster(
      loop.start,
      useEditorStore.getState().arrangementSegments,
    );
    eng.parkIdle(parkMasterT);
  }, [loop]);

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
    const eng = engineRef.current;
    if (!eng || !isReady) return;

    if (!isPlaying) {
      stopRaf();
      // Defensive pause both sides + cancel any pending fade. Reset
      // gains so the next play() starts cleanly with the active side
      // audible.
      cancelEndPause(walkerRef.current);
      eng.cancelArmed();
      eng.pauseBoth();
      eng.snapGainsToActive();
      return;
    }

    // Resume the context if a previous setPlaying(false) had no effect
    // on it. resume() is idempotent.
    eng.resumeContext();

    eng.playActive().catch((err) => {
      setError(err instanceof Error ? err.message : "audio.play() failed");
    });

    function tick() {
      const engine = engineRef.current;
      if (!engine) {
        rafRef.current = null;
        return;
      }
      const store = useEditorStore.getState();
      if (!store.playback.isPlaying) {
        rafRef.current = null;
        return;
      }
      const walker = walkerRef.current;
      const active = engine.activeEl;
      const t = active.currentTime;
      // Compute timeline-time from the authoritative segment idx so
      // duplicate-source pills don't snap to the first occurrence's
      // arr-position. We do this BEFORE any segment-validation logic so
      // a momentary master-time drift past `seg.out` (RAF stall, browser
      // nudge) doesn't bounce the playhead back to a duplicate even for
      // a single tick.
      {
        const segs = store.arrangementSegments;
        let pillT = t;
        if (segs.length > 0 && walker.currentSegmentIdx != null) {
          const idx = walker.currentSegmentIdx;
          if (idx >= 0 && idx < segs.length) {
            const arrStarts = segmentArrStarts(segs);
            pillT = arrStarts[idx] + Math.max(0, t - segs[idx].in);
          }
        }
        store.setPlayhead(t, pillT);
      }

      // Has an armed crossfade fired already? The engine detects it by
      // audioContext.currentTime — on the audio render thread the ramp
      // completed at fireAtCtxTime + CROSSFADE_S, so any tick observing
      // that bound has already heard the swap.
      const fired = engine.consumeFired();
      if (fired) {
        // Swap roles. The new idle = the former active, which is still
        // playing past the wrap point and must be paused + re-parked at
        // the wrap target (loop.start for normal loops, the next
        // segment's `in` for arrangement-segment hops) so it's ready
        // for the NEXT wrap.
        const wrapLoop = store.playback.loop;
        // A fired wrap/hop invalidates any scheduled end-of-arrangement
        // pause — we've just crossfaded away from the segment it was
        // scheduled for. Without this a stale timer stops playback
        // milliseconds after a loop wrap at the arrangement's end.
        cancelEndPause(walker);
        // Authoritative segment-walker advance: the listener is now
        // hearing the segment whose `in` we crossfaded into. Stamp it
        // into state so the next tick's segment lookup doesn't snap
        // backward to a duplicate of an earlier chunk that happens to
        // share the same master-time range.
        if (fired.payload.nextSegmentIdx !== undefined) {
          walker.currentSegmentIdx = fired.payload.nextSegmentIdx;
        }
        engine.swapSides(
          fired.payload.wrapTarget ?? (wrapLoop ? wrapLoop.start : undefined),
        );
        // Clear any pendingWrapAt — the deferred wrap just happened.
        if (store.playback.pendingWrapAt != null) {
          store.clearPendingWrap();
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ─── Composed-timeline walker ─────────────────────────────────
      // Every job lands here with at least one segment — single-take
      // jobs synthesize `[{in:0, out:duration}]` in synthesizeJobLoadShape,
      // long-form jobs feed their full chunk arrangement. arr-time then
      // equals master-time for single-take and the user's loop markers
      // map straight through.
      //
      // The walker uses an AUTHORITATIVE walker.currentSegmentIdx instead
      // of re-deriving from master-time on every tick — duplicate chunks
      // (same master-time range used multiple times in the arrangement)
      // share master-time bounds, so a "scan-for-first-match" lookup
      // would lock the playback into the first occurrence forever. The
      // index advances on each crossfade hop and re-binds on user-seek.
      const segs = store.arrangementSegments;
      if (segs.length > 0) {
        let curIdx = walker.currentSegmentIdx ?? -1;
        // The cached index is AUTHORITATIVE — set on user-seek and on
        // every crossfade hop. We do NOT invalidate it just because the
        // browser nudged `t` past `seg.out` for a tick; that would scan
        // for the first master-time match and bounce the playhead onto
        // a duplicate occurrence (the "1-2-1-4" bug). The only legitimate
        // reasons for re-scanning are: (a) startup with no prior state
        // (curIdx == null), (b) the segment list shape changed and the
        // old index is now out-of-bounds.
        if (curIdx < 0 || curIdx >= segs.length) {
          curIdx = -1;
          for (let i = 0; i < segs.length; i++) {
            if (t >= segs[i].in - 1e-3 && t < segs[i].out) {
              curIdx = i;
              break;
            }
          }
          if (curIdx !== -1) walker.currentSegmentIdx = curIdx;
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
            walker.currentSegmentIdx = null;
            rafRef.current = null;
            return;
          }
          const target = segs[nextIdx].in;
          try {
            active.currentTime = clampSeek(target, active.duration);
          } catch {
            /* ignore */
          }
          walker.currentSegmentIdx = nextIdx;
          const arrStarts = segmentArrStarts(segs);
          store.setPlayhead(target, arrStarts[nextIdx]);
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        const curSeg = segs[curIdx];
        const nextSeg = segs[curIdx + 1] ?? null;
        const distToEnd = curSeg.out - t;

        // ── Loop-wrap arming (composed-timeline / OP-1 tape mode) ──
        // The user marks loop in/out on the arr-time tape. We project
        // those markers down to master-time wrap geometry per tick; the
        // wrap fires inside ONE specific segment occurrence (dedup-safe
        // for arrangements where the same chunk appears twice).
        //
        // The wrap takes priority over hop-arming when it fires inside
        // the current segment: the segment-hop would otherwise schedule
        // first and the loop wrap target would never be reached.
        const loop = store.playback.loop;
        const loopWrap = nextLoopWrapMasterT(loop, segs);
        const wrapHere =
          loopWrap !== null && loopWrap.wrapInSegIdx === curIdx;
        const pendingWrapAt = store.playback.pendingWrapAt;
        if (loop && !engine.isArmed) {
          // arr-time of the playhead WITHIN this specific segment
          // occurrence. segmentArrStarts handles duplicates correctly —
          // we anchor to curIdx, not to a master-time scan.
          const arrStarts = segmentArrStarts(segs);
          const arrT = arrStarts[curIdx] + (t - curSeg.in);

          // OP-1 deferred shift: when `pendingWrapAt` is set the loop
          // bounds are ignored entirely — the active element keeps
          // playing through whatever territory it's in until arr-time
          // reaches the deferred wrap point (typically the OLD loop's
          // end), at which moment we wrap to the new loop.start. Without
          // this branch the "outside loop → immediate wrap" rule below
          // would yank the playhead back the moment the user shifted
          // the loop, defeating the whole point of the deferred shift.
          if (pendingWrapAt != null && loopWrap) {
            const pendingSegIdx = segmentIndexAtArr(pendingWrapAt, segs);
            // Half-open: arr exactly at totalArr returns -1 — clamp to
            // last segment so the wrap can still fire.
            const armSegIdx =
              pendingSegIdx === -1 ? segs.length - 1 : pendingSegIdx;
            if (armSegIdx === curIdx) {
              const masterTAtPending =
                curSeg.in + (pendingWrapAt - arrStarts[curIdx]);
              const distMaster = masterTAtPending - t;
              if (distMaster <= LEAD_TIME_S) {
                engine.armCrossfade({
                  distS: distMaster,
                  targetS: loopWrap.wrapTargetMasterT,
                  payload: {
                    wrapTarget: loopWrap.wrapTargetMasterT,
                    nextSegmentIdx: loopWrap.targetSegIdx,
                  },
                });
                rafRef.current = requestAnimationFrame(tick);
                return;
              }
            }
            // pendingWrapAt is in a future segment OR not yet within
            // lead-window: skip the regular loop-arming below (else the
            // immediate-wrap branch would trigger and defeat the deferred
            // shift) but fall through to segment-hop arming so we can
            // walk into the segment that contains pendingWrapAt.
          }

          // Skip the immediate / lead-window arming when pendingWrapAt
          // is queued — only the OP-1 branch above is allowed to fire,
          // and only the segment-hop block below should still run.
          const insideLoop = arrT >= loop.start && arrT < loop.end;
          if (pendingWrapAt == null && !insideLoop && loopWrap) {
            // User scrubbed outside the loop region (before-start or
            // past-end) — wrap immediately. Crossfade with zero distance.
            engine.armCrossfade({
              distS: 0,
              targetS: loopWrap.wrapTargetMasterT,
              payload: {
                wrapTarget: loopWrap.wrapTargetMasterT,
                nextSegmentIdx: loopWrap.targetSegIdx,
              },
            });
            rafRef.current = requestAnimationFrame(tick);
            return;
          }

          if (pendingWrapAt == null && wrapHere && loopWrap) {
            const distToWrap = loopWrap.wrapAtMasterT - t;
            if (distToWrap <= LEAD_TIME_S) {
              // Within lead window (or briefly past on RAF stall) — arm.
              engine.armCrossfade({
                distS: distToWrap,
                targetS: loopWrap.wrapTargetMasterT,
                payload: {
                  wrapTarget: loopWrap.wrapTargetMasterT,
                  nextSegmentIdx: loopWrap.targetSegIdx,
                },
              });
              rafRef.current = requestAnimationFrame(tick);
              return;
            }
          }
        }

        // Hop-arming guard: skip the segment hop only when the loop wrap
        // is going to fire INSIDE this segment first. The pendingWrapAt
        // (deferred shift) doesn't follow `loopWrap`'s geometry — it has
        // its own arming branch above and shouldn't suppress hops.
        const wrapBlocksHop = pendingWrapAt == null && wrapHere;
        if (
          !engine.isArmed &&
          distToEnd <= LEAD_TIME_S &&
          nextSeg &&
          !wrapBlocksHop
        ) {
          // Approaching a segment boundary with another chunk to hop
          // into — arm a sample-accurate gain crossfade. The idle is
          // pre-played at nextSeg.in so its decoder is hot by the time
          // the ramp fires; payload.nextSegmentIdx tells the fired
          // branch which index to advance into (handles duplicates).
          //
          // No lower bound on distToEnd: like the loop-wrap path, this
          // tolerates a tick landing AT or PAST the boundary (RAF stall,
          // GC pause, hidden tab). The crossfade then fires immediately —
          // without this the hop would never arm, the authoritative index
          // would never advance, and the active element would free-run
          // into master material that is not in the arrangement.
          engine.armCrossfade({
            distS: distToEnd,
            targetS: nextSeg.in,
            payload: { wrapTarget: nextSeg.in, nextSegmentIdx: curIdx + 1 },
          });
        } else if (
          !engine.isArmed &&
          !nextSeg &&
          distToEnd <= LEAD_TIME_S &&
          walker.endPauseSegmentIdx !== curIdx
        ) {
          // `!engine.isArmed`: while a loop-wrap crossfade is armed
          // in this segment (loop.end at/near the last segment's out),
          // ticks inside the lead window would otherwise schedule a
          // setPlaying(false) timer that fires right after the wrap and
          // kills the loop's next pass.
          // No lower bound on distToEnd here either: a stall can carry t
          // past the last segment's out without a tick in the lead
          // window — the timer then fires with zero delay instead of the
          // playhead sailing to the end of the master file.
          // Last segment — schedule a pause when the active element
          // reaches its `out`. We do NOT engage the crossfade machinery
          // here: a fake-arm would trip the swap block on the next tick
          // and kick the idle (parked at the previous wrapTarget) onto
          // PROGRAM, which snaps the playhead back to that idle's
          // master-time and presents as the song "looping back to the
          // start" right before the pause. Leaving the active element
          // playing past `out` for ~LEAD_TIME until the timeout fires
          // is fine — the master audio runs out of arrangement, the
          // user hears the natural tail of the chunk for a few ms.
          walker.endPauseSegmentIdx = curIdx;
          walker.endPauseTimer = setTimeout(() => {
            useEditorStore.getState().setPlaying(false);
          }, Math.max(0, distToEnd * 1000));
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // No segments + no finite duration: nothing to play. Yield until
      // the audio loads (`isReady` flips and the effect re-runs).
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopRaf();
      eng.pauseBoth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isReady]);

  return { isReady, audioDuration, error };
}

function cancelEndPause(walker: WalkerState): void {
  if (walker.endPauseTimer != null) {
    clearTimeout(walker.endPauseTimer);
    walker.endPauseTimer = null;
  }
  walker.endPauseSegmentIdx = null;
}
