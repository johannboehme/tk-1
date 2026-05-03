/**
 * Triage auto-persist hook.
 *
 * Watches the slice of the Triage store that should round-trip into
 * IDB and writes changes back to the job row. Debounced 250 ms — slider
 * drags + nudge buttons fire at high frequency, IndexedDB doesn't love
 * that.
 *
 * Persisted: chunks, silenceConfig, jobBpm (→ job.bpm), beatsPerBar,
 * snapMode (→ job.ui.snapMode, shared with editor), per-cam
 * syncOverrideMs.
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
          jobBpm: s.jobBpm,
          beatsPerBar: s.beatsPerBar,
          snapMode: s.snapMode,
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
        // Build the BPM payload in the same shape `LocalJob.bpm` uses —
        // includes `phase` so the editor's bar grid stays anchored
        // correctly on the same job.
        const bpmPayload = s.jobBpm
          ? {
              value: s.jobBpm.value,
              confidence: s.jobBpm.confidence ?? job.bpm?.confidence ?? 0,
              phase: job.bpm?.phase ?? s.beatPhaseS,
              manualOverride: s.jobBpm.manualOverride,
            }
          : job.bpm;
        await jobsDb.updateJob(s.jobId, {
          chunks: s.chunks,
          silenceConfig: s.silenceConfig,
          bpm: bpmPayload,
          beatsPerBar: s.beatsPerBar,
          ui: { ...(job.ui ?? {}), snapMode: s.snapMode },
          videos: updatedVideos,
        });
        timeoutRef.current = null;
      }, DEBOUNCE_MS);
    }

    const unsub = useTriageStore.subscribe((s, prev) => {
      const watched = (st: typeof s) => ({
        chunks: st.chunks,
        silenceConfig: st.silenceConfig,
        jobBpm: st.jobBpm,
        beatsPerBar: st.beatsPerBar,
        snapMode: st.snapMode,
        camSync: st.cams.map((c) => c.syncOverrideMs ?? 0).join(","),
      });
      const cur = watched(s);
      const old = watched(prev);
      if (
        cur.chunks !== old.chunks ||
        cur.silenceConfig !== old.silenceConfig ||
        cur.jobBpm !== old.jobBpm ||
        cur.beatsPerBar !== old.beatsPerBar ||
        cur.snapMode !== old.snapMode ||
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
