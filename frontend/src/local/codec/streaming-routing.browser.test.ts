import { describe, it, expect } from "vitest";
import { decodeAudioToMonoPcm } from "./index";

const MP4_FIXTURE = "/__test_fixtures__/tone-3s.mp4";
const MP3_FIXTURE = "/__test_fixtures__/studio-mp3.mp3";

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return await r.blob();
}

describe("codec resolver: streaming-routing", () => {
  it("forceBackend='streaming' picks the right sub-decoder by content sniff (MP4)", async () => {
    if (typeof AudioDecoder === "undefined") return;
    const blob = await fetchBlob(MP4_FIXTURE);
    const result = await decodeAudioToMonoPcm(blob, 22050, {
      forceBackend: "streaming",
    });
    expect(result.backend).toBe("webcodecs");
    expect(result.pcm.length).toBeGreaterThan(22050 * 2.5);
  });

  it("forceBackend='streaming' picks MP3 sub-decoder for an MP3 source", async () => {
    if (typeof AudioDecoder === "undefined") return;
    const blob = await fetchBlob(MP3_FIXTURE);
    const result = await decodeAudioToMonoPcm(blob, 22050, {
      forceBackend: "streaming",
    });
    expect(result.backend).toBe("webcodecs");
    expect(result.pcm.length).toBeGreaterThan(22050);
  });

  it("forceBackend='streaming' rejects ArrayBuffer source with a clear message", async () => {
    const ab = new ArrayBuffer(64);
    await expect(
      decodeAudioToMonoPcm(ab, 22050, { forceBackend: "streaming" }),
    ).rejects.toThrow(/Blob\/File source/);
  });

  it("forceBackend='streaming' on unrecognised container surfaces a useful error", async () => {
    const blob = new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer]);
    await expect(
      decodeAudioToMonoPcm(blob, 22050, { forceBackend: "streaming" }),
    ).rejects.toThrow(/streamable/i);
  });

  it("auto-routes a small MP3 Blob through the streaming path (sub-progress emitted)", async () => {
    // Regression for the [decoding-studio-audio] OOM: a long (~45 MB) MP3
    // expands to ~1 GB of PCM and blows up the whole-file decodeAudioData /
    // ffmpeg paths. Streamable Blobs must take the memory-safe streaming path
    // regardless of file size — not only when they cross the old 500 MB gate.
    // We can't tell streaming from whole-file by `backend` (both report
    // "webcodecs"), so we use the progress signature instead: streaming emits
    // a fraction after each read batch (0 < f < 1); the whole-file path only
    // ever emits 0 then 1.
    if (typeof AudioDecoder === "undefined") return;
    const blob = await fetchBlob(MP3_FIXTURE);
    const fracs: number[] = [];
    const result = await decodeAudioToMonoPcm(blob, 22050, {
      onProgress: (f) => fracs.push(f),
    });
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(fracs.some((f) => f > 0 && f < 1)).toBe(true);
  });

  it("auto-routes an ArrayBuffer source through the whole-file path (no sub-progress)", async () => {
    // ArrayBuffer sources can't be streamed (no incremental slicing), so they
    // must fall through to decodeAudioData -> ffmpeg, which reports only 0/1.
    const ab = await (await fetchBlob(MP4_FIXTURE)).arrayBuffer();
    const fracs: number[] = [];
    const result = await decodeAudioToMonoPcm(ab, 22050, {
      onProgress: (f) => fracs.push(f),
    });
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(fracs.some((f) => f > 0 && f < 1)).toBe(false);
  });
});
