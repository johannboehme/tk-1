/**
 * Triage audio playback — gapless loop via the shared two-`<audio>`
 * ping-pong + WebAudio crossfade engine (local/audio/pingpong-engine),
 * scoped down to what Triage needs (no A/B-bypass, no audio-volume
 * coupling).
 *
 * Why dual-element: a single-element loop wrap is `currentTime = X`
 * which always interrupts the decoder and produces an audible click.
 * Triage loops chunks for review — the user listens to a chunk repeat
 * many times to decide keep/drop. Even one click per loop wrap turns
 * the screen unusable. Dual-element with a 8 ms WebAudio gain ramp
 * is sample-accurate and below click-perception thresholds.
 *
 * The engine owns the graph/crossfade mechanics; this driver keeps the
 * Triage-specific walkers: plain loop, seam loop (A-tail → B-head
 * audition around a cut) and sequence (walk the kept chunks
 * chronologically).
 */
import { useCallback, useEffect, useRef } from "react";
import { useTriageStore } from "../../local/triage/triage-store";
import {
  buildSequence,
  nextSequenceId,
  resolveSeamWindow,
  seamHopTarget,
} from "../../local/triage/triage-sequence";
import { clampSeek } from "../../lib/clamp";
import {
  LEAD_TIME_S,
  type PingPongEngine,
} from "../../local/audio/pingpong-engine";
import { usePingPongTransport } from "../../local/audio/use-pingpong-transport";

/** Walker data attached to an armed crossfade, interpreted on fire. */
type TriageArmPayload =
  /** Plain loop wrap back to loop.start. */
  | { kind: "loop" }
  /** Seam loop: which window to switch to when the crossfade fires. */
  | { kind: "seam"; nextPhase: "A" | "B" }
  /** Sequence walker: chunk id to advance focus to when the crossfade
   *  fires. null = current chunk was the last one (sentinel arm — a
   *  timer does the actual stop, no side swap). */
  | { kind: "sequence"; nextId: string | null };

type Branch = "continue" | "loop" | "sequence" | "seam";

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

  /** Seam loop: which window is currently playing (A-tail or B-head). */
  const seamPhaseRef = useRef<"A" | "B">("A");
  const branchRef = useRef<Branch>("continue");
  const rafRef = useRef<number | null>(null);

  const subscribeExternalTime = useCallback(
    (cb: (tS: number) => void) =>
      useTriageStore.subscribe((s, prev) => {
        if (s.playback.currentTime !== prev.playback.currentTime) {
          cb(s.playback.currentTime);
        }
      }),
    [],
  );

  const { engineRef } = usePingPongTransport<TriageArmPayload>({
    aRef,
    bRef,
    jobId,
    isPlaying,
    onPlayRejected: () => setPlaying(false),
    subscribeExternalTime,
  });

  // Park the idle element at loop.start whenever the loop region
  // changes. Resets any armed crossfade.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.cancelArmed();
    if (!loop) return;
    eng.parkIdle(loop.start);
  }, [loop, engineRef]);

  // RAF loop: broadcast time + arm crossfades near loop/seam/sequence
  // boundaries.
  useEffect(() => {
    function tick() {
      const eng: PingPongEngine<TriageArmPayload> | null = engineRef.current;
      if (eng) {
        const active = eng.activeEl;
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
          eng.cancelArmed();
          // Entering seam always starts in the A-tail window.
          if (branch === "seam") seamPhaseRef.current = "A";
          branchRef.current = branch;
        }

        if (branch === "seam") {
          // Loop a window straddling the A→B cut:
          //   [loopIn → A.end] (A) → hop → [B.start → loopOut] (B) → wrap.
          // A.end / B.start are read fresh (live trims); loopIn / loopOut
          // are the ephemeral brackets. Same crossfade for both hops.
          const win = pb.seam ? resolveSeamWindow(pb.seam, state.chunks) : null;
          if (win && !eng.isArmed) {
            // Derive the audition window from the playhead so a user seek
            // into either lane updates which side we're on. Disjoint
            // windows are unambiguous; on overlap keep the tracked phase.
            const inA = t >= win.loopInS - 0.01 && t <= win.aEndS + 0.05;
            const inB = t >= win.bStartS - 0.05 && t <= win.loopOutS + 0.01;
            if (inA && !inB) seamPhaseRef.current = "A";
            else if (inB && !inA) seamPhaseRef.current = "B";
          }
          if (win && pb.isPlaying && !eng.isArmed) {
            const { armAtS, seekToS, nextPhase } = seamHopTarget(
              win,
              seamPhaseRef.current,
            );
            const remaining = armAtS - t;
            if (remaining > 0 && remaining < LEAD_TIME_S) {
              eng.armCrossfade({
                distS: remaining,
                targetS: seekToS,
                payload: { kind: "seam", nextPhase },
              });
            } else if (t >= armAtS + 0.05) {
              // Missed the lead window (dropped frame, or a live trim
              // moved the boundary behind the playhead) — hard-jump +
              // flip phase so the loop recovers.
              eng.seekActive(seekToS);
              seamPhaseRef.current = nextPhase;
            }
          }
          // Crossfade fired — swap active + flip window. Runs regardless
          // of isPlaying so a stale armed flag clears on pause.
          const fired = eng.consumeFired();
          if (fired && fired.payload.kind === "seam") {
            eng.swapSides();
            seamPhaseRef.current = fired.payload.nextPhase;
          }
        } else if (branch === "loop") {
          const lp = pb.loop!;
          // Loop arming.
          if (!eng.isArmed && pb.isPlaying) {
            const remaining = lp.end - t;
            if (remaining > 0 && remaining < LEAD_TIME_S) {
              eng.armCrossfade({
                distS: remaining,
                targetS: lp.start,
                payload: { kind: "loop" },
              });
            }
          }
          // Crossfade has fired — swap active + re-park old active at
          // loop.start for the next wrap.
          const fired = eng.consumeFired();
          if (fired && fired.payload.kind === "loop") {
            eng.swapSides(lp.start);
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
          if (pb.isPlaying && !eng.isArmed) {
            if (curIdx === -1) {
              // Focus drifted off the kept set mid-play → stop. (Start
              // positioning is handled synchronously in setPlaying.)
              state.setPlaying(false);
            } else {
              const curChunk = seq[curIdx];
              const remaining = curChunk.endMs / 1000 - t;
              if (remaining > 0 && remaining < LEAD_TIME_S) {
                const nextId = nextSequenceId(seq, curId);
                if (nextId) {
                  eng.armCrossfade({
                    distS: remaining,
                    targetS: seq[curIdx + 1].startMs / 1000,
                    payload: { kind: "sequence", nextId },
                  });
                } else {
                  // Last kept chunk — stop at its end (no loop in
                  // sequence). Arm with a null target to block re-arming;
                  // a timer does the actual pause at the chunk end. NOT
                  // a real crossfade — a fake swap would kick the idle
                  // (parked at an earlier position) onto PROGRAM.
                  eng.armWithoutCrossfade({
                    distS: remaining,
                    payload: { kind: "sequence", nextId: null },
                  });
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
          const fired = eng.consumeFired();
          if (
            fired &&
            fired.payload.kind === "sequence" &&
            fired.payload.nextId != null
          ) {
            eng.swapSides();
            state.sequenceAdvance(fired.payload.nextId);
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
  }, [engineRef, tickTime]);

  return null;
}
