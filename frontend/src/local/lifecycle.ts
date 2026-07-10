/**
 * Cross-cutting lifecycle helpers for the local-jobs runtime:
 *
 *   1. `installRenderUnloadGuard` / `removeRenderUnloadGuard` (and the
 *      sync twins) — manage a `beforeunload` listener that warns the
 *      user if they try to leave while a render or sync is running.
 *
 *   2. `requestPersistentStorage` — asks the browser to mark our OPFS
 *      bucket as "persistent" so it doesn't get evicted under storage
 *      pressure. Called once on first user write.
 *
 *   3. `maybePromptQuotaPrune` — consent-based OPFS quota guard: if usage
 *      exceeds the high-water mark, propose deleting the oldest finished
 *      jobs (down to the low-water mark) and ask the user first. Nothing
 *      is ever deleted silently (#64).
 *
 * No "mark interrupted" pass: lifecycle progress lives in the in-memory
 * `useOpsStore` which is empty after a page reload. Persisted job rows
 * carry only data (sync result, chunks, arrangement, lastRender). A row
 * lacking `videos[].sync` is simply "needs sync"; the user can re-run.
 */

import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";
import { promptQuotaPrune } from "./quota-consent";

const HIGH_WATER = 0.8; // start pruning above 80% used
const LOW_WATER = 0.6; // prune down to 60%

const ACTIVE_RENDER_JOBS = new Set<string>();
const ACTIVE_SYNC_JOBS = new Set<string>();
let unloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

function ensureUnloadHandler(): void {
  if (unloadHandler) return;
  unloadHandler = (e: BeforeUnloadEvent) => {
    if (ACTIVE_RENDER_JOBS.size === 0 && ACTIVE_SYNC_JOBS.size === 0) return;
    e.preventDefault();
    // Modern browsers ignore the message but show a generic warning.
    // We set returnValue for older Chromium / Safari compatibility.
    e.returnValue =
      ACTIVE_RENDER_JOBS.size > 0
        ? "A render is still running — leaving will discard the result."
        : "A sync is still running — leaving will discard its progress.";
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

/** Same warn-on-leave mechanism for syncs (#65): a multi-minute sync
 *  lives only in the in-memory ops store, so an accidental reload used
 *  to silently discard it (and strand the job at "needs sync"). */
export function installSyncUnloadGuard(jobId: string): void {
  ACTIVE_SYNC_JOBS.add(jobId);
  ensureUnloadHandler();
}

export function removeSyncUnloadGuard(jobId: string): void {
  ACTIVE_SYNC_JOBS.delete(jobId);
}

export function activeSyncJobsForTest(): ReadonlySet<string> {
  return ACTIVE_SYNC_JOBS;
}

/**
 * Delete `jobs/*` OPFS directories that no IndexedDB row references
 * (#119). Such orphans appear when a createJob failed mid-copy in an
 * older build, or when the row write itself failed — they are invisible
 * in History, unreachable by deleteJob, and permanently eat quota.
 *
 * Directories whose newest file is younger than `ORPHAN_MIN_AGE_MS` are
 * spared: they may belong to a createJob currently copying files in
 * another tab (the row is only written after all copies finish).
 *
 * Returns the number of directories removed. Best-effort per directory.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export async function sweepOrphanJobDirs(nowMs = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await opfs.list("jobs");
  } catch {
    return 0;
  }
  const dirs = entries
    .filter((e) => e.endsWith("/"))
    .map((e) => e.slice(0, -1));
  if (dirs.length === 0) return 0;

  const known = new Set((await jobsDb.listJobs()).map((j) => j.id));
  let removed = 0;
  for (const dir of dirs) {
    if (known.has(dir)) continue;
    try {
      const { newestModifiedMs } = await opfs.dirStats(`jobs/${dir}`);
      if (
        newestModifiedMs !== null &&
        nowMs - newestModifiedMs < ORPHAN_MIN_AGE_MS
      ) {
        continue; // possibly mid-createJob in another tab
      }
      await opfs.deletePath(`jobs/${dir}`);
      removed++;
    } catch {
      // best-effort — skip this dir, try the others
    }
  }
  return removed;
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

/** One project the quota guard proposes to delete — id + display bits +
 *  its measured OPFS footprint. */
export interface PruneCandidate {
  id: string;
  title: string | null;
  createdAt: number;
  bytes: number;
}

/**
 * Pure planner for the consent-based quota guard (#64): given the prune
 * candidates (finished projects, with their measured OPFS sizes) and the
 * current usage/quota, return the oldest-first subset whose deletion
 * would bring usage back under `LOW_WATER`. Returns everything when even
 * that is not enough (best effort), and nothing when usage is fine.
 *
 * The result is exactly what the consent dialog lists — nothing outside
 * the returned plan is ever deleted.
 */
export function planQuotaPrune(
  candidates: ReadonlyArray<PruneCandidate>,
  usageBytes: number,
  quotaBytes: number,
): PruneCandidate[] {
  if (quotaBytes <= 0 || usageBytes / quotaBytes < HIGH_WATER) return [];
  const needBytes = usageBytes - quotaBytes * LOW_WATER;
  const sorted = [...candidates].sort((a, b) => a.createdAt - b.createdAt);
  const plan: PruneCandidate[] = [];
  let freed = 0;
  for (const c of sorted) {
    if (freed >= needBytes) break;
    plan.push(c);
    freed += c.bytes;
  }
  return plan;
}

/**
 * Consent-based storage guard, run before committing big new files
 * (#64). When origin storage is above `HIGH_WATER`, this proposes
 * deleting the oldest finished projects (those with a `lastRender`) and
 * asks the user via a blocking dialog — listing each project by name,
 * age, and size. Nothing is deleted without an explicit confirmation;
 * declining simply proceeds (a later OPFS write may then fail with a
 * clear storage error, which beats silent data loss).
 *
 * 'Has a render' does not mean 'user is done with it' — the row behind
 * that render still carries live edits — which is exactly why this asks
 * instead of pruning silently.
 *
 * Returns the number of projects actually deleted. Deletion walks the
 * confirmed plan oldest-first and stops early once the estimate is back
 * under `LOW_WATER`, so it never removes more than the user approved
 * and often less.
 */
export async function maybePromptQuotaPrune(
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
  if (quota <= 0 || usage / quota < HIGH_WATER) return 0;

  // Prune candidates: jobs with a finished render, oldest first. A job
  // without `lastRender` could be in any phase the user still cares
  // about (mid-triage, mid-arrange) — never proposed for deletion.
  const all = await jobsDb.listJobs();
  const withRender = all.filter(
    (j: LocalJob) => !protectedSet.has(j.id) && Boolean(j.lastRender),
  );
  if (withRender.length === 0) return 0;

  const candidates: PruneCandidate[] = [];
  for (const job of withRender) {
    let bytes = 0;
    try {
      bytes = (await opfs.dirStats(`jobs/${job.id}`)).bytes;
    } catch {
      // size unknown — still a valid candidate, just listed as 0 B
    }
    candidates.push({
      id: job.id,
      title: job.title,
      createdAt: job.createdAt,
      bytes,
    });
  }

  const plan = planQuotaPrune(candidates, usage, quota);
  if (plan.length === 0) return 0;

  const confirmed = await promptQuotaPrune({
    plan,
    usageBytes: usage,
    quotaBytes: quota,
  });
  if (!confirmed) return 0;

  const targetBytes = quota * LOW_WATER;
  let pruned = 0;
  for (const job of plan) {
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
