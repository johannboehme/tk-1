/**
 * Codec resolver: a single entry point that picks the best backend per
 * operation. Callers (sync, render) don't know whether WebCodecs or
 * ffmpeg.wasm did the work — they only see PCM / chunks coming out.
 *
 * Routing strategy (capability-based, not size-based):
 *   1. **Streamable Blobs** (source is a `Blob`/`File` that sniffs as
 *      mp4 / mp3 / wav): route to the streaming decoder for that
 *      container — regardless of file size. The whole-file paths
 *      (`decodeAudioData`, ffmpeg.wasm MEMFS) decode into a single
 *      ArrayBuffer and blow up on long recordings: a 45 MB MP3 expands to
 *      ~1 GB of PCM and overflows Chromium's allocator long before the
 *      ~2 GiB ArrayBuffer cap. Streaming reads in 4 MiB batches and feeds
 *      WebCodecs `AudioDecoder` chunks at a time, so memory stays bounded.
 *      If streaming fails on a small file, we fall back to the whole-file
 *      path below.
 *   2. **Everything else** (non-streamable containers like ogg/flac/opus,
 *      or `ArrayBuffer` sources that can't be sliced incrementally): try
 *      WebCodecs `decodeAudioData` first, fall back to ffmpeg.wasm on
 *      failure.
 *
 * The result reports which backend won (`.backend`) so the UI can show it
 * to the user — that's the "Mechanismus-Indikator" requirement from the
 * plan: "es sollte ersichtlich sein, was für Mechanismen verwendet werden".
 */

import {
  decodeAudioToMonoPcm as webcodecsDecodeAudio,
  type DecodedAudio,
} from "./webcodecs/audio-decode";
import { sniffContainer } from "./streaming/sniff-container";

/** Fallback ceiling for streamable files. Streamable Blobs always try
 *  the streaming decoder first (see routing strategy above); if streaming
 *  *fails*, a file below this size falls back to the whole-file path,
 *  while a file at or above it surfaces the streaming error directly — a
 *  whole-file retry on something this large would only OOM. Well below
 *  Chromium's ArrayBuffer cap (~2 GiB). */
const STREAMING_THRESHOLD = 500 * 1024 * 1024;

let ffmpegAudioDecodeImpl:
  | ((source: Blob | ArrayBuffer, targetSampleRate: number) => Promise<DecodedAudio>)
  | null = null;

async function loadFfmpegAudioDecode() {
  if (!ffmpegAudioDecodeImpl) {
    const mod = await import("./ffmpeg/audio-decode");
    ffmpegAudioDecodeImpl = mod.decodeAudioToMonoPcmFfmpeg;
  }
  return ffmpegAudioDecodeImpl;
}

export interface CodecResolverOptions {
  /** Force a specific backend (escape hatch for debugging / tests).
   *  `streaming` picks the appropriate streaming sub-decoder by
   *  container sniff regardless of file size. */
  forceBackend?: "webcodecs" | "ffmpeg-wasm" | "streaming";
  /** Reports decode progress as a fraction in [0, 1]. The streaming
   *  sub-decoders report after each read batch (smooth on big files);
   *  the fast `decodeAudioData` and ffmpeg-wasm paths report 0 at the
   *  start and 1 at the end (no sub-progress available from those
   *  APIs). */
  onProgress?: (frac: number) => void;
}

export async function decodeAudioToMonoPcm(
  source: Blob | ArrayBuffer,
  targetSampleRate: number,
  opts: CodecResolverOptions = {},
): Promise<DecodedAudio> {
  if (opts.forceBackend === "ffmpeg-wasm") {
    opts.onProgress?.(0);
    const ffDecode = await loadFfmpegAudioDecode();
    const out = await ffDecode(source, targetSampleRate);
    opts.onProgress?.(1);
    return out;
  }
  if (opts.forceBackend === "webcodecs") {
    opts.onProgress?.(0);
    const out = await webcodecsDecodeAudio(source, targetSampleRate);
    opts.onProgress?.(1);
    return out;
  }
  if (opts.forceBackend === "streaming") {
    if (!(source instanceof Blob)) {
      throw new Error(
        "forceBackend='streaming' requires a Blob/File source (not ArrayBuffer)",
      );
    }
    return runStreamingDecode(source, targetSampleRate, opts.onProgress);
  }

  // Auto-route. Prefer the streaming decoder whenever the source is a Blob
  // whose container we can stream (mp3 / mp4 / wav) — independent of size.
  // The whole-file paths choke on long recordings, so streaming is the safe
  // default; non-streamable containers and ArrayBuffer sources drop through
  // to the whole-file path below.
  let streamingErr: unknown;
  if (source instanceof Blob && (await sniffContainer(source)) !== null) {
    try {
      return await runStreamingDecode(source, targetSampleRate, opts.onProgress);
    } catch (err) {
      // Above the fallback ceiling a whole-file retry would only OOM, so
      // surface the streaming failure directly.
      if (source.size >= STREAMING_THRESHOLD) throw err;
      streamingErr = err;
    }
  }

  // Whole-file path: ArrayBuffer source, non-streamable container, or a small
  // streamable file whose streaming decode failed. Try WebCodecs /
  // decodeAudioData first, fall back to ffmpeg.wasm on failure.
  opts.onProgress?.(0);
  let webcodecsErr: unknown;
  try {
    const out = await webcodecsDecodeAudio(source, targetSampleRate);
    opts.onProgress?.(1);
    return out;
  } catch (err) {
    if (err instanceof Error && /webkit|webcodecs/i.test(err.name)) {
      // give up, no fallback path can do better than the native decoder
      throw err;
    }
    webcodecsErr = err;
  }
  // Most decode failures (NotSupportedError, EncodingError, etc.) get
  // here. The decodeAudioData rejection types are notoriously inconsistent,
  // so we treat any failure as a signal to try the heavier backend.
  const ffDecode = await loadFfmpegAudioDecode();
  try {
    const out = await ffDecode(source, targetSampleRate);
    opts.onProgress?.(1);
    return out;
  } catch (ffErr) {
    // Both backends failed: chain the WebCodecs reason into the surfaced
    // error so the JobPage banner doesn't lose the diagnostic from the
    // primary path.
    const webMsg =
      webcodecsErr instanceof Error
        ? webcodecsErr.message
        : String(webcodecsErr);
    const ffMsg = ffErr instanceof Error ? ffErr.message : String(ffErr);
    const streamMsg =
      streamingErr !== undefined
        ? `; streaming: ${streamingErr instanceof Error ? streamingErr.message : String(streamingErr)}`
        : "";
    throw new Error(
      `Audio decode failed (ffmpeg: ${ffMsg}; webcodecs: ${webMsg}${streamMsg})`,
    );
  }
}

async function runStreamingDecode(
  source: Blob,
  targetSampleRate: number,
  onProgress?: (frac: number) => void,
): Promise<DecodedAudio> {
  const fmt = await sniffContainer(source);
  if (fmt === "mp4") {
    const mod = await import("./streaming/streaming-mp4-audio");
    return mod.decodeMp4AudioStreaming(source, targetSampleRate, { onProgress });
  }
  if (fmt === "mp3") {
    const mod = await import("./streaming/streaming-mp3");
    return mod.decodeMp3Streaming(source, targetSampleRate, { onProgress });
  }
  if (fmt === "wav") {
    const mod = await import("./streaming/streaming-wav");
    return mod.decodeWavStreaming(source, targetSampleRate, { onProgress });
  }
  throw new Error(
    `File is ${formatGiB(source.size)} and the container isn't streamable ` +
      `(only mp4/mov/m4a, mp3, wav supported in the streaming path). ` +
      `Re-encode at a lower bitrate or convert before importing.`,
  );
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export type { DecodedAudio };
