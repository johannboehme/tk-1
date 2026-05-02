/**
 * Streaming MP4 / MOV / M4A audio decoder.
 *
 * Pipeline:
 *   1. `chunkedReader(file)` walks the Blob in 4 MiB batches.
 *   2. Each batch is fed to mp4box.js via `appendBuffer({fileStart})`.
 *   3. mp4box's `onReady` fires once the moov is parsed → we extract the
 *      audio track's codec config and configure `AudioDecoder`.
 *   4. mp4box's `onSamples` fires repeatedly as we feed bytes → each
 *      sample becomes an `EncodedAudioChunk` we push to the decoder.
 *      After each batch we call `releaseUsedSamples(...)` so mp4box
 *      drops the underlying bytes (mp4box.js issues #393, #430).
 *   5. Decoder's output callback feeds the resampler.
 *   6. After EOF: `decoder.flush()` → `resampler.finish()` → DecodedAudio.
 *
 * Memory profile (independent of source file size):
 *   - 4 MiB read buffer
 *   - mp4box state (moov + remaining sample tables): O(track samples not
 *     yet released). With aggressive `releaseUsedSamples`, this stays
 *     ≤ ~50 MB on multi-hour files.
 *   - Decoder pending queue: ≤ DECODE_QUEUE_SOFT_CAP frames in flight.
 *   - PCM accumulator: 88 KB / second @ 22050 mono — not avoidable, used
 *     by the sync algorithm.
 */

import { createFile, type Movie, type Sample, type ISOFile } from "mp4box";
import { chunkedReader } from "./file-stream-reader";
import { createMonoResampler } from "./resampler";
import { locateMoov } from "./mp4-moov-locator";
import type { DecodedAudio } from "../webcodecs/audio-decode";

const DECODE_QUEUE_SOFT_CAP = 16;
/** First N bytes we always read upfront. Phone recordings put `ftyp`
 *  + a 16-byte 64-bit `mdat` header in the first ~48 bytes; 64 KiB is
 *  generous headroom for non-standard prelude boxes. */
const HEAD_PROBE_BYTES = 64 * 1024;

interface MP4BoxFileBuffer extends ArrayBuffer {
  fileStart: number;
}

interface AudioTrackInfo {
  trackId: number;
  codec: string; // e.g. "mp4a.40.2"
  sampleRate: number;
  channelCount: number;
  /** AudioSpecificConfig bytes for AAC (DecoderSpecificInfo from esds).
   *  Empty for codecs that don't need it. */
  description?: Uint8Array;
  timescale: number;
}

export async function decodeMp4AudioStreaming(
  source: Blob,
  targetSampleRate: number,
): Promise<DecodedAudio> {
  if (typeof AudioDecoder === "undefined") {
    throw new Error(
      "Streaming MP4 audio decode requires WebCodecs AudioDecoder " +
        "(Chrome/Edge/Brave)",
    );
  }

  const file = createFile();
  const resampler = createMonoResampler({ targetSampleRate });

  const decoderErrors: Error[] = [];
  // Capture via object refs so TypeScript's control-flow narrowing
  // doesn't think the closure assignments never happen.
  const state: {
    decoder: AudioDecoder | null;
    trackInfo: AudioTrackInfo | null;
    sawSamples: boolean;
    mp4boxError: Error | null;
  } = { decoder: null, trackInfo: null, sawSamples: false, mp4boxError: null };

  // Promise that resolves once mp4box has parsed the moov box and we've
  // configured the decoder. We MUST wait for this before flushing — sample
  // callbacks before configuration would silently drop frames.
  let resolveReady: () => void;
  let rejectReady: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  file.onError = (err: string) => {
    state.mp4boxError = new Error(`mp4box: ${err}`);
    rejectReady(state.mp4boxError);
  };

  file.onReady = (movie: Movie) => {
    try {
      const audioTrack = movie.audioTracks?.[0] ?? null;
      if (!audioTrack) {
        state.mp4boxError = new Error("MP4 has no audio track");
        rejectReady(state.mp4boxError);
        return;
      }
      const audioMeta = (audioTrack as { audio?: { sample_rate?: number; channel_count?: number } }).audio;
      const description = extractAudioDescription(file, audioTrack.id);
      const trackInfo: AudioTrackInfo = {
        trackId: audioTrack.id,
        codec: audioTrack.codec,
        sampleRate: audioMeta?.sample_rate ?? 48000,
        channelCount: audioMeta?.channel_count ?? 2,
        description,
        timescale: audioTrack.timescale,
      };
      state.trackInfo = trackInfo;
      const dec = new AudioDecoder({
        output: (frame) => {
          try {
            feedAudioFrame(frame, resampler);
          } finally {
            frame.close();
          }
        },
        error: (e) => decoderErrors.push(e),
      });
      state.decoder = dec;
      const config: AudioDecoderConfig = {
        codec: trackInfo.codec,
        sampleRate: trackInfo.sampleRate,
        numberOfChannels: trackInfo.channelCount,
      };
      if (trackInfo.description && trackInfo.description.length > 0) {
        config.description = trackInfo.description;
      }
      dec.configure(config);
      file.setExtractionOptions(trackInfo.trackId, null, { nbSamples: 1000 });
      file.start();
      resolveReady();
    } catch (e) {
      state.mp4boxError = e instanceof Error ? e : new Error(String(e));
      rejectReady(state.mp4boxError);
    }
  };

  file.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
    const dec = state.decoder;
    const trackInfo = state.trackInfo;
    if (!dec || !trackInfo || id !== trackInfo.trackId) return;
    state.sawSamples = true;
    let lastSampleNumber = -1;
    for (const s of samples) {
      const timestampUs = (s.cts * 1_000_000) / s.timescale;
      dec.decode(
        new EncodedAudioChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: timestampUs,
          duration: (s.duration * 1_000_000) / s.timescale,
          data: new Uint8Array(s.data as unknown as ArrayBuffer),
        }),
      );
      lastSampleNumber = s.number;
    }
    // Drop everything mp4box is holding for already-queued samples.
    if (lastSampleNumber >= 0) {
      file.releaseUsedSamples(trackInfo.trackId, lastSampleNumber + 1);
    }
  };

  // Many phone recordings / screen recorders write `mdat` first and
  // `moov` last (no rewind needed when the recording stops). Sequential
  // streaming would have to buffer the entire mdat before mp4box could
  // parse moov — useless for a 9 GB file. So: probe the head + locate
  // the moov in the tail, feed both upfront with their real fileStart
  // offsets. mp4box parses ftyp + jumps over the mdat-by-header-size,
  // hits the out-of-order moov, fires onReady. Then we stream the mdat
  // body sequentially and `onSamples` fires as bytes accumulate.
  const head = new Uint8Array(
    await source.slice(0, Math.min(HEAD_PROBE_BYTES, source.size)).arrayBuffer(),
  );
  const moov = await locateMoov(source);
  const moovIsAfterHead = moov !== null && moov.offset >= head.length;

  // Always feed the head first (covers ftyp + moov-first files entirely).
  appendBytes(file, head, 0);

  // For moov-last files, also feed moov out-of-order so onReady fires
  // before we stream the giant mdat body.
  if (moov && moovIsAfterHead) {
    appendBytes(file, moov.bytes, moov.offset);
  }

  // Stream the body. For moov-first files (or files where the head
  // probe already covered the whole thing) we just continue from
  // head.length to source.size. For moov-last files we want to skip
  // the moov range we already fed (no harm in re-feeding overlapping
  // bytes, but it's wasted disk read on a multi-GB file).
  const bodyStart = head.length;
  const bodyEnd = moov && moovIsAfterHead ? moov.offset : source.size;
  const reader = chunkedReader(source.slice(bodyStart, bodyEnd));
  try {
    for (;;) {
      if (state.mp4boxError) throw state.mp4boxError;
      const batch = await reader.next();
      if (batch === null) break;
      const fileStart = bodyStart + (reader.position - batch.length);
      appendBytes(file, batch, fileStart);
      // Apply backpressure between batches if the decoder is saturated.
      const dec = state.decoder;
      if (dec && dec.decodeQueueSize > DECODE_QUEUE_SOFT_CAP) {
        await waitForDrain(dec, DECODE_QUEUE_SOFT_CAP / 2);
        if (decoderErrors.length > 0) break;
      }
    }
    file.flush();
  } finally {
    await reader.cancel();
  }

  // If onReady never fired (file had no parsable moov), bail out.
  if (state.mp4boxError) throw state.mp4boxError;
  await ready; // resolves once onReady ran (or already did)
  const dec = state.decoder;
  if (!dec || !state.trackInfo) {
    throw new Error("MP4 audio: decoder never got configured");
  }
  if (!state.sawSamples) {
    throw new Error("MP4 audio: no audio samples extracted");
  }

  try {
    await dec.flush();
  } catch (e) {
    if (e instanceof Error) decoderErrors.push(e);
  }
  dec.close();

  if (decoderErrors.length > 0) {
    throw new Error(
      `MP4 audio decode failed: ` +
        decoderErrors.map((e) => e.message).join("; "),
    );
  }

  const pcm = resampler.finish();
  return {
    pcm,
    sampleRate: targetSampleRate,
    durationS: pcm.length / targetSampleRate,
    backend: "webcodecs",
  };
}

function feedAudioFrame(
  frame: AudioData,
  resampler: ReturnType<typeof createMonoResampler>,
): void {
  const ch = frame.numberOfChannels;
  const frames = frame.numberOfFrames;
  const rate = frame.sampleRate;
  if (frame.format === "f32-planar" || frame.format === "f32") {
    const channels: Float32Array[] = [];
    for (let c = 0; c < ch; c++) {
      const buf = new Float32Array(frames);
      frame.copyTo(buf, { planeIndex: c, format: "f32-planar" });
      channels.push(buf);
    }
    resampler.pushPlanar(channels, rate);
    return;
  }
  const total = ch * frames;
  const buf = new Float32Array(total);
  frame.copyTo(buf, { planeIndex: 0, format: "f32" });
  resampler.pushInterleaved(buf, ch, rate);
}

async function waitForDrain(
  decoder: AudioDecoder,
  target: number,
): Promise<void> {
  for (let i = 0; i < 50 && decoder.decodeQueueSize > target; i++) {
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

function sliceToFreshArrayBuffer(view: Uint8Array): ArrayBuffer {
  // Always copy: `view.buffer` is `ArrayBufferLike` (could be a
  // SharedArrayBuffer in theory) and mp4box wants a strict ArrayBuffer.
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function appendBytes(file: ISOFile, bytes: Uint8Array, fileStart: number): void {
  const ab = sliceToFreshArrayBuffer(bytes);
  (ab as MP4BoxFileBuffer).fileStart = fileStart;
  file.appendBuffer(ab as never);
}

interface EsdsLikeBox {
  data?: Uint8Array;
  esds?: { data?: Uint8Array };
  write?: (s: unknown) => void;
}

/**
 * Extract the audio decoder description (AudioSpecificConfig bytes for
 * AAC, equivalent for ALAC/FLAC). Walks mp4box's parsed sample entry
 * to find the `esds` box and pulls out the DecoderSpecificInfo (tag
 * 0x05). Returns undefined for codecs that don't need a description
 * (e.g. some Opus-in-MP4 paths).
 */
function extractAudioDescription(
  file: ISOFile,
  trackId: number,
): Uint8Array | undefined {
  const trakBox = file.getTrackById(trackId) as unknown as {
    mdia?: {
      minf?: {
        stbl?: {
          stsd?: { entries?: EsdsLikeBox[] };
        };
      };
    };
  };
  const stsd = trakBox?.mdia?.minf?.stbl?.stsd;
  if (!stsd) return undefined;
  const entry = stsd.entries?.[0];
  if (!entry) return undefined;

  // mp4box exposes esds as either entry.esds (newer) or as a child box
  // accessible via box-typed lookups. Try the simple property first.
  const esds = entry.esds;
  const esdsBytes = esds?.data;
  if (!esdsBytes) return undefined;

  return extractAacAsc(esdsBytes);
}

/**
 * Walk an ESDS box payload to find the DecoderSpecificInfo (tag 0x05)
 * which holds the AudioSpecificConfig. ESDS structure:
 *
 *   esds box payload:
 *     [4 bytes version+flags]
 *     ES_Descriptor (tag 0x03)
 *       [2 bytes ES_ID][1 byte flags]
 *       (optional skipped fields gated by flags)
 *       DecoderConfigDescriptor (tag 0x04)
 *         [13 bytes fixed fields]
 *         DecoderSpecificInfo (tag 0x05)
 *           [bytes]            ← what we want
 *
 * Each descriptor has a 1-byte tag followed by a variable-length size
 * (1-4 bytes, MSB-continuation encoding).
 */
function extractAacAsc(esdsBytes: Uint8Array): Uint8Array | undefined {
  let pos = 4; // skip version + flags
  // Parse ES_Descriptor
  if (pos >= esdsBytes.length || esdsBytes[pos] !== 0x03) return undefined;
  pos += 1;
  pos = skipDescriptorSize(esdsBytes, pos);
  if (pos < 0 || pos + 3 > esdsBytes.length) return undefined;
  pos += 2; // ES_ID
  const flags = esdsBytes[pos++];
  if ((flags >> 7) & 1) pos += 2; // streamDependenceFlag
  if ((flags >> 6) & 1) {
    if (pos >= esdsBytes.length) return undefined;
    const urlLen = esdsBytes[pos++];
    pos += urlLen;
  }
  if ((flags >> 5) & 1) pos += 2; // OCRStreamFlag

  // Parse DecoderConfigDescriptor
  if (pos >= esdsBytes.length || esdsBytes[pos] !== 0x04) return undefined;
  pos += 1;
  pos = skipDescriptorSize(esdsBytes, pos);
  if (pos < 0 || pos + 13 > esdsBytes.length) return undefined;
  pos += 13; // objectTypeIndication(1) + streamType(1) + bufferSize(3) + maxBR(4) + avgBR(4)

  // Parse DecoderSpecificInfo
  if (pos >= esdsBytes.length || esdsBytes[pos] !== 0x05) return undefined;
  pos += 1;
  const sizeStart = pos;
  pos = skipDescriptorSize(esdsBytes, pos);
  if (pos < 0) return undefined;
  const size = readDescriptorSize(esdsBytes, sizeStart);
  if (size < 0 || pos + size > esdsBytes.length) return undefined;
  return esdsBytes.slice(pos, pos + size);
}

function skipDescriptorSize(buf: Uint8Array, pos: number): number {
  for (let i = 0; i < 4; i++) {
    if (pos >= buf.length) return -1;
    const byte = buf[pos++];
    if (!(byte & 0x80)) return pos;
  }
  return pos;
}

function readDescriptorSize(buf: Uint8Array, pos: number): number {
  let size = 0;
  for (let i = 0; i < 4; i++) {
    if (pos >= buf.length) return -1;
    const byte = buf[pos++];
    size = (size << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return size;
  }
  return size;
}
