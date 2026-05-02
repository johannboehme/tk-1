/**
 * mp4box.js demux wrapper.
 *
 * Provides two operations the rest of the app needs:
 *   * `openVideoDemux` — returns track info + an AsyncIterable of
 *     encoded chunks. Streaming-friendly on the consumer side (chunks
 *     yielded one at a time so callers can apply backpressure on the
 *     decoder). The producer currently loads the whole source into
 *     mp4box in one shot — see notes below for why true streaming
 *     demux for moov-last big files isn't wired in yet.
 *   * `demuxVideoTrack` — convenience wrapper that materialises the
 *     AsyncIterable to a chunks array. Suitable for small files /
 *     fixtures; for large sources prefer `openVideoDemux` and iterate.
 *
 * Big-file note: for files above the WebCodecs-AudioDecoder streaming
 * threshold (~500 MiB), `source.arrayBuffer()` will throw a RangeError
 * (Chromium ArrayBuffer cap). The audio-only sync path uses a
 * dedicated streaming MP4 audio decoder
 * (`streaming/streaming-mp4-audio.ts`) that works for arbitrarily
 * large files via mp4box's chunked appendBuffer + moov-prefetch.
 * Wiring the same trick into the video-side `openVideoDemux` is
 * tracked as future work — mp4box's `processSamples` for the video
 * track currently doesn't fire after a moov-prefetched chunked feed
 * even though it does fire reliably for the audio track from the
 * same file (root cause TBD).
 */

import { createFile, DataStream, type Movie, type Sample, type ISOFile } from "mp4box";

export interface VideoTrackInfo {
  trackId: number;
  codec: string;            // e.g. "avc1.42E01F"
  /** Stored pixel dimensions (codec-level). For rotated phone recordings
   *  this is the recorded landscape size, NOT what the user sees in a
   *  player — see `rotationDeg` for the matrix that transforms stored to
   *  displayed pixels. */
  width: number;
  height: number;
  durationS: number;
  fps: number;
  /** Display rotation in degrees clockwise to apply to stored pixels for
   *  correct display, snapped to {0, 90, 180, 270}. Decoded from the
   *  track's `tkhd` matrix; phone recordings held in portrait carry 90 or
   *  270 here. The render compositor must apply this transform — without
   *  it, portrait recordings come out sideways even though preview (which
   *  renders through the browser's native `<video>`) honours it. */
  rotationDeg: 0 | 90 | 180 | 270;
  /** Avc decoder configuration record (the contents of the `avcC` box). */
  description: Uint8Array;
}

/**
 * Decode a 9-element ISO Base Media transform matrix (16.16 / 2.30 fixed
 * point) into the integer rotation it encodes. Returns 0 when the matrix
 * is missing, identity, or doesn't decode to a clean 90° multiple — in
 * those cases the renderer treats the frames as already-upright.
 */
export function rotationDegFromMatrix(
  matrix: ArrayLike<number> | undefined,
): 0 | 90 | 180 | 270 {
  if (!matrix || matrix.length < 5) return 0;
  // Elements [0,1,3,4] = [a, b, c, d] of the 2D rotation/scale block. For
  // a pure rotation tan(angle) = b/a; atan2 handles every quadrant
  // including the a=0 ones (90°, 270°).
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  const rad = Math.atan2(b, a);
  // Snap to the nearest 90°. ISO matrices come from a fixed set of
  // rotations (0/90/180/270) so anything else is numerical noise.
  const snapped = Math.round((rad * 180) / Math.PI / 90) * 90;
  const norm = ((snapped % 360) + 360) % 360;
  if (norm === 90 || norm === 180 || norm === 270) return norm;
  return 0;
}

export interface VideoChunk {
  /** Microseconds since start. */
  timestampUs: number;
  durationUs: number;
  isKey: boolean;
  data: Uint8Array;
}

export interface VideoDemuxResult {
  info: VideoTrackInfo;
  chunks: VideoChunk[];
}

/** Streaming-friendly view of a demuxed video track. Iterate samples
 *  via `for await`; the iterator is single-pass. Call `cancel()` if
 *  you want to stop early so the underlying file reader can close. */
export interface DemuxedVideoStream {
  info: VideoTrackInfo;
  samples: AsyncIterable<VideoChunk>;
  cancel(): Promise<void>;
}

interface MP4BoxFileBuffer extends ArrayBuffer {
  fileStart: number;
}

/**
 * Open a demuxer. Loads the whole source into mp4box in one shot;
 * exposes the resulting samples as an `AsyncIterable<VideoChunk>` so
 * consumers can apply backpressure on the decoder. Returns null when
 * the source has no parsable video track.
 *
 * For sources above ~2 GiB, `source.arrayBuffer()` will throw a
 * RangeError (Chromium ArrayBuffer cap). The audio-extraction path for
 * the sync algorithm uses a separate streaming decoder that handles
 * arbitrarily large files; video-side streaming demux is future work.
 */
export async function openVideoDemux(
  source: Blob | ArrayBuffer,
): Promise<DemuxedVideoStream | null> {
  const eagerBytes: ArrayBuffer =
    source instanceof ArrayBuffer ? source : await source.arrayBuffer();

  const file = createFile();

  // ---- Pump samples into a queue read by an async iterator. ----
  type QueueEvent =
    | { kind: "chunk"; chunk: VideoChunk; sampleNumber: number }
    | { kind: "done" }
    | { kind: "error"; err: Error };

  const queue: QueueEvent[] = [];
  const waiters: Array<() => void> = [];
  let cancelled = false;
  let fileError: Error | null = null;

  function pushEvent(ev: QueueEvent): void {
    queue.push(ev);
    const w = waiters.shift();
    if (w) w();
  }

  // Async-resolved once mp4box has parsed moov + we have track info.
  // Resolves to null for sources without a video track (mirrors the
  // old behavior).
  let resolveInfo!: (v: VideoTrackInfo | null) => void;
  let rejectInfo!: (err: Error) => void;
  const infoPromise = new Promise<VideoTrackInfo | null>((res, rej) => {
    resolveInfo = res;
    rejectInfo = rej;
  });

  let trackId: number | null = null;

  file.onError = (err: string) => {
    fileError = new Error(`mp4box: ${err}`);
    rejectInfo(fileError);
    pushEvent({ kind: "error", err: fileError });
  };

  file.onReady = (movie: Movie) => {
    try {
      const videoTrack = movie.videoTracks?.[0] ?? null;
      if (!videoTrack) {
        resolveInfo(null);
        // Push a `done` so any iterator that started consuming gets a
        // clean end. Callers usually check `info === null` first and
        // never iterate, but be defensive.
        pushEvent({ kind: "done" });
        return;
      }
      const desc = extractDecoderDescription(file, videoTrack.id);
      if (!desc) {
        const err = new Error("Could not extract video decoder description (avcC).");
        fileError = err;
        rejectInfo(err);
        pushEvent({ kind: "error", err });
        return;
      }
      const videoMeta = videoTrack.video;
      if (!videoMeta) {
        const err = new Error("Video track has no `video` metadata.");
        fileError = err;
        rejectInfo(err);
        pushEvent({ kind: "error", err });
        return;
      }
      const info: VideoTrackInfo = {
        trackId: videoTrack.id,
        codec: videoTrack.codec,
        width: videoMeta.width,
        height: videoMeta.height,
        durationS: videoTrack.duration / videoTrack.timescale,
        fps:
          videoTrack.nb_samples /
          (videoTrack.duration / videoTrack.timescale || 1),
        rotationDeg: rotationDegFromMatrix(
          (videoTrack as { matrix?: ArrayLike<number> }).matrix,
        ),
        description: desc,
      };
      trackId = videoTrack.id;
      file.setExtractionOptions(videoTrack.id, null, { nbSamples: 1000 });
      file.start();
      resolveInfo(info);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      fileError = err;
      rejectInfo(err);
      pushEvent({ kind: "error", err });
    }
  };

  file.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
    if (cancelled || trackId === null || id !== trackId) return;
    let lastNumber = -1;
    for (const s of samples) {
      pushEvent({
        kind: "chunk",
        sampleNumber: s.number,
        chunk: {
          timestampUs: (s.cts * 1_000_000) / s.timescale,
          durationUs: (s.duration * 1_000_000) / s.timescale,
          isKey: s.is_sync,
          data: new Uint8Array(s.data as unknown as ArrayBuffer),
        },
      });
      lastNumber = s.number;
    }
    if (lastNumber >= 0) {
      file.releaseUsedSamples(trackId, lastNumber + 1);
    }
  };

  // ---- Drive the mp4box feed. Single eager appendBuffer; the
  //      AsyncIterable on the consumer side still gives us
  //      backpressure-friendly semantics for the decoder pipeline. ----

  let cancelFeeder: () => Promise<void>;
  const feedPromise = (async () => {
    try {
      const buf = eagerBytes as MP4BoxFileBuffer;
      buf.fileStart = 0;
      file.appendBuffer(buf as never);
      file.flush();
      // mp4box delivers samples synchronously after start() in our flow
      // (entire file is in memory), so we yield to the microtask queue
      // and then signal end-of-stream.
      await Promise.resolve();
      pushEvent({ kind: "done" });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!fileError) {
        fileError = err;
        try { rejectInfo(err); } catch { /* already settled */ }
      }
      pushEvent({ kind: "error", err });
    }
  })();
  cancelFeeder = async () => {
    // Eager feed already finished (or will finish synchronously) — just
    // mark cancelled so the iterator returns done on its next call.
    cancelled = true;
  };

  // Block until we know the info (or it failed).
  let info: VideoTrackInfo | null;
  try {
    info = await infoPromise;
  } catch (e) {
    // Make sure the feeder finishes (it might be mid-flight) before we
    // bubble. Don't await its promise rejection.
    void feedPromise.catch(() => undefined);
    throw e;
  }
  if (info === null) {
    // No video track. Iterator will end immediately.
    void feedPromise.catch(() => undefined);
    return null;
  }

  // ---- Async iterator that drains the queue. ----
  const iterableInfo = info;
  const samples: AsyncIterable<VideoChunk> = {
    [Symbol.asyncIterator](): AsyncIterator<VideoChunk> {
      return {
        async next(): Promise<IteratorResult<VideoChunk>> {
          for (;;) {
            if (queue.length > 0) {
              const ev = queue.shift()!;
              if (ev.kind === "chunk") {
                return { value: ev.chunk, done: false };
              }
              if (ev.kind === "done") {
                return { value: undefined as unknown as VideoChunk, done: true };
              }
              throw ev.err;
            }
            if (cancelled) {
              return { value: undefined as unknown as VideoChunk, done: true };
            }
            await new Promise<void>((res) => waiters.push(res));
          }
        },
        async return(): Promise<IteratorResult<VideoChunk>> {
          cancelled = true;
          await cancelFeeder();
          // Wake any sleeping iterator users.
          const w = waiters.shift();
          if (w) w();
          return { value: undefined as unknown as VideoChunk, done: true };
        },
      };
    },
  };

  return {
    info: iterableInfo,
    samples,
    async cancel(): Promise<void> {
      cancelled = true;
      await cancelFeeder();
      // Wake any sleeping iterator users.
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w();
      }
    },
  };
}

/**
 * Reads an MP4/MOV and returns the first video track's chunks + decoder
 * config. Returns null if there is no video track.
 *
 * Convenience wrapper around `openVideoDemux` for callers that want all
 * chunks materialised as an array. Suitable for files small enough that
 * holding every chunk in RAM is acceptable (tests, fixtures, the
 * sub-streaming-threshold path). For large sources prefer
 * `openVideoDemux` and iterate the `samples` AsyncIterable.
 */
export async function demuxVideoTrack(
  source: Blob | ArrayBuffer,
): Promise<VideoDemuxResult | null> {
  const stream = await openVideoDemux(source);
  if (!stream) return null;
  const chunks: VideoChunk[] = [];
  for await (const c of stream.samples) chunks.push(c);
  return { info: stream.info, chunks };
}

/**
 * Extracts the decoder configuration (avcC for AVC, hvcC for HEVC) by
 * walking the box tree directly. Returns the inner box payload bytes
 * (not the 8-byte box header), which is exactly what WebCodecs and
 * mp4-muxer expect as the `description`.
 */
function extractDecoderDescription(file: ISOFile, trackId: number): Uint8Array | null {
  const trakBox = file.getTrackById(trackId) as unknown as TrakBox | undefined;
  if (!trakBox) return null;
  const stsd = trakBox.mdia?.minf?.stbl?.stsd;
  if (!stsd) return null;
  const entry = stsd.entries?.[0] as unknown as SampleEntryBox | undefined;
  if (!entry) return null;

  const candidate =
    entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC ?? null;
  if (!candidate) return null;

  // mp4box doesn't keep raw `.data` for these boxes by default; we serialise
  // the box back to bytes via DataStream then strip the 8-byte box header
  // (size + type). The remaining payload is exactly the
  // AVCDecoderConfigurationRecord (or HEVCDecoderConfigurationRecord, etc.)
  // that WebCodecs and mp4-muxer expect as `description`.
  const stream = new (DataStream as unknown as new (
    arr?: ArrayBufferLike,
    offset?: number,
    endianness?: number,
  ) => DataStreamLike)(undefined, 0, 1 /* BIG_ENDIAN */);
  (candidate as { write: (s: DataStreamLike) => void }).write(stream);
  return new Uint8Array(stream.buffer, 8);
}

/* ---- mp4box internal types we depend on (declared loosely) ---- */
interface TrakBox {
  mdia?: { minf?: { stbl?: { stsd?: { entries?: SampleEntryBox[] } } } };
}
interface ConfigBox {
  data?: Uint8Array;
  write: (s: DataStreamLike) => void;
}
interface SampleEntryBox {
  avcC?: ConfigBox;
  hvcC?: ConfigBox;
  av1C?: ConfigBox;
  vpcC?: ConfigBox;
}
interface DataStreamLike {
  buffer: ArrayBuffer;
}
