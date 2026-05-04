import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { RuleStrip } from "../editor/components/RuleStrip";
import { DownloadIcon } from "../editor/components/icons";
import { SyncProgressPanel } from "../components/sync/SyncProgressPanel";
import {
  deleteJob,
  jobEvents,
  jobsDb,
  resolveJobAssetUrl,
  runQuickRender,
  type LocalJob,
} from "../local/jobs";
import { jobRoutePath, nextRouteForJob } from "../local/jobs-routing";
import { SyncPatchPanel } from "../components/sync/SyncPatchPanel";

export default function JobPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

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

  // Build a download URL when an output appears.
  useEffect(() => {
    if (!job?.hasOutput) return;
    let url: string | null = null;
    let cancelled = false;
    resolveJobAssetUrl(job.id, "output").then((u) => {
      if (cancelled) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      url = u;
      setDownloadUrl(u);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setDownloadUrl(null);
    };
  }, [job?.hasOutput, job?.id]);

  async function onQuickRender() {
    if (!job) return;
    setErr(null);
    try {
      await runQuickRender(job.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Render failed");
    }
  }

  async function onDelete() {
    if (!job) return;
    if (!window.confirm("Delete this job and its files?")) return;
    await deleteJob(job.id);
    navigate("/jobs");
  }

  if (err) return <Banner kind="error" text={err} />;
  if (!job) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <span className="font-mono text-xs text-ink-2 tracking-label uppercase">
          Loading job…
        </span>
      </main>
    );
  }

  const isDone = job.status === "rendered" || job.status === "synced";
  const isFailed = job.status === "failed";
  // A failed job that already has a sync result is recoverable: the
  // sync data lets the user re-enter the editor or kick off another
  // render attempt without redoing the upload + analysis.
  const canRetry = isFailed && Boolean(job.sync);
  // Quick render is the "drop video + audio → aligned MP4" shortcut —
  // skips the editor entirely. Doesn't fit the long-form workflow
  // (chunks need to be triaged, arranged, then composed in the editor),
  // so we hide it for that path.
  const showQuickRender = job.mode !== "longform";

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <header className="mb-6 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tracking-label uppercase text-ink-2">
            JOB · {job.id.slice(0, 8)}
          </span>
          <RuleStrip count={32} className="text-rule flex-1 max-w-[200px]" />
          <StatusBadge status={job.status} />
        </div>
        <h1 className="font-display font-semibold text-3xl sm:text-4xl text-ink truncate">
          {job.title || job.id}
        </h1>
        <JobSubtitle job={job} />
      </header>

      <section className="mb-6">
        <AnimatePresence mode="wait" initial={false}>
          {(job.status === "queued" || job.status === "syncing") ? (
            <motion.div
              key="progress"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <SyncProgressPanel job={job} />
            </motion.div>
          ) : (
            <motion.div
              key="patch"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <SyncPatchPanel job={job} />
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {isFailed && job.error && <Banner kind="error" text={job.error} />}
      {err && <Banner kind="error" text={err} />}

      {(isDone || canRetry) && (
        <div className="flex flex-wrap gap-3 border-t border-rule pt-5">
          {showQuickRender && (
            <ChunkyButton variant="primary" size="lg" onClick={onQuickRender}>
              {canRetry ? "Retry quick render" : "Quick render"}
            </ChunkyButton>
          )}
          {job.mode === "longform" ? (
            <LongformStageButtons
              job={job}
              isPrimary={!showQuickRender}
              onNavigate={(route) => navigate(jobRoutePath(job.id, route))}
            />
          ) : (
            <ChunkyButton
              variant={showQuickRender ? "secondary" : "primary"}
              size="lg"
              onClick={() => navigate(jobRoutePath(job.id, nextRouteForJob(job)))}
            >
              {nextRouteLabel(nextRouteForJob(job))}
            </ChunkyButton>
          )}
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={`${job.title || job.id}.mp4`}
              className="inline-flex items-center gap-2 h-12 px-5 rounded-md bg-cobalt text-paper-hi font-display tracking-label uppercase text-xs hover:bg-cobalt/90"
            >
              <DownloadIcon className="w-4 h-4" />
              Download MP4
            </a>
          )}
          <ChunkyButton variant="ghost" size="lg" onClick={onDelete}>
            Delete
          </ChunkyButton>
        </div>
      )}

      {/* Sync also failed — only recovery is to delete and retry the upload. */}
      {isFailed && !job.sync && (
        <div className="flex flex-wrap gap-3 border-t border-rule pt-5">
          <ChunkyButton variant="ghost" size="lg" onClick={onDelete}>
            Delete and start over
          </ChunkyButton>
        </div>
      )}
    </main>
  );
}

function nextRouteLabel(route: ReturnType<typeof nextRouteForJob>): string {
  switch (route) {
    case "triage":
      return "Continue → Triage";
    case "arrange":
      return "Continue → Arrange";
    case "edit":
    default:
      return "Open editor";
  }
}

/**
 * Long-form jobs walk Triage → Arrange → Editor. Once a job has
 * graduated past a phase the user typically still wants to be able to
 * jump back into it (re-curate chunks, tweak the arrangement) without
 * losing the editor state. We surface all reachable phases as buttons,
 * highlighting the most-recent one as primary so a single click on
 * "open" still lands them where they were.
 */
function LongformStageButtons({
  job,
  isPrimary,
  onNavigate,
}: {
  job: LocalJob;
  isPrimary: boolean;
  onNavigate: (route: "triage" | "arrange" | "edit") => void;
}) {
  const arrangementDefined = job.arrangement !== undefined;
  const arrangementHasItems = (job.arrangement?.length ?? 0) > 0;
  // The "default" stage = the furthest one the user can land in.
  // Highlighting that one as primary keeps the muscle memory of the
  // single Continue button while still exposing the others.
  const defaultStage = nextRouteForJob(job);

  type Stage = { route: "triage" | "arrange" | "edit"; label: string; reachable: boolean };
  const stages: Stage[] = [
    { route: "triage", label: "Triage", reachable: true },
    { route: "arrange", label: "Arrange", reachable: arrangementDefined },
    { route: "edit", label: "Editor", reachable: arrangementHasItems },
  ];

  return (
    <>
      {stages
        .filter((s) => s.reachable)
        .map((s) => (
          <ChunkyButton
            key={s.route}
            variant={
              s.route === defaultStage
                ? isPrimary
                  ? "primary"
                  : "secondary"
                : "ghost"
            }
            size="lg"
            onClick={() => onNavigate(s.route)}
          >
            {s.label}
          </ChunkyButton>
        ))}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="font-mono text-[10px] tracking-label uppercase text-ink-2 bg-paper-hi border border-rule rounded-full px-2 py-0.5">
      {status}
    </span>
  );
}

/**
 * Subtitle — one line under the title summarising the job at a glance.
 * Uniform across cam counts: "{N} cam{s} · {audioFilename}". The cam
 * filenames live in the Sync Patch Panel below.
 */
function JobSubtitle({ job }: { job: LocalJob }) {
  const camCount = job.videos?.length ?? (job.videoFilename ? 1 : 0);
  return (
    <p className="font-mono text-xs text-ink-2 truncate">
      {camCount} cam{camCount === 1 ? "" : "s"} · {job.audioFilename}
    </p>
  );
}

function Banner({ kind, text }: { kind: "error"; text: string }) {
  return (
    <div
      className={[
        "border-l-2 pl-3 py-2 text-sm font-mono",
        kind === "error" ? "border-danger text-danger" : "",
      ].join(" ")}
    >
      {text}
    </div>
  );
}
