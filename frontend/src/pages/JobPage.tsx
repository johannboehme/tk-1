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
import { isVideoAsset, type VideoAsset } from "../storage/jobs-db";

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
          <ChunkyButton
            variant={showQuickRender ? "secondary" : "primary"}
            size="lg"
            onClick={() => navigate(jobRoutePath(job.id, nextRouteForJob(job)))}
          >
            {nextRouteLabel(nextRouteForJob(job))}
          </ChunkyButton>
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

/**
 * Sync Patch Panel — uniform per-cam patchbay, regardless of cam count.
 *
 * One row per cam, hardware look that matches the timeline's Lane-Headers:
 * cam-color stripe + cam name + filename + OFFSET + DRIFT + a 3-LED
 * confidence bar matching the Tally aesthetic. Reads each cam's sync from
 * `job.videos[i].sync` directly — single source of truth, no mirror layer.
 */
function SyncPatchPanel({ job }: { job: LocalJob }) {
  // Image cams have no sync result — they're not part of this panel.
  const videos: VideoAsset[] = (job.videos ?? []).filter(isVideoAsset);

  if (videos.length === 0) {
    return (
      <div className="rounded-md border border-rule px-4 py-6 text-center font-mono text-xs text-ink-3">
        No cams yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <div className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-2">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          {videos.length === 1 ? "Sync" : `Sync · ${videos.length} cams`}
        </span>
        <RuleStrip count={20} className="text-rule flex-1 max-w-[180px]" />
      </div>
      {/* Desktop / wider tablets: 5-column grid. */}
      <div className="hidden sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto] gap-x-4">
        <HeaderCell>CAM</HeaderCell>
        <HeaderCell>SOURCE</HeaderCell>
        <HeaderCell align="right">OFFSET</HeaderCell>
        <HeaderCell align="right">DRIFT</HeaderCell>
        <HeaderCell align="right">CONF</HeaderCell>
        {videos.map((cam, i) => (
          <SyncRow
            key={cam.id}
            cam={cam}
            index={i}
            last={i === videos.length - 1}
          />
        ))}
      </div>
      {/* Narrow phones: stacked card per cam — labels render inline so the
       *  numeric columns can't overflow. */}
      <div className="sm:hidden">
        {videos.map((cam, i) => (
          <SyncCard
            key={cam.id}
            cam={cam}
            index={i}
            last={i === videos.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function HeaderCell({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div
      className={[
        "px-3 py-2 font-display tracking-label uppercase text-[10px] text-ink-3 border-b border-rule bg-paper-panel/60",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function SyncRow({
  cam,
  index,
  last,
}: {
  cam: VideoAsset;
  index: number;
  last: boolean;
}) {
  const sync = cam.sync;
  const border = last ? "" : "border-b border-rule/50";
  return (
    <>
      {/* CAM cell — color stripe + name */}
      <div className={`px-3 py-3 ${border} flex items-center gap-2`}>
        <span
          className="w-1.5 h-7 rounded-sm shrink-0"
          style={{
            background: cam.color,
            boxShadow: `0 0 4px ${cam.color}55`,
          }}
        />
        <span className="font-display font-semibold text-xs tracking-label uppercase">
          Cam {index + 1}
        </span>
      </div>
      {/* SOURCE cell — filename */}
      <div
        className={`px-3 py-3 ${border} font-mono text-xs text-ink-2 truncate self-center min-w-0`}
        title={cam.filename}
      >
        {cam.filename}
      </div>
      {/* OFFSET */}
      <div className={`px-3 py-3 ${border} text-right font-mono tabular text-ink self-center`}>
        {sync ? `${sync.offsetMs.toFixed(1)} ms` : "—"}
      </div>
      {/* DRIFT */}
      <div className={`px-3 py-3 ${border} text-right font-mono tabular text-ink self-center`}>
        {sync ? `${((sync.driftRatio - 1) * 100).toFixed(3)}%` : "—"}
      </div>
      {/* CONFIDENCE — three-LED bar like a hardware tally */}
      <div className={`px-3 py-3 ${border} text-right self-center`}>
        {sync ? (
          <ConfidenceLeds value={sync.confidence} />
        ) : (
          <span className="font-mono text-ink-3">—</span>
        )}
      </div>
    </>
  );
}

/**
 * Mobile-only stacked card per cam. Renders the same data as SyncRow but
 * label-value pairs flow vertically so OFFSET/DRIFT/CONF can never push
 * the row past the viewport on a narrow phone.
 */
function SyncCard({
  cam,
  index,
  last,
}: {
  cam: VideoAsset;
  index: number;
  last: boolean;
}) {
  const sync = cam.sync;
  const border = last ? "" : "border-b border-rule/50";
  return (
    <div className={`px-3 py-3 ${border}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="w-1.5 h-7 rounded-sm shrink-0"
          style={{
            background: cam.color,
            boxShadow: `0 0 4px ${cam.color}55`,
          }}
        />
        <span className="font-display font-semibold text-xs tracking-label uppercase shrink-0">
          Cam {index + 1}
        </span>
        <span
          className="font-mono text-xs text-ink-2 truncate min-w-0"
          title={cam.filename}
        >
          {cam.filename}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] pl-3.5">
        <span className="font-display tracking-label uppercase text-ink-3">Offset</span>
        <span className="font-mono tabular text-ink text-right">
          {sync ? `${sync.offsetMs.toFixed(1)} ms` : "—"}
        </span>
        <span className="font-display tracking-label uppercase text-ink-3">Drift</span>
        <span className="font-mono tabular text-ink text-right">
          {sync ? `${((sync.driftRatio - 1) * 100).toFixed(3)}%` : "—"}
        </span>
        <span className="font-display tracking-label uppercase text-ink-3">Conf</span>
        <span className="text-right">
          {sync ? <ConfidenceLeds value={sync.confidence} /> : <span className="font-mono text-ink-3">—</span>}
        </span>
      </div>
    </div>
  );
}

/** 3-LED confidence indicator. Matches the analog Tally aesthetic of the
 * Lane-Headers in the timeline. */
function ConfidenceLeds({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  // High >= 70, Mid 30..70, Low < 30
  const lit = value >= 0.7 ? 3 : value >= 0.3 ? 2 : 1;
  const color = lit === 3 ? "#34D399" : lit === 2 ? "#FFB020" : "#FF3326";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="block w-[6px] h-[6px] rounded-full"
            style={{
              background: i < lit ? color : "#3A352E",
              boxShadow: i < lit ? `0 0 4px ${color}` : "none",
              opacity: i < lit ? 1 : 0.35,
            }}
          />
        ))}
      </span>
      <span className="font-mono tabular text-ink text-xs">{pct}%</span>
    </span>
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
