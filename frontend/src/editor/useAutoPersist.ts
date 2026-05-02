/**
 * useAutoPersist — debounced save of editor state into the LocalJob row.
 *
 * What gets persisted (300 ms after the last change):
 *  - per-cam: `syncOverrideMs`, `startOffsetS`, `selectedCandidateIdx`
 *  - `cuts[]` (multi-cam markers)
 *  - `trim` { in, out }
 *  - `bpm` (value + manualOverride flag — survives reload so the user
 *    doesn't lose their override after a refresh)
 *  - `audioStartNudgeS` — user's beat-grid anchor correction
 *  - `beatsPerBar`, `barOffsetBeats` — time signature + pickup
 *  - `ui` { snapMode, lanesLocked }
 *
 * Skipped during the initial load — we only fire when the user actually
 * changes something. Wiring point: mount once in the editor shell after
 * `loadJob()` resolved.
 */
import { useEffect } from "react";
import { useEditorStore } from "./store";
import {
  isImageAsset,
  jobsDb,
  type LocalJob,
  type MediaAsset,
} from "../storage/jobs-db";
import { isVideoClip } from "./types";

const DEBOUNCE_MS = 300;

/** Pure helper: derive the persist-patch for `updateJob` from an editor
 *  state snapshot and the current LocalJob row. Exported for testing.
 *
 *  Handles both video assets (sync override + candidate idx) and image
 *  assets (only startOffsetS to persist). */
export function buildPersistPatch(
  s: ReturnType<typeof useEditorStore.getState>,
  job: LocalJob,
): Partial<LocalJob> {
  const updatedVideos: MediaAsset[] = (job.videos ?? []).map((v): MediaAsset => {
    const clip = s.clips.find((c) => c.id === v.id);
    if (!clip) return v;
    if (isImageAsset(v)) {
      return {
        ...v,
        startOffsetS: clip.startOffsetS,
        rotation: clip.rotation,
        flipX: clip.flipX,
        flipY: clip.flipY,
        viewportTransform: clip.viewportTransform,
      };
    }
    if (!isVideoClip(clip)) return v; // shouldn't happen, defensive
    return {
      ...v,
      syncOverrideMs: clip.syncOverrideMs,
      startOffsetS: clip.startOffsetS,
      selectedCandidateIdx: clip.selectedCandidateIdx,
      trimInS: clip.trimInS,
      trimOutS: clip.trimOutS,
      rotation: clip.rotation,
      flipX: clip.flipX,
      flipY: clip.flipY,
      viewportTransform: clip.viewportTransform,
    };
  });

  const bpm = s.jobMeta?.bpm
    ? {
        value: s.jobMeta.bpm.value,
        confidence: s.jobMeta.bpm.confidence,
        phase: s.jobMeta.bpm.phase,
        manualOverride: s.jobMeta.bpm.manualOverride,
      }
    : undefined;

  return {
    videos: updatedVideos,
    cuts: s.cuts,
    bpm,
    audioStartNudgeS: s.jobMeta?.audioStartNudgeS ?? 0,
    beatsPerBar: s.jobMeta?.beatsPerBar ?? 4,
    barOffsetBeats: s.jobMeta?.barOffsetBeats ?? 0,
    ui: { snapMode: s.ui.snapMode, lanesLocked: s.ui.lanesLocked },
    trim: { in: s.trim.in, out: s.trim.out },
    fx: s.fx,
    audioVolume: s.audioVolume,
    exportSpec: s.exportSpec,
  };
}

export function useAutoPersist(jobId: string | null): void {
  useEffect(() => {
    if (!jobId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let firstFire = true;

    const flush = async () => {
      timer = null;
      if (cancelled) return;
      const s = useEditorStore.getState();
      if (!s.jobMeta || s.jobMeta.id !== jobId) return;

      try {
        const job = await jobsDb.getJob(jobId);
        if (!job || cancelled) return;
        await jobsDb.updateJob(jobId, buildPersistPatch(s, job));
      } catch (err) {
        // Non-fatal: a failed write means we'll retry on the next change.
        console.warn("auto-persist failed:", err);
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    const unsub = useEditorStore.subscribe((state, prev) => {
      // Skip while the store hasn't been loaded yet for this jobId.
      if (!state.jobMeta || state.jobMeta.id !== jobId) return;

      // Skip the very first transition into "loaded" — that's loadJob()
      // hydrating the store from IDB, not a user edit.
      if (firstFire) {
        firstFire = false;
        return;
      }

      if (
        state.clips !== prev.clips ||
        state.cuts !== prev.cuts ||
        state.trim !== prev.trim ||
        state.ui.snapMode !== prev.ui.snapMode ||
        state.ui.lanesLocked !== prev.ui.lanesLocked ||
        state.jobMeta.bpm !== prev.jobMeta?.bpm ||
        state.jobMeta.audioStartNudgeS !== prev.jobMeta?.audioStartNudgeS ||
        state.jobMeta.beatsPerBar !== prev.jobMeta?.beatsPerBar ||
        state.jobMeta.barOffsetBeats !== prev.jobMeta?.barOffsetBeats ||
        state.fx !== prev.fx ||
        state.audioVolume !== prev.audioVolume ||
        state.exportSpec !== prev.exportSpec
      ) {
        schedule();
      }
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsub();
    };
  }, [jobId]);
}
