import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  type AssetSource,
  AssetPermissionError,
  checkReadPermission,
  loadAsset,
  loadAssetFile,
  persistPickedAsset,
  requestReadPermission,
  deleteAssetIfOwned,
} from "./asset-source";
import { opfs } from "../storage/opfs";

vi.mock("../storage/opfs", () => ({
  opfs: {
    readFile: vi.fn(async () => new File([new Uint8Array([1, 2, 3])], "x.bin")),
    writeFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
  },
}));

const opfsMock = vi.mocked(opfs);

function fakeHandle(name: string, perm: PermissionState | "n/a" = "granted"): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      return new File([new Uint8Array([9, 9, 9])], name);
    },
    async queryPermission() {
      return perm === "n/a" ? "granted" : perm;
    },
    async requestPermission() {
      return perm === "n/a" ? "granted" : perm;
    },
  } as unknown as FileSystemFileHandle;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadAsset", () => {
  it("OPFS source → opfs.readFile", async () => {
    await loadAsset({ kind: "opfs", path: "jobs/x/cam-1.mp4" });
    expect(opfsMock.readFile).toHaveBeenCalledWith("jobs/x/cam-1.mp4");
  });

  it("granted handle → handle.getFile", async () => {
    const h = fakeHandle("clip.mp4", "granted");
    const file = await loadAsset({ kind: "handle", handle: h });
    expect(file.name).toBe("clip.mp4");
  });

  it("prompt-state handle → AssetPermissionError", async () => {
    const h = fakeHandle("clip.mp4", "prompt");
    await expect(
      loadAsset({ kind: "handle", handle: h }),
    ).rejects.toBeInstanceOf(AssetPermissionError);
  });

  it("denied handle → AssetPermissionError", async () => {
    const h = fakeHandle("clip.mp4", "denied");
    await expect(
      loadAsset({ kind: "handle", handle: h }),
    ).rejects.toBeInstanceOf(AssetPermissionError);
  });
});

describe("loadAssetFile (schema-tolerant)", () => {
  it("uses `source` when present (v3+)", async () => {
    const h = fakeHandle("audio.mp3");
    await loadAssetFile({
      source: { kind: "handle", handle: h },
      opfsPath: "ignored.mp3",
    });
    expect(opfsMock.readFile).not.toHaveBeenCalled();
  });

  it("falls back to `opfsPath` when `source` is missing (v2)", async () => {
    await loadAssetFile({ opfsPath: "jobs/x/audio.wav" });
    expect(opfsMock.readFile).toHaveBeenCalledWith("jobs/x/audio.wav");
  });

  it("throws when neither field is set", async () => {
    await expect(loadAssetFile({})).rejects.toThrow(/neither.*source.*opfsPath/);
  });
});

describe("persistPickedAsset", () => {
  it("handle-backed pick → returns handle source, no OPFS write", async () => {
    const h = fakeHandle("video.mp4");
    const file = new File([new Uint8Array(100)], "video.mp4");
    const source = await persistPickedAsset({ file, handle: h }, "ignored.mp4");
    expect(source).toEqual({ kind: "handle", handle: h });
    expect(opfsMock.writeFile).not.toHaveBeenCalled();
  });

  it("file-only pick → writes to OPFS, returns OPFS source", async () => {
    const file = new File([new Uint8Array(100)], "video.mp4");
    const source = await persistPickedAsset(
      { file, handle: null },
      "jobs/abc/cam-1.mp4",
    );
    expect(source).toEqual({ kind: "opfs", path: "jobs/abc/cam-1.mp4" });
    expect(opfsMock.writeFile).toHaveBeenCalledWith(
      "jobs/abc/cam-1.mp4",
      file,
    );
  });
});

describe("deleteAssetIfOwned", () => {
  it("OPFS source → deletes the file", async () => {
    await deleteAssetIfOwned({ kind: "opfs", path: "jobs/x/cam-1.mp4" });
    expect(opfsMock.deleteFile).toHaveBeenCalledWith("jobs/x/cam-1.mp4");
  });

  it("handle source → no-op (we don't own the user's disk file)", async () => {
    const h = fakeHandle("clip.mp4");
    await deleteAssetIfOwned({ kind: "handle", handle: h });
    expect(opfsMock.deleteFile).not.toHaveBeenCalled();
  });
});

describe("checkReadPermission", () => {
  it("OPFS source → 'n/a'", async () => {
    const p = await checkReadPermission({ kind: "opfs", path: "x" });
    expect(p).toBe("n/a");
  });

  it("granted handle → 'granted'", async () => {
    const h = fakeHandle("a", "granted");
    expect(await checkReadPermission({ kind: "handle", handle: h })).toBe(
      "granted",
    );
  });

  it("prompt handle → 'prompt'", async () => {
    const h = fakeHandle("a", "prompt");
    expect(await checkReadPermission({ kind: "handle", handle: h })).toBe(
      "prompt",
    );
  });
});

describe("requestReadPermission", () => {
  it("OPFS source → 'granted' immediately", async () => {
    expect(await requestReadPermission({ kind: "opfs", path: "x" })).toBe(
      "granted",
    );
  });

  it("handle source → forwards to handle.requestPermission", async () => {
    const h = fakeHandle("a", "granted");
    expect(await requestReadPermission({ kind: "handle", handle: h })).toBe(
      "granted",
    );
  });
});

describe("AssetPermissionError", () => {
  it("carries the file name + permission state", () => {
    const err = new AssetPermissionError("song.mp3", "prompt");
    expect(err.fileName).toBe("song.mp3");
    expect(err.state).toBe("prompt");
    expect(err.code).toBe("permission-required");
    expect(err.message).toMatch(/song\.mp3/);
  });
});

// quick exhaust: AssetSource union actually accepts both shapes
const _exhaust: AssetSource[] = [
  { kind: "opfs", path: "x" },
  { kind: "handle", handle: fakeHandle("y") },
];
void _exhaust;
