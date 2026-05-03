/**
 * Locate the `moov` box in an MP4 file by walking the box tree.
 *
 * Phone cameras / screen recorders write `mdat` first and `moov` last
 * (no rewind needed when recording stops), so streaming demuxers like
 * mp4box.js have to wait for the entire mdat before they can parse
 * track structure. Pre-locating moov lets us feed it out-of-order via
 * `appendBuffer({fileStart})` so `onReady` fires immediately.
 *
 * Strategy:
 *   1. Read the first `headBytes` of the file (default 64 KiB).
 *   2. Walk boxes from byte 0 by their declared sizes — `ftyp` is
 *      always first, then typically `mdat` (with its size in the
 *      header), then `moov`. We never read the mdat body; we jump
 *      past it using the size field.
 *   3. If a box header straddles the head probe (e.g. the file starts
 *      with `ftyp` + tiny boxes whose total exceeds 64 KiB), expand
 *      the probe.
 *   4. When we find moov, slice its bytes from disk and return them.
 *
 * Returns null when no moov is found (rare — usually means a non-MP4
 * file mis-sniffed as MP4).
 */

export interface MoovLocation {
  /** Absolute byte offset of the moov box header in the source. */
  offset: number;
  /** Total size of the moov box in bytes (header + payload). */
  size: number;
  /** Already-read bytes covering the moov box (caller can feed these
   *  straight to the demuxer without re-reading from disk). */
  bytes: Uint8Array;
}

export interface MoovLocateOptions {
  /** Initial head probe size for box-header walking. Default 64 KiB. */
  headBytes?: number;
  /** Max sequential box-header reads before we give up. Each read
   *  fetches just the 16-byte header at the next box offset. Default
   *  64 — generous for pathological prelude box stacks. */
  maxBoxLookups?: number;
}

const DEFAULT_HEAD = 64 * 1024;
const DEFAULT_MAX_LOOKUPS = 64;

export async function locateMoov(
  source: Blob,
  opts: MoovLocateOptions = {},
): Promise<MoovLocation | null> {
  const headSize = Math.min(opts.headBytes ?? DEFAULT_HEAD, source.size);
  const head = new Uint8Array(await source.slice(0, headSize).arrayBuffer());

  // Walk boxes starting from the head. For boxes whose payload extends
  // past `headSize` (typically `mdat` on long recordings) we don't read
  // the body — we jump past it using the declared box size and read
  // just the next box's header from disk on demand.
  let pos = 0;
  let lookups = 0;
  const maxLookups = opts.maxBoxLookups ?? DEFAULT_MAX_LOOKUPS;
  while (pos + 8 <= source.size) {
    if (lookups++ > maxLookups) return null;

    // Get this box's header (size + type, possibly + 64-bit ext-size).
    let headerBytes: Uint8Array;
    if (pos + 16 <= head.length) {
      headerBytes = head.subarray(pos, pos + 16);
    } else {
      const probeEnd = Math.min(pos + 16, source.size);
      headerBytes = new Uint8Array(
        await source.slice(pos, probeEnd).arrayBuffer(),
      );
    }
    if (headerBytes.length < 8) return null;

    const sizeField = readBE32(headerBytes, 0);
    const type = readAscii(headerBytes, 4, 4);
    let size: number;
    if (sizeField === 0) {
      // Box extends to EOF.
      size = source.size - pos;
    } else if (sizeField === 1) {
      if (headerBytes.length < 16) return null;
      const hi = readBE32(headerBytes, 8);
      const lo = readBE32(headerBytes, 12);
      size = hi * 0x100000000 + lo;
    } else {
      size = sizeField;
    }
    if (size < 8) return null;

    if (type === "moov") {
      // Found it. Slice the moov bytes from disk.
      const moovEnd = Math.min(pos + size, source.size);
      const bytes = new Uint8Array(
        await source.slice(pos, moovEnd).arrayBuffer(),
      );
      return { offset: pos, size: bytes.length, bytes };
    }

    pos += size;
  }
  return null;
}

function readBE32(buf: Uint8Array, pos: number): number {
  return (
    ((buf[pos] << 24) >>> 0) +
    (buf[pos + 1] << 16) +
    (buf[pos + 2] << 8) +
    buf[pos + 3]
  );
}

function readAscii(buf: Uint8Array, pos: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[pos + i]);
  return s;
}
