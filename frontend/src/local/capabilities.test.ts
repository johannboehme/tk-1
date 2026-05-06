import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectCapabilities,
  meetsMinRequirements,
  probeWebGPUVideoFrameUpload,
  supportsLargeMediaFiles,
  LEGACY_BROWSER_MAX_FILE_BYTES,
  type Capabilities,
} from "./capabilities";

// In jsdom keine WebCodecs/OPFS — wir mocken pro Test, um beide Pfade zu testen.

const ORIGINAL_CROSS_ORIGIN_ISOLATED = (globalThis as { crossOriginIsolated?: boolean })
  .crossOriginIsolated;

function mockEverythingPresent() {
  vi.stubGlobal("WebAssembly", { instantiate: () => undefined });
  vi.stubGlobal("SharedArrayBuffer", class {});
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("AudioDecoder", class {});
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("AudioEncoder", class {});
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("showSaveFilePicker", () => undefined);
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    storage: {
      getDirectory: () => Promise.resolve({}),
    },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore the original crossOriginIsolated value to avoid leaking into other tests.
  if (ORIGINAL_CROSS_ORIGIN_ISOLATED !== undefined) {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated =
      ORIGINAL_CROSS_ORIGIN_ISOLATED;
  }
});

describe("detectCapabilities", () => {
  it("returns a fully populated object in the bare jsdom environment", () => {
    const caps = detectCapabilities();
    // jsdom hat WebAssembly + SharedArrayBuffer per default. Browser-only-APIs fehlen.
    expect(caps).toMatchObject<Partial<Capabilities>>({
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: false,
      opfs: false,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
  });

  it("returns true for every flag when the modern APIs are present", () => {
    mockEverythingPresent();
    const caps = detectCapabilities();
    expect(caps.webAssembly).toBe(true);
    expect(caps.sharedArrayBuffer).toBe(true);
    expect(caps.crossOriginIsolated).toBe(true);
    expect(caps.opfs).toBe(true);
    expect(caps.audioDecoder).toBe(true);
    expect(caps.videoDecoder).toBe(true);
    expect(caps.audioEncoder).toBe(true);
    expect(caps.videoEncoder).toBe(true);
    expect(caps.fileSystemAccess).toBe(true);
  });
});

describe("meetsMinRequirements", () => {
  it("rejects when webAssembly is missing", () => {
    const result = meetsMinRequirements({
      webAssembly: false,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      opfs: true,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("webAssembly");
  });

  it("rejects when sharedArrayBuffer is missing", () => {
    const result = meetsMinRequirements({
      webAssembly: true,
      sharedArrayBuffer: false,
      crossOriginIsolated: true,
      opfs: true,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("sharedArrayBuffer");
  });

  it("rejects when crossOriginIsolated is false (no SAB usable without it)", () => {
    const result = meetsMinRequirements({
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: false,
      opfs: true,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("crossOriginIsolated");
  });

  it("rejects when opfs is missing", () => {
    const result = meetsMinRequirements({
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      opfs: false,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("opfs");
  });

  it("accepts when all min capabilities are present, even without WebCodecs (ffmpeg-wasm fallback path)", () => {
    const result = meetsMinRequirements({
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      opfs: true,
      audioDecoder: false,
      videoDecoder: false,
      audioEncoder: false,
      videoEncoder: false,
      fileSystemAccess: false,
      webgl2: false,
      webgpu: false,
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("accepts when all capabilities are present (Chrome path)", () => {
    const result = meetsMinRequirements({
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      opfs: true,
      audioDecoder: true,
      videoDecoder: true,
      audioEncoder: true,
      videoEncoder: true,
      fileSystemAccess: true,
      webgl2: true,
      webgpu: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("supportsLargeMediaFiles", () => {
  function caps(overrides: Partial<Capabilities> = {}): Capabilities {
    return {
      webAssembly: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      opfs: true,
      audioDecoder: true,
      videoDecoder: true,
      audioEncoder: true,
      videoEncoder: true,
      fileSystemAccess: true,
      webgl2: true,
      webgpu: false,
      ...overrides,
    };
  }

  it("true when both AudioDecoder and VideoDecoder are present", () => {
    expect(supportsLargeMediaFiles(caps())).toBe(true);
  });

  it("false when AudioDecoder is missing (Safari 18- without TP)", () => {
    expect(supportsLargeMediaFiles(caps({ audioDecoder: false }))).toBe(false);
  });

  it("false when VideoDecoder is missing", () => {
    expect(supportsLargeMediaFiles(caps({ videoDecoder: false }))).toBe(false);
  });

  it("LEGACY_BROWSER_MAX_FILE_BYTES is below the Chromium ArrayBuffer cap", () => {
    expect(LEGACY_BROWSER_MAX_FILE_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024);
    expect(LEGACY_BROWSER_MAX_FILE_BYTES).toBeGreaterThan(1.5 * 1024 * 1024 * 1024);
  });
});

describe("detectCapabilities — gpu-related fields", () => {
  it("reports webgpu=false unconditionally (real probe is async via probeWebGPU)", () => {
    // detectCapabilities() is sync and reports webgpu=false by default.
    // The real check lives in probeWebGPU() (calls requestAdapter()),
    // and initCapabilities() merges the probed value into the
    // singleton — see App.tsx boot.
    const caps = detectCapabilities();
    expect(caps.webgpu).toBe(false);
  });

  it("webgl2 is false in jsdom (no WebGL2 implementation)", () => {
    const caps = detectCapabilities();
    expect(caps.webgl2).toBe(false);
  });
});

describe("probeWebGPUVideoFrameUpload", () => {
  // jsdom hat weder OffscreenCanvas noch VideoFrame — wir mocken minimal,
  // damit der Probe-Pfad einmal mit "upload geht" und einmal mit "upload
  // wirft" durchläuft. Modelliert Firefox 148, das einen Adapter hat aber
  // bei copyExternalImageToTexture(VideoFrame) wirft.

  const FakeOffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return {
        fillStyle: "",
        fillRect: () => undefined,
      };
    }
  };
  const FakeVideoFrame = class {
    constructor(_src: unknown, _opts: unknown) {}
    close() {}
  };

  function makeAdapter(opts: { uploadThrows: boolean }): GPUAdapter {
    const fakeQueue = {
      copyExternalImageToTexture: () => {
        if (opts.uploadThrows) {
          throw new TypeError(
            "GPUQueue.copyExternalImageToTexture: 'source' member …",
          );
        }
      },
    };
    const fakeDevice = {
      queue: fakeQueue,
      pushErrorScope: () => undefined,
      popErrorScope: async () => null,
      createTexture: () => ({ destroy: () => undefined }),
      destroy: () => undefined,
    };
    return {
      requestDevice: async () => fakeDevice,
    } as unknown as GPUAdapter;
  }

  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("GPUTextureUsage", {
      COPY_DST: 1,
      TEXTURE_BINDING: 4,
    });
  });

  it("returns true when copyExternalImageToTexture accepts a VideoFrame", async () => {
    const adapter = makeAdapter({ uploadThrows: false });
    expect(await probeWebGPUVideoFrameUpload(adapter)).toBe(true);
  });

  it("returns false when copyExternalImageToTexture throws (Firefox today)", async () => {
    const adapter = makeAdapter({ uploadThrows: true });
    expect(await probeWebGPUVideoFrameUpload(adapter)).toBe(false);
  });

  it("returns false when VideoFrame is missing in the environment", async () => {
    vi.stubGlobal("VideoFrame", undefined);
    const adapter = makeAdapter({ uploadThrows: false });
    expect(await probeWebGPUVideoFrameUpload(adapter)).toBe(false);
  });
});
