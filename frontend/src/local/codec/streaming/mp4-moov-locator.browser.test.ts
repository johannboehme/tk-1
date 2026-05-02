import { describe, it, expect } from "vitest";
import { locateMoov } from "./mp4-moov-locator";

const MP4_FIXTURE = "/__test_fixtures__/tone-3s.mp4"; // moov-first

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return await r.blob();
}

describe("locateMoov", () => {
  it("finds moov in a moov-first fixture (re-walk from anywhere in the tail)", async () => {
    const blob = await fetchBlob(MP4_FIXTURE);
    const m = await locateMoov(blob);
    expect(m).not.toBeNull();
    expect(m!.size).toBeGreaterThan(8);
    // Round-trip: the bytes we got back start with the box header
    // (size BE-uint32 at 0, "moov" at 4..7).
    expect(String.fromCharCode(...m!.bytes.slice(4, 8))).toBe("moov");
  });

  it("synthetic moov-last MP4: ftyp + mdat + moov ordering", async () => {
    // Build a minimal MP4 with: ftyp (32 bytes), mdat (1 MB),
    // moov (synthetic 200 bytes payload, 208 with header).
    const ftyp = new Uint8Array(32);
    writeBE32(ftyp, 0, 32);
    writeAscii(ftyp, 4, "ftyp");
    writeAscii(ftyp, 8, "isom");

    const mdatSize = 1024 * 1024;
    const mdat = new Uint8Array(mdatSize);
    writeBE32(mdat, 0, mdatSize);
    writeAscii(mdat, 4, "mdat");
    // Fill mdat body with random "moov" false-positives to make sure
    // the locator's box-walk is robust.
    for (let i = 8; i + 4 <= mdatSize; i += 256) {
      writeAscii(mdat, i, "moov");
    }

    const moovPayload = new Uint8Array(200);
    const moov = new Uint8Array(208);
    writeBE32(moov, 0, 208);
    writeAscii(moov, 4, "moov");
    moov.set(moovPayload, 8);

    const blob = new Blob([
      ftyp.buffer as BlobPart,
      mdat.buffer as BlobPart,
      moov.buffer as BlobPart,
    ]);
    const m = await locateMoov(blob);
    expect(m).not.toBeNull();
    expect(m!.offset).toBe(32 + mdatSize);
    expect(m!.size).toBe(208);
    expect(String.fromCharCode(...m!.bytes.slice(4, 8))).toBe("moov");
  });

  it("expands probe when the initial tail is too small to cover moov", async () => {
    // 5 MiB mdat + 4 MiB moov payload + small ftyp. Default tail
    // probe (16 MiB) covers everything, so force a tiny initial
    // probe to exercise the expansion path.
    const ftyp = new Uint8Array(32);
    writeBE32(ftyp, 0, 32);
    writeAscii(ftyp, 4, "ftyp");
    writeAscii(ftyp, 8, "isom");

    const mdatSize = 5 * 1024 * 1024;
    const mdat = new Uint8Array(mdatSize);
    writeBE32(mdat, 0, mdatSize);
    writeAscii(mdat, 4, "mdat");

    const moovPayload = new Uint8Array(4 * 1024 * 1024);
    const moovTotal = 8 + moovPayload.length;
    const moov = new Uint8Array(moovTotal);
    writeBE32(moov, 0, moovTotal);
    writeAscii(moov, 4, "moov");
    moov.set(moovPayload, 8);

    const blob = new Blob([
      ftyp.buffer as BlobPart,
      mdat.buffer as BlobPart,
      moov.buffer as BlobPart,
    ]);
    const m = await locateMoov(blob);
    expect(m).not.toBeNull();
    expect(m!.offset).toBe(32 + mdatSize);
    expect(m!.size).toBe(moovTotal);
  });

  it("returns null when no moov is found within the max probe", async () => {
    // ftyp + 1 MiB mdat, no moov.
    const ftyp = new Uint8Array(32);
    writeBE32(ftyp, 0, 32);
    writeAscii(ftyp, 4, "ftyp");
    writeAscii(ftyp, 8, "isom");

    const mdatSize = 1024 * 1024;
    const mdat = new Uint8Array(mdatSize);
    writeBE32(mdat, 0, mdatSize);
    writeAscii(mdat, 4, "mdat");

    const blob = new Blob([
      ftyp.buffer as BlobPart,
      mdat.buffer as BlobPart,
    ]);
    const m = await locateMoov(blob);
    expect(m).toBeNull();
  });
});

function writeBE32(buf: Uint8Array, pos: number, val: number): void {
  buf[pos] = (val >>> 24) & 0xff;
  buf[pos + 1] = (val >>> 16) & 0xff;
  buf[pos + 2] = (val >>> 8) & 0xff;
  buf[pos + 3] = val & 0xff;
}

function writeAscii(buf: Uint8Array, pos: number, str: string): void {
  for (let i = 0; i < str.length; i++) buf[pos + i] = str.charCodeAt(i);
}
