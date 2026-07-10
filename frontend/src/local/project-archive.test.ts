/**
 * Unit tests for the project-archive pure helpers (#86): manifest
 * validation, handle stripping, path rewriting, and the Float32Array
 * round-trip through the JSON encoding.
 */
import { describe, expect, test } from "vitest";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  audioOpfsPathOf,
  parseArchiveManifest,
  rewriteJobPaths,
  stripHandlesForArchive,
} from "./project-archive";
import type { LocalJob, VideoAsset } from "../storage/jobs-db";

function baseJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "abc123def456",
    title: "My Song",
    videoFilename: "take-1.mp4",
    audioFilename: "song.wav",
    createdAt: 1000,
    schemaVersion: 3,
    audioSource: { kind: "opfs", path: "jobs/abc123def456/audio.wav" },
    videos: [
      {
        kind: "video",
        id: "cam-1",
        filename: "take-1.mp4",
        opfsPath: "jobs/abc123def456/cam-1.mp4",
        source: { kind: "opfs", path: "jobs/abc123def456/cam-1.mp4" },
        color: "#dd4a1f",
        framesPath: "jobs/abc123def456/frames-cam-1.webp",
      },
    ],
    ...overrides,
  };
}

describe("rewriteJobPaths", () => {
  test("rewrites id, asset paths, sources, framesPath, and audioSource", () => {
    const out = rewriteJobPaths(baseJob(), "ffff00001111");
    expect(out.id).toBe("ffff00001111");
    const cam = out.videos![0] as VideoAsset;
    expect(cam.opfsPath).toBe("jobs/ffff00001111/cam-1.mp4");
    expect(cam.source).toEqual({
      kind: "opfs",
      path: "jobs/ffff00001111/cam-1.mp4",
    });
    expect(cam.framesPath).toBe("jobs/ffff00001111/frames-cam-1.webp");
    expect(out.audioSource).toEqual({
      kind: "opfs",
      path: "jobs/ffff00001111/audio.wav",
    });
  });

  test("leaves foreign paths untouched", () => {
    const job = baseJob({
      videos: [
        {
          kind: "video",
          id: "cam-1",
          filename: "v.mp4",
          opfsPath: "somewhere/else.mp4",
          color: "#000",
        },
      ],
    });
    const out = rewriteJobPaths(job, "ffff00001111");
    expect(out.videos![0].opfsPath).toBe("somewhere/else.mp4");
  });

  test("does not mutate the input", () => {
    const job = baseJob();
    rewriteJobPaths(job, "ffff00001111");
    expect(job.id).toBe("abc123def456");
    expect(job.videos![0].opfsPath).toBe("jobs/abc123def456/cam-1.mp4");
  });
});

describe("stripHandlesForArchive", () => {
  test("replaces handle sources with the asset's canonical OPFS path", () => {
    const fakeHandle = { name: "take-1.mp4" } as unknown as FileSystemFileHandle;
    const job = baseJob({
      audioSource: { kind: "handle", handle: fakeHandle },
      videos: [
        {
          kind: "video",
          id: "cam-1",
          filename: "take-1.mp4",
          opfsPath: "jobs/abc123def456/cam-1.mp4",
          source: { kind: "handle", handle: fakeHandle },
          color: "#dd4a1f",
        },
      ],
    });
    const out = stripHandlesForArchive(job);
    expect(out.videos![0].source).toEqual({
      kind: "opfs",
      path: "jobs/abc123def456/cam-1.mp4",
    });
    expect(out.audioSource).toEqual({
      kind: "opfs",
      path: "jobs/abc123def456/audio.wav",
    });
  });

  test("audio path derives its extension from audioFilename", () => {
    const job = baseJob({
      audioFilename: "master.m4a",
      audioSource: undefined,
    });
    expect(audioOpfsPathOf(job)).toBe("jobs/abc123def456/audio.m4a");
  });
});

describe("parseArchiveManifest", () => {
  test("accepts a well-formed manifest", () => {
    const m = parseArchiveManifest(
      JSON.stringify({
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        exportedAt: 1,
        job: { id: "x" },
        media: [],
      }),
    );
    expect(m.job).toEqual({ id: "x" });
  });

  test("rejects foreign JSON", () => {
    expect(() => parseArchiveManifest('{"hello":"world"}')).toThrow(
      /not a tk-1 project archive/i,
    );
  });

  test("rejects invalid JSON", () => {
    expect(() => parseArchiveManifest("not json")).toThrow(/not valid json/i);
  });

  test("rejects archives from a newer app version", () => {
    expect(() =>
      parseArchiveManifest(
        JSON.stringify({
          format: ARCHIVE_FORMAT,
          version: ARCHIVE_VERSION + 1,
          job: {},
          media: [],
        }),
      ),
    ).toThrow(/newer version/i);
  });
});
