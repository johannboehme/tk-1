/**
 * Editor state. zustand because:
 *  - currentTime updates at ~60Hz; we don't want a useReducer/Context to
 *    re-render the whole tree on every tick. Selectors keep the timeline
 *    and transport bar isolated from panel re-renders.
 *  - Slices are kept logically grouped (offset / trim / etc.) for
 *    extensibility — future tracks/clips slot in without restructuring.
 */
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  Clip,
  EditSpec,
  ExportSpec,
  MatchCandidate,
  TextOverlay,
  ViewportTransform,
  VisualizerConfig,
  clipEffectiveDisplayDims,
  clipRangeS,
  isVideoClip,
} from "./types";
import { classifyAspectRatio } from "./exportPresets";
import { DEFAULT_VIEWPORT_TRANSFORM } from "./render/element-transform";
import { LoopRegion, clampLoopRegion } from "./OffsetScheduler";
import { activeCamAt, type CamRange } from "./cuts";
import { gridStepSeconds, snapTime, type SnapMode } from "./snap";
import { buildClipMatchPositions } from "./match-snap";
import { buildQuantizePreview, type QuantizePreview } from "./quantize";
import {
  effectiveBeatPhaseS,
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
} from "./selectors/timing";
import type { Cut } from "../storage/jobs-db";
import type { FxKind, PunchFx } from "./fx/types";
import { defaultTapLengthS, fxCatalog } from "./fx/catalog";
import type { ADSREnvelope } from "./fx/envelope";
import { INSTANT_ENVELOPE } from "./fx/envelope";

export interface BpmInfo {
  /** BPM (detected or user-overridden). */
  value: number;
  /** Detection confidence 0..1 (the autocorrelation peak strength). */
  confidence: number;
  /** Phase of beat 0 in seconds. */
  phase: number;
  /** True when the user manually overrode the detected BPM. */
  manualOverride: boolean;
}

export interface JobMeta {
  id: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  algoOffsetMs: number;
  driftRatio: number;
  /** Master-audio tempo info — either the detected one or the user's
   *  manual override (manualOverride flag distinguishes). null when no
   *  analysis ran. */
  bpm?: BpmInfo | null;
  /** Original detected BPM (kept around so the user can revert from a
   *  manual override). null when the analysis didn't detect anything. */
  detectedBpm?: BpmInfo | null;
  /** Beat times (seconds, master-timeline). Used by BeatRuler and snap. */
  beats?: number[];
  /** Every 4th beat (4/4 fixed in V1). */
  downbeats?: number[];
  /** When the actual performance starts in the master audio (seconds).
   *  0 when the file is non-silent throughout. Used by the "go to audio
   *  start" transport button. */
  audioStartS?: number;
  /** User correction to the auto-detected audio start, in seconds (signed).
   *  When non-zero it shifts both the beat-grid anchor and the audio-start
   *  marker by the same delta — see `effectiveBeatPhaseS` /
   *  `effectiveAudioStartS`. Lives separately from `bpm.phase` so a
   *  re-analysis (which overwrites `bpm`) doesn't clobber the user's
   *  correction. Default 0. */
  audioStartNudgeS?: number;
  /** Beats per bar — the integer numerator the user picked (4/4 → 4,
   *  3/4 → 3, 6/8 → 6, …). Drives the bar-line grid and the "1" / "1/2"
   *  snap modes. Default 4 when missing. The detector doesn't infer this;
   *  it's a manual choice on top of detected BPM. */
  beatsPerBar?: number;
  /** Anacrusis / pickup — number of beats between beat 0 and bar 1.
   *  0 = no pickup (default; bar 1 starts on beat 0). 2 in 4/4 means the
   *  song begins with a 2-beat pickup and bar 1 sits at beat 2. Stored
   *  modulo `beatsPerBar` so any value normalises into [0, beatsPerBar). */
  barOffsetBeats?: number;
}

export type PanelTab = "sync" | "options" | "overlays" | "export";

export interface PlaybackSlice {
  currentTime: number;
  isPlaying: boolean;
  loop: LoopRegion | null;
  // Set by seek(t); useAudioMaster watches this and writes
  // audioElement.currentTime, then calls clearSeekRequest. Distinguishes
  // user-initiated seeks from the 60Hz tick that mirrors the audio
  // element's clock back into the store.
  seekRequest: number | null;
  // Deferred wrap point for OP-1 style loop-shift. When non-null the audio
  // master wraps to loop.start at this master-time instead of at loop.end —
  // letting the playhead keep playing in a now-out-of-loop zone until it
  // reaches the OLD loop end. Cleared by user-seek and setLoop().
  pendingWrapAt: number | null;
}

export interface OffsetSlice {
  userOverrideMs: number;
  // True while the user is comparing original (algo offset only) against the
  // override. Frontends use this to drive the audio scheduler — we play the
  // raw studio audio at algoOffsetMs only when bypass is true.
  abBypass: boolean;
}

export interface TrimRegion {
  in: number;
  out: number;
}

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

/** One live punch-in hold per slot key. The slotKey identifies the trigger
 *  source ("key:F" for hotkey F, "pad:0" for the first hardware pad).
 *  Multiple holds may exist simultaneously — polyphony is intentional and
 *  what makes P-FX feel like a step-sequencer / synth, not a switch. */
export interface FxHoldEntry {
  /** Persistent: hold writes a real PunchFx to fx[] and grows outS while
   *  held — recorded onto the timeline.
   *
   *  Preview: hold renders the effect over the live preview at full
   *  strength (sustain=1, no envelope) BUT does NOT write to fx[]. Used
   *  while playback is paused so the user can audition / tweak params
   *  with both encoders without polluting the timeline with 1-frame
   *  capsules. */
  mode: "persistent" | "preview";
  /** Kind being held. In persistent mode mirrors the new fx's kind; in
   *  preview mode there's no fx so this is the only place the kind lives. */
  kind: FxKind;
  /** ID of the FX whose outS is currently being live-extended. Empty
   *  string for `mode: "preview"` — no fx is written. */
  fxId: string;
  /** Master-time when this hold started (already snapped by the caller). */
  startS: number;
  /** Snapshot of fx[] at hold-start; used by cancel to revert. Empty
   *  array for preview mode (nothing to revert). */
  priorFx: PunchFx[];
}

// Default preset = "custom" — meaning "derived from the first clip on
// the timeline". The store's auto-init in `setClipDisplayDims` kicks in
// the first time a clip reports its dims and seeds aspect + resolution
// from that clip. Web/Archive/Mobile are opinionated overrides.
const DEFAULT_EXPORT: ExportSpec = {
  preset: "custom",
  format: "mp4",
  resolution: "source",
  video_codec: "h264",
  audio_codec: "aac",
  video_bitrate_kbps: 3500,
  audio_bitrate_kbps: 128,
  quality: "good",
};

/** Initial-bare data needed to construct an in-memory video clip. */
export interface VideoClipInit {
  kind?: "video";
  id: string;
  filename: string;
  color: string;
  sourceDurationS: number;
  syncOffsetMs: number;
  syncOverrideMs?: number;
  startOffsetS?: number;
  /** Per-cam drift vs. master audio. Default 1 = no drift. */
  driftRatio?: number;
  /** Top-K alternative offsets from the WASM matcher. Optional — falls back
   *  to a single-element array containing just the primary offset. */
  candidates?: MatchCandidate[];
  /** Persisted user-selected primary candidate index. Defaults to 0. */
  selectedCandidateIdx?: number;
  /** Per-clip trim — defaults to 0 / sourceDurationS. */
  trimInS?: number;
  trimOutS?: number;
  /** User-applied rotation / flip. V1 supports 90° steps + boolean flip;
   *  defaults: 0° / false. */
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate). */
  viewportTransform?: ViewportTransform;
}

/** Initial data for an image clip. */
export interface ImageClipInit {
  kind: "image";
  id: string;
  filename: string;
  color: string;
  durationS: number;
  startOffsetS?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate). */
  viewportTransform?: ViewportTransform;
}

export type ClipInit = VideoClipInit | ImageClipInit;

interface EditorState {
  jobMeta: JobMeta | null;
  playback: PlaybackSlice;
  offset: OffsetSlice;
  trim: TrimRegion;
  overlays: TextOverlay[];
  visualizer: VisualizerConfig | null;
  exportSpec: ExportSpec;
  ui: UiSlice;

  // ---- Multi-cam ----
  clips: Clip[];
  cuts: Cut[];
  selectedClipId: string | null;
  /** Live indicator for an in-progress TAKE-button-or-hotkey hold. While
   * a key/button is pressed, this points to the held cam + the master-time
   * the press started at. Once the press passes the tap-vs-hold threshold,
   * `painting` flips to true and the PROGRAM strip starts visualising the
   * range. `priorCuts` is the cuts-snapshot at press-time, used by
   * `cancelHold` (Esc) to revert. Cleared back to null on release. */
  holdGesture:
    | { camId: string; startS: number; painting: boolean; priorCuts: Cut[] }
    | null;

  /** Transient preview of the Q-hold quantize gesture. Non-null while
   *  Q is held; rendered as ghost markers in the timeline. Committed on
   *  Q-up via `commitQuantizePreview`, dropped on Esc via `cancelQuantizePreview`. */
  quantizePreview: QuantizePreview | null;

  /** Transient toast/notice the editor can flash to the user (e.g. "no
   *  match candidates — beat snap"). The `key` reshuffles on every push so
   *  the toast component can re-trigger its enter animation even if the
   *  message text is unchanged. Null when nothing is showing. */
  notice: { message: string; key: number } | null;

  /** Cams currently being prepared in the background (decode / match /
   *  frames). The Editor's live-job-update handler sets this from the
   *  underlying VideoAsset state — a cam is "preparing" while its
   *  framesPath is still undefined, regardless of skipSync. The lane
   *  header renders a small "PREP" badge while the cam is in this set. */
  preparingCamIds: ReadonlySet<string>;

  /** Punch-in FX (visual effects with in/out spans, freely overlapping). */
  fx: PunchFx[];

  /** Live punch-in holds keyed by slotKey (e.g. "key:F", "pad:0"). Multiple
   *  may be active simultaneously. Plain object so zustand reference-equality
   *  selectors work cleanly (a Map would mutate-in-place under naive use). */
  fxHolds: Record<string, FxHoldEntry>;

  /** "Recording head" state — which FX kind the FxHardwarePanel's two
   *  encoders + LCD are currently editing. Drücken eines Pads (Tastatur
   *  oder UI) selektiert den Kind; die Werte der Knobs werden in
   *  `fxDefaults` für genau diesen Kind geschrieben. Was schon auf der
   *  Timeline liegt (PunchFx mit gefrozen `params`) bleibt unverändert —
   *  Recording-Head schreibt vorwärts, nicht rückwärts. */
  selectedFxKind: FxKind;

  /** Per-Kind Encoder-Defaults — Storage-Range (z.B. vignette intensity
   *  in 0..1, NICHT die 0..100 Display-Werte). Wenn ein Eintrag fehlt,
   *  fällt `beginFxHold` auf `fxCatalog[kind].defaultParams` zurück.
   *  In-memory only in V1 — Persistenz über jobs.db kommt sobald wir
   *  entscheiden ob das per-Job (Edit) oder global (User-Pref) lebt. */
  fxDefaults: Partial<Record<FxKind, Record<string, number>>>;

  /** Per-Kind ADSR-Hüllkurve — wird beim `beginFxHold` in die neu
   *  geschriebene PunchFx eingefroren, parallel zu `fxDefaults`. Wenn ein
   *  Eintrag fehlt, fällt das Bake auf `fxCatalog[kind].defaultEnvelope`
   *  (oder INSTANT_ENVELOPE) zurück. In-memory only — gleiche Persistenz-
   *  Frage wie fxDefaults. */
  fxEnvelopes: Partial<Record<FxKind, ADSREnvelope>>;

  /** Master-audio playback gain. 1.0 = source level (default), 0 = muted,
   *  2.0 = +6 dB. Applied by `useAudioMaster` to the master `<audio>`
   *  element AND baked into the rendered output by `edit.ts`. */
  audioVolume: number;

  // actions
  reset(): void;
  loadJob(
    meta: JobMeta,
    opts?: {
      lastSyncOverrideMs?: number | null;
      clips?: ClipInit[];
      cuts?: Cut[];
      fx?: PunchFx[];
      audioVolume?: number;
    },
  ): void;

  /** Append a single clip to clips[] without resetting any other editor
   *  state. Used by the Editor's "+ Media" flow when addVideoToJob /
   *  addImageToJob lands a fresh asset in the underlying job. */
  addClip(init: ClipInit): void;
  /** Replace a clip in clips[] with a fresh build from the given init.
   *  Used when an asset's sync result fills in *after* it was first
   *  appended (the lane initially shows up without candidates; once
   *  runCamPrep finishes, the candidates / syncOffset arrive and the
   *  clip is re-derived). No-op for unknown camId. */
  updateClip(init: ClipInit): void;
  /** Remove a clip and any cuts that referenced it. Clears the
   *  selectedClipId if it pointed at this cam. No-op for unknown camId. */
  removeClip(camId: string): void;
  /** Record a clip's display (post-rotation) pixel size. Called by the
   *  preview's video / image elements once their natural dims become
   *  available. Feeds the output-frame bounding-box resolver — which
   *  is why we need this in the store, not just per-DOM-element. */
  setClipDisplayDims(camId: string, w: number, h: number): void;

  setCurrentTime(t: number): void;
  setPlaying(playing: boolean): void;
  setLoop(loop: LoopRegion | null): void;
  setAbBypass(bypass: boolean): void;
  seek(t: number): void;
  clearSeekRequest(): void;
  /** Step the playhead by the active snap target:
   *  - off → ±1 frame
   *  - match → next/prev match-position of the selected clip (frame-step fallback)
   *  - 1, 1/2, 1/4, 1/8, 1/16 → ±1 grid tick on the bar/beat grid
   *  Always writes a seekRequest. */
  stepByActiveSnap(direction: 1 | -1): void;
  /** OP-1 style loop-shift: move loop region by its own length without
   *  interrupting playback. The playhead stays where it is; if it ends up
   *  outside the new loop, `pendingWrapAt` is set to the OLD loop.end so
   *  the audio scheduler wraps at the natural play-out point. No-op if no
   *  loop is set or the shifted loop falls entirely outside trim. */
  shiftLoop(direction: 1 | -1): void;
  /** Clear the deferred wrap point (called by useAudioMaster after the
   *  scheduler has reseeked into the new loop region). */
  clearPendingWrap(): void;

  setOffset(ms: number): void;
  nudgeOffset(deltaMs: number): void;

  setTrim(t: TrimRegion): void;

  addOverlay(o: TextOverlay): void;
  updateOverlay(idx: number, patch: Partial<TextOverlay>): void;
  removeOverlay(idx: number): void;

  setVisualizer(v: VisualizerConfig | null): void;
  setExport(patch: Partial<ExportSpec>): void;

  setActivePanel(tab: PanelTab): void;
  setZoom(z: number): void;
  setScrollX(x: number): void;
  setSnapMode(m: SnapMode): void;
  setLanesLocked(locked: boolean): void;
  /** Reset a cam's alignment back to the algorithm's primary candidate:
   *  selectedCandidateIdx=0, syncOverrideMs=0, startOffsetS=0. Used by
   *  the lane-header ↺ button when the user wants to undo their nudges. */
  resetClipAlignment(camId: string): void;
  setBpm(patch: { value: number; manualOverride: boolean; phase?: number; confidence?: number }): void;
  /** Restore bpm to whatever was originally detected by the analysis
   *  (clears manualOverride). No-op if nothing was detected. */
  resetBpmToDetected(): void;
  /** Set the master-audio start nudge in seconds. Affects beat-grid anchor
   *  and audio-start marker; does NOT move audio playback, cams, or any
   *  existing cuts/FX (those stay at their absolute master times). */
  setAudioStartNudgeS(s: number): void;
  /** Increment the master-audio nudge by `deltaMs` (ms; signed). */
  nudgeAudioStartMs(deltaMs: number): void;
  /** Set the time-signature numerator (= beats per bar). Re-runs the
   *  whole-bar grid + bar-line ruler the next render. */
  setBeatsPerBar(n: number): void;
  /** Set the anacrusis / pickup, in beats. Stored modulo `beatsPerBar`
   *  so any value canonicalises into [0, beatsPerBar). */
  setBarOffsetBeats(n: number): void;
  setSelectedCandidateIdx(camId: string, idx: number): void;

  // ---- Multi-cam actions ----
  setSelectedClipId(id: string | null): void;
  setClipSyncOverride(camId: string, ms: number): void;
  nudgeClipSyncOverride(camId: string, deltaMs: number): void;
  setClipStartOffset(camId: string, startOffsetS: number): void;
  /** Set a clip's user-applied rotation in degrees. V1 expects 0/90/180/270;
   *  values are stored as-is (the renderer normalises). */
  setClipRotation(camId: string, deg: number): void;
  /** Toggle / set a clip's horizontal or vertical mirror. */
  setClipFlip(camId: string, axis: "x" | "y", on: boolean): void;
  /** Reset a clip's rotation/flip back to defaults (0° / no flip). */
  resetClipTransform(camId: string): void;
  /** Update a clip's per-element Stage transform (scale + translate).
   *  Partial — undefined fields keep their current value. Creates the
   *  transform from `DEFAULT_VIEWPORT_TRANSFORM` when none is set. */
  setClipViewportTransform(
    camId: string,
    partial: Partial<ViewportTransform>,
  ): void;
  /** Drop a clip's viewport transform → cover-fit default. */
  resetClipViewportTransform(camId: string): void;
  /** Master-audio playback gain. Clamped to [0, 4]. */
  setMasterAudioVolume(v: number): void;
  /** Resize an image clip's duration on the master timeline. Clamped to
   *  a sane minimum so the lane doesn't collapse to invisibility.
   *  No-op for video clips (their length is the source-file length). */
  setImageClipDuration(camId: string, durationS: number): void;
  /** Set per-clip trim for a video clip. Clamped to
   *  [0, sourceDurationS] with a minimum visible window of 0.05 s.
   *  No-op for image clips. */
  setVideoClipTrim(camId: string, trimInS: number, trimOutS: number): void;
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

  /** Build a quantize preview from current cuts/clips/trim against the
   *  active snap-mode. Called on Q-down. Re-call to refresh after the
   *  snap-mode changed during the hold. */
  buildAndStartQuantizePreview(): void;
  /** Commit the active preview into the store (mutates cuts, clips, trim).
   *  Called on Q-up. No-op if no preview is active. */
  commitQuantizePreview(): void;
  /** Drop the active preview without applying. Called on Esc during hold. */
  cancelQuantizePreview(): void;

  // ---- Selectors ----
  totalOffsetMs(): number;
  buildEditSpec(): EditSpec;
  camRanges(): CamRange[];
  activeCamId(t?: number): string | null;
  /** Apply the active snap mode to a master-timeline time. Used by every
   *  cut-set call site (TAKE-button, hotkey, REC) so cuts respect the
   *  same grid as drag-snapping. Returns `t` unchanged in mode "off". */
  snapMasterTime(t: number): number;

  /** Show a transient toast. Reuses the same store slot — multiple pushes
   *  in quick succession overwrite each other. The toast component owns
   *  the timer and clears via dismissNotice. */
  pushNotice(message: string): void;
  /** Clear the active notice. No-op when none is showing. */
  dismissNotice(): void;

  /** Replace the set of cams in background-prep state. The Editor's
   *  job-update handler calls this on every event so the badge tracks
   *  the underlying asset state without leaks. */
  setPreparingCamIds(ids: Iterable<string>): void;

  // ---- Punch-in FX actions ----
  /** Insert a fx and return its id. The caller is responsible for snapping
   *  inS/outS — like every other time-mutating action in this store. */
  addFx(kind: FxKind, inS: number, outS: number, params?: Record<string, number>): string;
  /** Move a fx's in-point. Min-window 0.05 s preserved relative to outS. */
  setFxIn(id: string, inS: number): void;
  /** Move a fx's out-point. Min-window 0.05 s preserved relative to inS. */
  setFxOut(id: string, outS: number): void;
  removeFx(id: string): void;
  /** Drop every persisted FX-capsule. Used by the long-press-clear
   *  gesture on the FX strip. Live recordings (`fxHolds`) are left
   *  untouched — `cancelAllFxHolds()` is the right call for those. */
  clearAllFx(): void;
  /** Begin a live punch-in. Creates a fx with default-tap-length and
   *  records a hold under `slotKey`. `startS` should already be snapped. */
  beginFxHold(slotKey: string, kind: FxKind, startS: number): void;
  /** Live-extend the held fx's out-point. Out only grows — going backward
   *  from a previously-extended position keeps the larger value, so a quick
   *  release after a long hold doesn't shrink the capsule. */
  tickFxHold(slotKey: string, currentS: number): void;
  /** Finalise the hold — leaves the fx in place, drops the hold record. */
  endFxHold(slotKey: string): void;
  /** Revert this slot's hold using its priorFx snapshot. */
  cancelFxHold(slotKey: string): void;
  /** Esc: revert every active hold. Iterates in insertion-order, each
   *  revert applied on top of the prior (so the very first priorFx wins). */
  cancelAllFxHolds(): void;
  /** Punch a small "erase head" through any non-live fx whose range
   *  contains `t` (inS <= t < outS). `kinds` filters which kinds to
   *  affect: "all" hits every kind; an array hits only listed kinds.
   *  Splits / trims / drops as needed. Live (currently-held) fx are
   *  never touched here — call endFxHold first if you want to abort
   *  a live recording. */
  eraseFxAt(t: number, kinds: FxKind[] | "all"): void;

  /** Switch which FxKind the panel's encoders are editing. Called from
   *  pad-press handlers (mouse + keyboard) — the recording head moves
   *  with whatever you just punched. */
  setSelectedFxKind(kind: FxKind): void;

  /** Set the encoder default for `paramId` of `kind` (storage-range —
   *  the encoder's display 0..100 is mapped against the param's
   *  min/max in catalog). Called from the encoder's drag handler. */
  setFxDefault(kind: FxKind, paramId: string, value: number): void;

  /** Patch the ADSR envelope default for `kind` — partial update so the
   *  ADSR-Editor can drag a single point without re-sending the whole
   *  envelope. Missing fields keep their prior value. */
  setFxEnvelope(kind: FxKind, partial: Partial<ADSREnvelope>): void;
  /** Reset envelope for `kind` back to the catalog's defaultEnvelope
   *  (or INSTANT_ENVELOPE if none). Used by double-click on ADSR knots. */
  resetFxEnvelope(kind: FxKind): void;

  setProgramStripMode(mode: UiSlice["programStripMode"]): void;
  setFxPanelOpen(open: boolean): void;
  /** Update the X-hold-to-clear progress (0..1, or null to clear).
   *  Editor.tsx writes this from a RAF timer while X is held during
   *  pause; ProgramStrip mirrors it onto whichever lanes are visible. */
  setXClearProgress(progress: number | null): void;
}

const TRIM_EPS = 0.05; // seconds — minimum trim window length

const initialPlayback: PlaybackSlice = {
  currentTime: 0,
  isPlaying: false,
  loop: null,
  seekRequest: null,
  pendingWrapAt: null,
};

const initialOffset: OffsetSlice = {
  userOverrideMs: 0,
  abBypass: false,
};

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

const FX_MIN_WINDOW_S = 0.05;
/** Buffer pushed past the playhead during a live hold. Keeps `t < outS`
 *  true across RAF jitter and snap-quantization gaps. ~3 frames at 60Hz. */
const FX_HOLD_OVERSHOOT_S = 0.05;
/** Width of the "erase head" punch-through. ~150 ms so a brief X-tap
 *  leaves a clearly visible gap, and consecutive frames of an X-hold at
 *  the same paused playhead don't collapse to a no-op (a 1-frame head
 *  trims the fx by 1 frame on first tick, then the snapped t falls
 *  outside the trimmed fx and nothing else happens). 150 ms is wide
 *  enough to read on the tape strip without obliterating neighbours. */
const FX_ERASE_DELTA_S = 0.15;

/** Apply the tape-overwrite pre-filter to `fx` for a write into
 *  `[rangeStartS, rangeEndS)` of kind `kind`. Live fx (ids in
 *  `liveIds`) are protected and pass through untouched. Any other fx of
 *  the same kind that overlaps the range is trimmed to the part(s)
 *  outside the range; if degenerate (< FX_MIN_WINDOW_S) it's dropped.
 *
 *  Pure helper so we can call it from both beginFxHold (range starts at
 *  startS, end is the default-tap commit) and tickFxHold (range grows
 *  with the playhead). */
function clobberSameKindOverlapping(
  fx: readonly PunchFx[],
  kind: FxKind,
  rangeStartS: number,
  rangeEndS: number,
  liveIds: ReadonlySet<string>,
): readonly PunchFx[] {
  if (rangeEndS <= rangeStartS) return fx;
  // Fast path: scan once, detect whether ANY non-live same-kind fx
  // overlaps the range. If none does, the result is reference-identical
  // to `fx` — we can skip allocating + set()ing entirely. This matters
  // for `tickFxHold`, which calls us at 60 Hz while F is held; the
  // common case (held FX growing into virgin tape) has no overlaps.
  let needsChange = false;
  for (const f of fx) {
    if (f.kind !== kind || liveIds.has(f.id)) continue;
    if (f.outS <= rangeStartS || f.inS >= rangeEndS) continue;
    needsChange = true;
    break;
  }
  if (!needsChange) return fx;
  const out: PunchFx[] = [];
  for (const f of fx) {
    if (f.kind !== kind || liveIds.has(f.id)) {
      out.push(f);
      continue;
    }
    // No overlap → keep.
    if (f.outS <= rangeStartS || f.inS >= rangeEndS) {
      out.push(f);
      continue;
    }
    // Fully inside → drop.
    if (f.inS >= rangeStartS && f.outS <= rangeEndS) {
      continue;
    }
    // Overlaps the front edge: trim back end.
    if (f.inS < rangeStartS && f.outS <= rangeEndS) {
      const trimmed: PunchFx = { ...f, outS: rangeStartS };
      if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) out.push(trimmed);
      continue;
    }
    // Overlaps the back edge: trim front start.
    if (f.inS >= rangeStartS && f.outS > rangeEndS) {
      const trimmed: PunchFx = { ...f, inS: rangeEndS };
      if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) out.push(trimmed);
      continue;
    }
    // Range strictly inside f → split into two pieces.
    const left: PunchFx = { ...f, outS: rangeStartS };
    const right: PunchFx = { ...f, id: makeFxId(), inS: rangeEndS };
    if (left.outS - left.inS >= FX_MIN_WINDOW_S) out.push(left);
    if (right.outS - right.inS >= FX_MIN_WINDOW_S) out.push(right);
  }
  return out;
}

function makeFxId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fx-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** True if `camId` has material at master-timeline time `t`. */
function camHasMaterialAt(
  camId: string,
  t: number,
  ranges: readonly CamRange[],
): boolean {
  const r = ranges.find((x) => x.id === camId);
  return !!r && t >= r.startS && t < r.endS;
}

function buildClips(inits: ClipInit[] | undefined, fallbackOverrideMs: number): Clip[] {
  if (!inits || inits.length === 0) return [];
  return inits.map((init, i): Clip => {
    if (init.kind === "image") {
      return {
        kind: "image",
        id: init.id,
        filename: init.filename,
        color: init.color,
        durationS: init.durationS,
        startOffsetS: init.startOffsetS ?? 0,
        rotation: init.rotation ?? 0,
        flipX: init.flipX ?? false,
        flipY: init.flipY ?? false,
        viewportTransform: init.viewportTransform,
      };
    }
    const candidates = init.candidates ?? [];
    const selectedIdx = Math.max(
      0,
      Math.min(init.selectedCandidateIdx ?? 0, Math.max(0, candidates.length - 1)),
    );
    // syncOffsetMs mirrors the active candidate when present, otherwise
    // falls back to whatever the caller passed (legacy single-offset path).
    const syncOffsetMs = candidates.length > 0
      ? candidates[selectedIdx].offsetMs
      : init.syncOffsetMs;
    return {
      kind: "video",
      id: init.id,
      filename: init.filename,
      color: init.color,
      sourceDurationS: init.sourceDurationS,
      syncOffsetMs,
      syncOverrideMs:
        init.syncOverrideMs ?? (i === 0 ? fallbackOverrideMs : 0),
      startOffsetS: init.startOffsetS ?? 0,
      driftRatio: init.driftRatio ?? 1,
      candidates,
      selectedCandidateIdx: selectedIdx,
      trimInS: Math.max(0, init.trimInS ?? 0),
      trimOutS: Math.max(
        (init.trimInS ?? 0) + 0.05,
        init.trimOutS ?? init.sourceDurationS,
      ),
      rotation: init.rotation ?? 0,
      flipX: init.flipX ?? false,
      flipY: init.flipY ?? false,
      viewportTransform: init.viewportTransform,
    };
  });
}

/**
 * Single-slot memoizer for `camRanges`. The result is a pure function of
 * the `clips` array, but `clips` only changes when the project is loaded
 * or edited (rare) — vs `cuts`/`fx` which change on every keypress.
 * Caching on the array reference means rapid `addCut` / `addFx` calls
 * don't re-walk all clips to recompute the range list every time.
 *
 * WeakMap keeps the cache GC-clean: when a `clips` array is dropped the
 * cached ranges go with it.
 */
const camRangesCache = new WeakMap<readonly Clip[], CamRange[]>();
function computeCamRanges(clips: readonly Clip[]): CamRange[] {
  const cached = camRangesCache.get(clips);
  if (cached !== undefined) return cached;
  const ranges = clips.map((c) => {
    const range = clipRangeS(c);
    return { id: c.id, startS: range.startS, endS: range.endS };
  });
  camRangesCache.set(clips, ranges);
  return ranges;
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

export const useEditorStore = create<EditorState>()(
  subscribeWithSelector((set, get) => ({
    jobMeta: null,
    playback: initialPlayback,
    offset: initialOffset,
    trim: { in: 0, out: 0 },
    overlays: [],
    visualizer: null,
    exportSpec: DEFAULT_EXPORT,
    ui: initialUi,
    clips: [],
    cuts: [],
    selectedClipId: null,
    holdGesture: null,
    quantizePreview: null,
    notice: null,
    preparingCamIds: new Set<string>(),
    fx: [],
    fxHolds: {},
    selectedFxKind: "vignette",
    fxDefaults: {},
    fxEnvelopes: {},
    audioVolume: 1.0,

    reset() {
      set({
        jobMeta: null,
        playback: initialPlayback,
        offset: initialOffset,
        trim: { in: 0, out: 0 },
        overlays: [],
        visualizer: null,
        exportSpec: DEFAULT_EXPORT,
        ui: initialUi,
        clips: [],
        cuts: [],
        selectedClipId: null,
        holdGesture: null,
        quantizePreview: null,
        notice: null,
        preparingCamIds: new Set<string>(),
        fx: [],
        fxHolds: {},
        selectedFxKind: "vignette",
        fxDefaults: {},
        fxEnvelopes: {},
        audioVolume: 1.0,
      });
    },

    loadJob(meta, opts) {
      const fallbackOverride = opts?.lastSyncOverrideMs ?? 0;
      const clips = buildClips(opts?.clips, fallbackOverride);
      // Mirror cam-1's override into the legacy offset slice so existing
      // OffsetScheduler / SyncTuner consumers see the same number. Image
      // cams have no sync, so fall back to the caller's override hint.
      const cam1 = clips[0];
      const legacyOverrideMs =
        cam1 && isVideoClip(cam1)
          ? cam1.syncOverrideMs
          : fallbackOverride;
      // Auto-select the only cam if there's just one — bequem für Single-Video-Use.
      const selectedClipId = clips.length === 1 ? clips[0].id : null;
      // Normalize bpm/beats/downbeats so consumers can rely on null vs. value
      // instead of having to handle undefined.
      // If the caller didn't pass detectedBpm but did pass an
      // auto-detected bpm (manualOverride === false), treat that as the
      // detected reference. Lets simple test/loader call sites get away
      // with one field instead of two.
      const detectedFallback =
        meta.detectedBpm !== undefined
          ? meta.detectedBpm
          : meta.bpm && !meta.bpm.manualOverride
            ? meta.bpm
            : null;
      const normalizedMeta: JobMeta = {
        ...meta,
        bpm: meta.bpm ?? null,
        detectedBpm: detectedFallback,
        beats: meta.beats ?? [],
        downbeats: meta.downbeats ?? [],
      };
      set({
        jobMeta: normalizedMeta,
        playback: initialPlayback,
        offset: {
          userOverrideMs: legacyOverrideMs,
          abBypass: false,
        },
        trim: { in: 0, out: meta.duration },
        overlays: [],
        visualizer: null,
        exportSpec: DEFAULT_EXPORT,
        ui: initialUi,
        clips,
        cuts: opts?.cuts ?? [],
        selectedClipId,
        fx: opts?.fx ?? [],
        fxHolds: {},
        selectedFxKind: "vignette",
        fxDefaults: {},
        fxEnvelopes: {},
        audioVolume:
          typeof opts?.audioVolume === "number" && opts.audioVolume >= 0
            ? Math.min(4, opts.audioVolume)
            : 1.0,
      });
    },

    addClip(init) {
      const existing = get().clips;
      // No-op if a clip with this id is already in the store — the
      // Editor's job-event subscriber may fire repeatedly with the same
      // asset before sync results arrive.
      if (existing.some((c) => c.id === init.id)) return;
      const [built] = buildClips([init], 0);
      if (!built) return;
      set({ clips: [...existing, built] });
    },

    updateClip(init) {
      const existing = get().clips;
      const idx = existing.findIndex((c) => c.id === init.id);
      if (idx < 0) return;
      const [rebuilt] = buildClips([init], 0);
      if (!rebuilt) return;
      // Preserve the user's drag-on-timeline offset and (for video) any
      // syncOverrideMs / selectedCandidateIdx / rotation / flip they've
      // already applied. A re-derive from sync results must not nuke
      // those user edits.
      const cur = existing[idx];
      let merged: typeof rebuilt = rebuilt;
      if (rebuilt.kind !== "image" && cur.kind !== "image") {
        merged = {
          ...rebuilt,
          syncOverrideMs: cur.syncOverrideMs,
          startOffsetS: cur.startOffsetS,
          selectedCandidateIdx: cur.selectedCandidateIdx,
          rotation: cur.rotation,
          flipX: cur.flipX,
          flipY: cur.flipY,
          displayW: cur.displayW,
          displayH: cur.displayH,
        };
      } else if (rebuilt.kind === "image" && cur.kind === "image") {
        merged = {
          ...rebuilt,
          startOffsetS: cur.startOffsetS,
          rotation: cur.rotation,
          flipX: cur.flipX,
          flipY: cur.flipY,
          displayW: cur.displayW,
          displayH: cur.displayH,
        };
      }
      const next = existing.slice();
      next[idx] = merged;
      set({ clips: next });
    },

    removeClip(camId) {
      const state = get();
      const idx = state.clips.findIndex((c) => c.id === camId);
      if (idx < 0) return;
      set({
        clips: state.clips.filter((c) => c.id !== camId),
        cuts: state.cuts.filter((c) => c.camId !== camId),
        selectedClipId:
          state.selectedClipId === camId ? null : state.selectedClipId,
      });
    },

    setClipDisplayDims(camId, w, h) {
      if (w <= 0 || h <= 0) return;
      const state = get();
      const clips = state.clips;
      const idx = clips.findIndex((c) => c.id === camId);
      if (idx < 0) return;
      const cur = clips[idx];
      if (cur.displayW === w && cur.displayH === h) return;
      const next = clips.slice();
      next[idx] = { ...cur, displayW: w, displayH: h };

      // Auto-init the Stage from the FIRST clip (by timeline order) that
      // reports its dims, while the user has not yet picked a resolution.
      // Once any concrete resolution is set, this stops firing.
      let nextExport: ExportSpec | null = null;
      const spec = state.exportSpec;
      const noUserResolution =
        spec.resolution === undefined || spec.resolution === "source";
      if (noUserResolution) {
        const firstClip = [...next].sort(
          (a, b) => clipRangeS(a).startS - clipRangeS(b).startS,
        )[0];
        const firstDims =
          firstClip != null ? clipEffectiveDisplayDims(firstClip) : undefined;
        if (firstDims) {
          const aspect = classifyAspectRatio(firstDims);
          nextExport = {
            ...spec,
            resolution: { w: firstDims.w, h: firstDims.h },
            aspectRatio: aspect,
            resolutionLongSide: Math.max(firstDims.w, firstDims.h),
          };
        }
      }

      set(nextExport ? { clips: next, exportSpec: nextExport } : { clips: next });
    },

    setCurrentTime(t) {
      set({ playback: { ...get().playback, currentTime: t } });
    },
    setPlaying(playing) {
      const s = get();
      if (s.playback.isPlaying === playing) return;
      // Latched preview holds (created via pad-click while paused) only
      // make sense while the playhead is frozen. The moment playback
      // starts, drop them — otherwise the descriptor would synthesise a
      // transient FX every frame on top of any persistent recording.
      let nextHolds = s.fxHolds;
      if (playing) {
        let dropped = false;
        const filtered: Record<string, FxHoldEntry> = {};
        for (const [slot, h] of Object.entries(s.fxHolds)) {
          if (h.mode === "preview") {
            dropped = true;
            continue;
          }
          filtered[slot] = h;
        }
        if (dropped) nextHolds = filtered;
      }
      set({
        playback: { ...s.playback, isPlaying: playing },
        fxHolds: nextHolds,
      });
    },
    setLoop(loop) {
      const { trim } = get();
      const clamped = loop ? clampLoopRegion(loop, trim) : null;
      set({
        playback: { ...get().playback, loop: clamped, pendingWrapAt: null },
      });
    },
    setAbBypass(bypass) {
      set({ offset: { ...get().offset, abBypass: bypass } });
    },
    seek(t) {
      const meta = get().jobMeta;
      const dur = meta?.duration ?? Infinity;
      const clamped = Math.max(0, Math.min(t, dur));
      set({
        playback: {
          ...get().playback,
          currentTime: clamped,
          seekRequest: clamped,
          // A user-initiated seek overrides any deferred loop-shift wrap —
          // the user's intent is to be at `t`, not at the OP-1 wrap point.
          pendingWrapAt: null,
        },
      });
    },
    clearSeekRequest() {
      set({ playback: { ...get().playback, seekRequest: null } });
    },
    stepByActiveSnap(direction) {
      const s = get();
      const t = s.playback.currentTime;
      const fps = s.jobMeta?.fps && s.jobMeta.fps > 0 ? s.jobMeta.fps : 30;
      const frameStep = () => s.seek(t + direction * (1 / fps));
      const mode = s.ui.snapMode;

      if (mode === "off") return frameStep();

      if (mode === "match") {
        const clip = s.clips.find((c) => c.id === s.selectedClipId);
        if (clip && isVideoClip(clip) && clip.candidates?.length) {
          const positions = buildClipMatchPositions(clip)
            .map((p) => p.startS)
            .sort((a, b) => a - b);
          const eps = 1e-6;
          const target =
            direction > 0
              ? positions.find((p) => p > t + eps)
              : [...positions].reverse().find((p) => p < t - eps);
          if (target !== undefined) {
            s.seek(target);
            return;
          }
        }
        return frameStep();
      }

      const bpm = s.jobMeta?.bpm?.value ?? null;
      const beatsPerBar = effectiveBeatsPerBar(s.jobMeta);
      const step = gridStepSeconds(mode, bpm, beatsPerBar);
      if (step === null || step <= 0) return frameStep();

      // Probe slightly into the desired direction so snapTime rounds the
      // correct way (snapTime always picks the nearest tick — without the
      // probe, t already on a tick would round to itself).
      const probe = t + direction * step * 0.5;
      const candidate = snapTime(probe, mode, {
        bpm,
        beatPhase: effectiveBeatPhaseS(s.jobMeta),
        beatsPerBar,
        barOffsetBeats: effectiveBarOffsetBeats(s.jobMeta),
      });
      // FP tolerance only — used to absorb snapTime's
      // round-half-toward-+∞ asymmetry on negative half-tick probes.
      // NOT a "near a snap" widener: a larger eps would falsely double
      // the step when the user's playhead happens to land within ±N ms
      // of a snap (e.g. via audio-mirror seek precision).
      const eps = step * 1e-9;
      let target = candidate;
      if (Math.abs(target - t) < eps) target = candidate + direction * step;
      s.seek(target);
    },
    shiftLoop(direction) {
      const s = get();
      const loop = s.playback.loop;
      if (!loop) return;

      const len = loop.end - loop.start;
      const newLoop: LoopRegion = {
        start: loop.start + direction * len,
        end: loop.end + direction * len,
      };
      const clamped = clampLoopRegion(newLoop, s.trim);
      if (!clamped) return;

      const t = s.playback.currentTime;
      // Defer the wrap to the OLD loop end whenever the playhead is OUTSIDE
      // the new loop region. Forward-shift while playing: t is in the old
      // loop, before the new loop's start → wrap at old loop.end. Backward-
      // shift while playing: t is past the new loop's end → still wrap at
      // old loop.end (the playhead reaches it as it advances forward).
      const insideNew = t >= clamped.start && t < clamped.end;
      const pendingWrapAt = insideNew ? null : loop.end;

      set({
        playback: { ...s.playback, loop: clamped, pendingWrapAt },
      });
    },
    clearPendingWrap() {
      const cur = get().playback.pendingWrapAt;
      if (cur == null) return;
      set({ playback: { ...get().playback, pendingWrapAt: null } });
    },

    setOffset(ms) {
      // Backward-shim: also writes through to cam-1's override, so the
      // multi-cam clips slice and the legacy offset slice stay in sync.
      set({ offset: { ...get().offset, userOverrideMs: ms } });
      const clips = get().clips;
      if (clips.length > 0) {
        const next = clips.map((c, i) =>
          i === 0 ? { ...c, syncOverrideMs: ms } : c,
        );
        set({ clips: next });
      }
    },
    nudgeOffset(deltaMs) {
      const cur = get().offset.userOverrideMs;
      // Round to 1 ms for the integer-step nudges, but allow callers to pass
      // sub-ms for the knob (we'll add that later).
      const next = Math.round((cur + deltaMs) * 1000) / 1000;
      set({ offset: { ...get().offset, userOverrideMs: next } });
      const clips = get().clips;
      if (clips.length > 0) {
        const updated = clips.map((c, i) =>
          i === 0 ? { ...c, syncOverrideMs: next } : c,
        );
        set({ clips: updated });
      }
    },

    setTrim(t) {
      const meta = get().jobMeta;
      const dur = meta?.duration ?? Infinity;
      let { in: tin, out: tout } = t;
      tin = Math.max(0, Math.min(tin, dur));
      tout = Math.max(0, Math.min(tout, dur));
      if (tout - tin < TRIM_EPS) {
        // degenerate: keep tout fixed, push tin back
        tin = Math.max(0, tout - TRIM_EPS);
      }
      set({ trim: { in: tin, out: tout } });
      // Re-clamp loop to new trim
      const loop = get().playback.loop;
      if (loop) {
        const clamped = clampLoopRegion(loop, { in: tin, out: tout });
        set({ playback: { ...get().playback, loop: clamped } });
      }
    },

    addOverlay(o) {
      set({ overlays: [...get().overlays, o] });
    },
    updateOverlay(idx, patch) {
      set({
        overlays: get().overlays.map((o, i) =>
          i === idx ? { ...o, ...patch } : o,
        ),
      });
    },
    removeOverlay(idx) {
      set({ overlays: get().overlays.filter((_, i) => i !== idx) });
    },

    setVisualizer(v) {
      set({ visualizer: v });
    },
    setExport(patch) {
      set({ exportSpec: { ...get().exportSpec, ...patch } });
    },

    setActivePanel(tab) {
      set({ ui: { ...get().ui, activePanel: tab } });
    },
    setZoom(z) {
      set({ ui: { ...get().ui, zoom: Math.max(1, Math.min(64, z)) } });
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
    resetClipAlignment(camId) {
      const clips = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        // Image clips have no sync alignment — only their startOffsetS.
        if (!isVideoClip(c)) {
          return { ...c, startOffsetS: 0 };
        }
        const primary = c.candidates[0];
        return {
          ...c,
          syncOverrideMs: 0,
          startOffsetS: 0,
          selectedCandidateIdx: 0,
          syncOffsetMs: primary?.offsetMs ?? c.syncOffsetMs,
        };
      });
      set({ clips });
      // Mirror cam-1 into the legacy offset slice (SyncTuner).
      if (clips[0]?.id === camId) {
        set({ offset: { ...get().offset, userOverrideMs: 0 } });
      }
    },
    setBpm(patch) {
      const meta = get().jobMeta;
      if (!meta) return;
      const cur = meta.bpm ?? null;
      const next: BpmInfo = {
        value: patch.value,
        confidence: patch.confidence ?? cur?.confidence ?? 0,
        phase: patch.phase ?? cur?.phase ?? 0,
        manualOverride: patch.manualOverride,
      };
      set({ jobMeta: { ...meta, bpm: next } });
    },
    resetBpmToDetected() {
      const meta = get().jobMeta;
      if (!meta?.detectedBpm) return;
      set({
        jobMeta: {
          ...meta,
          bpm: { ...meta.detectedBpm, manualOverride: false },
        },
      });
    },
    setAudioStartNudgeS(s) {
      const meta = get().jobMeta;
      if (!meta) return;
      // Round to ms-precision so persisted state matches the UI's ms display.
      const rounded = Math.round(s * 1000) / 1000;
      set({ jobMeta: { ...meta, audioStartNudgeS: rounded } });
    },
    nudgeAudioStartMs(deltaMs) {
      const meta = get().jobMeta;
      if (!meta) return;
      const cur = meta.audioStartNudgeS ?? 0;
      get().setAudioStartNudgeS(cur + deltaMs / 1000);
    },
    setBeatsPerBar(n) {
      const meta = get().jobMeta;
      if (!meta) return;
      // Clamp to a sensible band — the picker only offers integers in
      // [2, 12], but a defensive guard here keeps a stale persisted value
      // from breaking the grid math.
      const safe = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
      // Re-canonicalise the existing pickup against the new bar length
      // so the UI doesn't suddenly point at a phantom pickup beat.
      const offRaw = meta.barOffsetBeats ?? 0;
      const off = ((Math.floor(offRaw) % safe) + safe) % safe;
      set({
        jobMeta: { ...meta, beatsPerBar: safe, barOffsetBeats: off },
      });
    },
    setBarOffsetBeats(n) {
      const meta = get().jobMeta;
      if (!meta) return;
      const bpb =
        meta.beatsPerBar && meta.beatsPerBar >= 1 ? meta.beatsPerBar : 4;
      const safe = Number.isFinite(n) ? Math.floor(n) : 0;
      const off = ((safe % bpb) + bpb) % bpb;
      set({ jobMeta: { ...meta, barOffsetBeats: off } });
    },
    setSelectedCandidateIdx(camId, idx) {
      const clips = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        if (!isVideoClip(c)) return c; // image clips have no candidates
        const max = Math.max(0, c.candidates.length - 1);
        const clamped = Math.max(0, Math.min(idx, max));
        const newOffset = c.candidates[clamped]?.offsetMs ?? c.syncOffsetMs;
        return { ...c, selectedCandidateIdx: clamped, syncOffsetMs: newOffset };
      });
      set({ clips });
    },

    setSelectedClipId(id) {
      const state = get();
      // Auto-downgrade: if the user moves selection onto a clip with no
      // match candidates while snap-mode is "match", silently switch to a
      // beat-grid mode and surface a one-shot toast. The match-button is
      // also visually disabled by SnapModeButtons so this only triggers
      // when the user e.g. hotkey-jumps between cams.
      if (id !== null && state.ui.snapMode === "match") {
        const target = state.clips.find((c) => c.id === id);
        const noCandidates =
          !!target &&
          (!isVideoClip(target) || target.candidates.length === 0);
        if (noCandidates) {
          set({
            selectedClipId: id,
            ui: { ...state.ui, snapMode: "1" },
            notice: {
              message: "No match candidates — beat snap",
              key: state.notice ? state.notice.key + 1 : 1,
            },
          });
          return;
        }
      }
      set({ selectedClipId: id });
    },
    setClipSyncOverride(camId, ms) {
      const clips = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        if (!isVideoClip(c)) return c; // images have no sync override
        return { ...c, syncOverrideMs: ms };
      });
      set({ clips });
      // Mirror cam-1 changes into legacy offset slice (SyncTuner).
      const cam1 = clips[0];
      if (cam1 && cam1.id === camId && isVideoClip(cam1)) {
        set({ offset: { ...get().offset, userOverrideMs: ms } });
      }
    },
    nudgeClipSyncOverride(camId, deltaMs) {
      const found = get().clips.find((c) => c.id === camId);
      if (!found || !isVideoClip(found)) return;
      const next = Math.round((found.syncOverrideMs + deltaMs) * 1000) / 1000;
      get().setClipSyncOverride(camId, next);
    },
    setImageClipDuration(camId, durationS) {
      const next = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        if (c.kind !== "image") return c;
        // Hard min so the pill never collapses to an unhittable sliver.
        const clamped = Math.max(0.1, durationS);
        return { ...c, durationS: clamped };
      });
      set({ clips: next });
    },

    setVideoClipTrim(camId, trimInS, trimOutS) {
      const next = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        if (!isVideoClip(c)) return c;
        const minWindow = 0.05;
        const inS = Math.max(
          0,
          Math.min(c.sourceDurationS - minWindow, trimInS),
        );
        const outS = Math.max(
          inS + minWindow,
          Math.min(c.sourceDurationS, trimOutS),
        );
        return { ...c, trimInS: inS, trimOutS: outS };
      });
      set({ clips: next });
    },

    setClipStartOffset(camId, startOffsetS) {
      const clips = get().clips.map((c) =>
        c.id === camId ? { ...c, startOffsetS } : c,
      );
      set({ clips });
    },
    setClipRotation(camId, deg) {
      const clips = get().clips.map((c): Clip =>
        c.id === camId ? { ...c, rotation: deg } : c,
      );
      set({ clips });
    },
    setClipFlip(camId, axis, on) {
      const key = axis === "x" ? "flipX" : "flipY";
      const clips = get().clips.map((c): Clip =>
        c.id === camId ? { ...c, [key]: on } : c,
      );
      set({ clips });
    },
    resetClipTransform(camId) {
      const clips = get().clips.map((c): Clip =>
        c.id === camId ? { ...c, rotation: 0, flipX: false, flipY: false } : c,
      );
      set({ clips });
    },
    setClipViewportTransform(camId, partial) {
      const clips = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        const cur: ViewportTransform =
          c.viewportTransform ?? DEFAULT_VIEWPORT_TRANSFORM;
        const merged: ViewportTransform = {
          scale: partial.scale ?? cur.scale,
          x: partial.x ?? cur.x,
          y: partial.y ?? cur.y,
        };
        return { ...c, viewportTransform: merged };
      });
      set({ clips });
    },
    resetClipViewportTransform(camId) {
      const clips = get().clips.map((c): Clip => {
        if (c.id !== camId) return c;
        const { viewportTransform: _drop, ...rest } = c;
        void _drop;
        return rest as Clip;
      });
      set({ clips });
    },
    setMasterAudioVolume(v) {
      const clamped = Math.max(0, Math.min(4, v));
      set({ audioVolume: clamped });
    },
    addCut(cut) {
      // Compute ranges once (memoized on the clips array reference, so
      // back-to-back addCut calls share the same range list) and reuse
      // for both no-op guards instead of recomputing twice.
      const s = get();
      const ranges = computeCamRanges(s.clips);

      // No-op guard #1: if the cam is already active at this time (via a
      // prior cut or default-fallback), inserting another marker to the
      // same cam is redundant.
      const currentActive = activeCamAt(s.cuts, cut.atTimeS, ranges);
      if (currentActive === cut.camId) return false;

      // No-op guard #2: if the target cam has NO material at this time,
      // adding the cut wouldn't change anything — activeCamAt would still
      // fall back to whatever cam has material here. This is the "single-
      // video area" case: in a region only cam-2 covers, hitting TAKE on
      // cam-1 used to deposit a marker that did nothing.
      const target = ranges.find((r) => r.id === cut.camId);
      if (
        !target ||
        cut.atTimeS < target.startS ||
        cut.atTimeS >= target.endS
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
      // Clamp to the duration window so a drag can't push a cut past
      // the end of the master timeline.
      const dur = get().jobMeta?.duration ?? Infinity;
      const clamped = Math.max(0, Math.min(dur, toAtTimeS));
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
      const cuts = get().cuts;
      // Drop every cut inside [lo, hi] — the held cam painted over them.
      let next = cuts.filter((c) => c.atTimeS < lo || c.atTimeS > hi);
      const ranges = get().clips.map((c) => {
        const r = clipRangeS(c);
        return { id: c.id, startS: r.startS, endS: r.endS };
      });
      const activeAtLo = activeCamAt(next, lo, ranges);
      // Same guard as addCut: only emit the in-marker when the held cam
      // actually has material at lo. Otherwise the marker is visually
      // inert (activeCamAt falls back to whoever else covers the spot).
      if (activeAtLo !== camId && camHasMaterialAt(camId, lo, ranges)) {
        next = [...next, { atTimeS: lo, camId }].sort(
          (a, b) => a.atTimeS - b.atTimeS,
        );
      }
      set({ cuts: next });
    },
    applyHoldRelease(camId: string, fromS: number, toS: number, priorCuts: Cut[]) {
      const lo = Math.min(fromS, toS);
      const hi = Math.max(fromS, toS);
      const ranges = get().clips.map((c) => {
        const r = clipRangeS(c);
        return { id: c.id, startS: r.startS, endS: r.endS };
      });
      // What WOULD have been on PROGRAM at the release moment if we hadn't
      // painted? That's the cam we want to resume to (unless it's the cam
      // we were holding, in which case the hold was redundant and no
      // trailing cut is needed).
      const prevActiveAtRelease = activeCamAt(priorCuts, hi, ranges);

      // Paint: drop cuts in [lo, hi], insert lead cut if camId wasn't
      // already active at lo AND it actually has material there.
      let next: Cut[] = priorCuts.filter((c) => c.atTimeS < lo || c.atTimeS > hi);
      const activeAtLo = activeCamAt(next, lo, ranges);
      if (activeAtLo !== camId && camHasMaterialAt(camId, lo, ranges)) {
        next.push({ atTimeS: lo, camId });
      }

      // Trailing resume cut at hi — only if the original would have shown
      // a different cam there. activeCamAt only returns a cam that has
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
    buildAndStartQuantizePreview() {
      const s = get();
      // Quantize is sync-aligned (snaps cut times to beat grid). Image
      // clips don't participate — feed only video clips to the helper.
      const videoClips = s.clips.filter(isVideoClip);
      const preview = buildQuantizePreview(
        { cuts: s.cuts, clips: videoClips, trim: s.trim, fx: s.fx },
        s.ui.snapMode,
        {
          bpm: s.jobMeta?.bpm?.value ?? null,
          beatPhase: effectiveBeatPhaseS(s.jobMeta),
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

      // Apply clip start-offsets.
      const nextClips = get().clips.map((c) => {
        const change = preview.clipStartOffsets.find((p) => p.camId === c.id);
        return change ? { ...c, startOffsetS: change.to } : c;
      });

      // Apply trim.
      const nextTrim = preview.trim ? preview.trim.to : get().trim;

      // Apply fx in/out snaps.
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
        clips: nextClips,
        trim: nextTrim,
        fx: nextFx,
        quantizePreview: null,
      });
    },
    cancelQuantizePreview() {
      set({ quantizePreview: null });
    },

    totalOffsetMs() {
      // Read the current cam-0 sync from the clips array so that MATCH
      // mode candidate switches (which mutate clips[0].syncOffsetMs) and
      // drag re-syncs (which mutate clips[0].syncOverrideMs) both flow
      // through to the audio scheduler. jobMeta.algoOffsetMs is now a
      // historical field, kept only as a fallback when clips are empty.
      // If cam-0 is an image (no sync), fall back to legacy fields.
      const { clips, jobMeta, offset } = get();
      const cam0 = clips[0];
      if (cam0 && isVideoClip(cam0)) {
        const algo = cam0.syncOffsetMs ?? jobMeta?.algoOffsetMs ?? 0;
        const override = cam0.syncOverrideMs ?? offset.userOverrideMs;
        return offset.abBypass ? algo : algo + override;
      }
      const algo = jobMeta?.algoOffsetMs ?? 0;
      const override = offset.userOverrideMs;
      return offset.abBypass ? algo : algo + override;
    },

    buildEditSpec() {
      const s = get();
      return {
        version: 1,
        segments: [{ in: s.trim.in, out: s.trim.out }],
        overlays: s.overlays,
        visualizer: s.visualizer,
        sync_override_ms: s.offset.userOverrideMs,
        export: s.exportSpec,
      };
    },

    camRanges() {
      return computeCamRanges(get().clips);
    },
    activeCamId(t) {
      const s = get();
      const time = t ?? s.playback.currentTime;
      return activeCamAt(s.cuts, time, computeCamRanges(s.clips));
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

    pushNotice(message) {
      const cur = get().notice;
      set({ notice: { message, key: cur ? cur.key + 1 : 1 } });
    },
    dismissNotice() {
      set({ notice: null });
    },

    setPreparingCamIds(ids) {
      const next = new Set(ids);
      const cur = get().preparingCamIds;
      // Avoid the set-state churn when the membership didn't actually
      // change — keeps the LaneHeader from re-rendering on every event.
      if (next.size === cur.size) {
        let same = true;
        for (const id of next) {
          if (!cur.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      set({ preparingCamIds: next });
    },

    // ---- Punch-in FX ----
    addFx(kind, inS, outS, params) {
      const id = makeFxId();
      // Enforce min-window so a tap or quick drag never produces a sliver
      // capsule that the user can't grab again.
      const safeOut = Math.max(outS, inS + FX_MIN_WINDOW_S);
      const fx: PunchFx = params
        ? { id, kind, inS, outS: safeOut, params }
        : { id, kind, inS, outS: safeOut };
      set({ fx: [...get().fx, fx] });
      return id;
    },
    setFxIn(id, inS) {
      const next = get().fx.map((f) => {
        if (f.id !== id) return f;
        // Clamp so inS stays at most outS - min-window. If the user pushes
        // past that, the fx collapses to its minimum width anchored at outS.
        const clampedIn = Math.min(inS, f.outS - FX_MIN_WINDOW_S);
        return { ...f, inS: clampedIn };
      });
      set({ fx: next });
    },
    setFxOut(id, outS) {
      const next = get().fx.map((f) => {
        if (f.id !== id) return f;
        // Symmetric clamp: outS at least inS + min-window.
        const clampedOut = Math.max(outS, f.inS + FX_MIN_WINDOW_S);
        return { ...f, outS: clampedOut };
      });
      set({ fx: next });
    },
    removeFx(id) {
      set({ fx: get().fx.filter((f) => f.id !== id) });
    },
    clearAllFx() {
      // Don't touch live recordings — they're owned by `fxHolds` and
      // need to flow through cancelAllFxHolds() if the caller wants to
      // also abort in-flight punches.
      const liveIds = new Set<string>();
      for (const h of Object.values(get().fxHolds)) liveIds.add(h.fxId);
      set({ fx: get().fx.filter((f) => liveIds.has(f.id)) });
    },
    beginFxHold(slotKey, kind, startS) {
      // Single set() per keypress — cuts subscriber-fanout cost (13 field
      // checks in useAutoPersist alone) by 3-4×. The previous version
      // called set() up to four times: prior-hold cleanup → clobber →
      // addFx → fxHolds update. Each one fired every store subscriber
      // synchronously inside the hot keydown handler.
      const s = get();

      // Audition mode: while playback is paused the pad just overlays
      // the effect on the live frame so the user can dial in DEPTH/EDGE
      // with full visual feedback. NOTHING is written to fx[] — no 1-px
      // capsule on the timeline, no clobber, no priorFx snapshot needed.
      if (!s.playback.isPlaying) {
        const prior = s.fxHolds[slotKey];
        const nextHolds: Record<string, FxHoldEntry> = { ...s.fxHolds };
        if (prior) delete nextHolds[slotKey];
        nextHolds[slotKey] = {
          mode: "preview",
          kind,
          fxId: "",
          startS,
          priorFx: [],
        };
        set({ fxHolds: nextHolds });
        return;
      }

      const bpm = s.jobMeta?.bpm?.value ?? null;
      const lengthS = defaultTapLengthS(kind, bpm);

      // If a stale prior hold exists on this slot (Safari can fire
      // keydown twice without keyup on inactive-window resume), start
      // from its priorFx baseline instead of stacking it on top.
      const prior = s.fxHolds[slotKey];
      const baselineFx = prior ? prior.priorFx : s.fx;
      // The new entry's priorFx is the snapshot WE see — i.e. what to
      // restore on cancel. After clobber/insert, that's the baseline.
      const priorFx = baselineFx.slice();

      // Tape-overwrite: clobber non-live same-kind fx that overlap the
      // default-tap window. Live FX (currently held by other slots) are
      // skipped via liveIds.
      const liveIds = new Set<string>();
      for (const [k, h] of Object.entries(s.fxHolds)) {
        if (k !== slotKey && h.fxId) liveIds.add(h.fxId);
      }
      const outS = Math.max(startS + lengthS, startS + FX_MIN_WINDOW_S);

      // Bake what the panel encoders are currently showing into the new
      // capsule so it's frozen at write-time (Recording Head — what was
      // on the knobs at the moment of the press is what gets recorded).
      // Same freeze logic for the ADSR envelope. Computed before clobber
      // so the clobber pass can see the full footprint of the new fx
      // including its release tail.
      const id = makeFxId();
      const userDefaults = s.fxDefaults[kind];
      const params =
        userDefaults && Object.keys(userDefaults).length > 0
          ? { ...userDefaults }
          : undefined;
      const userEnv = s.fxEnvelopes[kind];
      const catalogEnv = fxCatalog[kind]?.defaultEnvelope;
      const envelope: ADSREnvelope = userEnv ?? catalogEnv ?? INSTANT_ENVELOPE;
      // Clobber sees the new fx's eventual footprint (incl. release
      // tail) so a rapid same-spot retrigger erases the previous fx in
      // full instead of leaving a release-tail stub behind. Also tape-
      // splits inside an old fx land at the new fx's actual end, not
      // its zero-width head.
      const clobberEndS = outS + envelope.releaseS;
      const clobbered = clobberSameKindOverlapping(
        baselineFx,
        kind,
        startS,
        clobberEndS,
        liveIds,
      );
      const newFx: PunchFx = {
        id,
        kind,
        inS: startS,
        outS,
        params,
        envelope: { ...envelope },
      };
      const nextFx = [...clobbered, newFx];

      const nextHolds: Record<string, FxHoldEntry> = { ...s.fxHolds };
      if (prior) delete nextHolds[slotKey];
      nextHolds[slotKey] = {
        mode: "persistent",
        kind,
        fxId: id,
        startS,
        priorFx,
      };

      set({ fx: nextFx, fxHolds: nextHolds });
    },
    tickFxHold(slotKey, currentS) {
      const s = get();
      const hold = s.fxHolds[slotKey];
      if (!hold) return;
      // Preview holds don't have an fx to grow — the renderer overlays
      // the effect at full strength while held, no timeline state.
      if (hold.mode === "preview") return;
      const liveFx = s.fx.find((f) => f.id === hold.fxId);
      if (!liveFx) return;
      // Push outS *past* the playhead by HOLD_OVERSHOOT_S so the FX stays
      // active across RAF tick boundaries. Without the buffer, the moment
      // currentTime catches up to outS the active-resolver (`t < outS`)
      // marks the FX inactive — the vignette flickers off mid-hold.
      // Only grow: backwards moves keep the larger value (matches live-
      // performance feel — hold longer ↔ longer capsule, never shrinks
      // under your fingertip).
      const target = currentS + FX_HOLD_OVERSHOOT_S;
      if (target <= liveFx.outS) return;
      // Tape-overwrite: as the live range grows, eat any non-live
      // same-kind fx in its path. Skip the live fx itself.
      const liveIds = new Set<string>();
      for (const h of Object.values(s.fxHolds)) liveIds.add(h.fxId);
      const clobbered = clobberSameKindOverlapping(
        s.fx,
        liveFx.kind,
        hold.startS,
        target,
        liveIds,
      );
      // Build the next fx array: clobbered list with the live fx's outS
      // pushed to target. Single set() merges what used to be two
      // (`set({fx: clobbered})` + `setFxOut`).
      const clampedOut = Math.max(target, liveFx.inS + FX_MIN_WINDOW_S);
      const nextFx = clobbered.map((f) =>
        f.id === hold.fxId ? { ...f, outS: clampedOut } : f,
      );
      set({ fx: nextFx });
    },
    endFxHold(slotKey) {
      const cur = get().fxHolds;
      const hold = cur[slotKey];
      if (!hold) return;
      // Preview hold: no fx to finalise — just drop the entry. The
      // overlay disappears on the next render tick.
      if (hold.mode === "preview") {
        const next = { ...cur };
        delete next[slotKey];
        set({ fxHolds: next });
        return;
      }
      // Snap the committed out-edge to the active grid. The in-edge was
      // snapped at beginFxHold; mirroring that on release means tap and
      // hold both produce on-grid ranges. Falls back to the live outS
      // (with overshoot) if the snap would shrink below in + min-window
      // — recording never collapses a fx under the user's fingertips.
      const fx = get().fx.find((f) => f.id === hold.fxId);
      if (fx) {
        // The live tick keeps outS at currentS + overshoot, so
        // `outS - overshoot` is the latest playhead position we know about.
        // We use that as the release time instead of reading playback.
        // currentTime again — the latter may have advanced past our last
        // observation, and during tests there's often no playback at all.
        const releaseS = Math.max(fx.inS, fx.outS - FX_HOLD_OVERSHOOT_S);
        const snappedRelease = get().snapMasterTime(releaseS);
        // Synth-voice release: the region must extend BEYOND the user's
        // release moment by `envelope.releaseS` seconds so the release
        // phase actually has time to fade. Without the tail, `outS` lands
        // at the snapped release moment and the playhead is past the
        // region instantly — effect cuts off hard. Snap stays at the
        // user-perceived moment; only the tail is appended (off-grid).
        const releaseTailS = fx.envelope?.releaseS ?? 0;
        const finalOut = Math.max(
          fx.inS + FX_MIN_WINDOW_S,
          snappedRelease + releaseTailS,
        );
        if (Math.abs(finalOut - fx.outS) > 1e-6) {
          set({
            fx: get().fx.map((f) =>
              f.id === hold.fxId ? { ...f, outS: finalOut } : f,
            ),
          });
        }
      }
      const next = { ...cur };
      delete next[slotKey];
      set({ fxHolds: next });
    },
    cancelFxHold(slotKey) {
      const hold = get().fxHolds[slotKey];
      if (!hold) return;
      const next = { ...get().fxHolds };
      delete next[slotKey];
      if (hold.mode === "preview") {
        // Nothing was written to fx[] — just drop the hold record.
        set({ fxHolds: next });
        return;
      }
      // Revert: drop only the fx this hold introduced. Other live holds
      // keep their fx (we don't full-revert to priorFx, that would clobber
      // simultaneously-held FX from other slots).
      const fxNext = get().fx.filter((f) => f.id !== hold.fxId);
      set({ fx: fxNext, fxHolds: next });
    },
    cancelAllFxHolds() {
      const holds = get().fxHolds;
      const liveIds = new Set(
        Object.values(holds)
          .filter((h) => h.mode === "persistent")
          .map((h) => h.fxId),
      );
      const fxNext = get().fx.filter((f) => !liveIds.has(f.id));
      set({ fx: fxNext, fxHolds: {} });
    },
    eraseFxAt(t, kinds) {
      const liveIds = new Set(
        Object.values(get().fxHolds)
          .filter((h) => h.mode === "persistent")
          .map((h) => h.fxId),
      );
      const matchKind = (k: FxKind): boolean =>
        kinds === "all" ? true : kinds.includes(k);
      // Tape-erase: the head is a ~150 ms window centered on t. Only the
      // strip of an fx that lives *under the head* is wiped — anything
      // outside the head survives. A head straddling the front edge of
      // an fx trims its inS forward; the back edge trims its outS back;
      // a head inside an fx splits it into two pieces.
      const cutLow = t - FX_ERASE_DELTA_S / 2;
      const cutHigh = t + FX_ERASE_DELTA_S / 2;
      const next: PunchFx[] = [];
      for (const f of get().fx) {
        if (!matchKind(f.kind) || liveIds.has(f.id)) {
          next.push(f);
          continue;
        }
        // No overlap → keep as-is.
        if (cutHigh <= f.inS || cutLow >= f.outS) {
          next.push(f);
          continue;
        }
        // Head fully covers the fx → drop entirely.
        if (cutLow <= f.inS && cutHigh >= f.outS) {
          continue;
        }
        // Head straddles front edge (cuts off the head of the fx).
        if (cutLow <= f.inS && cutHigh < f.outS) {
          const trimmed: PunchFx = { ...f, inS: cutHigh };
          if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) next.push(trimmed);
          continue;
        }
        // Head straddles back edge (cuts off the tail of the fx).
        if (cutLow > f.inS && cutHigh >= f.outS) {
          const trimmed: PunchFx = { ...f, outS: cutLow };
          if (trimmed.outS - trimmed.inS >= FX_MIN_WINDOW_S) next.push(trimmed);
          continue;
        }
        // Head strictly inside fx → split into [inS, cutLow] + [cutHigh, outS].
        const left: PunchFx = { ...f, outS: cutLow };
        const right: PunchFx = { ...f, id: makeFxId(), inS: cutHigh };
        if (left.outS - left.inS >= FX_MIN_WINDOW_S) next.push(left);
        if (right.outS - right.inS >= FX_MIN_WINDOW_S) next.push(right);
      }
      set({ fx: next });
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
    setSelectedFxKind(kind) {
      if (get().selectedFxKind === kind) return;
      set({ selectedFxKind: kind });
    },
    setFxDefault(kind, paramId, value) {
      const cur = get().fxDefaults;
      const sub = cur[kind] ?? {};
      if (sub[paramId] === value) return;
      set({
        fxDefaults: {
          ...cur,
          [kind]: { ...sub, [paramId]: value },
        },
      });
    },
    setFxEnvelope(kind, partial) {
      const cur = get().fxEnvelopes;
      const baseline =
        cur[kind] ?? fxCatalog[kind]?.defaultEnvelope ?? INSTANT_ENVELOPE;
      const next: ADSREnvelope = {
        attackS: partial.attackS ?? baseline.attackS,
        decayS: partial.decayS ?? baseline.decayS,
        sustain: partial.sustain ?? baseline.sustain,
        releaseS: partial.releaseS ?? baseline.releaseS,
      };
      // Skip the set when nothing actually changed — keeps zustand
      // subscribers (and the RAF preview) idle on no-op drags.
      const prev = cur[kind];
      if (
        prev &&
        prev.attackS === next.attackS &&
        prev.decayS === next.decayS &&
        prev.sustain === next.sustain &&
        prev.releaseS === next.releaseS
      ) {
        return;
      }
      set({ fxEnvelopes: { ...cur, [kind]: next } });
    },
    resetFxEnvelope(kind) {
      const cur = get().fxEnvelopes;
      if (!(kind in cur)) return;
      const next = { ...cur };
      delete next[kind];
      set({ fxEnvelopes: next });
    },
  })),
);
