/**
 * Clamp a member's render segments to the master-time span actually covered
 * by its cams. A project whose audio runs longer than its video (or whose
 * clips are trimmed) would otherwise render the SMPTE test pattern in the
 * uncovered gap — fine for a standalone export the user framed deliberately,
 * but in a reel it shows up as bars wedged between members and pushes later
 * members far down the timeline. Clamping drops those gaps so members butt
 * directly against each other.
 *
 * Pure function — no IO.
 */
export interface TimeRange {
  in: number;
  out: number;
}

export interface CamRange {
  startS: number;
  endS: number;
}

export function clampSegmentsToContent<T extends TimeRange>(
  segments: T[],
  camRanges: CamRange[],
): T[] {
  if (camRanges.length === 0 || segments.length === 0) return segments;
  const contentStart = Math.min(...camRanges.map((r) => r.startS));
  const contentEnd = Math.max(...camRanges.map((r) => r.endS));
  const out: T[] = [];
  for (const s of segments) {
    const inS = Math.max(s.in, contentStart);
    const outS = Math.min(s.out, contentEnd);
    if (outS > inS + 1e-6) out.push({ ...s, in: inS, out: outS });
  }
  // Never return empty — a degenerate clamp (e.g. content entirely outside
  // the trim window) falls back to the original so the member still renders.
  return out.length > 0 ? out : segments;
}
