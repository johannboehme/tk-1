/**
 * mp4box.js demux wrapper.
 *
 * Provides two operations the rest of the app needs:
 *   * `openVideoDemux` — returns track info + an `AsyncIterable<VideoChunk>`
 *     that streams encoded samples from disk. Bounded memory regardless of
 *     source size: we only ever hold one sample's worth of bytes (~hundreds
 *     of KB for high-bitrate H.264) plus mp4box's parsed moov state.
 *   * `demuxVideoTrack` — convenience wrapper that materialises the
 *     AsyncIterable to a chunks array. Suitable for small fixtures /
 *     tests; for large sources prefer `openVideoDemux` and iterate.
 *
 * Architecture:
 *   1. Probe the head (64 KiB) and tail of the source to locate the
 *      `moov` box. Phone recordings and screen recorders write `mdat`
 *      first and `moov` last.
 *   2. Feed mp4box ONLY [head] + [moov bytes] (out of order via
 *      `appendBuffer({fileStart})`) so it can parse the track structure.
 *      We never hand it the multi-GB mdat body.
 *   3. After `onReady`, read the per-track sample table directly from
 *      mp4box's parsed structure (`trakBox.samples[]`). Each entry
 *      carries `{offset, size, cts, dts, duration, is_sync, timescale}`.
 *   4. The AsyncIterable yields each sample by `source.slice(offset,
 *      offset+size).arrayBuffer()` — random-access reads, no buffering.
 *
 * Why we bypass mp4box's `processSamples` / `onSamples` for the video
 * track: it requires contiguous bytes from byte 0 onward to fire (audio
 * tracks happen to work via moov-prefetched chunked feed, video doesn't
 * — root cause is in mp4box's per-track sample dispatcher and would need
 * fixing upstream). Reading sample bytes via `Blob.slice` is what mp4box
 * itself would do internally; we just skip its buffer-tracking layer.
 */

import { createFile, DataStream, type Movie, type Sample, type ISOFile } from "mp4box";
import { locateMoov } from "../streaming/mp4-moov-locator";

const HEAD_PROBE_BYTES = 64 * 1024;

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

/** Per-sample metadata extracted from the parsed `stbl` (no bytes —
 *  use `loadSample(idx)` to fetch the encoded bytes for one sample on
 *  demand). The array is in decode order; `cts` is in `timescale`
 *  ticks. */
export interface SampleMeta {
  /** Byte offset in the source. */
  offset: number;
  /** Byte length of this sample's encoded data. */
  size: number;
  /** Composition timestamp (presentation order) in track-timescale ticks. */
  cts: number;
  /** Decode timestamp in track-timescale ticks. */
  dts: number;
  /** Sample duration in track-timescale ticks. */
  duration: number;
  /** Track timescale (ticks per second). */
  timescale: number;
  /** True for keyframes (RAP / sync samples) — every random-access
   *  decoder restart point. Frame-strip extractors only ever need to
   *  decode keyframes when tile spacing is wider than the keyframe
   *  interval. */
  isKey: boolean;
}

/** Streaming-friendly view of a demuxed video track.
 *
 * Two consumption modes:
 *   - `samples` — single-pass `AsyncIterable<VideoChunk>` that yields
 *     every encoded sample in decode order. Use this when you need
 *     all chunks (full-file render).
 *   - `sampleTable` + `loadSample(idx)` — sample metadata is parsed
 *     upfront (cheap, sub-MB even for hour-long recordings); fetch
 *     individual sample bytes on demand. Use this for sparse access:
 *     thumbnail strips, scrubbing, keyframe-only browsing.
 *
 * Call `cancel()` to abandon any pending byte-fetches.
 */
export interface DemuxedVideoStream {
  info: VideoTrackInfo;
  samples: AsyncIterable<VideoChunk>;
  /** All samples' metadata, in decode order. */
  sampleTable: ReadonlyArray<SampleMeta>;
  /** Fetch one sample's encoded bytes. Random-access, no buffering. */
  loadSample(idx: number): Promise<VideoChunk>;
  cancel(): Promise<void>;
}

interface MP4BoxFileBuffer extends ArrayBuffer {
  fileStart: number;
}

/**
 * Open a demuxer. Memory-bounded for arbitrarily-sized sources: only
 * the head + moov are buffered for parsing; sample bytes are read on
 * demand via `Blob.slice`. Returns null when the source has no
 * parsable video track.
 */
export async function openVideoDemux(
  source: Blob | ArrayBuffer,
): Promise<DemuxedVideoStream | null> {
  const blob = source instanceof Blob ? source : new Blob([source]);

  const file = createFile();

  // Block until mp4box parses the moov — we listen via onReady.
  let resolveInfo!: (v: { info: VideoTrackInfo; trackId: number } | null) => void;
  let rejectInfo!: (err: Error) => void;
  const infoPromise = new Promise<{ info: VideoTrackInfo; trackId: number } | null>(
    (res, rej) => {
      resolveInfo = res;
      rejectInfo = rej;
    },
  );

  file.onError = (err: string) => {
    rejectInfo(new Error(`mp4box: ${err}`));
  };

  file.onReady = (movie: Movie) => {
    try {
      const videoTrack = movie.videoTracks?.[0] ?? null;
      if (!videoTrack) {
        resolveInfo(null);
        return;
      }
      const desc = extractDecoderDescription(file, videoTrack.id);
      if (!desc) {
        rejectInfo(new Error("Could not extract video decoder description (avcC)."));
        return;
      }
      const videoMeta = videoTrack.video;
      if (!videoMeta) {
        rejectInfo(new Error("Video track has no `video` metadata."));
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
      resolveInfo({ info, trackId: videoTrack.id });
    } catch (e) {
      rejectInfo(e instanceof Error ? e : new Error(String(e)));
    }
  };

  // Feed mp4box only what it needs to parse the moov.
  // 1. Head (ftyp + start of mdat header).
  // 2. moov bytes (probably at the tail for phone recordings).
  // For moov-first files, the head probe alone may already include moov;
  // in that case `locateMoov` returns offset < headSize and we skip the
  // out-of-order append.
  const headSize = Math.min(HEAD_PROBE_BYTES, blob.size);
  const head = new Uint8Array(await blob.slice(0, headSize).arrayBuffer());
  appendBytes(file, head, 0);

  // If onReady already fired (moov was inside head), we don't need to
  // locate it. Use Promise.race with a microtask check to avoid an
  // unnecessary tail fetch.
  let infoOrNull = await Promise.race([
    infoPromise,
    Promise.resolve(undefined),
  ]);
  if (infoOrNull === undefined) {
    // Need more bytes. Locate moov in the tail and feed it.
    const moov = await locateMoov(blob);
    if (moov && moov.offset >= headSize) {
      appendBytes(file, moov.bytes, moov.offset);
    } else if (!moov) {
      throw new Error("mp4box: moov box not found in source");
    }
    file.flush();
    infoOrNull = await infoPromise;
  } else {
    file.flush();
  }

  if (infoOrNull === null) return null;
  const { info, trackId } = infoOrNull;

  // Pull the sample table mp4box built when it parsed the stbl. This
  // gives us per-sample {offset, size, cts, dts, duration, is_sync,
  // timescale} for every sample without ever reading mdat. We project
  // it into our slim `SampleMeta` shape so callers don't depend on
  // mp4box's internal `Sample` type.
  const trak = file.getTrackById(trackId) as unknown as { samples?: Sample[] } | undefined;
  const rawSamples = trak?.samples ?? [];
  if (rawSamples.length === 0) {
    throw new Error("mp4box: video track has no samples in its sample table");
  }
  const sampleTable: SampleMeta[] = rawSamples.map((s) => ({
    offset: s.offset,
    size: s.size,
    cts: s.cts,
    dts: s.dts,
    duration: s.duration,
    timescale: s.timescale,
    isKey: s.is_sync,
  }));

  let cancelled = false;

  async function loadSample(idx: number): Promise<VideoChunk> {
    if (idx < 0 || idx >= sampleTable.length) {
      throw new RangeError(
        `loadSample: idx ${idx} out of range [0..${sampleTable.length})`,
      );
    }
    const s = sampleTable[idx];
    const data = new Uint8Array(
      await blob.slice(s.offset, s.offset + s.size).arrayBuffer(),
    );
    return {
      timestampUs: (s.cts * 1_000_000) / s.timescale,
      durationUs: (s.duration * 1_000_000) / s.timescale,
      isKey: s.isKey,
      data,
    };
  }

  const samples: AsyncIterable<VideoChunk> = {
    [Symbol.asyncIterator](): AsyncIterator<VideoChunk> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<VideoChunk>> {
          while (i < sampleTable.length) {
            if (cancelled) {
              return { value: undefined as unknown as VideoChunk, done: true };
            }
            return { value: await loadSample(i++), done: false };
          }
          return { value: undefined as unknown as VideoChunk, done: true };
        },
        async return(): Promise<IteratorResult<VideoChunk>> {
          cancelled = true;
          return { value: undefined as unknown as VideoChunk, done: true };
        },
      };
    },
  };

  return {
    info,
    samples,
    sampleTable,
    loadSample,
    async cancel(): Promise<void> {
      cancelled = true;
    },
  };
}

/**
 * Reads an MP4/MOV and returns the first video track's chunks + decoder
 * config. Returns null if there is no video track.
 *
 * Convenience wrapper around `openVideoDemux` for callers that want all
 * chunks materialised as an array. Suitable for small files / fixtures
 * where the chunk array fits comfortably in memory; for large sources
 * prefer `openVideoDemux` and iterate the `samples` AsyncIterable.
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

function appendBytes(file: ISOFile, bytes: Uint8Array, fileStart: number): void {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  (ab as MP4BoxFileBuffer).fileStart = fileStart;
  file.appendBuffer(ab as never);
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
