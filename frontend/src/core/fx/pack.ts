import type { PunchFx } from "./types";

export interface FxPackLayout {
  id: string;
  slotIdx: number;
}

export interface FxPackResult {
  /** Number of sub-rows needed to hold all fx without overlap. */
  slots: number;
  /** One entry per fx, mapping id → slotIdx. */
  layout: FxPackLayout[];
}

/**
 * Greedy lane packing for the FX-half of the ProgramStrip. Sorts the fx by
 * `inS` (ties broken by id for determinism), then for each fx places it in
 * the lowest sub-slot whose last fx ended at or before this fx's `inS`.
 *
 * The result preserves the *input* iteration order in `layout`, but the
 * slot assignment respects time-order so the visual result is stable.
 *
 * Touching boundaries (a.outS === b.inS) count as non-overlapping —
 * matches the inclusive-in / exclusive-out semantics of `activeFxAt`.
 */
export function packFxIntoSlots(fx: readonly PunchFx[]): FxPackResult {
  if (fx.length === 0) return { slots: 0, layout: [] };

  // Time-order the indices for slot assignment. We keep the original input
  // order in the output so callers can pair `layout[i]` with `fx[i]` if
  // they want — though here we key by id, which is more robust under
  // re-renders.
  const orderedIdx = fx
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = fx[a];
      const fb = fx[b];
      if (fa.inS !== fb.inS) return fa.inS - fb.inS;
      return fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0;
    });

  // slotEnds[s] = last assigned outS in slot s. -Infinity for an empty slot.
  const slotEnds: number[] = [];
  const assignment = new Map<string, number>();

  for (const idx of orderedIdx) {
    const f = fx[idx];
    let placed = -1;
    for (let s = 0; s < slotEnds.length; s++) {
      if (slotEnds[s] <= f.inS) {
        placed = s;
        break;
      }
    }
    if (placed === -1) {
      slotEnds.push(f.outS);
      placed = slotEnds.length - 1;
    } else {
      slotEnds[placed] = f.outS;
    }
    assignment.set(f.id, placed);
  }

  const layout: FxPackLayout[] = fx.map((f) => ({
    id: f.id,
    slotIdx: assignment.get(f.id) ?? 0,
  }));
  return { slots: slotEnds.length, layout };
}
