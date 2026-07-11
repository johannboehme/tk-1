/**
 * Playback domain — playhead clock, walker contract (seekRequest /
 * seekSegmentIdxHint / pendingWrapAt) and OP-1 style loop handling.
 */
import { LoopRegion } from "../OffsetScheduler";
import { clampLoopToBounds } from "../arrangement-loop";
import {
  arrToMaster,
  masterToArr,
  segmentIndexAtArr,
  totalArrDuration,
} from "../../core/arrangement-time";
import { isVideoClip } from "../../core/types";
import { gridStepSeconds, snapTime } from "../../core/snap";
import { buildClipMatchPositions } from "../match-snap";
import {
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
  arrBeatPhaseS,
} from "../selectors/timing";
import type { FxHoldEntry } from "./fx-slice";
import type { SliceCreator } from "./state";

export interface PlaybackSlice {
  currentTime: number;
  /** Timeline-time of the playhead — emitted by the audio walker
   *  authoritatively from `(currentPillIdx, masterT)`. Consumers that
   *  draw the playhead or display the song time read THIS, not a
   *  `masterToArr(currentTime)` projection (which scans by master-time
   *  and snaps duplicate-source pills onto the first occurrence). */
  timelineT: number;
  isPlaying: boolean;
  loop: LoopRegion | null;
  // Set by seek(t); useAudioMaster watches this and writes
  // audioElement.currentTime, then calls clearSeekRequest. Distinguishes
  // user-initiated seeks from the 60Hz tick that mirrors the audio
  // element's clock back into the store.
  seekRequest: number | null;
  // Disambiguator for arrangement-mode seeks. When the same master-time
  // appears in multiple segments (a chunk used twice in the song), the
  // caller can tell the walker which occurrence it intended — without
  // this, the walker would lock onto the first match and the playhead
  // would visually rewind to an earlier occurrence's arr-position. null
  // = no hint (walker scans).
  seekSegmentIdxHint: number | null;
  // Deferred wrap point for OP-1 style loop-shift. When non-null the audio
  // master wraps to loop.start at this master-time instead of at loop.end —
  // letting the playhead keep playing in a now-out-of-loop zone until it
  // reaches the OLD loop end. Cleared by user-seek and setLoop().
  pendingWrapAt: number | null;
}

export interface PlaybackSliceState {
  playback: PlaybackSlice;
}

export interface PlaybackSliceActions {
  setCurrentTime(t: number): void;
  /** Walker-side atomic update of both master- and timeline-time. The
   *  walker computes timeline-time from its authoritative `currentPillIdx`
   *  + master-offset-within-segment; consumers (playhead, transport
   *  clock) read `timelineT` directly so duplicate-source pills don't
   *  collapse onto the first occurrence on the song view. */
  setPlayhead(masterT: number, timelineT: number): void;
  setPlaying(playing: boolean): void;
  setLoop(loop: LoopRegion | null): void;
  seek(
    t: number,
    opts?: {
      /** Arrangement-mode disambiguator: which segment this seek lands
       *  in (when the master-time appears in multiple segments). The
       *  audio walker uses this as the authoritative segment index
       *  instead of scanning for the first master-time match. */
      segmentIdxHint?: number;
    },
  ): void;
  clearSeekRequest(): void;
  /** Step the playhead by the active snap target:
   *  - off → ±1 frame
   *  - match → next/prev match-position of the selected clip (frame-step fallback)
   *  - 1, 1/2, 1/4, 1/8, 1/16 → ±1 grid tick on the bar/beat grid
   *  Always writes a seekRequest. */
  stepByActiveSnap(direction: 1 | -1): void;
  /** OP-1 style loop-shift: move loop region by its own length without
   *  interrupting playback. The playhead stays where it is; if it ends up
   *  outside the new loop, `pendingWrapAt` is set to the OLD loop.end so
   *  the audio scheduler wraps at the natural play-out point. No-op if no
   *  loop is set or the shifted loop falls entirely outside trim. */
  shiftLoop(direction: 1 | -1): void;
  /** Tape-drag: relocate the loop region without interrupting playback.
   *  Same OP-1 deferred-wrap semantics as `shiftLoop`, but for absolute
   *  placements (a Timeline drag, not a directional shift). `setLoop`
   *  remains the "full replacement" entry point and clears pendingWrapAt. */
  moveLoop(loop: LoopRegion | null): void;
  /** Clear the deferred wrap point (called by useAudioMaster after the
   *  scheduler has reseeked into the new loop region). */
  clearPendingWrap(): void;
}

const initialPlayback: PlaybackSlice = {
  currentTime: 0,
  timelineT: 0,
  isPlaying: false,
  loop: null,
  seekRequest: null,
  seekSegmentIdxHint: null,
  pendingWrapAt: null,
};

export function initialPlaybackState(): PlaybackSliceState {
  return { playback: initialPlayback };
}

export const createPlaybackSlice: SliceCreator<PlaybackSliceActions> = (
  set,
  get,
) => ({
  setCurrentTime(t) {
    set({ playback: { ...get().playback, currentTime: t } });
  },
  setPlayhead(masterT, timelineT) {
    set({
      playback: {
        ...get().playback,
        currentTime: masterT,
        timelineT,
      },
    });
  },
  setPlaying(playing) {
    const s = get();
    if (s.playback.isPlaying === playing) return;
    if (playing) {
      // Latched preview holds (created via pad-click while paused) only
      // make sense while the playhead is frozen. The moment playback
      // starts, drop them — otherwise the descriptor would synthesise a
      // transient FX every frame on top of any persistent recording.
      let nextHolds = s.fxHolds;
      let dropped = false;
      const filtered: Record<string, FxHoldEntry> = {};
      for (const [slot, h] of Object.entries(s.fxHolds)) {
        if (h.mode === "preview") {
          dropped = true;
          continue;
        }
        filtered[slot] = h;
      }
      if (dropped) nextHolds = filtered;
      set({
        playback: { ...s.playback, isPlaying: true },
        fxHolds: nextHolds,
      });
      return;
    }
    // Stopping. A persistent (recording) hold whose pad-pointerup never
    // arrives — window blur, tab switch, or the auto-stop at song end —
    // would otherwise dangle in `fxHolds` forever: its `outS` keeps
    // growing on the next play and clearAllFx can't remove it (it
    // preserves live recordings by design). Finalize each persistent
    // hold here via the normal release path so it becomes an ordinary
    // committed capsule that can be erased / cleared. Preview holds are
    // valid while paused, so they stay.
    set({ playback: { ...s.playback, isPlaying: false } });
    for (const [slot, h] of Object.entries(s.fxHolds)) {
      if (h.mode === "persistent") get().endFxHold(slot);
    }
  },
  setLoop(loop) {
    const { trim, arrangementSegments } = get();
    const clamped = clampLoopToBounds(loop, arrangementSegments, trim);
    set({
      playback: { ...get().playback, loop: clamped, pendingWrapAt: null },
    });
  },
  seek(t, opts) {
    const meta = get().jobMeta;
    const dur = meta?.duration ?? Infinity;
    const clamped = Math.max(0, Math.min(t, dur));
    const s = get();
    const segs = s.arrangementSegments;
    const hint = opts?.segmentIdxHint ?? null;
    // Compute timeline-time for this seek synchronously so the playhead
    // doesn't flash to the first-occurrence position before the walker
    // catches up next tick. When the caller passes a segmentIdxHint we
    // know exactly which occurrence they meant — without it we fall back
    // to a master-time scan (only correct for non-duplicate jobs).
    let timelineT = clamped;
    if (segs.length > 0) {
      const arrStarts: number[] = [];
      let cursor = 0;
      for (const seg of segs) {
        arrStarts.push(cursor);
        cursor += Math.max(0, seg.out - seg.in);
      }
      let segIdx = -1;
      if (hint != null && hint >= 0 && hint < segs.length) {
        segIdx = hint;
      } else {
        for (let i = 0; i < segs.length; i++) {
          if (clamped >= segs[i].in - 1e-3 && clamped < segs[i].out) {
            segIdx = i;
            break;
          }
        }
      }
      if (segIdx >= 0) {
        timelineT = arrStarts[segIdx] + Math.max(0, clamped - segs[segIdx].in);
      }
    }
    set({
      playback: {
        ...s.playback,
        currentTime: clamped,
        timelineT,
        seekRequest: clamped,
        // A user-initiated seek overrides any deferred loop-shift wrap —
        // the user's intent is to be at `t`, not at the OP-1 wrap point.
        pendingWrapAt: null,
        // Arrangement-mode disambiguator. Multiple segments may share
        // the same master-time range (chunk duplicated in the song);
        // the timeline knows which sub-pill the user clicked because
        // arr-time is unique. Forwarding the segment index here lets
        // the audio walker resume on the right occurrence instead of
        // snapping to the first match. null/undefined = no hint, the
        // walker scans normally.
        seekSegmentIdxHint: hint,
      },
    });
  },
  clearSeekRequest() {
    set({
      playback: {
        ...get().playback,
        seekRequest: null,
        seekSegmentIdxHint: null,
      },
    });
  },
  stepByActiveSnap(direction) {
    const s = get();
    const segs = s.arrangementSegments;
    const fps = s.jobMeta?.fps && s.jobMeta.fps > 0 ? s.jobMeta.fps : 30;
    const mode = s.ui.snapMode;

    // The step runs on the ARR axis (the composed song timeline, #102):
    // every drawn grid surface — BeatRuler, snapTimelineTime, Timeline
    // drags — anchors there, so a master-axis step lands off the
    // visible bar lines in any segment ≥ 1. And a raw master seek near
    // a chunk edge can escape into a segment GAP, where seek()'s
    // fallback stores the master value in the arr-time playhead field.
    const tArr = s.playback.timelineT;
    const totalArr =
      segs.length > 0
        ? totalArrDuration(segs)
        : (s.jobMeta?.duration ?? Infinity);
    const seekArr = (targetArr: number) => {
      const clamped = Math.max(0, Math.min(totalArr, targetArr));
      if (segs.length === 0) {
        s.seek(clamped);
        return;
      }
      // arr == totalArr is past the half-open last segment — clamp the
      // hint to the last index so the walker resumes on the right
      // occurrence (arrToMaster already clamps the value to last.out).
      let idx = segmentIndexAtArr(clamped, segs);
      if (idx === -1) idx = segs.length - 1;
      s.seek(arrToMaster(clamped, segs), { segmentIdxHint: idx });
    };
    const frameStep = () => seekArr(tArr + direction * (1 / fps));

    if (mode === "off") return frameStep();

    if (mode === "match") {
      const clip = s.clips.find((c) => c.id === s.selectedClipId);
      if (clip && isVideoClip(clip) && clip.candidates?.length) {
        // Candidate alignments are master-time positions by definition;
        // compare on the master clock, then project the winner onto the
        // arr axis so the playhead field stays arr-time.
        const t = s.playback.currentTime;
        const positions = buildClipMatchPositions(clip)
          .map((p) => p.startS)
          .sort((a, b) => a - b);
        const eps = 1e-6;
        const target =
          direction > 0
            ? positions.find((p) => p > t + eps)
            : [...positions].reverse().find((p) => p < t - eps);
        if (target !== undefined) {
          seekArr(masterToArr(target, segs));
          return;
        }
      }
      return frameStep();
    }

    const bpm = s.jobMeta?.bpm?.value ?? null;
    const beatsPerBar = effectiveBeatsPerBar(s.jobMeta);
    const step = gridStepSeconds(mode, bpm, beatsPerBar);
    if (step === null || step <= 0) return frameStep();

    // Probe slightly into the desired direction so snapTime rounds the
    // correct way (snapTime always picks the nearest tick — without the
    // probe, t already on a tick would round to itself).
    const probe = tArr + direction * step * 0.5;
    const candidate = snapTime(probe, mode, {
      bpm,
      // Same anchor as snapTimelineTime / the BeatRuler — bar 0 in
      // arr-time.
      beatPhase: arrBeatPhaseS(s.jobMeta, segs),
      beatsPerBar,
      barOffsetBeats: effectiveBarOffsetBeats(s.jobMeta),
    });
    // FP tolerance only — used to absorb snapTime's
    // round-half-toward-+∞ asymmetry on negative half-tick probes.
    // NOT a "near a snap" widener: a larger eps would falsely double
    // the step when the user's playhead happens to land within ±N ms
    // of a snap (e.g. via audio-mirror seek precision).
    const eps = step * 1e-9;
    let target = candidate;
    if (Math.abs(target - tArr) < eps) target = candidate + direction * step;
    seekArr(target);
  },
  shiftLoop(direction) {
    const s = get();
    const loop = s.playback.loop;
    if (!loop) return;

    const len = loop.end - loop.start;
    const newLoop: LoopRegion = {
      start: loop.start + direction * len,
      end: loop.end + direction * len,
    };
    const clamped = clampLoopToBounds(newLoop, s.arrangementSegments, s.trim);
    if (!clamped) return;

    // Defer the wrap to the OLD loop end whenever the playhead is OUTSIDE
    // the new loop region. Loop bounds + pendingWrapAt live in arr-time
    // on the composed timeline; master-time is projected through the
    // segments (Identity for single-take's whole-master segment).
    const t_view = masterToArr(s.playback.currentTime, s.arrangementSegments);
    const insideNew = t_view >= clamped.start && t_view < clamped.end;
    const pendingWrapAt = insideNew ? null : loop.end;

    set({
      playback: { ...s.playback, loop: clamped, pendingWrapAt },
    });
  },
  moveLoop(loop) {
    // OP-1 tape-drag: incrementally relocates an existing loop region.
    // Differs from `setLoop` (full replacement, clears pendingWrapAt)
    // in that it preserves continuity — the active element keeps
    // playing through the OLD loop until its end, then wraps to the
    // NEW loop.start. `setLoop(null)` and "first set" cases route
    // through `setLoop`, since there's nothing to defer to.
    if (!loop) {
      get().setLoop(null);
      return;
    }
    const s = get();
    const old = s.playback.loop;
    if (!old) {
      get().setLoop(loop);
      return;
    }
    const clamped = clampLoopToBounds(loop, s.arrangementSegments, s.trim);
    if (!clamped) return;
    const t_view = masterToArr(s.playback.currentTime, s.arrangementSegments);
    const insideNew = t_view >= clamped.start && t_view < clamped.end;
    // Preserve any existing pendingWrapAt — multiple drags before the
    // first wrap fires should keep the earliest old-end as the trigger
    // (otherwise the trigger keeps chasing the latest drag's old-end
    // and the wrap may never fire).
    const pendingWrapAt = insideNew
      ? null
      : (s.playback.pendingWrapAt ?? old.end);
    set({
      playback: { ...s.playback, loop: clamped, pendingWrapAt },
    });
  },
  clearPendingWrap() {
    const cur = get().playback.pendingWrapAt;
    if (cur == null) return;
    set({ playback: { ...get().playback, pendingWrapAt: null } });
  },
});
