/**
 * `showwaves`-style waveform visualizer.
 *
 * Draws the audio waveform as a horizontal trace, scrolling with playback
 * time. Mirrors ffmpeg's `showwaves=mode=line` filter visually. Owns the
 * full audio PCM so it can be drawn deterministically per timestamp.
 */

import type { Visualizer } from "./types";

export interface ShowwavesOptions {
  /** Mono PCM of the FULL master audio — indexed by the master time the
   *  compositor passes to `draw`. */
  pcm: Float32Array;
  sampleRate: number;
  /** Region of the canvas to occupy: top, height in pixels. */
  yPosition?: number;
  height?: number;
  /** Visible time window in seconds. */
  windowSeconds?: number;
  color?: string;
  background?: string | null;
  lineWidth?: number;
}

export class ShowwavesVisualizer implements Visualizer {
  private pcm: Float32Array;
  private sampleRate: number;
  private yPosition: number;
  private height: number;
  private windowSeconds: number;
  private color: string;
  private background: string | null;
  private lineWidth: number;

  constructor(opts: ShowwavesOptions) {
    this.pcm = opts.pcm;
    this.sampleRate = opts.sampleRate;
    this.yPosition = opts.yPosition ?? -1; // default: bottom-aligned
    this.height = opts.height ?? 80;
    this.windowSeconds = opts.windowSeconds ?? 2.0;
    this.color = opts.color ?? "rgba(255, 87, 34, 0.85)"; // TE hot orange
    this.background = opts.background ?? "rgba(0, 0, 0, 0.35)";
    this.lineWidth = opts.lineWidth ?? 2;
  }

  draw(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number): void {
    const top = this.yPosition < 0 ? h - this.height - 16 : this.yPosition;
    const stripH = this.height;

    if (this.background !== null) {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, top, w, stripH);
    }

    const halfWindow = this.windowSeconds / 2;
    const startSample = Math.max(0, Math.floor((t - halfWindow) * this.sampleRate));
    const endSample = Math.min(this.pcm.length, Math.ceil((t + halfWindow) * this.sampleRate));
    if (endSample <= startSample) return;
    const visible = endSample - startSample;
    const samplesPerPixel = Math.max(1, Math.floor(visible / w));

    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.beginPath();
    const center = top + stripH / 2;
    const amplitude = stripH / 2 - 2;

    for (let x = 0; x < w; x++) {
      const segStart = startSample + x * samplesPerPixel;
      const segEnd = Math.min(this.pcm.length, segStart + samplesPerPixel);
      let lo = 0;
      let hi = 0;
      for (let i = segStart; i < segEnd; i++) {
        const v = this.pcm[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const yLo = center - lo * amplitude;
      const yHi = center - hi * amplitude;
      if (x === 0) ctx.moveTo(x, (yLo + yHi) / 2);
      ctx.moveTo(x, yLo);
      ctx.lineTo(x, yHi);
    }
    ctx.stroke();
    ctx.restore();
  }
}
