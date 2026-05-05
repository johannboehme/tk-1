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
 * Downstream invalidation: any change to `chunks` (split / merge /
 * accept / re-chop) drops the persisted `arrangement` and `pills` so
 * the Arrange + Editor pages re-seed from the new chunk set on their
 * next mount. The user's mental model — "if I step back and change
 * something, everything downstream is regenerated" — is enforced
 * here so callers don't have to remember to invalidate.
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
  /** True until we've persisted at least one mutation; used to gate the
   *  arrangement+pills invalidation so loading a job into Triage
   *  doesn't itself wipe downstream state on the very first save. */
  const initialLoadRef = useRef(true);
  /** Tracks whether the last observed mutation actually touched the
   *  chunks list. Drives whether the next persist run wipes the
   *  arrangement + pills downstream. Set in the subscription, read +
   *  cleared inside the debounced write. */
  const chunksDirtyRef = useRef(false);

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
        const isFirstWrite = lastWrittenRef.current === null;
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
        // Downstream invalidation. A genuine chunk mutation (split /
        // merge / accept toggle / re-chop) means the Arrange page's
        // arrangement and the Editor's pills both reference stale
        // chunk bounds. Wipe both so the next page mount re-seeds
        // from the new chunk set. Skip on the first persist of a
        // load so opening a job doesn't drop the user's existing
        // arrangement.
        const invalidateDownstream = chunksDirtyRef.current && !isFirstWrite;
        chunksDirtyRef.current = false;
        await jobsDb.updateJob(s.jobId, {
          chunks: s.chunks,
          silenceConfig: s.silenceConfig,
          bpm: bpmPayload,
          beatsPerBar: s.beatsPerBar,
          ui: { ...(job.ui ?? {}), snapMode: s.snapMode },
          videos: updatedVideos,
          ...(invalidateDownstream ? { arrangement: [], pills: [] } : {}),
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
      // Track chunk-list mutations separately so the persist run knows
      // whether to wipe downstream state. Reference-equality is good
      // enough — Triage actions return a fresh chunks array on every
      // mutation, identity reads as the right ground truth. The very
      // first chunks-change after mount is the `initFromJob` load
      // hydrating the store with the persisted chunks; that's not a
      // user edit and must not invalidate the existing arrangement.
      if (cur.chunks !== old.chunks) {
        if (initialLoadRef.current) {
          initialLoadRef.current = false;
        } else {
          chunksDirtyRef.current = true;
        }
      }
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
