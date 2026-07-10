/**
 * Collision-free cam-slot allocation.
 *
 * Cam ids follow `cam-${index + 1}` and everything derived from a cam —
 * its OPFS media path, frame-strip path, persisted cuts and per-cam
 * editor state — is keyed on that id. `removeCamFromJob` deliberately
 * does NOT renumber survivors (that would orphan their persisted state),
 * so allocating a new slot from `videos.length` re-issues a live id
 * after any delete-then-add: [cam-1, cam-2, cam-3] → delete cam-1 →
 * length 2 → "cam-3" again. The duplicate then corrupts the surviving
 * cam-3 lane (sync/trim overwritten, OPFS media clobbered) — issue #68.
 *
 * `nextCamIndex` instead scans the existing ids for the highest numeric
 * suffix and allocates one past it. The display name ("Cam N") stays
 * derived from array position in the UI, so numbering the user sees is
 * unaffected.
 */

/** Index to feed `persistVideoCam` / `persistImageCam` (which build
 *  `cam-${index + 1}`) so the resulting id collides with no existing
 *  asset. `existing.length` acts as a conservative floor for legacy /
 *  non-standard ids. */
export function nextCamIndex(
  existing: ReadonlyArray<{ id: string }>,
): number {
  let index = existing.length;
  for (const asset of existing) {
    const m = /^cam-(\d+)$/.exec(asset.id);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    // id `cam-n` was built from index n-1, so index n is the first one
    // strictly past it.
    if (Number.isFinite(n) && n > index) index = n;
  }
  return index;
}
