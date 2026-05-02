import { describe, it, expect } from "vitest";
import { classifyHead } from "./sniff-container";

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe("classifyHead", () => {
  it("recognises RIFF/WAVE header as wav", () => {
    // "RIFF" + 4 size bytes + "WAVE"
    const head = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(classifyHead(head)).toBe("wav");
  });

  it("recognises ftyp box as mp4 (any brand)", () => {
    // 4 bytes box size, "ftyp" at offset 4..7, then brand
    const head = bytes(
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
      0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,    // "isom" + minor version
    );
    expect(classifyHead(head)).toBe("mp4");
  });

  it("recognises ID3v2 tag as mp3 (no MP3 frame yet visible)", () => {
    const head = bytes(0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(classifyHead(head)).toBe("mp3");
  });

  it("recognises bare MPEG Layer III sync word as mp3", () => {
    // 0xFF 0xFB = MPEG-1 Layer III, no protection
    const head = bytes(0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(classifyHead(head)).toBe("mp3");
  });

  it("rejects ADTS-AAC (sync word matches but layer != III)", () => {
    // 0xFF 0xF1 = MPEG-4 ADTS, layer=00 (no layer in ADTS == not Layer III)
    const head = bytes(0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(classifyHead(head)).toBeNull();
  });

  it("returns null for unrecognised content", () => {
    const head = bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0);
    expect(classifyHead(head)).toBeNull();
  });

  it("returns null for buffers shorter than the smallest signature", () => {
    expect(classifyHead(bytes())).toBeNull();
    expect(classifyHead(bytes(0xff, 0xfb))).toBeNull();
  });
});
