import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { RuleStrip } from "../editor/components/RuleStrip";
import { TrashIcon } from "../editor/components/icons";
import { formatDuration } from "../components/ProgressBar";
import { jobsDb, deleteJob, jobEvents, type LocalJob } from "../local/jobs";
import { useOpsStore, type JobOps } from "../local/ops-store";
import { isVideoAsset } from "../storage/jobs-db";

export default function History() {
  const [jobs, setJobs] = useState<LocalJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await jobsDb.listJobs();
        if (!cancelled) setJobs(next);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    };
    load();

    // Auto-refresh on any job event so progress bars tick during active jobs.
    const onUpdate = () => load();
    jobEvents.addEventListener("update", onUpdate);
    return () => {
      cancelled = true;
      jobEvents.removeEventListener("update", onUpdate);
    };
  }, []);

  async function remove(id: string) {
    if (!window.confirm("Delete this job and its files?")) return;
    await deleteJob(id);
    setJobs((curr) => (curr ? curr.filter((j) => j.id !== id) : curr));
  }

  if (err)
    return (
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10">
        <p className="font-mono text-sm text-danger">{err}</p>
      </main>
    );
  if (!jobs)
    return (
      <main className="flex-1 flex items-center justify-center">
        <span className="font-mono text-xs text-ink-2 tracking-label uppercase">
          Loading…
        </span>
      </main>
    );

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <header className="mb-6 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tracking-label uppercase text-ink-2">
            HISTORY · {String(jobs.length).padStart(2, "0")}
          </span>
          <RuleStrip count={32} className="text-rule flex-1 max-w-[200px]" />
        </div>
        <div className="flex items-end justify-between gap-3">
          <h1 className="font-display font-semibold text-3xl sm:text-5xl text-ink leading-none">
            Your jobs
          </h1>
          <Link to="/" className="hidden sm:block">
            <ChunkyButton variant="primary" size="md">
              + New
            </ChunkyButton>
          </Link>
        </div>
      </header>

      {jobs.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} onDelete={() => remove(j.id)} />
          ))}
        </ul>
      )}
    </main>
  );
}

type BadgeKind = "queued" | "syncing" | "rendering" | "rendered" | "synced" | "failed" | "needs-sync";

function jobBadge(job: LocalJob, ops: JobOps | undefined): BadgeKind {
  if (ops?.render && !ops.render.error) return "rendering";
  if (ops?.sync && !ops.sync.error) return "syncing";
  if (ops?.render?.error || ops?.sync?.error) return "failed";
  const cams = job.videos ?? [];
  const hasSyncData =
    cams.length > 0 && cams.every((c) => !isVideoAsset(c) || Boolean(c.sync));
  if (job.lastRender) return "rendered";
  if (hasSyncData) return "synced";
  return "needs-sync";
}

function activePct(ops: JobOps | undefined): number | null {
  if (ops?.render) return ops.render.pct;
  if (ops?.sync) return ops.sync.pct;
  return null;
}

function JobCard({ job, onDelete }: { job: LocalJob; onDelete: () => void }) {
  const ops = useOpsStore((s) => s.ops[job.id]);
  const pct = activePct(ops);
  const badge = jobBadge(job, ops);
  return (
    <li className="group relative bg-paper-hi border border-rule rounded-lg overflow-hidden hover:border-ink-2 transition-colors">
      <Link to={`/job/${job.id}`} className="block">
        <div className="aspect-[16/7] bg-sunken overflow-hidden relative">
          <div className="absolute top-2 left-2 flex items-center gap-1.5">
            <StatusBadge kind={badge} />
          </div>
          {job.durationS != null && (
            <span className="absolute bottom-2 right-2 font-mono text-[10px] tabular tracking-label uppercase text-paper-hi bg-sunken/70 px-1.5 py-0.5 rounded-sm">
              {formatDuration(job.durationS)}
            </span>
          )}
        </div>

        <div className="p-3 flex flex-col gap-2">
          <h2 className="font-display font-semibold text-base text-ink truncate">
            {job.title || job.id.slice(0, 12)}
          </h2>
          <div className="flex items-center justify-between font-mono text-[11px] tabular text-ink-2">
            <span>{new Date(job.createdAt).toLocaleString()}</span>
            {job.sync?.offsetMs != null && (
              <span className="text-hot">
                {job.sync.offsetMs > 0 ? "+" : ""}
                {job.sync.offsetMs.toFixed(0)}ms
              </span>
            )}
          </div>

          {pct !== null && (
            <div className="flex items-center gap-2 mt-1">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                className="flex-1 h-1 bg-paper-deep rounded-full overflow-hidden"
              >
                <div
                  className="h-full bg-hot transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="font-mono text-[10px] tabular text-ink-2 shrink-0">
                {Math.round(pct)}%
              </span>
            </div>
          )}
        </div>
      </Link>
      <button
        onClick={(e) => {
          e.preventDefault();
          onDelete();
        }}
        className="absolute top-2 right-2 h-7 w-7 inline-flex items-center justify-center rounded-md bg-paper-hi/90 backdrop-blur text-ink-2 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Delete job"
      >
        <TrashIcon width={14} height={14} />
      </button>
    </li>
  );
}

function StatusBadge({ kind }: { kind: BadgeKind }) {
  const map: Record<BadgeKind, { bg: string; text: string }> = {
    queued: { bg: "bg-ink/80 text-paper-hi", text: "QUEUED" },
    syncing: { bg: "bg-hot/90 text-paper-hi", text: "SYNC" },
    synced: { bg: "bg-success/80 text-paper-hi", text: "SYNCED" },
    rendering: { bg: "bg-hot/90 text-paper-hi", text: "RENDER" },
    rendered: { bg: "bg-success/90 text-paper-hi", text: "DONE" },
    failed: { bg: "bg-danger/90 text-paper-hi", text: "FAIL" },
    "needs-sync": { bg: "bg-ink/40 text-paper-hi", text: "NEW" },
  };
  const it = map[kind];
  return (
    <span
      className={[
        "inline-flex items-center h-5 px-1.5 rounded-sm font-mono text-[10px] tracking-label uppercase",
        it.bg,
      ].join(" ")}
    >
      {it.text}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="grid sm:grid-cols-[1.2fr_1fr] gap-6 sm:gap-8 items-center bg-paper-hi border border-rule rounded-lg p-8 sm:p-12">
      <div>
        <span className="label mb-3 block">Nothing here yet</span>
        <h2 className="font-display font-semibold text-3xl sm:text-4xl leading-tight text-ink mb-3">
          No jobs.
          <br />
          <span className="text-hot">Drop a video.</span>
        </h2>
        <p className="text-ink-2 max-w-sm mb-5">
          Upload your first phone-or-glasses video plus the matching studio
          audio. Sync runs locally in seconds.
        </p>
        <Link to="/">
          <ChunkyButton variant="primary" size="md">
            + Upload
          </ChunkyButton>
        </Link>
      </div>
    </div>
  );
}
