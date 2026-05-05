import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { MonoReadout } from "../editor/components/MonoReadout";
import { RuleStrip } from "../editor/components/RuleStrip";
import {
  cancelEditRender,
  jobEvents,
  jobsDb,
  type LocalJob,
} from "../local/jobs";
import { useRenderOp } from "../local/ops-store";

const STAGE_LABELS: Record<string, string> = {
  "render-prep": "Preparing",
  "audio-decode": "Decoding audio",
  "audio-encode": "Encoding audio",
  "energy-curves": "Analyzing audio energy",
  "extracting-frames": "Extracting preview frames",
  encoding: "Encoding video",
  "encoder-flush": "Flushing last frames",
  muxing: "Muxing audio + video",
  finalizing: "Finalizing file",
  writing: "Writing MP4",
  rendered: "Done",
  cancelled: "Cancelled",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function formatDuration(s: number): string {
  if (!isFinite(s) || s < 0) return "—";
  if (s < 1) return "<1 s";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return `${m} m ${sec.toString().padStart(2, "0")} s`;
}

export default function RenderScreen() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  // Rolling samples of (elapsedMs, pct) used to estimate the ETA. The
  // first few samples after the encoder warms up are noisy, so we keep
  // the last 8 and pick the trend over that window.
  const samplesRef = useRef<Array<{ t: number; pct: number }>>([]);
  const [eta, setEta] = useState<number | null>(null);
  const op = useRenderOp(id);

  useEffect(() => {
    if (!id) return;
    let active = true;
    jobsDb.getJob(id).then((j) => {
      if (active) setJob(j ?? null);
    });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ jobId: string; job: LocalJob }>).detail;
      if (detail.jobId !== id) return;
      setJob({ ...detail.job });
    };
    jobEvents.addEventListener("update", handler);
    return () => {
      active = false;
      jobEvents.removeEventListener("update", handler);
    };
  }, [id]);

  // Update ETA whenever progress changes. We only sample during the
  // encoding phase — the prep stages are too fast to be meaningful.
  useEffect(() => {
    if (!op || op.stage !== "encoding") return;
    const elapsed = Date.now() - startedAtRef.current;
    const pct = op.pct;
    if (pct < 26) return; // skip the initial step from 25 → first frame
    const samples = samplesRef.current;
    samples.push({ t: elapsed, pct });
    if (samples.length > 8) samples.shift();
    if (samples.length < 2) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dPct = last.pct - first.pct;
    if (dPct <= 0) return;
    const msPerPct = (last.t - first.t) / dPct;
    const remaining = (90 - last.pct) * msPerPct;
    setEta(remaining / 1000);
  }, [op?.pct, op?.stage, op]);

  // Auto-navigate when the render finishes. We give the success path a
  // brief moment so the user sees "Done" before the page swaps.
  useEffect(() => {
    if (!op?.done) return;
    const t = window.setTimeout(() => navigate(`/job/${id}`), 600);
    return () => window.clearTimeout(t);
  }, [op?.done, id, navigate]);

  async function onCancel() {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await cancelEditRender(id);
    } finally {
      navigate(`/job/${id}/edit`);
    }
  }

  const pct = op?.pct ?? 0;
  const stage = op?.stage ?? "render-prep";
  const framesDone = op?.framesDone;
  const framesTotal = op?.framesTotal;
  const isCancelled = op?.error === "cancelled";
  const isFailed = Boolean(op?.error) && !isCancelled;
  const isDone = op?.done === true;

  const headline = useMemo(() => {
    if (isDone) return "Render done";
    if (isCancelled) return "Cancelled";
    if (isFailed) return "Render failed";
    return "Rendering…";
  }, [isDone, isFailed, isCancelled]);

  return (
    <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-10">
      <div className="w-full max-w-xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tracking-label uppercase text-ink-2">
              JOB · {id.slice(0, 8)}
            </span>
            <RuleStrip count={32} className="text-rule flex-1 max-w-[200px]" />
          </div>
          <h1 className="font-display font-semibold text-3xl sm:text-4xl text-ink">
            {headline}
          </h1>
          {job?.title && (
            <p className="font-mono text-xs text-ink-2 truncate">{job.title}</p>
          )}
        </header>

        {!isFailed && (
          <section className="bg-paper-hi border border-rule rounded-md p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between font-mono text-[11px] tracking-label uppercase text-ink-2">
              <span>{stageLabel(stage)}</span>
              <span className="tabular text-ink">{Math.round(pct)}%</span>
            </div>
            <div className="h-3 rounded-full bg-paper border border-rule overflow-hidden">
              <div
                className="h-full bg-hot transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-1">
              <MonoReadout
                label="FRAMES"
                value={
                  framesTotal && framesTotal > 0
                    ? `${framesDone ?? 0} / ${framesTotal}`
                    : "—"
                }
                align="left"
              />
              <MonoReadout
                label="ETA"
                value={
                  isDone
                    ? "—"
                    : eta != null && stage === "encoding"
                      ? formatDuration(eta)
                      : "—"
                }
                align="left"
              />
            </div>
          </section>
        )}

        {(isFailed || isCancelled) && (
          <section className="border-l-2 border-danger pl-3 py-2 font-mono text-sm text-danger">
            {isCancelled ? "Render was cancelled." : (op?.error ?? "Unknown error.")}
          </section>
        )}

        <div className="flex flex-wrap gap-3">
          {!isDone && !isFailed && !isCancelled && (
            <ChunkyButton
              variant="ghost"
              size="lg"
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel render"}
            </ChunkyButton>
          )}
          {(isFailed || isCancelled) && (
            <ChunkyButton
              variant="secondary"
              size="lg"
              onClick={() => navigate(`/job/${id}/edit`)}
            >
              Back to editor
            </ChunkyButton>
          )}
        </div>
      </div>
    </main>
  );
}
