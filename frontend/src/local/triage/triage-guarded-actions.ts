/**
 * Triage actions that may destroy downstream work, wrapped in
 * confirm-dialog gates.
 *
 * UI components (TransportBar buttons, Inspector buttons, keyboard
 * shortcuts) call these instead of `useTriageStore.getState().<action>`
 * directly. Plain async functions — keyboard handlers can `await` them
 * without hooks plumbing.
 *
 * Confirm rules (see plan: ich-bin-mir-nicht-mutable-squirrel.md):
 *   - reject: confirm if the chunk is in the persisted arrangement.
 *   - split: when the chunk is in the arrangement, ask whether
 *     occurrences should become Part A, Part B, or both back-to-back.
 *     Cancel aborts the split entirely.
 *   - join (merge): silent when the two chunks are *always adjacent*
 *     in the arrangement; otherwise confirm "replace all with merged"
 *     vs "cancel merge entirely".
 */
import { jobsDb } from "../jobs";
import {
  confirmDestructive,
  chooseSplitReplacement,
  confirmMergeReplaceAll,
} from "../../lib/confirm";
import {
  countEditsAffectedByChunkRemoval,
  isAlwaysAdjacentInArrangement,
} from "../edits-impact";
import {
  applyMergeToArrangement,
  applySplitToArrangement,
} from "./triage-arrangement-ops";
import { useTriageStore } from "./triage-store";

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function impactSummary(parts: { items: number; cuts: number; fx: number }): string {
  const bits: string[] = [];
  if (parts.items > 0) bits.push(pluralize(parts.items, "item", "items"));
  if (parts.cuts > 0) bits.push(pluralize(parts.cuts, "cut", "cuts"));
  if (parts.fx > 0) bits.push(pluralize(parts.fx, "FX entry", "FX entries"));
  return bits.join(", ");
}

/**
 * Reject the focused chunk. If it's in the arrangement, confirm first.
 * The store action `rejectFocused` flips `accepted` to false; the
 * persist hook's diff-propagation prunes arrangement items on the next
 * write. The Editor reconciles its pills + cuts on its next mount.
 */
export async function rejectFocusedGuarded(autoAdvance = true): Promise<void> {
  const state = useTriageStore.getState();
  const focusedId = state.focusedChunkId;
  if (!focusedId || !state.jobId) return;

  const job = await jobsDb.getJob(state.jobId);
  const arrangement = job?.arrangement ?? [];
  const pills = job?.pills ?? [];
  const cuts = job?.cuts ?? [];
  const fx = job?.fx ?? [];
  const impact = countEditsAffectedByChunkRemoval(focusedId, arrangement, pills, cuts, fx);

  if (impact.items > 0) {
    const detail = impactSummary(impact);
    const ok = await confirmDestructive({
      title: "Drop chunk?",
      body: `This chunk is in the arrangement. Dropping it will remove ${detail} from your arrangement and editor edits.`,
      destructiveLabel: "Drop chunk",
    });
    if (!ok) return;
  }

  state.rejectFocused(autoAdvance);
}

/**
 * Split the focused chunk at the given master-time. If the chunk is
 * in the arrangement, ask the user how to handle existing occurrences
 * (Part A / Part B / Both / Cancel). The arrangement is mutated in IDB
 * directly so the next Arrange / Editor mount picks up the change.
 */
export async function splitFocusedGuarded(atMs: number): Promise<void> {
  const state = useTriageStore.getState();
  const focusedId = state.focusedChunkId;
  if (!focusedId || !state.jobId) return;

  const job = await jobsDb.getJob(state.jobId);
  const arrangement = job?.arrangement ?? [];
  const usageCount = arrangement.filter((a) => a.chunkId === focusedId).length;

  let mode: "a" | "b" | "both" | null = null;
  if (usageCount > 0) {
    mode = await chooseSplitReplacement({
      title: "Split chunk in arrangement?",
      body: `This chunk appears ${pluralize(usageCount, "time", "times")} in the arrangement. After the split, what should each occurrence become?`,
    });
    if (mode === null) return;
  }

  const newRightId = state.splitChunkAt(focusedId, atMs);
  if (newRightId === null) return; // degenerate split (too close to edge)

  if (mode !== null && mode !== "a" && state.jobId) {
    const fresh = await jobsDb.getJob(state.jobId);
    const currentArrangement = fresh?.arrangement ?? [];
    const next = applySplitToArrangement(
      currentArrangement,
      focusedId,
      newRightId,
      mode,
    );
    if (next !== currentArrangement) {
      await jobsDb.updateJob(state.jobId, { arrangement: next });
    }
  }
}

/**
 * Merge the focused chunk with its prev/next neighbour. Silent when
 * every occurrence in the arrangement is adjacent to its neighbour.
 * Otherwise confirm: "Replace all with merged" → applies; "Cancel" →
 * aborts the merge entirely (so chunks A and B stay both available
 * and arrangement keeps using them as before).
 */
export async function joinFocusedGuarded(direction: "prev" | "next"): Promise<void> {
  const state = useTriageStore.getState();
  const focusedId = state.focusedChunkId;
  if (!focusedId || !state.jobId) return;

  // Resolve the neighbour the store would pick. Mirror the chronological-
  // sort logic in `joinChunks` so we know which two chunk ids the merge
  // will actually touch — otherwise we can't compute adjacency or apply
  // the post-merge arrangement transform with the right ids.
  const sorted = [...state.chunks].sort((a, b) => a.startMs - b.startMs);
  const idx = sorted.findIndex((c) => c.id === focusedId);
  if (idx < 0) return;
  const neighbourIdx = direction === "prev" ? idx - 1 : idx + 1;
  if (neighbourIdx < 0 || neighbourIdx >= sorted.length) return;
  const neighbour = sorted[neighbourIdx];

  const job = await jobsDb.getJob(state.jobId);
  const arrangement = job?.arrangement ?? [];
  const focusedInArr = arrangement.some((a) => a.chunkId === focusedId);
  const neighbourInArr = arrangement.some((a) => a.chunkId === neighbour.id);
  const anyInArr = focusedInArr || neighbourInArr;
  const allAdjacent = isAlwaysAdjacentInArrangement(
    focusedId,
    neighbour.id,
    arrangement,
  );

  if (anyInArr && !allAdjacent) {
    const ok = await confirmMergeReplaceAll({
      title: "Merge chunks?",
      body: `These chunks appear separately in the arrangement. Replace every occurrence with the merged chunk?`,
    });
    if (!ok) return;
  }

  // After joinChunks the store keeps focusedId as the merged chunk's id
  // and removes the neighbour. Mirror that in the arrangement.
  state.joinChunks(focusedId, direction);

  if (anyInArr && state.jobId) {
    const fresh = await jobsDb.getJob(state.jobId);
    const currentArrangement = fresh?.arrangement ?? [];
    const next = applyMergeToArrangement(
      currentArrangement,
      focusedId,
      neighbour.id,
    );
    if (next !== currentArrangement) {
      await jobsDb.updateJob(state.jobId, { arrangement: next });
    }
  }
}
