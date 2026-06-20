import { describe, it, expect, vi } from "vitest";
import { loadMasterAudio, type LoadMasterAudioDeps } from "./load-master-audio";
import type { PeakPyramid } from "../local/waveform/peak-pyramid";

/** Minimal pyramid stand-in — only the fields the loader reads. */
function fakePyramid(durationS: number, sampleRate = 22050): PeakPyramid {
  return { version: 1, sampleRate, durationS } as unknown as PeakPyramid;
}

function decoded(sampleRate = 22050) {
  return { pcm: new Float32Array([0.1, -0.2, 0.3]), sampleRate };
}

function makeDeps(over: Partial<LoadMasterAudioDeps> = {}): LoadMasterAudioDeps {
  return {
    getCachedPyramid: vi.fn(async () => undefined),
    decode: vi.fn(async () => decoded()),
    buildPyramid: vi.fn(async (_id, _pcm, sr) => fakePyramid(7, sr)),
    ...over,
  };
}

describe("loadMasterAudio", () => {
  it("uses the cached pyramid's duration WITHOUT decoding (the fast path)", async () => {
    const cached = fakePyramid(123.4);
    const deps = makeDeps({ getCachedPyramid: vi.fn(async () => cached) });

    const out = await loadMasterAudio("job-1", 22050, deps);

    expect(out.wave?.duration).toBe(123.4);
    expect(out.wave?.pyramid).toBe(cached);
    // The whole point: no decode and no rebuild gate the result.
    expect(deps.decode).not.toHaveBeenCalled();
    expect(deps.buildPyramid).not.toHaveBeenCalled();
  });

  it("queries the cache with the requested sample rate", async () => {
    const getCachedPyramid = vi.fn(async () => fakePyramid(10));
    await loadMasterAudio("job-1", 48000, makeDeps({ getCachedPyramid }));
    expect(getCachedPyramid).toHaveBeenCalledWith("job-1", 48000);
  });

  it("getPcm() lazily decodes at most once on the fast path", async () => {
    const decode = vi.fn(async () => decoded());
    const out = await loadMasterAudio(
      "job-1",
      22050,
      makeDeps({ getCachedPyramid: vi.fn(async () => fakePyramid(5)), decode }),
    );

    expect(decode).not.toHaveBeenCalled(); // not yet — deferred
    const a = await out.getPcm();
    const b = await out.getPcm();
    expect(decode).toHaveBeenCalledTimes(1); // memoized
    expect(a).toBe(b);
    expect(a?.pcm.length).toBe(3);
  });

  it("on cache miss: decodes, builds+persists the pyramid, derives duration from it", async () => {
    const buildPyramid = vi.fn(async (_id, _pcm, sr) => fakePyramid(88, sr));
    const decode = vi.fn(async () => decoded(22050));
    const out = await loadMasterAudio(
      "job-1",
      22050,
      makeDeps({ getCachedPyramid: vi.fn(async () => undefined), decode, buildPyramid }),
    );

    expect(out.wave?.duration).toBe(88);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(buildPyramid).toHaveBeenCalledWith("job-1", expect.any(Float32Array), 22050);
  });

  it("on cache miss: getPcm() reuses the cold-path decode (no second decode)", async () => {
    const decode = vi.fn(async () => decoded());
    const out = await loadMasterAudio(
      "job-1",
      22050,
      makeDeps({ getCachedPyramid: vi.fn(async () => undefined), decode }),
    );
    const pcm = await out.getPcm();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(pcm?.pcm.length).toBe(3);
  });

  it("returns wave=null (graceful) when decode fails on the cold path", async () => {
    const out = await loadMasterAudio(
      "job-1",
      22050,
      makeDeps({
        getCachedPyramid: vi.fn(async () => undefined),
        decode: vi.fn(async () => {
          throw new Error("no audio");
        }),
      }),
    );
    expect(out.wave).toBeNull();
    expect(await out.getPcm()).toBeNull();
  });

  it("treats a cache read error as a miss and falls back to decode", async () => {
    const buildPyramid = vi.fn(async (_id, _pcm, sr) => fakePyramid(33, sr));
    const out = await loadMasterAudio(
      "job-1",
      22050,
      makeDeps({
        getCachedPyramid: vi.fn(async () => {
          throw new Error("idb down");
        }),
        buildPyramid,
      }),
    );
    expect(out.wave?.duration).toBe(33);
    expect(buildPyramid).toHaveBeenCalledTimes(1);
  });
});
