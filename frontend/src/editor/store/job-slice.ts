/**
 * Job domain — job meta (fps / duration / bpm / beat grid), the legacy
 * cam-1 sync-offset mirror, the master trim window, the master-audio
 * gain, and the job lifecycle (reset / loadJob).
 *
 * `initialEditorState()` lives here because reset()/loadJob() consume
 * it: the initial data is composed from every slice's own initial
 * factory, so create() / reset() can never drift apart again (#121).
 */
import type { Segment, Pill } from "../../core/types";
import { isVideoClip } from "../../core/types";
import { reconcilePills } from "../../core/arrangement-pills";
import { segmentIndexAtArr } from "../../core/arrangement-time";
import type { ArrangementItem, Chunk, Cut } from "../../storage/jobs-db";
import type { PunchFx } from "../../core/fx/types";
import { defaultColorGrade, type GradeParams } from "../../core/fx/looks";
import type { FilterSlot } from "../../core/fx/types";
import { clampLoopToBounds } from "../arrangement-loop";
import type { EditorStateData, SliceCreator } from "./state";
import { buildClips, initialClipsState, type ClipInit } from "./clips-slice";
import { initialPlaybackState } from "./playback-slice";
import { initialPillsState } from "./pills-slice";
import { initialCutsState } from "./cuts-slice";
import { initialQuantizeState } from "./quantize-slice";
import { initialFxState } from "./fx-slice";
import { initialGradeState } from "./grade-slice";
import { DEFAULT_EXPORT, initialOutputState } from "./output-slice";
import { initialUiState } from "./ui-slice";

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

const TRIM_EPS = 0.05; // seconds — minimum trim window length

const initialOffset: OffsetSlice = {
  userOverrideMs: 0,
  abBypass: false,
};

export interface JobSliceState {
  jobMeta: JobMeta | null;
  offset: OffsetSlice;
  trim: TrimRegion;
  /** Master-audio playback gain. 1.0 = source level (default), 0 = muted,
   *  2.0 = +6 dB. Applied by `useAudioMaster` to the master `<audio>`
   *  element AND baked into the rendered output by `edit.ts`. */
  audioVolume: number;
}

export interface JobSliceActions {
  reset(): void;
  loadJob(
    meta: JobMeta,
    opts?: {
      lastSyncOverrideMs?: number | null;
      clips?: ClipInit[];
      cuts?: Cut[];
      fx?: PunchFx[];
      /** Persisted global color grade. Absent on legacy jobs → identity. */
      colorGrade?: GradeParams;
      /** Persisted opinionated filter stack. Absent on legacy jobs → []. */
      filterSlots?: FilterSlot[];
      audioVolume?: number;
      /** Long-form arrangement segments (master-time {in, out}). When
       *  passed, the editor walks them sequentially during playback +
       *  emits them into EditSpec at render time. */
      arrangementSegments?: Segment[];
      /** Source-of-truth for pill auto-generation. Pills are derived
       *  from `(cams × arrangement-items × chunks)` on first mount; if
       *  `storedPills` are non-empty their user-edited values (move /
       *  trim) are reconciled in by id. */
      arrangement?: ArrangementItem[];
      chunks?: Chunk[];
      storedPills?: Pill[];
    },
  ): void;
  setOffset(ms: number): void;
  nudgeOffset(deltaMs: number): void;
  setAbBypass(bypass: boolean): void;
  setTrim(t: TrimRegion): void;
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
  /** Re-anchor the bar grid (= master `audioStartNudgeS`) so beat 0 lands
   *  on the audio onset of the given pill's source segment. Used to
   *  re-align the grid against a single chunk after small accumulated
   *  drift between FX/cut snap-times and the audio. Pass-through return
   *  codes mirror triage's `conformChunk` so the UI can disable / toast. */
  conformAudioStartToPill(
    pillId: string,
  ): "ok" | "no-pill" | "no-bpm" | "no-audio-start" | "unchanged";
  /** Set the time-signature numerator (= beats per bar). Re-runs the
   *  whole-bar grid + bar-line ruler the next render. */
  setBeatsPerBar(n: number): void;
  /** Set the anacrusis / pickup, in beats. Stored modulo `beatsPerBar`
   *  so any value canonicalises into [0, beatsPerBar). */
  setBarOffsetBeats(n: number): void;
  /** Master-audio playback gain. Clamped to [0, 4]. */
  setMasterAudioVolume(v: number): void;
  // ---- Selectors ----
  totalOffsetMs(): number;
}

export function initialJobState(): JobSliceState {
  return {
    jobMeta: null,
    offset: initialOffset,
    trim: { in: 0, out: 0 },
    audioVolume: 1.0,
  };
}

/** The complete initial data of the editor store — one spread of every
 *  slice's initial factory. Used by the assembly's create() and by
 *  reset(), so a new field only has to be added in its slice's factory
 *  to be covered everywhere. */
export function initialEditorState(): EditorStateData {
  return {
    ...initialJobState(),
    ...initialPlaybackState(),
    ...initialClipsState(),
    ...initialPillsState(),
    ...initialCutsState(),
    ...initialQuantizeState(),
    ...initialFxState(),
    ...initialGradeState(),
    ...initialOutputState(),
    ...initialUiState(),
  };
}

export const createJobSlice: SliceCreator<JobSliceActions> = (set, get) => ({
  reset() {
    set(initialEditorState());
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
    // Deliberately NOT reset here (unlike reset()): holdGesture,
    // quantizePreview, notice, preparingCamIds and history stay
    // untouched across a job load — they are session-transients owned
    // by their own flows (the prep badge in particular is fed by the
    // Editor's job-event subscription that races this call).
    const initial = initialEditorState();
    set({
      jobMeta: normalizedMeta,
      playback: initial.playback,
      offset: {
        userOverrideMs: legacyOverrideMs,
        abBypass: false,
      },
      trim: { in: 0, out: meta.duration },
      overlays: initial.overlays,
      visualizer: initial.visualizer,
      exportSpec: DEFAULT_EXPORT,
      ui: initial.ui,
      clips,
      cuts: opts?.cuts ?? [],
      selectedClipId,
      // Pills ARE the editing surface — generated for every job
      // (arrangement OR single-take). reconcilePills splices stored
      // user edits (move / trim) on top of the freshly auto-derived
      // default; orphaned pills (whose cam or arrangement-item
      // disappeared) drop out, new ones come in.
      pills: reconcilePills(
        opts?.arrangement ?? [],
        opts?.chunks ?? [],
        clips,
        opts?.storedPills ?? [],
      ),
      selectedPillId: null,
      fx: opts?.fx ?? [],
      // Merge over defaults so a grade persisted before a param existed
      // still loads with every key present.
      colorGrade: { ...defaultColorGrade(), ...(opts?.colorGrade ?? {}) },
      filterSlots: opts?.filterSlots ?? [],
      fxHolds: initial.fxHolds,
      selectedFxKind: initial.selectedFxKind,
      fxDefaults: initial.fxDefaults,
      fxEnvelopes: initial.fxEnvelopes,
      fxModulations: initial.fxModulations,
      audioEnv: initial.audioEnv,
      audioVolume:
        typeof opts?.audioVolume === "number" && opts.audioVolume >= 0
          ? Math.min(4, opts.audioVolume)
          : 1.0,
      // Composed-timeline invariant: every loaded job carries at least
      // one segment. Editor.tsx feeds the synthesized shape from
      // synthesizeJobLoadShape; callers that omit it (legacy tests,
      // simplified harnesses) get a default single-segment covering
      // the whole master so the segment walker has a real range to
      // walk and arr-time projections stay Identity for direct-mode.
      arrangementSegments:
        opts?.arrangementSegments && opts.arrangementSegments.length > 0
          ? opts.arrangementSegments
          : [{ in: 0, out: meta.duration }],
    });
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
  setAbBypass(bypass) {
    set({ offset: { ...get().offset, abBypass: bypass } });
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
    // Re-clamp loop to new trim. In arr-mode the loop lives in arr-time
    // and is bounded by `totalArrDuration` — trim has no say. In direct-
    // mode trim and the loop share the master-time clock and the loop
    // must stay inside trim.
    const loop = get().playback.loop;
    if (loop) {
      const clamped = clampLoopToBounds(
        loop,
        get().arrangementSegments,
        { in: tin, out: tout },
      );
      set({ playback: { ...get().playback, loop: clamped } });
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
  conformAudioStartToPill(pillId) {
    const s = get();
    const pill = s.pills.find((p) => p.id === pillId);
    if (!pill) return "no-pill";
    const meta = s.jobMeta;
    const phase = meta?.bpm?.phase;
    if (!meta || typeof phase !== "number") return "no-bpm";
    // Resolve the segment via the pill's auto-generated arr-position —
    // immune to any post-load drag that moved arrStartS off its
    // arrangement-item's segment range.
    const segIdx = segmentIndexAtArr(
      pill.originalArrStartS,
      s.arrangementSegments,
    );
    if (segIdx < 0) return "no-audio-start";
    const seg = s.arrangementSegments[segIdx];
    if (typeof seg.audioStartMs !== "number") return "no-audio-start";
    const targetPhaseS = seg.audioStartMs / 1000;
    const newNudgeS = Math.round((targetPhaseS - phase) * 1000) / 1000;
    const cur = meta.audioStartNudgeS ?? 0;
    if (Math.abs(newNudgeS - cur) < 1e-6) return "unchanged";
    set({ jobMeta: { ...meta, audioStartNudgeS: newNudgeS } });
    return "ok";
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
  setMasterAudioVolume(v) {
    const clamped = Math.max(0, Math.min(4, v));
    set({ audioVolume: clamped });
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
});
