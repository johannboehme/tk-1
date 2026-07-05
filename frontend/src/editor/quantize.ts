/**
 * Pure quantize helpers for the Q-hold-to-quantize gesture.
 *
 * `buildQuantizePreview` returns a list of from→to deltas for every
 * off-grid marker (cuts, cam start positions, trim). The Timeline
 * component renders ghost markers at the `to` positions while Q is
 * held; on keyup, `applyQuantizePreview` mutates the store via the
 * provided actions. Esc cancels by simply discarding the preview.
 */
import { snapTime, type SnapMode, type SnapCtx } from "./snap";
import { clipRangeS, type VideoClip } from "./types";
import type { Cut } from "../storage/jobs-db";
import type { PunchFx } from "./fx/types";

const ON_GRID_TOLERANCE_S = 0.001;

export interface FxQuantizeChange {
  id: string;
  /** Present only when the in-point moved off-grid. */
  in?: { from: number; to: number };
  /** Present only when the out-point moved off-grid. */
  out?: { from: number; to: number };
}

export interface QuantizePreview {
  cuts: { from: number; to: number; camId: string }[];
  clipStartOffsets: { camId: string; from: number; to: number }[];
  trim:
    | { from: { in: number; out: number }; to: { in: number; out: number } }
    | null;
  /** Per-fx in/out snap deltas. Empty when no fx in the snapshot or all
   *  on-grid. Only the side(s) that moved are populated. */
  fxs: FxQuantizeChange[];
}

export interface QuantizeStateSnapshot {
  cuts: Cut[];
  clips: VideoClip[];
  trim: { in: number; out: number };
  /** Optional — older callers (and tests) may omit. Treated as empty. */
  fx?: PunchFx[];
}

export function buildQuantizePreview(
  state: QuantizeStateSnapshot,
  mode: SnapMode,
  ctx: SnapCtx,
): QuantizePreview {
  // OFF / MATCH have no time-grid → no quantize. (MATCH would mean
  // "snap each marker to a cam-alignment offset" which is conceptually
  // ill-defined for cuts and trim.)
  if (mode === "off" || mode === "match") {
    return emptyPreview();
  }
  if (!ctx.bpm || ctx.bpm <= 0) return emptyPreview();

  // Quantize cuts.
  const cuts: QuantizePreview["cuts"] = [];
  for (const cut of state.cuts) {
    const snapped = snapTime(cut.atTimeS, mode, ctx);
    if (Math.abs(snapped - cut.atTimeS) > ON_GRID_TOLERANCE_S) {
      cuts.push({ from: cut.atTimeS, to: snapped, camId: cut.camId });
    }
  }

  // Quantize cam start positions: snap the clip's visible startS, then
  // back-solve startOffsetS while preserving sync and trim.
  // range.startS = -totalSyncS + startOffsetS + trimInS  →
  // startOffsetS = snappedStart + totalSyncS − trimInS.
  const clipStartOffsets: QuantizePreview["clipStartOffsets"] = [];
  for (const clip of state.clips) {
    const range = clipRangeS(clip);
    const snappedStart = snapTime(range.startS, mode, ctx);
    if (Math.abs(snappedStart - range.startS) > ON_GRID_TOLERANCE_S) {
      const algoSyncS = (clip.syncOffsetMs + clip.syncOverrideMs) / 1000;
      const trimInS = clip.trimInS ?? 0;
      const newStartOffsetS = snappedStart + algoSyncS - trimInS;
      clipStartOffsets.push({
        camId: clip.id,
        from: clip.startOffsetS,
        to: newStartOffsetS,
      });
    }
  }

  // Quantize trim independently for in / out.
  let trim: QuantizePreview["trim"] = null;
  const trimInSnapped = snapTime(state.trim.in, mode, ctx);
  const trimOutSnapped = snapTime(state.trim.out, mode, ctx);
  const inOff = Math.abs(trimInSnapped - state.trim.in) > ON_GRID_TOLERANCE_S;
  const outOff =
    Math.abs(trimOutSnapped - state.trim.out) > ON_GRID_TOLERANCE_S;
  if (inOff || outOff) {
    trim = {
      from: { in: state.trim.in, out: state.trim.out },
      to: {
        in: inOff ? trimInSnapped : state.trim.in,
        out: outOff ? trimOutSnapped : state.trim.out,
      },
    };
  }

  // Quantize fx in/out independently — same grid as cuts/clips/trim. P-FX
  // overlap freely so we don't dedupe; if two end up colliding on the
  // same beat, both stay (greedy lane packing in the UI surfaces them as
  // sub-rows).
  const fxs: FxQuantizeChange[] = [];
  for (const f of state.fx ?? []) {
    const inSnapped = snapTime(f.inS, mode, ctx);
    const outSnapped = snapTime(f.outS, mode, ctx);
    const inOff = Math.abs(inSnapped - f.inS) > ON_GRID_TOLERANCE_S;
    const outOff = Math.abs(outSnapped - f.outS) > ON_GRID_TOLERANCE_S;
    if (!inOff && !outOff) continue;
    const change: FxQuantizeChange = { id: f.id };
    if (inOff) change.in = { from: f.inS, to: inSnapped };
    if (outOff) change.out = { from: f.outS, to: outSnapped };
    fxs.push(change);
  }

  return { cuts, clipStartOffsets, trim, fxs };
}

function emptyPreview(): QuantizePreview {
  return { cuts: [], clipStartOffsets: [], trim: null, fxs: [] };
}
