/**
 * Test fixture: run the Compositor inside a REAL Worker scope — no DOM
 * globals (no HTMLImageElement, no document). Mirrors exactly what
 * edit.worker.ts does when the frame loop composites an ImageBitmap
 * (test-pattern / image-cam path).
 *
 * Regression target: the WebGPU backend crashed the whole render with
 * "HTMLImageElement is not defined" the first time an ImageBitmap layer
 * was uploaded from a worker.
 */
import { Compositor } from "./compositor";
import type { BackendCapabilities } from "../../core/render/factory";

interface RunMessage {
  caps: BackendCapabilities;
}

interface ResultMessage {
  ok: boolean;
  backendId?: string;
  message?: string;
}

self.addEventListener("message", (e: MessageEvent<RunMessage>) => {
  void run(e.data).then((result) => {
    (self as unknown as Worker).postMessage(result);
  });
});

async function run(msg: RunMessage): Promise<ResultMessage> {
  try {
    const w = 64;
    const h = 64;
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext("2d")!;
    ctx.fillStyle = "rgb(255, 0, 0)";
    ctx.fillRect(0, 0, w, h);
    const bitmap = off.transferToImageBitmap();

    const compositor = await Compositor.create(
      {
        width: w,
        height: h,
        sourceWidth: w,
        sourceHeight: h,
        overlays: [],
        visualizers: [],
        fx: [],
      },
      msg.caps,
    );
    const backendId = compositor.backendId;
    const frame = await compositor.compositeImage(bitmap, w, h, 0, 33333, {
      tTimelineS: 0,
      tMasterS: 0,
    });
    frame.close();
    bitmap.close();
    compositor.destroy();
    return { ok: true, backendId };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
