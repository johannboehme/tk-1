/**
 * Arrange-page actions that may destroy editor work, gated through
 * confirm dialogs.
 *
 * Removing an item drops every pill tied to that arrangement-item id
 * and any cuts/fx whose timeline range overlaps those pills. We warn
 * before pulling the trigger so the user doesn't lose hours of edits
 * to a stray Backspace.
 *
 * Duplicating an item that has user edits copies pills + cuts + fx
 * onto the new item with translated timeline ranges. Done here rather
 * than in the editor's reconcile so the duplicate is "live" the moment
 * the user presses the button.
 */
import { jobsDb } from "../jobs";
import { confirmDestructive } from "../../lib/confirm";
import { countEditsAffectedByItemRemoval } from "../edits-impact";
import { useArrangeStore } from "./arrange-store";
import {
  type ArrangementItem,
  type Cut,
  type PillRecord,
  type PunchFxRecord,
} from "../../storage/jobs-db";

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function impactSummary(parts: { cuts: number; fx: number; userEditedPills: number }): string {
  const bits: string[] = [];
  if (parts.cuts > 0) bits.push(pluralize(parts.cuts, "cut", "cuts"));
  if (parts.fx > 0) bits.push(pluralize(parts.fx, "FX entry", "FX entries"));
  if (parts.userEditedPills > 0)
    bits.push(pluralize(parts.userEditedPills, "edited pill", "edited pills"));
  return bits.join(", ");
}

export async function removeItemGuarded(itemId: string): Promise<void> {
  const state = useArrangeStore.getState();
  if (!state.jobId) return;

  const job = await jobsDb.getJob(state.jobId);
  const pills = job?.pills ?? [];
  const cuts = job?.cuts ?? [];
  const fx = job?.fx ?? [];
  const impact = countEditsAffectedByItemRemoval(itemId, pills, cuts, fx);

  const hasEdits =
    impact.cuts > 0 || impact.fx > 0 || impact.userEditedPills > 0;
  if (hasEdits) {
    const detail = impactSummary(impact);
    const ok = await confirmDestructive({
      title: "Delete item?",
      body: `Removing this item will also drop ${detail} from the editor.`,
      destructiveLabel: "Delete item",
    });
    if (!ok) return;
  }

  state.removeItem(itemId);

  if (hasEdits) {
    // Prune the job's pills / cuts / fx so the editor doesn't have to
    // reconcile away orphans on its next mount. (Reconcile would do
    // it, but writing here keeps IDB in shape and the next render
    // free of dangling references.)
    const pillRanges = pills
      .filter((p) => p.fromArrangementItemId === itemId)
      .map((p) => ({ startS: p.arrStartS, endS: p.arrEndS }));
    const overlaps = (atS: number) =>
      pillRanges.some((r) => atS >= r.startS && atS < r.endS);
    const overlapsRange = (inS: number, outS: number) =>
      pillRanges.some((r) => inS < r.endS && r.startS < outS);
    const nextPills = pills.filter(
      (p) => p.fromArrangementItemId !== itemId,
    );
    const nextCuts = cuts.filter((c) => !overlaps(c.atTimeS));
    const nextFx = fx.filter((f) => !overlapsRange(f.inS, f.outS));
    await jobsDb.updateJob(state.jobId, {
      pills: nextPills,
      cuts: nextCuts,
      fx: nextFx,
    });
  }
}

/**
 * Duplicate the focused arrangement-item AND copy any user-edited pills,
 * cuts, and fx tied to its timeline range over to the new item with
 * translated timestamps.
 *
 * Time-shift math: the new item is inserted immediately after the source.
 * Source-time (sourceInS / sourceOutS on pills) is independent of the
 * timeline — same cam material plays in both occurrences — so we keep
 * those values verbatim. Timeline-time on the source pills shifts by
 * exactly the source chunk's duration to hit the clone's slot. Cuts +
 * FX inside the source pill ranges shift the same way.
 */
export async function duplicateItemWithEdits(itemId: string): Promise<void> {
  const store = useArrangeStore.getState();
  if (!store.jobId) return;
  const sourceItem = store.arrangement.find((a) => a.id === itemId);
  if (!sourceItem) return;
  const chunk = store.chunks.find((c) => c.id === sourceItem.chunkId);
  const sourceDurationS = chunk ? (chunk.endMs - chunk.startMs) / 1000 : 0;

  // Mutate the arrangement first so the persist-hook + reconcile stay
  // in sync with the IDB pills/cuts/fx we write below. The store action
  // generates the new id internally — we identify it as "the one
  // matching sourceItem.chunkId at index sourceIdx + 1" after the
  // mutation lands.
  const sourceIdx = store.arrangement.findIndex((a) => a.id === itemId);
  store.duplicateItem(itemId);
  const next = useArrangeStore.getState().arrangement;
  const cloneItem = next[sourceIdx + 1];
  if (!cloneItem || cloneItem.chunkId !== sourceItem.chunkId) return;

  if (sourceDurationS <= 0) return;

  const job = await jobsDb.getJob(store.jobId);
  if (!job) return;
  const sourcePills = (job.pills ?? []).filter(
    (p) => p.fromArrangementItemId === itemId,
  );
  if (sourcePills.length === 0) return; // no edits, nothing to copy

  const clonedPills: PillRecord[] = sourcePills.map((p) => ({
    ...p,
    id: `${p.camId}::${cloneItem.id}`,
    fromArrangementItemId: cloneItem.id,
    arrStartS: p.arrStartS + sourceDurationS,
    arrEndS: p.arrEndS + sourceDurationS,
    originalArrStartS: p.originalArrStartS + sourceDurationS,
    originalArrEndS: p.originalArrEndS + sourceDurationS,
  }));

  const sourceRanges = sourcePills.map((p) => ({
    startS: p.arrStartS,
    endS: p.arrEndS,
  }));
  const cutInSource = (atS: number) =>
    sourceRanges.some((r) => atS >= r.startS && atS < r.endS);
  const fxInSource = (inS: number, outS: number) =>
    sourceRanges.some((r) => inS < r.endS && r.startS < outS);

  const sourceCuts: Cut[] = (job.cuts ?? []).filter((c) => cutInSource(c.atTimeS));
  const clonedCuts: Cut[] = sourceCuts.map((c) => ({
    ...c,
    atTimeS: c.atTimeS + sourceDurationS,
  }));

  const sourceFx: PunchFxRecord[] = (job.fx ?? []).filter((f) =>
    fxInSource(f.inS, f.outS),
  );
  const clonedFx: PunchFxRecord[] = sourceFx.map((f) => ({
    ...f,
    id: `${f.id}-dup-${cloneItem.id}`,
    inS: f.inS + sourceDurationS,
    outS: f.outS + sourceDurationS,
  }));

  const updates: Parameters<typeof jobsDb.updateJob>[1] = {};
  if (clonedPills.length > 0) updates.pills = [...(job.pills ?? []), ...clonedPills];
  if (clonedCuts.length > 0) updates.cuts = [...(job.cuts ?? []), ...clonedCuts];
  if (clonedFx.length > 0) updates.fx = [...(job.fx ?? []), ...clonedFx];
  if (Object.keys(updates).length > 0) {
    await jobsDb.updateJob(store.jobId, updates);
  }
}

// Re-export type-checkable shapes for tests
export type { ArrangementItem, Cut, PillRecord, PunchFxRecord };
