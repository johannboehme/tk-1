/**
 * Triage-Phase (Step 1 von 3 für Long-Form-Session-Jobs).
 *
 * Identifiziert Audio-Chunks im Master-Audio per Stille-Erkennung. BPM
 * + Time-Signature kommen aus der Master-Audio-Analyse und gelten
 * song-global — alle Chunks teilen sich denselben Bar-Grid, weil sie
 * downstream auf Bars geschnitten und zu einem Song zusammengefügt
 * werden.
 *
 * Layout (Desktop): Top-Strip mit Cam + Inspector + Chunk-Liste,
 * darunter SnapModeButtons-Plate, dann Timeline volle Breite, ganz
 * unten der Transport. Mobile: vertikaler Stack.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { SnapModeButtonsView } from "../editor/components/SnapModeButtonsView";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import { isVideoAsset } from "../storage/jobs-db";
import {
  DEFAULT_SILENCE_CONFIG,
  runChunkDetectionForJob,
  type TriageStageProgress,
} from "../local/triage/triage-orchestrator";
import { loadAssetFile } from "../local/asset-source";
import { decodeAudioToMonoPcm } from "../local/codec";
import { TRIAGE_ENVELOPE_HZ } from "../local/triage/chunk-detect";
import { useTriageStore } from "../local/triage/triage-store";
import { useTriagePersist } from "../local/triage/useTriagePersist";
import { getCachedAnalysis } from "../local/render/audio-analysis";
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
  const snapMode = useTriageStore((s) => s.snapMode);
  const setSnapMode = useTriageStore((s) => s.setSnapMode);
  const hasBpm = useTriageStore((s) => Boolean(s.jobBpm?.value));
  useTriagePersist();

  async function continueToArrange() {
    const state = useTriageStore.getState();
    if (!state.jobId) return;
    const fresh = await jobsDb.getJob(state.jobId);
    const existing = fresh?.arrangement ?? [];
    const inArrangement = new Set(existing.map((a) => a.chunkId));
    const acceptedSorted = [...state.chunks]
      .filter((c) => c.accepted)
      .sort((a, b) => a.startMs - b.startMs);
    const additions = acceptedSorted
      .filter((c) => !inArrangement.has(c.id))
      .map((c, i) => ({
        id: `arr-${c.id}-${Date.now()}-${i}`,
        chunkId: c.id,
      }));
    await jobsDb.updateJob(state.jobId, {
      arrangement: [...existing, ...additions],
    });
    navigate(jobRoutePath(id, "arrange"));
  }

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

  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  useEffect(() => {
    if (!job || job.status !== "synced") return;
    if (detectionStartedRef.current) return;
    if (detection.kind !== "idle") return;
    detectionStartedRef.current = true;

    const hasCached =
      Array.isArray(job.chunks) &&
      job.chunks.length > 0 &&
      job.triageEnvelope instanceof Float32Array;

    let cancelled = false;

    async function loadTimingFields(): Promise<{
      jobBpm: ReturnType<typeof toBpmValue> | null;
      detectedBpm: { value: number; confidence: number } | null;
      beatsPerBar: number;
      barOffsetBeats: number;
      beatPhaseS: number;
    }> {
      // Pull cached audio analysis for the auto-detected reference;
      // job.bpm carries the current (possibly user-overridden) value.
      const analysis = await getCachedAnalysis(job!.id).catch(() => undefined);
      const detectedTempo = analysis?.tempo;
      const detectedBpm = detectedTempo
        ? { value: detectedTempo.bpm, confidence: detectedTempo.confidence }
        : null;
      const persistedBpm = job!.bpm;
      const jobBpm = persistedBpm
        ? toBpmValue(persistedBpm)
        : detectedBpm
          ? { value: detectedBpm.value, confidence: detectedBpm.confidence, manualOverride: false }
          : null;
      return {
        jobBpm,
        detectedBpm,
        beatsPerBar: job!.beatsPerBar ?? 4,
        barOffsetBeats: job!.barOffsetBeats ?? 0,
        beatPhaseS: analysis?.audioStartS ?? persistedBpm?.phase ?? 0,
      };
    }

    if (hasCached) {
      void loadTimingFields().then((timing) => {
        if (cancelled) return;
        const videos = (job!.videos ?? []).filter(isVideoAsset);
        initFromJob({
          jobId: job!.id,
          audioDuration: job!.durationS ?? 0,
          cams: videos,
          chunks: job!.chunks!,
          silenceConfig: job!.silenceConfig ?? DEFAULT_SILENCE_CONFIG,
          jobBpm: timing.jobBpm,
          detectedBpm: timing.detectedBpm,
          beatsPerBar: timing.beatsPerBar,
          barOffsetBeats: timing.barOffsetBeats,
          beatPhaseS: timing.beatPhaseS,
          snapMode: job!.ui?.snapMode ?? "1",
          loopEnabled: true,
          pcm: new Float32Array(0),
          pcmSampleRate: 22050,
          envelope: job!.triageEnvelope!,
          envelopeHz: TRIAGE_ENVELOPE_HZ,
        });
        setDetection({ kind: "ready" });

        void decodePcmInBackground(job!).then((pcm) => {
          if (cancelled || !pcm) return;
          useTriageStore.setState({ pcm: pcm.pcm, pcmSampleRate: pcm.sampleRate });
        });
      });
      return () => {
        cancelled = true;
      };
    }

    setDetection({ kind: "running", stage: "decoding" });
    runChunkDetectionForJob(job.id, job.silenceConfig ?? DEFAULT_SILENCE_CONFIG, {
      onStage: (p) => {
        if (!cancelled) setDetection({ kind: "running", stage: p.stage });
      },
    })
      .then(async (result) => {
        if (cancelled) return;
        const timing = await loadTimingFields();
        if (cancelled) return;
        const videos = (job!.videos ?? []).filter(isVideoAsset);
        const chunksToUse = job!.chunks && job!.chunks.length > 0 ? job!.chunks : result.chunks;
        initFromJob({
          jobId: job!.id,
          audioDuration: job!.durationS ?? result.pcm.length / result.sampleRate,
          cams: videos,
          chunks: chunksToUse,
          silenceConfig: job!.silenceConfig ?? DEFAULT_SILENCE_CONFIG,
          jobBpm: timing.jobBpm,
          detectedBpm: timing.detectedBpm,
          beatsPerBar: timing.beatsPerBar,
          barOffsetBeats: timing.barOffsetBeats,
          beatPhaseS: timing.beatPhaseS,
          snapMode: job!.ui?.snapMode ?? "1",
          loopEnabled: true,
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
        onContinue={continueToArrange}
        continueLabel="Continue → Arrange"
      />

      {detection.kind === "ready" && <TriageAudioMaster />}

      {detection.kind !== "ready" ? (
        <NotReady job={job} detection={detection} />
      ) : (
        <>
          {/* Top tools row — Cam preview + Inspector + Chunks list,
           *  arranged so the Cam preview gets the most width on
           *  desktop. */}
          <div className="flex-none px-3 pt-3 grid gap-3 grid-cols-1 lg:grid-cols-[minmax(360px,1.2fr)_minmax(320px,1fr)_minmax(220px,0.8fr)]">
            <div className="flex flex-col gap-3 min-h-0">
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
            </div>
            <div className="flex flex-col gap-3 min-h-0">
              <ChunkInspector />
              <DetectionPanel />
            </div>
            <div className="min-h-0">
              <ChunksList />
            </div>
          </div>

          {/* Snap-mode plate — sits between the tools row and the
           *  timeline so it visibly governs trim drags below. */}
          <div className="flex-none px-3 pt-3 flex items-center justify-center">
            <SnapModeButtonsView
              snapMode={snapMode}
              onSnapModeChange={setSnapMode}
              hasBpm={hasBpm}
            />
          </div>

          {/* Full-width timeline. Sits directly above the transport
           *  bar — that's where the action is, so it gets the breathing
           *  room. */}
          <div className="flex-1 min-h-0 px-3 py-3 flex flex-col">
            <div className="flex-1 min-h-0">
              <TriageTimeline />
            </div>
          </div>

          <TriageTransportBar />
        </>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function toBpmValue(persisted: NonNullable<LocalJob["bpm"]>): {
  value: number;
  confidence: number;
  manualOverride: boolean;
} {
  return {
    value: persisted.value,
    confidence: persisted.confidence,
    manualOverride: Boolean(persisted.manualOverride),
  };
}

async function decodePcmInBackground(
  job: LocalJob,
): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
  if (!job.audioSource) return null;
  try {
    const file = await loadAssetFile({ source: job.audioSource });
    const decoded = await decodeAudioToMonoPcm(file, 22050);
    return { pcm: decoded.pcm, sampleRate: decoded.sampleRate };
  } catch (err) {
    console.warn("Triage background PCM decode failed:", err);
    return null;
  }
}

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
