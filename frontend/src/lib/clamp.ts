/** Bounded clamp `lo ≤ v ≤ hi`. Read the call as `clamp(value, lo, hi)`. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Clamp into the unit interval [0, 1]. */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Clamp a seek target into a media element's valid range. Non-finite
 * targets land at 0; an unknown/invalid duration only floors at 0 so an
 * early seek (metadata not yet loaded) isn't silently discarded.
 */
export function clampSeek(target: number, duration: number): number {
  if (!Number.isFinite(target)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, target);
  return Math.max(0, Math.min(duration, target));
}
