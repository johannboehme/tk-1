import { useEffect, useMemo, useState } from "react";
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
import { useSyncOp } from "../local/ops-store";
import { isVideoAsset } from "../storage/jobs-db";
import { SyncPatchPanel } from "../components/sync/SyncPatchPanel";

export default function JobPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<LocalJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const syncOp = useSyncOp(id);

  // Derived state — phase comes from data + ops, never a status enum.
  const hasSyncData = useMemo(() => {
    const cams = job?.videos ?? [];
    if (cams.length === 0) return false;
    return cams.every((c) => !isVideoAsset(c) || Boolean(c.sync));
  }, [job?.videos]);
  const isSyncing = Boolean(syncOp) && !syncOp?.error;
  const syncFailed = Boolean(syncOp?.error);
  const hasOutput = Boolean(job?.lastRender);

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
    if (!job?.lastRender) return;
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
  }, [job?.lastRender, job?.id]);

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

  // "Ready to use" = sync result is on the job. Either freshly
  // produced (op finished, hasSyncData) or rehydrated from history.
  const isDone = hasSyncData && !isSyncing;
  // A failed sync op with `videos[].sync` already filled is recoverable
  // — the sync data lets the user re-enter the editor or kick off
  // another render attempt without redoing the upload + analysis.
  const canRetry = syncFailed && hasSyncData;
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
          <StatusBadge
            label={statusLabel({ isSyncing, syncFailed, hasSyncData, hasOutput })}
          />
        </div>
        <h1 className="font-display font-semibold text-3xl sm:text-4xl text-ink truncate">
          {job.title || job.id}
        </h1>
        <JobSubtitle job={job} />
      </header>

      <section className="mb-6">
        <AnimatePresence mode="wait" initial={false}>
          {isSyncing ? (
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

      {syncFailed && syncOp?.error && (
        <Banner kind="error" text={syncOp.error} details={syncOp.errorReport} />
      )}
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

      {/* Sync failed without producing any data — only recovery is to delete and retry. */}
      {syncFailed && !hasSyncData && (
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

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="font-mono text-[10px] tracking-label uppercase text-ink-2 bg-paper-hi border border-rule rounded-full px-2 py-0.5">
      {label}
    </span>
  );
}

function statusLabel(args: {
  isSyncing: boolean;
  syncFailed: boolean;
  hasSyncData: boolean;
  hasOutput: boolean;
}): string {
  if (args.isSyncing) return "syncing";
  if (args.syncFailed) return "failed";
  if (args.hasOutput) return "rendered";
  if (args.hasSyncData) return "synced";
  return "needs sync";
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

function Banner({
  kind,
  text,
  details,
}: {
  kind: "error";
  text: string;
  /** Optional multi-line plaintext diagnostic. When set, the banner
   *  shows a "Show details" toggle + "Copy details" affordance so the
   *  user can ship the report to us without poking around devtools. */
  details?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API can refuse in non-secure contexts; the user can
      // still select + copy from the open <pre> in that case.
    }
  }

  return (
    <div
      className={[
        "border-l-2 pl-3 py-2 text-sm font-mono",
        kind === "error" ? "border-danger text-danger" : "",
      ].join(" ")}
    >
      <div>{text}</div>
      {details && (
        <div className="mt-1 flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="underline underline-offset-2 hover:opacity-80"
          >
            {open ? "Hide details" : "Show details"}
          </button>
          <button
            type="button"
            onClick={copy}
            className="underline underline-offset-2 hover:opacity-80"
          >
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      )}
      {details && open && (
        <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-ink-2 bg-paper-hi border border-rule rounded p-3 max-h-80 overflow-auto">
          {details}
        </pre>
      )}
    </div>
  );
}
