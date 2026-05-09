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
import { loadAssetFile } from "../asset-source";
import { resolveCamAssetUrl } from "../jobs";
import { planTileStrip } from "../render/frames/strategy";
import { camSourceTimeS } from "../timing/cam-time";

/** Target output width for tier-3 (on-demand seek) thumbnails — drawn
 *  from the full-res video, so we can pick a number that's plenty
 *  large for the biggest frame in the strip. */
const THUMB_WIDTH = 256;
/** Tier-2 only kicks in when the strip tile is at least this wide.
 *  Strips are extracted at `tileHeight: 80`, so portrait phone clips
 *  end up with ~45 px wide tiles — upscaling those to even 124 px
 *  (Polaroid width) produces visible blocking. Landscape clips have
 *  ~142 px tiles which scale up cleanly. The threshold sits between
 *  the two regimes so portrait falls through to tier 3 (full-res
 *  video seek), landscape stays on the fast strip path. */
const TIER2_MIN_TILE_WIDTH = 100;
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
  /** Resolved once the probe is fully usable: `<video>`'s
   *  loadedmetadata event has fired AND the intrinsic rotation has
   *  been resolved (either from the persisted asset field or the
   *  lazy demux probe). Tier-2 slicers must await this before
   *  reading `rotationDeg`. */
  ready: Promise<void>;
  /** Intrinsic rotation needed to display the source correctly,
   *  derived from `cam.intrinsicRotationDeg` (sync-time persistence)
   *  or a lazy demux probe / dim-swap heuristic for legacy assets. */
  rotationDeg: 0 | 90 | 180 | 270;
  /** Serialises seek+grab calls so the decoder cursor isn't yanked
   *  mid-seek. */
  queue: Promise<unknown>;
  refCount: number;
  syncOffsetMs: number;
}

// Map keyed by jobId::camId. Stores the in-flight Promise — concurrent
// callers (e.g. 30 polaroids mounting at once) all await the SAME
// probe creation instead of each kicking off a separate demux + IDB
// roundtrip + <video> element. Without this dedup we'd leak 29 video
// elements per cam on every mount.
const probes = new Map<string, Promise<CamProbe | null>>();

function probeKey(jobId: string, camId: string): string {
  return `${jobId}::${camId}`;
}

function thumbLog(...args: unknown[]) {
  // Opt-in via `localStorage.__thumbDebug = '1'` — silent in prod by
  // default. Use to diagnose rotation / tier / seek issues.
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem("__thumbDebug") !== "1") return;
  // eslint-disable-next-line no-console
  console.log("[thumb]", ...args);
}

async function buildProbe(
  jobId: string,
  cam: VideoAsset,
): Promise<CamProbe | null> {
  const url = await resolveCamAssetUrl(jobId, cam.id, "video");
  if (!url) {
    thumbLog("probe", cam.id, "no url");
    return null;
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  // 30 s metadata timeout. Big files (multi-GB phone recordings) can
  // take tens of seconds to surface `loadedmetadata` on a cold
  // OPFS-backed blob URL — 5 s was too aggressive and turned into a
  // silent "v.duration === NaN" path that produced "no preview"
  // placeholders later in tier 3.
  const metadataReady = new Promise<void>((resolve) => {
    let timer: number | null = null;
    function done(reason: string) {
      if (timer != null) clearTimeout(timer);
      cleanup();
      thumbLog(
        "metadata",
        cam.id,
        reason,
        "videoW=" + video.videoWidth,
        "videoH=" + video.videoHeight,
        "duration=" + video.duration,
      );
      resolve();
    }
    function cleanup() {
      video.removeEventListener("loadedmetadata", () => done("event"));
      video.removeEventListener("error", () => done("error"));
    }
    video.addEventListener("loadedmetadata", () => done("event"), {
      once: true,
    });
    video.addEventListener("error", () => done("error"), { once: true });
    if (video.readyState >= 1) done("already-ready");
    timer = window.setTimeout(() => done("timeout-30s"), 30_000);
  });

  // Determine intrinsic rotation. Strategy:
  //
  //   1. Start with `cam.intrinsicRotationDeg` if persisted (from sync
  //      time matrix decode). Use as the candidate.
  //   2. If undefined, run lazy demux probe over the moov atom.
  //   3. After metadata loads, run the dim-swap CROSS-CHECK against
  //      the `<video>` element's display dims. Browsers honour the
  //      container's display matrix when computing videoWidth/Height,
  //      so it's the most reliable source of truth at runtime.
  //      If dim-swap disagrees with the candidate (e.g. candidate=0
  //      but the video is clearly portrait), override to 90 — a
  //      previous matrix-decode bug at sync time mustn't survive into
  //      tier-2 thumbnails forever.
  //   4. If everything fails, fall back to 0.
  //
  // The cross-check fixes the case where intrinsicRotationDeg was
  // persisted as 0 (e.g. mp4box exposed an unexpected matrix layout
  // for a specific file) but the file is actually portrait — without
  // it, tier 2 silently produces sideways thumbs while tier 3 (which
  // honours browser auto-rotation) produces upright ones, giving
  // mixed thumbnails for the same cam.
  function detectDimSwap(): 0 | 90 | "unknown" {
    const dispW = video.videoWidth;
    const dispH = video.videoHeight;
    const storedW = cam.width ?? 0;
    const storedH = cam.height ?? 0;
    if (storedW <= 0 || storedH <= 0 || dispW <= 0 || dispH <= 0) {
      return "unknown";
    }
    if (dispW === storedH && dispH === storedW) return 90;
    if (dispW === storedW && dispH === storedH) return 0;
    return "unknown";
  }

  const rotationDegPromise: Promise<0 | 90 | 180 | 270> = (async () => {
    let candidate: 0 | 90 | 180 | 270 | undefined = cam.intrinsicRotationDeg;
    let source = "cam-field";

    if (candidate === undefined) {
      try {
        const file = await loadAssetFile(cam);
        const m = await import("../codec/webcodecs/demux");
        const v = await m.demuxVideoTrack(file);
        if (v) {
          candidate = v.info.rotationDeg;
          source = "lazy-demux";
          void jobsDb
            .updateJob(jobId, {
              videos: await (async () => {
                const job = await jobsDb.getJob(jobId);
                return (job?.videos ?? []).map((v2) =>
                  isVideoAsset(v2) && v2.id === cam.id
                    ? { ...v2, intrinsicRotationDeg: candidate as 0 | 90 | 180 | 270 }
                    : v2,
                );
              })(),
            })
            .catch(() => undefined);
        } else {
          thumbLog("rotation", cam.id, "lazy-demux-returned-null");
        }
      } catch (err) {
        thumbLog("rotation", cam.id, "lazy-demux-throw", String(err));
      }
    }

    // Cross-check against runtime display dims — the browser honours
    // the container's display matrix here, so it's authoritative.
    await metadataReady;
    const dimSwap = detectDimSwap();
    const candidateImpliesSwap = candidate === 90 || candidate === 270;

    if (dimSwap === 90 && !candidateImpliesSwap) {
      thumbLog(
        "rotation",
        cam.id,
        "override-from-dim-swap",
        `candidate=${candidate}(${source})`,
        "→ 90",
        `display=${video.videoWidth}x${video.videoHeight}`,
        `stored=${cam.width}x${cam.height}`,
      );
      // The `<video>` element shows portrait but our candidate said
      // landscape. Override to 90. We can't distinguish 90 from 270
      // without the matrix, but 90 covers the common case (phone
      // held in portrait).
      return 90;
    }
    if (dimSwap === 0 && candidateImpliesSwap) {
      thumbLog(
        "rotation",
        cam.id,
        "override-no-swap",
        `candidate=${candidate}(${source})`,
        "→ 0",
        `display=${video.videoWidth}x${video.videoHeight}`,
        `stored=${cam.width}x${cam.height}`,
      );
      return 0;
    }

    if (candidate !== undefined) {
      thumbLog(
        "rotation",
        cam.id,
        source,
        candidate,
        `dim-swap=${dimSwap}`,
      );
      return candidate;
    }
    // Fall through: no demux candidate, dim-swap inconclusive.
    if (dimSwap === 90) {
      thumbLog("rotation", cam.id, "fallback-dim-swap", 90);
      return 90;
    }
    thumbLog("rotation", cam.id, "fallback-zero", 0, `dim-swap=${dimSwap}`);
    return 0;
  })();

  // Build the probe object up front so we have a stable reference. The
  // `ready` promise is constructed via rotationDegPromise (NOT
  // Promise.all) so we can SET probe.rotationDeg synchronously inside
  // the same continuation that resolves ready — that way every awaiter
  // observes the real value, no microtask-ordering hazard.
  const probe: CamProbe = {
    video,
    srcUrl: url,
    ready: undefined as unknown as Promise<void>,
    rotationDeg: cam.intrinsicRotationDeg ?? 0,
    queue: Promise.resolve(),
    refCount: 0,
    syncOffsetMs: (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0),
  };
  probe.ready = rotationDegPromise.then(async (r) => {
    probe.rotationDeg = r;
    await metadataReady;
    thumbLog("probe-ready", cam.id, `rotation=${r}`);
  });
  return probe;
}

async function getOrCreateProbe(
  jobId: string,
  cam: VideoAsset,
): Promise<CamProbe | null> {
  const key = probeKey(jobId, cam.id);
  let promise = probes.get(key);
  if (!promise) {
    promise = buildProbe(jobId, cam);
    probes.set(key, promise);
  }
  const probe = await promise;
  if (!probe) {
    // Don't keep a null promise pinned — let a future caller retry.
    if (probes.get(key) === promise) probes.delete(key);
    return null;
  }
  probe.refCount += 1;
  probe.syncOffsetMs =
    (cam.sync?.offsetMs ?? 0) + (cam.syncOverrideMs ?? 0);
  return probe;
}

function releaseProbe(jobId: string, camId: string) {
  const key = probeKey(jobId, camId);
  const promise = probes.get(key);
  if (!promise) return;
  void promise.then((p) => {
    if (!p) return;
    p.refCount -= 1;
    if (p.refCount > 0) return;
    setTimeout(() => {
      const promise2 = probes.get(key);
      if (!promise2) return;
      void promise2.then((p2) => {
        if (!p2 || p2.refCount > 0) return;
        URL.revokeObjectURL(p2.srcUrl);
        p2.video.removeAttribute("src");
        p2.video.load();
        if (probes.get(key) === promise2) probes.delete(key);
      });
    }, 5_000);
  });
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
  // Plan must mirror the extractor's tile cadence. New strips have
  // rotation BAKED IN at extraction time (`framesOrientation:
  // "display"`) — the planner there used the post-rotation aspect, so
  // we replay that here too. Legacy strips (orientation undefined or
  // "codec") used codec dims; consumers slice them with the manual
  // rotation override below.
  const swap =
    cam.framesOrientation === "display" &&
    (cam.intrinsicRotationDeg === 90 || cam.intrinsicRotationDeg === 270);
  const plan = planTileStrip({
    durationS: cam.durationS,
    sourceWidth: swap ? cam.height : cam.width,
    sourceHeight: swap ? cam.width : cam.height,
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
  // Sign convention: positive `syncOffsetMs` means the cam started BEFORE
  // master t=0 (pre-roll). The cam's source-time-0 sits at master
  // `-syncOffsetMs/1000`, so source-time at master T is
  // `T − (−syncOffsetMs/1000) = T + syncOffsetMs/1000`. See
  // `local/timing/cam-time.ts` and `editor/types.ts:clipRangeS` for the
  // canonical definition.
  const camRef = { masterStartS: -syncOffsetMs / 1000, driftRatio: 1 };
  const sourceInS = camSourceTimeS(chunk.startMs / 1000, camRef);
  const sourceOutS = camSourceTimeS(chunk.endMs / 1000, camRef);
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
 * Slice one tile out of the strip into a JPEG at the tile's NATIVE
 * resolution — no upscale at encode time. CSS scaling does the final
 * fit at the consumer end, which keeps the JPEG round small while
 * avoiding the blocky upscale-then-recompress double-hit we used to
 * pay when the slice was stretched to a fixed THUMB_WIDTH first.
 */
async function sliceTileToBlob(
  bundle: StripBundle,
  tileIdx: number,
  rotationDeg: 0 | 90 | 180 | 270,
): Promise<Blob | null> {
  const { image, plan } = bundle;
  const srcX = tileIdx * plan.tileWidth;

  // Output canvas dims = the tile's display dimensions. Width and
  // height swap when we rotate 90°/270° (portrait clip stored sideways
  // in the codec strip — display dims are tile.height × tile.width).
  const swap = rotationDeg === 90 || rotationDeg === 270;
  const w = swap ? plan.tileHeight : plan.tileWidth;
  const h = swap ? plan.tileWidth : plan.tileHeight;

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
      ctx.translate(w / 2, h / 2);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      // Source is tileWidth × tileHeight. Drawn centred so the rotation
      // around the canvas centre lines up with the tile centre.
      ctx.drawImage(
        image,
        srcX,
        0,
        plan.tileWidth,
        plan.tileHeight,
        -plan.tileWidth / 2,
        -plan.tileHeight / 2,
        plan.tileWidth,
        plan.tileHeight,
      );
    }
  } catch {
    return null;
  }
  // Higher JPEG quality compensates for the lower pixel count — at the
  // small native tile size, blocky compression is the bigger eyesore
  // than file size.
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9);
  });
}

// ─── Tier 3: on-demand video seek ──────────────────────────────────────

async function seekAndCapture(
  probe: CamProbe,
  masterTimeS: number,
  chunkIdForLog: string,
): Promise<Blob | null> {
  await probe.ready;
  const v = probe.video;
  if (!Number.isFinite(v.duration) || v.duration <= 0) {
    thumbLog(
      "tier3-fail",
      chunkIdForLog,
      "no-duration",
      "duration=" + v.duration,
      "readyState=" + v.readyState,
    );
    return null;
  }
  // Clamp the seek target into the cam's recorded range. Chunks whose
  // master-time falls before the cam started (sourceTimeS < 0) or past
  // its end (sourceTimeS > duration) get the boundary frame instead
  // of nothing — better a slightly-off thumbnail than an "out of
  // range" placeholder that the user has no way to act on.
  // See `findCoveringTileIdx` above for the sign convention.
  const rawSource = camSourceTimeS(masterTimeS, {
    masterStartS: -probe.syncOffsetMs / 1000,
    driftRatio: 1,
  });
  const sourceTimeS = Math.max(0, Math.min(v.duration - 0.05, rawSource));

  let seekedFired = false;
  await new Promise<void>((resolve) => {
    let timer: number | null = null;
    function done(reason: string) {
      if (timer != null) clearTimeout(timer);
      v.removeEventListener("seeked", onSeeked);
      if (reason === "seeked") seekedFired = true;
      resolve();
    }
    function onSeeked() {
      done("seeked");
    }
    v.addEventListener("seeked", onSeeked);
    try {
      v.currentTime = sourceTimeS;
    } catch (err) {
      thumbLog(
        "tier3-fail",
        chunkIdForLog,
        "seek-throw",
        String(err),
      );
      done("throw");
      return;
    }
    // Safety timeout — some codecs / files never fire `seeked` for
    // a target near EOF. 2 s is generous; we'd rather draw whatever
    // frame is current than hang.
    timer = window.setTimeout(() => done("timeout-2s"), 2_000);
  });

  if (!seekedFired) {
    thumbLog(
      "tier3-warn",
      chunkIdForLog,
      "no-seeked-event",
      "target=" + sourceTimeS.toFixed(3),
      "current=" + v.currentTime.toFixed(3),
    );
  }

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
  if (!ctx) {
    thumbLog("tier3-fail", chunkIdForLog, "no-2d-context");
    return null;
  }
  try {
    ctx.drawImage(v, 0, 0, w, h);
  } catch (err) {
    thumbLog("tier3-fail", chunkIdForLog, "drawImage-throw", String(err));
    return null;
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.78);
  });
  if (!blob) {
    thumbLog("tier3-fail", chunkIdForLog, "toBlob-null");
  } else {
    thumbLog(
      "tier3-ok",
      chunkIdForLog,
      `source=${sourceTimeS.toFixed(2)}`,
      `dim=${w}x${h}`,
    );
  }
  return blob;
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
  let usedTier: "2" | "3" | "none" = "none";

  // Tier 2 — strip slice.
  try {
    const bundle = await getOrLoadStrip(req.jobId, req.cam);
    if (bundle && probe) {
      const sliceRotation =
        req.cam.framesOrientation === "display"
          ? (0 as const)
          : probe.rotationDeg;
      // Display width of a single tile after the slicer's rotation —
      // for portrait clips stored in a codec-orientation strip, the
      // tile width as the user sees it is `tileHeight`. We gate on
      // that so a 45-px-wide portrait tile doesn't get sliced and
      // delivered as a blocky thumb.
      const swap = sliceRotation === 90 || sliceRotation === 270;
      const tileDisplayW = swap ? bundle.plan.tileHeight : bundle.plan.tileWidth;
      if (tileDisplayW < TIER2_MIN_TILE_WIDTH) {
        thumbLog(
          "tier2-skip",
          req.chunk.id,
          "tile-too-small",
          `displayW=${tileDisplayW}`,
          `min=${TIER2_MIN_TILE_WIDTH}`,
        );
      } else {
        const syncOffsetMs =
          (req.cam.sync?.offsetMs ?? 0) + (req.cam.syncOverrideMs ?? 0);
        const tileIdx = findCoveringTileIdx(
          req.chunk,
          syncOffsetMs,
          bundle.plan,
        );
        if (tileIdx !== null) {
          blob = await sliceTileToBlob(bundle, tileIdx, sliceRotation);
          if (blob) {
            usedTier = "2";
            thumbLog(
              "tier2-ok",
              req.chunk.id,
              `cam=${req.cam.id}`,
              `tileIdx=${tileIdx}`,
              `orient=${req.cam.framesOrientation ?? "codec"}`,
              `sliceRot=${sliceRotation}`,
              `displayW=${tileDisplayW}`,
            );
          } else {
            thumbLog(
              "tier2-fail",
              req.chunk.id,
              "slice-returned-null",
              `tileIdx=${tileIdx}`,
            );
          }
        } else {
          thumbLog(
            "tier2-skip",
            req.chunk.id,
            "no-covering-tile",
            `chunkRange=${(req.chunk.startMs / 1000).toFixed(2)}-${(req.chunk.endMs / 1000).toFixed(2)}`,
            `syncOff=${syncOffsetMs}`,
          );
        }
      }
    } else if (!bundle) {
      thumbLog("tier2-skip", req.chunk.id, "no-strip", `cam=${req.cam.id}`);
    }
  } catch (err) {
    thumbLog("tier2-throw", req.chunk.id, String(err));
  }

  // Tier 3 — on-demand seek (for chunks that fall between strip
  // tiles, plus any cam without a frames.webp at all).
  if (!blob && probe) {
    const result = probe.queue
      .catch(() => null)
      .then(() =>
        seekAndCapture(probe, clampMidpointMasterS(req.chunk), req.chunk.id),
      );
    probe.queue = result.catch(() => null);
    try {
      blob = await result;
      if (blob) usedTier = "3";
    } catch (err) {
      thumbLog("tier3-throw", req.chunk.id, String(err));
      blob = null;
    }
  }

  thumbLog(
    "extract-done",
    req.chunk.id,
    `cam=${req.cam.id}`,
    `tier=${usedTier}`,
    `blob=${blob ? blob.size + "b" : "null"}`,
  );

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

/**
 * Synchronously look up an already-cached thumbnail URL. Returns the
 * URL when the in-memory map has an entry, null otherwise. Use to
 * decide whether to render the "developing" indicator or jump
 * straight to showing the image.
 */
export function peekChunkThumbnailUrl(
  jobId: string,
  camId: string,
  chunkId: string,
): string | null {
  const ck = cacheKey(jobId, camId, chunkId);
  const memHit = urlCache.get(ck);
  if (!memHit) return null;
  recordAccess(ck, memHit);
  return memHit.url;
}

/**
 * Bulk-load every cached thumbnail for a job from IDB into the
 * in-memory URL cache. Call this once per Arrange-page mount so the
 * synchronous peek in `useChunkThumbnail` finds returning thumbs
 * without a flash of "developing" dots.
 *
 * Skips chunks already in the in-memory cache; safe to call multiple
 * times. Best-effort — IDB failures fall through.
 */
export async function prefetchChunkThumbnails(
  jobId: string,
  camId: string,
  chunkIds: readonly string[],
): Promise<number> {
  let hits = 0;
  await Promise.all(
    chunkIds.map(async (chunkId) => {
      const ck = cacheKey(jobId, camId, chunkId);
      if (urlCache.has(ck)) {
        hits += 1;
        return;
      }
      try {
        const blob = await jobsDb.getChunkThumbnail(jobId, camId, chunkId);
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const entry: ThumbCacheEntry = { url, lastAccessedTick: 0 };
        recordAccess(ck, entry);
        evictIfFull();
        hits += 1;
      } catch {
        /* per-chunk failure non-fatal */
      }
    }),
  );
  return hits;
}

/** Drop every in-memory blob-URL + tear down all probes. Called when
 *  the Arrange page unmounts so we don't pin memory. The IDB cache
 *  stays intact across mounts. */
export function clearChunkThumbnails(): void {
  for (const entry of urlCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  urlCache.clear();
  for (const [key, promise] of probes) {
    void promise.then((p) => {
      if (!p) return;
      URL.revokeObjectURL(p.srcUrl);
      p.video.removeAttribute("src");
      p.video.load();
    });
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
