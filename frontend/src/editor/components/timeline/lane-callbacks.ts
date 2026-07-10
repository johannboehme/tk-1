/**
 * Stable per-cam callbacks for the memo()ed LaneHeader.
 *
 * Timeline re-renders every playback frame (it subscribes to the playhead
 * for the overlay + auto-page). LaneHeader is React.memo'd to keep its
 * skeuomorph control strip off that 60 Hz path — which only works if the
 * five callbacks it receives keep their identity across renders. This
 * factory creates them ONCE per cam and reads all live state through
 * `useEditorStore.getState()` at call time (the pattern the inline
 * onTakeStart already used), so the closures never go stale.
 */
import { useEditorStore } from "../../store";

export interface LaneCallbacks {
  onSelectClip: () => void;
  /** Pointer pressed on TAKE — immediate cut + begin hold; promotes to
   *  paint-mode after 500 ms (cassette-rec model: tap and hold share one
   *  code path). */
  onTakeStart: () => void;
  /** Pointer released on TAKE — applies the overwrite-range when the hold
   *  crossed the paint threshold, then ends the hold. */
  onTakeFinish: () => void;
  onReset: () => void;
  onDelete: () => void;
}

/** Hold duration after which a TAKE press promotes to paint-mode. */
export const TAKE_PROMOTE_MS = 500;

/**
 * @param promoteTimers Shared per-cam promote-timer registry (owned by the
 *        Timeline so unmount cleanup can clear it).
 * @param getOnDeleteClip Resolved at CALL time so the Editor can swap its
 *        onDeleteClip prop without invalidating the cached callbacks.
 */
export function createLaneCallbacksCache(
  promoteTimers: Map<string, ReturnType<typeof setTimeout>>,
  getOnDeleteClip: () => ((camId: string) => void) | undefined,
): (clipId: string) => LaneCallbacks {
  const cache = new Map<string, LaneCallbacks>();
  return (clipId: string): LaneCallbacks => {
    let cbs = cache.get(clipId);
    if (cbs) return cbs;
    cbs = {
      onSelectClip: () => {
        useEditorStore.getState().setSelectedClipId(clipId);
      },
      // onTake is intentionally not part of this set — the cassette-rec
      // model fires the immediate cut inside onTakeStart so a tap and a
      // hold use one code path.
      onTakeStart: () => {
        const s = useEditorStore.getState();
        // Single-active-hold guard: ignore if another TAKE is already
        // engaged (button or keyboard).
        if (s.holdGesture) return;
        const startS = s.snapTimelineTime(s.playback.timelineT);
        s.beginHoldGesture(clipId, startS);
        s.addCut({ atTimeS: startS, camId: clipId });
        const existing = promoteTimers.get(clipId);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          useEditorStore.getState().promoteHoldToPaint();
        }, TAKE_PROMOTE_MS);
        promoteTimers.set(clipId, t);
      },
      onTakeFinish: () => {
        const promoteT = promoteTimers.get(clipId);
        if (promoteT) {
          clearTimeout(promoteT);
          promoteTimers.delete(clipId);
        }
        const s = useEditorStore.getState();
        const hold = s.holdGesture;
        // Only act on releases that match this clip's hold — otherwise a
        // stale onTakeFinish (after a cancelHold via Esc) shouldn't
        // re-apply anything.
        if (!hold || hold.camId !== clipId) return;
        const endS = s.snapTimelineTime(s.playback.timelineT);
        if (hold.painting) {
          s.applyHoldRelease(clipId, hold.startS, endS, hold.priorCuts);
        }
        s.endHoldGesture();
      },
      onReset: () => {
        const s = useEditorStore.getState();
        s.resetClipAlignment(clipId);
        s.resetPillsForCam(clipId);
      },
      onDelete: () => {
        getOnDeleteClip()?.(clipId);
      },
    };
    cache.set(clipId, cbs);
    return cbs;
  };
}
