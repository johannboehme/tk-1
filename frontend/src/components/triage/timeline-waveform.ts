/**
 * Windowed RMS-envelope waveform rendering, shared by the seam lanes.
 * Same mip-pyramid + peak-hold + warm-ink gradient approach as the main
 * TriageTimeline, but drawn for an arbitrary [t0S, t1S] master-time
 * window so each seam lane can show a slice of any chunk at any zoom.
 */

/** Build a max-pool mip pyramid (≤2 samples/px at any zoom) + the global
 *  peak for normalisation. Pure — safe to memoise on the envelope. */
export function buildMips(
  envelope: Float32Array | null,
): { mips: Float32Array[]; peak: number } {
  if (!envelope || envelope.length === 0) return { mips: [], peak: 1 };
  const mips: Float32Array[] = [envelope];
  let cur = envelope;
  while (cur.length > 64) {
    const next = new Float32Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[i * 2] ?? 0;
      const b = cur[i * 2 + 1] ?? 0;
      next[i] = a > b ? a : b;
    }
    mips.push(next);
    cur = next;
  }
  let peak = 0.01;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > peak) peak = envelope[i];
  }
  return { mips, peak };
}

export interface DrawEnvelopeOpts {
  mips: Float32Array[];
  envelopeHz: number;
  peak: number;
  /** Master-time window (seconds) mapped across the canvas width. */
  t0S: number;
  t1S: number;
  /** CSS pixel size of the canvas. */
  w: number;
  h: number;
}

/** Draw the envelope window into an already DPR-scaled 2D context.
 *  Caller clears + sets the transform. */
export function drawEnvelopeWindow(
  ctx: CanvasRenderingContext2D,
  { mips, envelopeHz, peak, t0S, t1S, w, h }: DrawEnvelopeOpts,
): void {
  const cx = h / 2;
  // Subtle ground line so a dead-silent window still reads as a lane.
  ctx.strokeStyle = "rgba(154,143,128,0.30)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, cx);
  ctx.lineTo(w, cx);
  ctx.stroke();

  if (mips.length === 0 || t1S <= t0S || w <= 0) return;

  const pxPerSec = w / (t1S - t0S);
  const xToTime = (xPx: number) => t0S + xPx / pxPerSec;
  const peakRef = Math.max(0.01, peak);
  const half = h / 2 - 2;

  // Pick the mip level for ≤ ~2 samples per pixel.
  const samplesPerPxL0 = envelopeHz / pxPerSec;
  let level = 0;
  while (level + 1 < mips.length && samplesPerPxL0 / Math.pow(2, level) > 2) {
    level++;
  }
  const mip = mips[level];
  const mipHz = envelopeHz / Math.pow(2, level);
  const sPerSample = 1 / mipHz;

  const samples = new Float32Array(w);
  for (let xPx = 0; xPx < w; xPx++) {
    const t0 = xToTime(xPx);
    const t1 = xToTime(xPx + 1);
    const i0 = Math.max(0, Math.floor(t0 / sPerSample));
    const i1 = Math.min(mip.length, Math.ceil(t1 / sPerSample));
    let m = 0;
    if (i1 > i0) {
      for (let i = i0; i < i1; i++) if (mip[i] > m) m = mip[i];
    } else if (i0 < mip.length) {
      const sFloat = t0 / sPerSample;
      const j = Math.floor(sFloat);
      const frac = sFloat - j;
      const a = mip[Math.max(0, Math.min(mip.length - 1, j))] ?? 0;
      const b = mip[Math.max(0, Math.min(mip.length - 1, j + 1))] ?? 0;
      m = a * (1 - frac) + b * frac;
    }
    samples[xPx] = m / peakRef;
  }

  // 3-tap smoothing.
  const smoothed = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const a = samples[Math.max(0, x - 1)];
    const b = samples[x];
    const c = samples[Math.min(w - 1, x + 1)];
    smoothed[x] = (a + 2 * b + c) * 0.25;
  }

  const yTop = (v: number) => cx - v * half;
  const yBot = (v: number) => cx + v * half;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(34, 30, 26, 0)");
  grad.addColorStop(0.18, "rgba(34, 30, 26, 0.32)");
  grad.addColorStop(0.5, "rgba(34, 30, 26, 0.92)");
  grad.addColorStop(0.82, "rgba(34, 30, 26, 0.32)");
  grad.addColorStop(1, "rgba(34, 30, 26, 0)");
  ctx.beginPath();
  ctx.moveTo(0, yTop(smoothed[0]));
  for (let x = 1; x < w; x++) ctx.lineTo(x, yTop(smoothed[x]));
  for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, yBot(smoothed[x]));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}
