/**
 * On-demand chunk-thumbnail extractor.
 *
 * The Triage / Sync pre-pipeline doesn't always produce frames for
 * every chunk — the global frame-strip is sampled at a fixed cadence
 * (~5–10 s spacing), so a 4-bar chunk that's 2 s long may have zero
 * dedicated thumbs and just inherits a smear from a neighbouring tile.
 * For Arrange's Polaroid contact-sheet we want a real, recognisable
 * still per `(camId, chunkId)` pair — so we lazily extract one when a
 * Polaroid first becomes visible and cache the result.
 *
 * Mechanics:
 *   - One hidden `<video>` per (jobId, camId), allocated on demand,
 *     reused for every thumbnail request for that cam.
 *   - Requests queue per-cam; seeks are serial (HTMLVideoElement
 *     decoder is single-cursor).
 *   - A request resolves to a `blob:` URL pointing at a 200-px-wide
 *     JPEG snapshot of the chunk's mid-frame, converted from
 *     master-time → cam-source-time via the cam's sync offset.
 *   - LRU-cap of 200 thumbs per process; blob URLs are revoked on
 *     evict so memory stays bounded for very long sessions.
 */
import { resolveCamAssetUrl } from "../jobs";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";

const THUMB_WIDTH = 200;
const MAX_CACHE = 200;

interface ThumbCacheEntry {
  url: string;
  /** Bumped each get — drives eviction order. */
  lastAccessedTick: number;
}

let accessTick = 0;
const cache = new Map<string, ThumbCacheEntry>();

function cacheKey(jobId: string, camId: string, chunkId: string): string {
  return `${jobId}::${camId}::${chunkId}`;
}

function recordAccess(key: string, entry: ThumbCacheEntry) {
  accessTick += 1;
  entry.lastAccessedTick = accessTick;
  cache.set(key, entry);
}

function evictIfFull() {
  if (cache.size <= MAX_CACHE) return;
  // Find the oldest accessed entry. Map iteration is insertion order;
  // fine for an LRU if we always re-insert on access.
  let oldestKey: string | null = null;
  let oldestTick = Infinity;
  for (const [k, v] of cache) {
    if (v.lastAccessedTick < oldestTick) {
      oldestKey = k;
      oldestTick = v.lastAccessedTick;
    }
  }
  if (oldestKey) {
    const entry = cache.get(oldestKey);
    if (entry) URL.revokeObjectURL(entry.url);
    cache.delete(oldestKey);
  }
}

interface CamPipeline {
  /** Hidden video element used for seek-and-grab. */
  video: HTMLVideoElement;
  /** Object URL of the cam's source. Revoked when the pipeline is
   *  released. */
  srcUrl: string;
  /** Promise chain — every new request awaits the previous one so the
   *  decoder cursor isn't yanked mid-seek. */
  queue: Promise<unknown>;
  /** Strong references prevent GC while requests are pending. */
  refCount: number;
  /** Total + per-cam sync offset in seconds. master-time + this =
   *  cam-source-time. (Note negation in resolveSourceTimeS — sync.offsetMs
   *  is the master-delay relative to the cam, so cam-source-time =
   *  master-time - offset/1000). */
  syncOffsetMs: number;
}

const pipelines = new Map<string, CamPipeline>();

function pipelineKey(jobId: string, camId: string): string {
  return `${jobId}::${camId}`;
}

async function getOrCreatePipeline(
  jobId: string,
  cam: VideoAsset,
): Promise<CamPipeline | null> {
  const key = pipelineKey(jobId, cam.id);
  const existing = pipelines.get(key);
  if (existing) {
    existing.refCount += 1;
    // Keep sync offset in sync — user nudges might have changed.
    existing.syncOffsetMs =
      (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0);
    return existing;
  }
  const url = await resolveCamAssetUrl(jobId, cam.id, "video");
  if (!url) return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;
  // Wait for metadata before declaring the pipeline ready — seeks
  // before metadata reject silently in some browsers.
  await new Promise<void>((resolve, reject) => {
    function ok() {
      cleanup();
      resolve();
    }
    function fail(e: Event) {
      cleanup();
      reject(new Error("video metadata load failed"));
      void e;
    }
    function cleanup() {
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", fail);
    }
    video.addEventListener("loadedmetadata", ok, { once: true });
    video.addEventListener("error", fail, { once: true });
    if (video.readyState >= 1) ok();
  });
  const pipeline: CamPipeline = {
    video,
    srcUrl: url,
    queue: Promise.resolve(),
    refCount: 1,
    syncOffsetMs: (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0),
  };
  pipelines.set(key, pipeline);
  return pipeline;
}

/** Drop a pipeline reference; tear down the underlying video when no
 *  one wants it any more. */
function releasePipeline(jobId: string, camId: string) {
  const key = pipelineKey(jobId, camId);
  const p = pipelines.get(key);
  if (!p) return;
  p.refCount -= 1;
  if (p.refCount > 0) return;
  // Defer teardown a tick so a re-mount in StrictMode doesn't kill it.
  setTimeout(() => {
    const p2 = pipelines.get(key);
    if (!p2 || p2.refCount > 0) return;
    URL.revokeObjectURL(p2.srcUrl);
    p2.video.removeAttribute("src");
    p2.video.load();
    pipelines.delete(key);
  }, 5_000);
}

function clampMidpoint(chunk: Chunk): number {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  // Take the visual midpoint of the chunk for the most representative
  // frame.
  return startS + (endS - startS) / 2;
}

async function seekAndCapture(
  pipeline: CamPipeline,
  masterTimeS: number,
): Promise<string | null> {
  const sourceTimeS = masterTimeS - pipeline.syncOffsetMs / 1000;
  const v = pipeline.video;
  if (!Number.isFinite(v.duration) || v.duration <= 0) return null;
  // Clamp into the cam's recorded range. Out-of-range = chunk's master
  // time falls outside this cam's footage — return null so the caller
  // shows the empty-Polaroid look.
  if (sourceTimeS < 0 || sourceTimeS > v.duration - 0.05) return null;

  await new Promise<void>((resolve) => {
    function done() {
      v.removeEventListener("seeked", done);
      resolve();
    }
    v.addEventListener("seeked", done);
    try {
      v.currentTime = sourceTimeS;
    } catch {
      v.removeEventListener("seeked", done);
      resolve();
    }
    // Safety timeout — some codecs / files never fire `seeked` for
    // a target near EOF. 1.5 s is generous.
    setTimeout(() => {
      v.removeEventListener("seeked", done);
      resolve();
    }, 1500);
  });

  // Snapshot to a canvas at THUMB_WIDTH-px wide.
  const ratio = v.videoWidth > 0 ? v.videoHeight / v.videoWidth : 9 / 16;
  const w = THUMB_WIDTH;
  const h = Math.round(w * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(v, 0, 0, w, h);
  } catch {
    return null;
  }

  return await new Promise<string | null>((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        resolve(URL.createObjectURL(blob));
      },
      "image/jpeg",
      0.78,
    );
  });
}

export interface ExtractRequest {
  jobId: string;
  cam: VideoAsset;
  chunk: Chunk;
}

/**
 * Get a thumbnail blob URL for a (cam, chunk) pair, extracting it on
 * demand if not already cached. Returns null when extraction fails
 * (chunk falls outside the cam's recorded range, decoder error, etc.) —
 * callers should display an empty-Polaroid placeholder in that case.
 */
export async function getChunkThumbnailUrl(
  req: ExtractRequest,
): Promise<string | null> {
  const key = cacheKey(req.jobId, req.cam.id, req.chunk.id);
  const cached = cache.get(key);
  if (cached) {
    recordAccess(key, cached);
    return cached.url;
  }

  const pipeline = await getOrCreatePipeline(req.jobId, req.cam).catch(
    () => null,
  );
  if (!pipeline) return null;

  // Serialise via the pipeline's queue — only one seek-and-capture
  // per cam at a time. Must release the pipeline ref after every
  // request even on failure.
  const result = pipeline.queue
    .catch(() => null)
    .then(() => seekAndCapture(pipeline, clampMidpoint(req.chunk)));
  pipeline.queue = result.catch(() => null);

  let url: string | null = null;
  try {
    url = await result;
  } finally {
    releasePipeline(req.jobId, req.cam.id);
  }

  if (url) {
    const entry: ThumbCacheEntry = { url, lastAccessedTick: 0 };
    recordAccess(key, entry);
    evictIfFull();
  }
  return url;
}

/** Drop every cached thumbnail and tear down all pipelines. Called
 *  when the Arrange page unmounts so we don't pin memory. */
export function clearChunkThumbnails(): void {
  for (const entry of cache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  cache.clear();
  for (const [key, p] of pipelines) {
    URL.revokeObjectURL(p.srcUrl);
    p.video.removeAttribute("src");
    p.video.load();
    pipelines.delete(key);
  }
}

/** Unit-test seam: peek into the cache. */
export function _peekCache(): ReadonlyMap<string, ThumbCacheEntry> {
  return cache;
}
