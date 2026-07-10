/**
 * Visualizer interface — one draw call per output frame.
 *
 * The compositor calls `draw(ctx, t, w, h)` after painting the source
 * frame and before subtitle burn-in. The visualizer is responsible for
 * any compositing of its own (alpha, blend mode, transparent regions).
 *
 * Each visualizer owns its source data (PCM, energy curves, etc.) — the
 * compositor doesn't pass it in per-frame. This keeps the composite hot
 * path tight and lets the visualizer pre-compute whatever it needs.
 */

export interface Visualizer {
  /**
   * Paint this visualizer's contribution at MASTER-audio time `t`
   * (seconds into the master track — the audio audible at this output
   * frame) onto the given context. The context's canvas is `w × h`
   * pixels. Master time is the right axis because the visualizer's
   * source data (PCM, energy curves) is decoded from the full master
   * audio; output-relative time diverges from it as soon as segments
   * drop or trim material.
   */
  draw(ctx: OffscreenCanvasRenderingContext2D, t: number, w: number, h: number): void;
}
