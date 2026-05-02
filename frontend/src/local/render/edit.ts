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
import type { BackendCapabilities } from "../../editor/render/factory";
import { CamFrameStream } from "./cam-frame-stream";
import { makeTestPatternCanvas } from "./test-pattern";
import { activeCamAt } from "../../editor/cuts";
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
      pendingError = e instanceof Error ? e : new Error(String(e));
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
  const videoCodec: VideoEncodeCodec = input.videoCodec ?? "h264";

  if (videoCodec === "h265") {
    const ok = await isVideoCodecSupported("h265", outputWidth, outputHeight, fps);
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
  input.onProgress?.({ stage: "audio-decode", framesDone: 0, framesTotal: 0 });
  let audio: { pcm: Float32Array; sampleRate: number; channels: number };
  if (input.audioPcm) {
    audio = input.audioPcm;
  } else if (input.audioFile) {
    audio = await decodeStudioAudioInterleaved(input.audioFile);
  } else {
    throw new Error("editRenderMulti: either audioFile or audioPcm is required");
  }
  let pcm: Float32Array | null = audio.pcm;
  pcm = applySegments(pcm, audio.channels, audio.sampleRate, input.segments);

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
  pcm = null;

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

  const encoder = new StreamingVideoEncoder({
    width: outputWidth,
    height: outputHeight,
    frameRate: fps,
    videoCodec,
    bitrateBps: input.videoBitrateBps ?? 4_000_000,
  });

  // Output segments (trim regions on the master timeline).
  const intervals: Segment[] =
    input.segments.length > 0
      ? input.segments
      : [{ in: 0, out: masterDurationS }];
  const totalKept = intervals.reduce((acc, s) => acc + (s.out - s.in), 0);
  const totalFrames = Math.max(1, Math.round(totalKept * fps));
  const frameDurationUs = Math.round(1_000_000 / fps);

  let framesEmitted = 0;
  try {
    for (const seg of intervals) {
      const segStartFrame = framesEmitted;
      const segFrames = Math.max(0, Math.round((seg.out - seg.in) * fps));
      for (let i = 0; i < segFrames; i++) {
        const tMaster = seg.in + i / fps;
        const camId = activeCamAt(input.cuts, tMaster, camRanges);
        let source: CanvasImageSource;
        let srcW: number;
        let srcH: number;
        let srcRot: 0 | 90 | 180 | 270 = 0;
        let userTransform: {
          rotation?: number;
          flipX?: boolean;
          flipY?: boolean;
          viewportTransform?: import("../../editor/types").ViewportTransform;
        } = {};
        if (camId) {
          const cam = demuxResults.find((d) => d.cam.id === camId)!;
          if (cam.kind === "image") {
            // Image cam: same bitmap for every frame in range. No
            // source-time math, no drift — the bitmap *is* the frame.
            source = cam.bitmap;
            srcW = cam.info.width;
            srcH = cam.info.height;
            userTransform = {
              rotation: cam.cam.rotation,
              flipX: cam.cam.flipX,
              flipY: cam.cam.flipY,
              viewportTransform: cam.cam.viewportTransform,
            };
          } else {
            const sourceTimeUs = camSourceTimeUs(tMaster, {
              masterStartS: cam.cam.masterStartS,
              driftRatio: cam.cam.driftRatio ?? 1,
            });
            const frame = await cam.stream.frameAtOrBefore(sourceTimeUs);
            if (frame) {
              source = frame as unknown as CanvasImageSource;
              srcW = cam.info.width;
              srcH = cam.info.height;
              srcRot = cam.info.rotationDeg;
              userTransform = {
                rotation: cam.cam.rotation,
                flipX: cam.cam.flipX,
                flipY: cam.cam.flipY,
                viewportTransform: cam.cam.viewportTransform,
              };
            } else {
              source = testPattern;
              srcW = outputWidth;
              srcH = outputHeight;
            }
          }
        } else {
          source = testPattern;
          srcW = outputWidth;
          srcH = outputHeight;
        }
        const outTimestampUs = framesEmitted * frameDurationUs;
        const composed = await compositor.compositeImage(
          source,
          srcW,
          srcH,
          outTimestampUs,
          frameDurationUs,
          srcRot,
          userTransform,
          // FX must be looked up at master time (tMaster), not the
          // segment-relative output timestamp — segments shift output
          // time so FX queries with output time miss every FX.
          tMaster,
        );
        encoder.pushFrame(composed, {
          keyFrame: framesEmitted === segStartFrame,
        });
        composed.close();
        framesEmitted++;
        if (framesEmitted % 30 === 0 || framesEmitted === totalFrames) {
          input.onProgress?.({
            stage: "video-encode",
            framesDone: framesEmitted,
            framesTotal: totalFrames,
          });
        }
        // Yield to let the encoder flush; without this Chrome occasionally
        // stalls when the compositor pushes faster than the encoder accepts.
        if ((framesEmitted & 0x07) === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    // The encoder still has pending frames to flush — on a 90 s clip
    // that's 1-3 s of opaque waiting. Surface it as its own stage so the
    // progress bar moves off the last frame-encode tick.
    input.onProgress?.({
      stage: "encoder-flush",
      framesDone: framesEmitted,
      framesTotal: totalFrames,
    });
    const encodedVideo = await encoder.finish();
    if (!encodedVideo.description) {
      throw new Error("Video encoder produced no description");
    }

    input.onProgress?.({
      stage: "muxing",
      framesDone: framesEmitted,
      framesTotal: totalFrames,
    });

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
    // Push chunks in batches so the progress event fires periodically
    // while the muxer streams to FileSystemWritableFileStream — without
    // this, longer renders sit silent for several seconds while the file
    // is written.
    const totalChunks = encodedVideo.chunks.length + encodedAudio.chunks.length;
    let chunksWritten = 0;
    const reportMuxProgress = () => {
      input.onProgress?.({
        stage: "muxing",
        framesDone: chunksWritten,
        framesTotal: totalChunks,
      });
    };
    for (const c of encodedVideo.chunks) {
      muxer.addVideoChunkRaw(c.data, c.type, c.timestampUs, c.durationUs, videoMeta);
      chunksWritten++;
      if ((chunksWritten & 0x3f) === 0) reportMuxProgress();
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
      chunksWritten++;
      if ((chunksWritten & 0x3f) === 0) reportMuxProgress();
    }

    input.onProgress?.({
      stage: "finalizing",
      framesDone: chunksWritten,
      framesTotal: totalChunks,
    });
    muxer.finalize();

    let outputBytes: Uint8Array | null = null;
    let byteLength = 0;
    if (!input.output) {
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
  } finally {
    compositor.destroy();
    for (const d of demuxResults) {
      if (d.kind === "video") d.stream.close();
      else d.bitmap.close();
    }
  }
}
