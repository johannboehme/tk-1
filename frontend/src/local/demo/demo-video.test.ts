import { describe, it, expect } from "vitest";
import { sliceCamAudio } from "./demo-video";

describe("sliceCamAudio", () => {
  const sr = 100; // 100 Hz keeps the math readable
  const song = new Float32Array(1000); // 10 s
  for (let i = 0; i < song.length; i++) song[i] = i;

  it("slices from the cam's song start for the cam's duration", () => {
    const out = sliceCamAudio(song, sr, 2, 3);
    expect(out.length).toBe(300);
    expect(out[0]).toBe(200);
    expect(out[299]).toBe(499);
  });

  it("clamps a slice that runs past the end of the song", () => {
    const out = sliceCamAudio(song, sr, 8, 5);
    expect(out.length).toBe(200); // only 2 s of song remain
    expect(out[0]).toBe(800);
  });

  it("returns an empty slice when the start is past the end", () => {
    expect(sliceCamAudio(song, sr, 12, 2).length).toBe(0);
  });
});
