import { describe, it, expect } from "vitest";
import { decodeWavStreaming } from "./streaming-wav";

/** Build a synthetic 16-bit PCM WAV from a Float32 mono signal. */
function makeWavBlob(
  signal: Float32Array,
  sampleRate: number,
  numChannels = 1,
): Blob {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataLen = signal.length * blockAlign;
  const fileLen = 44 + dataLen;
  const buf = new ArrayBuffer(fileLen);
  const view = new DataView(buf);
  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, fileLen - 8, true);
  writeAscii(view, 8, "WAVE");
  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLen, true);
  // interleaved 16-bit samples (mono so just one channel)
  for (let i = 0; i < signal.length; i++) {
    const s = Math.max(-1, Math.min(1, signal[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buf]);
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function makeSine(len: number, freq: number, rate: number): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

describe("decodeWavStreaming", () => {
  it("decodes a 16-bit PCM mono WAV and resamples to the target rate", async () => {
    const signal = makeSine(48000, 440, 48000); // 1 sec @ 48 kHz
    const blob = makeWavBlob(signal, 48000, 1);
    const result = await decodeWavStreaming(blob, 22050);

    expect(result.sampleRate).toBe(22050);
    expect(result.backend).toBe("webcodecs");
    // ~22050 samples ± 1 for boundary
    expect(result.pcm.length).toBeGreaterThanOrEqual(22049);
    expect(result.pcm.length).toBeLessThanOrEqual(22052);

    // Zero-crossing rate of a 440 Hz tone over ~1 second.
    let zc = 0;
    const slice = result.pcm.subarray(100, 22000);
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1] <= 0 && slice[i] > 0) zc++;
    }
    expect(zc).toBeGreaterThanOrEqual(430);
    expect(zc).toBeLessThanOrEqual(450);
  });

  it("decodes a stereo WAV by mixing down to mono", async () => {
    // Stereo WAV: left = +0.5 const, right = -0.5 const; mixdown = 0.
    const stereoLen = 22050;
    const blockAlign = 4;
    const dataLen = stereoLen * blockAlign;
    const fileLen = 44 + dataLen;
    const buf = new ArrayBuffer(fileLen);
    const view = new DataView(buf);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, fileLen - 8, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); // 2 channels
    view.setUint32(24, 22050, true);
    view.setUint32(28, 22050 * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataLen, true);
    for (let i = 0; i < stereoLen; i++) {
      view.setInt16(44 + i * 4, Math.round(0.5 * 32767), true);   // L
      view.setInt16(44 + i * 4 + 2, Math.round(-0.5 * 32767), true); // R
    }
    const blob = new Blob([buf]);

    const result = await decodeWavStreaming(blob, 22050);
    expect(result.sampleRate).toBe(22050);
    // Mixdown should be ~0 across the body.
    for (let i = 100; i < result.pcm.length - 100; i++) {
      expect(Math.abs(result.pcm[i])).toBeLessThan(0.001);
    }
  });

  it("rejects WAVs with unsupported format codes", async () => {
    const buf = new ArrayBuffer(44);
    const view = new DataView(buf);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 7, true); // 7 = mu-law (unsupported)
    view.setUint16(22, 1, true);
    view.setUint32(24, 22050, true);
    view.setUint32(28, 22050, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, 0, true);
    const blob = new Blob([buf]);
    await expect(decodeWavStreaming(blob, 22050)).rejects.toThrow(
      /unsupported format code/,
    );
  });
});
