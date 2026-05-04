/**
 * Three-tier chunk-thumbnail resolver for the Arrange page.
 *
 *   1. **IDB cache** — `jobsDb.getChunkThumbnail(jobId, camId, chunkId)`.
 *      Hot path; returns instantly across reloads. Filled by tier 2 + 3.
 *
 *   2. **Pre-extracted strip** — every cam ships a `frames.webp` tile
 *      strip generated at sync time at known centre-of-tile timestamps
 *      (planTileStrip cadence). For chunks whose master-time range
 *      contains at least one tile timestamp, we slice the tile out of
 *      the strip — zero video decode, runs in ~ms.
 *
 *   3. **On-demand video seek** — fallback for short chunks that fall
 *      between tile timestamps (the strip's spacing widens with
 *      duration: 0.5 s for ≤ 60 s sources, 10 s for ≥ 1800 s ones, so
 *      a 2-s chunk in a 1-h session has no overlapping tile). A
 *      hidden `<video>` per cam seeks to the chunk midpoint and
 *      grabs a frame.
 *
 *   In-memory blob-URL cache (LRU 200) sits over the whole stack so
 *   the same URL gets handed back to multiple <img> consumers without
 *   re-reading IDB.
 */
import { jobsDb, isVideoAsset } from "../../storage/jobs-db";
import type { Chunk, VideoAsset } from "../../storage/jobs-db";
import { resolveCamAssetUrl } from "../jobs";
import { planTileStrip } from "../render/frames/strategy";

const THUMB_WIDTH = 200;
const MAX_URL_CACHE = 200;

interface ThumbCacheEntry {
  url: string;
  lastAccessedTick: number;
}

let accessTick = 0;
const urlCache = new Map<string, ThumbCacheEntry>();

function cacheKey(jobId: string, camId: string, chunkId: string): string {
  return `${jobId}::${camId}::${chunkId}`;
}

function recordAccess(key: string, entry: ThumbCacheEntry) {
  accessTick += 1;
  entry.lastAccessedTick = accessTick;
  urlCache.set(key, entry);
}

function evictIfFull() {
  if (urlCache.size <= MAX_URL_CACHE) return;
  let oldestKey: string | null = null;
  let oldestTick = Infinity;
  for (const [k, v] of urlCache) {
    if (v.lastAccessedTick < oldestTick) {
      oldestKey = k;
      oldestTick = v.lastAccessedTick;
    }
  }
  if (oldestKey) {
    const entry = urlCache.get(oldestKey);
    if (entry) URL.revokeObjectURL(entry.url);
    urlCache.delete(oldestKey);
  }
}

// ─── Tier 2: pre-extracted strip ───────────────────────────────────────
//
// Per cam we cache (1) the loaded HTMLImageElement of frames.webp and
// (2) the deterministic tile plan derived from the cam's metadata.
// The plan tells us each tile's centre timestamp + width.

interface StripPlan {
  /** Centre timestamps in cam-source-time (seconds). */
  timestampsS: number[];
  /** Tile width (pixels) inside the strip image. */
  tileWidth: number;
  /** Tile height. */
  tileHeight: number;
}

interface StripBundle {
  image: HTMLImageElement;
  plan: StripPlan;
}

const stripCache = new Map<string, Promise<StripBundle | null>>();

function stripCacheKey(jobId: string, camId: string): string {
  return `${jobId}::${camId}`;
}

async function loadCamStrip(
  jobId: string,
  cam: VideoAsset,
): Promise<StripBundle | null> {
  if (!isVideoAsset(cam) || !cam.framesPath) return null;
  if (cam.durationS === undefined || cam.width === undefined || cam.height === undefined) {
    return null;
  }
  const url = await resolveCamAssetUrl(jobId, cam.id, "frames");
  if (!url) return null;
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (!image) {
    URL.revokeObjectURL(url);
    return null;
  }
  // Plan must mirror what the extractor used at sync time. Derive
  // it from the same inputs (durationS + dims). The default
  // tileHeight (80) and maxTiles (100) are baked into the
  // extractor — the plan won't match if either default changes here.
  const plan = planTileStrip({
    durationS: cam.durationS,
    sourceWidth: cam.width,
    sourceHeight: cam.height,
    tileHeight: 80,
    maxTiles: 100,
  });
  // Sanity check: image width should equal tileCount × tileWidth.
  // If the extractor used different params (older job), bail back to
  // tier 3 rather than slicing wrong frames.
  const expectedW = plan.timestampsS.length * plan.tileWidth;
  if (Math.abs(image.naturalWidth - expectedW) > plan.tileWidth) {
    return null;
  }
  return {
    image,
    plan: {
      timestampsS: plan.timestampsS,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
    },
  };
}

function getOrLoadStrip(
  jobId: string,
  cam: VideoAsset,
): Promise<StripBundle | null> {
  const key = stripCacheKey(jobId, cam.id);
  let p = stripCache.get(key);
  if (!p) {
    p = loadCamStrip(jobId, cam).catch(() => null);
    stripCache.set(key, p);
  }
  return p;
}

/** For a chunk with master-time bounds, find the strip-tile whose
 *  cam-source-time falls inside the chunk. Returns its index or null
 *  when no tile covers this chunk (caller falls back to tier 3). */
function findCoveringTileIdx(
  chunk: Chunk,
  syncOffsetMs: number,
  plan: StripPlan,
): number | null {
  // Convert the chunk's master-time range to cam-source-time. Strip
  // timestamps are cam-source-time.
  const sourceInS = chunk.startMs / 1000 - syncOffsetMs / 1000;
  const sourceOutS = chunk.endMs / 1000 - syncOffsetMs / 1000;
  if (sourceOutS <= 0) return null;
  // Find any tile inside [sourceInS, sourceOutS]. Pick the closest
  // to the midpoint so the visual feels representative.
  const midS = (sourceInS + sourceOutS) / 2;
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < plan.timestampsS.length; i++) {
    const t = plan.timestampsS[i];
    if (t < sourceInS || t > sourceOutS) continue;
    const d = Math.abs(t - midS);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx === -1 ? null : bestIdx;
}

async function sliceTileToBlob(
  bundle: StripBundle,
  tileIdx: number,
): Promise<Blob | null> {
  const { image, plan } = bundle;
  const srcX = tileIdx * plan.tileWidth;
  const w = THUMB_WIDTH;
  const h = Math.round(w * (plan.tileHeight / plan.tileWidth));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(
      image,
      srcX,
      0,
      plan.tileWidth,
      plan.tileHeight,
      0,
      0,
      w,
      h,
    );
  } catch {
    return null;
  }
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.78);
  });
}

// ─── Tier 3: on-demand video seek ──────────────────────────────────────

interface CamPipeline {
  video: HTMLVideoElement;
  srcUrl: string;
  queue: Promise<unknown>;
  refCount: number;
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
  await new Promise<void>((resolve, reject) => {
    function ok() {
      cleanup();
      resolve();
    }
    function fail() {
      cleanup();
      reject(new Error("video metadata load failed"));
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

function releasePipeline(jobId: string, camId: string) {
  const key = pipelineKey(jobId, camId);
  const p = pipelines.get(key);
  if (!p) return;
  p.refCount -= 1;
  if (p.refCount > 0) return;
  setTimeout(() => {
    const p2 = pipelines.get(key);
    if (!p2 || p2.refCount > 0) return;
    URL.revokeObjectURL(p2.srcUrl);
    p2.video.removeAttribute("src");
    p2.video.load();
    pipelines.delete(key);
  }, 5_000);
}

async function seekAndCapture(
  pipeline: CamPipeline,
  masterTimeS: number,
): Promise<Blob | null> {
  const sourceTimeS = masterTimeS - pipeline.syncOffsetMs / 1000;
  const v = pipeline.video;
  if (!Number.isFinite(v.duration) || v.duration <= 0) return null;
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
    setTimeout(() => {
      v.removeEventListener("seeked", done);
      resolve();
    }, 1500);
  });

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

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.78);
  });
}

function clampMidpointMasterS(chunk: Chunk): number {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  return startS + (endS - startS) / 2;
}

// ─── Public API ────────────────────────────────────────────────────────

export interface ExtractRequest {
  jobId: string;
  cam: VideoAsset;
  chunk: Chunk;
}

/**
 * Resolve a thumbnail blob URL for `(cam, chunk)`. Walks the three
 * tiers in order; returns null if every tier fails (e.g. the chunk
 * sits outside the cam's recorded range — show an empty-Polaroid
 * placeholder).
 */
export async function getChunkThumbnailUrl(
  req: ExtractRequest,
): Promise<string | null> {
  const ck = cacheKey(req.jobId, req.cam.id, req.chunk.id);

  // In-memory hit — fastest path.
  const memHit = urlCache.get(ck);
  if (memHit) {
    recordAccess(ck, memHit);
    return memHit.url;
  }

  // Tier 1 — IDB.
  try {
    const cached = await jobsDb.getChunkThumbnail(req.jobId, req.cam.id, req.chunk.id);
    if (cached) {
      const url = URL.createObjectURL(cached);
      const entry: ThumbCacheEntry = { url, lastAccessedTick: 0 };
      recordAccess(ck, entry);
      evictIfFull();
      return url;
    }
  } catch {
    /* IDB issue — fall through to extraction */
  }

  // Tier 2 — strip slice. Most chunks satisfy this for typical
  // session footage (a 4-bar chunk is usually long enough to cover
  // at least one strip tile).
  let blob: Blob | null = null;
  try {
    const bundle = await getOrLoadStrip(req.jobId, req.cam);
    if (bundle) {
      const syncOffsetMs =
        (req.cam.sync?.offsetMs ?? 0) + (req.cam.syncOverrideMs ?? 0);
      const tileIdx = findCoveringTileIdx(req.chunk, syncOffsetMs, bundle.plan);
      if (tileIdx !== null) {
        blob = await sliceTileToBlob(bundle, tileIdx);
      }
    }
  } catch {
    /* fall through */
  }

  // Tier 3 — on-demand seek (slow; only chunks shorter than the strip
  // tile spacing land here).
  if (!blob) {
    const pipeline = await getOrCreatePipeline(req.jobId, req.cam).catch(
      () => null,
    );
    if (pipeline) {
      const result = pipeline.queue
        .catch(() => null)
        .then(() =>
          seekAndCapture(pipeline, clampMidpointMasterS(req.chunk)),
        );
      pipeline.queue = result.catch(() => null);
      try {
        blob = await result;
      } finally {
        releasePipeline(req.jobId, req.cam.id);
      }
    }
  }

  if (!blob) return null;

  // Persist to IDB so the next page-load gets an instant tier-1 hit.
  // Best-effort — a write failure (quota, schema mismatch) just means
  // the next reload re-extracts; no functional impact.
  void jobsDb
    .saveChunkThumbnail(req.jobId, req.cam.id, req.chunk.id, blob)
    .catch(() => undefined);

  const url = URL.createObjectURL(blob);
  const entry: ThumbCacheEntry = { url, lastAccessedTick: 0 };
  recordAccess(ck, entry);
  evictIfFull();
  return url;
}

/** Drop every in-memory blob-URL + tear down all pipelines. Called
 *  when the Arrange page unmounts so we don't pin memory. The IDB
 *  cache stays intact across mounts. */
export function clearChunkThumbnails(): void {
  for (const entry of urlCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  urlCache.clear();
  for (const [key, p] of pipelines) {
    URL.revokeObjectURL(p.srcUrl);
    p.video.removeAttribute("src");
    p.video.load();
    pipelines.delete(key);
  }
  // Strip image cache cleared too — frames.webp object URLs get
  // revoked when their last <img> reference goes away.
  stripCache.clear();
}

/** Unit-test seam: peek into the in-memory URL cache. */
export function _peekCache(): ReadonlyMap<string, ThumbCacheEntry> {
  return urlCache;
}
