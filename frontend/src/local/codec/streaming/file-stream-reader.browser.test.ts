import { describe, it, expect } from "vitest";
import { chunkedReader } from "./file-stream-reader";

function makeBlob(len: number): Blob {
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = i & 0xff;
  return new Blob([data]);
}

describe("chunkedReader (real Blob.stream)", () => {
  it("yields the entire content concatenated across batches", async () => {
    const blob = makeBlob(10 * 1024); // 10 KB
    const reader = chunkedReader(blob, { batchBytes: 1024 });
    const got: Uint8Array[] = [];
    let pos = 0;
    for (;;) {
      const batch = await reader.next();
      if (batch === null) break;
      got.push(batch);
      expect(reader.position).toBeGreaterThanOrEqual(pos + batch.length);
      pos = reader.position;
    }
    const total = got.reduce((acc, b) => acc + b.length, 0);
    expect(total).toBe(10 * 1024);
    expect(reader.position).toBe(10 * 1024);
    // Verify byte content is correct.
    const concat = new Uint8Array(total);
    let off = 0;
    for (const b of got) {
      concat.set(b, off);
      off += b.length;
    }
    for (let i = 0; i < concat.length; i++) {
      expect(concat[i]).toBe(i & 0xff);
    }
  });

  it("handles zero-length blob with a single null result", async () => {
    const reader = chunkedReader(new Blob([]));
    expect(await reader.next()).toBeNull();
  });

  it("returns null after EOF and stays null on subsequent calls", async () => {
    const reader = chunkedReader(makeBlob(64), { batchBytes: 1024 });
    const a = await reader.next();
    expect(a).not.toBeNull();
    expect(await reader.next()).toBeNull();
    expect(await reader.next()).toBeNull();
  });

  it("cancel() is idempotent", async () => {
    const reader = chunkedReader(makeBlob(1024));
    await reader.cancel();
    await reader.cancel();
    expect(await reader.next()).toBeNull();
  });
});
