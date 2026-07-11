// Unit-level coverage for `encodeAudioFromPcm`'s codec-fallback +
// failure-mode handling. We mock WebCodecs in jsdom so this runs in the
// fast unit suite — the real-codec roundtrip still lives in the
// `.browser.test.ts` sibling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAudioFromPcm,
  isAudioCodecSupported,
  resolveAudioCodecWithFallback,
} from "./audio-encode";

interface MockEncoderState {
  emitChunks: number;
  description?: Uint8Array;
  /** When set, fire the error callback with this on the first encode(). */
  errorOnFirstEncode?: Error;
  /** Per-codec overrides. Useful for "AAC silently emits 0, Opus works". */
  perCodec?: Partial<
    Record<
      string,
      {
        emitChunks?: number;
        errorOnFirstEncode?: Error;
        configureThrows?: Error;
      }
    >
  >;
}

function installMockWebCodecs(state: MockEncoderState, supportedCodecs: Set<string>) {
  // AudioData stand-in — we only need close().
  (globalThis as unknown as { AudioData: unknown }).AudioData = class {
    constructor(_init: unknown) {}
    close() {}
  };

  class MockAudioEncoder {
    static isConfigSupported = vi.fn(async (cfg: { codec: string }) => ({
      supported: supportedCodecs.has(cfg.codec),
      config: cfg,
    }));
    private out: (chunk: { byteLength: number; copyTo: (b: Uint8Array) => void; type: string; timestamp: number; duration?: number }, meta: unknown) => void;
    private err: (e: Error) => void;
    private firedFirst = false;
    private firedDescription = false;
    private codec = "";
    constructor(init: { output: MockAudioEncoder["out"]; error: MockAudioEncoder["err"] }) {
      this.out = init.output;
      this.err = init.error;
    }
    configure(cfg: { codec: string }) {
      this.codec = cfg.codec;
      const override = state.perCodec?.[cfg.codec];
      if (override?.configureThrows) throw override.configureThrows;
    }
    encode(_d: unknown) {
      const override = state.perCodec?.[this.codec];
      const errorOnFirst = override?.errorOnFirstEncode ?? state.errorOnFirstEncode;
      if (errorOnFirst && !this.firedFirst) {
        this.firedFirst = true;
        this.err(errorOnFirst);
        return;
      }
      this.firedFirst = true;
    }
    async flush() {
      const override = state.perCodec?.[this.codec];
      const emitChunks = override?.emitChunks ?? state.emitChunks;
      for (let i = 0; i < emitChunks; i++) {
        const meta = !this.firedDescription
          ? {
              decoderConfig: {
                description: state.description ?? new Uint8Array([1, 2, 3, 4]),
              },
            }
          : undefined;
        this.firedDescription = true;
        this.out(
          {
            byteLength: 4,
            copyTo: (b: Uint8Array) => {
              b[0] = 0xaa;
              b[1] = 0xbb;
              b[2] = 0xcc;
              b[3] = 0xdd;
            },
            type: "key",
            timestamp: i * 21333,
            duration: 21333,
          },
          meta,
        );
      }
    }
    close() {}
  }
  (globalThis as unknown as { AudioEncoder: unknown }).AudioEncoder = MockAudioEncoder;
  return MockAudioEncoder;
}

const ORIGINAL = {
  AudioEncoder: (globalThis as { AudioEncoder?: unknown }).AudioEncoder,
  AudioData: (globalThis as { AudioData?: unknown }).AudioData,
};

afterEach(() => {
  if (ORIGINAL.AudioEncoder === undefined) {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
  } else {
    (globalThis as unknown as { AudioEncoder: unknown }).AudioEncoder = ORIGINAL.AudioEncoder;
  }
  if (ORIGINAL.AudioData === undefined) {
    delete (globalThis as { AudioData?: unknown }).AudioData;
  } else {
    (globalThis as unknown as { AudioData: unknown }).AudioData = ORIGINAL.AudioData;
  }
});

describe("isAudioCodecSupported", () => {
  it("returns false when AudioEncoder is unavailable", async () => {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
    const ok = await isAudioCodecSupported("aac", 48000, 2);
    expect(ok).toBe(false);
  });

  it("delegates to AudioEncoder.isConfigSupported", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set(["mp4a.40.2"]));
    expect(await isAudioCodecSupported("aac", 48000, 2)).toBe(true);
    expect(await isAudioCodecSupported("opus", 48000, 2)).toBe(false);
  });
});

describe("resolveAudioCodecWithFallback — pre-muxer codec resolution (#109)", () => {
  // The streaming export path (editRenderMulti → streamEncodeAudioWith-
  // Segments) constructs the mp4 muxer with the audio codec BEFORE any
  // encoding starts, so encodeAudioFromPcm's mid-encode fallback is
  // structurally impossible there. The codec must be resolved by probe
  // up front — otherwise iOS Safari (AudioEncoder without AAC) hard-
  // fails every default export even though Opus encoding works.

  it("keeps the requested codec when it is supported", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set(["mp4a.40.2", "opus"]));
    expect(await resolveAudioCodecWithFallback("aac", 48000, 2)).toBe("aac");
    expect(await resolveAudioCodecWithFallback("opus", 48000, 2)).toBe("opus");
  });

  it("swaps AAC → Opus when AAC is unsupported (iOS-Safari sim)", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set(["opus"]));
    expect(await resolveAudioCodecWithFallback("aac", 48000, 2)).toBe("opus");
  });

  it("swaps Opus → AAC when Opus is unsupported (mirror case)", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set(["mp4a.40.2"]));
    expect(await resolveAudioCodecWithFallback("opus", 48000, 2)).toBe("aac");
  });

  it("returns the requested codec when NEITHER is supported, so the encoder surfaces its descriptive error", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set());
    expect(await resolveAudioCodecWithFallback("aac", 48000, 2)).toBe("aac");
  });

  it("returns the requested codec when AudioEncoder is entirely unavailable", async () => {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
    expect(await resolveAudioCodecWithFallback("aac", 48000, 2)).toBe("aac");
  });
});

describe("encodeAudioFromPcm — failure modes that used to ship a silent track", () => {
  beforeEach(() => {
    // 200 samples mono — encoder receives a few frames, emits per-frame.
    // The encode() mock ignores input and we control chunk count via
    // state.emitChunks, so the actual PCM length only affects the loop.
  });

  it("falls back to Opus when AAC is unsupported (iOS-Safari sim)", async () => {
    installMockWebCodecs({ emitChunks: 3 }, new Set(["opus"]));
    const pcm = new Float32Array(48000); // 1 s mono
    const result = await encodeAudioFromPcm(pcm, {
      numberOfChannels: 1,
      sampleRate: 48000,
      codec: "aac",
    });
    expect(result.muxerCodec).toBe("opus");
    expect(result.codec).toBe("opus");
    expect(result.chunks.length).toBe(3);
  });

  it("throws aggregated error when both codecs are unsupported", async () => {
    installMockWebCodecs({ emitChunks: 1 }, new Set());
    const pcm = new Float32Array(48000);
    await expect(
      encodeAudioFromPcm(pcm, {
        numberOfChannels: 1,
        sampleRate: 48000,
        codec: "aac",
      }),
    ).rejects.toThrow(/failed for both AAC and OPUS/);
  });

  it("throws when the encoder fires an async error mid-stream", async () => {
    // Same regression we just fixed: the old code's `error: (e) => { throw e }`
    // was a no-op and produced an under-filled chunks array silently.
    installMockWebCodecs(
      {
        emitChunks: 1,
        errorOnFirstEncode: new Error("simulated platform failure"),
      },
      new Set(["mp4a.40.2"]),
    );
    const pcm = new Float32Array(48000);
    await expect(
      encodeAudioFromPcm(pcm, {
        numberOfChannels: 1,
        sampleRate: 48000,
        codec: "aac",
      }),
    ).rejects.toThrow(/simulated platform failure/);
  });

  it("throws when the encoder configures but produces 0 chunks", async () => {
    // The literal "exported file has no audio" symptom: encoder seemed
    // OK but never emitted data.
    installMockWebCodecs({ emitChunks: 0 }, new Set(["mp4a.40.2"]));
    const pcm = new Float32Array(48000);
    await expect(
      encodeAudioFromPcm(pcm, {
        numberOfChannels: 1,
        sampleRate: 48000,
        codec: "aac",
      }),
    ).rejects.toThrow(/produced 0 chunks/);
  });

  it("returns the AAC chunks when AAC IS supported (desktop happy path)", async () => {
    installMockWebCodecs(
      { emitChunks: 5 },
      new Set(["mp4a.40.2", "opus"]),
    );
    const pcm = new Float32Array(48000);
    const result = await encodeAudioFromPcm(pcm, {
      numberOfChannels: 1,
      sampleRate: 48000,
      codec: "aac",
    });
    expect(result.muxerCodec).toBe("aac");
    expect(result.codec).toBe("mp4a.40.2");
    expect(result.chunks.length).toBe(5);
    expect(result.description).toBeDefined();
  });

  it("falls back to Opus when AAC PASSES the probe but emits 0 chunks (Android Chrome MediaCodec sim)", async () => {
    // Real-world failure mode the user hit: probe says AAC is fine,
    // configure succeeds, but the underlying MediaCodec encoder on the
    // device just doesn't deliver chunks — we shipped a registered-but-
    // empty audio track. This test pins the try-then-fallback fix.
    installMockWebCodecs(
      {
        emitChunks: 0, // default for any codec without a per-codec entry
        perCodec: {
          "mp4a.40.2": { emitChunks: 0 }, // AAC silently broken
          opus: { emitChunks: 4 }, // Opus works
        },
      },
      new Set(["mp4a.40.2", "opus"]),
    );
    const pcm = new Float32Array(48000);
    const result = await encodeAudioFromPcm(pcm, {
      numberOfChannels: 1,
      sampleRate: 48000,
      codec: "aac",
    });
    expect(result.muxerCodec).toBe("opus");
    expect(result.chunks.length).toBe(4);
  });

  it("falls back to AAC when Opus configure throws (mirror case)", async () => {
    installMockWebCodecs(
      {
        emitChunks: 3,
        perCodec: {
          opus: { configureThrows: new Error("opus configure: NotSupportedError") },
        },
      },
      new Set(["mp4a.40.2", "opus"]),
    );
    const pcm = new Float32Array(48000);
    const result = await encodeAudioFromPcm(pcm, {
      numberOfChannels: 1,
      sampleRate: 48000,
      codec: "opus",
    });
    expect(result.muxerCodec).toBe("aac");
    expect(result.chunks.length).toBe(3);
  });
});
