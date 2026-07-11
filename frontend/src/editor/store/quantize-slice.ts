/**
 * Quantize domain — the transient Q-hold preview and its commit/cancel
 * paths (scope: cuts + fx only, #70).
 */
import type { Cut } from "../../storage/jobs-db";
import { buildQuantizePreview, type QuantizePreview } from "../quantize";
import {
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
  arrBeatPhaseS,
} from "../selectors/timing";
import type { SliceCreator } from "./state";

export interface QuantizeSliceState {
  /** Transient preview of the Q-hold quantize gesture. Non-null while
   *  Q is held; rendered as ghost markers in the timeline. Committed on
   *  Q-up via `commitQuantizePreview`, dropped on Esc via `cancelQuantizePreview`. */
  quantizePreview: QuantizePreview | null;
}

export interface QuantizeSliceActions {
  /** Build a quantize preview from current cuts/clips/trim against the
   *  active snap-mode. Called on Q-down. Re-call to refresh after the
   *  snap-mode changed during the hold. */
  buildAndStartQuantizePreview(): void;
  /** Commit the active preview into the store (mutates cuts, clips, trim).
   *  Called on Q-up. No-op if no preview is active. */
  commitQuantizePreview(): void;
  /** Drop the active preview without applying. Called on Esc during hold. */
  cancelQuantizePreview(): void;
}

export function initialQuantizeState(): QuantizeSliceState {
  return { quantizePreview: null };
}

export const createQuantizeSlice: SliceCreator<QuantizeSliceActions> = (
  set,
  get,
) => ({
  buildAndStartQuantizePreview() {
    const s = get();
    // Scope: cuts + fx ONLY (#70). Cam start offsets are auto-synced
    // (snapping them would break A/V alignment) and the master trim is
    // the user's export window — quantize must not touch either.
    //
    // Cuts + fx live in timeline-time, so the beat anchor must be the
    // ARR-time one — the exact grid the BeatRuler draws and
    // snapTimelineTime recorded the cuts on (#94). The master anchor
    // differs by segments[0].in in long-form and would move on-grid
    // markers OFF the visible bar lines.
    const preview = buildQuantizePreview(
      { cuts: s.cuts, fx: s.fx },
      s.ui.snapMode,
      {
        bpm: s.jobMeta?.bpm?.value ?? null,
        beatPhase: arrBeatPhaseS(s.jobMeta, s.arrangementSegments),
        beatsPerBar: effectiveBeatsPerBar(s.jobMeta),
        barOffsetBeats: effectiveBarOffsetBeats(s.jobMeta),
      },
    );
    set({ quantizePreview: preview });
  },
  commitQuantizePreview() {
    const preview = get().quantizePreview;
    if (!preview) return;
    // Apply cuts: replace each off-grid cut with its snapped target.
    let nextCuts = get().cuts.slice();
    for (const change of preview.cuts) {
      nextCuts = nextCuts.map((c) =>
        c.atTimeS === change.from && c.camId === change.camId
          ? { ...c, atTimeS: change.to }
          : c,
      );
    }
    nextCuts.sort((a, b) => a.atTimeS - b.atTimeS);
    // Dedupe cuts that quantize onto the same instant. Two markers can
    // collapse onto a single grid line in two flavours:
    //   1. Same camId, same time → exact dupe; drop one, no semantics
    //      change (activeCamAt is identical).
    //   2. Different camIds, same time → ambiguity. activeCamAt picks
    //      whichever cut is *later* in the array; the earlier one is
    //      dead. We keep the later one (matches activeCamAt) and drop
    //      the dead one so the user doesn't end up with stacked
    //      markers in the strip.
    // We walk forwards keeping the *latest* cut per atTimeS.
    const TOL = 1e-6;
    const dedupedReverse: Cut[] = [];
    const seenTimes = new Set<number>();
    for (let i = nextCuts.length - 1; i >= 0; i--) {
      const c = nextCuts[i];
      // Use the rounded time as the key so floating-point noise doesn't
      // hide a true dupe.
      const key = Math.round(c.atTimeS / TOL) * TOL;
      if (seenTimes.has(key)) continue;
      seenTimes.add(key);
      dedupedReverse.push(c);
    }
    nextCuts = dedupedReverse.reverse();

    // Apply fx in/out snaps. (Cuts + fx are the ENTIRE quantize scope —
    // cam start offsets and trim are deliberately untouched, #70.)
    let nextFx = get().fx;
    if (preview.fxs.length > 0) {
      nextFx = nextFx.map((f) => {
        const change = preview.fxs.find((c) => c.id === f.id);
        if (!change) return f;
        let inS = f.inS;
        let outS = f.outS;
        if (change.in) inS = change.in.to;
        if (change.out) outS = change.out.to;
        // Same min-window guard as setFxIn / setFxOut.
        if (outS - inS < 0.05) outS = inS + 0.05;
        return { ...f, inS, outS };
      });
    }

    set({
      cuts: nextCuts,
      fx: nextFx,
      quantizePreview: null,
    });
  },
  cancelQuantizePreview() {
    set({ quantizePreview: null });
  },
});
