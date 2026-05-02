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
});
