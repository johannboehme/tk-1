/**
 * Unit-Tests für WebGPUBackend in jsdom — ohne echtes GPU-Device.
 * Hier deckt ab:
 *   - init() wirft sauber wenn `navigator.gpu` fehlt (jsdom)
 *   - id ist "webgpu"
 *   - dispose() ist idempotent (safe ohne init)
 *   - warmup() ist no-op
 *
 * Pixel-Parity wird in webgpu-backend.browser.test.ts verifiziert
 * (echtes GPU-Device, Chromium via Playwright).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebGPUBackend } from "./webgpu-backend";
import {
  getCapabilities,
  initCapabilities,
  _resetWebGPUProbeForTest,
} from "../capabilities";

function mockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  // jsdom hat kein webgpu — getContext("webgpu") liefert null. Das wird
  // im Backend nach dem requestAdapter-Check geprüft, aber wir kommen
  // vorher schon beim "navigator.gpu missing"-Check raus.
  return canvas;
}

describe("WebGPUBackend (jsdom)", () => {
  it("id is 'webgpu'", () => {
    expect(new WebGPUBackend().id).toBe("webgpu");
  });

  it("init() rejects with BackendError when navigator.gpu missing", async () => {
    const b = new WebGPUBackend();
    await expect(
      b.init(mockCanvas(), { pixelW: 1, pixelH: 1 }),
    ).rejects.toThrow(/navigator\.gpu|adapter|init/i);
  });

  it("warmup() is a no-op (resolves immediately)", async () => {
    const b = new WebGPUBackend();
    await expect(b.warmup()).resolves.toBeUndefined();
  });

  it("dispose() is safe to call without init()", () => {
    const b = new WebGPUBackend();
    expect(() => b.dispose()).not.toThrow();
  });

  it("dispose() is idempotent (safe to call twice)", () => {
    const b = new WebGPUBackend();
    b.dispose();
    expect(() => b.dispose()).not.toThrow();
  });
});

describe("WebGPUBackend — device.lost handling (issue #115)", () => {
  // Full fake GPU stack so init() runs to completion in jsdom. Each
  // requestDevice() call yields a FRESH device whose `lost` promise the
  // test can resolve (real losses) or that resolves on destroy()
  // (intentional dispose, reason "destroyed").

  interface FakeLost {
    fire: (info: { reason: string; message: string }) => void;
  }

  function makeFakeDevice(): { device: unknown; lost: FakeLost } {
    let fire!: FakeLost["fire"];
    const lost = new Promise<{ reason: string; message: string }>((res) => {
      let settled = false;
      fire = (info) => {
        if (settled) return;
        settled = true;
        res(info);
      };
    });
    const device = {
      lost,
      queue: {
        copyExternalImageToTexture: () => undefined,
        writeBuffer: () => undefined,
        submit: () => undefined,
      },
      pushErrorScope: () => undefined,
      popErrorScope: async () => null,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy: () => undefined }),
      createTexture: () => ({
        destroy: () => undefined,
        createView: () => ({}),
      }),
      addEventListener: () => undefined,
      destroy: () =>
        fire({ reason: "destroyed", message: "device destroyed" }),
    };
    return { device, lost: { fire } };
  }

  function installFakeGPU(): { lastLost: () => FakeLost } {
    let last: FakeLost | null = null;
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          const { device, lost } = makeFakeDevice();
          last = lost;
          return device;
        },
      }),
    };
    vi.stubGlobal("GPUTextureUsage", {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16,
    });
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    vi.stubGlobal("GPUBufferUsage", {
      MAP_READ: 1,
      MAP_WRITE: 2,
      COPY_SRC: 4,
      COPY_DST: 8,
      UNIFORM: 64,
    });
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect: () => undefined };
      }
    });
    vi.stubGlobal("VideoFrame", class {
      close() {}
    });
    vi.stubGlobal("navigator", { ...globalThis.navigator, gpu });
    return { lastLost: () => last! };
  }

  function webgpuCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    (canvas as unknown as { getContext: (t: string) => unknown }).getContext =
      (t: string) => (t === "webgpu" ? { configure: () => undefined } : null);
    return canvas;
  }

  const flush = () => new Promise((res) => setTimeout(res, 0));

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetWebGPUProbeForTest();
  });

  it("a real device loss fires onContextLost and downgrades the session capability", async () => {
    const { lastLost } = installFakeGPU();
    _resetWebGPUProbeForTest();
    expect((await initCapabilities()).webgpu).toBe(true);

    const b = new WebGPUBackend();
    await b.init(webgpuCanvas(), { pixelW: 4, pixelH: 4 });
    const onLost = vi.fn();
    b.onContextLost = onLost;

    lastLost().fire({ reason: "unknown", message: "GPU process crashed" });
    await flush();

    expect(onLost).toHaveBeenCalledWith({
      reason: "unknown",
      message: "GPU process crashed",
    });
    expect(getCapabilities().webgpu).toBe(false);
  });

  it("dispose() (reason 'destroyed') does NOT fire onContextLost or downgrade", async () => {
    installFakeGPU();
    _resetWebGPUProbeForTest();
    expect((await initCapabilities()).webgpu).toBe(true);

    const b = new WebGPUBackend();
    await b.init(webgpuCanvas(), { pixelW: 4, pixelH: 4 });
    const onLost = vi.fn();
    b.onContextLost = onLost;

    b.dispose();
    await flush();

    expect(onLost).not.toHaveBeenCalled();
    expect(getCapabilities().webgpu).toBe(true);
  });
});
