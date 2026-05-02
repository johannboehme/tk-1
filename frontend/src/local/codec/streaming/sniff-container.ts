/**
 * Detects the audio container format of a Blob by reading the first
 * ~16 bytes and matching well-known magic-byte signatures.
 *
 * We don't trust the file extension (user may have renamed); the magic
 * bytes drive the routing decision in `codec/index.ts`. Returns `null`
 * if no streaming-eligible container is recognised — caller falls back
 * to the heavier paths (`decodeAudioData` + ffmpeg.wasm) which detect
 * by content too but only work for files small enough to fit in a single
 * ArrayBuffer.
 */

export type StreamingContainer = "mp4" | "mp3" | "wav";

export async function sniffContainer(
  source: Blob,
): Promise<StreamingContainer | null> {
  if (source.size < 12) return null;
  const head = new Uint8Array(await source.slice(0, 16).arrayBuffer());
  return classifyHead(head);
}

/** Pure: classify a head buffer (for tests and reuse). */
export function classifyHead(head: Uint8Array): StreamingContainer | null {
  if (head.length < 4) return null;

  // RIFF....WAVE — "RIFF" at offset 0, "WAVE" at offset 8.
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
  ) {
    return "wav";
  }

  // ISO BMFF / MP4 / MOV / M4A — "ftyp" box at offset 4 (size at 0..3,
  // type at 4..7). We don't filter by major brand: AAC-in-MP4, ALAC,
  // mov, m4a all have the same outer container and our streaming MP4
  // demuxer (mp4box.js) handles them.
  if (
    head.length >= 8 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  ) {
    return "mp4";
  }

  // MP3 — two cases:
  //   1. ID3v2 tag at offset 0 ("ID3"), then MP3 frames after the tag
  //   2. MP3 frame sync word at offset 0: 0xFF 0xEx (11 bits set,
  //      MPEG version + layer in remaining bits)
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return "mp3";
  }
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // Reject ADTS-AAC (0xFF 0xF1 / 0xF9) — that's AAC-in-ADTS, not MP3.
    // Both share the 0xFFE0 prefix; differentiate via layer bits.
    // MPEG layer bits: bits 1..2 of byte 1. layer=01 → Layer III (MP3).
    const layer = (head[1] >> 1) & 0x03;
    if (layer === 0x01) return "mp3";
  }

  return null;
}
