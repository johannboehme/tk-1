/**
 * Frame-strip extraction via WebCodecs.
 *
 * Streams every encoded chunk through `VideoDecoder` and stamps the first
 * frame ≥ each target timestamp into a single OffscreenCanvas tile-strip.
 * Output is encoded as WebP for compactness — the strip is one row of tiles
 * laid out left-to-right, exactly the layout `Timeline.tsx` already expects.
 */

import { openVideoDemux } from "../../codec/webcodecs/demux";
import { planTileStrip } from "./strategy";
import type { FrameStripResult } from "./types";

export interface WebcodecsFrameStripOptions {
  /** Tile height in pixels. Default 80. */
  tileHeight?: number;
  /** Hard cap on tile count. Default 200. */
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
  const { info, samples } = demuxed;

  const plan = planTileStrip({
    durationS: info.durationS,
    sourceWidth: info.width,
    sourceHeight: info.height,
    tileHeight: opts.tileHeight,
    maxTiles: opts.maxTiles,
  });
  if (plan.timestampsS.length === 0) {
    throw new Error("Frame extraction: planned zero tiles (zero-duration source?)");
  }

  const canvas = new OffscreenCanvas(
    plan.tileWidth * plan.timestampsS.length,
    plan.tileHeight,
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Frame extraction: OffscreenCanvas 2d context unavailable");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Targets in microseconds (matches VideoFrame.timestamp units).
  const targetsUs = plan.timestampsS.map((s) => Math.round(s * 1_000_000));
  // For each tile slot we record whether we've already drawn into it.
  const drawn = new Uint8Array(plan.timestampsS.length);
  let drawnCount = 0;
  let pendingError: Error | null = null;

  // Sliding pointer: VideoDecoder emits frames in display order, so we
  // can advance through the targets sequentially. Decoder runs ahead of
  // the encoder feed via backpressure.
  let nextTargetIdx = 0;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (nextTargetIdx >= targetsUs.length) {
          frame.close();
          return;
        }
        const tsUs = frame.timestamp;
        // Advance past targets this frame already passed (e.g. dense
        // sampling near keyframe boundaries on low-fps sources).
        while (
          nextTargetIdx < targetsUs.length - 1 &&
          tsUs >= targetsUs[nextTargetIdx + 1]
        ) {
          nextTargetIdx++;
        }
        if (tsUs >= targetsUs[nextTargetIdx] && !drawn[nextTargetIdx]) {
          const dx = nextTargetIdx * plan.tileWidth;
          ctx.drawImage(
            frame as unknown as CanvasImageSource,
            dx,
            0,
            plan.tileWidth,
            plan.tileHeight,
          );
          drawn[nextTargetIdx] = 1;
          drawnCount++;
          nextTargetIdx++;
          opts.onProgress?.(drawnCount / targetsUs.length);
        }
        frame.close();
      } catch (e) {
        pendingError = e instanceof Error ? e : new Error(String(e));
        try { frame.close(); } catch { /* already closed */ }
      }
    },
    error: (e) => {
      pendingError = e instanceof Error ? e : new Error(String(e));
    },
  });

  decoder.configure({
    codec: info.codec,
    codedWidth: info.width,
    codedHeight: info.height,
    description: info.description,
  });

  // Feed chunks with backpressure so we don't pile up VideoFrames in
  // flight. Pull samples from the demuxer's AsyncIterable on demand —
  // for big files mp4box releases each batch's bytes after we consume
  // them, so the encoded-side memory footprint stays bounded.
  let stoppedEarly = false;
  for await (const c of samples) {
    if (pendingError) throw pendingError;
    if (nextTargetIdx >= targetsUs.length) {
      stoppedEarly = true;
      break;
    }
    while (decoder.decodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 1));
      if (pendingError) throw pendingError;
      if (nextTargetIdx >= targetsUs.length) {
        stoppedEarly = true;
        break;
      }
    }
    if (stoppedEarly) break;
    decoder.decode(
      new EncodedVideoChunk({
        type: c.isKey ? "key" : "delta",
        timestamp: c.timestampUs,
        duration: c.durationUs,
        data: c.data,
      }),
    );
  }
  if (stoppedEarly) {
    // Tell mp4box we don't need the rest so it stops buffering.
    await demuxed.cancel();
  }
  await decoder.flush();
  decoder.close();
  if (pendingError) throw pendingError;

  // Fill any remaining empty tiles by repeating the last drawn one — keeps
  // the strip visually continuous when the source ended a hair before the
  // final target timestamp.
  if (drawnCount === 0) {
    throw new Error("Frame extraction: decoder emitted no usable frames");
  }
  let lastFilled = -1;
  for (let i = 0; i < drawn.length; i++) {
    if (drawn[i]) lastFilled = i;
    else if (lastFilled >= 0) {
      ctx.drawImage(
        canvas,
        lastFilled * plan.tileWidth, 0, plan.tileWidth, plan.tileHeight,
        i * plan.tileWidth, 0, plan.tileWidth, plan.tileHeight,
      );
    }
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
