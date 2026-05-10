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
 * Downstream propagation (non-destructive): a chunk-list mutation
 * applies a diff to the persisted `arrangement` (drop items whose
 * chunk vanished or got rejected; preserve everything else).
 * `pills` are NOT wiped here — the Editor's `reconcilePills` matches
 * stored pills against the fresh arrangement on every mount, which
 * preserves user-edited pills correctly. Wiping would drop those edits
 * unnecessarily. Confirm dialogs (in the Triage UI before destructive
 * actions) gate the user-visible loss; this hook just persists the
 * resulting state.
 *
 * Mirrors the editor's `useAutoPersist` pattern.
 */
import { useEffect, useRef } from "react";
import { jobsDb } from "../jobs";
import { useTriageStore } from "./triage-store";
import { isVideoAsset } from "../../storage/jobs-db";
import { propagateTriageChangesToArrangement } from "./diff-arrangement";
import type { Chunk } from "../../storage/jobs-db";

const DEBOUNCE_MS = 250;

export function useTriagePersist() {
  const lastWrittenRef = useRef<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  /** True until we've persisted at least one mutation; used to gate
   *  arrangement diff-propagation so loading a job into Triage doesn't
   *  itself touch downstream state on the very first save. */
  const initialLoadRef = useRef(true);
  /** Snapshot of the chunks the last persisted arrangement was diffed
   *  against. Lets the next chunk-mutation persist compute a real diff
   *  (added / removed / modified) instead of a blanket wipe. */
  const lastPersistedChunksRef = useRef<readonly Chunk[]>([]);
  /** Tracks whether the last observed mutation actually touched the
   *  chunks list. Drives whether the next persist run runs the
   *  arrangement diff-propagation. Set in the subscription, read +
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
        // Downstream propagation. On a real chunk mutation (post-load),
        // diff against the previously-persisted chunks set and prune
        // arrangement items whose chunk got dropped. The Editor's
        // reconcile pass picks up new pill geometry on its own —
        // wiping pills here would needlessly drop user edits.
        const propagate = chunksDirtyRef.current && !isFirstWrite;
        chunksDirtyRef.current = false;
        const prevChunks = lastPersistedChunksRef.current ?? [];
        const nextArrangement = propagate
          ? propagateTriageChangesToArrangement(
              prevChunks,
              s.chunks,
              job.arrangement ?? [],
            )
          : null;
        const arrangementChanged =
          nextArrangement !== null && nextArrangement !== (job.arrangement ?? []);
        await jobsDb.updateJob(s.jobId, {
          chunks: s.chunks,
          silenceConfig: s.silenceConfig,
          bpm: bpmPayload,
          beatsPerBar: s.beatsPerBar,
          ui: { ...(job.ui ?? {}), snapMode: s.snapMode },
          videos: updatedVideos,
          ...(arrangementChanged && nextArrangement !== null
            ? { arrangement: nextArrangement }
            : {}),
        });
        lastPersistedChunksRef.current = s.chunks;
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
      // whether to run the arrangement diff-propagation. Reference-
      // equality is good enough — Triage actions return a fresh chunks
      // array on every mutation, identity reads as the right ground
      // truth. The first chunks-change after mount is `initFromJob`
      // hydrating the store; capture it as the diff baseline but don't
      // mark dirty.
      if (cur.chunks !== old.chunks) {
        if (initialLoadRef.current) {
          initialLoadRef.current = false;
          lastPersistedChunksRef.current = s.chunks;
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
