/**
 * Local-job lifecycle. Replaces the backend job API.
 *
 * Flow:
 *   1. `createJob(videoFiles, audioFile, title)` writes 1 master audio +
 *      1..N video files to OPFS, records a fresh `LocalJob` in IndexedDB
 *      (status=queued), and returns its id. Sync is launched immediately
 *      as a fire-and-forget task per video; UI should subscribe to job
 *      events to show progress.
 *   2. `runQuickRender(jobId, opts)` produces an MP4 in OPFS using the
 *      sync result + user offset/drift overrides.
 *   3. `runEditRender(jobId, editSpec)` does the same for the full edit.
 *
 * Progress is dispatched on a global EventTarget so multiple components
 * can subscribe (JobPage, History) without coupling to the orchestrator.
 */

import {
  isImageAsset,
  isVideoAsset,
  jobsDb,
  type JobProgress,
  type LocalJob,
  type SyncResult,
  type VideoAsset,
} from "../storage/jobs-db";
import { camColorAt } from "../storage/migrations";
import { opfs } from "../storage/opfs";
import { syncAudio } from "./sync";
import { getOrComputeAnalysis } from "./render/audio-analysis";
import { quickRender } from "./render/quick";
import {
  decodeStudioAudioInterleaved,
  type Segment,
} from "./render/edit";
import type {
  CamWorkerInput,
  EditWorkerEvent,
  EditWorkerInput,
  EditWorkerMessage,
  VisualizerWorkerDescriptor,
} from "./render/edit.worker";
import { decodeAudioToMonoPcm } from "./codec";
import { computeEnergyCurves } from "./render/energy";
import { extractTimelineFrames } from "./render/frames";
import type { TextOverlay } from "./render/ass-builder";
import {
  installRenderUnloadGuard,
  pruneIfQuotaTight,
  removeRenderUnloadGuard,
  requestPersistentStorage,
} from "./lifecycle";
import { emitJobUpdate, jobEvents } from "./jobs-events";

export { jobEvents };

const AUDIO_NAME = "audio";
const OUTPUT_NAME = "output.mp4";

function audioPath(jobId: string, ext: string): string {
  return `jobs/${jobId}/${AUDIO_NAME}.${ext}`;
}
function outputPath(jobId: string): string {
  return `jobs/${jobId}/${OUTPUT_NAME}`;
}
function camVideoPath(jobId: string, camId: string, ext: string): string {
  return `jobs/${jobId}/${camId}.${ext}`;
}
function camFramesPath(jobId: string, camId: string): string {
  return `jobs/${jobId}/frames-${camId}.webp`;
}

function generateJobId(): string {
  // 12 hex chars from cryptographically random bytes; same density as a
  // UUID's prefix and avoids the dashes when used in URLs.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fileExtension(file: File, fallback: string): string {
  const dot = file.name.lastIndexOf(".");
  if (dot < 0 || dot === file.name.length - 1) return fallback;
  const ext = file.name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext : fallback;
}

// -----------------------------------------------------------------------------
// Single source of truth for "persist a media file as a new cam slot in OPFS
// + return the matching asset record". Used by both the upfront upload flow
// (createJob — loops over the user's videos) and the per-cam Editor "+ Media"
// flow (addVideoToJob / addImageToJob — one cam per call).
// -----------------------------------------------------------------------------

/** Persist a video file as cam-{index+1} in OPFS and return the
 *  VideoAsset record (without sync / dimensions / framesPath — those are
 *  filled by runCamPrep). */
async function persistVideoCam(
  jobId: string,
  file: File,
  index: number,
): Promise<VideoAsset> {
  const camId = `cam-${index + 1}`;
  const ext = fileExtension(file, "mp4");
  const opfsPath = camVideoPath(jobId, camId, ext);
  await opfs.writeFile(opfsPath, file);
  return {
    id: camId,
    filename: file.name,
    opfsPath,
    color: camColorAt(index),
  };
}

/** Persist an image file as cam-{index+1} in OPFS, probe its dimensions,
 *  and return the ImageAsset record. Probing failure is non-fatal —
 *  width/height stay undefined and the lane uses a fallback aspect. */
async function persistImageCam(
  jobId: string,
  file: File,
  index: number,
  durationS: number,
): Promise<{
  kind: "image";
  id: string;
  filename: string;
  opfsPath: string;
  color: string;
  durationS: number;
  width?: number;
  height?: number;
}> {
  const camId = `cam-${index + 1}`;
  const ext = fileExtension(file, "png");
  const opfsPath = camVideoPath(jobId, camId, ext);
  await opfs.writeFile(opfsPath, file);
  let width: number | undefined;
  let height: number | undefined;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    // ignore — non-fatal
  }
  return {
    kind: "image",
    id: camId,
    filename: file.name,
    opfsPath,
    color: camColorAt(index),
    durationS,
    width,
    height,
  };
}

interface CreateJobOptions {
  /** Optional title; falls back to the video file name. */
  title?: string | null;
}

/**
 * Persists the input files in OPFS, registers the job, and kicks off sync
 * asynchronously. Returns immediately with the new job id; subscribe to
 * `jobEvents` for status updates.
 *
 * `videoFiles` must contain at least one video; the first one becomes cam-1
 * (the lane that's mirrored into legacy top-level fields for backward
 * compat).
 */
export async function createJob(
  videoFiles: File[],
  audioFile: File,
  options: CreateJobOptions = {},
): Promise<string> {
  if (videoFiles.length === 0) {
    throw new Error("At least one video is required");
  }

  // Best-effort housekeeping before we commit big new files: ask for
  // persistent storage (so the browser doesn't evict OPFS under pressure)
  // and prune old jobs if we're close to the quota.
  void requestPersistentStorage();
  await pruneIfQuotaTight().catch(() => undefined);

  const jobId = generateJobId();
  const audioExt = fileExtension(audioFile, "wav");

  await opfs.writeFile(audioPath(jobId, audioExt), audioFile);

  const videos: VideoAsset[] = [];
  for (let i = 0; i < videoFiles.length; i++) {
    videos.push(await persistVideoCam(jobId, videoFiles[i], i));
  }

  const firstVideo = videoFiles[0];

  const job: LocalJob = {
    id: jobId,
    title: options.title ?? firstVideo.name,
    // Legacy V1 mirrors of cam-1 (kept for backward compat — older callers
    // may still read videoFilename / sync / dimensions at the top level).
    videoFilename: firstVideo.name,
    audioFilename: audioFile.name,
    status: "queued",
    progress: { pct: 0, stage: "queued" },
    hasOutput: false,
    createdAt: Date.now(),
    schemaVersion: 2,
    videos,
    cuts: [],
  };
  await jobsDb.saveJob(job);
  emitJobUpdate(job);

  // Kick off sync without awaiting — UI subscribes for results.
  void runSync(jobId, audioExt).catch(async (err) => {
    const failed = await jobsDb.updateJob(jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      progress: { pct: 100, stage: "failed" },
    });
    emitJobUpdate(failed);
  });

  return jobId;
}

async function reportProgress(
  jobId: string,
  partial: Partial<JobProgress>,
  status?: LocalJob["status"],
): Promise<void> {
  const cur = await jobsDb.getJob(jobId);
  if (!cur) return;
  const next: JobProgress = { ...cur.progress, ...partial };
  const updated = await jobsDb.updateJob(jobId, {
    progress: next,
    ...(status ? { status } : {}),
  });
  emitJobUpdate(updated);
}

/**
 * Mark a job as failed and emit an update event. Best-effort — if the
 * row no longer exists (e.g. user deleted it during render), we swallow.
 */
async function markFailed(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const updated = await jobsDb.updateJob(jobId, {
      status: "failed",
      error: message,
      progress: { pct: 100, stage: "failed" },
      finishedAt: Date.now(),
    });
    emitJobUpdate(updated);
  } catch {
    // ignore — likely deleted
  }
}

/**
 * Per-cam preparation: decode + match (unless skipped) + probe + frames.
 *
 * Decoupled from any specific orchestration so it can be reused by the
 * upfront `runSync` (batches all cams) and by `addVideoToJob` (one cam
 * added later from the editor).
 *
 * `mapPct` lets the caller control how the per-cam fractional progress
 * (0..1) is mapped onto the job's global pct bar — runSync uses a per-cam
 * band of the 5..95% range; addVideoToJob uses the cam's nominal band so
 * the SyncProgressPanel keeps showing it correctly.
 *
 * `studioPcm` is required when matching; pass `null` when `skipSync` is
 * true to indicate the master audio doesn't need decoding.
 *
 * Frame extraction always runs — the timeline lane needs thumbnails even
 * for B-roll cams the user opted out of matching.
 */
async function runCamPrep(
  jobId: string,
  cam: VideoAsset,
  studioPcm: Float32Array | null,
  opts: {
    skipSync?: boolean;
    mapPct: (frac: number) => number;
  },
): Promise<VideoAsset> {
  const videoFile = await opfs.readFile(cam.opfsPath);

  // SYNC stage — only if matching is requested.
  let sync: SyncResult | undefined;
  if (!opts.skipSync) {
    if (!studioPcm) {
      throw new Error(`runCamPrep: studioPcm is required when skipSync is false`);
    }
    await reportProgress(jobId, {
      pct: opts.mapPct(0),
      stage: `syncing-${cam.id}`,
      detail: `${cam.id} · ${cam.filename}`,
    });

    const videoMonoPcm = await decodeAudioToMonoPcm(videoFile, 22050);
    await reportProgress(jobId, {
      pct: opts.mapPct(0.4),
      stage: `syncing-${cam.id}`,
      detail: `${cam.id} · ${cam.filename}`,
    });

    const result = await syncAudio({
      refSource: videoMonoPcm.pcm,
      querySource: studioPcm,
    });
    sync = {
      offsetMs: result.offsetMs,
      driftRatio: result.driftRatio,
      confidence: result.confidence,
      warning: result.warning ?? undefined,
      candidates: result.candidates,
    };
  }

  // Probe video for duration / dimensions. Best-effort; missing fields
  // surface as undefined and the editor falls back to defaults.
  let durationS: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const { demuxVideoTrack } = await import("./codec/webcodecs/demux");
    const v = await demuxVideoTrack(videoFile);
    if (v) {
      durationS = v.info.durationS;
      width = v.info.width;
      height = v.info.height;
    }
  } catch {
    // ignore — nice-to-have
  }

  // Per-cam thumbnail strip. Always runs (B-roll lanes need thumbnails too).
  // Failure is non-blocking.
  let framesPath: string | undefined;
  await reportProgress(jobId, {
    pct: opts.mapPct(0.6),
    stage: `frames-${cam.id}`,
    detail: `${cam.id} · ${cam.filename}`,
  });
  try {
    const r = await extractTimelineFrames(videoFile, {
      onProgress: (frac) => {
        void reportProgress(jobId, {
          pct: opts.mapPct(0.6 + frac * 0.4),
          stage: `frames-${cam.id}`,
          detail: `${cam.id} · ${cam.filename}`,
        });
      },
    });
    framesPath = camFramesPath(jobId, cam.id);
    await opfs.writeFile(framesPath, r.blob);
  } catch (err) {
    console.warn(`Frame strip extraction failed for ${jobId}/${cam.id}:`, err);
  }

  return {
    ...cam,
    sync,
    durationS,
    width,
    height,
    framesPath,
  };
}

async function runSync(jobId: string, audioExt: string): Promise<void> {
  await reportProgress(jobId, { pct: 2, stage: "loading" }, "syncing");

  const job = await jobsDb.getJob(jobId);
  if (!job?.videos?.length) {
    throw new Error(`Job ${jobId} has no videos to sync`);
  }
  // runSync only runs at upload time, when videos[] is exclusively
  // VideoAssets (createJob never appends images). Filter defensively in
  // case a future caller sneaks images in — they don't get prep here.
  const videos = job.videos.filter(isVideoAsset);
  if (videos.length === 0) {
    throw new Error(`Job ${jobId}: no video cams to sync`);
  }

  // Decode the master studio audio once; every cam syncs against this.
  const audioFile = await opfs.readFile(audioPath(jobId, audioExt));
  await reportProgress(jobId, { pct: 5, stage: "decoding-studio-audio" });
  const studioMonoPcm = await decodeAudioToMonoPcm(audioFile, 22050);

  const updatedVideos: VideoAsset[] = [];
  // Each cam gets an equal slice of the 5-95% progress band.
  const bandPerCam = 90 / videos.length;

  for (let i = 0; i < videos.length; i++) {
    const cam = videos[i];
    const camStartPct = 5 + i * bandPerCam;
    const updated = await runCamPrep(jobId, cam, studioMonoPcm.pcm, {
      mapPct: (frac) =>
        Math.min(95, Math.floor(camStartPct + frac * bandPerCam)),
    });
    updatedVideos.push(updated);
  }

  // Mirror cam-1's stats to the legacy top-level fields so consumers that
  // haven't moved to videos[] yet still see something sensible.
  const lead = updatedVideos[0];
  const synced = await jobsDb.updateJob(jobId, {
    videos: updatedVideos,
    sync: lead.sync,
    durationS: lead.durationS,
    width: lead.width,
    height: lead.height,
    hasFrames: !!lead.framesPath,
    progress: { pct: 95, stage: "analyzing-audio" },
  });
  emitJobUpdate(synced);

  // Audio-Analyse-Phase: Spectral-Flux Onsets, Tempo, Beats. Cached per job
  // in IDB so the editor can read it without recomputing. Failure is
  // non-blocking — the sync result is the critical artifact, the analysis
  // is value-add.
  try {
    await getOrComputeAnalysis(jobId, studioMonoPcm.pcm, studioMonoPcm.sampleRate);
  } catch (err) {
    console.warn(`Audio analysis failed for ${jobId} (non-fatal):`, err);
  }

  const updated = await jobsDb.updateJob(jobId, {
    status: "synced",
    progress: { pct: 100, stage: "synced" },
    finishedAt: Date.now(),
  });
  emitJobUpdate(updated);
}

// -----------------------------------------------------------------------------
// addVideoToJob — append a cam to an existing project (editor "+ Media")
// -----------------------------------------------------------------------------

export interface AddVideoOptions {
  /** Skip the audio-match stage. The cam still gets dimensions probed and
   *  thumbnails extracted, but `sync` and `candidates` stay undefined.
   *  Used for B-roll the user wants to place by hand. */
  skipSync?: boolean;
}

/**
 * Append a video to an existing job and run the per-cam preparation in the
 * background. Returns the new cam id immediately so callers can update UI
 * (e.g. spin up an empty lane). The cam is persisted with `sync` and
 * `framesPath` undefined; both fill in via `jobsDb.updateJob` events as
 * the prep progresses.
 *
 * Errors during prep are logged but don't fail the job — the new cam stays
 * in videos[] without sync/frames so the user can retry or remove it.
 */
export async function addVideoToJob(
  jobId: string,
  file: File,
  opts: AddVideoOptions = {},
): Promise<string> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const existing = job.videos ?? [];
  const newCam = await persistVideoCam(jobId, file, existing.length);
  const camId = newCam.id;

  // Probe dimensions BEFORE the first persist so the editor lane appears
  // with its real duration immediately — without this the lane would be
  // a zero-width invisible sliver until runCamPrep finishes seconds later.
  try {
    const { demuxVideoTrack } = await import("./codec/webcodecs/demux");
    const v = await demuxVideoTrack(file);
    if (v) {
      newCam.durationS = v.info.durationS;
      newCam.width = v.info.width;
      newCam.height = v.info.height;
    }
  } catch {
    // ignore — runCamPrep will probe again as a fallback
  }

  // Append immediately (sync still undefined) so editor lane appears now.
  const next = [...existing, newCam];
  const saved = await jobsDb.updateJob(jobId, { videos: next });
  emitJobUpdate(saved);

  // Run cam-prep in the background. Don't block the caller — the editor
  // subscribes to jobEvents to know when the cam is ready.
  void (async () => {
    try {
      // Studio PCM only needed when actually matching.
      let studioPcm: Float32Array | null = null;
      if (!opts.skipSync) {
        const audioExt = fileExtension(
          { name: job.audioFilename } as File,
          "wav",
        );
        const audioFile = await opfs.readFile(audioPath(jobId, audioExt));
        const decoded = await decodeAudioToMonoPcm(audioFile, 22050);
        studioPcm = decoded.pcm;
      }

      // Project this cam onto the multi-cam progress panel: it sits at the
      // very end of videos[] now, so its band mirrors what runSync would
      // have used for an N-cam batch.
      const totalCams = next.length;
      const bandPerCam = 90 / totalCams;
      const camStartPct = 5 + (totalCams - 1) * bandPerCam;

      const prepared = await runCamPrep(jobId, newCam, studioPcm, {
        skipSync: opts.skipSync,
        mapPct: (frac) =>
          Math.min(95, Math.floor(camStartPct + frac * bandPerCam)),
      });

      // Re-read videos[] before writing — user may have added more cams in
      // the meantime, or the editor may have edited per-cam state.
      const cur = await jobsDb.getJob(jobId);
      if (!cur) return;
      const updated = (cur.videos ?? []).map((v) =>
        v.id === camId ? { ...v, ...prepared } : v,
      );
      const final = await jobsDb.updateJob(jobId, { videos: updated });
      emitJobUpdate(final);
    } catch (err) {
      console.error(
        `addVideoToJob: cam-prep failed for ${jobId}/${camId}:`,
        err,
      );
      // The cam stays in videos[] without sync/frames; UI surface it as
      // "not synced" — user can remove or retry.
    }
  })();

  return camId;
}

// -----------------------------------------------------------------------------
// addImageToJob — append a still-image clip to an existing project
// -----------------------------------------------------------------------------

export interface AddImageOptions {
  /** Initial duration on the master timeline (seconds). User can resize
   *  via the lane handle later. */
  durationS?: number;
}

const DEFAULT_IMAGE_DURATION_S = 5;

/**
 * Append an image asset to an existing job. Images don't have audio, sync
 * candidates, or thumbnail strips — only a user-set duration and a free
 * placement offset. Probing dimensions runs synchronously here (it's
 * cheap for an image: decode → naturalWidth/Height) so the lane gets
 * its aspect ratio without a background pass.
 */
export async function addImageToJob(
  jobId: string,
  file: File,
  opts: AddImageOptions = {},
): Promise<string> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const existing = job.videos ?? [];
  const durationS = opts.durationS ?? DEFAULT_IMAGE_DURATION_S;
  const newAsset = await persistImageCam(
    jobId,
    file,
    existing.length,
    durationS,
  );

  const next = [...existing, newAsset];
  const saved = await jobsDb.updateJob(jobId, { videos: next });
  emitJobUpdate(saved);

  return newAsset.id;
}

interface QuickRenderInput {
  /** User offset override added on top of the algorithm's offsetMs. */
  offsetOverrideMs?: number;
}

export async function runQuickRender(
  jobId: string,
  opts: QuickRenderInput = {},
): Promise<void> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.sync) throw new Error("Cannot render before sync completes.");

  installRenderUnloadGuard(jobId);
  try {
    await reportProgress(jobId, { pct: 5, stage: "render-prep" }, "rendering");

    // V1 limitation (same as runEditRender): renders cam-1 only.
    const cam1Path = job.videos?.[0]?.opfsPath;
    if (!cam1Path) throw new Error("No video found for this job.");
    const audioExt = fileExtension(new File([], job.audioFilename), "wav");
    const videoFile = await opfs.readFile(cam1Path);
    const audioFile = await opfs.readFile(audioPath(jobId, audioExt));

    await reportProgress(jobId, { pct: 15, stage: "encoding" });
    const totalOffsetMs = job.sync.offsetMs + (opts.offsetOverrideMs ?? 0);
    const result = await quickRender({
      videoFile,
      audioFile,
      offsetMs: totalOffsetMs,
      driftRatio: job.sync.driftRatio,
    });

    await reportProgress(jobId, { pct: 90, stage: "writing" });
    await opfs.writeFile(outputPath(jobId), result.output);

    const updated = await jobsDb.updateJob(jobId, {
      status: "rendered",
      hasOutput: true,
      outputBytes: result.output.byteLength,
      progress: { pct: 100, stage: "rendered" },
      finishedAt: Date.now(),
    });
    emitJobUpdate(updated);
  } catch (err) {
    // Crucial: without this the job stays stuck in "rendering" status
    // forever and the JobPage shows no recovery actions.
    await markFailed(jobId, err);
    throw err;
  } finally {
    removeRenderUnloadGuard(jobId);
  }
}

export interface EditSpecLocal {
  segments: Segment[];
  overlays: TextOverlay[];
  offsetOverrideMs?: number;
  /**
   * Subset of visualizers to add — built lazily inside runEditRender from
   * the audio PCM + energy curves. The UI sends a small descriptor; we
   * expand it here.
   */
  visualizers?: VisualizerDescriptor[];
  /** Resolved encoder/output options. Built by the editor's submit handler
   *  from the user's `ExportSpec` (UI layer) — this stays raw kbps/codec so
   *  the worker doesn't need to know about presets. */
  exportOpts?: ExportRenderOpts;
  /** Output filename (without extension). Used purely for download UX. */
  outputFilename?: string;
  /** Per-cam render-time overrides built from the editor's clips slice. */
  clipOverrides?: Array<{
    id: string;
    syncOverrideMs: number;
    startOffsetS: number;
    rotation?: number;
    flipX?: boolean;
    flipY?: boolean;
    viewportTransform?: import("../editor/types").ViewportTransform;
  }>;
  /** Master-audio playback gain. 1.0 = source level. Picked up at render
   *  start from the store's `audioVolume`. Optional / undefined → 1.0. */
  audioVolume?: number;
  /** Multi-cam cuts — drives the multi-source frame loop. */
  cuts?: Array<{ atTimeS: number; camId: string }>;
}

export interface ExportRenderOpts {
  width?: number;
  height?: number;
  videoCodec: "h264" | "h265";
  audioCodec: "aac" | "opus";
  videoBitrateBps: number;
  audioBitrateBps: number;
}

export type VisualizerDescriptor =
  | { type: "showwaves" }
  | { type: "showfreqs" };

/**
 * Tracks renders that are currently running so cancelEditRender can
 * terminate the underlying worker. One entry per active job; renders
 * for different jobs run concurrently with their own workers.
 */
const activeRenders = new Map<string, Worker>();

/**
 * Start the edit-render. Returns a promise that resolves when the worker
 * reports `done` or rejects on `error`. The caller is free to ignore the
 * promise — the function emits jobEvents along the way, so the UI can
 * subscribe through that channel instead.
 *
 * Cancel by calling `cancelEditRender(jobId)`.
 */
export async function runEditRender(
  jobId: string,
  spec: EditSpecLocal,
): Promise<void> {
  const job = await jobsDb.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.sync) throw new Error("Cannot render before sync completes.");
  if (activeRenders.has(jobId)) {
    throw new Error("Render already in progress for this job.");
  }

  installRenderUnloadGuard(jobId);
  let workerOwned: Worker | null = null;
  try {
    await reportProgress(jobId, { pct: 5, stage: "render-prep" }, "rendering");

    const videos = job.videos ?? [];
    if (videos.length === 0) throw new Error("No video found for this job.");
    const audioExt = fileExtension(new File([], job.audioFilename), "wav");
    const audioFile = await opfs.readFile(audioPath(jobId, audioExt));

    // Audio decode + energy curves run on the main thread because
    // AudioContext.decodeAudioData isn't available in workers. Both are
    // fast (a few seconds for a 3-min file) and the produced Float32Arrays
    // are transferred zero-copy into the worker.
    await reportProgress(jobId, { pct: 10, stage: "audio-decode" });
    const audio = await decodeStudioAudioInterleaved(audioFile);
    // Bake the master-audio volume into the PCM in-place. Skipped when
    // unity (1.0 / undefined) so the common path stays a pure decode.
    const audioVolumeRaw = spec.audioVolume;
    const audioVolume =
      typeof audioVolumeRaw === "number" && audioVolumeRaw >= 0
        ? Math.min(4, audioVolumeRaw)
        : 1;
    if (audioVolume !== 1) {
      const pcm = audio.pcm;
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] *= audioVolume;
      }
    }

    let monoPcm: Float32Array | null = null;
    let energy: ReturnType<typeof computeEnergyCurves> | null = null;
    const needsPcm =
      (spec.visualizers && spec.visualizers.length > 0) ||
      spec.overlays.some((o) => o.reactiveBand);
    if (needsPcm) {
      await reportProgress(jobId, { pct: 18, stage: "energy-curves" });
      const decoded = await decodeAudioToMonoPcm(audioFile, 22050);
      monoPcm = decoded.pcm;
      energy = computeEnergyCurves(monoPcm, 22050, 30);
    }

    const visualizerDescs: VisualizerWorkerDescriptor[] = [];
    if (spec.visualizers && monoPcm && energy) {
      for (const desc of spec.visualizers) {
        if (desc.type === "showwaves") {
          visualizerDescs.push({ type: "showwaves", pcm: monoPcm, sampleRate: 22050 });
        } else if (desc.type === "showfreqs") {
          visualizerDescs.push({ type: "showfreqs", energy });
        }
      }
    }

    await reportProgress(jobId, { pct: 25, stage: "encoding" });
    // Audio offset is anchored to cam-1 (the master clock cam), same sign
    // convention as the legacy single-cam pipeline.
    const totalOffsetMs = job.sync.offsetMs + (spec.offsetOverrideMs ?? 0);

    // Build the per-cam descriptors. Each cam's master-timeline start
    // position is derived from its own sync algorithm + the editor's
    // syncOverrideMs + startOffsetS; mirrors `clipRangeS()` on the editor
    // side so what the user previewed is what gets rendered.
    const overridesById = new Map(
      (spec.clipOverrides ?? []).map((o) => [o.id, o] as const),
    );
    const camInputs: CamWorkerInput[] = videos.map((v): CamWorkerInput => {
      const ov = overridesById.get(v.id);
      // User transform: prefer the latest from the editor's overrides
      // (covers in-flight tweaks before auto-persist debounces) and fall
      // back to whatever sits on the persisted asset row.
      const rotation = ov?.rotation ?? v.rotation ?? 0;
      const flipX = ov?.flipX ?? v.flipX ?? false;
      const flipY = ov?.flipY ?? v.flipY ?? false;
      const viewportTransform = ov?.viewportTransform;
      if (isImageAsset(v)) {
        // Image cams have no sync offset and no drift — masterStartS is
        // the user-set placement, sourceDurationS is the user-set length.
        const startOffsetS = ov?.startOffsetS ?? v.startOffsetS ?? 0;
        return {
          id: v.id,
          opfsPath: v.opfsPath,
          masterStartS: startOffsetS,
          sourceDurationS: v.durationS,
          driftRatio: 1,
          kind: "image",
          rotation,
          flipX,
          flipY,
          viewportTransform,
        };
      }
      const algoMs = v.sync?.offsetMs ?? 0;
      const userMs = ov?.syncOverrideMs ?? 0;
      const startOffsetS = ov?.startOffsetS ?? 0;
      const masterStartS = -(algoMs + userMs) / 1000 + startOffsetS;
      // Per-clip trim: the cam still plays from source-time 0 onward
      // (masterStartS unchanged), but we narrow its "available" master-
      // timeline range to [trimInS, trimOutS]. activeCamAt + the
      // editor's clipRangeS use this same window to pick the active
      // cam, so cuts stay consistent between editor and render.
      const sourceDurationS = v.durationS ?? 0;
      const trimInS = Math.max(0, v.trimInS ?? 0);
      const trimOutS = Math.max(
        trimInS + 0.05,
        Math.min(sourceDurationS, v.trimOutS ?? sourceDurationS),
      );
      return {
        id: v.id,
        opfsPath: v.opfsPath,
        masterStartS,
        sourceDurationS,
        driftRatio: v.sync?.driftRatio ?? 1,
        trimInS,
        trimOutS,
        rotation,
        flipX,
        flipY,
        viewportTransform,
      };
    });

    const cuts = spec.cuts ?? [];
    const masterDurationS = Math.max(
      ...camInputs.map((c) => c.masterStartS + c.sourceDurationS),
      0,
    );

    const workerInput: EditWorkerInput = {
      cams: camInputs,
      cuts,
      masterDurationS,
      outputPath: outputPath(jobId),
      audioPcm: audio,
      segments: spec.segments,
      overlays: spec.overlays,
      visualizers: visualizerDescs,
      energy,
      fx: job.fx,
      offsetMs: totalOffsetMs,
      driftRatio: job.sync.driftRatio,
      outputWidth: spec.exportOpts?.width,
      outputHeight: spec.exportOpts?.height,
      videoCodec: spec.exportOpts?.videoCodec,
      audioCodec: spec.exportOpts?.audioCodec,
      videoBitrateBps: spec.exportOpts?.videoBitrateBps,
      audioBitrateBps: spec.exportOpts?.audioBitrateBps,
    };

    // Collect transferables: every Float32Array buffer we hand to the
    // worker is detached on the main side, freeing memory immediately.
    const transferables: Transferable[] = [audio.pcm.buffer];
    for (const d of visualizerDescs) {
      if (d.type === "showwaves") transferables.push(d.pcm.buffer);
    }

    const worker = new Worker(new URL("./render/edit.worker.ts", import.meta.url), {
      type: "module",
    });
    workerOwned = worker;
    activeRenders.set(jobId, worker);

    let lastDispatchedPct = 25;
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener("message", (e: MessageEvent<EditWorkerEvent>) => {
        const msg = e.data;
        if (msg.type === "progress") {
          const p = msg.progress;
          // Map worker stages to UI percentages so the bar doesn't sit at
          // 89 % while the encoder flushes + the muxer writes 90 s of
          // frames to OPFS — a 2–10 s "silent" stretch on a typical
          // export that left the user wondering if anything was happening.
          if (p.stage === "video-encode" && p.framesTotal > 0) {
            const pct = 25 + Math.floor((p.framesDone / p.framesTotal) * 60);
            if (pct === lastDispatchedPct) return;
            lastDispatchedPct = pct;
            void reportProgress(jobId, {
              pct: Math.min(85, pct),
              stage: "encoding",
              framesDone: p.framesDone,
              framesTotal: p.framesTotal,
            });
          } else if (p.stage === "encoder-flush") {
            if (lastDispatchedPct === 87) return;
            lastDispatchedPct = 87;
            void reportProgress(jobId, { pct: 87, stage: "encoder-flush" });
          } else if (p.stage === "muxing" && p.framesTotal > 0) {
            // Streaming-mux: chunks-written / total-chunks scaled into 88-94 %.
            const pct = 88 + Math.floor((p.framesDone / p.framesTotal) * 6);
            if (pct === lastDispatchedPct) return;
            lastDispatchedPct = pct;
            void reportProgress(jobId, {
              pct: Math.min(94, pct),
              stage: "muxing",
              framesDone: p.framesDone,
              framesTotal: p.framesTotal,
            });
          } else if (p.stage === "muxing") {
            // Fallback for the initial muxing event before chunk progress.
            if (lastDispatchedPct === 88) return;
            lastDispatchedPct = 88;
            void reportProgress(jobId, { pct: 88, stage: "muxing" });
          } else if (p.stage === "finalizing") {
            if (lastDispatchedPct === 95) return;
            lastDispatchedPct = 95;
            void reportProgress(jobId, { pct: 95, stage: "finalizing" });
          } else if (p.stage === "audio-encode") {
            if (lastDispatchedPct === 18) return;
            lastDispatchedPct = 18;
            void reportProgress(jobId, { pct: 18, stage: "audio-encode" });
          }
        } else if (msg.type === "done") {
          resolve();
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      });
      worker.addEventListener("error", (e) => {
        reject(new Error(e.message || "Render worker crashed"));
      });
      const startMsg: EditWorkerMessage = { type: "start", input: workerInput };
      worker.postMessage(startMsg, transferables);
    });

    await reportProgress(jobId, { pct: 95, stage: "writing" });
    const outputFile = await opfs.readFile(outputPath(jobId));
    const outputBytes = outputFile.size;

    const updated = await jobsDb.updateJob(jobId, {
      status: "rendered",
      hasOutput: true,
      outputBytes,
      progress: { pct: 100, stage: "rendered" },
      finishedAt: Date.now(),
      editSpec: spec,
    });
    emitJobUpdate(updated);
  } catch (err) {
    await markFailed(jobId, err);
    throw err;
  } finally {
    if (workerOwned) {
      workerOwned.terminate();
      activeRenders.delete(jobId);
    }
    removeRenderUnloadGuard(jobId);
  }
}

/**
 * Cancel an in-progress edit render. Hard-terminates the worker, deletes
 * the partial OPFS output, and marks the job as failed with a "cancelled"
 * sentinel so the UI can distinguish it from a real failure.
 *
 * Safe to call when no render is active for the given job — it's a no-op.
 */
export async function cancelEditRender(jobId: string): Promise<void> {
  const worker = activeRenders.get(jobId);
  if (!worker) return;
  worker.terminate();
  activeRenders.delete(jobId);
  // Remove the half-written output file so a future render isn't fooled
  // by leftovers. Best-effort — the file may not exist yet.
  await opfs.deleteFile(outputPath(jobId)).catch(() => undefined);
  try {
    const updated = await jobsDb.updateJob(jobId, {
      status: "failed",
      error: "cancelled",
      progress: { pct: 100, stage: "cancelled" },
      finishedAt: Date.now(),
    });
    emitJobUpdate(updated);
  } catch {
    // ignore — job may have been deleted already
  }
  removeRenderUnloadGuard(jobId);
}

/**
 * Resolve OPFS-backed object URLs for the editor / preview UI. Caller is
 * responsible for `URL.revokeObjectURL` when finished.
 *
 * For multi-cam jobs, `kind: "video"` and `kind: "frames"` always return
 * cam-1's asset (the legacy "the video" of a job). Multi-cam consumers
 * should resolve other cams via `resolveCamAssetUrl(jobId, camId, kind)`.
 */
export async function resolveJobAssetUrl(
  jobId: string,
  kind: "video" | "audio" | "output" | "frames",
): Promise<string | null> {
  if (kind === "output") {
    const exists = await opfs.exists(outputPath(jobId));
    if (!exists) return null;
    return opfs.objectUrl(outputPath(jobId));
  }
  const job = await jobsDb.getJob(jobId);
  if (!job) return null;

  if (kind === "frames") {
    const cam0 = job.videos?.[0];
    const cam0Frames =
      cam0 && isVideoAsset(cam0) ? cam0.framesPath : undefined;
    const path = cam0Frames ?? `jobs/${jobId}/frames.webp`;
    if (!(await opfs.exists(path))) return null;
    return opfs.objectUrl(path);
  }
  if (kind === "video") {
    const path = job.videos?.[0]?.opfsPath;
    if (!path) return null;
    if (!(await opfs.exists(path))) return null;
    return opfs.objectUrl(path);
  }
  // audio
  const ext = fileExtension(new File([], job.audioFilename), "wav");
  const path = audioPath(jobId, ext);
  if (!(await opfs.exists(path))) return null;
  return opfs.objectUrl(path);
}

/** Resolve the OPFS object URL for a specific cam's video or frames asset. */
export async function resolveCamAssetUrl(
  jobId: string,
  camId: string,
  kind: "video" | "frames",
): Promise<string | null> {
  const job = await jobsDb.getJob(jobId);
  if (!job?.videos) return null;
  const cam = job.videos.find((v) => v.id === camId);
  if (!cam) return null;
  // For "video" kind, return the asset's URL — works for both video and
  // image cams (browsers serve any blob URL to <video src> or <img src>
  // appropriately based on MIME). For "frames", only video assets have a
  // thumbnail strip; image assets return null (the caller falls back to
  // showing the image directly in the lane).
  let path: string | undefined;
  if (kind === "video") {
    path = cam.opfsPath;
  } else if (isVideoAsset(cam)) {
    path = cam.framesPath;
  }
  if (!path) return null;
  if (!(await opfs.exists(path))) return null;
  return opfs.objectUrl(path);
}

export async function deleteJob(jobId: string): Promise<void> {
  await opfs.deletePath(`jobs/${jobId}`);
  await jobsDb.deleteJob(jobId);
}

/**
 * Remove a single cam from an existing job. Cleans up the cam's video
 * file and its frame-strip in OPFS, prunes any cuts that referenced it,
 * and writes the slimmed videos[] back to IDB. Idempotent — unknown
 * camIds are a silent no-op.
 *
 * Note: cam ids stay stable for cams that *remain* (no renumbering).
 * That keeps existing cuts / overrides / persisted state valid.
 */
export async function removeCamFromJob(
  jobId: string,
  camId: string,
): Promise<void> {
  const job = await jobsDb.getJob(jobId);
  if (!job?.videos) return;
  const cam = job.videos.find((v) => v.id === camId);
  if (!cam) return;

  // Best-effort OPFS cleanup. Ignore not-found errors so a partially-
  // prepped cam (frames still missing) deletes cleanly.
  try {
    await opfs.deletePath(cam.opfsPath);
  } catch {
    // ignore
  }
  if (isVideoAsset(cam) && cam.framesPath) {
    try {
      await opfs.deletePath(cam.framesPath);
    } catch {
      // ignore
    }
  }

  const nextVideos = job.videos.filter((v) => v.id !== camId);
  const nextCuts = (job.cuts ?? []).filter((c) => c.camId !== camId);
  const updated = await jobsDb.updateJob(jobId, {
    videos: nextVideos,
    cuts: nextCuts,
  });
  emitJobUpdate(updated);
}

export { jobsDb };
export type { LocalJob, SyncResult, JobProgress, Segment, TextOverlay };
