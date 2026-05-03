/**
 * Frame-strip extraction via ffmpeg.wasm — fallback for browsers that can't
 * use WebCodecs `VideoDecoder` for the source codec, or for sources whose
 * mp4box demux fails (rare; typically MKV/AVI containers).
 *
 * Pipeline mirrors the pre-frontend Python:
 *   ffmpeg -i in -vf "fps=1/<step>,scale=-1:<H>,tile=<N>x1" -q:v 3 sheet.webp
 */

import { getFfmpeg } from "../../codec/ffmpeg/ffmpeg-loader";
import { planTileStrip } from "./strategy";
import type { FrameStripResult } from "./types";

export interface FfmpegFrameStripOptions {
  /** Probed source duration in seconds. We can't query ffmpeg.wasm easily,
   *  so the caller (which usually already demuxed for sync) provides it. */
  durationS: number;
  sourceWidth: number;
  sourceHeight: number;
  tileHeight?: number;
  maxTiles?: number;
  /** Fired once with frac=1 when extraction completes. ffmpeg.wasm doesn't
   *  expose mid-pipe progress over a tractable API, so we don't try to fake
   *  one — the caller can map this onto its own progress range. */
  onProgress?: (frac: number) => void;
}

export async function extractFrameStripFfmpeg(
  source: Blob | ArrayBuffer,
  opts: FfmpegFrameStripOptions,
): Promise<FrameStripResult> {
  const plan = planTileStrip({
    durationS: opts.durationS,
    sourceWidth: opts.sourceWidth,
    sourceHeight: opts.sourceHeight,
    tileHeight: opts.tileHeight,
    maxTiles: opts.maxTiles,
  });
  if (plan.timestampsS.length === 0) {
    throw new Error("Frame extraction: planned zero tiles (zero-duration source?)");
  }

  // Step that recovers our centred tile timestamps. Using fps=1/step from
  // ffmpeg samples at 0, step, 2*step, … which is offset by half a step
  // relative to our centred plan, but for a thumbnail strip this is fine —
  // the human visual cadence is unchanged.
  const step = plan.timestampsS[1] !== undefined
    ? plan.timestampsS[1] - plan.timestampsS[0]
    : opts.durationS;

  const ffmpeg = await getFfmpeg();

  const inputName = `frames-in-${Date.now()}.bin`;
  const outputName = `frames-out-${Date.now()}.webp`;

  // Avoid @ffmpeg/util's `fetchFile` — it routes through a legacy FileReader
  // that rejects OPFS-backed Files on some Chromium builds. See sibling
  // ffmpeg/audio-decode.ts for the longer note.
  const data =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(await source.arrayBuffer());
  await ffmpeg.writeFile(inputName, data);

  const filter =
    `fps=1/${step.toFixed(6)},` +
    `scale=${plan.tileWidth}:${plan.tileHeight}:flags=lanczos,` +
    `tile=${plan.timestampsS.length}x1`;

  await ffmpeg.exec([
    "-y",
    "-i",
    inputName,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outputName,
  ]);

  const bytes = (await ffmpeg.readFile(outputName)) as Uint8Array;
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const blob = new Blob([bytes as BlobPart], { type: "image/webp" });
  opts.onProgress?.(1);

  return {
    blob,
    manifest: {
      tileCount: plan.timestampsS.length,
      tileWidth: plan.tileWidth,
      tileHeight: plan.tileHeight,
      durationS: opts.durationS,
      tileTimestampsS: plan.timestampsS,
      backend: "ffmpeg-wasm",
    },
  };
}
