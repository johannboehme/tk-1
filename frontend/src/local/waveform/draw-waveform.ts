/**
 * Shared, stateless waveform draw engine. One source of truth for waveform
 * geometry across Triage, the Editor and SeamStrip.
 *
 * Two properties make it Ableton-grade where the old code was not:
 *  - It iterates DEVICE pixels (round(cssW * dpr)), placing one vertex per
 *    device pixel at css-x = i/dpr. The 2D context is DPR-scaled by the caller
 *    (setTransform(dpr,...)), so each vertex lands on a distinct device pixel —
 *    full retina horizontal resolution instead of the old CSS-pixel sampling.
 *  - It reads transient-preserving min/max from the peak pyramid and draws a
 *    crisp filled body with NO post-smoothing. At extreme zoom (finer than one
 *    base bucket) it reads raw PCM where available for true sample-edge detail.
 *
 * The pure column computation (`computeColumnModel`) is split out so the
 * geometry is unit-testable without a canvas. `drawWaveform` is the thin canvas
 * wrapper and returns the per-CSS-column max array so Triage's silence tint and
 * dB guides read the exact same silhouette the body is drawn from.
 */
import {
  type PeakPyramid,
  aggregateColumn,
  bucketRangeForTime,
  pickLevel,
  rawPcmColumn,
} from "./peak-pyramid";

export type Normalize = "absolute" | "peak";

export interface WaveStyle {
  /** Vertical gradient stops [offset 0..1, css color], top → bottom of lane. */
  gradientStops: [number, string][];
  groundColor: string;
  /** When set (and withRms), a brighter RMS core is drawn over the body. */
  rmsCoreColor?: string;
  /** Vertical padding inside the lane so the loudest peaks don't kiss edges. */
  padPx?: number;
}

export interface ColumnModelOpts {
  pyramid: PeakPyramid;
  /** Raw PCM for the extreme-zoom path. Optional (Editor drops it). */
  pcm?: Float32Array | null;
  /** Axis window (seconds). For the Editor this is arr-time; mapXToTime
   *  converts to master/pyramid time per column. */
  t0S: number;
  t1S: number;
  cssW: number;
  dpr: number;
  normalize?: Normalize;
  withRms?: boolean;
  /**
   * Maps a CSS x position to its pyramid (master) time, or null for a gap.
   * Used by the Editor's piecewise arr-time→master-time projection so
   * discontinuous regions never smear and long-form gaps stay gaps. When
   * omitted, the axis window maps linearly across the width.
   */
  mapXToTime?: (cssX: number) => number | null;
}

export interface ColumnModel {
  deviceWidth: number;
  /** Normalized signed max per device column (the upper silhouette edge). */
  top: Float32Array;
  /** Normalized signed min per device column (the lower silhouette edge). */
  bot: Float32Array;
  /** Normalized RMS magnitude per device column, or null. */
  core: Float32Array | null;
  hasData: Uint8Array;
  /** Per-CSS-column max (length round(cssW)) for the silence tint / dB guides. */
  colMaxCss: Float32Array;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Minimum visible half-height of the body, in CSS pixels. */
const MIN_HALF_PX = 0.6;

/**
 * Guarantee a minimum body thickness so the filled waveform never collapses to
 * an invisible zero-height sliver. At extreme (sub-sample) zoom the raw-PCM path
 * yields min==max per column; without this the body vanishes and only the
 * centre line remains — the waveform reads as a flat stroke. Expanding a too-thin
 * column symmetrically around its midpoint keeps the band centred on the signal,
 * so it traces the real sample values as a thin line instead of disappearing.
 * Returns [top, bot] in the same normalized units as the inputs.
 */
export function expandToMinThickness(
  topV: number,
  botV: number,
  minHalf: number,
): [number, number] {
  if (topV - botV >= 2 * minHalf) return [topV, botV];
  const mid = (topV + botV) / 2;
  return [mid + minHalf, mid - minHalf];
}

export function computeColumnModel(opts: ColumnModelOpts): ColumnModel {
  const { pyramid, t0S, t1S, cssW, dpr } = opts;
  const normalize = opts.normalize ?? "absolute";
  const pcm = opts.pcm ?? null;
  const withRms = opts.withRms ?? false;
  const mapXToTime = opts.mapXToTime;

  const deviceWidth = Math.max(1, Math.round(cssW * dpr));
  const top = new Float32Array(deviceWidth);
  const bot = new Float32Array(deviceWidth);
  const core = withRms ? new Float32Array(deviceWidth) : null;
  const hasData = new Uint8Array(deviceWidth);
  const colMaxCss = new Float32Array(Math.max(1, Math.round(cssW)));

  const sr = pyramid.sampleRate;
  const norm = normalize === "peak" ? pyramid.globalPeak : 1;
  const span = t1S - t0S;
  if (pyramid.levels.length === 0 || span <= 0) {
    return { deviceWidth, top, bot, core, hasData, colMaxCss };
  }

  const secPerDevPx = span / deviceWidth;
  const level = pickLevel(pyramid, secPerDevPx);
  const lvl = pyramid.levels[level];
  const bucketDur = lvl.samplesPerBucket / sr;
  const samplesPerDevPx = secPerDevPx * sr;
  // NB: pcm.length > 0 is essential — a detached/empty Float32Array is still
  // truthy, and rawPcmColumn on it returns {0,0} for every column (a flat line).
  const useRaw =
    !!pcm &&
    pcm.length > 0 &&
    level === 0 &&
    samplesPerDevPx < pyramid.baseSamplesPerBucket;

  // Column i's right boundary is column i+1's left boundary (same cssX), so
  // carry it across iterations — one mapXToTime projection per boundary
  // instead of two per column.
  let prevBoundary: number | null | undefined;
  for (let i = 0; i < deviceWidth; i++) {
    let t0c: number;
    let t1c: number;
    if (mapXToTime) {
      const a = prevBoundary !== undefined ? prevBoundary : mapXToTime(i / dpr);
      const b = mapXToTime((i + 1) / dpr);
      prevBoundary = b;
      if (a == null || b == null) {
        hasData[i] = 0;
        continue;
      }
      t0c = a < b ? a : b;
      t1c = a < b ? b : a;
    } else {
      t0c = t0S + (i / deviceWidth) * span;
      t1c = t0S + ((i + 1) / deviceWidth) * span;
    }

    let mn = 0;
    let mx = 0;
    let rm = 0;
    if (useRaw && pcm) {
      const agg = rawPcmColumn(pcm, sr, t0c, t1c, withRms);
      mn = agg.min;
      mx = agg.max;
      rm = agg.rms ?? 0;
    } else {
      const { i0, i1 } = bucketRangeForTime(lvl, sr, t0c, t1c);
      if (i1 - i0 >= 1) {
        const agg = aggregateColumn(lvl, i0, i1);
        mn = agg.min;
        mx = agg.max;
        rm = agg.rms ?? 0;
      } else {
        // Sub-bucket zoom: interpolate neighbouring buckets so the body stays
        // smooth between samples rather than snapping bucket-to-bucket.
        const fc = (t0c + t1c) / 2 / bucketDur;
        const j = Math.floor(fc);
        const frac = fc - j;
        const ja = clamp(j, 0, lvl.bucketCount - 1);
        const jb = clamp(j + 1, 0, lvl.bucketCount - 1);
        mx = lvl.max[ja] * (1 - frac) + lvl.max[jb] * frac;
        mn = lvl.min[ja] * (1 - frac) + lvl.min[jb] * frac;
        if (lvl.rms) rm = lvl.rms[ja] * (1 - frac) + lvl.rms[jb] * frac;
      }
    }

    top[i] = clamp(mx / norm, -1, 1);
    bot[i] = clamp(mn / norm, -1, 1);
    if (core) core[i] = clamp(rm / norm, 0, 1);
    hasData[i] = 1;
  }

  // Downsample device columns → per-CSS-column max (the silhouette's upper
  // edge) so a CSS-resolution consumer (Triage tint/guides) stays locked to it.
  const cssWInt = colMaxCss.length;
  for (let c = 0; c < cssWInt; c++) {
    const d0 = Math.floor(c * dpr);
    const d1 = Math.min(deviceWidth, Math.max(d0 + 1, Math.floor((c + 1) * dpr)));
    let mx = 0;
    for (let d = d0; d < d1; d++) if (hasData[d] && top[d] > mx) mx = top[d];
    colMaxCss[c] = mx;
  }

  return { deviceWidth, top, bot, core, hasData, colMaxCss };
}

export interface DrawWaveformOpts extends ColumnModelOpts {
  cssH: number;
  /** Top of the lane in CSS pixels (Editor places it inside a sub-band). */
  yTop?: number;
  style: WaveStyle;
}

/**
 * Draw the waveform into an already-cleared, DPR-scaled 2D context. Returns the
 * per-CSS-column max silhouette array (for the Triage silence tint / dB guides).
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  opts: DrawWaveformOpts,
): Float32Array {
  const model = computeColumnModel(opts);
  const { cssH, dpr, style } = opts;
  const yTop = opts.yTop ?? 0;
  const pad = style.padPx ?? 2;
  const cy = yTop + cssH / 2;
  const half = cssH / 2 - pad;
  const y = (v: number) => cy - v * half;

  const grad = ctx.createLinearGradient(0, yTop, 0, yTop + cssH);
  for (const [off, col] of style.gradientStops) grad.addColorStop(off, col);

  const { top, bot, core, hasData, deviceWidth } = model;
  // Normalized half-height that maps to MIN_HALF_PX on screen.
  const minHalf = MIN_HALF_PX / Math.max(1, half);

  // Scratch buffers shared by every run in this draw call — sized once to the
  // widest possible run so per-run allocation (and its GC churn at 60 Hz)
  // disappears.
  const et = new Float32Array(deviceWidth);
  const eb = new Float32Array(deviceWidth);

  const drawRun = (s: number, e: number) => {
    // Subtle ground line keeps quiet / silent stretches anchored.
    ctx.strokeStyle = style.groundColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(s / dpr, cy);
    ctx.lineTo(e / dpr, cy);
    ctx.stroke();

    // Expand any column thinner than the minimum so the body stays visible
    // (and traces the sample line) at extreme zoom instead of collapsing.
    const n = e - s;
    for (let i = s; i < e; i++) {
      const [t, b] = expandToMinThickness(top[i], bot[i], minHalf);
      et[i - s] = t;
      eb[i - s] = b;
    }

    // Filled body: top edge along the max envelope, back along the min.
    ctx.beginPath();
    ctx.moveTo(s / dpr, y(et[0]));
    for (let i = 1; i < n; i++) ctx.lineTo((s + i) / dpr, y(et[i]));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo((s + i) / dpr, y(eb[i]));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Optional brighter RMS core (Ableton two-tone).
    if (core && style.rmsCoreColor) {
      ctx.beginPath();
      ctx.moveTo(s / dpr, y(core[s]));
      for (let i = s + 1; i < e; i++) ctx.lineTo(i / dpr, y(core[i]));
      for (let i = e - 1; i >= s; i--) ctx.lineTo(i / dpr, y(-core[i]));
      ctx.closePath();
      ctx.fillStyle = style.rmsCoreColor;
      ctx.fill();
    }
  };

  let runStart = -1;
  for (let i = 0; i <= deviceWidth; i++) {
    const on = i < deviceWidth && hasData[i] === 1;
    if (on && runStart < 0) runStart = i;
    else if (!on && runStart >= 0) {
      drawRun(runStart, i);
      runStart = -1;
    }
  }

  return model.colMaxCss;
}

/** Triage warm-ink silhouette (matches the existing tape-deck palette). */
export const TRIAGE_STYLE: WaveStyle = {
  gradientStops: [
    [0, "rgba(34, 30, 26, 0)"],
    [0.18, "rgba(34, 30, 26, 0.32)"],
    [0.5, "rgba(34, 30, 26, 0.92)"],
    [0.82, "rgba(34, 30, 26, 0.32)"],
    [1, "rgba(34, 30, 26, 0)"],
  ],
  groundColor: "rgba(154,143,128,0.30)",
  padPx: 2,
};

/** Editor ink (#5C544A), same centre-glow shape inside the audio lane. */
export const EDITOR_STYLE: WaveStyle = {
  gradientStops: [
    [0, "rgba(92,84,74,0)"],
    [0.18, "rgba(92,84,74,0.32)"],
    [0.5, "rgba(92,84,74,0.92)"],
    [0.82, "rgba(92,84,74,0.32)"],
    [1, "rgba(92,84,74,0)"],
  ],
  groundColor: "rgba(92,84,74,0.30)",
  padPx: 2,
};
