/**
 * Pure quantize helpers for the Q-hold-to-quantize gesture.
 *
 * `buildQuantizePreview` returns a list of from→to deltas for every
 * off-grid CUT and FX edge. The Timeline component renders ghost markers
 * at the `to` positions while Q is held; on keyup the store commits the
 * deltas. Esc cancels by simply discarding the preview.
 *
 * Scope is deliberately cuts + fx ONLY (#70). Cam start positions are
 * auto-synced — snapping them to the musical grid would shift a camera
 * against the master audio and destroy the sample-accurate alignment the
 * app exists to compute. The master trim (export window) is equally off
 * limits: both used to be silently committed on Q-release without any
 * ghost preview.
 *
 * All quantized entities live in timeline-time (song axis), so a single
 * snap context — anchored the way the BeatRuler draws its bars — applies
 * to everything in the preview.
 */
import { snapTime, type SnapMode, type SnapCtx } from "../core/snap";
import type { Cut } from "../storage/jobs-db";
import type { PunchFx } from "../core/fx/types";

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
  /** Per-fx in/out snap deltas. Empty when no fx in the snapshot or all
   *  on-grid. Only the side(s) that moved are populated. */
  fxs: FxQuantizeChange[];
}

export interface QuantizeStateSnapshot {
  cuts: Cut[];
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
  // ill-defined for cuts.)
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

  // Quantize fx in/out independently — same grid as cuts. P-FX overlap
  // freely so we don't dedupe; if two end up colliding on the same beat,
  // both stay (greedy lane packing in the UI surfaces them as sub-rows).
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

  return { cuts, fxs };
}

function emptyPreview(): QuantizePreview {
  return { cuts: [], fxs: [] };
}
