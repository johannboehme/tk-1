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

  // Load the job and prime the arrange store.
  useEffect(() => {
    if (!id) return;
    let active = true;
    jobsDb.getJob(id).then((j) => {
      if (!active) return;
      if (!j) {
        setError("Job not found");
        return;
      }
      setJob(j);
      const cams = (j.videos ?? []).filter(isVideoAsset);
      // If the user came here via "Continue → Arrange" but the
      // arrangement is empty for some reason (e.g. legacy long-form
      // job pre-handoff), seed it with all accepted chunks now so
      // the user lands on a usable strip.
      let arrangement = j.arrangement ?? [];
      const acceptedChunks = (j.chunks ?? []).filter((c) => c.accepted);
      if (arrangement.length === 0 && acceptedChunks.length > 0) {
        arrangement = acceptedChunks
          .sort((a, b) => a.startMs - b.startMs)
          .map((c, i) => ({
            id: `arr-${c.id}-${Date.now()}-${i}`,
            chunkId: c.id,
          }));
        // Persist the seed so the next mount doesn't re-seed
        void jobsDb.updateJob(j.id, { arrangement });
      }
      initFromJob({
        jobId: j.id,
        audioDuration: j.durationS ?? 0,
        chunks: j.chunks ?? [],
        arrangement,
        cams,
        jobBpm: j.bpm?.value ?? null,
        jobBeatsPerBar: j.beatsPerBar ?? 4,
      });
      // Pre-warm the in-memory thumbnail URL cache from IDB so
      // returning visitors don't see "developing" dots flicker on
      // every Polaroid before the synchronous lookup hits. One
      // bulk fetch per cam per page-mount.
      const chunkIds = (j.chunks ?? []).map((c) => c.id);
      for (const cam of cams) {
        void prefetchChunkThumbnails(j.id, cam.id, chunkIds);
      }
    });
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

      <ArrangeTransport showCursorControls />
      <ChunkDragGhost />
    </div>
  );
}
