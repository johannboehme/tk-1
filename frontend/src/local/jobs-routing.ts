/**
 * Decide which workflow screen a job should land on after upload (or
 * after a navigation to its bare `/job/:id` route).
 *
 * Direct-mode jobs always go to the editor — that's the legacy path.
 * Long-form-session jobs walk the three-phase flow:
 *   1. Triage   — review/curate auto-detected chunks
 *   2. Arrange  — order the kept chunks into a sequence
 *   3. Editor   — open the song
 *
 * "Triage done" is signalled by `arrangement` being defined (even if
 * empty). Auto-detected chunks alone aren't enough — the user has to
 * actively click "Continue → Arrange" in Triage, which seeds the
 * arrangement and graduates the job to the next step. A non-empty
 * `arrangement` then means "ready for the editor".
 *
 * The user can navigate backwards explicitly (e.g. tap the breadcrumb)
 * — this helper only governs the "what's next?" default.
 */

import type { LocalJob } from "../storage/jobs-db";

export type JobRoute = "edit" | "triage" | "arrange";

export function nextRouteForJob(job: LocalJob): JobRoute {
  if (job.mode !== "longform") return "edit";
  // arrangement === undefined → user hasn't graduated past Triage yet,
  // even if chunks were auto-detected during sync.
  if (job.arrangement === undefined) return "triage";
  // arrangement is defined but no items in it → user is in the
  // arrange phase but hasn't built the sequence yet.
  if (job.arrangement.length === 0) return "arrange";
  return "edit";
}

/** Build the URL path for a given job + route. Concentrated here so the
 *  route shape stays in one place if we ever change the URL scheme. */
export function jobRoutePath(jobId: string, route: JobRoute): string {
  return `/job/${jobId}/${route}`;
}
