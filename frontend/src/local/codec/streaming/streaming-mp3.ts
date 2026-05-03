/**
 * Streaming MP3 decoder.
 *
 * MP3 has no container — it's a raw stream of frames, optionally
 * preceded by an ID3v2 tag and/or an APEv2 tag at the end. Each frame
 * starts with an 11-bit sync word (`0xFFE` ...) and a 4-byte header
 * encoding bitrate, sample rate, padding, etc. The frame length is
 * derivable from the header: `floor(144 * bitrate / sampleRate) + pad`
 * for Layer III at MPEG-1.
 *
 * Pipeline:
 *   1. Skip ID3v2 tag if present (length encoded in the tag header).
 *   2. Stream-read 4 MiB batches.
 *   3. Parse frame headers, slice frame bytes, push to `AudioDecoder`.
 *   4. Decoder output → mixdown → resampler → accumulate PCM.
 *
 * Backpressure: when `AudioDecoder.decodeQueueSize` exceeds a soft
 * cap, we await a microtask before pushing more — keeps decoder queue
 * bounded so memory stays flat.
 */

import { chunkedReader } from "./file-stream-reader";
import { createMonoResampler } from "./resampler";
import type { DecodedAudio } from "../webcodecs/audio-decode";

const DECODE_QUEUE_SOFT_CAP = 16;

// MPEG audio sample-rate table indexed by version × srIdx.
//   version: 11=MPEG1, 10=MPEG2, 00=MPEG2.5
const SAMPLE_RATES: Record<number, [number, number, number]> = {
  3 /* MPEG1   */: [44100, 48000, 32000],
  2 /* MPEG2   */: [22050, 24000, 16000],
  0 /* MPEG2.5 */: [11025, 12000, 8000],
};

// Bitrate tables (kbps) by version × layer × bitrateIdx (0..15).
//   layer: 01=Layer III, 10=Layer II, 11=Layer I
const BITRATES_MPEG1_L3 = [
  -1, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1,
];
const BITRATES_MPEG2_L3 = [
  -1, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1,
];
// We only support Layer III in this decoder (this is what `.mp3` files
// always are in the wild). Layer I / II are vanishingly rare for music.

interface Mp3FrameHeader {
  version: number; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  layer: number; // 1=Layer III
  bitrate: number; // bits/s
  sampleRate: number;
  padding: number; // 0 or 1
  channels: number; // 1 or 2
  /** Frame size in bytes (header + data). */
  frameSize: number;
  /** Decoded samples per frame. MPEG1=1152, MPEG2/2.5=576. */
  samplesPerFrame: number;
}

export interface StreamingMp3Options {
  /** Reports progress as a fraction in [0, 1] of source bytes read.
   *  Called after each read batch. */
  onProgress?: (frac: number) => void;
}

export async function decodeMp3Streaming(
  source: Blob,
  targetSampleRate: number,
  opts: StreamingMp3Options = {},
): Promise<DecodedAudio> {
  if (typeof AudioDecoder === "undefined") {
    throw new Error(
      "Streaming MP3 decode requires WebCodecs AudioDecoder (Chrome/Edge/Brave)",
    );
  }

  const id3Skip = await detectId3v2TagSize(source);
  const dataBlob = id3Skip > 0 ? source.slice(id3Skip) : source;
  const reader = chunkedReader(dataBlob);
  const sourceSize = source.size;

  const resampler = createMonoResampler({ targetSampleRate });
  let firstHeader: Mp3FrameHeader | null = null;
  let timestampUs = 0;

  // Wire up the AudioDecoder. It produces `AudioData` objects which we
  // immediately mix to mono and feed the resampler, then close to release
  // the underlying buffer.
  const decoderErrors: Error[] = [];
  const decoder = new AudioDecoder({
    output: (frame: AudioData) => {
      try {
        feedAudioFrame(frame, resampler);
      } finally {
        frame.close();
      }
    },
    error: (e) => decoderErrors.push(e),
  });

  // Frame-aligned carry across read batches.
  let carry: Uint8Array | null = null;

  outer: for (;;) {
    if (decoderErrors.length > 0) break;
    const batch = await reader.next();
    if (batch === null) break;
    if (opts.onProgress && sourceSize > 0) {
      opts.onProgress(Math.min(0.95, (id3Skip + reader.position) / sourceSize));
    }

    let view: Uint8Array;
    if (carry) {
      view = new Uint8Array(carry.length + batch.length);
      view.set(carry);
      view.set(batch, carry.length);
      carry = null;
    } else {
      view = batch;
    }

    let pos = 0;
    while (pos + 4 <= view.length) {
      // Find the next sync word. We expect frames to be back-to-back so
      // typically pos already points at one — but tolerate skipping
      // (e.g. APEv2 tag injected mid-file is rare but possible).
      const syncPos = findSyncWord(view, pos);
      if (syncPos < 0) {
        // No sync left in this batch — discard everything we already
        // walked past, leaving nothing to carry (we're past whatever
        // garbage there was).
        pos = view.length;
        break;
      }
      pos = syncPos;
      if (pos + 4 > view.length) {
        // Header straddles batch boundary — carry the tail.
        carry = view.subarray(pos);
        continue outer;
      }
      const header = parseFrameHeader(view, pos);
      if (header === null) {
        // Bad header at this candidate sync — advance by 1 and keep
        // searching.
        pos += 1;
        continue;
      }
      if (firstHeader === null) {
        firstHeader = header;
        const description = makeMp3Description(header);
        decoder.configure({
          codec: "mp3",
          sampleRate: header.sampleRate,
          numberOfChannels: header.channels,
          ...(description ? { description } : {}),
        });
      }
      if (pos + header.frameSize > view.length) {
        // Frame body straddles boundary — carry header + partial body.
        carry = view.subarray(pos);
        continue outer;
      }

      // We have a complete frame.
      const frameBytes = view.subarray(pos, pos + header.frameSize);
      pos += header.frameSize;

      // Backpressure: if decoder is saturated, wait for it to drain a
      // bit before queueing more.
      if (decoder.decodeQueueSize > DECODE_QUEUE_SOFT_CAP) {
        await waitForDrain(decoder, DECODE_QUEUE_SOFT_CAP / 2);
        if (decoderErrors.length > 0) break outer;
      }

      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: timestampUs,
          data: frameBytes,
        }),
      );
      timestampUs += Math.round(
        (header.samplesPerFrame * 1_000_000) / header.sampleRate,
      );
    }
    // pos == view.length here (or close); nothing left to carry unless we
    // explicitly set it above.
  }

  await reader.cancel();
  if (decoderErrors.length === 0) {
    try {
      await decoder.flush();
    } catch (e) {
      if (e instanceof Error) decoderErrors.push(e);
    }
  }
  decoder.close();

  if (decoderErrors.length > 0) {
    throw new Error(
      `MP3 decode failed: ${decoderErrors.map((e) => e.message).join("; ")}`,
    );
  }
  if (firstHeader === null) {
    throw new Error("MP3 decode: no audio frames found");
  }

  const pcm = resampler.finish();
  opts.onProgress?.(1);
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
  // Prefer planar f32 (cheapest copy + matches our resampler input).
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
  // Fallback: interleaved f32 in one plane.
  const total = ch * frames;
  const buf = new Float32Array(total);
  frame.copyTo(buf, { planeIndex: 0, format: "f32" });
  resampler.pushInterleaved(buf, ch, rate);
}

async function waitForDrain(
  decoder: AudioDecoder,
  target: number,
): Promise<void> {
  // Yield to the decoder's output queue. A microtask + macrotask is
  // typically enough; cap iterations to avoid infinite loops on stuck
  // decoders.
  for (let i = 0; i < 50 && decoder.decodeQueueSize > target; i++) {
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

async function detectId3v2TagSize(source: Blob): Promise<number> {
  if (source.size < 10) return 0;
  const head = new Uint8Array(await source.slice(0, 10).arrayBuffer());
  // ID3v2 magic: "ID3"
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  // Size at offset 6..9 is "synchsafe" — 7 bits per byte, MSB always 0.
  const a = head[6] & 0x7f;
  const b = head[7] & 0x7f;
  const c = head[8] & 0x7f;
  const d = head[9] & 0x7f;
  const tagSize = (a << 21) | (b << 14) | (c << 7) | d;
  return 10 + tagSize; // 10-byte header is not included in `tagSize`
}

function findSyncWord(buf: Uint8Array, start: number): number {
  const end = buf.length - 1;
  for (let i = start; i < end; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return i;
  }
  return -1;
}

function parseFrameHeader(
  buf: Uint8Array,
  pos: number,
): Mp3FrameHeader | null {
  const b1 = buf[pos];
  const b2 = buf[pos + 1];
  const b3 = buf[pos + 2];
  const b4 = buf[pos + 3];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;

  const version = (b2 >> 3) & 0x03;
  const layer = (b2 >> 1) & 0x03;
  if (layer !== 0x01) return null; // we only support Layer III
  const bitrateIdx = (b3 >> 4) & 0x0f;
  const srIdx = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  const channelMode = (b4 >> 6) & 0x03;
  const channels = channelMode === 0x03 ? 1 : 2;

  const rates = SAMPLE_RATES[version];
  if (!rates || srIdx === 3) return null;
  const sampleRate = rates[srIdx];

  const bitrateTable = version === 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3;
  const kbps = bitrateTable[bitrateIdx];
  if (kbps <= 0) return null;
  const bitrate = kbps * 1000;

  const samplesPerFrame = version === 3 ? 1152 : 576;
  // Layer III frame size formula. The constant is samplesPerFrame/8.
  const frameSize =
    Math.floor((samplesPerFrame * bitrate) / 8 / sampleRate) + padding;
  if (frameSize < 4) return null;
  return {
    version,
    layer,
    bitrate,
    sampleRate,
    padding,
    channels,
    frameSize,
    samplesPerFrame,
  };
}

/** Some browsers want a description blob on AudioDecoder for MP3 (it
 *  encodes channel count + sample rate — duplicates configure(), but is
 *  required to get past `Unsupported config` in some Chromium builds).
 *  For MP3 the description is empty: AudioDecoder uses the per-chunk
 *  frame headers.  Returning `undefined` keeps the configure() call
 *  cleaner. */
function makeMp3Description(_header: Mp3FrameHeader): undefined {
  return undefined;
}
