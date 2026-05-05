/**
 * Arrange-Phase (Step 2 of 3 für Long-Form-Session-Jobs).
 *
 * The Filmstreifen — user's accepted Triage chunks become a 35mm-style
 * film strip ordered into a playable sequence. Default = 1:1 with the
 * Triage handoff (chronological). User can reorder, duplicate, drop;
 * "Continue → Editor" graduates the job to the editor.
 *
 * Layout:
 *   Desktop (≥ lg):
 *     - Top: PlayerCockpit (cam preview + LCD)
 *     - Middle: FilmStrip (full-width) + MiniMap (overflow-only)
 *     - Below: ContactSheet (full-width source pool)
 *     - Right rail (lg+): ArrangeInspector
 *     - Bottom: ArrangeTransport
 *   Mobile (< lg):
 *     - LCD + tiny cam preview row
 *     - FilmStrip + MiniMap
 *     - ContactSheet directly underneath (touch-natural)
 *     - Inspector inline
 *     - Bottom: ArrangeTransport with cursor controls
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import { isVideoAsset } from "../storage/jobs-db";
import { useArrangeStore } from "../local/arrange/arrange-store";
import { useArrangePersist } from "../local/arrange/useArrangePersist";
import { useChunkMelSpecs } from "../local/arrange/useChunkMelSpecs";
import {
  clearChunkThumbnails,
  prefetchChunkThumbnails,
} from "../local/arrange/chunk-thumbnails";
import { FilmStrip } from "../components/arrange/FilmStrip";
import { ContactSheet } from "../components/arrange/ContactSheet";
import { PlayerCockpit } from "../components/arrange/PlayerCockpit";
import { ArrangeTransport } from "../components/arrange/ArrangeTransport";
import { MiniMap } from "../components/arrange/MiniMap";
import { ArrangeAudioMaster } from "../components/arrange/useArrangeAudio";
import { ChunkDragGhost } from "../components/arrange/ChunkDragGhost";
import { useChunkDragController } from "../components/arrange/useChunkDragController";
import { PhaseStrip } from "./Triage";

export default function Arrange() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initFromJob = useArrangeStore((s) => s.initFromJob);
  const reset = useArrangeStore((s) => s.reset);

  useArrangePersist();
  useChunkDragController();
  useChunkMelSpecs();

  // Load the job and prime the arrange store. The IDB thumbnail
  // prefetch runs BEFORE we expose the job to the UI — that way the
  // first paint of every Polaroid finds its URL via the synchronous
  // peek and skips the "developing dots" pulse for returning visitors.
  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      const j = await jobsDb.getJob(id);
      if (!active) return;
      if (!j) {
        setError("Job not found");
        return;
      }
      const cams = (j.videos ?? []).filter(isVideoAsset);
      const chunkIds = (j.chunks ?? []).map((c) => c.id);
      // Warm the in-memory cache from IDB. We block on this so the
      // polaroids that mount with the page-render below already see
      // their thumbnail in `peekChunkThumbnailUrl()` — eliminates the
      // brief flash of dots that landed on every card last session.
      await Promise.all(
        cams.map((cam) =>
          prefetchChunkThumbnails(j.id, cam.id, chunkIds).catch(
            () => undefined,
          ),
        ),
      );
      if (!active) return;
      // Reconcile arrangement against the latest Triage state at every
      // mount. Triage toggles `chunk.accepted` directly on the chunks
      // list but doesn't reach into the persisted arrangement, so a
      // previously-arranged chunk that the user has since rejected
      // would otherwise still show up here. Drop those items.
      const acceptedChunks = (j.chunks ?? []).filter((c) => c.accepted);
      const acceptedIds = new Set(acceptedChunks.map((c) => c.id));
      const persistedArr = j.arrangement ?? [];
      let arrangement = persistedArr.filter((it) =>
        acceptedIds.has(it.chunkId),
      );
      const wasPruned = arrangement.length < persistedArr.length;
      // First-time seed — only when the user has never touched the
      // arrangement (no items at all and pruning didn't just empty it).
      // Once they've curated something, an arrangement that ends up
      // empty after pruning is their decision and we leave it alone.
      const isFirstTimeSeed =
        !wasPruned && arrangement.length === 0 && acceptedChunks.length > 0;
      if (isFirstTimeSeed) {
        arrangement = acceptedChunks
          .slice()
          .sort((a, b) => a.startMs - b.startMs)
          .map((c, i) => ({
            id: `arr-${c.id}-${Date.now()}-${i}`,
            chunkId: c.id,
          }));
      }
      // Persist any divergence (pruning or first-time seed) so the
      // next mount sees consistent state and we don't re-prune the
      // same items every time.
      if (wasPruned || isFirstTimeSeed) {
        void jobsDb.updateJob(j.id, { arrangement });
      }
      setJob(j);
      initFromJob({
        jobId: j.id,
        audioDuration: j.durationS ?? 0,
        chunks: j.chunks ?? [],
        arrangement,
        cams,
        jobBpm: j.bpm?.value ?? null,
        jobBeatsPerBar: j.beatsPerBar ?? 4,
      });
    })();
    return () => {
      active = false;
    };
  }, [id, initFromJob]);

  // Reset on unmount + tear down thumbnail caches.
  useEffect(() => {
    return () => {
      reset();
      clearChunkThumbnails();
    };
  }, [reset]);

  async function continueToEditor() {
    // Flush the in-memory arrangement to IDB before navigating away —
    // useArrangePersist debounces writes 250 ms, so a fast click
    // following a recent +ADD/reorder would otherwise navigate before
    // the writeback fires and the editor would read a stale row.
    const s = useArrangeStore.getState();
    if (s.jobId) {
      await jobsDb.updateJob(s.jobId, { arrangement: s.arrangement });
    }
    navigate(jobRoutePath(id, "edit"));
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
        <PhaseStrip
          phase="arrange"
          jobTitle={null}
          jobId={id}
          onBack={() => navigate(jobRoutePath(id, "triage"))}
          onContinue={() => navigate(`/jobs`)}
          continueLabel="Back to History"
        />
        <main className="flex-1 grid place-items-center px-4 py-6">
          <p className="font-mono text-xs text-danger">{error}</p>
        </main>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
        <PhaseStrip
          phase="arrange"
          jobTitle={null}
          jobId={id}
          onBack={() => navigate(jobRoutePath(id, "triage"))}
          onContinue={continueToEditor}
          continueLabel="Continue → Editor"
        />
        <main className="flex-1 grid place-items-center px-4 py-6">
          <p className="font-mono text-xs text-ink-3">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
      <PhaseStrip
        phase="arrange"
        jobTitle={job.title}
        jobId={id}
        onBack={() => navigate(jobRoutePath(id, "triage"))}
        onContinue={continueToEditor}
        continueLabel="Continue → Editor"
      />

      <ArrangeAudioMaster />

      {/* Full-width single-column layout. Inspector lives inside the
       *  bottom transport bar instead of stealing horizontal real-
       *  estate from the strip + contact sheet. ContactSheet is
       *  flex-1 so it fills any vertical space the strip + cockpit
       *  don't claim — wrap-grid inside, no wasted paper. */}
      <main className="flex-1 min-h-0 flex flex-col gap-2 lg:gap-3 px-2 lg:px-3 py-2 lg:py-3 overflow-hidden">
        <PlayerCockpit />
        <div className="flex-none">
          <FilmStrip />
          <MiniMap />
        </div>
        <ContactSheet />
      </main>

      <ArrangeTransport />
      <ChunkDragGhost />
    </div>
  );
}
