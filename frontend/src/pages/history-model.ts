/**
 * Pure derivation of a History card's badge + progress state from the
 * persisted job and its transient ops. Kept free of React so the
 * lifecycle rules ("done is terminal", "a cancel is not a failure") are
 * unit-testable.
 */
import type { JobOps, RenderOpState, SyncOpState } from "../local/ops-store";
import { isVideoAsset, type LocalJob } from "../storage/jobs-db";

export type BadgeKind =
  | "queued"
  | "syncing"
  | "rendering"
  | "rendered"
  | "synced"
  | "failed"
  | "needs-sync";

/** A render op counts as live only until it errors or completes.
 *  (Plain boolean, not a type predicate — "not live" doesn't mean
 *  "absent", it can also be a done/failed op.) */
function isLiveRender(op: RenderOpState | undefined): boolean {
  return Boolean(op) && !op!.error && !op!.done;
}

/** Sync ops are cleared on completion, so "live" just means "no error". */
function isLiveSync(op: SyncOpState | undefined): boolean {
  return Boolean(op) && !op!.error;
}

/** cancelEditRender flags the op with this sentinel error. A deliberate
 *  cancel is not a failure — the badge falls back to the data-derived
 *  state instead of FAIL. */
function isCancelledRender(op: RenderOpState | undefined): boolean {
  return op?.error === "cancelled";
}

export function jobBadge(job: LocalJob, ops: JobOps | undefined): BadgeKind {
  if (isLiveRender(ops?.render)) return "rendering";
  if (isLiveSync(ops?.sync)) return "syncing";
  const renderFailed =
    Boolean(ops?.render?.error) && !isCancelledRender(ops?.render);
  if (renderFailed || ops?.sync?.error) return "failed";
  const cams = job.videos ?? [];
  const hasSyncData =
    cams.length > 0 && cams.every((c) => !isVideoAsset(c) || Boolean(c.sync));
  if (job.lastRender) return "rendered";
  if (hasSyncData) return "synced";
  return "needs-sync";
}

/** Progress to show on the card — only for ops that are actually moving.
 *  Terminal ops (done / errored) return null so no frozen bar lingers. */
export function activePct(ops: JobOps | undefined): number | null {
  if (ops?.render && isLiveRender(ops.render)) return ops.render.pct;
  if (ops?.sync && isLiveSync(ops.sync)) return ops.sync.pct;
  return null;
}
