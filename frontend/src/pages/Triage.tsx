/**
 * Triage-Phase (Step 1 von 3 für Long-Form-Session-Jobs).
 *
 * Identifiziert Audio-Chunks im Master-Audio per Stille-Erkennung +
 * BPM/Beat-Grid pro Chunk. User akzeptiert/verwirft pro Chunk und kann
 * Boundaries Bar-genau verschieben.
 *
 * Layout: Full-bleed (TopBar wird in App.tsx ausgeblendet). Thin top
 * strip mit Phase-Breadcrumb + Continue, der Rest ist Werkzeug-Fläche.
 *
 * Desktop (≥ lg): 3-Spalten-Layout — Cam-Preview + Sync links, Timeline
 * Mitte, Detection + Inspector + Chunks-List rechts.
 * Mobile (< lg): vertikaler Stack — Timeline → Transport → Inspector
 * (sticky) → Chunks-List → Sync/Detection als Accordions.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import { isVideoAsset } from "../storage/jobs-db";
import {
  DEFAULT_SILENCE_CONFIG,
  runChunkDetectionForJob,
  type TriageStageProgress,
} from "../local/triage/triage-orchestrator";
import { useTriageStore } from "../local/triage/triage-store";
import { useTriagePersist } from "../local/triage/useTriagePersist";
import { SyncPatchPanel } from "../components/sync/SyncPatchPanel";
import { TriageTimeline } from "../components/triage/TriageTimeline";
import { TriageTransportBar } from "../components/triage/TriageTransportBar";
import { DetectionPanel } from "../components/triage/DetectionPanel";
import { ChunkInspector } from "../components/triage/ChunkInspector";
import { ChunksList } from "../components/triage/ChunksList";
import { CamPreview } from "../components/triage/CamPreview";
import { TriageAudioMaster } from "../components/triage/useTriageAudio";

type DetectionState =
  | { kind: "idle" }
  | { kind: "running"; stage: TriageStageProgress["stage"] }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export default function Triage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [detection, setDetection] = useState<DetectionState>({ kind: "idle" });
  const detectionStartedRef = useRef(false);
  const initFromJob = useTriageStore((s) => s.initFromJob);
  const reset = useTriageStore((s) => s.reset);
  const setSelectedCamId = useTriageStore((s) => s.setSelectedCamId);
  const selectedCamId = useTriageStore((s) => s.selectedCamId);
  const nudgeCamSync = useTriageStore((s) => s.nudgeCamSyncOverride);
  const cams = useTriageStore((s) => s.cams);
  // Persist hook — writes chunks/silenceConfig/sessionBpm/cam-sync
  // changes back to the job row in IDB (debounced).
  useTriagePersist();

  // Load the job snapshot.
  useEffect(() => {
    if (!id) return;
    let active = true;
    jobsDb.getJob(id).then((j) => {
      if (active) setJob(j ?? null);
    });
    return () => {
      active = false;
    };
  }, [id]);

  // Reset triage store on unmount so PCM doesn't pin memory after
  // navigation away.
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  // Kick off detection (or load cached chunks) when the job is synced.
  useEffect(() => {
    if (!job || job.status !== "synced") return;
    if (detectionStartedRef.current) return;
    if (detection.kind !== "idle") return;
    detectionStartedRef.current = true;

    let cancelled = false;
    setDetection({ kind: "running", stage: "decoding" });
    runChunkDetectionForJob(job.id, job.silenceConfig ?? DEFAULT_SILENCE_CONFIG, {
      onStage: (p) => {
        if (!cancelled) setDetection({ kind: "running", stage: p.stage });
      },
    })
      .then((result) => {
        if (cancelled) return;
        const videos = (job.videos ?? []).filter(isVideoAsset);
        // If the job already had stored chunks (returning to triage),
        // prefer them over the freshly-detected — they carry user
        // accept/reject decisions.
        const chunksToUse = job.chunks && job.chunks.length > 0 ? job.chunks : result.chunks;
        initFromJob({
          jobId: job.id,
          audioDuration: job.durationS ?? result.pcm.length / result.sampleRate,
          cams: videos,
          chunks: chunksToUse,
          silenceConfig: job.silenceConfig ?? DEFAULT_SILENCE_CONFIG,
          sessionBpmOverride: job.sessionBpmOverride ?? null,
          pcm: result.pcm,
          pcmSampleRate: result.sampleRate,
          envelope: result.envelope,
          envelopeHz: result.envelopeHz,
        });
        setDetection({ kind: "ready" });
      })
      .catch((err) => {
        if (cancelled) return;
        setDetection({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [job, detection.kind, initFromJob]);

  return (
    <div className="flex-1 flex flex-col min-h-0 paper-bg">
      <PhaseStrip
        phase="triage"
        jobTitle={job?.title ?? null}
        jobId={id}
        onBack={() => navigate(`/job/${id}`)}
        onContinue={() => navigate(jobRoutePath(id, "arrange"))}
        continueLabel="Continue → Arrange"
      />

      {/* Hidden audio element drives the master clock. */}
      {detection.kind === "ready" && <TriageAudioMaster />}

      {detection.kind !== "ready" ? (
        <NotReady job={job} detection={detection} />
      ) : (
        <>
          {/* Desktop layout: 3-col split. Mobile: vertical stack. */}
          <main className="flex-1 min-h-0 grid lg:grid-cols-[300px_1fr_320px] gap-3 px-3 py-3 overflow-y-auto lg:overflow-hidden">
            {/* Left column — Cam preview + sync */}
            <aside className="flex flex-col gap-3 min-h-0 order-1 lg:order-1">
              <CamPreview />
              {job && (
                <SyncPatchPanel
                  job={job}
                  selectedCamId={selectedCamId}
                  onSelectCam={(id) => setSelectedCamId(id)}
                  onNudgeCam={(id, deltaMs) => nudgeCamSync(id, deltaMs)}
                  syncOverrides={Object.fromEntries(
                    cams.map((c) => [c.id, c.syncOverrideMs ?? 0]),
                  )}
                />
              )}
            </aside>

            {/* Middle column — Timeline + Transport */}
            <section className="flex flex-col gap-3 min-h-0 order-3 lg:order-2">
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                <div className="flex-1 min-h-0 grid place-items-stretch">
                  <TriageTimeline />
                </div>
              </div>
              <ChunksList />
            </section>

            {/* Right column — Detection + Inspector */}
            <aside className="flex flex-col gap-3 min-h-0 order-2 lg:order-3">
              <DetectionPanel />
              <ChunkInspector />
            </aside>
          </main>

          {/* Sticky bottom transport */}
          <TriageTransportBar />
        </>
      )}
    </div>
  );
}

// ─── Shared loading / error state UI ────────────────────────────────────

function NotReady({
  job,
  detection,
}: {
  job: LocalJob | null;
  detection: DetectionState;
}) {
  const stageLabel =
    detection.kind === "running"
      ? `${detection.stage}…`
      : detection.kind === "error"
        ? "error"
        : job?.status !== "synced"
          ? `waiting · ${job?.status ?? "loading"}`
          : "ready to detect";
  return (
    <main className="flex-1 min-h-0 grid place-items-center px-4 py-6">
      <div className="text-center max-w-md text-ink-3">
        <p className="font-mono text-xs tracking-label uppercase mb-3">
          ◇ Triage · {stageLabel}
        </p>
        {detection.kind === "error" ? (
          <p className="text-danger leading-relaxed text-sm font-mono">
            {detection.message}
          </p>
        ) : (
          <p className="text-ink-2 leading-relaxed text-sm">
            {job?.status !== "synced"
              ? "Waiting for sync to complete before chunk detection can run."
              : "Decoding master audio + detecting chunks…"}
          </p>
        )}
      </div>
    </main>
  );
}

// ─── PhaseStrip (shared with Arrange) ───────────────────────────────────

interface PhaseStripProps {
  phase: "triage" | "arrange";
  jobTitle: string | null;
  jobId: string;
  onBack: () => void;
  onContinue: () => void;
  continueLabel: string;
}

export function PhaseStrip({
  phase,
  jobTitle,
  jobId,
  onBack,
  onContinue,
  continueLabel,
}: PhaseStripProps) {
  return (
    <header className="flex-none h-12 border-b border-rule bg-paper-hi px-3 sm:px-5 flex items-center gap-3">
      <button
        type="button"
        onClick={onBack}
        className="font-mono text-[10px] tracking-label uppercase text-ink-3 hover:text-ink transition-colors shrink-0"
        title="Back to job overview"
      >
        ← Back
      </button>
      <span className="w-px h-5 bg-rule shrink-0" aria-hidden />
      <PhaseDots active={phase} />
      <span className="w-px h-5 bg-rule shrink-0" aria-hidden />
      <span
        className="font-mono text-xs text-ink truncate min-w-0 flex-1"
        title={jobTitle ?? jobId}
      >
        {jobTitle ?? jobId.slice(0, 8)}
      </span>
      <ChunkyButton variant="primary" size="sm" onClick={onContinue}>
        {continueLabel}
      </ChunkyButton>
    </header>
  );
}

function PhaseDots({ active }: { active: "triage" | "arrange" }) {
  const phases: Array<{ id: "triage" | "arrange"; label: string }> = [
    { id: "triage", label: "01 · Triage" },
    { id: "arrange", label: "02 · Arrange" },
  ];
  return (
    <div className="hidden sm:flex items-center gap-1 shrink-0">
      {phases.map((p, i) => (
        <span key={p.id} className="flex items-center gap-1">
          <span
            className={[
              "font-mono text-[10px] tracking-label uppercase",
              active === p.id ? "text-hot" : "text-ink-3",
            ].join(" ")}
          >
            {p.label}
          </span>
          {i < phases.length - 1 && (
            <span className="text-ink-3 text-[10px]">━━▶</span>
          )}
        </span>
      ))}
    </div>
  );
}
