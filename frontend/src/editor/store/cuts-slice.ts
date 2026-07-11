/**
 * Cuts domain — the PROGRAM cut list (timeline-time markers) and the
 * TAKE-hold paint gesture that mutates it.
 */
import type { Cut } from "../../storage/jobs-db";
import type { Clip, Pill, Segment } from "../../core/types";
import { activeCamAt } from "../../core/cuts";
import { activeCamAtArr, camHasPillAt } from "../../core/arrangement-pills";
import { totalArrDuration } from "../../core/arrangement-time";
import { computeCamRanges } from "./clips-slice";
import type { SliceCreator } from "./state";

/** Resolve the cam on PROGRAM at timeline-time `t` for cut-guard
 *  purposes. Cuts live in timeline-time (song axis) since the axis flip,
 *  so the resolution MUST run against the pills' arr-time coverage —
 *  master-time `clipRangeS` ranges are the wrong axis and reject valid
 *  TAKEs in long-form (#75).
 *
 *  Pill-less stores (simplified test harnesses that `loadJob` without an
 *  arrangement — production always synthesizes one) fall back to the
 *  legacy master-range resolution; for those the default whole-master
 *  segment makes both axes identical. */
function activeCamIdAtTimelineT(
  cuts: readonly Cut[],
  t: number,
  pills: readonly Pill[],
  segments: readonly Segment[],
  clips: readonly Clip[],
): string | null {
  if (pills.length === 0) {
    return activeCamAt(cuts, t, computeCamRanges(clips));
  }
  return activeCamAtArr(cuts, t, pills, segments)?.camId ?? null;
}

/** True if `camId` has material at timeline-time `t` — pill coverage on
 *  the song axis, with the same pill-less legacy fallback as
 *  `activeCamIdAtTimelineT`. */
function camHasMaterialAtTimelineT(
  camId: string,
  t: number,
  pills: readonly Pill[],
  clips: readonly Clip[],
): boolean {
  if (pills.length === 0) {
    const r = computeCamRanges(clips).find((x) => x.id === camId);
    return !!r && t >= r.startS && t < r.endS;
  }
  return camHasPillAt(camId, t, pills);
}

/**
 * Insert `cut` into a sorted-by-time `cuts` array, returning a new array.
 * `existing` MUST already be sorted ascending by `atTimeS`. O(n) — beats
 * O(n log n) `[...arr, x].sort()` because we already know where it goes.
 */
function insertCutSorted(existing: readonly Cut[], cut: Cut): Cut[] {
  // Binary search for the insertion index.
  let lo = 0;
  let hi = existing.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (existing[mid].atTimeS <= cut.atTimeS) lo = mid + 1;
    else hi = mid;
  }
  const next = existing.slice();
  next.splice(lo, 0, cut);
  return next;
}

export interface CutsSliceState {
  cuts: Cut[];
  /** Live indicator for an in-progress TAKE-button-or-hotkey hold. While
   * a key/button is pressed, this points to the held cam + the master-time
   * the press started at. Once the press passes the tap-vs-hold threshold,
   * `painting` flips to true and the PROGRAM strip starts visualising the
   * range. `priorCuts` is the cuts-snapshot at press-time, used by
   * `cancelHold` (Esc) to revert. Cleared back to null on release. */
  holdGesture:
    | { camId: string; startS: number; painting: boolean; priorCuts: Cut[] }
    | null;
}

export interface CutsSliceActions {
  /** Add a cut, but skip if the target cam is already active at that time
   * (no point recording a switch to the cam that was already on PROGRAM).
   * Returns true if a cut was actually inserted. */
  addCut(cut: Cut): boolean;
  /** Drag-move an existing cut from `fromAtTimeS` to `toAtTimeS` on the
   *  same cam. Returns the time the cut actually landed on (callers may
   *  want to use it as the new identity for the next drag tick). No-op
   *  if the source cut isn't found. */
  moveCut(fromAtTimeS: number, camId: string, toAtTimeS: number): number;
  /**
   * Hold-to-overwrite: ensures `camId` is on PROGRAM from `fromS` through
   * `toS`. Inserts a cut at `fromS` (skipped if camId is already active
   * there) AND removes any cuts to OTHER cams in (fromS, toS]. Used by
   * the TAKE-hold and hotkey-hold gestures so a press-and-hold visually
   * "paints" the cam over the held span.
   */
  overwriteCutsRange(camId: string, fromS: number, toS: number): void;
  applyHoldRelease(camId: string, fromS: number, toS: number, priorCuts: Cut[]): void;
  removeCutAt(atTimeS: number, camId?: string): void;
  clearCuts(): void;
  /** UI-only: announce that a TAKE button / hotkey is being held. Snapshots
   *  the current cuts so a subsequent cancelHold can revert. */
  beginHoldGesture(camId: string, startS: number): void;
  /** Promote the active hold to "painting" once the 500 ms threshold passes. */
  promoteHoldToPaint(): void;
  /** Release: clear the indicator. The cuts mutation is done separately. */
  endHoldGesture(): void;
  /** Cancel an active hold and revert cuts to the snapshot taken at
   *  beginHoldGesture. Triggered by Esc during a press. No-op when no
   *  hold is active. */
  cancelHold(): void;
  activeCamId(t?: number): string | null;
}

export function initialCutsState(): CutsSliceState {
  return {
    cuts: [],
    holdGesture: null,
  };
}

export const createCutsSlice: SliceCreator<CutsSliceActions> = (set, get) => ({
  addCut(cut) {
    // Cut.atTimeS is timeline-time — both guards resolve on the SAME
    // axis via pill coverage (see activeCamIdAtTimelineT, #75). The
    // legacy master-range guards rejected valid TAKEs whenever a cam's
    // master range didn't happen to contain the small arr-times that
    // long-form cuts carry.
    const s = get();

    // No-op guard #1: if the cam is already active at this time (via a
    // prior cut or default-fallback), inserting another marker to the
    // same cam is redundant.
    const currentActive = activeCamIdAtTimelineT(
      s.cuts,
      cut.atTimeS,
      s.pills,
      s.arrangementSegments,
      s.clips,
    );
    if (currentActive === cut.camId) return false;

    // No-op guard #2: if the target cam has NO material (pill) at this
    // song-position, adding the cut wouldn't change anything — the
    // resolver would still fall back to whatever cam covers the spot.
    // This is the "single-video area" case: in a region only cam-2
    // covers, hitting TAKE on cam-1 used to deposit a marker that did
    // nothing.
    if (
      !camHasMaterialAtTimelineT(cut.camId, cut.atTimeS, s.pills, s.clips)
    ) {
      return false;
    }

    // Idempotent: drop any cut already at this exact instant on the same
    // cam. Then binary-search insert into the already-sorted array. O(n)
    // splice instead of O(n log n) full re-sort on every keypress.
    const existing = s.cuts.filter(
      (c) => !(c.atTimeS === cut.atTimeS && c.camId === cut.camId),
    );
    const next = insertCutSorted(existing, cut);
    set({ cuts: next });
    return true;
  },
  moveCut(fromAtTimeS, camId, toAtTimeS) {
    const cuts = get().cuts;
    const idx = cuts.findIndex(
      (c) => c.atTimeS === fromAtTimeS && c.camId === camId,
    );
    if (idx < 0) return fromAtTimeS;
    // Cut.atTimeS is timeline-time, so the drag clamps against the
    // SONG axis [0, totalArrDuration] — NOT jobMeta.duration, which is
    // the master-audio length (#135). Duplicated chunks make the song
    // longer than the session (old clamp made the tail unreachable);
    // a short song cut from a long jam makes it much shorter (old
    // clamp let cuts sail into dead arr-space past the song's end).
    // Pre-load empty segments fall back to the master duration, where
    // both axes coincide.
    const segs = get().arrangementSegments;
    const hi =
      segs.length > 0
        ? totalArrDuration(segs)
        : (get().jobMeta?.duration ?? Infinity);
    const clamped = Math.max(0, Math.min(hi, toAtTimeS));
    // Replace, then re-sort. We don't dedupe during drag — collisions
    // (two cuts collapsing onto the same instant) are easier to
    // resolve visually after the user drops, and silently dropping
    // markers mid-drag would feel like a bug.
    const next = cuts.map((c, i) =>
      i === idx ? { ...c, atTimeS: clamped } : c,
    );
    next.sort((a, b) => a.atTimeS - b.atTimeS);
    set({ cuts: next });
    return clamped;
  },
  overwriteCutsRange(camId, fromS, toS) {
    const lo = Math.min(fromS, toS);
    const hi = Math.max(fromS, toS);
    const s = get();
    // Drop every cut inside [lo, hi] — the held cam painted over them.
    let next = s.cuts.filter((c) => c.atTimeS < lo || c.atTimeS > hi);
    // Hold-paint endpoints are timeline-time — resolve on the pill
    // axis, exactly like addCut (#75).
    const activeAtLo = activeCamIdAtTimelineT(
      next,
      lo,
      s.pills,
      s.arrangementSegments,
      s.clips,
    );
    // Same guard as addCut: only emit the in-marker when the held cam
    // actually has material at lo. Otherwise the marker is visually
    // inert (the resolver falls back to whoever else covers the spot).
    if (
      activeAtLo !== camId &&
      camHasMaterialAtTimelineT(camId, lo, s.pills, s.clips)
    ) {
      next = [...next, { atTimeS: lo, camId }].sort(
        (a, b) => a.atTimeS - b.atTimeS,
      );
    }
    set({ cuts: next });
  },
  applyHoldRelease(camId: string, fromS: number, toS: number, priorCuts: Cut[]) {
    const lo = Math.min(fromS, toS);
    const hi = Math.max(fromS, toS);
    const s = get();
    // What WOULD have been on PROGRAM at the release moment if we hadn't
    // painted? That's the cam we want to resume to (unless it's the cam
    // we were holding, in which case the hold was redundant and no
    // trailing cut is needed). All endpoints are timeline-time, so the
    // resolution runs on the pill axis (#75) — the legacy master-range
    // lookup could resume to a cam with no pill at this song-position
    // (inert cut) or to the wrong cam.
    const prevActiveAtRelease = activeCamIdAtTimelineT(
      priorCuts,
      hi,
      s.pills,
      s.arrangementSegments,
      s.clips,
    );

    // Paint: drop cuts in [lo, hi], insert lead cut if camId wasn't
    // already active at lo AND it actually has material there.
    const next: Cut[] = priorCuts.filter(
      (c) => c.atTimeS < lo || c.atTimeS > hi,
    );
    const activeAtLo = activeCamIdAtTimelineT(
      next,
      lo,
      s.pills,
      s.arrangementSegments,
      s.clips,
    );
    if (
      activeAtLo !== camId &&
      camHasMaterialAtTimelineT(camId, lo, s.pills, s.clips)
    ) {
      next.push({ atTimeS: lo, camId });
    }

    // Trailing resume cut at hi — only if the original would have shown
    // a different cam there. The resolver only returns a cam that has
    // material, so the trailing cut already targets a valid spot.
    if (prevActiveAtRelease !== null && prevActiveAtRelease !== camId) {
      next.push({ atTimeS: hi, camId: prevActiveAtRelease });
    }

    next.sort((a, b) => a.atTimeS - b.atTimeS);
    set({ cuts: next });
  },
  removeCutAt(atTimeS, camId) {
    const next = get().cuts.filter(
      (c) =>
        c.atTimeS !== atTimeS || (camId !== undefined && c.camId !== camId),
    );
    set({ cuts: next });
  },
  clearCuts() {
    set({ cuts: [] });
  },
  beginHoldGesture(camId: string, startS: number) {
    // Snapshot cuts at press time — used by cancelHold (Esc) to revert
    // the immediate addCut and any paint-overwrite that was applied
    // during the hold.
    const priorCuts = get().cuts.slice();
    set({ holdGesture: { camId, startS, painting: false, priorCuts } });
  },
  promoteHoldToPaint() {
    const cur = get().holdGesture;
    if (!cur || cur.painting) return;
    set({ holdGesture: { ...cur, painting: true } });
  },
  endHoldGesture() {
    set({ holdGesture: null });
  },
  cancelHold() {
    const cur = get().holdGesture;
    if (!cur) return;
    // Revert to the snapshot — drops the immediate cut AND any paint.
    set({ cuts: cur.priorCuts, holdGesture: null });
  },
  activeCamId(t) {
    const s = get();
    // `t` is timeline-time (the song-position the caller is asking
    // about). Defaults to the walker's authoritative `timelineT`, NOT
    // `currentTime` — the latter is master-time and would scan-snap
    // duplicate-pill slots onto the first occurrence's cam.
    const time = t ?? s.playback.timelineT;
    const active = activeCamAtArr(
      s.cuts,
      time,
      s.pills,
      s.arrangementSegments,
    );
    return active?.camId ?? null;
  },
});
