/**
 * Apply a Triage chunk-list diff to the persisted arrangement.
 *
 * Replaces the old "wipe arrangement on any chunk dirty"-pattern with
 * an ID-aware merge:
 *
 *   - chunk removed (deleted, or accepted: true → false): every
 *     `ArrangementItem` referencing that id is filtered out. The user's
 *     manual ordering of the surviving items is preserved.
 *   - chunk added (split halves, merge result, manual insert): the new
 *     chunk shows up in the Polaroid pool but is NOT auto-inserted into
 *     the arrangement. The user picks if and where to drag it.
 *   - chunk modified (trim, audioStart, bpm shift): no arrangement
 *     change. The Editor's `reconcilePills` pass picks up new geometry
 *     when it next mounts; arrangement items only carry chunkId, so
 *     they're unaffected.
 *
 * Identity preservation: when no items would be filtered out we return
 * the original `arrangement` reference verbatim so the persist hook's
 * fingerprint comparator doesn't write a no-op update.
 */
import type { ArrangementItem, Chunk } from "../../storage/jobs-db";

function isEffectivelyPresent(c: Chunk | undefined): boolean {
  return c !== undefined && c.accepted !== false;
}

export function propagateTriageChangesToArrangement(
  prevChunks: readonly Chunk[],
  nextChunks: readonly Chunk[],
  arrangement: readonly ArrangementItem[],
): ArrangementItem[] {
  if (arrangement.length === 0) return arrangement as ArrangementItem[];

  const nextById = new Map<string, Chunk>();
  for (const c of nextChunks) nextById.set(c.id, c);

  // An arrangement item survives iff its chunk still exists AND is
  // still effectively-present. "Effectively-present" excludes chunks
  // whose `accepted` flag flipped to false — that's the user-facing
  // "rejected" state, which the Reject confirm gate has already
  // approved at this point.
  const filtered = arrangement.filter((item) => {
    const c = nextById.get(item.chunkId);
    return isEffectivelyPresent(c);
  });

  if (filtered.length === arrangement.length) {
    // No removals → preserve the input reference so persist-hook
    // fingerprint sees identity equality.
    return arrangement as ArrangementItem[];
  }
  // Mark prevChunks as referenced so callers can pass it without us
  // shouting "unused parameter" — we need the diff signature to read
  // self-documenting at call sites even though the current
  // implementation only consults `nextChunks`. Future versions could
  // use prevChunks to detect e.g. detach-not-delete cases.
  void prevChunks;
  return filtered;
}
