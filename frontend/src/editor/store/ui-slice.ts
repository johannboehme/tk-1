/**
 * UI domain — panel/zoom/scroll/snap/lock preferences, the transient
 * toast notice, the undo/redo depth mirror, and the snap selectors that
 * apply the active snap mode to master- / timeline-time values.
 */
import { snapTime, type SnapMode } from "../../core/snap";
import {
  effectiveBeatPhaseS,
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
  arrBeatPhaseS,
} from "../selectors/timing";
import type { SliceCreator } from "./state";

export type PanelTab = "sync" | "options" | "overlays" | "export";

export interface UiSlice {
  activePanel: PanelTab;
  zoom: number; // 1 = full duration fits in viewport, 2 = 50% fits, etc.
  scrollX: number; // seconds offset from start of trim region
  /** Active snap mode for every time-mutating drag/click in the timeline. */
  snapMode: SnapMode;
  /** When true, cam-clip horizontal drag is disabled — only the playhead
   *  moves. Avoids the "playhead trapped behind dense clips" problem. */
  lanesLocked: boolean;
  /** What the ProgramStrip displays. "cuts" = today's cam-color tape +
   *  brass splice tabs (default). "fx" = punch-in FX capsules only.
   *  "both" = vertical split (cuts top, fx bottom). */
  programStripMode: "cuts" | "fx" | "both";
  /** Whether the FX hardware-pad panel is slid out (desktop). On mobile
   *  the panel ignores this and stays always-open. */
  fxPanelOpen: boolean;
  /** 0..1 progress of the keyboard-driven X-hold-to-clear gesture
   *  (only active while paused — during playback X erases under the
   *  playhead instead). ProgramStrip mirrors this onto whichever lanes
   *  are visible per `programStripMode`, sharing the visual treatment
   *  with the pointer-driven long-press. `null` when idle. */
  xClearProgress: number | null;
}

export interface UiSliceState {
  ui: UiSlice;
  /** Transient toast/notice the editor can flash to the user (e.g. "no
   *  match candidates — beat snap"). The `key` reshuffles on every push so
   *  the toast component can re-trigger its enter animation even if the
   *  message text is unchanged. Null when nothing is showing. */
  notice: { message: string; key: number } | null;
  /** Undo/redo stack depths, mirrored in by the editor history module
   *  (`editor/history.ts`) so UI affordances (transport undo/redo
   *  buttons) can subscribe. The stacks themselves live outside the
   *  store — snapshots of the store must not be part of the state they
   *  snapshot. Written exclusively by the history module. */
  history: { undoDepth: number; redoDepth: number };
}

export interface UiSliceActions {
  setActivePanel(tab: PanelTab): void;
  setZoom(z: number): void;
  setScrollX(x: number): void;
  setSnapMode(m: SnapMode): void;
  setLanesLocked(locked: boolean): void;
  setProgramStripMode(mode: UiSlice["programStripMode"]): void;
  setFxPanelOpen(open: boolean): void;
  /** Update the X-hold-to-clear progress (0..1, or null to clear).
   *  Editor.tsx writes this from a RAF timer while X is held during
   *  pause; ProgramStrip mirrors it onto whichever lanes are visible. */
  setXClearProgress(progress: number | null): void;
  /** Show a transient toast. Reuses the same store slot — multiple pushes
   *  in quick succession overwrite each other. The toast component owns
   *  the timer and clears via dismissNotice. */
  pushNotice(message: string): void;
  /** Clear the active notice. No-op when none is showing. */
  dismissNotice(): void;
  /** Apply the active snap mode to a master-timeline time. Used by every
   *  cut-set call site (TAKE-button, hotkey, REC) so cuts respect the
   *  same grid as drag-snapping. Returns `t` unchanged in mode "off". */
  snapMasterTime(t: number): number;
  /** Apply the active snap mode to a timeline-time value. The grid
   *  anchor (beatPhase) is projected from master-time into timeline-
   *  time so the snapped value lands on the same bar marker the
   *  BeatRuler draws. Use this for FX / Cut recording, where the
   *  capsule lives on the song axis. */
  snapTimelineTime(t: number): number;
}

const initialUi: UiSlice = {
  activePanel: "sync",
  zoom: 1,
  scrollX: 0,
  snapMode: "off",
  // Default: lanes locked. The user has to press the LOCK button to unlock
  // before clips become draggable — keeps the playhead reachable through
  // dense lanes by default. Pressing the (unlock) button = lanes locked
  // becomes false.
  lanesLocked: true,
  programStripMode: "both",
  // Closed by default on every form factor. The pull-tab is the
  // discovery affordance; users tap it to expand the pad bank.
  fxPanelOpen: false,
  xClearProgress: null,
};

export function initialUiState(): UiSliceState {
  return {
    ui: initialUi,
    notice: null,
    history: { undoDepth: 0, redoDepth: 0 },
  };
}

export const createUiSlice: SliceCreator<UiSliceActions> = (set, get) => ({
  setActivePanel(tab) {
    set({ ui: { ...get().ui, activePanel: tab } });
  },
  setZoom(z) {
    // Cap matches Timeline.tsx's MAX_ZOOM so wheel/pinch and a
    // hypothetical programmatic zoom land in the same range.
    set({ ui: { ...get().ui, zoom: Math.max(1, Math.min(1024, z)) } });
  },
  setScrollX(x) {
    set({ ui: { ...get().ui, scrollX: Math.max(0, x) } });
  },
  setSnapMode(m) {
    set({ ui: { ...get().ui, snapMode: m } });
  },
  setLanesLocked(locked) {
    set({ ui: { ...get().ui, lanesLocked: locked } });
  },
  setProgramStripMode(mode) {
    set({ ui: { ...get().ui, programStripMode: mode } });
  },
  setFxPanelOpen(open) {
    set({ ui: { ...get().ui, fxPanelOpen: open } });
  },
  setXClearProgress(progress) {
    const cur = get().ui.xClearProgress;
    if (cur === progress) return;
    set({ ui: { ...get().ui, xClearProgress: progress } });
  },
  pushNotice(message) {
    const cur = get().notice;
    set({ notice: { message, key: cur ? cur.key + 1 : 1 } });
  },
  dismissNotice() {
    set({ notice: null });
  },
  snapMasterTime(t) {
    const s = get();
    const mode = s.ui.snapMode;
    // MATCH mode is for clip-drag (where we have candidatePositions);
    // for cut-set we treat it as off — the user's intent is "snap to
    // beat", not "snap to a cam-alignment offset which is unrelated to
    // the master-clock cut position".
    if (mode === "off" || mode === "match") return t;
    return snapTime(t, mode, {
      bpm: s.jobMeta?.bpm?.value ?? null,
      beatPhase: effectiveBeatPhaseS(s.jobMeta),
      beatsPerBar: effectiveBeatsPerBar(s.jobMeta),
      barOffsetBeats: effectiveBarOffsetBeats(s.jobMeta),
    });
  },
  snapTimelineTime(t) {
    const s = get();
    const mode = s.ui.snapMode;
    if (mode === "off" || mode === "match") return t;
    // For the snap result to land on the bar marker the BeatRuler
    // renders, the beat-grid anchor must be in the same arr-time axis
    // as `t`. `arrBeatPhaseS` is the exact anchor the BeatRuler uses
    // (beat 0 relative to the first played segment).
    const beatPhase = arrBeatPhaseS(s.jobMeta, s.arrangementSegments);
    return snapTime(t, mode, {
      bpm: s.jobMeta?.bpm?.value ?? null,
      beatPhase,
      beatsPerBar: effectiveBeatsPerBar(s.jobMeta),
      barOffsetBeats: effectiveBarOffsetBeats(s.jobMeta),
    });
  },
});
