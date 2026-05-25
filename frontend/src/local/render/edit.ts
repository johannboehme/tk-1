/**
 * Edit-render orchestrator.
 *
 * Pipeline (mirrors `app/pipeline/render_edit.py` but without the ffmpeg
 * filter-graph indirection — we do the work directly in WebCodecs):
 *
 *   1. Demux phone-video → encoded video chunks + decoder config.
 *   2. Decode + transform studio audio (drift, offset, segment cuts).
 *   3. Encode audio → AAC chunks.
 *   4. Streaming video pipeline: each decoded VideoFrame is composited
 *      and pushed straight into the encoder, then closed. Backpressure
 *      on the decode/encode queues keeps memory bounded — see the
 *      `frameQueue` history below for what we replaced.
 *   5. Mux video + audio into MP4. If `output` is provided we stream
 *      the bytes directly into a FileSystemWritableFileStream; otherwise
 *      we fall back to an in-memory buffer (used by tests).
 *
 * History: until 2026-04 the pipeline buffered every decoded VideoFrame
 * into an array (`frameQueue: VideoFrame[]`) before encoding. That
 * accumulated multi-GB of YUV data for typical 3-min 1080p videos and
 * regularly killed the browser tab. Streaming + backpressure fixes that.
 */

import {
  ArrayBufferTarget,
  FileSystemWritableFileStreamTarget,
  Muxer,
} from "mp4-muxer";

type MuxTarget = ArrayBufferTarget | FileSystemWritableFileStreamTarget;
import {
  encodeAudioFromPcm,
  streamEncodeAudioWithSegments,
  type AudioEncodeCodec,
} from "../codec/webcodecs/audio-encode";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import {
  StreamingVideoEncoder,
  isVideoCodecSupported,
  type VideoEncodeCodec,
} from "../codec/webcodecs/video-encode";
import {
  applyAudioOffsetInterleaved,
  applyDriftStretchInterleaved,
} from "./audio-fx";
import { Compositor } from "./compositor";
import { SingleRenderSink, type RenderSink } from "./render-sink";
import {
  applyViewportTransform,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "../../editor/render/element-transform";
import type { ViewportTransform } from "../../editor/types";
import type { BackendCapabilities } from "../../editor/render/factory";
import { CamFrameStream } from "./cam-frame-stream";
import { makeTestPatternCanvas } from "./test-pattern";
import { activeCamAt } from "../../editor/cuts";
import { activeCamAtArr as activeCamAtArrLocal } from "../../editor/arrangement-pills";
import type { Cut } from "../../storage/jobs-db";
import type { PunchFx } from "../../editor/fx/types";
import type { TextOverlay, EnergyCurves } from "./ass-builder";
import type { Visualizer } from "./visualizer/types";
import { camSourceTimeUs } from "../timing/cam-time";

export interface Segment {
  in: number; // seconds
  out: number; // seconds
}

export interface EditRenderProgress {
  /** "audio-decode" | "audio-encode" | "video-encode" | "muxing" */
  stage: string;
  /** Frames composited + sent to the encoder so far. */
  framesDone: number;
  /** Total frames the encoder is expected to emit (best estimate). */
  framesTotal: number;
}

export interface EditRenderInput {
  videoFile: Blob | ArrayBuffer;
  /** One of audioFile / audioPcm must be provided. audioPcm is the worker
   *  path: AudioContext.decodeAudioData is unavailable in workers, so the
   *  main thread decodes once and transfers the Float32Array. */
  audioFile?: Blob | ArrayBuffer;
  audioPcm?: { pcm: Float32Array; sampleRate: number; channels: number };
  segments: Segment[]; // empty/zero-length → use the whole clip
  overlays: TextOverlay[];
  energy?: EnergyCurves | null;
  visualizers?: Visualizer[];
  /** Punch-in FX (visual effects with in/out spans). Same data the live
   *  preview reads — passed through to the compositor verbatim. */
  fx?: PunchFx[];
  offsetMs: number;
  driftRatio: number;
  videoBitrateBps?: number;
  audioBitrateBps?: number;
  /** Output video codec. Default: h264. */
  videoCodec?: VideoEncodeCodec;
  /** Output audio codec. Default: aac. */
  audioCodec?: AudioEncodeCodec;
  /** Output dimensions. Defaults to the source's. Aspect-mismatched values
   *  result in a letterboxed render — the source is fit aspect-preserving
   *  and the spare canvas is filled with black. */
  outputWidth?: number;
  outputHeight?: number;
  /** Output framerate. Defaults to 30 — independent from any source cam's
   *  fps so a 120 fps source cam and a 30 fps source cam can coexist on
   *  the same master timeline without driving the output rate up. */
  outputFps?: number;
  /** Stream the muxed MP4 directly into this writable. When present the
   *  caller owns the stream's lifecycle (close on success, abort on error). */
  output?: FileSystemWritableFileStream;
  /** Periodic progress notifications. Called from the decoder output
   *  callback — keep work in the handler tiny. */
  onProgress?: (p: EditRenderProgress) => void;
  /** Render-Backend-Capabilities für die Compositor-Factory. Caller
   *  is responsible for probing — main thread typically uses
   *  `detectCapabilities() + probeWebGPU()`; the Worker probes
   *  internally and passes the result here. Defaults to Canvas2D-only
   *  if omitted (no GPU backend) — ensures correctness if a caller
   *  forgets to probe; render then matches the legacy hardcoded path. */
  capabilities?: BackendCapabilities;
}

export interface EditRenderResult {
  /** In-memory MP4 bytes when `input.output` was not provided; otherwise null. */
  output: Uint8Array | null;
  width: number;
  height: number;
  videoCodec: string;
  audioBackend: "webcodecs" | "ffmpeg-wasm";
  audioSampleRate: number;
  audioChannelCount: number;
  /** Final size in bytes. Always populated. */
  byteLength: number;
}

export async function decodeStudioAudioInterleaved(
  source: Blob | ArrayBuffer,
): Promise<{ pcm: Float32Array; sampleRate: number; channels: number }> {
  const buf = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const ctx = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
  const ch = decoded.numberOfChannels;
  const len = decoded.length;
  const inter = new Float32Array(len * ch);
  for (let c = 0; c < ch; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < len; i++) inter[i * ch + c] = channel[i];
  }
  return { pcm: inter, sampleRate: decoded.sampleRate, channels: ch };
}

/** Trim interleaved PCM to one or more time segments and concatenate. */
function applySegments(
  pcm: Float32Array,
  channelCount: number,
  sampleRate: number,
  segments: Segment[],
): Float32Array {
  if (segments.length === 0) return pcm;
  let totalSamples = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const seg of segments) {
    const s = Math.max(0, Math.floor(seg.in * sampleRate)) * channelCount;
    const e =
      Math.min(pcm.length, Math.floor(seg.out * sampleRate) * channelCount);
    if (e > s) {
      ranges.push({ start: s, end: e });
      totalSamples += e - s;
    }
  }
  const out = new Float32Array(totalSamples);
  let cursor = 0;
  for (const r of ranges) {
    out.set(pcm.subarray(r.start, r.end), cursor);
    cursor += r.end - r.start;
  }
  return out;
}

export async function editRender(input: EditRenderInput): Promise<EditRenderResult> {
  // Step 1: demux video.
  const video = await demuxVideoTrack(input.videoFile);
  if (!video) throw new Error("Edit render: no video track in source.");

  // Step 2: decode + transform audio. We chain through a single binding so
  // intermediate Float32Arrays become unreachable and can be GC'd before
  // the next allocation runs. For 3 min stereo @ 48 kHz each copy is
  // ~140 MB — keeping all four around simultaneously is what caused the
  // pre-2026-04 audio-side leak.
  input.onProgress?.({ stage: "audio-decode", framesDone: 0, framesTotal: 0 });
  let audio: { pcm: Float32Array; sampleRate: number; channels: number };
  if (input.audioPcm) {
    audio = input.audioPcm;
  } else if (input.audioFile) {
    audio = await decodeStudioAudioInterleaved(input.audioFile);
  } else {
    throw new Error("editRender: either audioFile or audioPcm is required");
  }
  let pcm: Float32Array | null = audio.pcm;
  if (input.driftRatio !== 1.0) {
    const next = applyDriftStretchInterleaved(pcm, audio.channels, input.driftRatio);
    pcm = next;
  }
  if (input.offsetMs !== 0) {
    const next = applyAudioOffsetInterleaved(pcm, audio.channels, audio.sampleRate, input.offsetMs);
    pcm = next;
  }
  pcm = applySegments(pcm, audio.channels, audio.sampleRate, input.segments);

  // Step 3: encode audio.
  input.onProgress?.({ stage: "audio-encode", framesDone: 0, framesTotal: 0 });
  const audioCodec: AudioEncodeCodec = input.audioCodec ?? "aac";
  const encodedAudio = await encodeAudioFromPcm(pcm, {
    numberOfChannels: audio.channels,
    sampleRate: audio.sampleRate,
    bitrateBps: input.audioBitrateBps ?? 192_000,
    codec: audioCodec,
  });
  if (!encodedAudio.description) {
    throw new Error("Audio encoder produced no description");
  }
  // Drop the PCM reference — encoder copied what it needed. Frees ~half a
  // gig for a 3-min stereo source before the heavy video pipeline starts.
  pcm = null;

  // Step 4: streaming video composite + encode.
  const fps = Math.max(1, Math.round(video.info.fps));
  // Output dimensions follow the source's *displayed* (post-rotation)
  // size. A portrait phone recording stored as 1920×1080 with a 90°
  // matrix outputs as 1080×1920 — same as preview.
  const srcRot = video.info.rotationDeg;
  const srcRotSwap = srcRot === 90 || srcRot === 270;
  const dispW = srcRotSwap ? video.info.height : video.info.width;
  const dispH = srcRotSwap ? video.info.width : video.info.height;
  const outputWidth = input.outputWidth ?? dispW;
  const outputHeight = input.outputHeight ?? dispH;
  const videoCodec: VideoEncodeCodec = input.videoCodec ?? "h264";

  // Validate codec capability up front. Failing here surfaces a clear UI
  // error before we've decoded a single frame; without the probe we would
  // get a cryptic NotSupportedError from VideoEncoder.configure deep in
  // the pipeline (and the half-written MP4 to clean up).
  if (videoCodec === "h265") {
    const supported = await isVideoCodecSupported(
      "h265",
      outputWidth,
      outputHeight,
      fps,
    );
    if (!supported) {
      throw new Error(
        "This browser cannot encode H.265 at the requested resolution. Please choose H.264.",
      );
    }
  }

  const compositor = await Compositor.create(
    {
      width: outputWidth,
      height: outputHeight,
      sourceWidth: video.info.width,
      sourceHeight: video.info.height,
      overlays: input.overlays,
      energy: input.energy ?? null,
      visualizers: input.visualizers ?? [],
      fx: input.fx ?? [],
    },
    input.capabilities ?? { webgl2: false, webgpu: false },
  );
  await compositor.ensureSubtitleEngine();

  const encoder = new StreamingVideoEncoder({
    width: outputWidth,
    height: outputHeight,
    frameRate: fps,
    videoCodec,
    bitrateBps: input.videoBitrateBps ?? 4_000_000,
  });

  const intervals: Segment[] =
    input.segments.length > 0
      ? input.segments
      : [{ in: 0, out: video.info.durationS }];

  // Estimate the total emitted-frame count from the kept duration. Used
  // only for the progress bar; off by a frame or two is fine.
  const keptDurationS = intervals.reduce((acc, s) => acc + (s.out - s.in), 0);
  const framesTotal = Math.max(1, Math.round(keptDurationS * fps));

  let nextIntervalIdx = 0;
  let firstFrameInGop = true;
  let framesEmitted = 0;
  let pendingError: Error | null = null;
  // The compositor's compositeImage() is async (WebGPU readback is
  // async — see Compositor for why). The VideoDecoder calls `output`
  // fire-and-forget, so we serialize the per-frame work through a
  // Promise chain — without serialization, multiple async output
  // callbacks could interleave their `compositor.compositeImage()` /
  // `encoder.pushFrame()` calls and produce out-of-order frames.
  let outputQueue: Promise<void> = Promise.resolve();
  const decoder = new VideoDecoder({
    output: (frame) => {
      outputQueue = outputQueue.then(async () => {
        try {
          const tS = frame.timestamp / 1_000_000;
          let inInterval = false;
          let intervalStartS = 0;
          for (let i = 0; i < intervals.length; i++) {
            const seg = intervals[i];
            if (tS >= seg.in && tS < seg.out) {
              inInterval = true;
              for (let j = 0; j < i; j++) {
                intervalStartS += intervals[j].out - intervals[j].in;
              }
              intervalStartS -= seg.in;
              if (i !== nextIntervalIdx) {
                nextIntervalIdx = i;
                firstFrameInGop = true;
              }
              break;
            }
          }
          if (!inInterval) {
            frame.close();
            return;
          }
          const outTs = Math.round((tS + intervalStartS) * 1_000_000);
          const composed = await compositor.compositeImage(
            frame as unknown as CanvasImageSource,
            frame.codedWidth,
            frame.codedHeight,
            outTs,
            frame.duration ?? 0,
            srcRot,
            undefined,
            // FX live on the master timeline; tS is the source-frame's
            // master time (single-cam pipeline = master time).
            tS,
          );
          encoder.pushFrame(composed, { keyFrame: firstFrameInGop });
          composed.close();
          frame.close();
          firstFrameInGop = false;
          framesEmitted++;
          if (framesEmitted % 30 === 0 || framesEmitted === framesTotal) {
            input.onProgress?.({
              stage: "video-encode",
              framesDone: framesEmitted,
              framesTotal,
            });
          }
        } catch (e) {
          pendingError = e instanceof Error ? e : new Error(String(e));
          try { frame.close(); } catch { /* already closed */ }
        }
      });
    },
    error: (e) => {
      // The native VideoDecoder error message is just "Decoding error".
      // Wrap it with the codec + dims so the user has at least a
      // breadcrumb when render fails partway through.
      const orig = e instanceof Error ? e.message : String(e);
      pendingError = new Error(
        `Render decode failed (codec ${video.info.codec}, ` +
          `${video.info.width}×${video.info.height}, ` +
          `${framesEmitted} frames emitted): ${orig}`,
      );
    },
  });
  decoder.configure({
    codec: video.info.codec,
    codedWidth: video.info.width,
    codedHeight: video.info.height,
    description: video.info.description,
  });

  // Feed chunks with backpressure. Without this the HW decoder happily
  // outruns the (typically slower) software encoder and we accumulate
  // hundreds of in-flight VideoFrames. The thresholds (8 / 16) are
  // conservative — empirically Chromium's HW encoder pipelines around
  // 4 frames; 16 leaves headroom without bloating memory.
  for (const c of video.chunks) {
    if (pendingError) throw pendingError;
    while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 16) {
      await new Promise((r) => setTimeout(r, 1));
      if (pendingError) throw pendingError;
    }
    decoder.decode(
      new EncodedVideoChunk({
        type: c.isKey ? "key" : "delta",
        timestamp: c.timestampUs,
        duration: c.durationUs,
        data: c.data,
      }),
    );
  }
  await decoder.flush();
  // Drain pending compositor work — flush() returns once the decoder
  // has emitted all output callbacks, but those callbacks chain async
  // composite work onto outputQueue. We must wait for that to settle.
  await outputQueue;
  decoder.close();
  if (pendingError) throw pendingError;

  const encodedVideo = await encoder.finish();
  if (!encodedVideo.description) {
    throw new Error("Video encoder produced no description");
  }
  compositor.destroy();

  // Final progress tick at the encode boundary.
  input.onProgress?.({
    stage: "muxing",
    framesDone: framesEmitted,
    framesTotal,
  });

  // Step 5: mux. Stream into the caller-provided sink when given so the
  // entire MP4 never has to live in RAM. fastStart: "in-memory" is not
  // available with a streaming target — moov ends up at the tail, which
  // is fine for local OPFS playback.
  const target: MuxTarget = input.output
    ? new FileSystemWritableFileStreamTarget(input.output)
    : new ArrayBufferTarget();

  const muxer = new Muxer({
    target,
    video: {
      codec: encodedVideo.muxerCodec,
      width: outputWidth,
      height: outputHeight,
      frameRate: fps,
    },
    audio: {
      codec: encodedAudio.muxerCodec,
      numberOfChannels: encodedAudio.numberOfChannels,
      sampleRate: encodedAudio.sampleRate,
    },
    fastStart: input.output ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoMeta = {
    decoderConfig: {
      codec: encodedVideo.codec,
      codedWidth: encodedVideo.width,
      codedHeight: encodedVideo.height,
      description: encodedVideo.description,
    },
  } as unknown as Parameters<Muxer<MuxTarget>["addVideoChunkRaw"]>[4];
  for (const c of encodedVideo.chunks) {
    muxer.addVideoChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, videoMeta);
  }

  const audioMeta = {
    decoderConfig: {
      codec: encodedAudio.codec,
      sampleRate: encodedAudio.sampleRate,
      numberOfChannels: encodedAudio.numberOfChannels,
      description: encodedAudio.description,
    },
  } as unknown as Parameters<Muxer<MuxTarget>["addAudioChunkRaw"]>[4];
  for (const c of encodedAudio.chunks) {
    muxer.addAudioChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, audioMeta);
  }

  muxer.finalize();

  let outputBytes: Uint8Array | null = null;
  let byteLength = 0;
  if (input.output) {
    // Caller closes the writable. We only know the size if the muxer
    // exposes it on the target — FileSystemWritableFileStreamTarget
    // doesn't, so we leave byteLength at 0 here and have the caller
    // stat the file afterwards.
    byteLength = 0;
  } else {
    const buf = (target as ArrayBufferTarget).buffer;
    outputBytes = new Uint8Array(buf);
    byteLength = outputBytes.byteLength;
  }

  return {
    output: outputBytes,
    width: outputWidth,
    height: outputHeight,
    videoCodec: encodedVideo.codec,
    audioBackend: "webcodecs",
    audioSampleRate: encodedAudio.sampleRate,
    audioChannelCount: encodedAudio.numberOfChannels,
    byteLength,
  };
}

// =============================================================================
// Multi-cam renderer
// =============================================================================

export interface CamSourceInput {
  id: string;
  file: Blob | ArrayBuffer;
  /** Cam's start time on the master timeline (seconds). The cam's source
   *  plays from source-time 0 at this point — trim narrows the *visible*
   *  window only, it doesn't shift source-time. */
  masterStartS: number;
  /** Source duration of this cam's video (seconds). For image cams this
   *  is the user-set length on the master timeline. */
  sourceDurationS: number;
  /** Per-cam drift relative to the master audio. Default 1 (no drift).
   *  See `cam-time.ts` for the sign convention — `driftRatio > 1` means
   *  the cam clock ran faster than master, so source-time advances
   *  faster per master-second. Ignored for image cams. */
  driftRatio?: number;
  /** Discriminator. Optional with default "video" for backward-compat.
   *  "image" means the file is decoded once via createImageBitmap and the
   *  same frame is emitted for every output frame in the cam's range. */
  kind?: "video" | "image";
  /** Per-clip trim (source-time seconds). Narrows the master-timeline
   *  range during which this cam is "available" to
   *  [masterStartS + trimInS, masterStartS + trimOutS]. Defaults to
   *  [0, sourceDurationS]. Image cams ignore this. */
  trimInS?: number;
  trimOutS?: number;
  /** User-applied rotation (degrees, V1: 0/90/180/270). Default 0. Stacked
   *  on top of the source's intrinsic MP4 rotation matrix. */
  rotation?: number;
  /** Mirror horizontally / vertically (post-rotation). Defaults false. */
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate). When
   *  omitted, the compositor uses the cover-fit default. */
  viewportTransform?: import("../../editor/types").ViewportTransform;
}

export interface MultiCamRenderInput
  extends Omit<EditRenderInput, "videoFile"> {
  cams: CamSourceInput[];
  cuts: Cut[];
  /**
   * Master-timeline duration (seconds). Defaults to the longest cam's end
   * position if omitted. The output's effective length is bounded by this
   * minus segment trims.
   */
  masterDurationS?: number;
  /**
   * Long-form arrangement-mode pills. When present (and `segments` is
   * non-empty), the renderer composes video by walking pills in arr-time
   * order instead of using the cams' contiguous master ranges directly.
   * Each pill defines (camId, sourceIn/Out in cam-time, arr-time
   * placement on the song); the active pill at song-time `tArr` is
   * chosen via `activeCamAtArr` (mirroring the editor preview).
   *
   * Direct-mode jobs leave this empty and fall back to the legacy
   * `activeCamAt` resolver against `camRanges`.
   */
  pills?: import("../../editor/types").Pill[];
  /**
   * Output muxer seam. When omitted, the render owns a `SingleRenderSink`
   * and finalizes it (the legacy single-job behaviour). When provided
   * (Reel), the caller owns the shared muxer + its finalize; this render
   * only streams its chunks in.
   */
  sink?: RenderSink;
  /**
   * Skip audio decode + encode entirely. Used by Reel member renders,
   * where the orchestrator encodes one global, gapless audio track for
   * all members and the per-member render contributes video only.
   */
  skipAudio?: boolean;
  /**
   * Reel outer-fit: render the member at its native dimensions (the
   * compositor stage stays native), then contain-fit + pan/zoom the whole
   * composited frame onto a larger common `stage` (the reel output frame),
   * letterboxing the aspect mismatch. The encoder runs at `stage` size.
   * When omitted the encoder runs at the native stage (single-job path).
   */
  outer?: { stage: { w: number; h: number }; viewport?: ViewportTransform };
}

/**
 * Multi-source render: walks the master timeline frame by frame, asks
 * `activeCamAt()` which cam to pull from at each step, decodes that cam's
 * frame closest to the equivalent source time, composites it, encodes it.
 *
 * Gaps (no cam active) are filled with the SMPTE color-bars test pattern.
 *
 * Audio handling is identical to the single-cam `editRender` — the master
 * studio audio is the canonical track; per-cam audio isn't mixed in V1.
 */
export async function editRenderMulti(
  input: MultiCamRenderInput,
): Promise<EditRenderResult> {
  if (input.cams.length === 0) {
    throw new Error("editRenderMulti: at least one cam is required");
  }

  // Demux all cams in parallel. Video cams go through the WebCodecs
  // demux path; image cams decode once via createImageBitmap and reuse
  // the same bitmap as the source for every frame in their range.
  input.onProgress?.({
    stage: "demux",
    framesDone: 0,
    framesTotal: 0,
  });
  type PreparedVideo = {
    cam: CamSourceInput;
    kind: "video";
    info: { width: number; height: number; rotationDeg: 0 | 90 | 180 | 270 };
    stream: CamFrameStream;
  };
  type PreparedImage = {
    cam: CamSourceInput;
    kind: "image";
    info: { width: number; height: number; rotationDeg: 0 };
    bitmap: ImageBitmap;
  };
  type Prepared = PreparedVideo | PreparedImage;
  const demuxResults: Prepared[] = await Promise.all(
    input.cams.map(async (cam): Promise<Prepared> => {
      if (cam.kind === "image") {
        const blob =
          cam.file instanceof Blob ? cam.file : new Blob([cam.file]);
        const bitmap = await createImageBitmap(blob);
        return {
          cam,
          kind: "image",
          info: {
            width: bitmap.width,
            height: bitmap.height,
            rotationDeg: 0 as const,
          },
          bitmap,
        };
      }
      const d = await demuxVideoTrack(cam.file);
      if (!d) throw new Error(`editRenderMulti: ${cam.id} has no video track`);
      const stream = await CamFrameStream.create(cam.file);
      return { cam, kind: "video", info: d.info, stream };
    }),
  );

  // Output fps is independent from any cam's source fps. Defaults to 30
  // (matches what the timeline grid + the preview RAF loop assume); a
  // user-chosen value comes through `input.outputFps`. Cam-1's source
  // fps is no longer relevant — the per-frame `frameAtOrBefore` lookup
  // handles arbitrary source rates including the 30-vs-120 case the
  // demo files exhibit.
  const fps = Math.max(1, Math.round(input.outputFps ?? 30));
  // Output dimensions = the bounding-box `(max W_disp, max H_disp)` over
  // all cams' displayed (post-rotation) sizes. That way no cam ever gets
  // cropped — cams smaller in either dimension are letterboxed/pillar-
  // boxed inside the box. Each cam still decides its own per-frame fit
  // via `compositeImage` below.
  let bboxW = 0;
  let bboxH = 0;
  for (const d of demuxResults) {
    const intrinsicRot = d.info.rotationDeg;
    const userRotRaw = d.cam.rotation ?? 0;
    const userRot = ((Math.round(userRotRaw / 90) * 90) % 360 + 360) % 360;
    const effectiveRot = (intrinsicRot + userRot) % 360;
    const swap = effectiveRot === 90 || effectiveRot === 270;
    const w = swap ? d.info.height : d.info.width;
    const h = swap ? d.info.width : d.info.height;
    if (w > bboxW) bboxW = w;
    if (h > bboxH) bboxH = h;
  }
  const outputWidth = input.outputWidth ?? bboxW;
  const outputHeight = input.outputHeight ?? bboxH;
  // Encoder/output dimensions. With a reel `outer` fit the compositor stays
  // at the native (outputWidth × outputHeight) stage and the composited
  // frame is contain-fit onto the larger `outer.stage`, which is what the
  // encoder + muxer run at. Without it the two are identical.
  const encW = input.outer ? input.outer.stage.w : outputWidth;
  const encH = input.outer ? input.outer.stage.h : outputHeight;
  const videoCodec: VideoEncodeCodec = input.videoCodec ?? "h264";

  if (videoCodec === "h265") {
    const ok = await isVideoCodecSupported("h265", encW, encH, fps);
    if (!ok) {
      // Tear down decoders before bailing.
      for (const d of demuxResults) {
        if (d.kind === "video") d.stream.close();
        else d.bitmap.close();
      }
      throw new Error(
        "This browser cannot encode H.265 at the requested resolution. Please choose H.264.",
      );
    }
  }

  // Audio: master audio is the canonical timeline. We don't time-stretch
  // or offset-shift it — each cam already encodes its own sync delay via
  // `masterStartS` (cam frame lookups go through `camSourceTimeUs` below)
  // and its own clock drift via `driftRatio`. Applying the legacy single-
  // cam `offsetMs` to the audio on top of that double-applies cam-1's
  // sync: the audio gets shifted while the cam frame lookup *also*
  // shifts to compensate, and the two shifts compound — what looked
  // like correct alignment in the preview ended up several seconds out
  // in the export.
  let audio: { pcm: Float32Array; sampleRate: number; channels: number } | null =
    null;
  if (!input.skipAudio) {
    input.onProgress?.({ stage: "audio-decode", framesDone: 0, framesTotal: 0 });
    if (input.audioPcm) {
      audio = input.audioPcm;
    } else if (input.audioFile) {
      audio = await decodeStudioAudioInterleaved(input.audioFile);
    } else {
      throw new Error(
        "editRenderMulti: either audioFile or audioPcm is required",
      );
    }
  }
  const audioCodec: AudioEncodeCodec = input.audioCodec ?? "aac";
  // When audio is skipped (Reel member render) the sink already carries the
  // muxer's audio config; these fall back to standard values only for the
  // own-sink path, which always has decoded audio.
  const audioSampleRate = audio?.sampleRate ?? 48000;
  const audioChannels = audio?.channels ?? 2;

  // Cam ranges on the master timeline + a test-pattern source for gaps.
  // Per-clip trim (video cams only) narrows the available window; image
  // cams' sourceDurationS *is* their on-timeline length so no trim
  // applies. activeCamAt routes cuts to the unrestricted cam outside
  // the trim window, falling back to the test pattern.
  const camRanges = input.cams.map((c) => {
    if (c.kind === "image") {
      return {
        id: c.id,
        startS: c.masterStartS,
        endS: c.masterStartS + c.sourceDurationS,
      };
    }
    const trimInS = Math.max(0, c.trimInS ?? 0);
    const trimOutS = Math.max(
      trimInS + 0.05,
      Math.min(c.sourceDurationS, c.trimOutS ?? c.sourceDurationS),
    );
    return {
      id: c.id,
      startS: c.masterStartS + trimInS,
      endS: c.masterStartS + trimOutS,
    };
  });
  const masterDurationS =
    input.masterDurationS ??
    Math.max(...camRanges.map((r) => r.endS), 0);
  const testPattern = makeTestPatternCanvas(outputWidth, outputHeight);

  // Compositor (overlays + visualizers + fx shared across cams).
  const compositor = await Compositor.create(
    {
      width: outputWidth,
      height: outputHeight,
      sourceWidth: outputWidth,
      sourceHeight: outputHeight,
      overlays: input.overlays,
      energy: input.energy ?? null,
      visualizers: input.visualizers ?? [],
      fx: input.fx ?? [],
    },
    input.capabilities ?? { webgl2: false, webgpu: false },
  );
  await compositor.ensureSubtitleEngine();

  // Output muxer seam. The own-sink path constructs (and later finalizes)
  // a SingleRenderSink — identical to the legacy muxer behaviour. The Reel
  // passes a shared sink it owns; this render only streams chunks in.
  const ownSink = input.sink == null;
  const sink: RenderSink =
    input.sink ??
    new SingleRenderSink({
      width: encW,
      height: encH,
      fps,
      videoCodec,
      audioCodec,
      audioChannels,
      audioSampleRate,
      output: input.output,
    });

  // Stream-encode audio: walks segments inline, emits encoded chunks,
  // each pushed straight into the sink. Skipped for Reel member renders —
  // the orchestrator encodes one global gapless track for all members.
  if (!input.skipAudio && audio) {
    input.onProgress?.({ stage: "audio-encode", framesDone: 0, framesTotal: 0 });
    const audioCodecString = audioCodec === "opus" ? "opus" : "mp4a.40.2";
    let audioMeta:
      | Parameters<Muxer<MuxTarget>["addAudioChunkRaw"]>[4]
      | undefined;
    await streamEncodeAudioWithSegments(audio.pcm, input.segments, {
      numberOfChannels: audioChannels,
      sampleRate: audioSampleRate,
      bitrateBps: input.audioBitrateBps ?? 192_000,
      codec: audioCodec,
      onChunk: (chunk, description) => {
        if (!audioMeta && description) {
          audioMeta = {
            decoderConfig: {
              codec: audioCodecString,
              sampleRate: audioSampleRate,
              numberOfChannels: audioChannels,
              description,
            },
          } as unknown as Parameters<Muxer<MuxTarget>["addAudioChunkRaw"]>[4];
        }
        sink.addAudioChunk(
          chunk.data,
          chunk.type,
          chunk.timestampUs,
          chunk.durationUs,
          audioMeta,
        );
      },
    });
  }
  // Drop our reference so the worker's PCM buffer is GC-eligible. (For
  // a 30-min stereo 48k input this is ~700 MB — no point keeping it
  // around through the video render.)
  audio = null;

  // Streaming video encoder: each emitted chunk goes straight into the
  // muxer. The encoder no longer accumulates anything in `chunks`.
  let videoMeta: Parameters<Muxer<MuxTarget>["addVideoChunkRaw"]>[4] | undefined;
  let videoChunksWritten = 0;
  const encoder = new StreamingVideoEncoder({
    width: encW,
    height: encH,
    frameRate: fps,
    videoCodec,
    bitrateBps: input.videoBitrateBps ?? 4_000_000,
    onChunk: (chunk, description) => {
      if (!videoMeta && description) {
        videoMeta = {
          decoderConfig: {
            codec: encoder.codec,
            codedWidth: encW,
            codedHeight: encH,
            description,
          },
        } as unknown as Parameters<Muxer<MuxTarget>["addVideoChunkRaw"]>[4];
      }
      sink.addVideoChunk(
        chunk.data,
        chunk.type,
        chunk.timestampUs,
        chunk.durationUs,
        videoMeta,
      );
      videoChunksWritten++;
    },
  });

  // Output segments (trim regions on the master timeline).
  const intervals: Segment[] =
    input.segments.length > 0
      ? input.segments
      : [{ in: 0, out: masterDurationS }];
  const totalKept = intervals.reduce((acc, s) => acc + (s.out - s.in), 0);
  const totalFrames = Math.max(1, Math.round(totalKept * fps));
  const frameDurationUs = Math.round(1_000_000 / fps);

  // Arrangement-mode pill table. When present, the renderer dispatches
  // each frame's active cam through `activeCamAtArr` so per-pill trim
  // and arr-placement (the user's edits in the editor's pill toolbar)
  // are honoured. Direct-mode jobs leave this empty and fall back to
  // the legacy `activeCamAt` resolver against `camRanges`.
  const pillsForRender = input.pills ?? [];
  const pillMode = pillsForRender.length > 0 && input.segments.length > 0;

  let framesEmitted = 0;
  let pendingError: Error | null = null;
  // Pipeline parallelisation: the main loop awaits frameAtOrBefore (the
  // decoder runs ahead inside CamFrameStream), then queues compositor +
  // encoder work onto a Promise chain. While the chain processes frame N
  // (compositor await + encoder push), the main loop can already pull
  // frame N+1. Decoder, compositor, encoder run nebenläufig.
  let outputQueue: Promise<void> = Promise.resolve();
  let chainInFlight = 0;
  // Reel outer-fit scratch canvas: the member's composited frame (native
  // stage) gets contain-fit + pan/zoomed onto the reel stage, letterboxing
  // the aspect mismatch with black. Allocated once, reused per frame.
  const outer = input.outer;
  const outerCanvas = outer ? new OffscreenCanvas(encW, encH) : null;
  const outerCtx = outerCanvas
    ? outerCanvas.getContext("2d", { alpha: false })
    : null;
  const outerRect = outer
    ? (() => {
        const disp = { w: outputWidth, h: outputHeight };
        const s = Math.min(encW / disp.w, encH / disp.h);
        const cover = {
          dstX: (encW - disp.w * s) / 2,
          dstY: (encH - disp.h * s) / 2,
          dstW: disp.w * s,
          dstH: disp.h * s,
        };
        return applyViewportTransform(
          cover,
          outer.viewport ?? DEFAULT_VIEWPORT_TRANSFORM,
        );
      })()
    : null;
  try {
    // Per-segment arr-time cursor — accumulated so each frame's `tArr`
    // matches the editor's masterToArr projection, which is what pills
    // are anchored against.
    let arrCursorPerSeg = 0;
    for (const seg of intervals) {
      const segStartFrame = framesEmitted;
      const segFrames = Math.max(0, Math.round((seg.out - seg.in) * fps));
      for (let i = 0; i < segFrames; i++) {
        if (pendingError) throw pendingError;
        const tMaster = seg.in + i / fps;
        const tArr = arrCursorPerSeg + i / fps;
        // Active cam: pill-aware in arrangement-mode, legacy clip-range
        // in direct-mode. Pills also yield the active pill so we can
        // pull source-time directly from its sourceIn/Out window.
        let camId: string | null;
        let activePill: import("../../editor/types").Pill | null = null;
        if (pillMode) {
          const active = activeCamAtArrLocal(
            input.cuts,
            tArr,
            pillsForRender,
            input.segments,
          );
          camId = active?.camId ?? null;
          activePill = active?.pill ?? null;
        } else {
          camId = activeCamAt(input.cuts, tMaster, camRanges);
        }
        // Resolve the source for this frame. For video cams we own the
        // returned VideoFrame (cloned from the stream-owned one) and
        // must close it after the chain composites it. Static sources
        // (image cams, test pattern) are not owned.
        type Src =
          | {
              kind: "frame";
              frame: VideoFrame;
              w: number;
              h: number;
              rot: 0 | 90 | 180 | 270;
              transform: {
                rotation?: number;
                flipX?: boolean;
                flipY?: boolean;
                viewportTransform?: import("../../editor/types").ViewportTransform;
              };
            }
          | {
              kind: "static";
              img: CanvasImageSource;
              w: number;
              h: number;
              rot: 0 | 90 | 180 | 270;
              transform: {
                rotation?: number;
                flipX?: boolean;
                flipY?: boolean;
                viewportTransform?: import("../../editor/types").ViewportTransform;
              };
            };
        let src: Src;
        if (camId) {
          const cam = demuxResults.find((d) => d.cam.id === camId)!;
          if (cam.kind === "image") {
            // Image cam: same bitmap for every frame in range. No
            // source-time math, no drift — the bitmap *is* the frame.
            src = {
              kind: "static",
              img: cam.bitmap,
              w: cam.info.width,
              h: cam.info.height,
              rot: 0,
              transform: {
                rotation: cam.cam.rotation,
                flipX: cam.cam.flipX,
                flipY: cam.cam.flipY,
                viewportTransform: cam.cam.viewportTransform,
              },
            };
          } else {
            // Source-time selection.
            //   Pill-mode: read straight from the active pill's
            //   sourceIn/Out window — moving / trimming a pill in the
            //   editor must change which frame the renderer fetches.
            //   Direct-mode: master-to-cam-source via the cam's anchor
            //   + drift, identical to the legacy path.
            const rawSourceTimeS = activePill
              ? activePill.sourceInS + (tArr - activePill.arrStartS)
              : null;
            // Clamp to the cam's actual source-time range. A pill whose
            // sourceIn/Out window points just past the end of the
            // video (within rounding error) would otherwise hand the
            // VideoDecoder a timestamp it can't satisfy, surfacing as
            // a context-free "Decoding error". Clamp to one frame
            // before the end so the decoder always lands on a valid
            // sample.
            const sourceMaxS = Math.max(
              0,
              cam.cam.sourceDurationS - 1 / fps,
            );
            const sourceTimeS =
              rawSourceTimeS != null
                ? Math.max(0, Math.min(sourceMaxS, rawSourceTimeS))
                : null;
            const sourceTimeUs =
              sourceTimeS != null
                ? Math.round(sourceTimeS * 1_000_000)
                : camSourceTimeUs(tMaster, {
                    masterStartS: cam.cam.masterStartS,
                    driftRatio: cam.cam.driftRatio ?? 1,
                  });
            let streamFrame: VideoFrame | null = null;
            try {
              streamFrame = await cam.stream.frameAtOrBefore(sourceTimeUs);
            } catch (err) {
              // The native VideoDecoder error message is just
              // "Decoding error" — useless for debugging. Re-throw
              // with the cam id, source-time, and frame number so
              // the user has a chance of understanding which input
              // is bad.
              const orig = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Render decode failed on cam '${cam.cam.id}' at source-time ` +
                  `${(sourceTimeUs / 1_000_000).toFixed(3)}s ` +
                  `(arr ${tArr.toFixed(3)}s, master ${tMaster.toFixed(3)}s, ` +
                  `frame ${framesEmitted}): ${orig}`,
              );
            }
            if (streamFrame) {
              // Clone the stream-owned frame so it stays alive past the
              // next frameAtOrBefore call. WebCodecs' VideoFrame
              // constructor is a cheap reference-clone (shared buffer,
              // refcounted) — not a pixel copy.
              const owned = new VideoFrame(streamFrame, {
                timestamp: streamFrame.timestamp,
              });
              src = {
                kind: "frame",
                frame: owned,
                w: cam.info.width,
                h: cam.info.height,
                rot: cam.info.rotationDeg,
                transform: {
                  rotation: cam.cam.rotation,
                  flipX: cam.cam.flipX,
                  flipY: cam.cam.flipY,
                  viewportTransform: cam.cam.viewportTransform,
                },
              };
            } else {
              src = {
                kind: "static",
                img: testPattern,
                w: outputWidth,
                h: outputHeight,
                rot: 0,
                transform: {},
              };
            }
          }
        } else {
          src = {
            kind: "static",
            img: testPattern,
            w: outputWidth,
            h: outputHeight,
            rot: 0,
            transform: {},
          };
        }
        const outTimestampUs = framesEmitted * frameDurationUs;
        const isFirstInSeg = framesEmitted === segStartFrame;
        const myFrameNum = framesEmitted;
        const captured = {
          src,
          outTs: outTimestampUs,
          isFirstInSeg,
          tArr,
        };
        framesEmitted++;
        chainInFlight++;
        outputQueue = outputQueue.then(async () => {
          try {
            if (pendingError) return;
            const composed = await compositor.compositeImage(
              captured.src.kind === "frame"
                ? (captured.src.frame as unknown as CanvasImageSource)
                : captured.src.img,
              captured.src.w,
              captured.src.h,
              captured.outTs,
              frameDurationUs,
              captured.src.rot,
              captured.src.transform,
              // FX live in timeline-time (= arrangement-time). Pass tArr
              // so the FX-active query lines up with the editor: a recording
              // at the duplicate-pill slot fires there and only there.
              captured.tArr,
            );
            if (outerCtx && outerCanvas && outerRect) {
              // Letterbox the native composited frame onto the reel stage.
              outerCtx.fillStyle = "#000";
              outerCtx.fillRect(0, 0, encW, encH);
              outerCtx.drawImage(
                composed as unknown as CanvasImageSource,
                outerRect.dstX,
                outerRect.dstY,
                outerRect.dstW,
                outerRect.dstH,
              );
              composed.close();
              const outFrame = new VideoFrame(outerCanvas, {
                timestamp: captured.outTs,
                duration: frameDurationUs,
              });
              encoder.pushFrame(outFrame, { keyFrame: captured.isFirstInSeg });
              outFrame.close();
            } else {
              encoder.pushFrame(composed, { keyFrame: captured.isFirstInSeg });
              composed.close();
            }
            const done = myFrameNum + 1;
            if (done % 30 === 0 || done === totalFrames) {
              input.onProgress?.({
                stage: "video-encode",
                framesDone: done,
                framesTotal: totalFrames,
              });
            }
          } catch (e) {
            pendingError = e instanceof Error ? e : new Error(String(e));
          } finally {
            if (captured.src.kind === "frame") {
              try {
                captured.src.frame.close();
              } catch {
                /* already closed */
              }
            }
            chainInFlight--;
          }
        });
        // Hard backpressure on encoder + composite chain. Without this
        // the main loop would queue chains faster than the GPU
        // compositor + encoder can drain them — at 4K each in-flight
        // VideoFrame is ~12 MB, so a few seconds of overflow runs into
        // multi-GB territory and crashes the tab. Encoder threshold (16)
        // matches the single-cam path. Chain-depth threshold (4) bounds
        // queued composite work — compositor takes ~10-30 ms per 4K
        // frame so 4 means the main loop can run ~50-100 ms ahead of
        // the GPU.
        while (encoder.encodeQueueSize > 16 || chainInFlight > 4) {
          if (pendingError) throw pendingError;
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      arrCursorPerSeg += seg.out - seg.in;
    }
    // Drain pending compositor + encoder work before advancing to flush.
    await outputQueue;
    if (pendingError) throw pendingError;

    // The encoder still has pending frames to flush — on a 90 s clip
    // that's 1-3 s of opaque waiting. Surface it as its own stage so the
    // progress bar moves off the last frame-encode tick.
    input.onProgress?.({
      stage: "encoder-flush",
      framesDone: framesEmitted,
      framesTotal: totalFrames,
    });
    // encoder.finish() flushes pending frames; the streaming `onChunk`
    // callback has already pushed every chunk into the muxer by then.
    // The returned value is mostly a metadata bundle; chunks is empty
    // in streaming mode.
    const encodedVideo = await encoder.finish();
    if (!encodedVideo.description) {
      throw new Error("Video encoder produced no description");
    }

    let outputBytes: Uint8Array | null = null;
    let byteLength = 0;
    // Own-sink path finalizes its muxer here. With a shared (Reel) sink the
    // orchestrator finalizes once after every member has streamed in.
    if (ownSink) {
      input.onProgress?.({
        stage: "muxing",
        framesDone: videoChunksWritten,
        framesTotal: framesEmitted,
      });
      const res = sink.finalize();
      outputBytes = res.output;
      byteLength = res.byteLength;
    }

    return {
      output: outputBytes,
      width: encW,
      height: encH,
      videoCodec: encodedVideo.codec,
      audioBackend: "webcodecs",
      audioSampleRate: audioSampleRate,
      audioChannelCount: audioChannels,
      byteLength,
    };
  } finally {
    compositor.destroy();
    for (const d of demuxResults) {
      if (d.kind === "video") d.stream.close();
      else d.bitmap.close();
    }
  }
}
