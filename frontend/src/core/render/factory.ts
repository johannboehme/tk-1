/**
 * Backend factory — picks the best available CompositorBackend for the
 * supplied capabilities. Strict ladder: WebGPU → WebGL2 → Canvas2D.
 *
 * `capabilities.webgpu === true` is the boot probe's best guess, NOT a
 * hard guarantee: between probe and init the GPU process can crash,
 * the driver can reset, or a dGPU/iGPU switch can invalidate the
 * adapter. A failing WebGPU rung therefore falls through to WebGL2 and
 * calls `markWebGPUUnavailable()` so remounts skip the dead tier for
 * the rest of the session.
 *
 * Caveat: if WebGPU init fails AFTER `canvas.getContext("webgpu")`
 * succeeded (rare — pipeline setup), the canvas's context mode is
 * already fixed and the lower rungs can't claim it; recovery then
 * needs a fresh canvas (the Compositor remounts one on context loss).
 * All common failure paths (requestAdapter null/throw, requestDevice
 * throw) happen before the context is claimed.
 *
 * WebGL2 keeps a try/catch fallback because jsdom's
 * `getContext('webgl2')` returns null even when the host probe (in a
 * real browser) said it was available — that branch handles unit
 * tests that exercise the factory under jsdom.
 */
import { markWebGPUUnavailable } from "../capabilities";
import { Canvas2DBackend } from "./canvas2d-backend";
import { WebGL2Backend } from "./webgl2-backend";
import { WebGPUBackend } from "./webgpu-backend";
import type { BackendCaps, CompositorBackend } from "./backend";

export interface BackendCapabilities {
  webgl2: boolean;
  webgpu: boolean;
}

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export async function createBackend(
  canvas: AnyCanvas,
  caps: BackendCaps,
  capabilities: BackendCapabilities,
): Promise<CompositorBackend> {
  if (capabilities.webgpu) {
    const b = new WebGPUBackend();
    try {
      await b.init(canvas, caps);
      return b;
    } catch (err) {
      console.warn(
        "[compositor] WebGPU init failed, falling back to WebGL2:",
        err,
      );
      try {
        b.dispose();
      } catch {
        /* partially initialised — nothing more to release */
      }
      markWebGPUUnavailable();
    }
  }
  if (capabilities.webgl2) {
    try {
      const b = new WebGL2Backend();
      await b.init(canvas, caps);
      return b;
    } catch (err) {
      console.warn(
        "[compositor] WebGL2 init failed, falling back to Canvas2D:",
        err,
      );
    }
  }
  const b = new Canvas2DBackend();
  await b.init(canvas, caps);
  return b;
}
