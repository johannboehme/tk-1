/**
 * Codec resolver routing tests (#127).
 *
 * The auto-fallback ladder (streaming → decodeAudioData → ffmpeg.wasm) is
 * the recovery story for weird phone recordings; these tests pin the
 * ROUTING decisions with stubbed sub-decoders — which backend runs, when
 * fallback is allowed, when we give up, and what the aggregated error
 * says. Real-decoder integration lives in codec-resolver.browser.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeAudioToMonoPcm, type DecodedAudio } from "./index";

const { mockStreamingMp4, mockWebcodecs, mockFfmpeg } = vi.hoisted(() => ({
  mockStreamingMp4:
    vi.fn<(...args: unknown[]) => Promise<DecodedAudio>>(),
  mockWebcodecs: vi.fn<(...args: unknown[]) => Promise<DecodedAudio>>(),
  mockFfmpeg: vi.fn<(...args: unknown[]) => Promise<DecodedAudio>>(),
}));

vi.mock("./streaming/streaming-mp4-audio", () => ({
  decodeMp4AudioStreaming: mockStreamingMp4,
}));
vi.mock("./webcodecs/audio-decode", () => ({
  decodeAudioToMonoPcm: mockWebcodecs,
}));
vi.mock("./ffmpeg/audio-decode", () => ({
  decodeAudioToMonoPcmFfmpeg: mockFfmpeg,
}));

// jsdom's Blob has no arrayBuffer(); the container sniff needs it.
// Local polyfill via FileReader (which jsdom does implement).
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

function decoded(backend: DecodedAudio["backend"]): DecodedAudio {
  return {
    pcm: new Float32Array(2205),
    sampleRate: 22050,
    durationS: 0.1,
    backend,
  };
}

/** A Blob whose head sniffs as MP4 (ftyp box at offset 4). */
function mp4Blob(): Blob {
  return new Blob([
    new Uint8Array([
      0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
      0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, // "isom" + minor version
    ]),
  ]);
}

/** Same magic bytes, but reporting a size above STREAMING_THRESHOLD
 *  (500 MiB) without actually allocating it. */
class HugeMp4Blob extends Blob {
  get size(): number {
    return 600 * 1024 * 1024;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("decodeAudioToMonoPcm: auto-route fallback ladder", () => {
  it("falls back streaming → webcodecs when streaming fails on a small Blob", async () => {
    mockStreamingMp4.mockRejectedValue(new Error("mp4box: moov box not found"));
    mockWebcodecs.mockResolvedValue(decoded("webcodecs"));

    const result = await decodeAudioToMonoPcm(mp4Blob(), 22050);

    expect(result.backend).toBe("webcodecs");
    expect(mockStreamingMp4).toHaveBeenCalledTimes(1);
    expect(mockWebcodecs).toHaveBeenCalledTimes(1);
    expect(mockFfmpeg).not.toHaveBeenCalled();
  });

  it("surfaces the streaming error directly (no fallback) at >= 500 MiB — a whole-file retry would OOM", async () => {
    const streamErr = new Error("mp4box: moov box not found");
    mockStreamingMp4.mockRejectedValue(streamErr);

    const huge = new HugeMp4Blob([await mp4Blob().arrayBuffer()]);
    await expect(decodeAudioToMonoPcm(huge, 22050)).rejects.toBe(streamErr);

    expect(mockWebcodecs).not.toHaveBeenCalled();
    expect(mockFfmpeg).not.toHaveBeenCalled();
  });

  it("gives up without trying ffmpeg when the WebCodecs error NAME flags the native decoder (/webkit|webcodecs/i)", async () => {
    // The regex gate in index.ts routes on err.name. If Chromium ever
    // renames these errors, this pin fails loudly instead of the ffmpeg
    // fallback silently dying.
    const nativeErr = new Error("native decoder says no");
    nativeErr.name = "WebCodecsNotSupportedError";
    mockWebcodecs.mockRejectedValue(nativeErr);

    // ArrayBuffer source skips the streaming path entirely.
    await expect(decodeAudioToMonoPcm(new ArrayBuffer(64), 22050)).rejects.toBe(
      nativeErr,
    );
    expect(mockFfmpeg).not.toHaveBeenCalled();
  });

  it("falls back webcodecs → ffmpeg for ordinary decode failures (e.g. EncodingError)", async () => {
    const err = new Error("decode broke");
    err.name = "EncodingError";
    mockWebcodecs.mockRejectedValue(err);
    mockFfmpeg.mockResolvedValue(decoded("ffmpeg-wasm"));

    const result = await decodeAudioToMonoPcm(new ArrayBuffer(64), 22050);

    expect(result.backend).toBe("ffmpeg-wasm");
    expect(mockWebcodecs).toHaveBeenCalledTimes(1);
    expect(mockFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("aggregates all three backend failures into the user-facing error", async () => {
    mockStreamingMp4.mockRejectedValue(new Error("stream boom"));
    const webErr = new Error("web boom");
    webErr.name = "EncodingError";
    mockWebcodecs.mockRejectedValue(webErr);
    mockFfmpeg.mockRejectedValue(new Error("ff boom"));

    let err: unknown;
    try {
      await decodeAudioToMonoPcm(mp4Blob(), 22050);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Audio decode failed");
    expect(msg).toContain("ffmpeg: ff boom");
    expect(msg).toContain("webcodecs: web boom");
    expect(msg).toContain("streaming: stream boom");
  });
});
