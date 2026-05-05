/**
 * Triage-Phase (Step 1 von 3 für Long-Form-Session-Jobs).
 *
 * Identifiziert Audio-Chunks im Master-Audio per Stille-Erkennung. BPM
 * gilt song-global (Mode der per-Chunk-Detections; user-überschreibbar
 * via brass-plate im Inspector-Header), aber jeder Chunk hat seinen
 * eigenen `audioStartMs`-Anchor — Long-form Sessions sind nicht
 * zueinander beat-aligned.
 *
 * Layout (Desktop): vier-Regionen-Rack
 *   1. PhaseStrip                    (existing, 48px)
 *   2. ControlRow                    (h-80, three equal-height columns)
 *      ├── Cam preview + SyncPatch
 *      ├── Inspector (BPM-plate im header, KV/octave/trim im body)
 *      └── ChunksList (compact)
 *   3. DeckStrip                     (h-20, brushed-metal band)
 *      ├── SnapModeButtons cassette plate (left)
 *      └── Detection sliders + kept-LCD (right)
 *   4. Timeline                      (flex-1, fills the rest)
 *   5. TransportBar                  (existing)
 *
 * Mobile: vertical stack, timeline gets `min-h-[280px]` so it never
 * disappears.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { HelpIcon } from "../editor/components/icons";
import { SnapModeButtonsView } from "../editor/components/SnapModeButtonsView";
import { jobsDb } from "../local/jobs";
import type { LocalJob } from "../local/jobs";
import { jobRoutePath } from "../local/jobs-routing";
import { useSyncOp } from "../local/ops-store";
import { isVideoAsset } from "../storage/jobs-db";
import {
  DEFAULT_SILENCE_CONFIG,
  runChunkDetectionForJob,
  type TriageStageProgress,
} from "../local/triage/triage-orchestrator";
import { loadAssetFile } from "../local/asset-source";
import { decodeAudioToMonoPcm } from "../local/codec";
import { TRIAGE_ENVELOPE_HZ, pickGlobalBpm } from "../local/triage/chunk-detect";
import {
  isChunkEffectivelyAccepted,
  useTriageStore,
} from "../local/triage/triage-store";
import { useTriagePersist } from "../local/triage/useTriagePersist";
import { getCachedAnalysis } from "../local/render/audio-analysis";
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
  const snapMode = useTriageStore((s) => s.snapMode);
  const setSnapMode = useTriageStore((s) => s.setSnapMode);
  const hasBpm = useTriageStore((s) => Boolean(s.jobBpm?.value));
  const syncOp = useSyncOp(id);
  useTriagePersist();

  // Detection can run as soon as the master video has a sync result
  // (its envelope/PCM is decodable). Independent of any lifecycle bit;
  // history-loaded projects with sync data and a `lastRender` come in
  // here just fine.
  const masterCam = job?.videos?.find(isVideoAsset);
  const hasSyncData = Boolean(masterCam?.sync);

  async function continueToArrange() {
    const state = useTriageStore.getState();
    if (!state.jobId) return;
    const fresh = await jobsDb.getJob(state.jobId);
    const existing = fresh?.arrangement ?? [];
    const jobBpmValue = state.jobBpm?.value ?? null;
    // The set of chunks the user is actually keeping at this moment —
    // accepted-flag AND passes the active min-bars filter.
    const acceptedIds = new Set(
      state.chunks
        .filter((c) =>
          isChunkEffectivelyAccepted(
            c,
            state.minChunkBars,
            jobBpmValue,
            state.beatsPerBar,
          ),
        )
        .map((c) => c.id),
    );
    // Step 1: prune the existing arrangement against the live accepted
    // set. Without this, a chunk the user kept earlier and rejected
    // later would still ship into Arrange (and the editor) as a stale
    // item — exactly the "double the chunks" bug from the report.
    const prunedExisting = existing.filter((it) =>
      acceptedIds.has(it.chunkId),
    );
    // Step 2: append any newly-accepted chunks that aren't in the
    // arrangement yet, in master-time order. Existing items keep
    // their position so an established arrangement isn't rewritten.
    const inArrangement = new Set(prunedExisting.map((a) => a.chunkId));
    const additions = state.chunks
      .filter((c) => acceptedIds.has(c.id) && !inArrangement.has(c.id))
      .sort((a, b) => a.startMs - b.startMs)
      .map((c, i) => ({
        id: `arr-${c.id}-${Date.now()}-${i}`,
        chunkId: c.id,
      }));
    await jobsDb.updateJob(state.jobId, {
      arrangement: [...prunedExisting, ...additions],
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
    if (!job || !hasSyncData) return;
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
      const analysis = await getCachedAnalysis(job!.id).catch(() => undefined);
      const detectedTempo = analysis?.tempo;
      const detectedBpm = detectedTempo
        ? { value: detectedTempo.bpm, confidence: detectedTempo.confidence }
        : null;
      const persistedBpm = job!.bpm;
      // Triple fallback: persisted job.bpm → whole-file analysis cache
      // → mode of per-chunk detected BPMs. Whole-file is unreliable on
      // long-form sessions but better than nothing; the chunk-mode is
      // the canonical long-form path but only works when at least
      // some chunks were long enough for tempo detection.
      let jobBpm: ReturnType<typeof toBpmValue> | null = persistedBpm
        ? toBpmValue(persistedBpm)
        : detectedBpm
          ? { value: detectedBpm.value, confidence: detectedBpm.confidence, manualOverride: false }
          : null;
      if (!jobBpm && job!.chunks?.length) {
        const fromChunks = pickGlobalBpm(job!.chunks);
        if (fromChunks) {
          jobBpm = {
            value: fromChunks.value,
            confidence: fromChunks.confidence,
            manualOverride: false,
          };
        }
      }
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
          minChunkBars: 0,
          loopEnabled: true,
          pcm: new Float32Array(0),
          pcmSampleRate: 22050,
          envelope: job!.triageEnvelope!,
          envelopeHz: TRIAGE_ENVELOPE_HZ,
        });
        setDetection({ kind: "ready" });

        // PCM decode runs in the background so the timeline paints
        // instantly off the cached envelope. Conform needs the full
        // PCM and waits on `pcmDecoding`; we flip it here so the
        // wait knows when to stop. On failure we surface the reason
        // through `pcmDecodeError`.
        //
        // We DON'T gate the post-decode store updates on the local
        // `cancelled` flag — `setDetection({ kind: "ready" })` inside
        // this effect triggers a re-render that flips `cancelled` to
        // true (the effect's deps include `detection.kind`), which
        // would otherwise leave the long-running decode's resolution
        // stranded. Instead we check against the store's `jobId` to
        // guard against the user navigating to a different job.
        const decodeJobId = job!.id;
        useTriageStore.setState({ pcmDecoding: true, pcmDecodeError: null });
        void decodePcmInBackground(job!)
          .then((outcome) => {
            if (useTriageStore.getState().jobId !== decodeJobId) return;
            if (outcome.ok) {
              useTriageStore.setState({
                pcm: outcome.pcm,
                pcmSampleRate: outcome.sampleRate,
                pcmDecodeError: null,
              });
            } else {
              useTriageStore.setState({ pcmDecodeError: outcome.reason });
            }
          })
          .finally(() => {
            if (useTriageStore.getState().jobId === decodeJobId) {
              useTriageStore.setState({ pcmDecoding: false });
            }
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
          minChunkBars: 0,
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
  }, [job, hasSyncData, detection.kind, initFromJob]);

  return (
    <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
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
        <NotReady
          hasSyncData={hasSyncData}
          syncStage={syncOp?.stage}
          detection={detection}
        />
      ) : (
        <>
          {/* ─── ControlRow — three equal-height columns. Grows on
           *  tall viewports (flex-1 with min) so the cam preview gets
           *  more room when there is room to give. */}
          <section
            className={[
              "flex-1 min-h-[18rem] px-3 pt-3",
              "grid grid-cols-1 gap-3",
              "lg:grid-cols-[minmax(420px,1.5fr)_minmax(360px,1.1fr)_minmax(220px,0.6fr)]",
            ].join(" ")}
          >
            {/* Col 1 — Cam preview only. The corner badge is a
             *  dropdown for cam-switching; per-cam sync nudging lives
             *  in the editor where it actually matters for cuts. */}
            <div className="min-h-0">
              <CamPreview />
            </div>

            {/* Col 2 — Inspector (BPM in header, body fills) */}
            <ChunkInspector />

            {/* Col 3 — Compact chunks index */}
            <ChunksList />
          </section>

          {/* ─── DeckStrip — snap plate + detection sliders ─────── */}
          <section
            className={[
              "flex-none mt-3 px-3 py-3",
              "grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-3 lg:gap-4 items-center",
              "border-y border-rule bg-paper-deep",
            ].join(" ")}
            style={{
              boxShadow: [
                "inset 0 1px 0 rgba(255,255,255,0.5)",
                "inset 0 -1px 0 rgba(0,0,0,0.15)",
              ].join(", "),
            }}
          >
            <div className="flex justify-center lg:justify-start">
              <SnapModeButtonsView
                snapMode={snapMode}
                onSnapModeChange={setSnapMode}
                hasBpm={hasBpm}
                // Triage has no per-clip audio-match candidates, so
                // MATCH is meaningless here — drop it from the plate.
                modes={["off", "1", "1/2", "1/4", "1/8", "1/16"]}
              />
            </div>
            <DetectionPanel />
          </section>

          {/* ─── Timeline — compact strip directly above transport.
           *  Height matches the timeline content exactly (rulers +
           *  capped waveform + chunk lane) so there's no dead paper-
           *  hi space inside the frame. Extra vertical real estate
           *  flows to ControlRow above. */}
          <section className="flex-none px-3 py-2 flex">
            <div
              className="flex-1 rounded-md overflow-hidden"
              style={{
                boxShadow: "inset 0 2px 4px rgba(0,0,0,0.08)",
                height: 188,
              }}
            >
              <TriageTimeline />
            </div>
          </section>

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

type PcmDecodeOutcome =
  | { ok: true; pcm: Float32Array; sampleRate: number }
  | { ok: false; reason: string };

async function decodePcmInBackground(job: LocalJob): Promise<PcmDecodeOutcome> {
  if (!job.audioSource) {
    return { ok: false, reason: "no audio source on job" };
  }
  try {
    const file = await loadAssetFile({ source: job.audioSource });
    const decoded = await decodeAudioToMonoPcm(file, 22050);
    return { ok: true, pcm: decoded.pcm, sampleRate: decoded.sampleRate };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Triage background PCM decode failed:", err);
    return { ok: false, reason: message };
  }
}

function NotReady({
  hasSyncData,
  syncStage,
  detection,
}: {
  hasSyncData: boolean;
  syncStage?: string;
  detection: DetectionState;
}) {
  const stageLabel =
    detection.kind === "running"
      ? `${detection.stage}…`
      : detection.kind === "error"
        ? "error"
        : !hasSyncData
          ? syncStage
            ? `waiting · ${syncStage}`
            : "waiting · sync needed"
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
            {!hasSyncData
              ? syncStage
                ? "Sync is still running. Detection will start as soon as it finishes."
                : "This project has no sync result yet — open the job page and re-run sync."
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
      {/* Help button — dispatches a synthetic "?" keydown so the
       *  globally-mounted HelpOverlay opens. Same pattern the editor
       *  uses; no separate state to manage. */}
      <ChunkyButton
        variant="secondary"
        size="sm"
        className="aspect-square"
        aria-label="Show keyboard shortcuts"
        title="Keyboard shortcuts · ?"
        onClick={() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "?", bubbles: true }),
          )
        }
      >
        <HelpIcon />
      </ChunkyButton>
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
            <span
              className="text-[10px]"
              style={{ color: active === p.id ? "#FF8A4F" : "#9A8F80" }}
              aria-hidden
            >
              ━━▶
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
