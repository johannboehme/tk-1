/**
 * Streaming WAV decoder.
 *
 * WAV is trivial: a RIFF header tells us format/rate/channels, then the
 * `data` chunk holds raw interleaved samples. We read the header, then
 * stream the data section through the mono resampler — never holding
 * more than one read-batch in memory.
 *
 * Supports format codes 1 (PCM int) and 3 (IEEE float). PCM bit-depths:
 * 8, 16, 24, 32. Anything else (A-law, μ-law, ADPCM, WMA) → throws and
 * the caller falls back to ffmpeg.wasm.
 */

import { chunkedReader } from "./file-stream-reader";
import { createMonoResampler } from "./resampler";
import type { DecodedAudio } from "../webcodecs/audio-decode";

interface WavFmt {
  formatCode: number; // 1=PCM int, 3=float
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number; // bytes per frame across all channels
  /** Byte offset in the file where the `data` chunk's payload starts. */
  dataOffset: number;
  /** Byte length of the `data` chunk's payload. May be 0 or 0xFFFFFFFF
   *  for streaming WAVs of unknown length; in that case we read until EOF. */
  dataSize: number;
}

export interface StreamingWavOptions {
  /** Reports progress as a fraction in [0, 1] of source bytes read. */
  onProgress?: (frac: number) => void;
}

export async function decodeWavStreaming(
  source: Blob,
  targetSampleRate: number,
  opts: StreamingWavOptions = {},
): Promise<DecodedAudio> {
  // Step 1: read enough of the head to find fmt + data chunk offsets.
  // 1 MiB is plenty for any sane WAV header (some have huge LIST/INFO
  // chunks; bump if needed).
  const HEADER_PROBE = Math.min(source.size, 1 * 1024 * 1024);
  const headBytes = new Uint8Array(
    await source.slice(0, HEADER_PROBE).arrayBuffer(),
  );
  const fmt = parseWavHeader(headBytes);

  if (fmt.formatCode !== 1 && fmt.formatCode !== 3) {
    throw new Error(
      `WAV: unsupported format code ${fmt.formatCode} ` +
        `(only PCM int / IEEE float supported in streaming path)`,
    );
  }
  if (fmt.formatCode === 1 && ![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error(
      `WAV: unsupported PCM bit depth ${fmt.bitsPerSample}`,
    );
  }
  if (fmt.formatCode === 3 && fmt.bitsPerSample !== 32) {
    throw new Error(
      `WAV: unsupported float bit depth ${fmt.bitsPerSample}`,
    );
  }

  const resampler = createMonoResampler({ targetSampleRate });
  const dataLimit = fmt.dataSize > 0 && fmt.dataSize < 0xffffffff
    ? fmt.dataOffset + fmt.dataSize
    : source.size;

  // Step 2: stream the data section through the resampler.
  // We position-skip past the header by slicing the Blob; the
  // ChunkedReader then walks the rest in 4 MiB batches.
  const dataBlob = source.slice(fmt.dataOffset, dataLimit);
  const reader = chunkedReader(dataBlob);

  // Frame-aligned carry: a 4 MiB read may end mid-frame; carry the
  // tail bytes to the next batch so each `decodeBatch` call sees only
  // whole frames.
  let carry: Uint8Array | null = null;
  const sourceSize = source.size;
  for (;;) {
    const batch = await reader.next();
    if (batch === null) break;
    if (opts.onProgress && sourceSize > 0) {
      opts.onProgress(Math.min(0.95, (fmt.dataOffset + reader.position) / sourceSize));
    }
    let view: Uint8Array = batch;
    if (carry) {
      const merged = new Uint8Array(carry.length + batch.length);
      merged.set(carry);
      merged.set(batch, carry.length);
      view = merged;
      carry = null;
    }
    const fullFrames = Math.floor(view.length / fmt.blockAlign);
    const consumeBytes = fullFrames * fmt.blockAlign;
    if (consumeBytes < view.length) {
      carry = view.slice(consumeBytes);
    }
    if (fullFrames === 0) continue;
    const interleaved = bytesToFloat32Interleaved(
      view.subarray(0, consumeBytes),
      fmt,
      fullFrames,
    );
    resampler.pushInterleaved(interleaved, fmt.numChannels, fmt.sampleRate);
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

function parseWavHeader(bytes: Uint8Array): WavFmt {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "RIFF" + size + "WAVE"
  if (
    view.getUint8(0) !== 0x52 || view.getUint8(1) !== 0x49 ||
    view.getUint8(2) !== 0x46 || view.getUint8(3) !== 0x46
  ) {
    throw new Error("WAV: bad RIFF signature");
  }
  if (
    view.getUint8(8) !== 0x57 || view.getUint8(9) !== 0x41 ||
    view.getUint8(10) !== 0x56 || view.getUint8(11) !== 0x45
  ) {
    throw new Error("WAV: bad WAVE signature");
  }

  let pos = 12;
  let fmt: Partial<WavFmt> = {};
  let dataOffset = -1;
  let dataSize = 0;

  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(
      view.getUint8(pos),
      view.getUint8(pos + 1),
      view.getUint8(pos + 2),
      view.getUint8(pos + 3),
    );
    const size = view.getUint32(pos + 4, true);
    if (id === "fmt ") {
      const fpos = pos + 8;
      fmt = {
        formatCode: view.getUint16(fpos, true),
        numChannels: view.getUint16(fpos + 2, true),
        sampleRate: view.getUint32(fpos + 4, true),
        bitsPerSample: view.getUint16(fpos + 14, true),
        blockAlign: view.getUint16(fpos + 12, true),
      };
    } else if (id === "data") {
      dataOffset = pos + 8;
      dataSize = size;
      break;
    }
    pos += 8 + size + (size & 1); // chunks are word-aligned (pad byte if odd size)
  }

  if (dataOffset < 0) {
    throw new Error("WAV: no data chunk found in header probe");
  }
  if (
    fmt.formatCode === undefined ||
    fmt.numChannels === undefined ||
    fmt.sampleRate === undefined ||
    fmt.bitsPerSample === undefined ||
    fmt.blockAlign === undefined
  ) {
    throw new Error("WAV: no fmt chunk found before data chunk");
  }
  return { ...(fmt as WavFmt), dataOffset, dataSize };
}

function bytesToFloat32Interleaved(
  bytes: Uint8Array,
  fmt: WavFmt,
  numFrames: number,
): Float32Array {
  const samples = numFrames * fmt.numChannels;
  const out = new Float32Array(samples);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (fmt.formatCode === 3 /* IEEE float */) {
    for (let i = 0; i < samples; i++) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }

  // PCM int.
  switch (fmt.bitsPerSample) {
    case 8: {
      // 8-bit WAV is unsigned (centred at 128).
      const inv = 1 / 128;
      for (let i = 0; i < samples; i++) {
        out[i] = (view.getUint8(i) - 128) * inv;
      }
      break;
    }
    case 16: {
      const inv = 1 / 32768;
      for (let i = 0; i < samples; i++) {
        out[i] = view.getInt16(i * 2, true) * inv;
      }
      break;
    }
    case 24: {
      const inv = 1 / 8388608;
      for (let i = 0; i < samples; i++) {
        const off = i * 3;
        // little-endian 24-bit signed
        const lo = view.getUint8(off);
        const mid = view.getUint8(off + 1);
        const hi = view.getInt8(off + 2); // sign-extend via Int8
        out[i] = ((hi << 16) | (mid << 8) | lo) * inv;
      }
      break;
    }
    case 32: {
      const inv = 1 / 2147483648;
      for (let i = 0; i < samples; i++) {
        out[i] = view.getInt32(i * 4, true) * inv;
      }
      break;
    }
  }
  return out;
}
