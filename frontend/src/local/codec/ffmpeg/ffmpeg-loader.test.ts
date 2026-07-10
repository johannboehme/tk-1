/**
 * getFfmpeg() memoization semantics (#118).
 *
 * The load includes a ~25 MB core download; on flaky Wi-Fi (or offline
 * PWA before the runtime cache ever stored the core) that fetch rejects.
 * The memo must NOT cache the rejection forever — a later call has to
 * retry, otherwise every ffmpeg fallback fails instantly until reload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFfmpeg, _resetFfmpegForTests } from "./ffmpeg-loader";

const { mockToBlobURL, mockLoad, mockTerminate } = vi.hoisted(() => ({
  mockToBlobURL: vi.fn<(...args: unknown[]) => Promise<string>>(),
  mockLoad: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  mockTerminate: vi.fn(),
}));

vi.mock("@ffmpeg/util", () => ({
  toBlobURL: mockToBlobURL,
}));
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    load = mockLoad;
    terminate = mockTerminate;
  },
}));
vi.mock("@ffmpeg/ffmpeg/worker?worker&url", () => ({
  default: "mock-worker-url",
}));

beforeEach(() => {
  vi.clearAllMocks();
  _resetFfmpegForTests();
});

describe("getFfmpeg", () => {
  it("memoizes a successful load (one download, one instance)", async () => {
    mockToBlobURL.mockResolvedValue("blob:mock");
    mockLoad.mockResolvedValue(true);

    const a = await getFfmpeg();
    const b = await getFfmpeg();

    expect(b).toBe(a);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockToBlobURL).toHaveBeenCalledTimes(2); // core js + wasm, once
  });

  it("retries after a failed core download instead of caching the rejection", async () => {
    mockToBlobURL.mockRejectedValueOnce(new Error("Failed to fetch"));
    mockToBlobURL.mockRejectedValueOnce(new Error("Failed to fetch"));
    mockToBlobURL.mockResolvedValue("blob:mock");
    mockLoad.mockResolvedValue(true);

    await expect(getFfmpeg()).rejects.toThrow(/decoder|connection/i);

    // Connectivity is back — the next call must start a fresh load, not
    // return the stale rejected promise.
    const ffmpeg = await getFfmpeg();
    expect(ffmpeg).toBeDefined();
    expect(mockToBlobURL).toHaveBeenCalledTimes(4); // 2 failed + 2 retried
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it("names the download as the cause when the core fetch fails", async () => {
    mockToBlobURL.mockRejectedValue(new Error("Failed to fetch"));

    await expect(getFfmpeg()).rejects.toThrow(
      /media decoder.*check your connection.*Failed to fetch/is,
    );
  });

  it("retries when ffmpeg.load() itself rejects (e.g. worker spawn failure)", async () => {
    mockToBlobURL.mockResolvedValue("blob:mock");
    mockLoad.mockRejectedValueOnce(new Error("worker exploded"));
    mockLoad.mockResolvedValue(true);

    await expect(getFfmpeg()).rejects.toThrow(/worker exploded/);
    const ffmpeg = await getFfmpeg();
    expect(ffmpeg).toBeDefined();
    expect(mockLoad).toHaveBeenCalledTimes(2);
  });
});
