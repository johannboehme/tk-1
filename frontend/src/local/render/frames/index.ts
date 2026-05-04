/**
 * Frame-strip extraction — public API.
 *
 * Two backends, one shape:
 *   1. WebCodecs `VideoDecoder` (primary; hardware-accelerated, no extra bundle)
 *   2. ffmpeg.wasm (fallback; lazy-loaded, ~25 MB, slow but universal)
 *
 * The result is a single WebP tile-strip + a manifest describing the layout,
 * laid out in the same row-of-tiles shape that `Timeline.tsx` already
 * consumes via the `thumbnailsUrl` prop.
 */

import { demuxVideoTrack } from "../../codec/webcodecs/demux";
import { extractFrameStripWebcodecs } from "./webcodecs";
import type { FrameStripResult } from "./types";

export type { FrameStripManifest, FrameStripResult } from "./types";

export interface ExtractFramesOptions {
  /** Tile height in pixels. Default 80. */
  tileHeight?: number;
  /** Hard cap on tile count. Default 200. */
  maxTiles?: number;
  /** WebP quality (0..1). Default 0.75. Only used by the WebCodecs path. */
  quality?: number;
  forceBackend?: "webcodecs" | "ffmpeg-wasm";
  /** Source duration; required only when forcing the ffmpeg-wasm backend
   *  (it can't probe duration without re-running the demux). */
  durationS?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  /** [0..1] progress callback. Coarse on the ffmpeg path. */
  onProgress?: (frac: number) => void;
  /** Bake the source's display rotation into the strip so tiles come
   *  out upright. Should be the value the demuxer extracts from the
   *  container's display matrix (`info.rotationDeg`). Default 0. */
  rotationDeg?: 0 | 90 | 180 | 270;
}

let ffmpegImpl: typeof import("./ffmpeg") | null = null;
async function loadFfmpegBackend() {
  if (!ffmpegImpl) {
    ffmpegImpl = await import("./ffmpeg");
  }
  return ffmpegImpl;
}

export async function extractTimelineFrames(
  source: Blob | ArrayBuffer,
  opts: ExtractFramesOptions = {},
): Promise<FrameStripResult> {
  if (opts.forceBackend === "ffmpeg-wasm") {
    const { extractFrameStripFfmpeg } = await loadFfmpegBackend();
    if (
      opts.durationS === undefined ||
      opts.sourceWidth === undefined ||
      opts.sourceHeight === undefined
    ) {
      // Probe via demux as a convenience. If the caller didn't pass
      // rotation, take it from the demux probe.
      const probed = await demuxVideoTrack(source);
      if (!probed) throw new Error("Frame extraction: source has no video track");
      return extractFrameStripFfmpeg(source, {
        durationS: probed.info.durationS,
        sourceWidth: probed.info.width,
        sourceHeight: probed.info.height,
        tileHeight: opts.tileHeight,
        maxTiles: opts.maxTiles,
        onProgress: opts.onProgress,
        rotationDeg: opts.rotationDeg ?? probed.info.rotationDeg,
      });
    }
    return extractFrameStripFfmpeg(source, {
      durationS: opts.durationS,
      sourceWidth: opts.sourceWidth,
      sourceHeight: opts.sourceHeight,
      tileHeight: opts.tileHeight,
      maxTiles: opts.maxTiles,
      onProgress: opts.onProgress,
      rotationDeg: opts.rotationDeg,
    });
  }

  if (opts.forceBackend === "webcodecs") {
    return extractFrameStripWebcodecs(source, {
      tileHeight: opts.tileHeight,
      maxTiles: opts.maxTiles,
      quality: opts.quality,
      onProgress: opts.onProgress,
      rotationDeg: opts.rotationDeg,
    });
  }

  // Default: WebCodecs first, fall back to ffmpeg.wasm on failure. We swallow
  // any error from the primary path because the secondary path can handle
  // every container the primary can plus the awkward ones (MKV, AVI, etc.).
  let primaryError: unknown = null;
  try {
    return await extractFrameStripWebcodecs(source, {
      tileHeight: opts.tileHeight,
      maxTiles: opts.maxTiles,
      quality: opts.quality,
      onProgress: opts.onProgress,
      rotationDeg: opts.rotationDeg,
    });
  } catch (err) {
    primaryError = err;
  }

  // Probe the source so the ffmpeg path can plan its tile strip.
  const probed = await demuxVideoTrack(source).catch(() => null);
  if (!probed) {
    // No way to plan without dimensions — give up and surface the original
    // failure so the caller knows what went wrong.
    throw primaryError instanceof Error
      ? primaryError
      : new Error(String(primaryError));
  }

  const { extractFrameStripFfmpeg } = await loadFfmpegBackend();
  return extractFrameStripFfmpeg(source, {
    durationS: probed.info.durationS,
    sourceWidth: probed.info.width,
    sourceHeight: probed.info.height,
    tileHeight: opts.tileHeight,
    maxTiles: opts.maxTiles,
    onProgress: opts.onProgress,
    rotationDeg: opts.rotationDeg ?? probed.info.rotationDeg,
  });
}
