/**
 * Frame-strip extraction via WebCodecs.
 *
 * Strategy: keyframe-only seek-and-decode.
 *
 *   1. Open the demux to get the sample table (per-sample offsets +
 *      keyframe flags + timestamps). No mdat reads happen here.
 *   2. For each tile timestamp, find the closest keyframe whose cts
 *      ≤ target. Snap the tile to that keyframe's time — for typical
 *      phone/screen recordings the keyframe interval is 1–4 s, so the
 *      snap is invisible at our 5–10 s tile spacing.
 *   3. Load just that keyframe's encoded bytes (random-access blob
 *      slice), decode, snapshot to the canvas tile.
 *
 * Why this matters for big files: the previous implementation streamed
 * EVERY sample through the decoder (~48 000 frames for a 16-min phone
 * recording @ 50 fps), even though only ~100 thumbnails are needed.
 * Keyframe-only decode visits ~N_tiles samples instead — a ~100×
 * reduction in decoder work for a 9 GB recording.
 */

import { openVideoDemux, type SampleMeta } from "../../codec/webcodecs/demux";
import { planTileStrip } from "./strategy";
import type { FrameStripResult } from "./types";

export interface WebcodecsFrameStripOptions {
  /** Tile height in pixels. Default 80. */
  tileHeight?: number;
  /** Hard cap on tile count. Default from `planTileStrip` (100). */
  maxTiles?: number;
  /** WebP quality (0..1). Default 0.75. */
  quality?: number;
  /** Called with [0..1] as tiles fill in. Cheap to call repeatedly. */
  onProgress?: (frac: number) => void;
}

export async function extractFrameStripWebcodecs(
  source: Blob | ArrayBuffer,
  opts: WebcodecsFrameStripOptions = {},
): Promise<FrameStripResult> {
  const demuxed = await openVideoDemux(source);
  if (!demuxed) {
    throw new Error("Frame extraction: source has no video track");
  }
  const { info, sampleTable, loadSample } = demuxed;

  const plan = planTileStrip({
    durationS: info.durationS,
    sourceWidth: info.width,
    sourceHeight: info.height,
    tileHeight: opts.tileHeight,
    maxTiles: opts.maxTiles,
  });
  if (plan.timestampsS.length === 0) {
    await demuxed.cancel();
    throw new Error("Frame extraction: planned zero tiles (zero-duration source?)");
  }

  // Indices of every keyframe in the sample table — sorted by cts
  // because mp4box yields samples in decode order, which for keyframes
  // matches presentation order.
  const keyframeIdxs: number[] = [];
  for (let i = 0; i < sampleTable.length; i++) {
    if (sampleTable[i].isKey) keyframeIdxs.push(i);
  }
  if (keyframeIdxs.length === 0) {
    await demuxed.cancel();
    throw new Error("Frame extraction: source has no keyframes");
  }

  // Pre-resolve each tile to the sample-index of the keyframe nearest
  // (and at-or-before) its target timestamp. Several tiles may resolve
  // to the SAME keyframe when the keyframe interval is wider than the
  // tile spacing — we de-dup the decode work and reuse the snapshot.
  const tileSampleIdx = new Int32Array(plan.timestampsS.length);
  for (let t = 0; t < plan.timestampsS.length; t++) {
    const targetUs = plan.timestampsS[t] * 1_000_000;
    tileSampleIdx[t] = nearestKeyframeIdx(sampleTable, keyframeIdxs, targetUs);
  }

  const canvas = new OffscreenCanvas(
    plan.tileWidth * plan.timestampsS.length,
    plan.tileHeight,
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    await demuxed.cancel();
    throw new Error("Frame extraction: OffscreenCanvas 2d context unavailable");
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Decode + snapshot. We process tiles in input order; consecutive
  // tiles often share a keyframe (when keyframe interval > tile step),
  // so we cache the most recent decoded VideoFrame and reuse it
  // without round-tripping through the decoder.
  let pendingError: Error | null = null;
  let drawnCount = 0;
  let lastDecodedSampleIdx = -1;
  let lastDecodedFrame: VideoFrame | null = null;

  // The decoder is configured once and re-used across keyframes —
  // every `decode({type:"key"})` call resets its prediction context
  // naturally, so we don't need decoder.reset() between keyframes.
  const decoded = new Promise<VideoFrame>((resolve, reject) => {
    // unused — see drainOnce inline below
    void resolve;
    void reject;
  });
  void decoded;
  // We use a simpler waiter pattern: each decode call awaits a single
  // output via a one-shot resolver attached to the decoder.
  let pendingResolve: ((f: VideoFrame) => void) | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const r = pendingResolve;
      pendingResolve = null;
      if (r) r(frame);
      else frame.close(); // straggler — shouldn't happen in 1-in-1-out mode
    },
    error: (e) => {
      pendingError = e instanceof Error ? e : new Error(String(e));
      const r = pendingResolve;
      pendingResolve = null;
      if (r) r(null as unknown as VideoFrame); // trip the await; checked below
    },
  });
  decoder.configure({
    codec: info.codec,
    codedWidth: info.width,
    codedHeight: info.height,
    description: info.description,
  });

  try {
    for (let t = 0; t < tileSampleIdx.length; t++) {
      if (pendingError) throw pendingError;
      const idx = tileSampleIdx[t];

      let frame: VideoFrame;
      if (idx === lastDecodedSampleIdx && lastDecodedFrame) {
        frame = lastDecodedFrame;
      } else {
        // Decode a fresh keyframe. Load just its encoded bytes, push
        // into the decoder, then `flush()` to force the output — a
        // single decode call may not emit until the decoder has
        // accumulated enough chunks for B-frame lookahead, which never
        // happens when we feed exactly one chunk at a time.
        const chunk = await loadSample(idx);
        const framePromise = new Promise<VideoFrame>((resolve) => {
          pendingResolve = resolve;
        });
        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: chunk.timestampUs,
            duration: chunk.durationUs,
            data: chunk.data,
          }),
        );
        await decoder.flush();
        const decodedFrame = await framePromise;
        if (pendingError) {
          try { decodedFrame?.close(); } catch { /* nullable */ }
          throw pendingError;
        }
        if (lastDecodedFrame) {
          try { lastDecodedFrame.close(); } catch { /* already closed */ }
        }
        lastDecodedFrame = decodedFrame;
        lastDecodedSampleIdx = idx;
        frame = decodedFrame;
      }

      const dx = t * plan.tileWidth;
      ctx.drawImage(
        frame as unknown as CanvasImageSource,
        dx,
        0,
        plan.tileWidth,
        plan.tileHeight,
      );
      drawnCount++;
      opts.onProgress?.(drawnCount / tileSampleIdx.length);
    }
  } finally {
    if (lastDecodedFrame) {
      try { lastDecodedFrame.close(); } catch { /* already closed */ }
    }
    try { decoder.close(); } catch { /* idempotent */ }
    await demuxed.cancel();
  }

  if (pendingError) throw pendingError;
  if (drawnCount === 0) {
    throw new Error("Frame extraction: decoder emitted no usable frames");
  }

  const blob = await canvas.convertToBlob({
    type: "image/webp",
    quality: opts.quality ?? 0.75,
  });

  return {
    blob,
    manifest: {
      tileCount: plan.timestampsS.length,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
      durationS: info.durationS,
      tileTimestampsS: plan.timestampsS,
      backend: "webcodecs",
    },
  };
}

/**
 * Find the keyframe whose cts is closest to (and at or before)
 * `targetUs`. Falls back to the FIRST keyframe when the target is
 * before any keyframe (typical for very early tile timestamps).
 *
 * `keyframeIdxs` is the pre-computed index of keyframes within
 * `sampleTable`, in decode order (which equals presentation order for
 * keyframes since they have no reordering).
 */
function nearestKeyframeIdx(
  sampleTable: ReadonlyArray<SampleMeta>,
  keyframeIdxs: ReadonlyArray<number>,
  targetUs: number,
): number {
  // Binary search for the largest keyframe index whose cts ≤ target.
  let lo = 0;
  let hi = keyframeIdxs.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sIdx = keyframeIdxs[mid];
    const s = sampleTable[sIdx];
    const ctsUs = (s.cts * 1_000_000) / s.timescale;
    if (ctsUs <= targetUs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return keyframeIdxs[best];
}
