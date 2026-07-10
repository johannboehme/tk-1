/**
 * Round-trip tests for the project-archive ZIP container (#86).
 */
import { describe, expect, it } from "vitest";
import {
  buildZip,
  crc32Of,
  crc32OfBlob,
  readZipIndex,
  zipEntryBlob,
} from "./zip";

async function bufferOf(blob: Blob): Promise<ArrayBuffer> {
  // jsdom's Blob lacks arrayBuffer() — go through FileReader.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsArrayBuffer(blob);
  });
}

async function text(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await bufferOf(blob));
}

describe("crc32", () => {
  it("matches the well-known check value for '123456789'", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc32Of(bytes)).toBe(0xcbf43926);
  });

  it("blob streaming matches the one-shot value across chunk boundaries", async () => {
    const big = new Uint8Array(3_000_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    expect(await crc32OfBlob(new Blob([big]))).toBe(crc32Of(big));
  });
});

describe("buildZip + readZipIndex + zipEntryBlob", () => {
  it("round-trips multiple entries byte-identically", async () => {
    const a = new Blob(["hello archive"]);
    const bBytes = new Uint8Array(70_000);
    for (let i = 0; i < bBytes.length; i++) bBytes[i] = (i * 7) & 0xff;
    const b = new Blob([bBytes]);

    const zip = await buildZip([
      { name: "project.json", data: a },
      { name: "media/cam-1.mp4", data: b },
    ]);

    const index = await readZipIndex(zip);
    expect(index.map((e) => e.name)).toEqual([
      "project.json",
      "media/cam-1.mp4",
    ]);
    expect(index[0].size).toBe(a.size);
    expect(index[1].size).toBe(b.size);

    expect(await text(await zipEntryBlob(zip, index[0]))).toBe("hello archive");
    const bBack = new Uint8Array(
      await bufferOf(await zipEntryBlob(zip, index[1])),
    );
    expect(bBack).toEqual(bBytes);
  });

  it("handles unicode entry names", async () => {
    const zip = await buildZip([
      { name: "média/Späti — take1.mp4", data: new Blob(["x"]) },
    ]);
    const index = await readZipIndex(zip);
    expect(index[0].name).toBe("média/Späti — take1.mp4");
  });

  it("handles an empty entry and an empty archive", async () => {
    const zip = await buildZip([{ name: "empty.bin", data: new Blob([]) }]);
    const index = await readZipIndex(zip);
    expect(index[0].size).toBe(0);
    expect((await zipEntryBlob(zip, index[0])).size).toBe(0);

    const none = await buildZip([]);
    expect(await readZipIndex(none)).toEqual([]);
  });

  it("round-trips through the ZIP64 record layout (forced)", async () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;
    const zip = await buildZip(
      [
        { name: "project.json", data: new Blob(["{}"]) },
        { name: "media/big.mp4", data: new Blob([payload]) },
      ],
      { forceZip64: true },
    );
    const index = await readZipIndex(zip);
    expect(index).toHaveLength(2);
    expect(index[1].size).toBe(payload.length);
    const back = new Uint8Array(
      await bufferOf(await zipEntryBlob(zip, index[1])),
    );
    expect(back).toEqual(payload);
    expect(await text(await zipEntryBlob(zip, index[0]))).toBe("{}");
  });

  it("stored CRCs in the index match the entry contents", async () => {
    const data = new TextEncoder().encode("crc check payload");
    const zip = await buildZip([{ name: "f", data: new Blob([data]) }]);
    const [entry] = await readZipIndex(zip);
    expect(entry.crc32).toBe(crc32Of(data));
  });

  it("rejects a non-zip blob with a clear error", async () => {
    await expect(readZipIndex(new Blob(["definitely not a zip"]))).rejects.toThrow(
      /not a zip/i,
    );
  });
});
