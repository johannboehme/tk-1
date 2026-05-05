/**
 * Encodes a stream of `VideoFrame`s to H.264 or H.265 chunks via WebCodecs
 * `VideoEncoder`. Mirror of `audio-encode.ts` for video.
 *
 * Caller passes frames via `pushFrame` and finalises with `finish`. The
 * resulting chunks list is suitable for `mp4-muxer.addVideoChunkRaw`.
 */

import { avcCodecForResolution } from "./avc-level";
import { hevcCodecForResolution } from "./hevc-level";

export type VideoEncodeCodec = "h264" | "h265";

export interface EncodedVideoChunkRecord {
  type: "key" | "delta";
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

export interface VideoEncodeResult {
  chunks: EncodedVideoChunkRecord[];
  /** Codec string used by the encoder (e.g. "avc1.640028" or "hev1.1.6.L120.B0"). */
  codec: string;
  /** Container codec key consumed by mp4-muxer. */
  muxerCodec: "avc" | "hevc";
  width: number;
  height: number;
  description?: Uint8Array;
}

export interface VideoEncodeOptions {
  width: number;
  height: number;
  frameRate: number;
  /** "h264" (default) or "h265". The exact codec string is derived from the
   *  resolution + framerate so the right level/profile is picked. */
  videoCodec?: VideoEncodeCodec;
  /** Override the auto-derived codec string (escape hatch for tests). */
  codec?: string;
  bitrateBps?: number;
  /** When provided, encoded chunks are pushed straight through this
   *  callback as they arrive — the encoder does NOT accumulate them in
   *  `this.chunks`. Use this to stream chunks directly into a muxer
   *  (or any other sink) so RAM stays constant regardless of render
   *  duration. The optional `description` arg is the same value the
   *  encoder will eventually return from `finish()`; it's set on the
   *  first chunk and stable thereafter. */
  onChunk?: (chunk: EncodedVideoChunkRecord, description?: Uint8Array) => void;
}

/**
 * Probe whether the runtime can encode H.265 at the requested resolution.
 *
 * `VideoEncoder.isConfigSupported` is the only authoritative way to check
 * this — UA strings lie. We surface the result so the UI can fail loudly
 * when a user picked H.265 on a browser that can't deliver it.
 */
export async function isVideoCodecSupported(
  videoCodec: VideoEncodeCodec,
  width: number,
  height: number,
  frameRate: number,
): Promise<boolean> {
  const codecString =
    videoCodec === "h265"
      ? hevcCodecForResolution(width, height, frameRate)
      : avcCodecForResolution(width, height, frameRate);
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: codecString,
      width,
      height,
      framerate: frameRate,
      bitrate: 4_000_000,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

export class StreamingVideoEncoder {
  private encoder: VideoEncoder;
  private chunks: EncodedVideoChunkRecord[] = [];
  private description?: Uint8Array;
  private err: Error | null = null;
  private codecString: string;
  private muxerCodec: "avc" | "hevc";
  private opts: VideoEncodeOptions;
  private onChunk?: (chunk: EncodedVideoChunkRecord, description?: Uint8Array) => void;

  constructor(opts: VideoEncodeOptions) {
    this.opts = opts;
    this.onChunk = opts.onChunk;
    const videoCodec: VideoEncodeCodec = opts.videoCodec ?? "h264";
    this.muxerCodec = videoCodec === "h265" ? "hevc" : "avc";
    this.codecString =
      opts.codec ??
      (videoCodec === "h265"
        ? hevcCodecForResolution(opts.width, opts.height, opts.frameRate)
        : avcCodecForResolution(opts.width, opts.height, opts.frameRate));

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (this.description === undefined && metadata?.decoderConfig?.description) {
          const desc = metadata.decoderConfig.description as
            | ArrayBuffer
            | ArrayBufferView;
          if (desc instanceof ArrayBuffer) {
            this.description = new Uint8Array(desc);
          } else {
            const view = desc as ArrayBufferView;
            this.description = new Uint8Array(
              view.buffer as ArrayBuffer,
              view.byteOffset,
              view.byteLength,
            );
          }
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const record: EncodedVideoChunkRecord = {
          type: chunk.type as "key" | "delta",
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          data,
        };
        if (this.onChunk) {
          // Streaming mode: push straight through, do not retain.
          // RAM stays constant in render duration.
          this.onChunk(record, this.description);
        } else {
          // Batch mode: accumulate for later finish() consumers.
          this.chunks.push(record);
        }
      },
      error: (e) => {
        this.err = e instanceof Error ? e : new Error(String(e));
      },
    });

    // The `avc: { format: "avc" }` hint tells WebCodecs to emit length-
    // prefixed (AVCC) NAL units in the description, which is what
    // mp4-muxer expects. The HEVC equivalent is `hevc: { format: "hevc" }`.
    const config: VideoEncoderConfig = {
      codec: this.codecString,
      width: opts.width,
      height: opts.height,
      bitrate: opts.bitrateBps ?? 4_000_000,
      framerate: opts.frameRate,
    };
    if (videoCodec === "h265") {
      (config as VideoEncoderConfig & { hevc?: { format: "hevc" | "annexb" } }).hevc = {
        format: "hevc",
      };
    } else {
      (config as VideoEncoderConfig & { avc?: { format: "avc" | "annexb" } }).avc = {
        format: "avc",
      };
    }
    this.encoder.configure(config);
  }

  /**
   * Encode one frame. The caller MUST close the frame after this returns.
   * Indicate keyframes explicitly for the first frame and at GOP boundaries.
   */
  pushFrame(frame: VideoFrame, options: { keyFrame?: boolean } = {}): void {
    if (this.err) throw this.err;
    this.encoder.encode(frame, options);
  }

  /** Number of frames queued internally by the WebCodecs encoder. Used by
   * the render pipeline to apply backpressure and avoid runaway memory. */
  get encodeQueueSize(): number {
    return this.encoder.encodeQueueSize;
  }

  /** Codec string used by the encoder (e.g. "avc1.640028"). Available
   *  immediately after construction — useful for callers that need to
   *  configure a downstream consumer (e.g. a muxer's video meta) before
   *  any frame is encoded. */
  get codec(): string {
    return this.codecString;
  }

  /** Container codec key consumed by mp4-muxer ("avc" | "hevc"). */
  get muxerCodecKey(): "avc" | "hevc" {
    return this.muxerCodec;
  }

  async finish(): Promise<VideoEncodeResult> {
    await this.encoder.flush();
    if (this.err) throw this.err;
    this.encoder.close();
    return {
      chunks: this.chunks,
      codec: this.codecString,
      muxerCodec: this.muxerCodec,
      width: this.opts.width,
      height: this.opts.height,
      description: this.description,
    };
  }
}
