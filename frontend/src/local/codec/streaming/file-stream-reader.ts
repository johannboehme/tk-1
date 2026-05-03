/**
 * Chunked file reader on top of `Blob.stream()`.
 *
 * Why not just `await blob.arrayBuffer()`: ArrayBuffer is capped at ~2 GiB
 * in Chromium (v8 max ByteLength on 32-bit structures). For multi-GB
 * media files we have to read the bytes in chunks, never holding more
 * than O(chunkSize) in JS heap.
 *
 * Why batch instead of forwarding the native ~64 KB chunks: round-trips
 * through `await reader.read()` add up. mp4box and the MP3 frame parser
 * happily consume larger batches and we get linear SSD throughput
 * (~500 MB/s on modern NVMe) when reading in 4 MiB slices. The batch
 * size is configurable so tests can pin tiny values.
 */

const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface ChunkedReader {
  /** Bytes already produced by `next()`. Useful for mp4box's
   *  `appendBuffer({ fileStart })` invariant. */
  readonly position: number;
  /** Yields the next batch of bytes, or `null` when EOF. */
  next(): Promise<Uint8Array | null>;
  /** Releases the underlying ReadableStreamDefaultReader. Idempotent. */
  cancel(reason?: unknown): Promise<void>;
}

export interface ChunkedReaderOptions {
  /** Target batch size for `next()`. Defaults to 4 MiB. The final batch
   *  may be smaller. */
  batchBytes?: number;
}

export function chunkedReader(
  source: Blob,
  opts: ChunkedReaderOptions = {},
): ChunkedReader {
  const target = Math.max(1, opts.batchBytes ?? DEFAULT_BATCH_BYTES);
  const reader = source.stream().getReader();
  let position = 0;
  let leftover: Uint8Array | null = null;
  let done = false;
  let cancelled = false;

  return {
    get position() {
      return position;
    },
    async next(): Promise<Uint8Array | null> {
      if (cancelled || done) return null;

      // Accumulate native chunks (~64 KB on Chromium) until the target
      // batch is reached or the stream ends.
      const parts: Uint8Array[] = [];
      let total = 0;
      if (leftover) {
        parts.push(leftover);
        total += leftover.length;
        leftover = null;
      }
      while (total < target && !done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          done = true;
          break;
        }
        if (!value || value.length === 0) continue;
        parts.push(value);
        total += value.length;
      }

      if (parts.length === 0) return null;

      // If we overshot because the last native chunk pushed us past target
      // by a lot, keep the excess for the next call. (For 4 MiB batches and
      // 64 KB native chunks the overshoot is bounded; we just keep the
      // simple "concat then return" path.)
      const out = parts.length === 1 ? parts[0] : concat(parts, total);
      position += out.length;
      return out;
    },
    async cancel(reason?: unknown): Promise<void> {
      if (cancelled) return;
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // closing a closed reader is fine
      }
    },
  };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
