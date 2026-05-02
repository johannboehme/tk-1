import { describe, it, expect } from "vitest";
import { decodeMp3Streaming } from "./streaming-mp3";

const MP3_FIXTURE = "/__test_fixtures__/studio-mp3.mp3";

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return await r.blob();
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

describe("decodeMp3Streaming", () => {
  it("decodes a real MP3 (ID3v2.4 + Layer III) and produces non-silent PCM", async () => {
    if (typeof AudioDecoder === "undefined") {
      // Browser doesn't support AudioDecoder (Firefox/Safari pre-WebCodecs):
      // verify we error cleanly.
      const blob = await fetchBlob(MP3_FIXTURE);
      await expect(decodeMp3Streaming(blob, 22050)).rejects.toThrow(
        /AudioDecoder/,
      );
      return;
    }
    const blob = await fetchBlob(MP3_FIXTURE);
    const result = await decodeMp3Streaming(blob, 22050);

    expect(result.backend).toBe("webcodecs");
    expect(result.sampleRate).toBe(22050);
    // Studio fixture is at least a few seconds; PCM length should reflect
    // that — at least 1 second of audio at 22050 Hz.
    expect(result.pcm.length).toBeGreaterThan(22050);

    // Body of the signal is non-silent (RMS well above noise floor).
    const bodyRms = rms(result.pcm.subarray(22050, Math.min(44100, result.pcm.length)));
    expect(bodyRms).toBeGreaterThan(0.01);
  });
});
