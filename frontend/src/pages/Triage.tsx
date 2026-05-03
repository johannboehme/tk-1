/**
 * Triage-Phase (Step 1 von 3 für Long-Form-Session-Jobs).
 *
 * Identifiziert Audio-Chunks im Master-Audio per Stille-Erkennung +
 * BPM/Beat-Grid pro Chunk. User akzeptiert/verwirft pro Chunk und kann
 * Boundaries Bar-genau verschieben.
 *
 * Diese Datei ist aktuell ein Placeholder für Phase 1: Routing +
 * Job-State-Machine. Die echte Triage-UI (Waveform-Overview, Cam-
 * Switcher, Per-Chunk Refinement) baut Phase 3+4 darauf.
 *
 * Layout: Full-bleed (TopBar wird in App.tsx ausgeblendet). Thin top
 * strip mit Phase-Breadcrumb + Continue, der Rest ist Werkzeug-Fläche.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import {
  DEFAULT_SILENCE_CONFIG,
  runChunkDetectionForJob,
  type RunChunkDetectionResult,
  type TriageStageProgress,
} from "../local/triage/triage-orchestrator";

type DetectionState =
  | { kind: "idle" }
  | { kind: "running"; stage: TriageStageProgress["stage"] }
  | { kind: "ready"; result: RunChunkDetectionResult }
  | { kind: "error"; message: string };

export default function Triage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [detection, setDetection] = useState<DetectionState>({ kind: "idle" });
  // Guard against double-firing the detection effect under StrictMode and
  // against re-runs when the persisted chunks come back in via setJob().
  const detectionStartedRef = useRef(false);

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

  // Kick off chunk detection when the job is synced and we don't yet
  // have any chunks. Idempotent — runs at most once per page mount.
  useEffect(() => {
    if (!job || job.status !== "synced") return;
    if (detectionStartedRef.current) return;
    if (detection.kind !== "idle") return;
    if (job.chunks && job.chunks.length > 0) return;

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
        setDetection({ kind: "ready", result });
        // Refresh the job snapshot so chunks/silenceConfig come from
        // the persisted source of truth.
        jobsDb.getJob(job.id).then((j) => {
          if (!cancelled && j) setJob(j);
        });
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
  }, [job, detection.kind]);

  const status = jobStatusLabel(job, detection);

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

      <main className="flex-1 min-h-0 grid place-items-center px-4 py-6">
        <div className="text-center max-w-md text-ink-3">
          <p className="font-mono text-xs tracking-label uppercase mb-3">
            ◇ Triage UI · under construction
          </p>
          <p className="text-ink-2 leading-relaxed text-sm mb-4">
            Detection-Backend läuft, UI kommt im nächsten Phasen-Schritt.
          </p>
          <div className="font-mono text-[11px] tabular space-y-1 text-left inline-block bg-paper-hi border border-rule rounded-md px-4 py-3">
            <div>job: {job ? job.title ?? job.id.slice(0, 8) : "loading…"}</div>
            <div>status: {status}</div>
            {detection.kind === "ready" && (
              <>
                <div>chunks: {detection.result.chunks.length}</div>
                <div>
                  envelope: {detection.result.envelope.length} samples @{" "}
                  {detection.result.envelopeHz} Hz
                </div>
                <div>
                  pcm: {(detection.result.pcm.length / detection.result.sampleRate).toFixed(1)} s @{" "}
                  {detection.result.sampleRate} Hz
                </div>
              </>
            )}
            {detection.kind === "error" && (
              <div className="text-danger">error: {detection.message}</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function jobStatusLabel(
  job: LocalJob | null,
  detection: DetectionState,
): string {
  if (!job) return "—";
  if (job.status !== "synced") return `waiting · ${job.status}`;
  switch (detection.kind) {
    case "idle":
      return job.chunks && job.chunks.length > 0
        ? `cached · ${job.chunks.length} chunks`
        : "ready to detect";
    case "running":
      return `detecting · ${detection.stage}`;
    case "ready":
      return `detected · ${detection.result.chunks.length} chunks`;
    case "error":
      return "error";
  }
}

// -----------------------------------------------------------------------------
// PhaseStrip — shared thin top bar for Triage + Arrange (and later phases).
// Lives here for now; promote to its own file once Arrange also wants it.
// -----------------------------------------------------------------------------

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
