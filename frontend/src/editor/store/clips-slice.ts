/**
 * Clips domain — the in-memory cam clips (video + image), their
 * per-clip alignment / transform / trim edits, selection, and the
 * background-prep badge set.
 */
import {
  Clip,
  ExportSpec,
  MatchCandidate,
  ViewportTransform,
  clipEffectiveDisplayDims,
  clipRangeS,
  isVideoClip,
} from "../../core/types";
import type { CamRange } from "../../core/cuts";
import { DEFAULT_VIEWPORT_TRANSFORM } from "../../core/render/element-transform";
import { classifyAspectRatio } from "../exportPresets";
import { clamp } from "../../lib/clamp";
import {
  PILL_MIN_WINDOW_S,
  mutatePillsForCam,
  shiftPillOriginalSource,
  shiftPillSource,
} from "./pills-slice";
import type { SliceCreator } from "./state";

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

export function buildClips(
  inits: ClipInit[] | undefined,
  fallbackOverrideMs: number,
): Clip[] {
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
export function computeCamRanges(clips: readonly Clip[]): CamRange[] {
  const cached = camRangesCache.get(clips);
  if (cached !== undefined) return cached;
  const ranges = clips.map((c) => {
    const range = clipRangeS(c);
    return { id: c.id, startS: range.startS, endS: range.endS };
  });
  camRangesCache.set(clips, ranges);
  return ranges;
}

/** Pure helper — apply `fn` to the one clip matching `camId`. Same idea
 *  as `mutatePill` for the dozen-or-so per-clip setters (sync override,
 *  trim, rotation, …). */
function mutateClip(
  clips: readonly Clip[],
  camId: string,
  fn: (c: Clip) => Clip,
): Clip[] {
  return clips.map((c) => (c.id === camId ? fn(c) : c));
}

export interface ClipsSliceState {
  clips: Clip[];
  selectedClipId: string | null;
  /** Cams currently being prepared in the background (decode / match /
   *  frames). The Editor's live-job-update handler sets this from the
   *  underlying VideoAsset state — a cam is "preparing" while its
   *  framesPath is still undefined, regardless of skipSync. The lane
   *  header renders a small "PREP" badge while the cam is in this set. */
  preparingCamIds: ReadonlySet<string>;
}

export interface ClipsSliceActions {
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
  /** Reset a cam's alignment back to the algorithm's primary candidate:
   *  selectedCandidateIdx=0, syncOverrideMs=0, startOffsetS=0. Used by
   *  the lane-header ↺ button when the user wants to undo their nudges. */
  resetClipAlignment(camId: string): void;
  setSelectedCandidateIdx(camId: string, idx: number): void;
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
  /** Resize an image clip's duration on the master timeline. Clamped to
   *  a sane minimum so the lane doesn't collapse to invisibility.
   *  No-op for video clips (their length is the source-file length). */
  setImageClipDuration(camId: string, durationS: number): void;
  /** Set per-clip trim for a video clip. Clamped to
   *  [0, sourceDurationS] with a minimum visible window of 0.05 s.
   *  No-op for image clips. */
  setVideoClipTrim(camId: string, trimInS: number, trimOutS: number): void;
  /** Replace the set of cams in background-prep state. The Editor's
   *  job-update handler calls this on every event so the badge tracks
   *  the underlying asset state without leaks. */
  setPreparingCamIds(ids: Iterable<string>): void;
  camRanges(): CamRange[];
}

export function initialClipsState(): ClipsSliceState {
  return {
    clips: [],
    selectedClipId: null,
    preparingCamIds: new Set<string>(),
  };
}

export const createClipsSlice: SliceCreator<ClipsSliceActions> = (
  set,
  get,
) => ({
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

  resetClipAlignment(camId) {
    const clips = mutateClip(get().clips, camId, (c) => {
      // Image clips have no sync alignment — only their startOffsetS.
      if (!isVideoClip(c)) return { ...c, startOffsetS: 0 };
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

  setSelectedCandidateIdx(camId, idx) {
    const prev = get().clips.find((c) => c.id === camId);
    if (!prev || !isVideoClip(prev)) return;
    const prevOffsetMs = prev.syncOffsetMs;
    set({
      clips: mutateClip(get().clips, camId, (c) => {
        if (!isVideoClip(c)) return c; // image clips have no candidates
        const clamped = clamp(idx, 0, Math.max(0, c.candidates.length - 1));
        const newOffset = c.candidates[clamped]?.offsetMs ?? c.syncOffsetMs;
        return { ...c, selectedCandidateIdx: clamped, syncOffsetMs: newOffset };
      }),
    });
    // The candidate-switch shifts the cam's master-anchor — every
    // pill of this cam needs its source-time mapping shifted by the
    // same delta so the same arr-position plays the right source
    // frames at the new alignment. Without this, pills (which are
    // authoritative for source-time post-pill-refactor) keep playing
    // the OLD candidate's frames and the snap is invisible. Mirrors
    // what `setClipSyncOverride` does for syncOverrideMs nudges.
    const next = get().clips.find((c) => c.id === camId);
    if (!next || !isVideoClip(next)) return;
    const deltaMs = next.syncOffsetMs - prevOffsetMs;
    if (Math.abs(deltaMs) > 1e-6) {
      const deltaS = deltaMs / 1000;
      set({
        pills: mutatePillsForCam(get().pills, camId, (p) =>
          shiftPillOriginalSource(shiftPillSource(p, deltaS), deltaS),
        ),
      });
    }
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
    const prev = get().clips.find((c) => c.id === camId);
    const prevMs = prev && isVideoClip(prev) ? prev.syncOverrideMs : 0;
    const clips = mutateClip(get().clips, camId, (c) =>
      isVideoClip(c) ? { ...c, syncOverrideMs: ms } : c,
    );
    set({ clips });
    // The cam-track-anchor change is reflected in pill source-time:
    // every pill of this cam plays its excerpt N ms later (positive)
    // or earlier (negative) than before. We update both the live and
    // the original source bounds so a per-pill RESET targets the
    // post-anchor baseline (= where the cam currently belongs in the
    // song). Without this the SyncTuner's nudge would change the
    // cam-master-anchor field but the rendered pill audio/video
    // wouldn't move at all — pills are authoritative for source-time.
    const deltaMs = ms - prevMs;
    if (Math.abs(deltaMs) > 1e-6) {
      const deltaS = deltaMs / 1000;
      set({
        pills: mutatePillsForCam(get().pills, camId, (p) =>
          shiftPillOriginalSource(shiftPillSource(p, deltaS), deltaS),
        ),
      });
    }
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
    set({
      clips: mutateClip(get().clips, camId, (c) => {
        if (c.kind !== "image") return c;
        // Hard min so the pill never collapses to an unhittable sliver.
        return { ...c, durationS: Math.max(0.1, durationS) };
      }),
    });
  },

  setVideoClipTrim(camId, trimInS, trimOutS) {
    set({
      clips: mutateClip(get().clips, camId, (c) => {
        if (!isVideoClip(c)) return c;
        const inS = clamp(trimInS, 0, c.sourceDurationS - PILL_MIN_WINDOW_S);
        const outS = clamp(trimOutS, inS + PILL_MIN_WINDOW_S, c.sourceDurationS);
        return { ...c, trimInS: inS, trimOutS: outS };
      }),
    });
  },

  setClipStartOffset(camId, startOffsetS) {
    set({
      clips: mutateClip(get().clips, camId, (c) => ({ ...c, startOffsetS })),
    });
  },
  setClipRotation(camId, deg) {
    set({
      clips: mutateClip(get().clips, camId, (c) => ({ ...c, rotation: deg })),
    });
  },
  setClipFlip(camId, axis, on) {
    const key = axis === "x" ? "flipX" : "flipY";
    set({
      clips: mutateClip(get().clips, camId, (c) => ({ ...c, [key]: on })),
    });
  },
  resetClipTransform(camId) {
    set({
      clips: mutateClip(get().clips, camId, (c) => ({
        ...c,
        rotation: 0,
        flipX: false,
        flipY: false,
      })),
    });
  },
  setClipViewportTransform(camId, partial) {
    set({
      clips: mutateClip(get().clips, camId, (c) => {
        const cur: ViewportTransform =
          c.viewportTransform ?? DEFAULT_VIEWPORT_TRANSFORM;
        return {
          ...c,
          viewportTransform: {
            scale: partial.scale ?? cur.scale,
            x: partial.x ?? cur.x,
            y: partial.y ?? cur.y,
          },
        };
      }),
    });
  },
  resetClipViewportTransform(camId) {
    set({
      clips: mutateClip(get().clips, camId, (c) => {
        const { viewportTransform: _drop, ...rest } = c;
        void _drop;
        return rest as Clip;
      }),
    });
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

  camRanges() {
    return computeCamRanges(get().clips);
  },
});
