/**
 * Mel-spectrogram rendering helpers shared by the Arrange page's
 * "double exposure" overlay (Polaroid card image well + FilmStrip
 * Frame) and the Cockpit MelDisplay.
 *
 * The Polaroid + Frame variants composite the mel onto the video
 * still with `mix-blend-mode: screen`. To behave well across chunk
 * durations (10 s vs 6 min into the same fixed pixel-width well),
 * two summarisation steps are applied before painting:
 *
 *   1. `maxPoolTimeAxis` aggregates the native-rate mel into the
 *      canvas's column count, taking the **peak** per bin. Keeps
 *      percussive transients visible at long durations where mean-
 *      pooling would smooth them away.
 *
 *   2. `normalizeP95` scales so the 95th-percentile non-trivial
 *      value maps to 255. Keeps exposure consistent across short
 *      and long chunks.
 *
 * The phosphor LUT is the OP-1 wine→copper→amber ramp used across
 * the app — the floor is dark wine `rgb(14,8,7)`, the mid is
 * copper `rgb(154,72,24)`, the peak is bright amber `rgb(255,138,
 * 79)`. With `screen` blend the dark wine floor adds barely any
 * brightness over the still (it's the "haunted" feel) while bright
 * amber peaks light up the photograph.
 */
import type { ChunkMelData } from "./chunk-mel";

/** OP-1 amber phosphor lookup. 256 RGBA stops, dark wine floor →
 *  copper mid → bright amber peak. Indexable as `LUT[v * 4 + c]`. */
export const PHOSPHOR_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  const floor: readonly [number, number, number] = [14, 8, 7];
  const mid: readonly [number, number, number] = [154, 72, 24];
  const peak: readonly [number, number, number] = [255, 138, 79];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number;
    if (t < 0.5) {
      const f = t * 2;
      r = floor[0] + (mid[0] - floor[0]) * f;
      g = floor[1] + (mid[1] - floor[1]) * f;
      b = floor[2] + (mid[2] - floor[2]) * f;
    } else {
      const f = (t - 0.5) * 2;
      r = mid[0] + (peak[0] - mid[0]) * f;
      g = mid[1] + (peak[1] - mid[1]) * f;
      b = mid[2] + (peak[2] - mid[2]) * f;
    }
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

/**
 * Max-pool the time axis of a frame-major mel array `data[f * nMels + m]`
 * down to `dstFrames` columns. Each output column holds the per-bin
 * peak over its contiguous source window. When `srcFrames ≤ dstFrames`
 * the input is returned unchanged — the caller paints it as-is.
 */
export function maxPoolTimeAxis(
  src: Uint8Array,
  nMels: number,
  srcFrames: number,
  dstFrames: number,
): Uint8Array {
  if (srcFrames <= dstFrames) return src;
  const out = new Uint8Array(nMels * dstFrames);
  for (let dx = 0; dx < dstFrames; dx++) {
    const s0 = Math.floor((dx * srcFrames) / dstFrames);
    const s1 = Math.max(s0 + 1, Math.floor(((dx + 1) * srcFrames) / dstFrames));
    for (let m = 0; m < nMels; m++) {
      let peak = 0;
      for (let sx = s0; sx < s1; sx++) {
        const v = src[sx * nMels + m];
        if (v > peak) peak = v;
      }
      out[dx * nMels + m] = peak;
    }
  }
  return out;
}

/**
 * In-place 95th-percentile normalisation. The Pth percentile of
 * non-trivial values (above a small noise floor) becomes 255;
 * everything above clamps. Below the noise floor or when the array
 * is too small to be a meaningful sample, no scaling is applied.
 */
export function normalizeP95(data: Uint8Array): void {
  // Guard against tiny arrays — a 3-cell percentile is meaningless.
  if (data.length < 16) return;
  // Build a non-trivial sample. Threshold of 5/255 ≈ 2 % filters the
  // wine-floor noise so all-quiet 99 % data doesn't drag p95 to zero.
  const NOISE = 5;
  const sample: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] > NOISE) sample.push(data[i]);
  }
  if (sample.length === 0) return;
  sample.sort((a, b) => a - b);
  const target = sample[Math.floor(sample.length * 0.95)];
  if (target <= 0) return;
  const scale = 255 / target;
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(data[i] * scale);
    data[i] = v > 255 ? 255 : v;
  }
}

/**
 * Render mel data into `canvas` using the OP-1 phosphor LUT, applying
 * the duration-aware summarisation pipeline (max-pool + p95 normalise).
 *
 * `dstFrames` controls the canvas's internal pixel-width; CSS scales
 * the canvas to the image well's display size and the browser's
 * bilinear filter does the phosphor "bleed" for free.
 *
 * The LUT's wine-black floor means low-energy regions stay almost
 * fully dark — combined with `mix-blend-mode: screen` on the canvas
 * element, the still photograph beneath shows through cleanly.
 */
export function renderMelOverlay(
  canvas: HTMLCanvasElement,
  mel: ChunkMelData,
  dstFrames: number,
): void {
  if (mel.nFrames === 0 || mel.nMels === 0) return;
  const pooled = maxPoolTimeAxis(mel.data, mel.nMels, mel.nFrames, dstFrames);
  const outFrames = pooled === mel.data ? mel.nFrames : dstFrames;
  // Copy before normalising so we don't mutate the cached store data.
  const view = pooled === mel.data ? new Uint8Array(pooled) : pooled;
  normalizeP95(view);
  paintToCanvas(canvas, view, mel.nMels, outFrames);
}

function paintToCanvas(
  canvas: HTMLCanvasElement,
  data: Uint8Array,
  nMels: number,
  nFrames: number,
): void {
  canvas.width = nFrames;
  canvas.height = nMels;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  const img = ctx.createImageData(nFrames, nMels);
  const dst = img.data;
  for (let f = 0; f < nFrames; f++) {
    for (let m = 0; m < nMels; m++) {
      const v = data[f * nMels + m];
      const x = f;
      // Low frequency at the bottom — matches the cockpit MelDisplay.
      const y = nMels - 1 - m;
      const di = (y * nFrames + x) * 4;
      const li = v * 4;
      dst[di + 0] = PHOSPHOR_LUT[li + 0];
      dst[di + 1] = PHOSPHOR_LUT[li + 1];
      dst[di + 2] = PHOSPHOR_LUT[li + 2];
      dst[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
