/**
 * Minimal ZIP container for project archives (#86) — write + read,
 * STORE method only (no compression: the payload is already-compressed
 * media). No dependency, works on Blobs end-to-end:
 *
 *  - The writer never materialises entry bytes in memory: each entry's
 *    Blob becomes a lazy part of the output Blob, so a 20 GB project
 *    exports without 20 GB of RAM. Only the CRC32 pass streams through
 *    the data (slice-wise), which is unavoidable — ZIP requires it.
 *  - ZIP64 records are emitted automatically when any size/offset
 *    exceeds the 32-bit format limits (multi-GB cam footage).
 *  - The reader parses the central directory and returns lazy Blob
 *    slices, so import writes media straight from the archive file on
 *    disk into OPFS without buffering whole entries.
 *
 * Not a general-purpose ZIP implementation: single volume, stored
 * entries only. Foreign archives with compressed entries are rejected
 * with a clear error.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

// ---------------------------------------------------------------------------
// CRC32 (standard polynomial, table-driven)
// ---------------------------------------------------------------------------

/** Blob → ArrayBuffer with a FileReader fallback: jsdom's Blob (used by
 *  the unit-test environment) lacks `arrayBuffer()`. */
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error("Blob read failed"));
    r.readAsArrayBuffer(blob);
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** One-shot CRC32 of a byte array. Exported for tests. */
export function crc32Of(bytes: Uint8Array): number {
  let state = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    state = CRC_TABLE[(state ^ bytes[i]) & 0xff] ^ (state >>> 8);
  }
  return (state ^ 0xffffffff) >>> 0;
}

const CRC_CHUNK_BYTES = 8 * 1024 * 1024;

/** Streaming CRC32 over a Blob, slice-wise — bounded memory even for
 *  multi-GB media files. */
export async function crc32OfBlob(data: Blob): Promise<number> {
  let state = 0xffffffff;
  for (let off = 0; off < data.size; off += CRC_CHUNK_BYTES) {
    const chunk = new Uint8Array(
      await bytesOf(data.slice(off, off + CRC_CHUNK_BYTES)),
    );
    for (let i = 0; i < chunk.length; i++) {
      state = CRC_TABLE[(state ^ chunk[i]) & 0xff] ^ (state >>> 8);
    }
  }
  return (state ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface ZipEntrySpec {
  /** Path inside the archive, "/"-separated, UTF-8. */
  name: string;
  data: Blob;
}

interface WriterOptions {
  /** Test hook: force ZIP64 records regardless of sizes. */
  forceZip64?: boolean;
}

function u16(view: DataView, off: number, v: number): void {
  view.setUint16(off, v, true);
}
function u32(view: DataView, off: number, v: number): void {
  view.setUint32(off, v >>> 0, true);
}
function u64(view: DataView, off: number, v: number): void {
  view.setBigUint64(off, BigInt(v), true);
}

/**
 * Build a stored-entries ZIP from the given entries. The returned Blob
 * references the entry Blobs lazily — no bulk copy happens here.
 */
export async function buildZip(
  entries: ZipEntrySpec[],
  options: WriterOptions = {},
): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.length > MAX_U16) {
      throw new Error(`Zip entry name too long: ${entry.name}`);
    }
    const size = entry.data.size;
    const crc = await crc32OfBlob(entry.data);
    const zip64 =
      options.forceZip64 || size >= MAX_U32 || offset >= MAX_U32;
    const versionNeeded = zip64 ? 45 : 20;
    const localExtra = zip64 ? 20 : 0; // header(4) + usize(8) + csize(8)

    // Local file header
    const lh = new DataView(new ArrayBuffer(30));
    u32(lh, 0, SIG_LOCAL);
    u16(lh, 4, versionNeeded);
    u16(lh, 6, 0x0800); // UTF-8 names
    u16(lh, 8, 0); // method: store
    u16(lh, 10, 0); // dos time
    u16(lh, 12, 0x21); // dos date (1980-01-01)
    u32(lh, 14, crc);
    u32(lh, 18, zip64 ? MAX_U32 : size);
    u32(lh, 22, zip64 ? MAX_U32 : size);
    u16(lh, 26, nameBytes.length);
    u16(lh, 28, localExtra);
    parts.push(lh.buffer, nameBytes);
    if (zip64) {
      const ex = new DataView(new ArrayBuffer(20));
      u16(ex, 0, 0x0001);
      u16(ex, 2, 16);
      u64(ex, 4, size);
      u64(ex, 12, size);
      parts.push(ex.buffer);
    }
    parts.push(entry.data); // lazy — the Blob is referenced, not copied

    // Central directory entry
    const cdZip64 = zip64;
    const cdExtraLen = cdZip64 ? 4 + 24 : 0; // usize + csize + offset
    const cd = new DataView(new ArrayBuffer(46));
    u32(cd, 0, SIG_CENTRAL);
    u16(cd, 4, 45); // version made by
    u16(cd, 6, versionNeeded);
    u16(cd, 8, 0x0800);
    u16(cd, 10, 0);
    u16(cd, 12, 0);
    u16(cd, 14, 0x21);
    u32(cd, 16, crc);
    u32(cd, 20, cdZip64 ? MAX_U32 : size);
    u32(cd, 24, cdZip64 ? MAX_U32 : size);
    u16(cd, 28, nameBytes.length);
    u16(cd, 30, cdExtraLen);
    u16(cd, 32, 0); // comment
    u16(cd, 34, 0); // disk
    u16(cd, 36, 0); // internal attrs
    u32(cd, 38, 0); // external attrs
    u32(cd, 42, cdZip64 ? MAX_U32 : offset);
    central.push(cd.buffer, nameBytes);
    if (cdZip64) {
      const ex = new DataView(new ArrayBuffer(cdExtraLen));
      u16(ex, 0, 0x0001);
      u16(ex, 2, 24);
      u64(ex, 4, size);
      u64(ex, 12, size);
      u64(ex, 20, offset);
      central.push(ex.buffer);
    }
    centralSize += 46 + nameBytes.length + cdExtraLen;

    const localHeaderSize = 30 + nameBytes.length + localExtra;
    offset += localHeaderSize + size;
  }

  const cdOffset = offset;
  const needsZip64Eocd =
    options.forceZip64 ||
    entries.length > MAX_U16 ||
    centralSize >= MAX_U32 ||
    cdOffset >= MAX_U32;

  const tail: BlobPart[] = [];
  if (needsZip64Eocd) {
    const e64 = new DataView(new ArrayBuffer(56));
    u32(e64, 0, SIG_EOCD64);
    u64(e64, 4, 44); // size of remaining record
    u16(e64, 12, 45);
    u16(e64, 14, 45);
    u32(e64, 16, 0);
    u32(e64, 20, 0);
    u64(e64, 24, entries.length);
    u64(e64, 32, entries.length);
    u64(e64, 40, centralSize);
    u64(e64, 48, cdOffset);
    tail.push(e64.buffer);

    const loc = new DataView(new ArrayBuffer(20));
    u32(loc, 0, SIG_EOCD64_LOCATOR);
    u32(loc, 4, 0);
    u64(loc, 8, cdOffset + centralSize);
    u32(loc, 16, 1);
    tail.push(loc.buffer);
  }
  const eocd = new DataView(new ArrayBuffer(22));
  u32(eocd, 0, SIG_EOCD);
  u16(eocd, 4, 0);
  u16(eocd, 6, 0);
  u16(eocd, 8, needsZip64Eocd ? MAX_U16 : entries.length);
  u16(eocd, 10, needsZip64Eocd ? MAX_U16 : entries.length);
  u32(eocd, 12, needsZip64Eocd ? MAX_U32 : centralSize);
  u32(eocd, 16, needsZip64Eocd ? MAX_U32 : cdOffset);
  u16(eocd, 20, 0);
  tail.push(eocd.buffer);

  return new Blob([...parts, ...central, ...tail], {
    type: "application/zip",
  });
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ZipEntryInfo {
  name: string;
  /** Uncompressed size (== stored size for method 0). */
  size: number;
  /** Offset of the local file header. */
  headerOffset: number;
  /** Compression method — this reader only serves method 0. */
  method: number;
  crc32: number;
}

/** Parse the central directory of a (possibly ZIP64) archive. */
export async function readZipIndex(file: Blob): Promise<ZipEntryInfo[]> {
  // EOCD lives in the last 22..(22+65535) bytes. Scan backwards.
  const tailSize = Math.min(file.size, 22 + MAX_U16);
  const tailStart = file.size - tailSize;
  const tail = new DataView(await bytesOf(file.slice(tailStart)));
  let eocdOff = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("Not a ZIP archive (no end record found)");

  let count = tail.getUint16(eocdOff + 10, true);
  let cdSize = tail.getUint32(eocdOff + 12, true);
  let cdOffset = tail.getUint32(eocdOff + 16, true);

  if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) {
    // ZIP64: locator sits directly before the EOCD.
    const locAbs = tailStart + eocdOff - 20;
    if (locAbs < 0) throw new Error("Corrupt ZIP64 archive (no locator)");
    const loc = new DataView(await bytesOf(file.slice(locAbs, locAbs + 20)));
    if (loc.getUint32(0, true) !== SIG_EOCD64_LOCATOR) {
      throw new Error("Corrupt ZIP64 archive (bad locator)");
    }
    const e64Off = Number(loc.getBigUint64(8, true));
    const e64 = new DataView(await bytesOf(file.slice(e64Off, e64Off + 56)));
    if (e64.getUint32(0, true) !== SIG_EOCD64) {
      throw new Error("Corrupt ZIP64 archive (bad end record)");
    }
    count = Number(e64.getBigUint64(32, true));
    cdSize = Number(e64.getBigUint64(40, true));
    cdOffset = Number(e64.getBigUint64(48, true));
  }

  const cd = new DataView(
    await bytesOf(file.slice(cdOffset, cdOffset + cdSize)),
  );
  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error("Corrupt ZIP archive (bad central directory)");
    }
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let headerOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(
      new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen),
    );

    // ZIP64 extra field: fields present only for maxed-out 32-bit values,
    // in the fixed order usize, csize, offset.
    if (size === MAX_U32 || headerOffset === MAX_U32) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = cd.getUint16(ep, true);
        const len = cd.getUint16(ep + 2, true);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (size === MAX_U32) {
            size = Number(cd.getBigUint64(fp, true));
            fp += 8;
          }
          // compressed size mirrors size for stored entries
          const csizeMaxed = cd.getUint32(p + 20, true) === MAX_U32;
          if (csizeMaxed) fp += 8;
          if (headerOffset === MAX_U32) {
            headerOffset = Number(cd.getBigUint64(fp, true));
          }
          break;
        }
        ep += 4 + len;
      }
    }

    entries.push({ name, size, headerOffset, method, crc32: crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Lazy Blob slice for one stored entry — resolves the local header to
 * find where the data starts, then returns `file.slice(...)` without
 * reading the payload.
 */
export async function zipEntryBlob(
  file: Blob,
  entry: ZipEntryInfo,
): Promise<Blob> {
  if (entry.method !== 0) {
    throw new Error(
      `Unsupported compressed entry "${entry.name}" — not a TK-1 archive`,
    );
  }
  const lh = new DataView(
    await bytesOf(file.slice(entry.headerOffset, entry.headerOffset + 30)),
  );
  if (lh.getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(`Corrupt ZIP archive (bad local header for ${entry.name})`);
  }
  const nameLen = lh.getUint16(26, true);
  const extraLen = lh.getUint16(28, true);
  const dataStart = entry.headerOffset + 30 + nameLen + extraLen;
  return file.slice(dataStart, dataStart + entry.size);
}
