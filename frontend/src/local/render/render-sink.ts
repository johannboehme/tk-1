/**
 * RenderSink — the muxer seam shared by single-job and Reel renders.
 *
 * `editRenderMulti` used to own its `Muxer`: it constructed one, pushed
 * every audio + video chunk straight in, and finalized it. That couples a
 * render to exactly one output file. The Reel needs N member renders to
 * feed ONE muxer (one continuous output), so the muxer ownership moves
 * behind this interface:
 *
 *   - `SingleRenderSink`  — owns its own muxer + finalizes it. Drop-in for
 *                           the existing single-job path (behaviour identical).
 *   - `SharedReelSink`    — one muxer across many member renders. The reel
 *                           orchestrator constructs it once, feeds the global
 *                           audio track once, then runs each member's video
 *                           into it with a cumulative time offset, and
 *                           finalizes at the very end.
 *
 * Both write to either an in-memory `ArrayBufferTarget` (tests) or a
 * streaming `FileSystemWritableFileStreamTarget` (OPFS), matching the
 * pipeline's existing memory strategy.
 */
import {
  ArrayBufferTarget,
  FileSystemWritableFileStreamTarget,
  Muxer,
} from "mp4-muxer";
import type { VideoEncodeCodec } from "../codec/webcodecs/video-encode";
import type { AudioEncodeCodec } from "../codec/webcodecs/audio-encode";

type MuxTarget = ArrayBufferTarget | FileSystemWritableFileStreamTarget;
/** mp4-muxer's per-chunk metadata bundles (carry the decoderConfig). The
 *  audio + video signatures differ, so keep them distinct. */
type VideoChunkMeta = Parameters<Muxer<MuxTarget>["addVideoChunkRaw"]>[4];
type AudioChunkMeta = Parameters<Muxer<MuxTarget>["addAudioChunkRaw"]>[4];

export interface RenderSinkConfig {
  width: number;
  height: number;
  fps: number;
  videoCodec: VideoEncodeCodec;
  audioCodec: AudioEncodeCodec;
  audioChannels: number;
  audioSampleRate: number;
  /** Stream straight into this writable (OPFS). Omit for an in-memory
   *  buffer the caller reads back from `finalize()`. */
  output?: FileSystemWritableFileStream;
}

export interface RenderSinkResult {
  /** In-memory MP4 bytes when no streaming `output` was given; else null. */
  output: Uint8Array | null;
  byteLength: number;
}

export interface RenderSink {
  addVideoChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: VideoChunkMeta,
  ): void;
  addAudioChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: AudioChunkMeta,
  ): void;
  finalize(): RenderSinkResult;
}

function makeMuxer(cfg: RenderSinkConfig): {
  muxer: Muxer<MuxTarget>;
  target: MuxTarget;
} {
  const target: MuxTarget = cfg.output
    ? new FileSystemWritableFileStreamTarget(cfg.output)
    : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: cfg.videoCodec === "h265" ? "hevc" : "avc",
      width: cfg.width,
      height: cfg.height,
      frameRate: cfg.fps,
    },
    audio: {
      codec: cfg.audioCodec,
      numberOfChannels: cfg.audioChannels,
      sampleRate: cfg.audioSampleRate,
    },
    fastStart: cfg.output ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });
  return { muxer, target };
}

function readBack(target: MuxTarget): RenderSinkResult {
  if (target instanceof ArrayBufferTarget) {
    const output = new Uint8Array(target.buffer);
    return { output, byteLength: output.byteLength };
  }
  return { output: null, byteLength: 0 };
}

/** Single-output sink — the existing single-job behaviour. */
export class SingleRenderSink implements RenderSink {
  private readonly muxer: Muxer<MuxTarget>;
  private readonly target: MuxTarget;

  constructor(cfg: RenderSinkConfig) {
    const { muxer, target } = makeMuxer(cfg);
    this.muxer = muxer;
    this.target = target;
  }

  addVideoChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: VideoChunkMeta,
  ): void {
    this.muxer.addVideoChunkRaw(data, type, timestampUs, durationUs, meta);
  }

  addAudioChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: AudioChunkMeta,
  ): void {
    this.muxer.addAudioChunkRaw(data, type, timestampUs, durationUs, meta);
  }

  finalize(): RenderSinkResult {
    this.muxer.finalize();
    return readBack(this.target);
  }
}

/**
 * Shared sink for a Reel: one muxer fed by many member renders.
 *
 * Audio is encoded ONCE globally (the orchestrator concatenates every
 * member's PCM into one gapless track), so audio chunks pass straight
 * through. Video is rendered per member, each member's `editRenderMulti`
 * emitting timestamps that restart at 0 — so the orchestrator bumps
 * `videoTimeOffsetUs` between members and the sink adds it to every video
 * chunk, yielding one monotonic timeline.
 *
 * The muxer wants a single decoderConfig per track. Each member runs its
 * own encoder and re-emits a config on its first chunk; since every member
 * is forced to the same codec/dimensions, we forward only the FIRST config
 * seen per track and drop the rest.
 */
export class SharedReelSink implements RenderSink {
  private readonly muxer: Muxer<MuxTarget>;
  private readonly target: MuxTarget;
  private videoTimeOffsetUs = 0;
  private sawVideoMeta = false;
  private sawAudioMeta = false;

  constructor(cfg: RenderSinkConfig) {
    const { muxer, target } = makeMuxer(cfg);
    this.muxer = muxer;
    this.target = target;
  }

  /** Set the cumulative video-time offset (µs) for the member about to
   *  render. The orchestrator calls this before each member with the sum
   *  of all prior members' output durations, snapped to the frame grid. */
  setVideoTimeOffset(us: number): void {
    this.videoTimeOffsetUs = Math.max(0, Math.round(us));
  }

  addVideoChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: VideoChunkMeta,
  ): void {
    const m = this.sawVideoMeta ? undefined : meta;
    if (meta) this.sawVideoMeta = true;
    this.muxer.addVideoChunkRaw(
      data,
      type,
      timestampUs + this.videoTimeOffsetUs,
      durationUs,
      m,
    );
  }

  addAudioChunk(
    data: Uint8Array,
    type: "key" | "delta",
    timestampUs: number,
    durationUs: number,
    meta?: AudioChunkMeta,
  ): void {
    const m = this.sawAudioMeta ? undefined : meta;
    if (meta) this.sawAudioMeta = true;
    this.muxer.addAudioChunkRaw(data, type, timestampUs, durationUs, m);
  }

  finalize(): RenderSinkResult {
    this.muxer.finalize();
    return readBack(this.target);
  }
}
