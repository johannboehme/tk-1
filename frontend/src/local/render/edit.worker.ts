/// <reference lib="webworker" />

/**
 * Edit-render worker.
 *
 * Owns the entire video pipeline (demux → decode → composite → encode →
 * mux) so the main thread stays responsive: the render screen can animate,
 * and the cancel button stays clickable. Audio decode happens on the main
 * thread before the worker is spawned (AudioContext is unavailable in
 * workers); the resulting Float32Array is transferred in.
 *
 * Cancel = `worker.terminate()` from the main thread. The orchestrator in
 * jobs.ts is responsible for cleaning up the partially-written OPFS file.
 *
 * Message protocol:
 *   in:  { type: "start", input: WorkerInput } — sent once
 *   out: { type: "progress", progress: EditRenderProgress }
 *        { type: "done" }
 *        { type: "error", message: string }
 */

import {
  editRender,
  editRenderMulti,
  type EditRenderProgress,
  type Segment,
} from "./edit";
import { opfs } from "../../storage/opfs";
import type { BackendCapabilities } from "../../editor/render/factory";
import { ShowwavesVisualizer } from "./visualizer/showwaves";
import { ShowfreqsVisualizer } from "./visualizer/showfreqs";
import type { Visualizer } from "./visualizer/types";
import type { TextOverlay, EnergyCurves } from "./ass-builder";
import type { Cut } from "../../storage/jobs-db";
import type { PunchFx } from "../../editor/fx/types";

export type VisualizerWorkerDescriptor =
  | { type: "showwaves"; pcm: Float32Array; sampleRate: number }
  | { type: "showfreqs"; energy: EnergyCurves };

/** Per-cam input descriptor for the multi-source render path. */
export interface CamWorkerInput {
  id: string;
  opfsPath: string;
  /** Cam start position on the master timeline (seconds). The cam's
   *  source plays from source-time 0 at this point, regardless of
   *  trim — trim only narrows the *visible* window. */
  masterStartS: number;
  sourceDurationS: number;
  /** Per-cam drift vs. master audio. Default 1 = no drift. */
  driftRatio?: number;
  /** Discriminator. Optional with default "video" so existing payloads
   *  keep working unchanged. "image" tells the worker to decode the file
   *  as a still image and emit it as a static frame for the entire range. */
  kind?: "video" | "image";
  /** Per-clip trim — narrows the cam's "available" master-timeline
   *  range. Defaults to [0, sourceDurationS] (no trim). */
  trimInS?: number;
  trimOutS?: number;
  /** User-applied rotation (degrees, V1: 0/90/180/270). Default 0. */
  rotation?: number;
  /** Mirror horizontally / vertically. Defaults false. */
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element Stage placement (cover-fit + scale + translate).
   *  Plumbed through to the compositor so render = preview placement. */
  viewportTransform?: import("../../editor/types").ViewportTransform;
}

export interface EditWorkerInput {
  /** Legacy single-cam path. Used when `cams` is omitted (or has length 1
   *  and `cuts` is empty — the renderer fast-paths to the simpler pipeline). */
  videoPath?: string;
  /** Multi-cam path. When present and (cams.length > 1 || cuts.length > 0)
   *  the worker dispatches to `editRenderMulti`. */
  cams?: CamWorkerInput[];
  cuts?: Cut[];
  /** Master-timeline duration; defaults to longest cam's end. */
  masterDurationS?: number;

  outputPath: string;
  audioPcm: { pcm: Float32Array; sampleRate: number; channels: number };
  segments: Segment[];
  overlays: TextOverlay[];
  visualizers: VisualizerWorkerDescriptor[];
  energy: EnergyCurves | null;
  /** Punch-in FX (visual effects with in/out spans). Same shape the
   *  editor store holds; passed through verbatim to the compositor. */
  fx?: PunchFx[];
  offsetMs: number;
  driftRatio: number;
  /** Output codec/dimension/bitrate overrides. Optional — the renderer
   *  defaults to "source dimensions, H.264, AAC, 4 Mbps" when omitted. */
  outputWidth?: number;
  outputHeight?: number;
  videoCodec?: "h264" | "h265";
  audioCodec?: "aac" | "opus";
  videoBitrateBps?: number;
  audioBitrateBps?: number;
  /** Output framerate (defaults to 30). Independent from any cam's source fps. */
  outputFps?: number;
}

export type EditWorkerMessage =
  | { type: "start"; input: EditWorkerInput }
  ;

export type EditWorkerEvent =
  | { type: "progress"; progress: EditRenderProgress }
  | { type: "done" }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Detect render-backend capabilities inside the worker. The compositor
 *  uses these to pick WebGPU → WebGL2 → Canvas2D in the Factory ladder.
 *  - webgl2: sync probe via OffscreenCanvas.getContext.
 *  - webgpu: async probe via requestAdapter — null means "API exists
 *            but no compatible adapter on this platform" (Linux-Chrome
 *            without dedicated GPU is the typical fail case). */
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
      webgpu = adapter != null;
    } catch {
      /* requestAdapter threw — leave webgpu=false */
    }
  }
  return { webgl2, webgpu };
}

ctx.addEventListener("message", async (e: MessageEvent<EditWorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== "start") return;
  const input = msg.input;

  let writable: FileSystemWritableFileStream | null = null;
  try {
    writable = await opfs.createWritable(input.outputPath);
    // Probe once per worker invocation. Cheap on the second worker-spawn
    // (adapter is cached at the platform-driver level).
    const capabilities = await probeBackendCapabilities();

    const visualizers: Visualizer[] = [];
    for (const d of input.visualizers) {
      if (d.type === "showwaves") {
        visualizers.push(new ShowwavesVisualizer({ pcm: d.pcm, sampleRate: d.sampleRate }));
      } else if (d.type === "showfreqs") {
        visualizers.push(new ShowfreqsVisualizer({ energy: d.energy }));
      }
    }

    const onProgress = (p: EditRenderProgress) => {
      const evt: EditWorkerEvent = { type: "progress", progress: p };
      ctx.postMessage(evt);
    };

    const useMultiCam =
      input.cams !== undefined &&
      (input.cams.length > 1 || (input.cuts ?? []).length > 0);

    if (useMultiCam) {
      const cams = input.cams!;
      const camFiles = await Promise.all(
        cams.map(async (c) => ({
          ...c,
          file: await opfs.readFile(c.opfsPath),
        })),
      );
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
        cuts: input.cuts ?? [],
        masterDurationS: input.masterDurationS,
        audioPcm: input.audioPcm,
        segments: input.segments,
        overlays: input.overlays,
        energy: input.energy,
        visualizers,
        fx: input.fx,
        offsetMs: input.offsetMs,
        driftRatio: input.driftRatio,
        outputFps: input.outputFps,
        outputWidth: input.outputWidth,
        outputHeight: input.outputHeight,
        videoCodec: input.videoCodec,
        audioCodec: input.audioCodec,
        videoBitrateBps: input.videoBitrateBps,
        audioBitrateBps: input.audioBitrateBps,
        output: writable,
        onProgress,
        capabilities,
      });
    } else {
      // Single-cam fast path. Either `videoPath` (legacy) or the only entry
      // in `cams` provides the source.
      const path = input.videoPath ?? input.cams?.[0]?.opfsPath;
      if (!path) throw new Error("editWorker: no video source provided");
      const videoFile = await opfs.readFile(path);
      await editRender({
        videoFile,
        audioPcm: input.audioPcm,
        segments: input.segments,
        overlays: input.overlays,
        energy: input.energy,
        visualizers,
        fx: input.fx,
        offsetMs: input.offsetMs,
        driftRatio: input.driftRatio,
        outputWidth: input.outputWidth,
        outputHeight: input.outputHeight,
        videoCodec: input.videoCodec,
        audioCodec: input.audioCodec,
        videoBitrateBps: input.videoBitrateBps,
        audioBitrateBps: input.audioBitrateBps,
        output: writable,
        onProgress,
        capabilities,
      });
    }

    await writable.close();
    writable = null;
    const done: EditWorkerEvent = { type: "done" };
    ctx.postMessage(done);
  } catch (err) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // best-effort
      }
    }
    const evt: EditWorkerEvent = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(evt);
  }
});
