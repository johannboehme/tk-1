/**
 * Bounded undo/redo history for the editor's DOCUMENT slice (#69).
 *
 * The store's mutating actions are numerous and gesture-driven (drags
 * write at 60 Hz, holds paint continuously), so the history is not a
 * per-action middleware: it subscribes to the store and coalesces
 * bursts of document changes into single entries.
 *
 *  - Capture: the first document-relevant change of a burst snapshots
 *    the PREVIOUS state (by reference — the store's immutable-update
 *    discipline makes snapshots free).
 *  - Finalize: after `IDLE_MS` without further changes AND with no
 *    in-flight gesture (`holdGesture`, `fxHolds`, `quantizePreview`),
 *    the base snapshot becomes one undo entry. A whole pill drag, a
 *    hold-paint, or an X-clear (clearAllFx + clearCuts) is ONE entry;
 *    a cancelled gesture (Esc → cancelHold) finalizes as a no-op and
 *    is dropped.
 *  - Restore: undo/redo write through `useEditorStore.setState`, so
 *    every subscriber — useAutoPersist's dirty-check included — sees
 *    the restored state like any other edit and persists it.
 *
 * What's IN the document slice: cuts, fx, pills, per-clip user edits
 * (sync override, source-trim, rotation/flip, viewport transform,
 * image duration, start offset), master trim, overlays, color grade,
 * filter slots, audio volume, loop region, and the beat-grid settings
 * (BPM override, audio-start nudge, beats-per-bar, pickup). Selection
 * is snapshotted for restore but never *creates* entries.
 *
 * What's OUT: playback/playhead state, zoom/scroll/panel UI, export
 * spec (written programmatically by the display-dims auto-init), and
 * clip ADD/REMOVE — cams are job-level assets whose files are gone
 * after removal, so undo merges clip fields per-id and never
 * resurrects or deletes a lane.
 */
import { useEditorStore, type BpmInfo } from "./store";
import { clampLoopToBounds } from "./arrangement-loop";
import {
  isImageClip,
  isVideoClip,
  type Clip,
  type Pill,
  type TextOverlay,
} from "../core/types";
import type { Cut } from "../storage/jobs-db";
import type { FilterSlot, PunchFx } from "../core/fx/types";
import type { GradeParams } from "../core/fx/looks";
import type { LoopRegion } from "./OffsetScheduler";
import { clamp } from "../lib/clamp";

type EditorState = ReturnType<typeof useEditorStore.getState>;

/** Quiet window after the last document change before a burst becomes
 *  one undo entry. Drags/holds tick every frame (~16 ms), so they stay
 *  in one burst; deliberate discrete edits are usually further apart. */
const IDLE_MS = 300;
/** Bounded stack — snapshots hold array references, so entries are cheap. */
const MAX_ENTRIES = 100;

interface DocSnapshot {
  cuts: Cut[];
  fx: PunchFx[];
  pills: Pill[];
  clips: Clip[];
  trim: { in: number; out: number };
  overlays: TextOverlay[];
  colorGrade: GradeParams;
  filterSlots: FilterSlot[];
  audioVolume: number;
  loop: LoopRegion | null;
  bpm: BpmInfo | null;
  audioStartNudgeS: number;
  beatsPerBar: number;
  barOffsetBeats: number;
  selectedClipId: string | null;
  selectedPillId: string | null;
}

interface HistoryEntry {
  /** Document state to restore when this entry is applied. */
  snapshot: DocSnapshot;
  /** Short noun label of what the entry's change touched ("cuts + FX"). */
  label: string;
}

// ─── Module state (one editor at a time) ─────────────────────────────────

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
/** Pre-burst snapshot; null = no burst in flight. */
let pendingBase: DocSnapshot | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** True while undo/redo applies a snapshot — the subscription must not
 *  record the restore as a fresh edit. */
let restoring = false;

// ─── Snapshot & equality ─────────────────────────────────────────────────

function captureSnapshot(s: EditorState): DocSnapshot {
  return {
    cuts: s.cuts,
    fx: s.fx,
    pills: s.pills,
    clips: s.clips,
    trim: s.trim,
    overlays: s.overlays,
    colorGrade: s.colorGrade,
    filterSlots: s.filterSlots,
    audioVolume: s.audioVolume,
    loop: s.playback.loop,
    bpm: s.jobMeta?.bpm ?? null,
    audioStartNudgeS: s.jobMeta?.audioStartNudgeS ?? 0,
    beatsPerBar: s.jobMeta?.beatsPerBar ?? 4,
    barOffsetBeats: s.jobMeta?.barOffsetBeats ?? 0,
    selectedClipId: s.selectedClipId,
    selectedPillId: s.selectedPillId,
  };
}

/** Cheap "did anything document-relevant possibly change" test — pure
 *  reference checks, run on every store transition. False positives are
 *  fine (finalize drops content-equal bursts); false negatives are not. */
function docRefsChanged(s: EditorState, p: EditorState): boolean {
  return (
    s.cuts !== p.cuts ||
    s.fx !== p.fx ||
    s.pills !== p.pills ||
    s.clips !== p.clips ||
    s.trim !== p.trim ||
    s.overlays !== p.overlays ||
    s.colorGrade !== p.colorGrade ||
    s.filterSlots !== p.filterSlots ||
    s.audioVolume !== p.audioVolume ||
    s.playback.loop !== p.playback.loop ||
    s.jobMeta !== p.jobMeta
  );
}

function refArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cutsEqual(a: readonly Cut[], b: readonly Cut[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].atTimeS !== b[i].atTimeS || a[i].camId !== b[i].camId) {
      return false;
    }
  }
  return true;
}

function vtEqual(
  a: Clip["viewportTransform"],
  b: Clip["viewportTransform"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.scale === b.scale && a.x === b.x && a.y === b.y;
}

/** Per-clip equality over the USER-EDITABLE projection only. Ignores
 *  displayW/H (reported by media elements after mount) and candidate/
 *  sync-result fields (written programmatically when prep finishes). */
function clipDocEqual(a: Clip, b: Clip): boolean {
  if (a === b) return true;
  if ((a.startOffsetS ?? 0) !== (b.startOffsetS ?? 0)) return false;
  if ((a.rotation ?? 0) !== (b.rotation ?? 0)) return false;
  if ((a.flipX ?? false) !== (b.flipX ?? false)) return false;
  if ((a.flipY ?? false) !== (b.flipY ?? false)) return false;
  if (!vtEqual(a.viewportTransform, b.viewportTransform)) return false;
  if (isImageClip(a) || isImageClip(b)) {
    if (!isImageClip(a) || !isImageClip(b)) return false;
    return a.durationS === b.durationS;
  }
  return (
    a.syncOverrideMs === b.syncOverrideMs &&
    a.selectedCandidateIdx === b.selectedCandidateIdx &&
    a.trimInS === b.trimInS &&
    a.trimOutS === b.trimOutS
  );
}

/** Compare only clips present in BOTH lists (matched by id) — cam
 *  add/remove is a job-level operation, deliberately not undoable. */
function clipsDocEqual(a: readonly Clip[], b: readonly Clip[]): boolean {
  if (a === b) return true;
  const byId = new Map(b.map((c) => [c.id, c]));
  for (const ca of a) {
    const cb = byId.get(ca.id);
    if (cb && !clipDocEqual(ca, cb)) return false;
  }
  return true;
}

function gradeEqual(a: GradeParams, b: GradeParams): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, number>;
  const rb = b as unknown as Record<string, number>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (ra[k] !== rb[k]) return false;
  return true;
}

function loopEqual(a: LoopRegion | null, b: LoopRegion | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

function bpmEqual(a: BpmInfo | null, b: BpmInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.value === b.value &&
    a.phase === b.phase &&
    a.confidence === b.confidence &&
    a.manualOverride === b.manualOverride
  );
}

/** Which document surfaces differ between two snapshots. Doubles as the
 *  no-op detector (empty result) and the entry-label source. */
function diffLabels(a: DocSnapshot, b: DocSnapshot): string[] {
  const out: string[] = [];
  if (!cutsEqual(a.cuts, b.cuts)) out.push("cuts");
  if (!refArrayEqual(a.fx, b.fx)) out.push("FX");
  if (!refArrayEqual(a.pills, b.pills) || !clipsDocEqual(a.clips, b.clips)) {
    out.push("clips");
  }
  if (a.trim.in !== b.trim.in || a.trim.out !== b.trim.out) out.push("trim");
  if (!loopEqual(a.loop, b.loop)) out.push("loop");
  if (!refArrayEqual(a.overlays, b.overlays)) out.push("overlays");
  if (!gradeEqual(a.colorGrade, b.colorGrade)) out.push("color grade");
  if (!refArrayEqual(a.filterSlots, b.filterSlots)) out.push("filters");
  if (a.audioVolume !== b.audioVolume) out.push("volume");
  if (
    !bpmEqual(a.bpm, b.bpm) ||
    a.audioStartNudgeS !== b.audioStartNudgeS ||
    a.beatsPerBar !== b.beatsPerBar ||
    a.barOffsetBeats !== b.barOffsetBeats
  ) {
    out.push("grid");
  }
  return out;
}

function labelText(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return "several edits";
}

// ─── Burst lifecycle ─────────────────────────────────────────────────────

/** In-flight gesture — finalize must wait so the whole hold/preview is
 *  one entry (and a cancel can collapse it to nothing). */
function gestureActive(s: EditorState): boolean {
  return (
    s.holdGesture !== null ||
    Object.keys(s.fxHolds).length > 0 ||
    s.quantizePreview !== null
  );
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(onIdle, IDLE_MS);
}

function onIdle(): void {
  idleTimer = null;
  const s = useEditorStore.getState();
  if (gestureActive(s)) {
    // Gesture still running (e.g. a long hold with no store writes for a
    // beat) — poll until it releases.
    armIdleTimer();
    return;
  }
  finalizePending(s);
}

function finalizePending(s: EditorState): void {
  clearIdleTimer();
  if (pendingBase === null) return;
  const base = pendingBase;
  pendingBase = null;
  const labels = diffLabels(base, captureSnapshot(s));
  // Content-equal (cancelled gesture, display-dims churn, no-op drag) —
  // nothing worth an entry.
  if (labels.length === 0) return;
  undoStack.push({ snapshot: base, label: labelText(labels) });
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  redoStack = [];
  syncDepth();
}

function syncDepth(): void {
  const cur = useEditorStore.getState().history;
  const undoDepth = undoStack.length;
  const redoDepth = redoStack.length;
  if (cur.undoDepth === undoDepth && cur.redoDepth === redoDepth) return;
  useEditorStore.setState({ history: { undoDepth, redoDepth } });
}

// ─── Store subscription ──────────────────────────────────────────────────

function onStoreChange(state: EditorState, prev: EditorState): void {
  if (restoring) return;
  // Document unloaded (reset / navigate away) — drop everything.
  if (state.jobMeta === null) {
    if (undoStack.length || redoStack.length || pendingBase) {
      resetEditorHistory();
    }
    return;
  }
  // Another document loaded — its past is not this document's past.
  if (prev.jobMeta === null || state.jobMeta.id !== prev.jobMeta.id) {
    resetEditorHistory();
    return;
  }
  if (!docRefsChanged(state, prev)) return;
  if (pendingBase === null) pendingBase = captureSnapshot(prev);
  armIdleTimer();
}

// ─── Restore ─────────────────────────────────────────────────────────────

/** Merge a snapshot clip's user-editable fields onto the CURRENT clip.
 *  syncOffsetMs is re-derived from the current candidates so a restored
 *  selectedCandidateIdx stays consistent with post-snapshot sync results. */
function restoreClipDoc(cur: Clip, old: Clip): Clip {
  if (!isVideoClip(cur) || !isVideoClip(old)) return cur;
  if (clipDocEqual(cur, old)) return cur;
  const idx = clamp(
    old.selectedCandidateIdx,
    0,
    Math.max(0, cur.candidates.length - 1),
  );
  return {
    ...cur,
    syncOverrideMs: old.syncOverrideMs,
    startOffsetS: old.startOffsetS,
    selectedCandidateIdx: idx,
    syncOffsetMs: cur.candidates[idx]?.offsetMs ?? cur.syncOffsetMs,
    trimInS: old.trimInS,
    trimOutS: old.trimOutS,
    rotation: old.rotation,
    flipX: old.flipX,
    flipY: old.flipY,
    viewportTransform: old.viewportTransform,
  };
}

function restoreImageClipDoc(cur: Clip, old: Clip): Clip {
  if (isVideoClip(cur) || isVideoClip(old)) return cur;
  if (clipDocEqual(cur, old)) return cur;
  return {
    ...cur,
    startOffsetS: old.startOffsetS,
    durationS: old.durationS,
    rotation: old.rotation,
    flipX: old.flipX,
    flipY: old.flipY,
    viewportTransform: old.viewportTransform,
  };
}

function applySnapshot(snap: DocSnapshot): void {
  const s = useEditorStore.getState();
  const camIds = new Set(s.clips.map((c) => c.id));
  const oldById = new Map(snap.clips.map((c) => [c.id, c]));

  // Per-id field merge — never resurrects removed cams / deletes added ones.
  const clips = s.clips.map((cur) => {
    const old = oldById.get(cur.id);
    if (!old) return cur;
    return isVideoClip(cur)
      ? restoreClipDoc(cur, old)
      : restoreImageClipDoc(cur, old);
  });
  // Cuts/pills referencing cams that no longer exist are dropped — same
  // validation setPills applies.
  const cuts = snap.cuts.filter((c) => camIds.has(c.camId));
  const pills = snap.pills.filter((p) => camIds.has(p.camId));
  const selectedClipId =
    snap.selectedClipId !== null && camIds.has(snap.selectedClipId)
      ? snap.selectedClipId
      : null;
  const selectedPillId =
    snap.selectedPillId !== null &&
    pills.some((p) => p.id === snap.selectedPillId)
      ? snap.selectedPillId
      : null;
  // Loop goes back through the same clamp setLoop applies — the restored
  // trim is part of the same snapshot, so both stay consistent.
  const loop = clampLoopToBounds(snap.loop, s.arrangementSegments, snap.trim);
  const jobMeta = s.jobMeta
    ? {
        ...s.jobMeta,
        bpm: snap.bpm,
        audioStartNudgeS: snap.audioStartNudgeS,
        beatsPerBar: snap.beatsPerBar,
        barOffsetBeats: snap.barOffsetBeats,
      }
    : s.jobMeta;
  // Legacy offset-slice mirror (SyncTuner reads it) tracks cam-1's override.
  const cam0 = clips[0];
  const userOverrideMs =
    cam0 && isVideoClip(cam0)
      ? cam0.syncOverrideMs
      : s.offset.userOverrideMs;

  restoring = true;
  try {
    useEditorStore.setState({
      cuts,
      fx: snap.fx,
      pills,
      clips,
      trim: snap.trim,
      overlays: snap.overlays,
      colorGrade: snap.colorGrade,
      filterSlots: snap.filterSlots,
      audioVolume: snap.audioVolume,
      playback: { ...s.playback, loop },
      jobMeta,
      selectedClipId,
      selectedPillId,
      offset: { ...s.offset, userOverrideMs },
    });
  } finally {
    restoring = false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Install the store subscription. Mount once from the editor page;
 * the returned disposer unsubscribes and drops all history.
 */
export function initEditorHistory(): () => void {
  const unsub = useEditorStore.subscribe(onStoreChange);
  return () => {
    unsub();
    resetEditorHistory();
  };
}

/** Drop all history (fresh document). Also called by the disposer. */
export function resetEditorHistory(): void {
  undoStack = [];
  redoStack = [];
  pendingBase = null;
  clearIdleTimer();
  syncDepth();
}

/** Finalize any in-flight burst immediately (tests; pre-undo flush). */
export function flushPendingHistory(): void {
  finalizePending(useEditorStore.getState());
}

/**
 * Undo the most recent document edit. No-op while a gesture is in
 * flight (Esc is the cancel for those). Returns true when an entry was
 * applied. Restores flow through the store, so auto-persist writes the
 * restored state like any other change.
 */
export function undoEdit(): boolean {
  const s = useEditorStore.getState();
  if (!s.jobMeta) return false;
  if (gestureActive(s)) return false;
  finalizePending(s);
  const entry = undoStack.pop();
  if (!entry) {
    s.pushNotice("Nothing to undo");
    return false;
  }
  redoStack.push({
    snapshot: captureSnapshot(useEditorStore.getState()),
    label: entry.label,
  });
  applySnapshot(entry.snapshot);
  syncDepth();
  useEditorStore.getState().pushNotice(`Undo — ${entry.label}`);
  return true;
}

/** Redo the most recently undone edit. Counterpart of `undoEdit`. */
export function redoEdit(): boolean {
  const s = useEditorStore.getState();
  if (!s.jobMeta) return false;
  if (gestureActive(s)) return false;
  finalizePending(s);
  const entry = redoStack.pop();
  if (!entry) {
    s.pushNotice("Nothing to redo");
    return false;
  }
  undoStack.push({
    snapshot: captureSnapshot(useEditorStore.getState()),
    label: entry.label,
  });
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  applySnapshot(entry.snapshot);
  syncDepth();
  useEditorStore.getState().pushNotice(`Redo — ${entry.label}`);
  return true;
}

/** True on Apple platforms — decides ⌘ vs Ctrl in shortcut labels. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");
}

/** Human-readable key label for the undo shortcut ("⌘Z" / "Ctrl+Z"). */
export function undoKeyLabel(): string {
  return isMacPlatform() ? "⌘Z" : "Ctrl+Z";
}

/** Human-readable key label for the redo shortcut. */
export function redoKeyLabel(): string {
  return isMacPlatform() ? "⇧⌘Z" : "Ctrl+Shift+Z";
}
