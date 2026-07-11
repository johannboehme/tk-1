/**
 * Sequential gapless playback for the Arrange page.
 *
 * Walks the user's `arrangement[]` from item to item: when the active
 * chunk's master-time `endMs` is reached, hop to the next item's
 * `startMs` via the shared dual-element ping-pong + WebAudio gain
 * crossfade engine (local/audio/pingpong-engine) that Triage and the
 * Editor use too. The crossfade buys gapless transitions even when the
 * next item is at a totally different point in the master audio.
 *
 * The hop logic doesn't care about the chunk's "logical" duration —
 * only the master-time range. The Editor's render path uses the same
 * arrangement to build a multi-segment EditSpec. All walker branching
 * lives in the pure planner — see arrange-walker.ts; this driver just
 * executes plans against the engine.
 */
import { useCallback, useEffect, useRef } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import { planWalkerTick } from "./arrange-walker";
import { LEAD_TIME_S } from "../../local/audio/pingpong-engine";
import { usePingPongTransport } from "../../local/audio/use-pingpong-transport";

/** Walker data attached to an armed crossfade, interpreted on fire. */
interface ArrangeArmPayload {
  /** True for real hops (advance / preview-loop): pause the old side
   *  and flip roles when the crossfade fires. False for the end-of-
   *  arrangement stop, which pauses via timeout instead (sentinel arm —
   *  no gain ramps, no side swap). */
  swapSides: boolean;
  /** Item the walker advances to when the crossfade fires. Null for
   *  preview-loops (walker stays detached) and the end-stop. */
  nextItemId: string | null;
}

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

  const rafRef = useRef<number | null>(null);

  const subscribeExternalTime = useCallback(
    (cb: (tS: number) => void) =>
      useArrangeStore.subscribe((s, prev) => {
        if (s.playback.currentTime !== prev.playback.currentTime) {
          cb(s.playback.currentTime);
        }
      }),
    [],
  );

  const { engineRef } = usePingPongTransport<ArrangeArmPayload>({
    aRef,
    bRef,
    jobId,
    isPlaying,
    onPlayRejected: () => setPlaying(false),
    subscribeExternalTime,
  });

  // Main RAF loop: broadcast time, walk arrangement, arm crossfades.
  useEffect(() => {
    function tick() {
      const eng = engineRef.current;
      if (eng) {
        const t = eng.activeEl.currentTime;

        const state = useArrangeStore.getState();
        // Broadcast time.
        if (Math.abs(state.playback.currentTime - t) > 0.01) {
          tickTime(t);
        }

        // The walker is identified by `currentItemId` (authoritative
        // store state) — NOT by master-time matching. That way a
        // duplicate of the same chunk doesn't collapse to the same
        // index and loop forever, and a deletion in front of the
        // current item doesn't yank the playhead onto a stale chunk.
        // A non-null `previewChunkId` switches the walker into the
        // pool-preview loop instead (chunk audition). All branching
        // lives in the pure planner — see arrange-walker.ts.
        const plan = planWalkerTick({
          isPlaying: state.playback.isPlaying,
          hasArmed: eng.isArmed,
          tS: t,
          arrangement: state.arrangement,
          chunks: state.chunks,
          currentItemId: state.playback.currentItemId,
          previewChunkId: state.previewChunkId,
          leadTimeS: LEAD_TIME_S,
        });
        if (plan.kind === "stop") {
          setPlaying(false);
        } else if (plan.kind === "arm-advance" || plan.kind === "arm-loop") {
          // Hop to the plan's master-time slice. Same gapless
          // ping-pong: idle element pre-plays the target while the
          // active element finishes the current stretch, then a gain
          // crossfade swaps them. For advances we record the NEXT
          // ITEM ID — that's what advances `currentItemId` when the
          // crossfade fires, not whatever happens to match `t * 1000`
          // afterwards. Preview-loops keep the walker detached.
          eng.armCrossfade({
            distS: plan.remainingS,
            targetS: plan.hopToS,
            payload: {
              swapSides: true,
              nextItemId:
                plan.kind === "arm-advance" ? plan.nextItemId : null,
            },
          });
        } else if (plan.kind === "arm-end") {
          // Last item — stop at end (don't loop in arrange).
          // Schedule a pause that fires after the current chunk end.
          // Sentinel arm only (no gain ramps): a fake crossfade would
          // kick the idle — parked at an earlier master-time — onto
          // PROGRAM and snap the playhead backwards.
          window.setTimeout(() => {
            setPlaying(false);
          }, Math.max(0, plan.remainingS * 1000));
          eng.armWithoutCrossfade({
            distS: plan.remainingS,
            payload: { swapSides: false, nextItemId: null },
          });
        }

        // Crossfade fired — swap roles and (for advances) walk on.
        const fired = eng.consumeFired();
        if (fired && fired.payload.swapSides) {
          eng.swapSides();
          if (fired.payload.nextItemId !== null) {
            // Walker advance: explicit, not via time-match.
            setCurrentItemId(fired.payload.nextItemId);
          }
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
  }, [engineRef, tickTime, setCurrentItemId, setPlaying]);

  return null;
}
