/**
 * Pure helper: produce ruler-tick positions for a given BPM, phase, and
 * visible time-range. Subdivisions appear/hide based on the zoom level
 * (px-per-beat) so the ruler stays legible at every zoom.
 *
 * This is the single source of truth for bar/beat grid math — the editor's
 * BeatRuler and both Triage rulers (TriageTimeline bar ruler, SeamStrip
 * lane rulers) all build their ticks here. Surface-specific behavior is
 * expressed through options, not copies:
 *
 * `beatsPerBar` (default 4) controls how many beats live in one bar.
 * `barOffsetBeats` (default 0) shifts where bar 1 begins — for songs
 * with an anacrusis / pickup the first N beats render as `beat` ticks
 * and bar 1 starts on the (N+1)th detected beat.
 * `extendBeforePhase` projects the grid to the left of the anchor
 * (bar numbers ≤ 0) — Triage uses this so a focused chunk's grid spans
 * the whole view as snap targets for outward trims.
 * `labelStride` decides which downbeats carry their bar number; `"auto"`
 * picks a power-of-2 stride so labels never crowd below TARGET_LABEL_PX.
 * `extensionSpan` marks ticks outside a primary half-open span
 * [startS, endS) as `extension: true` (rendered dimmed as snap targets).
 */

export type RulerTickKind = "bar" | "beat" | "div8" | "div16";

export interface RulerTick {
  /** Time in seconds on the master timeline. */
  t: number;
  kind: RulerTickKind;
  /** 1-based bar number, only set on `bar` ticks. With
   *  `extendBeforePhase` bars left of the anchor count down 0, -1, … */
  barNumber?: number;
  /** `bar` ticks only: whether this downbeat carries its number
   *  (stride-labeled). Always true at labelStride 1. */
  labeled?: boolean;
  /** Only present when `extensionSpan` was given: true when the tick
   *  lies outside the half-open span [startS, endS). */
  extension?: boolean;
}

const DEFAULT_BEATS_PER_BAR = 4;

const MIN_PX_PER_BEAT_FOR_BEATS = 8;
const MIN_PX_PER_BEAT_FOR_DIV8 = 32;
const MIN_PX_PER_BEAT_FOR_DIV16 = 64;

/** Labeled downbeats must sit at least this far apart on screen. */
const TARGET_LABEL_PX = 56;
/** Unlabeled in-between downbeats render only when a bar spans this. */
const MIN_PX_PER_BAR_FOR_MINOR = 6;
/** Below a quarter pixel per bar the ruler is unreadable tick soup —
 *  emit nothing. */
const MIN_PX_PER_BAR = 0.25;

/** Smallest power-of-2 bar stride whose labeled downbeats sit at least
 *  TARGET_LABEL_PX apart at the given zoom. */
export function pickBarStride(pxPerBar: number): number {
  if (pxPerBar >= TARGET_LABEL_PX) return 1;
  if (pxPerBar <= 0) return 1;
  const need = TARGET_LABEL_PX / pxPerBar;
  return Math.pow(2, Math.ceil(Math.log2(need)));
}

export interface BuildRulerTicksOpts {
  bpm: number | null;
  /** Time (s) of beat index 0 — the grid anchor. */
  beatPhase: number;
  startS: number;
  endS: number;
  pxPerSec: number;
  /** Beats per bar — default 4. */
  beatsPerBar?: number;
  /** Anacrusis / pickup, in beats. Default 0. The first N beats after the
   *  phase render as `beat` ticks; bar 1 starts at beat N. */
  barOffsetBeats?: number;
  /** Project the grid to beats before the phase (bar numbers ≤ 0).
   *  Default false: the silent intro before the phase stays empty (no
   *  negative bars hovering in the dead air). */
  extendBeforePhase?: boolean;
  /** Which downbeats get `labeled: true`. A number is a fixed stride
   *  (default 1 = every bar); `"auto"` adapts to the zoom via
   *  `pickBarStride`. At stride > 1, beats/subdivisions are suppressed
   *  and unlabeled downbeats render only with ≥ 6 px per bar. */
  labelStride?: number | "auto";
  /** Primary span (s). Ticks outside the HALF-OPEN [startS, endS) get
   *  `extension: true` — a downbeat exactly on endS opens the next bar,
   *  so it belongs to the extension, not the primary grid. */
  extensionSpan?: { startS: number; endS: number };
}

export function buildRulerTicks(opts: BuildRulerTicksOpts): RulerTick[] {
  const {
    bpm,
    beatPhase,
    startS,
    endS,
    pxPerSec,
    beatsPerBar = DEFAULT_BEATS_PER_BAR,
    barOffsetBeats = 0,
    extendBeforePhase = false,
    labelStride = 1,
    extensionSpan,
  } = opts;
  if (!bpm || bpm <= 0 || endS <= startS) return [];

  const bpb = beatsPerBar > 0 ? Math.floor(beatsPerBar) : DEFAULT_BEATS_PER_BAR;
  // Canonicalise the offset into [0, bpb) — pickup of `bpb` ≡ no pickup.
  let off = Math.floor(barOffsetBeats) % bpb;
  if (off < 0) off += bpb;

  const beatS = 60 / bpm;
  const pxPerBeat = beatS * pxPerSec;
  const pxPerBar = pxPerBeat * bpb;
  if (pxPerBar < MIN_PX_PER_BAR) return [];

  const stride =
    labelStride === "auto"
      ? pickBarStride(pxPerBar)
      : Math.max(1, Math.floor(labelStride));
  const showMinorBars = pxPerBar >= MIN_PX_PER_BAR_FOR_MINOR;
  const showBeats = stride === 1 && pxPerBeat >= MIN_PX_PER_BEAT_FOR_BEATS;
  const showDiv8 = stride === 1 && pxPerBeat >= MIN_PX_PER_BEAT_FOR_DIV8;
  const showDiv16 = stride === 1 && pxPerBeat >= MIN_PX_PER_BEAT_FOR_DIV16;

  // Half-open extension test: a tick exactly on the span's end already
  // opens the *next* bar, so it counts as extension.
  const ext = (t: number): { extension: boolean } | undefined =>
    extensionSpan
      ? {
          extension:
            t < extensionSpan.startS - 1e-9 || t > extensionSpan.endS - 1e-9,
        }
      : undefined;

  const ticks: RulerTick[] = [];

  // Iterate from the first beat at-or-before startS up to endS. Unless
  // the grid extends before the phase, clamp to beat 0 so the silent
  // intro stays empty.
  let firstBeatIdx = Math.floor((startS - beatPhase) / beatS);
  if (!extendBeforePhase) firstBeatIdx = Math.max(0, firstBeatIdx);
  const lastBeatIdx = Math.ceil((endS - beatPhase) / beatS);

  for (let i = firstBeatIdx; i <= lastBeatIdx; i++) {
    const beatT = beatPhase + i * beatS;

    // `j` = beat index relative to bar 1 / beat 1. Pickup beats sit at
    // j < 0 (we render them as `beat` ticks) and bar starts are at
    // j ≡ 0 (mod bpb).
    const j = i - off;
    if (beatT >= startS - 1e-9 && beatT <= endS + 1e-9) {
      const beatInBar = ((j % bpb) + bpb) % bpb;
      if (beatInBar === 0) {
        const barIdx0 = Math.floor(j / bpb); // 0-based; negative left of anchor
        const labeled = ((barIdx0 % stride) + stride) % stride === 0;
        if (labeled || showMinorBars) {
          ticks.push({
            t: beatT,
            kind: "bar",
            barNumber: barIdx0 + 1,
            labeled,
            ...ext(beatT),
          });
        }
      } else if (showBeats) {
        ticks.push({ t: beatT, kind: "beat", ...ext(beatT) });
      }
    }

    // Sub-beat ticks (1/8 + 1/16 subdivisions) only emit when the zoom
    // gives them enough room to be readable.
    if (showDiv8) {
      const halfT = beatT + beatS / 2;
      if (halfT >= startS - 1e-9 && halfT <= endS + 1e-9) {
        ticks.push({ t: halfT, kind: "div8", ...ext(halfT) });
      }
    }
    if (showDiv16) {
      const q1 = beatT + beatS / 4;
      const q3 = beatT + (3 * beatS) / 4;
      if (q1 >= startS - 1e-9 && q1 <= endS + 1e-9) {
        ticks.push({ t: q1, kind: "div16", ...ext(q1) });
      }
      if (q3 >= startS - 1e-9 && q3 <= endS + 1e-9) {
        ticks.push({ t: q3, kind: "div16", ...ext(q3) });
      }
    }
  }
  ticks.sort((a, b) => a.t - b.t);
  return ticks;
}
