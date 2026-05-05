/**
 * Arrange auto-persist hook.
 *
 * Watches the arrangement + per-cam syncOverride changes from the
 * Arrange store and writes them back to the job row in IDB. Debounced
 * 250 ms — same cadence as Triage.
 *
 * Downstream invalidation: any change to the arrangement drops the
 * persisted `pills` so the Editor re-seeds from the new arrangement
 * on its next mount. Same "step back, change, downstream regenerates"
 * contract as Triage→Arrange.
 *
 * Mirrors `useTriagePersist`.
 */
import { useEffect, useRef } from "react";
import { jobsDb } from "../jobs";
import { useArrangeStore } from "./arrange-store";
import { isVideoAsset } from "../../storage/jobs-db";

const DEBOUNCE_MS = 250;

export function useArrangePersist() {
  const lastWrittenRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  /** True until we've persisted at least one mutation; the very first
   *  arrangement-change is the `initFromJob` hydration, not a user
   *  edit, and must not wipe the editor's pills. */
  const initialLoadRef = useRef(true);
  /** Set when the subscription sees an actual arrangement mutation
   *  (post-load). Read + cleared by the next debounced write to
   *  decide whether to invalidate downstream pills. */
  const arrangementDirtyRef = useRef(false);

  useEffect(() => {
    function scheduleWrite() {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(async () => {
        const s = useArrangeStore.getState();
        if (!s.jobId) return;
        const fingerprint = JSON.stringify({
          arrangement: s.arrangement,
          camSync: s.cams.map((c) => [c.id, c.syncOverrideMs ?? 0]),
        });
        if (fingerprint === lastWrittenRef.current) return;
        lastWrittenRef.current = fingerprint;

        const job = await jobsDb.getJob(s.jobId);
        if (!job) return;
        const updatedVideos = (job.videos ?? []).map((v) => {
          if (!isVideoAsset(v)) return v;
          const overlay = s.cams.find((c) => c.id === v.id);
          if (!overlay) return v;
          return { ...v, syncOverrideMs: overlay.syncOverrideMs ?? 0 };
        });
        const invalidatePills = arrangementDirtyRef.current;
        arrangementDirtyRef.current = false;
        await jobsDb.updateJob(s.jobId, {
          arrangement: s.arrangement,
          videos: updatedVideos,
          ...(invalidatePills ? { pills: [] } : {}),
        });
        timeoutRef.current = null;
      }, DEBOUNCE_MS);
    }

    const unsub = useArrangeStore.subscribe((s, prev) => {
      const arrangementChanged = s.arrangement !== prev.arrangement;
      const camsChanged = s.cams !== prev.cams;
      // Same first-load gate as Triage — initFromJob's arrangement
      // hydration must not invalidate the editor's pills.
      if (arrangementChanged) {
        if (initialLoadRef.current) {
          initialLoadRef.current = false;
        } else {
          arrangementDirtyRef.current = true;
        }
      }
      if (arrangementChanged || camsChanged) scheduleWrite();
    });
    return () => {
      unsub();
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);
}
