/**
 * Paused-FX audition latch — the ONE implementation of the toggle/swap
 * gesture, shared by the FxHardwarePanel pad clicks and the V/W/E/R/T/Z/U
 * hotkeys (pages/Editor.tsx). While playback is paused a trigger LATCHES
 * a preview hold (the effect sits on the live frame so the user can dial
 * DEPTH/EDGE, encoders, ADSR); triggering the same kind again drops it,
 * a different kind swaps. Only one preview exists at a time — that keeps
 * the LCD readout and the live override unambiguous.
 *
 * Nothing is written to `fx[]` — preview holds are overlay-only (see
 * beginFxHold's paused branch in store.ts).
 */
import type { FxKind } from "./fx/types";
import type { FxHoldEntry } from "./store";

/** The slice of the editor store the latch gesture needs. Callers pass
 *  `useEditorStore.getState()` — the structural type keeps this testable
 *  and free of import cycles. */
export interface FxLatchStore {
  playback: { timelineT: number };
  fxHolds: Record<string, FxHoldEntry>;
  snapTimelineTime(t: number): number;
  beginFxHold(slotKey: string, kind: FxKind, startS: number): void;
  endFxHold(slotKey: string): void;
}

export type FxLatchResult = "latched" | "unlatched" | "swapped";

/**
 * Toggle/swap the single paused-audition preview. Call only while
 * playback is paused (playing triggers are press-and-hold recordings,
 * a different gesture).
 */
export function toggleFxPreviewLatch(
  s: FxLatchStore,
  slotKey: string,
  kind: FxKind,
): FxLatchResult {
  // Find any existing preview-mode hold — regardless of which slot
  // (pad click or hotkey) latched it, so both triggers stay in sync.
  let existingSlot: string | null = null;
  let existingKind: FxKind | null = null;
  for (const [slot, h] of Object.entries(s.fxHolds)) {
    if (h.mode === "preview") {
      existingSlot = slot;
      existingKind = h.kind;
      break;
    }
  }
  if (existingSlot != null && existingKind === kind) {
    // Same kind → toggle off.
    s.endFxHold(existingSlot);
    return "unlatched";
  }
  if (existingSlot != null) {
    // Different kind → drop the prior preview before latching the new one.
    s.endFxHold(existingSlot);
    const t = s.snapTimelineTime(s.playback.timelineT);
    s.beginFxHold(slotKey, kind, t);
    return "swapped";
  }
  const t = s.snapTimelineTime(s.playback.timelineT);
  s.beginFxHold(slotKey, kind, t);
  return "latched";
}
