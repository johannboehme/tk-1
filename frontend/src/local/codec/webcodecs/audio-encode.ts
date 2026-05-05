/**
 * Encodes a PCM Float32Array to AAC or Opus chunks via WebCodecs
 * `AudioEncoder`. Supports mono and stereo. Returns the encoder's resolved
 * description so the muxer can write the `esds` / `dOps` box correctly.
 */

export type AudioEncodeCodec = "aac" | "opus";

const CODEC_STRING: Record<AudioEncodeCodec, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
};

/**
 * Probe whether the runtime can encode this codec/format. The only
 * authoritative signal is `AudioEncoder.isConfigSupported` — UA strings
 * lie. iOS Safari ships AudioEncoder but historically only supports
 * Opus encoding (no AAC); without a probe we'd silently produce a file
 * with an audio track header but no audio data, which is exactly the
 * "exported file has no audio" symptom phones hit.
 *
 * Returns `false` for any rejection (no AudioEncoder, codec name
 * unknown, sample-rate / channel combo unsupported) so the caller can
 * decide whether to fall back to a different codec.
 */
export async function isAudioCodecSupported(
  codec: AudioEncodeCodec,
  sampleRate: number,
  numberOfChannels: number,
  bitrateBps: number = 128_000,
): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const r = await AudioEncoder.isConfigSupported({
      codec: CODEC_STRING[codec],
      sampleRate,
      numberOfChannels,
      bitrate: bitrateBps,
    });
    return r.supported === true;
  } catch {
    return false;
  }
}

export interface EncodedAudioChunkRecord {
  type: "key" | "delta";
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export interface AudioEncodeResult {
  chunks: EncodedAudioChunkRecord[];
  /** Codec ID — either WebCodecs ("opus") or AAC ("mp4a.40.2"). */
  codec: string;
  /** Container codec key consumed by mp4-muxer. */
  muxerCodec: "aac" | "opus";
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig (AAC) or DOps payload (Opus) bytes. */
  description?: Uint8Array;
}

export interface AudioEncodeOptions {
  /** Number of interleaved channels in the input (1 or 2). */
  numberOfChannels: number;
  sampleRate: number;
  bitrateBps?: number;
  /** Frame size for the encoder; AAC native frame is 1024, Opus 960. */
  frameSize?: number;
  /** Codec to encode with. Default: AAC (compat). */
  codec?: AudioEncodeCodec;
}

/**
 * Try to encode the PCM with a single codec. Resolves with the result on
 * success, or rejects with a descriptive error on any failure mode that
 * would leave the muxer with a silent audio track:
 *  - `isConfigSupported` returns false for this codec
 *  - `configure()` throws synchronously
 *  - the encoder's async `error` callback fires before/during flush
 *  - the encoder configures but emits zero chunks
 *  - the encoder emits chunks but never delivers a decoder description
 *
 * The caller decides whether to bail or fall back to the other codec.
 */
async function encodeWithCodec(
  pcm: Float32Array,
  codec: AudioEncodeCodec,
  numberOfChannels: number,
  sampleRate: number,
  bitrateBps: number,
  frameSizeOverride: number | undefined,
): Promise<AudioEncodeResult> {
  const codecString = CODEC_STRING[codec];

  // Probe first. WebCodecs' `configure()` validates async on most
  // browsers — without an isConfigSupported gate we'd "successfully"
  // configure, then collect zero chunks, ship a silent file.
  if (!(await isAudioCodecSupported(codec, sampleRate, numberOfChannels, bitrateBps))) {
    throw new Error(
      `AudioEncoder.isConfigSupported returned false for ` +
        `${codecString} ${sampleRate}Hz/${numberOfChannels}ch.`,
    );
  }

  const frameSize = frameSizeOverride ?? (codec === "opus" ? 960 : 1024);
  const samplesPerChannel = pcm.length / numberOfChannels;
  const chunks: EncodedAudioChunkRecord[] = [];
  let description: Uint8Array | undefined;
  let captured: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        type: chunk.type as "key" | "delta",
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? 0,
        data,
      });
      if (description === undefined && metadata?.decoderConfig?.description) {
        const desc = metadata.decoderConfig.description as
          | ArrayBuffer
          | ArrayBufferView;
        if (desc instanceof ArrayBuffer) {
          description = new Uint8Array(desc);
        } else {
          const view = desc as ArrayBufferView;
          description = new Uint8Array(
            view.buffer as ArrayBuffer,
            view.byteOffset,
            view.byteLength,
          );
        }
      }
    },
    // Throwing from here is a no-op (WebCodecs swallows it). Capture
    // instead and surface after flush().
    error: (e) => {
      captured = e instanceof Error ? e : new Error(String(e));
    },
  });

  try {
    encoder.configure({
      codec: codecString,
      sampleRate,
      numberOfChannels,
      bitrate: bitrateBps,
    });
  } catch (e) {
    encoder.close();
    throw new Error(
      `AudioEncoder.configure(${codecString}) threw: ${(e as Error).message}`,
    );
  }

  let cursor = 0;
  while (cursor < samplesPerChannel) {
    const frameEnd = Math.min(cursor + frameSize, samplesPerChannel);
    const frameLen = frameEnd - cursor;
    const frameData = new Float32Array(frameLen * numberOfChannels);
    frameData.set(
      pcm.subarray(cursor * numberOfChannels, frameEnd * numberOfChannels),
    );
    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: frameLen,
      numberOfChannels,
      timestamp: Math.round((cursor / sampleRate) * 1_000_000),
      data: frameData,
    });
    encoder.encode(audioData);
    audioData.close();
    cursor += frameLen;
  }

  try {
    await encoder.flush();
  } catch (e) {
    encoder.close();
    throw new Error(
      `AudioEncoder.flush(${codecString}) threw: ${(e as Error).message}`,
    );
  }
  encoder.close();

  if (captured) {
    throw new Error(
      `AudioEncoder ${codecString} failed mid-stream: ${(captured as Error).message}`,
    );
  }
  if (chunks.length === 0) {
    throw new Error(
      `AudioEncoder ${codecString} produced 0 chunks for ${pcm.length} PCM ` +
        `samples (sr=${sampleRate}, ch=${numberOfChannels}). The exported ` +
        `file would have a registered audio track with no data.`,
    );
  }
  if (!description) {
    throw new Error(
      `AudioEncoder ${codecString} produced no decoder description.`,
    );
  }

  return {
    chunks,
    codec: codecString,
    muxerCodec: codec,
    sampleRate,
    numberOfChannels,
    description,
  };
}

/**
 * Input PCM is laid out as INTERLEAVED frames: [L0, R0, L1, R1, ...].
 * For mono pass a Float32Array of length samples_per_channel.
 *
 * Codec resolution is **try-then-fallback**, not just probe-then-encode:
 *   - We attempt the requested codec end-to-end.
 *   - If anything in that attempt fails — probe rejects, configure
 *     throws, the async error callback fires, zero chunks emitted, no
 *     description — we automatically retry with the other codec.
 *   - Only if BOTH attempts fail do we surface an error.
 *
 * Why try-then-fallback rather than probe-then-fallback: real-world
 * mobile WebCodecs often passes `isConfigSupported` but then silently
 * emits zero chunks (Android Chrome's MediaCodec-backed AAC encoder is
 * a known offender for some sample-rate / channel combos). Probe-only
 * fallback would leave those cases producing a registered-but-empty
 * audio track — the literal "no audio in the file" bug we're fixing.
 */
export async function encodeAudioFromPcm(
  pcm: Float32Array,
  opts: AudioEncodeOptions,
): Promise<AudioEncodeResult> {
  const { numberOfChannels, sampleRate } = opts;
  const requestedCodec: AudioEncodeCodec = opts.codec ?? "aac";
  const bitrateBps = opts.bitrateBps ?? 192_000;
  const fallbackCodec: AudioEncodeCodec = requestedCodec === "aac" ? "opus" : "aac";

  let firstError: Error | null = null;
  try {
    return await encodeWithCodec(
      pcm,
      requestedCodec,
      numberOfChannels,
      sampleRate,
      bitrateBps,
      opts.frameSize,
    );
  } catch (e) {
    firstError = e instanceof Error ? e : new Error(String(e));
  }

  // Requested codec failed. Try the fallback before giving up — many
  // mobile encoders only ship one of {AAC, Opus}.
  try {
    return await encodeWithCodec(
      pcm,
      fallbackCodec,
      numberOfChannels,
      sampleRate,
      bitrateBps,
      opts.frameSize,
    );
  } catch (e) {
    const second = e instanceof Error ? e : new Error(String(e));
    throw new Error(
      `AudioEncoder failed for both ${requestedCodec.toUpperCase()} and ` +
        `${fallbackCodec.toUpperCase()}.\n` +
        `${requestedCodec.toUpperCase()}: ${firstError.message}\n` +
        `${fallbackCodec.toUpperCase()}: ${second.message}`,
    );
  }
}

/**
 * @deprecated AAC-specific entry kept for callers that don't care about
 *  the codec choice. New code should use `encodeAudioFromPcm`.
 */
export async function encodeAacFromPcm(
  pcm: Float32Array,
  opts: Omit<AudioEncodeOptions, "codec">,
): Promise<AudioEncodeResult> {
  return encodeAudioFromPcm(pcm, { ...opts, codec: "aac" });
}

export interface StreamEncodeAudioOptions {
  numberOfChannels: number;
  sampleRate: number;
  bitrateBps?: number;
  frameSize?: number;
  codec?: AudioEncodeCodec;
  /** Called for each encoded chunk as it's produced. The encoder does
   *  NOT retain chunks internally — push them straight into a muxer.
   *  `description` is provided once the first chunk's metadata arrives;
   *  subsequent calls pass the same value. */
  onChunk: (chunk: EncodedAudioChunkRecord, description?: Uint8Array) => void;
}

export interface StreamEncodeAudioResult {
  /** Codec string (e.g. "mp4a.40.2" for AAC). */
  codec: string;
  /** Container codec key consumed by mp4-muxer. */
  muxerCodec: "aac" | "opus";
  sampleRate: number;
  numberOfChannels: number;
  description: Uint8Array;
}

/**
 * Stream-encode interleaved PCM into the chosen codec, applying segment
 * trims inline. Each encoded chunk is pushed through `onChunk` — the
 * encoder does NOT accumulate chunks, so RAM stays constant regardless
 * of audio length.
 *
 * Segments are applied at sample granularity: the kept ranges are
 * concatenated into a single output stream with monotone timestamps
 * (= same semantics as `applySegments` + a regular encode, but no
 * intermediate trimmed PCM array allocated).
 *
 * No fallback: the requested codec must be supported. The legacy
 * `encodeAudioFromPcm` keeps its try-then-fallback for callers that
 * need it.
 */
export async function streamEncodeAudioWithSegments(
  pcm: Float32Array,
  segments: { in: number; out: number }[],
  opts: StreamEncodeAudioOptions,
): Promise<StreamEncodeAudioResult> {
  const codec = opts.codec ?? "aac";
  const codecString = CODEC_STRING[codec];
  const numberOfChannels = opts.numberOfChannels;
  const sampleRate = opts.sampleRate;
  const bitrateBps = opts.bitrateBps ?? 192_000;
  const frameSize = opts.frameSize ?? (codec === "opus" ? 960 : 1024);

  if (
    !(await isAudioCodecSupported(codec, sampleRate, numberOfChannels, bitrateBps))
  ) {
    throw new Error(
      `AudioEncoder.isConfigSupported returned false for ` +
        `${codecString} ${sampleRate}Hz/${numberOfChannels}ch.`,
    );
  }

  let description: Uint8Array | undefined;
  let captured: Error | null = null;
  let chunkCount = 0;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (description === undefined && metadata?.decoderConfig?.description) {
        const desc = metadata.decoderConfig.description as
          | ArrayBuffer
          | ArrayBufferView;
        if (desc instanceof ArrayBuffer) {
          description = new Uint8Array(desc);
        } else {
          const view = desc as ArrayBufferView;
          description = new Uint8Array(
            view.buffer as ArrayBuffer,
            view.byteOffset,
            view.byteLength,
          );
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      opts.onChunk(
        {
          type: chunk.type as "key" | "delta",
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          data,
        },
        description,
      );
      chunkCount++;
    },
    error: (e) => {
      captured = e instanceof Error ? e : new Error(String(e));
    },
  });

  try {
    encoder.configure({
      codec: codecString,
      sampleRate,
      numberOfChannels,
      bitrate: bitrateBps,
    });
  } catch (e) {
    encoder.close();
    throw new Error(
      `AudioEncoder.configure(${codecString}) threw: ${(e as Error).message}`,
    );
  }

  // Walk segments inline. Output timestamp is the cumulative output
  // sample index — segments are concatenated so the second segment's
  // first sample lands right after the first segment's last sample.
  const totalSrcFrames = Math.floor(pcm.length / numberOfChannels);
  const segs =
    segments.length > 0
      ? segments
      : [{ in: 0, out: totalSrcFrames / sampleRate }];
  let outputFrameIdx = 0;
  try {
    for (const seg of segs) {
      const segStartFrame = Math.max(0, Math.floor(seg.in * sampleRate));
      const segEndFrame = Math.min(totalSrcFrames, Math.floor(seg.out * sampleRate));
      let cursor = segStartFrame;
      while (cursor < segEndFrame) {
        const frameEnd = Math.min(cursor + frameSize, segEndFrame);
        const frameLen = frameEnd - cursor;
        // Per-AudioData buffer is bounded: frameSize * channels * 4 bytes
        // ≈ 8 KB at 1024 frames stereo. Constant, regardless of audio
        // length — the goal of streaming.
        const data = new Float32Array(frameLen * numberOfChannels);
        data.set(
          pcm.subarray(
            cursor * numberOfChannels,
            frameEnd * numberOfChannels,
          ),
        );
        const audioData = new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: frameLen,
          numberOfChannels,
          timestamp: Math.round((outputFrameIdx / sampleRate) * 1_000_000),
          data,
        });
        encoder.encode(audioData);
        audioData.close();
        outputFrameIdx += frameLen;
        cursor = frameEnd;
      }
    }
    await encoder.flush();
  } catch (e) {
    encoder.close();
    throw new Error(
      `AudioEncoder.flush(${codecString}) threw: ${(e as Error).message}`,
    );
  }
  encoder.close();

  if (captured) {
    throw new Error(
      `AudioEncoder ${codecString} failed mid-stream: ${(captured as Error).message}`,
    );
  }
  if (chunkCount === 0) {
    throw new Error(
      `AudioEncoder ${codecString} produced 0 chunks for ${pcm.length} PCM ` +
        `samples (sr=${sampleRate}, ch=${numberOfChannels}).`,
    );
  }
  if (!description) {
    throw new Error(
      `AudioEncoder ${codecString} produced no decoder description.`,
    );
  }

  return {
    codec: codecString,
    muxerCodec: codec,
    sampleRate,
    numberOfChannels,
    description,
  };
}
