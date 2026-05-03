/**
 * Triage auto-persist hook.
 *
 * Watches the slice of the Triage store that should round-trip into
 * IDB (chunks, silenceConfig, sessionBpmOverride, per-cam syncOverrideMs)
 * and writes changes back to the job row. Debounced 250 ms — slider
 * drags + nudge buttons fire at high frequency, IndexedDB doesn't
 * love that.
 *
 * Mirrors the editor's `useAutoPersist` pattern.
 */
import { useEffect, useRef } from "react";
import { jobsDb } from "../jobs";
import { useTriageStore } from "./triage-store";
import { isVideoAsset } from "../../storage/jobs-db";

const DEBOUNCE_MS = 250;

export function useTriagePersist() {
  const lastWrittenRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    function scheduleWrite() {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(async () => {
        const s = useTriageStore.getState();
        if (!s.jobId) return;
        const fingerprint = JSON.stringify({
          chunks: s.chunks,
          silenceConfig: s.silenceConfig,
          sessionBpmOverride: s.sessionBpmOverride,
          camSync: s.cams.map((c) => [c.id, c.syncOverrideMs ?? 0]),
        });
        if (fingerprint === lastWrittenRef.current) return;
        lastWrittenRef.current = fingerprint;

        // Read the job freshly to merge per-cam overrides into the
        // existing videos array — preserves any non-Triage fields
        // (sync, framesPath, viewportTransform, etc.).
        const job = await jobsDb.getJob(s.jobId);
        if (!job) return;
        const updatedVideos = (job.videos ?? []).map((v) => {
          if (!isVideoAsset(v)) return v;
          const overlay = s.cams.find((c) => c.id === v.id);
          if (!overlay) return v;
          return { ...v, syncOverrideMs: overlay.syncOverrideMs ?? 0 };
        });
        await jobsDb.updateJob(s.jobId, {
          chunks: s.chunks,
          silenceConfig: s.silenceConfig,
          sessionBpmOverride: s.sessionBpmOverride ?? undefined,
          videos: updatedVideos,
        });
        timeoutRef.current = null;
      }, DEBOUNCE_MS);
    }

    const unsub = useTriageStore.subscribe((s, prev) => {
      const watched = (st: typeof s) => ({
        chunks: st.chunks,
        silenceConfig: st.silenceConfig,
        sessionBpmOverride: st.sessionBpmOverride,
        camSync: st.cams.map((c) => c.syncOverrideMs ?? 0).join(","),
      });
      const cur = watched(s);
      const old = watched(prev);
      if (
        cur.chunks !== old.chunks ||
        cur.silenceConfig !== old.silenceConfig ||
        cur.sessionBpmOverride !== old.sessionBpmOverride ||
        cur.camSync !== old.camSync
      ) {
        scheduleWrite();
      }
    });
    return () => {
      unsub();
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);
}
