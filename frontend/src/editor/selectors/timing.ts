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
import type { Segment } from "../types";

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

/** Arrangement-time anchor of the master beat grid (beat 0 in arr-time).
 *
 *  The editor keeps ONE master bar grid for every job (see
 *  `effectiveBeatPhaseS`). Consumers that draw the grid or snap to it on
 *  the arr-time canvas need beat 0 expressed in arr-time. Arr-time 0 is
 *  the start of the first PLAYED segment, where `arr = master - seg0.in`,
 *  so the anchor is simply `beatPhaseMaster - seg0.in`. That keeps the
 *  grid continuous from the start of the song the user assembled,
 *  whatever order the chunks play in and wherever the first one sits in
 *  the source recording.
 *
 *  Do NOT project beat 0 through `masterToArr`: beat 0 is a single master
 *  instant (~0.3 s into the source). `masterToArr` returns the arr-time
 *  at which that instant is *played*, which is wherever the chunk
 *  covering master ~0 lands in the playback order. For a long-form
 *  arrangement whose first chunk starts late in the source (or whose
 *  master-0 chunk plays last), that anchors bar 1 far down the timeline —
 *  the "bar ruler starts way back in the song" bug.
 *
 *  Empty `segments` → the raw master phase unchanged (single-take supplies
 *  a whole-master `[0, dur]` segment, so this only hits the pre-load case).
 */
export function arrBeatPhaseS(
  meta: JobMeta | null | undefined,
  segments: readonly Segment[],
): number {
  const phase = effectiveBeatPhaseS(meta);
  if (segments.length === 0) return phase;
  return phase - segments[0].in;
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
