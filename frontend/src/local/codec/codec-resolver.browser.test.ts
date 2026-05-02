import { describe, it, expect } from "vitest";
import { decodeAudioToMonoPcm } from "./index";
import { opfs } from "../../storage/opfs";

const FIXTURE_URL = "/__test_fixtures__/tone-3s.mp4";

async function fetchFixture(): Promise<Blob> {
  const r = await fetch(FIXTURE_URL);
  return await r.blob();
}

async function opfsFixture(name: string): Promise<File> {
  const blob = await fetchFixture();
  await opfs.writeFile(`__codec_resolver_test__/${name}`, blob);
  return await opfs.readFile(`__codec_resolver_test__/${name}`);
}

describe("codec resolver: decodeAudioToMonoPcm (real Chromium)", () => {
  it("default path picks WebCodecs (decodeAudioData) for a standard MP4", async () => {
    const blob = await fetchFixture();
    const result = await decodeAudioToMonoPcm(blob, 22050);
    expect(result.backend).toBe("webcodecs");
    expect(result.sampleRate).toBe(22050);
    expect(result.pcm.length).toBeGreaterThan(22050 * 2.5);
  });

  it(
    "ffmpeg.wasm fallback yields the same audio (within tolerance) when forced",
    async () => {
      const blob = await fetchFixture();
      const a = await decodeAudioToMonoPcm(blob, 22050, {
        forceBackend: "webcodecs",
      });
      const b = await decodeAudioToMonoPcm(blob, 22050, {
        forceBackend: "ffmpeg-wasm",
      });
      expect(b.backend).toBe("ffmpeg-wasm");

      // Both paths should produce roughly the same number of samples
      // (within 100 ms due to differing edge handling).
      const tolSamples = 22050 / 10;
      expect(Math.abs(a.pcm.length - b.pcm.length)).toBeLessThan(tolSamples);

      // RMS sanity: both paths produce non-trivial audio. Exact match is
      // not enforced because WebCodecs and ffmpeg use different mono
      // mix-down strategies (channel averaging vs filter-graph downmix).
      const aRms = rms(a.pcm.slice(22050, 22050 * 2));
      const bRms = rms(b.pcm.slice(22050, 22050 * 2));
      expect(aRms).toBeGreaterThan(0.05);
      expect(bRms).toBeGreaterThan(0.05);

      // Both must report a 440 Hz fundamental (zero-crossing rate ~880/s).
      const aZc = zeroCrossings(a.pcm.slice(22050, 22050 * 2));
      const bZc = zeroCrossings(b.pcm.slice(22050, 22050 * 2));
      expect(aZc).toBeGreaterThan(420);
      expect(aZc).toBeLessThan(460);
      expect(bZc).toBeGreaterThan(420);
      expect(bZc).toBeLessThan(460);
    },
    120_000, // ffmpeg.wasm cold start can be slow
  );

  it("WebCodecs path decodes a plain MP3 (ID3v2.4, 128k, 48kHz mono)", async () => {
    // Sanity check that our WebCodecs/decodeAudioData path handles a
    // real-world MP3 without falling back to ffmpeg.wasm. If a user reports
    // `[decoding-studio-audio]` failures with a normal-looking MP3, this
    // test passing means the bug is in their specific file (truncated,
    // weird VBR header, unusual sample rate, or actually an M4A renamed
    // .mp3) rather than a regression in our decoder pipeline.
    const r = await fetch("/__test_fixtures__/studio-mp3.mp3");
    const blob = await r.blob();
    const result = await decodeAudioToMonoPcm(blob, 22050);
    expect(result.backend).toBe("webcodecs");
    expect(result.sampleRate).toBe(22050);
    expect(result.pcm.length).toBeGreaterThan(0);
  });

  it(
    "ffmpeg.wasm fallback works on an OPFS-backed File (regression: legacy FileReader path)",
    async () => {
      // Repro for: a job whose master audio came from `<input type=file>`,
      // got persisted to OPFS, then surfaces as `await handle.getFile()`. If
      // the WebCodecs decoder rejects (corrupt header, unsupported codec,
      // etc.), the resolver falls back to ffmpeg.wasm — which used to call
      // @ffmpeg/util's `fetchFile`, internally `FileReader.readAsArrayBuffer`.
      // FileReader rejects on OPFS-backed Files in some Chromium builds with
      // the opaque "File could not be read! Code=-1" message. The fix routes
      // the bytes through `source.arrayBuffer()` instead.
      const file = await opfsFixture("tone-from-opfs.mp4");
      const result = await decodeAudioToMonoPcm(file, 22050, {
        forceBackend: "ffmpeg-wasm",
      });
      expect(result.backend).toBe("ffmpeg-wasm");
      expect(result.pcm.length).toBeGreaterThan(22050 * 2.5);
    },
    120_000,
  );
});

function rms(buf: Float32Array): number {
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

function zeroCrossings(buf: Float32Array): number {
  let n = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) n++;
  }
  return n;
}
