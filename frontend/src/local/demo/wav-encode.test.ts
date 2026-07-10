import { describe, it, expect } from "vitest";
import { encodeWavPcm16 } from "./wav-encode";

function ascii(dv: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(offset + i));
  return s;
}

describe("encodeWavPcm16", () => {
  it("writes a valid RIFF/WAVE header for mono 44.1 kHz", () => {
    const samples = new Float32Array(100);
    const buf = encodeWavPcm16(samples, 1, 44100);
    const dv = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 100 * 2);
    expect(ascii(dv, 0, 4)).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + 100 * 2);
    expect(ascii(dv, 8, 4)).toBe("WAVE");
    expect(ascii(dv, 12, 4)).toBe("fmt ");
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint32(28, true)).toBe(44100 * 2); // byte rate
    expect(dv.getUint16(32, true)).toBe(2); // block align
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(dv, 36, 4)).toBe("data");
    expect(dv.getUint32(40, true)).toBe(100 * 2);
  });

  it("round-trips sample values within 16-bit precision", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const dv = new DataView(encodeWavPcm16(samples, 1, 48000));
    const read = (i: number) => dv.getInt16(44 + i * 2, true);
    expect(read(0)).toBe(0);
    expect(read(1) / 0x7fff).toBeCloseTo(0.5, 3);
    expect(read(2) / 0x8000).toBeCloseTo(-0.5, 3);
    expect(read(3)).toBe(0x7fff);
    expect(read(4)).toBe(-0x8000);
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const dv = new DataView(encodeWavPcm16(new Float32Array([1.7, -2.3]), 1, 44100));
    expect(dv.getInt16(44, true)).toBe(0x7fff);
    expect(dv.getInt16(46, true)).toBe(-0x8000);
  });

  it("encodes interleaved stereo with matching header fields", () => {
    const samples = new Float32Array(64); // 32 frames × 2 channels
    const dv = new DataView(encodeWavPcm16(samples, 2, 22050));
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(28, true)).toBe(22050 * 4);
    expect(dv.getUint16(32, true)).toBe(4);
    expect(dv.getUint32(40, true)).toBe(64 * 2);
  });
});
