import { describe, it, expect } from "vitest";
import { decodeAudioToMonoPcmFfmpeg } from "./audio-decode";
import { getFfmpeg } from "./ffmpeg-loader";

const FIXTURE_URL = "/__test_fixtures__/tone-3s.mp4";

async function fetchFixture(): Promise<Blob> {
  const r = await fetch(FIXTURE_URL);
  return await r.blob();
}

/** Names of regular files in the ffmpeg MEMFS root that our decode
 *  created (input-*.bin / output-*.wav). */
async function tempFilesInMemfs(): Promise<string[]> {
  const ffmpeg = await getFfmpeg();
  const nodes = await ffmpeg.listDir("/");
  return nodes
    .map((n) => n.name)
    .filter((name) => /^(input-|output-)/.test(name));
}

describe("decodeAudioToMonoPcmFfmpeg: failure handling (#117)", () => {
  it(
    "rejects with ffmpeg's own diagnostic (exit code + stderr) on undecodable input",
    async () => {
      // Deterministic garbage: no container ffmpeg can recognize, so the
      // transcode exits non-zero without writing output. Previously the
      // unchecked exec was followed by a blind readFile, surfacing an
      // opaque Emscripten "FS error" instead of ffmpeg's actual reason.
      const garbage = new Uint8Array(64 * 1024);
      for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
      let err: unknown;
      try {
        await decodeAudioToMonoPcmFfmpeg(garbage.buffer, 22050);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/exit code \d+/);
      // The captured ffmpeg log must name the real cause (stderr context).
      expect(msg).toMatch(/invalid data|unable to|could not|error/i);
      expect(msg).not.toMatch(/FS error/);
    },
    120_000, // ffmpeg.wasm cold start can be slow
  );

  it(
    "cleans up MEMFS temp files even when the transcode fails (no leak across retries)",
    async () => {
      const garbage = new Uint8Array(1024).fill(0xab);
      await decodeAudioToMonoPcmFfmpeg(garbage.buffer, 22050).catch(() => {});
      await decodeAudioToMonoPcmFfmpeg(garbage.buffer, 22050).catch(() => {});
      expect(await tempFilesInMemfs()).toEqual([]);
    },
    120_000,
  );

  it(
    "cleans up MEMFS temp files after a successful decode too",
    async () => {
      const blob = await fetchFixture();
      const result = await decodeAudioToMonoPcmFfmpeg(blob, 22050);
      expect(result.backend).toBe("ffmpeg-wasm");
      expect(result.pcm.length).toBeGreaterThan(22050 * 2.5);
      expect(await tempFilesInMemfs()).toEqual([]);
    },
    120_000,
  );
});
