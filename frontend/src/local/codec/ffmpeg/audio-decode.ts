/**
 * Audio decode via ffmpeg.wasm.
 *
 * Strategy: write the input to ffmpeg's virtual FS, transcode to a
 * 32-bit-float WAV at the target sample rate (mono mix-down), read back,
 * then return as a Float32Array. WAV is trivial to parse and avoids
 * needing any second decode step.
 *
 * Slow (~10–20× slower than WebCodecs), but unblocks the rare files
 * WebCodecs can't handle directly: .mkv, .avi, ProRes audio, AC-3, etc.
 */

import type { DecodedAudio } from "../webcodecs/audio-decode";
import { getFfmpeg } from "./ffmpeg-loader";

export async function decodeAudioToMonoPcmFfmpeg(
  source: Blob | ArrayBuffer,
  targetSampleRate: number,
): Promise<DecodedAudio> {
  const ffmpeg = await getFfmpeg();

  // We choose extensions that don't matter to ffmpeg's content-sniffing —
  // the file content drives demuxing.
  const inputName = `input-${Date.now()}.bin`;
  const outputName = `output-${Date.now()}.wav`;

  // We deliberately avoid @ffmpeg/util's `fetchFile` here: it routes through
  // a legacy `FileReader.readAsArrayBuffer`, which on some Chromium builds
  // rejects OPFS-backed Files with the opaque "File could not be read!
  // Code=-1". `Blob.arrayBuffer()` (Streams API) handles OPFS Files
  // reliably and is what the WebCodecs path already uses on the same source.
  const data =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(await source.arrayBuffer());
  await ffmpeg.writeFile(inputName, data);

  // Transcode to mono 32-bit float WAV at target sample rate.
  await ffmpeg.exec([
    "-y",
    "-i",
    inputName,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(targetSampleRate),
    "-c:a",
    "pcm_f32le",
    outputName,
  ]);

  const wavBytes = (await ffmpeg.readFile(outputName)) as Uint8Array;
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return parseWavFloat32(wavBytes, targetSampleRate);
}

function parseWavFloat32(bytes: Uint8Array, expectedSampleRate: number): DecodedAudio {
  // Minimal RIFF/WAVE parser. Skips chunks until "data". Assumes the file
  // ffmpeg produced has format = 3 (IEEE float), channels = 1.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Header: "RIFF" + size + "WAVE".
  if (
    view.getUint8(0) !== 0x52 ||
    view.getUint8(1) !== 0x49 ||
    view.getUint8(2) !== 0x46 ||
    view.getUint8(3) !== 0x46
  ) {
    throw new Error("ffmpeg.wasm: output is not a valid RIFF file");
  }

  let pos = 12; // skip RIFF header
  let sampleRate = expectedSampleRate;
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
      sampleRate = view.getUint32(pos + 8 + 4, true);
    } else if (id === "data") {
      dataOffset = pos + 8;
      dataSize = size;
      break;
    }
    pos += 8 + size + (size & 1);
  }

  if (dataOffset < 0) throw new Error("ffmpeg.wasm: WAV has no data chunk");

  // f32le samples.
  const sampleCount = dataSize / 4;
  // Build a clean Float32Array (don't share underlying buffer with the
  // ffmpeg memory which may be released).
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getFloat32(dataOffset + i * 4, true);
  }
  return {
    pcm: out,
    sampleRate,
    durationS: sampleCount / sampleRate,
    backend: "ffmpeg-wasm",
  };
}
