/**
 * Loop/trim region primitives shared by the editor store and the
 * arrangement-loop helpers.
 *
 * `LoopRegion`/`TrimRegion` are the store's user-facing marker shapes;
 * `clampLoopRegion` is the legacy direct-mode clamp that
 * `clampLoopToBounds` (arrangement-loop.ts) falls back to when no
 * arrangement segments exist yet (pre-load store snapshot).
 *
 * Loop *scheduling* — wrap geometry, crossfade arming, the two-`<audio>`
 * ping-pong — lives in useAudioMaster.ts + arrangement-loop.ts. This
 * module deliberately contains no scheduling logic.
 */

export interface LoopRegion {
  start: number;
  end: number;
}

export interface TrimRegion {
  in: number;
  out: number;
}

/**
 * The user's loop selection must stay inside the trim region — playing audio
 * from a region that won't be in the final render is misleading.
 * Returns null when the loop has no overlap with the trim region.
 */
export function clampLoopRegion(
  loop: LoopRegion,
  trim: TrimRegion,
): LoopRegion | null {
  const start = Math.max(loop.start, trim.in);
  const end = Math.min(loop.end, trim.out);
  if (end <= start) return null;
  return { start, end };
}
