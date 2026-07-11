import type { SnapMode } from "../../snap";

/** Hit zone reported by Timeline's pill hit-testing. */
export type PillHitZone = "left" | "right" | "body" | "reset";

/** Drag gesture a pill pointerdown may start. */
export type PillDragKind =
  | "playhead"
  | "pill-trim-in"
  | "pill-trim-out"
  | "pill-move"
  | "cam-track-move";

export type PillPointerDecision =
  /** Floating ↺ reset-button → revert the pill, no selection, no drag. */
  | { kind: "reset-pill" }
  /**
   * Select the pill (+ its cam). `seek` scrubs the playhead to the
   * pointer; `drag` is the gesture to arm (null = click, no drag).
   */
  | { kind: "select"; seek: boolean; drag: PillDragKind | null };

/**
 * Pure decision for a pointerdown that hit a pill in the Timeline.
 *
 * Video-lane interaction model (pills ARE the editing surface):
 *  - LOCK ON (default): pill-hits SELECT but don't start an edit drag —
 *    the SyncTuner + OptionsPanel still need a target. The click also
 *    scrubs the playhead so the pointer position can be auditioned —
 *    but NOT while a loop is engaged: a scrub onto a pill outside the
 *    loop lands out of the loop region, and the audio walker's
 *    immediate-wrap (useAudioMaster) yanks playback straight back to
 *    loop.start, so the picked pill could never be auditioned. With a
 *    loop active, select only and leave the loop running untouched.
 *    (Project invariant — regressed once as a user-reported bug.)
 *  - LOCK OFF: pill-edge hits start a trim drag, pill-body hits start
 *    a move drag; MATCH snap-mode promotes the body-drag to a
 *    cam-track move. Edit drags never scrub.
 *  - The ↺ reset zone always fires — it is a destructive-revert
 *    action, not an edit gesture, so lock state does not gate it.
 */
export function decidePillPointerDown(input: {
  zone: PillHitZone;
  loopActive: boolean;
  lanesLocked: boolean;
  snapMode: SnapMode;
}): PillPointerDecision {
  const { zone, loopActive, lanesLocked, snapMode } = input;

  if (zone === "reset") return { kind: "reset-pill" };

  if (lanesLocked) {
    if (loopActive) return { kind: "select", seek: false, drag: null };
    return { kind: "select", seek: true, drag: "playhead" };
  }

  if (zone === "left") return { kind: "select", seek: false, drag: "pill-trim-in" };
  if (zone === "right") return { kind: "select", seek: false, drag: "pill-trim-out" };
  return {
    kind: "select",
    seek: false,
    drag: snapMode === "match" ? "cam-track-move" : "pill-move",
  };
}
