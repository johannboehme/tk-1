import type { PunchFx } from "./types";

/**
 * Returns the FX active at timeline-time `t`, in the input's stable order.
 * `inS` is inclusive, `outS` exclusive — same convention as the cuts /
 * cam-range resolver in `cuts.ts`.
 *
 * Note on the time-axis: `inS`/`outS` used to be master-time, which fired
 * a recorded FX at every duplicate occurrence of the underlying chunk.
 * They're now timeline-time (song-position) so an FX in pill 1 stays in
 * pill 1 and doesn't bleed into pill 3 if both reference the same source.
 * On-load migration projects legacy master-time values to first-occurrence
 * timeline-time, preserving existing user edits.
 */
export function activeFxAt(
  fx: readonly PunchFx[],
  t: number,
): PunchFx[] {
  const out: PunchFx[] = [];
  for (const f of fx) {
    if (f.inS <= t && t < f.outS) out.push(f);
  }
  return out;
}
