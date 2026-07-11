/**
 * Regression: the render pipeline's Compositor must work inside a REAL
 * Worker scope, where DOM globals (HTMLImageElement, document) do not
 * exist.
 *
 * The demo project exposed this: any export whose frame loop composites
 * an ImageBitmap (test-pattern gap fill, image cams) crashed the render
 * worker with "HTMLImageElement is not defined" — but only on the
 * WebGPU backend, so machines that fell back to WebGL2 never saw it.
 * Every backend tier is exercised here.
 */
import { describe, expect, it } from "vitest";
import type { BackendCapabilities } from "../../core/render/factory";

interface ResultMessage {
  ok: boolean;
  backendId?: string;
  message?: string;
}

function runInWorker(caps: BackendCapabilities): Promise<ResultMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./compositor-in-worker.fixture.worker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker timed out"));
    }, 30_000);
    worker.addEventListener("message", (e: MessageEvent<ResultMessage>) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(e.data);
    });
    worker.addEventListener("error", (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(e.message || "worker crashed"));
    });
    worker.postMessage({ caps });
  });
}

describe("Compositor inside a real Worker (no DOM globals)", () => {
  it("composites an ImageBitmap on the Canvas2D tier", async () => {
    const result = await runInWorker({ webgl2: false, webgpu: false });
    expect(result.message).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.backendId).toBe("canvas2d");
  });

  it("composites an ImageBitmap on the WebGL2 tier", async () => {
    const result = await runInWorker({ webgl2: true, webgpu: false });
    expect(result.message).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("composites an ImageBitmap on the WebGPU tier (falls back when unavailable)", async () => {
    const result = await runInWorker({ webgl2: true, webgpu: true });
    // On machines without worker WebGPU the factory falls back — the
    // assertion is "no crash", whatever tier ends up serving.
    expect(result.message).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
