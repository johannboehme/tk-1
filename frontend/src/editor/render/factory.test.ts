import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackend, type BackendCapabilities } from "./factory";
import { WebGPUBackend } from "./webgpu-backend";
import { BackendError } from "./backend";
import {
  getCapabilities,
  initCapabilities,
  _resetWebGPUProbeForTest,
} from "../../local/capabilities";

/** Mock canvas with a getContext that returns a hand-rolled 2D ctx
 *  (jsdom doesn't ship one). Matches the pattern used in
 *  canvas2d-backend.test.ts. */
function mockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
  };
  (canvas as unknown as { getContext: (type: string) => unknown }).getContext = (
    type: string,
  ) => (type === "2d" ? ctx : null);
  return canvas;
}

const CAPS_NEITHER: BackendCapabilities = { webgl2: false, webgpu: false };
const CAPS_WEBGL2: BackendCapabilities = { webgl2: true, webgpu: false };
const CAPS_BOTH: BackendCapabilities = { webgl2: true, webgpu: true };

describe("createBackend factory — fallback ladder", () => {
  it("falls back to Canvas2D when no GPU capability available", async () => {
    const b = await createBackend(mockCanvas(), { pixelW: 1, pixelH: 1 }, CAPS_NEITHER);
    expect(b.id).toBe("canvas2d");
  });

  it("returns Canvas2D when WebGL2 init throws (jsdom — no real WebGL)", async () => {
    // jsdom's canvas.getContext("webgl2") returns null → WebGL2Backend init
    // throws → factory should fall through to Canvas2D.
    const b = await createBackend(mockCanvas(), { pixelW: 1, pixelH: 1 }, CAPS_WEBGL2);
    expect(b.id).toBe("canvas2d");
  });

  it("attempts WebGPU first when caps.webgpu === true", async () => {
    // Spy on WebGPUBackend.init — caps.webgpu being true is a hard
    // guarantee from the platform probe, so the factory MUST call init.
    // Stub init to resolve so the pipeline doesn't try to allocate a
    // real GPU device under jsdom.
    const initSpy = vi
      .spyOn(WebGPUBackend.prototype, "init")
      .mockImplementation(async () => undefined);
    const disposeSpy = vi
      .spyOn(WebGPUBackend.prototype, "dispose")
      .mockImplementation(() => undefined);
    const b = await createBackend(
      mockCanvas(),
      { pixelW: 1, pixelH: 1 },
      CAPS_BOTH,
    );
    expect(initSpy).toHaveBeenCalledOnce();
    expect(b.id).toBe("webgpu");
    initSpy.mockRestore();
    disposeSpy.mockRestore();
  });

  it("Canvas2DBackend is always reachable as the floor", async () => {
    const b = await createBackend(
      mockCanvas(),
      { pixelW: 100, pixelH: 50 },
      CAPS_NEITHER,
    );
    expect(b.id).toBe("canvas2d");
    b.dispose();
  });
});

describe("createBackend factory — WebGPU init failure (issue #115)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetWebGPUProbeForTest();
  });

  it("falls through the ladder when WebGPUBackend.init rejects (probe was stale)", async () => {
    // A positive probe is NOT a hard guarantee: the GPU process can
    // crash, the driver can reset, or a dGPU/iGPU switch can happen
    // between boot probe and backend init. The factory must fall
    // through to the next rung instead of propagating.
    const initSpy = vi
      .spyOn(WebGPUBackend.prototype, "init")
      .mockRejectedValue(
        new BackendError("init", "requestAdapter returned null"),
      );
    const disposeSpy = vi
      .spyOn(WebGPUBackend.prototype, "dispose")
      .mockImplementation(() => undefined);
    const b = await createBackend(
      mockCanvas(),
      { pixelW: 1, pixelH: 1 },
      CAPS_BOTH,
    );
    expect(initSpy).toHaveBeenCalledOnce();
    // jsdom has no WebGL2 either, so the ladder bottoms out at Canvas2D.
    expect(b.id).toBe("canvas2d");
    // The half-initialised WebGPU backend must be cleaned up.
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("poisons the session WebGPU capability so remounts skip the dead tier", async () => {
    // Boot-probe said webgpu=true (mock a working adapter), then the
    // backend init fails. Afterwards getCapabilities() must report
    // webgpu=false — otherwise every remount re-fails on the WebGPU
    // branch until a full page reload.
    _resetWebGPUProbeForTest();
    const FakeOffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect: () => undefined };
      }
    };
    const FakeVideoFrame = class {
      close() {}
    };
    const fakeDevice = {
      queue: { copyExternalImageToTexture: () => undefined },
      pushErrorScope: () => undefined,
      popErrorScope: async () => null,
      createTexture: () => ({ destroy: () => undefined }),
      destroy: () => undefined,
    };
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("GPUTextureUsage", {
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      RENDER_ATTACHMENT: 16,
    });
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      gpu: {
        requestAdapter: async () => ({ requestDevice: async () => fakeDevice }),
      },
    });
    expect((await initCapabilities()).webgpu).toBe(true);

    vi.spyOn(WebGPUBackend.prototype, "init").mockRejectedValue(
      new BackendError("init", "requestDevice threw: device lost"),
    );
    vi.spyOn(WebGPUBackend.prototype, "dispose").mockImplementation(
      () => undefined,
    );
    const b = await createBackend(
      mockCanvas(),
      { pixelW: 1, pixelH: 1 },
      CAPS_BOTH,
    );
    expect(b.id).toBe("canvas2d");
    expect(getCapabilities().webgpu).toBe(false);
  });
});

// (WebGPUBackend unit tests live in webgpu-backend.test.ts.)
