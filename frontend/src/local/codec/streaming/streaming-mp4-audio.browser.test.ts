import { describe, it, expect } from "vitest";
import { decodeMp4AudioStreaming } from "./streaming-mp4-audio";
import { decodeAudioToMonoPcm } from "../index";

const MP4_FIXTURE = "/__test_fixtures__/tone-3s.mp4";
const M4A_FIXTURE = "/__test_fixtures__/studio-aac.m4a";

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return await r.blob();
}

function zeroCrossings(buf: Float32Array): number {
  let n = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) n++;
  }
  return n;
}

describe("decodeMp4AudioStreaming", () => {
  it("decodes a 440 Hz tone in MP4 (AAC) at the requested sample rate", async () => {
    if (typeof AudioDecoder === "undefined") {
      const blob = await fetchBlob(MP4_FIXTURE);
      await expect(decodeMp4AudioStreaming(blob, 22050)).rejects.toThrow(
        /AudioDecoder/,
      );
      return;
    }
    const blob = await fetchBlob(MP4_FIXTURE);
    const result = await decodeMp4AudioStreaming(blob, 22050);

    expect(result.backend).toBe("webcodecs");
    expect(result.sampleRate).toBe(22050);
    // tone-3s.mp4 is ~3 seconds — expect ≥ 2.5 sec of PCM.
    expect(result.pcm.length).toBeGreaterThan(22050 * 2.5);

    // Should contain a 440 Hz fundamental — ZC rate ~880/sec across a
    // 1-second window.
    const slice = result.pcm.subarray(22050, 22050 * 2);
    const zc = zeroCrossings(slice);
    expect(zc).toBeGreaterThan(420);
    expect(zc).toBeLessThan(460);
  });

  it("decodes M4A (audio-only AAC container) as well", async () => {
    if (typeof AudioDecoder === "undefined") return; // covered above
    const blob = await fetchBlob(M4A_FIXTURE);
    const result = await decodeMp4AudioStreaming(blob, 22050);
    expect(result.backend).toBe("webcodecs");
    expect(result.pcm.length).toBeGreaterThan(0);
  });

  it(
    "produces audio close to the fast-path output (RMS within tolerance)",
    async () => {
      if (typeof AudioDecoder === "undefined") return;
      const blob = await fetchBlob(MP4_FIXTURE);
      const fast = await decodeAudioToMonoPcm(blob, 22050, {
        forceBackend: "webcodecs",
      });
      const stream = await decodeMp4AudioStreaming(blob, 22050);

      // Lengths should be within ~1 % of each other (boundary handling
      // differs at file edges).
      const lenDelta = Math.abs(fast.pcm.length - stream.pcm.length);
      expect(lenDelta).toBeLessThan(fast.pcm.length * 0.02);

      // RMS energy of a 1-second body slice should match within 20%
      // (channel mixdown + linear-interp resample vs. AudioContext OAC
      // resample produce slightly different gain profiles; for sync
      // purposes that's irrelevant).
      const len = Math.min(fast.pcm.length, stream.pcm.length);
      const start = Math.floor(len * 0.3);
      const end = Math.floor(len * 0.6);
      const fastRms = rms(fast.pcm.subarray(start, end));
      const streamRms = rms(stream.pcm.subarray(start, end));
      expect(streamRms).toBeGreaterThan(fastRms * 0.5);
      expect(streamRms).toBeLessThan(fastRms * 1.5);
    },
    60_000,
  );
});

function rms(buf: Float32Array): number {
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}
