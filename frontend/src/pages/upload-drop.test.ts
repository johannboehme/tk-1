import { describe, it, expect } from "vitest";
import {
  classifyMediaKind,
  dataTransferHasFiles,
  partitionDroppedAssets,
  readDroppedAssets,
} from "./upload-drop";
import type { PickedAsset } from "../local/asset-source";

function f(name: string, type: string): File {
  return new File([new Uint8Array(1)], name, { type });
}

function pick(name: string, type: string): PickedAsset {
  return { file: f(name, type), handle: null };
}

describe("classifyMediaKind", () => {
  it("classifies by MIME type first", () => {
    expect(classifyMediaKind(f("song.mp3", "audio/mpeg"))).toBe("audio");
    expect(classifyMediaKind(f("take.mp4", "video/mp4"))).toBe("video");
    expect(classifyMediaKind(f("take.mkv", "video/x-matroska"))).toBe("video");
  });

  it("falls back to the file extension when the MIME type is empty", () => {
    expect(classifyMediaKind(f("take.mov", ""))).toBe("video");
    expect(classifyMediaKind(f("master.flac", ""))).toBe("audio");
    expect(classifyMediaKind(f("TAKE.MOV", ""))).toBe("video");
  });

  it("returns null for files that are neither audio nor video", () => {
    expect(classifyMediaKind(f("notes.txt", "text/plain"))).toBeNull();
    expect(classifyMediaKind(f("cover.png", "image/png"))).toBeNull();
    expect(classifyMediaKind(f("README", ""))).toBeNull();
  });
});

describe("partitionDroppedAssets", () => {
  it("routes audio to audio, video to videos, everything else to ignored", () => {
    const a = pick("song.wav", "audio/wav");
    const v1 = pick("cam1.mp4", "video/mp4");
    const v2 = pick("cam2.mov", "video/quicktime");
    const x = pick("notes.txt", "text/plain");
    const out = partitionDroppedAssets([v1, a, x, v2]);
    expect(out.audio.map((p) => p.file.name)).toEqual(["song.wav"]);
    expect(out.videos.map((p) => p.file.name)).toEqual(["cam1.mp4", "cam2.mov"]);
    expect(out.ignored.map((p) => p.file.name)).toEqual(["notes.txt"]);
  });

  it("keeps multiple audio files in drop order (caller picks the first)", () => {
    const out = partitionDroppedAssets([
      pick("a.mp3", "audio/mpeg"),
      pick("b.mp3", "audio/mpeg"),
    ]);
    expect(out.audio.map((p) => p.file.name)).toEqual(["a.mp3", "b.mp3"]);
    expect(out.videos).toEqual([]);
  });
});

describe("dataTransferHasFiles", () => {
  it("detects a Files drag", () => {
    expect(dataTransferHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
  });
  it("rejects text drags and null", () => {
    expect(
      dataTransferHasFiles({ types: ["text/plain"] } as unknown as DataTransfer),
    ).toBe(false);
    expect(dataTransferHasFiles(null)).toBe(false);
  });
});

describe("readDroppedAssets", () => {
  it("returns plain files with null handles when items are unavailable", async () => {
    const file = f("take.mp4", "video/mp4");
    const dt = { files: [file] } as unknown as DataTransfer;
    const out = await readDroppedAssets(dt);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe(file);
    expect(out[0].handle).toBeNull();
  });

  it("captures FileSystemFileHandles when the browser provides them", async () => {
    const file = f("take.mp4", "video/mp4");
    const handle = {
      kind: "file",
      name: "take.mp4",
      getFile: async () => file,
    };
    const item = {
      kind: "file",
      getAsFile: () => file,
      getAsFileSystemHandle: async () => handle,
    };
    const dt = { items: [item], files: [file] } as unknown as DataTransfer;
    const out = await readDroppedAssets(dt);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe(file);
    expect(out[0].handle).toBe(handle);
  });

  it("falls back to getAsFile when the handle request fails", async () => {
    const file = f("take.mp4", "video/mp4");
    const item = {
      kind: "file",
      getAsFile: () => file,
      getAsFileSystemHandle: async () => {
        throw new Error("nope");
      },
    };
    const dt = { items: [item], files: [file] } as unknown as DataTransfer;
    const out = await readDroppedAssets(dt);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe(file);
    expect(out[0].handle).toBeNull();
  });

  it("skips directory handles that have no file fallback", async () => {
    const item = {
      kind: "file",
      getAsFile: () => null,
      getAsFileSystemHandle: async () => ({ kind: "directory", name: "clips" }),
    };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    const out = await readDroppedAssets(dt);
    expect(out).toEqual([]);
  });

  it("ignores non-file items (e.g. dragged text)", async () => {
    const item = {
      kind: "string",
      getAsFile: () => null,
    };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    const out = await readDroppedAssets(dt);
    expect(out).toEqual([]);
  });
});
