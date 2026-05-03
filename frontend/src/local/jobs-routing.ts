/**
 * Decide which workflow screen a job should land on after upload (or
 * after a navigation to its bare `/job/:id` route).
 *
 * Direct-mode jobs always go to the editor — that's the legacy path.
 * Long-form-session jobs walk the three-phase flow:
 *   1. Triage   — until at least one chunk has been detected & curated
 *   2. Arrange  — once chunks exist but no arrangement has been built
 *   3. Editor   — once an arrangement is in place
 *
 * The user can navigate backwards explicitly (e.g. tap the breadcrumb)
 * — this helper only governs the "what's next?" default.
 */

import type { LocalJob } from "../storage/jobs-db";

export type JobRoute = "edit" | "triage" | "arrange";

export function nextRouteForJob(job: LocalJob): JobRoute {
  if (job.mode !== "longform") return "edit";
  const hasChunks = (job.chunks?.length ?? 0) > 0;
  if (!hasChunks) return "triage";
  const hasArrangement = (job.arrangement?.length ?? 0) > 0;
  if (!hasArrangement) return "arrange";
  return "edit";
}

/** Build the URL path for a given job + route. Concentrated here so the
 *  route shape stays in one place if we ever change the URL scheme. */
export function jobRoutePath(jobId: string, route: JobRoute): string {
  return `/job/${jobId}/${route}`;
}
