import { describe, it, expect } from "vitest";
import { buildPeakPyramid } from "./peak-pyramid";
import { buildPeakPyramidAsync } from "./build-pyramid-async";

function sine(n: number, sr: number, freq: number, amp = 1): Float32Array {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return y;
}

describe("buildPeakPyramidAsync", () => {
  it("produces a pyramid identical to the sync builder", async () => {
    const sr = 22050;
    const pcm = sine(5 * sr, sr, 440); // 5s, several chunks at a small chunk size
    const sync = buildPeakPyramid(pcm, sr, { withRms: true });
    const asy = await buildPeakPyramidAsync(pcm, sr, {
      withRms: true,
      chunkSamples: 32_768, // force many chunks
    });
    expect(asy.levels.length).toBe(sync.levels.length);
    expect(asy.globalPeak).toBeCloseTo(sync.globalPeak, 6);
    expect(asy.durationS).toBeCloseTo(sync.durationS, 6);
    for (let L = 0; L < sync.levels.length; L++) {
      expect(asy.levels[L].bucketCount).toBe(sync.levels[L].bucketCount);
      expect(Array.from(asy.levels[L].max)).toEqual(Array.from(sync.levels[L].max));
      expect(Array.from(asy.levels[L].min)).toEqual(Array.from(sync.levels[L].min));
    }
  });

  it("reports progress ending at 1", async () => {
    const sr = 22050;
    const pcm = sine(2 * sr, sr, 440);
    let last = 0;
    await buildPeakPyramidAsync(pcm, sr, {
      chunkSamples: 16_384,
      onProgress: (f) => {
        last = f;
      },
    });
    expect(last).toBeCloseTo(1, 6);
  });

  it("handles empty PCM", async () => {
    const p = await buildPeakPyramidAsync(new Float32Array(0), 22050);
    expect(p.levels).toEqual([]);
    expect(p.sampleCount).toBe(0);
  });
});
