/**
 * Pure helper: wall-clock (M:SS) ruler ticks for a visible time-range.
 * Companion to `beat-ruler-ticks.ts` — this is the musically-agnostic
 * ruler (absolute time), used by the Triage timeline's top strip.
 */
import { formatTime } from "../../../lib/time-format";

export interface TimeRulerTick {
  /** Time in seconds. */
  t: number;
  /** M:SS label — empty string on minor ticks. */
  label: string;
  major: boolean;
}

/** Round a raw step (s) up to the next "nice" clock step (0.5 s, 1 s,
 *  … 30 s, 1 min, … 1 h), falling back to whole hours above the table. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const candidates = [
    0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600,
  ];
  for (const c of candidates) {
    if (c >= raw) return c;
  }
  return Math.ceil(raw / 3600) * 3600;
}

/** Labeled majors on nice steps (~120 px apart) with 5 minors between. */
export function buildTimeRulerTicks(
  viewStartS: number,
  viewEndS: number,
  widthPx: number,
): TimeRulerTick[] {
  const visible = viewEndS - viewStartS;
  if (visible <= 0 || widthPx <= 0) return [];
  const targetMajorPx = 120;
  const targetCount = Math.max(2, widthPx / targetMajorPx);
  const rawSpacing = visible / targetCount;
  const majorStep = niceStep(rawSpacing);
  const minorStep = majorStep / 5;
  const ticks: TimeRulerTick[] = [];
  const t0 = Math.floor(viewStartS / minorStep) * minorStep;
  for (let t = t0; t <= viewEndS + minorStep; t += minorStep) {
    const isMajor = Math.abs(t / majorStep - Math.round(t / majorStep)) < 0.001;
    ticks.push({
      t,
      label: isMajor ? formatTime(t) : "",
      major: isMajor,
    });
  }
  return ticks;
}
