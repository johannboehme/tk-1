/**
 * Three-tier chunk-thumbnail resolver for the Arrange page.
 *
 *   1. **IDB cache** — `jobsDb.getChunkThumbnail(jobId, camId, chunkId)`.
 *      Hot path; returns instantly across reloads.
 *
 *   2. **Pre-extracted strip** — every cam ships a `frames.webp` tile
 *      strip generated at sync time at known centre-of-tile timestamps
 *      (planTileStrip cadence). For chunks whose master-time range
 *      contains at least one tile timestamp, we slice the tile out of
 *      the strip — zero video decode, runs in ~ms.
 *
 *   3. **On-demand video seek** — fallback for short chunks that fall
 *      between tile timestamps. A hidden `<video>` per cam seeks to
 *      the chunk midpoint and grabs a frame.
 *
 * Rotation handling: the strip is decoded from the codec-level pixel
 * buffer (no rotation applied), so portrait phone recordings end up
 * sideways in the strip. We probe the cam's intrinsic rotation by
 * comparing stored dims (`cam.width/height`) to display dims
 * (`videoElement.videoWidth/Height`, which the browser auto-rotates)
 * and apply the missing rotation when slicing the strip. The on-demand
 * tier draws the `<video>` element directly so rotation already came
 * for free.
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

// ─── Per-cam probe: rotation + display dims + a reusable <video> ───────
//
// Both tier 2 (rotation when slicing strip) and tier 3 (the actual
// seek-and-capture) need a `<video>` element loaded from the cam asset.
// We share one element per cam — created lazily on first use — and
// release it when the page unmounts. Detected rotation gets handed to
// the strip slicer.

interface CamProbe {
  /** Hidden video element. Used by tier 3 for seek+grab. */
  video: HTMLVideoElement;
  /** Object URL kept alive for the lifetime of the probe. */
  srcUrl: string;
  /** True once `loadedmetadata` has fired and dims are stable. */
  ready: Promise<void>;
  /** Intrinsic rotation needed to display the source correctly,
   *  derived from the dim-swap heuristic against `cam.width/height`.
   *  0 = no rotation, 90/270 = portrait recordings, 180 rare. */
  rotationDeg: 0 | 90 | 180 | 270;
  /** Serialises seek+grab calls so the decoder cursor isn't yanked
   *  mid-seek. */
  queue: Promise<unknown>;
  refCount: number;
  syncOffsetMs: number;
}

const probes = new Map<string, CamProbe>();

function probeKey(jobId: string, camId: string): string {
  return `${jobId}::${camId}`;
}

async function getOrCreateProbe(
  jobId: string,
  cam: VideoAsset,
): Promise<CamProbe | null> {
  const key = probeKey(jobId, cam.id);
  const existing = probes.get(key);
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
  video.src = url;

  const ready = new Promise<void>((resolve) => {
    function done() {
      cleanup();
      resolve();
    }
    function cleanup() {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
    }
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", done, { once: true });
    if (video.readyState >= 1) done();
    setTimeout(done, 5_000); // never block forever
  });

  // Probe rotation once metadata is available. Display dims that
  // equal swapped stored dims = a 90° (or 270°) rotation; we can't
  // distinguish 90 from 270 without the matrix, but 90 is the
  // overwhelming majority for phone recordings held in portrait, so
  // we pick that.
  const rotationDegPromise = ready.then(() => {
    const dispW = video.videoWidth;
    const dispH = video.videoHeight;
    const storedW = cam.width ?? 0;
    const storedH = cam.height ?? 0;
    if (
      storedW > 0 &&
      storedH > 0 &&
      dispW > 0 &&
      dispH > 0 &&
      dispW === storedH &&
      dispH === storedW
    ) {
      return 90 as const;
    }
    return 0 as const;
  });

  const probe: CamProbe = {
    video,
    srcUrl: url,
    ready,
    rotationDeg: 0,
    queue: Promise.resolve(),
    refCount: 1,
    syncOffsetMs: (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0),
  };
  probes.set(key, probe);
  // Apply rotation as soon as known. Tier-2 callers `await` ready so
  // they observe the resolved value.
  void rotationDegPromise.then((r) => {
    probe.rotationDeg = r;
  });
  return probe;
}

function releaseProbe(jobId: string, camId: string) {
  const key = probeKey(jobId, camId);
  const p = probes.get(key);
  if (!p) return;
  p.refCount -= 1;
  if (p.refCount > 0) return;
  setTimeout(() => {
    const p2 = probes.get(key);
    if (!p2 || p2.refCount > 0) return;
    URL.revokeObjectURL(p2.srcUrl);
    p2.video.removeAttribute("src");
    p2.video.load();
    probes.delete(key);
  }, 5_000);
}

// ─── Tier 2: strip slice ───────────────────────────────────────────────

interface StripPlan {
  /** Centre timestamps in cam-source-time (seconds). */
  timestampsS: number[];
  tileWidth: number;
  tileHeight: number;
}

interface StripBundle {
  image: HTMLImageElement;
  plan: StripPlan;
  srcUrl: string;
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
  // Plan must mirror the extractor's tile cadence — derived from the
  // same inputs (durationS + dims), defaults aligned with the
  // extractor's defaults (tileHeight 80, maxTiles 100).
  const plan = planTileStrip({
    durationS: cam.durationS,
    sourceWidth: cam.width,
    sourceHeight: cam.height,
    tileHeight: 80,
    maxTiles: 100,
  });
  return {
    image,
    srcUrl: url,
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
 *  when no tile covers this chunk. */
function findCoveringTileIdx(
  chunk: Chunk,
  syncOffsetMs: number,
  plan: StripPlan,
): number | null {
  const sourceInS = chunk.startMs / 1000 - syncOffsetMs / 1000;
  const sourceOutS = chunk.endMs / 1000 - syncOffsetMs / 1000;
  if (sourceOutS <= 0) return null;
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

/**
 * Slice one tile out of the strip into a JPEG, honouring the cam's
 * intrinsic rotation. The strip stores raw codec-level pixels (no
 * rotation), so portrait phone recordings need a 90° rotate at draw
 * time to come out upright.
 */
async function sliceTileToBlob(
  bundle: StripBundle,
  tileIdx: number,
  rotationDeg: 0 | 90 | 180 | 270,
): Promise<Blob | null> {
  const { image, plan } = bundle;
  const srcX = tileIdx * plan.tileWidth;

  // Output canvas dims are post-rotation (display orientation).
  const swap = rotationDeg === 90 || rotationDeg === 270;
  const sourceAspect = plan.tileWidth / plan.tileHeight;
  const displayAspect = swap ? plan.tileHeight / plan.tileWidth : sourceAspect;
  const w = THUMB_WIDTH;
  const h = Math.max(2, Math.round(w / displayAspect));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    if (rotationDeg === 0) {
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
    } else {
      // Rotate around the canvas centre. After rotation we draw the
      // source tile at the (pre-rotation) display dims (h × w when
      // swap, w × h otherwise), centred at origin.
      const drawW = swap ? h : w;
      const drawH = swap ? w : h;
      ctx.translate(w / 2, h / 2);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      ctx.drawImage(
        image,
        srcX,
        0,
        plan.tileWidth,
        plan.tileHeight,
        -drawW / 2,
        -drawH / 2,
        drawW,
        drawH,
      );
    }
  } catch {
    return null;
  }
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.78);
  });
}

// ─── Tier 3: on-demand video seek ──────────────────────────────────────

async function seekAndCapture(
  probe: CamProbe,
  masterTimeS: number,
): Promise<Blob | null> {
  await probe.ready;
  const sourceTimeS = masterTimeS - probe.syncOffsetMs / 1000;
  const v = probe.video;
  if (!Number.isFinite(v.duration) || v.duration <= 0) return null;
  if (sourceTimeS < 0 || sourceTimeS > v.duration - 0.05) return null;

  await new Promise<void>((resolve) => {
    let timer: number | null = null;
    function done() {
      if (timer != null) clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    }
    v.addEventListener("seeked", done);
    try {
      v.currentTime = sourceTimeS;
    } catch {
      done();
      return;
    }
    // Safety timeout — some codecs / files never fire `seeked` for
    // a target near EOF. 2 s is generous; we'd rather draw whatever
    // frame is current than hang.
    timer = window.setTimeout(done, 2_000);
  });

  // `<video>` width/height already honour the MP4 rotation matrix,
  // so we don't need to re-apply it here — drawImage(video) gets
  // the display-oriented frame directly.
  const dispW = v.videoWidth || 16;
  const dispH = v.videoHeight || 9;
  const w = THUMB_WIDTH;
  const h = Math.max(2, Math.round(w * (dispH / dispW)));
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

export async function getChunkThumbnailUrl(
  req: ExtractRequest,
): Promise<string | null> {
  const ck = cacheKey(req.jobId, req.cam.id, req.chunk.id);

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

  // Strip + probe pipeline are needed by both tier 2 + tier 3 — fetch
  // them up front (in parallel). Probe is cheap (metadata-only video
  // load); strip is one image fetch + decode.
  const probe = await getOrCreateProbe(req.jobId, req.cam).catch(() => null);
  if (probe) {
    // Make sure rotation is known before slicing.
    await probe.ready;
  }

  let blob: Blob | null = null;

  // Tier 2 — strip slice.
  try {
    const bundle = await getOrLoadStrip(req.jobId, req.cam);
    if (bundle && probe) {
      const syncOffsetMs =
        (req.cam.sync?.offsetMs ?? 0) + (req.cam.syncOverrideMs ?? 0);
      const tileIdx = findCoveringTileIdx(req.chunk, syncOffsetMs, bundle.plan);
      if (tileIdx !== null) {
        blob = await sliceTileToBlob(bundle, tileIdx, probe.rotationDeg);
      }
    }
  } catch {
    /* fall through to tier 3 */
  }

  // Tier 3 — on-demand seek (for chunks that fall between strip
  // tiles, plus any cam without a frames.webp at all).
  if (!blob && probe) {
    const result = probe.queue
      .catch(() => null)
      .then(() => seekAndCapture(probe, clampMidpointMasterS(req.chunk)));
    probe.queue = result.catch(() => null);
    try {
      blob = await result;
    } catch {
      blob = null;
    }
  }

  if (probe) releaseProbe(req.jobId, req.cam.id);

  if (!blob) return null;

  // Persist to IDB so the next page-load gets an instant tier-1 hit.
  void jobsDb
    .saveChunkThumbnail(req.jobId, req.cam.id, req.chunk.id, blob)
    .catch(() => undefined);

  const url = URL.createObjectURL(blob);
  const entry: ThumbCacheEntry = { url, lastAccessedTick: 0 };
  recordAccess(ck, entry);
  evictIfFull();
  return url;
}

/** Drop every in-memory blob-URL + tear down all probes. Called when
 *  the Arrange page unmounts so we don't pin memory. The IDB cache
 *  stays intact across mounts. */
export function clearChunkThumbnails(): void {
  for (const entry of urlCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  urlCache.clear();
  for (const [key, p] of probes) {
    URL.revokeObjectURL(p.srcUrl);
    p.video.removeAttribute("src");
    p.video.load();
    probes.delete(key);
  }
  for (const [key, sp] of stripCache) {
    void sp.then((bundle) => {
      if (bundle) URL.revokeObjectURL(bundle.srcUrl);
    });
    stripCache.delete(key);
  }
}

/** Unit-test seam. */
export function _peekCache(): ReadonlyMap<string, ThumbCacheEntry> {
  return urlCache;
}
