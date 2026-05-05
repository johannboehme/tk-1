/**
 * Cross-cutting lifecycle helpers for the local-jobs runtime:
 *
 *   1. `installRenderUnloadGuard` / `removeRenderUnloadGuard` — manage a
 *      `beforeunload` listener that warns the user if they try to leave
 *      while a render is running.
 *
 *   2. `requestPersistentStorage` — asks the browser to mark our OPFS
 *      bucket as "persistent" so it doesn't get evicted under storage
 *      pressure. Called once on first user write.
 *
 *   3. `pruneIfQuotaTight` — best-effort OPFS quota guard: if usage
 *      exceeds the high-water mark, delete the oldest finished jobs until
 *      we're back under the low-water mark.
 *
 * No "mark interrupted" pass: lifecycle progress lives in the in-memory
 * `useOpsStore` which is empty after a page reload. Persisted job rows
 * carry only data (sync result, chunks, arrangement, lastRender). A row
 * lacking `videos[].sync` is simply "needs sync"; the user can re-run.
 */

import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";

const HIGH_WATER = 0.8; // start pruning above 80% used
const LOW_WATER = 0.6; // prune down to 60%

const ACTIVE_RENDER_JOBS = new Set<string>();
let unloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

function ensureUnloadHandler(): void {
  if (unloadHandler) return;
  unloadHandler = (e: BeforeUnloadEvent) => {
    if (ACTIVE_RENDER_JOBS.size === 0) return;
    e.preventDefault();
    // Modern browsers ignore the message but show a generic warning.
    // We set returnValue for older Chromium / Safari compatibility.
    e.returnValue =
      "A render is still running — leaving will discard the result.";
    return e.returnValue;
  };
  window.addEventListener("beforeunload", unloadHandler);
}

export function installRenderUnloadGuard(jobId: string): void {
  ACTIVE_RENDER_JOBS.add(jobId);
  ensureUnloadHandler();
}

export function removeRenderUnloadGuard(jobId: string): void {
  ACTIVE_RENDER_JOBS.delete(jobId);
}

export function activeRenderJobsForTest(): ReadonlySet<string> {
  return ACTIVE_RENDER_JOBS;
}

let persistRequested = false;

export async function requestPersistentStorage(): Promise<boolean> {
  if (persistRequested) return true;
  persistRequested = true;
  try {
    if (!navigator.storage?.persist) return false;
    const already = await navigator.storage.persisted?.();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * If the OPFS bucket is over `HIGH_WATER`, delete the oldest "completed"
 * jobs — those that already produced an output (`lastRender` set) —
 * until usage drops back to `LOW_WATER`. Returns the number of jobs
 * pruned. Excludes the `protectedJobIds` the caller is about to use.
 *
 * Best-effort: `navigator.storage.estimate()` returns aggregate browser
 * data, not just OPFS, so we use a conservative trigger threshold.
 */
export async function pruneIfQuotaTight(
  protectedJobIds: ReadonlyArray<string> = [],
): Promise<number> {
  const protectedSet = new Set(protectedJobIds);
  let estimate: { quota?: number; usage?: number };
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return 0;
  }
  const quota = estimate.quota ?? 0;
  const usage = estimate.usage ?? 0;
  if (quota <= 0) return 0;
  if (usage / quota < HIGH_WATER) return 0;

  // Prune candidates: jobs with a finished render, oldest first. A job
  // without `lastRender` could be in any phase the user still cares
  // about (mid-triage, mid-arrange) — too risky to delete out from
  // under them without an explicit signal.
  const all = await jobsDb.listJobs();
  const candidates = all
    .filter((j: LocalJob) => !protectedSet.has(j.id) && Boolean(j.lastRender))
    .sort((a, b) => a.createdAt - b.createdAt);

  const targetBytes = quota * LOW_WATER;
  let pruned = 0;
  for (const job of candidates) {
    await opfs.deletePath(`jobs/${job.id}`).catch(() => undefined);
    await jobsDb.deleteJob(job.id);
    pruned++;
    try {
      const next = await navigator.storage.estimate();
      if ((next.usage ?? 0) <= targetBytes) break;
    } catch {
      break;
    }
  }
  return pruned;
}
