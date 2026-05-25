/// <reference lib="webworker" />

/**
 * Reel-render worker.
 *
 * Renders several already-edited projects ("members") back-to-back into ONE
 * MP4. One shared muxer (SharedReelSink) spans all members:
 *
 *   1. Audio is pre-concatenated on the main thread (decode + resample to a
 *      common rate/channels + per-member trim + frame-accurate pad) into one
 *      gapless interleaved PCM buffer. The worker encodes it ONCE.
 *   2. Each member's video is rendered via `editRenderMulti` in video-only
 *      mode (`skipAudio`) into the shared sink, with a cumulative time
 *      offset so the members line up on one monotonic timeline. Each member
 *      is contain-fit (`outer`) onto the common reel stage with its own
 *      pan/zoom, letterboxing aspect mismatches.
 *
 * Cancel = `worker.terminate()`; the orchestrator cleans up the partial
 * OPFS file.
 */
import {
  editRenderMulti,
  type EditRenderProgress,
  type Segment,
} from "./edit";
import { SharedReelSink } from "./render-sink";
import { streamEncodeAudioWithSegments } from "../codec/webcodecs/audio-encode";
import { opfs } from "../../storage/opfs";
import { loadAsset } from "../asset-source";
import type { BackendCapabilities } from "../../editor/render/factory";
import { probeWebGPUVideoFrameUpload } from "../capabilities";
import { ShowwavesVisualizer } from "./visualizer/showwaves";
import { ShowfreqsVisualizer } from "./visualizer/showfreqs";
import type { Visualizer } from "./visualizer/types";
import type { TextOverlay, EnergyCurves } from "./ass-builder";
import type { Cut } from "../../storage/jobs-db";
import type { PunchFx } from "../../editor/fx/types";
import type { ViewportTransform, Pill } from "../../editor/types";
import type {
  CamWorkerInput,
  VisualizerWorkerDescriptor,
} from "./edit.worker";

export interface ReelMemberWorkerInput {
  cams: CamWorkerInput[];
  cuts?: Cut[];
  pills?: Pill[];
  masterDurationS?: number;
  segments: Segment[];
  overlays: TextOverlay[];
  visualizers: VisualizerWorkerDescriptor[];
  energy: EnergyCurves | null;
  fx?: PunchFx[];
  offsetMs: number;
  driftRatio: number;
  /** Member's native compositor stage (its own export resolution). The
   *  composited frame is contain-fit from here onto the reel stage. */
  nativeWidth?: number;
  nativeHeight?: number;
  /** Per-member pan/zoom over the reel stage. */
  viewport?: ViewportTransform;
  /** Output video frame count for this member — drives the cumulative
   *  time offset between members. */
  videoFrameCount: number;
}

export interface ReelWorkerInput {
  outputPath: string;
  stage: { w: number; h: number };
  fps: number;
  videoCodec: "h264" | "h265";
  audioCodec: "aac" | "opus";
  videoBitrateBps?: number;
  audioBitrateBps?: number;
  /** Pre-concatenated, gapless global audio track for the whole reel. */
  audioPcm: { pcm: Float32Array; sampleRate: number; channels: number };
  members: ReelMemberWorkerInput[];
}

export type ReelWorkerMessage = { type: "start"; input: ReelWorkerInput };

export type ReelWorkerEvent =
  | { type: "progress"; progress: { pct: number; stage: string } }
  | { type: "done" }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function probeBackendCapabilities(): Promise<BackendCapabilities> {
  let webgl2 = false;
  try {
    const probe = new OffscreenCanvas(1, 1);
    webgl2 = probe.getContext("webgl2") != null;
  } catch {
    /* OffscreenCanvas missing or webgl2 unsupported */
  }
  let webgpu = false;
  const gpu = (self.navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) webgpu = await probeWebGPUVideoFrameUpload(adapter);
    } catch {
      /* leave webgpu=false */
    }
  }
  return { webgl2, webgpu };
}

ctx.addEventListener("message", async (e: MessageEvent<ReelWorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== "start") return;
  const input = msg.input;

  const post = (evt: ReelWorkerEvent) => ctx.postMessage(evt);
  let writable: FileSystemWritableFileStream | null = null;
  try {
    if (input.members.length === 0) throw new Error("reelWorker: no members");
    writable = await opfs.createWritable(input.outputPath);
    const capabilities = await probeBackendCapabilities();

    const sink = new SharedReelSink({
      width: input.stage.w,
      height: input.stage.h,
      fps: input.fps,
      videoCodec: input.videoCodec,
      audioCodec: input.audioCodec,
      audioChannels: input.audioPcm.channels,
      audioSampleRate: input.audioPcm.sampleRate,
      output: writable,
    });

    // --- Audio: one global encode into the shared track. ---
    post({ progress: { pct: 4, stage: "audio-encode" }, type: "progress" });
    const audioCodecString = input.audioCodec === "opus" ? "opus" : "mp4a.40.2";
    let audioMeta:
      | Parameters<SharedReelSink["addAudioChunk"]>[4]
      | undefined;
    await streamEncodeAudioWithSegments(input.audioPcm.pcm, [], {
      numberOfChannels: input.audioPcm.channels,
      sampleRate: input.audioPcm.sampleRate,
      bitrateBps: input.audioBitrateBps ?? 192_000,
      codec: input.audioCodec,
      onChunk: (chunk, description) => {
        if (!audioMeta && description) {
          audioMeta = {
            decoderConfig: {
              codec: audioCodecString,
              sampleRate: input.audioPcm.sampleRate,
              numberOfChannels: input.audioPcm.channels,
              description,
            },
          } as unknown as Parameters<SharedReelSink["addAudioChunk"]>[4];
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

    // --- Video: each member, in order, into the shared sink. ---
    const frameDurationUs = Math.round(1_000_000 / input.fps);
    const totalFrames = Math.max(
      1,
      input.members.reduce((a, m) => a + m.videoFrameCount, 0),
    );
    let framesBefore = 0;
    for (let k = 0; k < input.members.length; k++) {
      const m = input.members[k];
      sink.setVideoTimeOffset(framesBefore * frameDurationUs);

      const camFiles = await Promise.all(
        m.cams.map(async (c) => ({ ...c, file: await loadAsset(c.source) })),
      );
      const visualizers: Visualizer[] = [];
      for (const d of m.visualizers) {
        if (d.type === "showwaves") {
          visualizers.push(
            new ShowwavesVisualizer({ pcm: d.pcm, sampleRate: d.sampleRate }),
          );
        } else if (d.type === "showfreqs") {
          visualizers.push(new ShowfreqsVisualizer({ energy: d.energy }));
        }
      }

      const memberBase = framesBefore;
      const onProgress = (p: EditRenderProgress) => {
        if (p.stage === "video-encode") {
          const done = memberBase + p.framesDone;
          post({
            type: "progress",
            progress: {
              pct: Math.min(96, 6 + Math.floor((done / totalFrames) * 88)),
              stage: "encoding",
            },
          });
        }
      };

      await editRenderMulti({
        cams: camFiles.map((c) => ({
          id: c.id,
          file: c.file,
          masterStartS: c.masterStartS,
          sourceDurationS: c.sourceDurationS,
          driftRatio: c.driftRatio ?? 1,
          kind: c.kind ?? "video",
          trimInS: c.trimInS,
          trimOutS: c.trimOutS,
          rotation: c.rotation,
          flipX: c.flipX,
          flipY: c.flipY,
          viewportTransform: c.viewportTransform,
        })),
        cuts: m.cuts ?? [],
        pills: m.pills,
        masterDurationS: m.masterDurationS,
        segments: m.segments,
        overlays: m.overlays,
        energy: m.energy,
        visualizers,
        fx: m.fx,
        offsetMs: m.offsetMs,
        driftRatio: m.driftRatio,
        outputFps: input.fps,
        outputWidth: m.nativeWidth,
        outputHeight: m.nativeHeight,
        videoCodec: input.videoCodec,
        videoBitrateBps: input.videoBitrateBps,
        // Audio handled globally; member contributes video only.
        skipAudio: true,
        sink,
        outer: { stage: input.stage, viewport: m.viewport },
        capabilities,
        onProgress,
      });

      framesBefore += m.videoFrameCount;
    }

    post({ type: "progress", progress: { pct: 98, stage: "finalizing" } });
    sink.finalize();
    await writable.close();
    writable = null;
    post({ type: "done" });
  } catch (err) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        /* best-effort */
      }
    }
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
