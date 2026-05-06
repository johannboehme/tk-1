/**
 * Effective timing selectors. The user can nudge the master-audio start
 * to correct a slightly-off auto-detection, pick a time signature, and
 * declare an anacrusis/pickup. Every consumer that draws the beat grid,
 * snaps to it, or jumps to the music start reads through these helpers
 * so the raw analyzer values and the user corrections are combined in
 * exactly one place.
 *
 * All values are returned in master-time. The editor uses one master
 * bar grid for every job — long-form arrangements anchor the same
 * master-bpm phase as single-take, and consumers that draw or snap in
 * arr-time project the result through `masterToArr` at the call site.
 */
import type { JobMeta } from "../store";

const DEFAULT_BEATS_PER_BAR = 4;

/** Master-time of beat 0. `jobMeta.bpm.phase + audioStartNudgeS` — the
 *  auto-detected first-onset master-time plus the user's correction. */
export function effectiveBeatPhaseS(
  meta: JobMeta | null | undefined,
): number {
  const nudge = meta?.audioStartNudgeS ?? 0;
  const phase = meta?.bpm?.phase ?? 0;
  return phase + nudge;
}

/** Master-time of the audio-onset (where audible material begins). */
export function effectiveAudioStartS(
  meta: JobMeta | null | undefined,
): number {
  const nudge = meta?.audioStartNudgeS ?? 0;
  const start = meta?.audioStartS ?? 0;
  return start + nudge;
}

export function effectiveBeatsPerBar(meta: JobMeta | null | undefined): number {
  const v = meta?.beatsPerBar;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
    return DEFAULT_BEATS_PER_BAR;
  }
  return Math.floor(v);
}

export function effectiveBarOffsetBeats(
  meta: JobMeta | null | undefined,
): number {
  const bpb = effectiveBeatsPerBar(meta);
  const raw = meta?.barOffsetBeats;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  // Pickup of `beatsPerBar` ≡ no pickup, so the canonical form is the
  // modular remainder. Floor before the modulo so fractional inputs (we
  // only accept integer beat counts in the UI, but be safe) collapse
  // deterministically.
  const m = Math.floor(raw) % bpb;
  return m < 0 ? m + bpb : m;
}

/** Master-time of bar 1 / beat 1. Returns 0 when bpm is unknown
 *  (no period to shift by). */
export function effectiveBarPhaseS(
  meta: JobMeta | null | undefined,
): number {
  const bpm = meta?.bpm?.value;
  if (!bpm || bpm <= 0) return 0;
  const beatPeriod = 60 / bpm;
  return effectiveBeatPhaseS(meta) + effectiveBarOffsetBeats(meta) * beatPeriod;
}
