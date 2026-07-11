/**
 * End-to-end round-trip for the project archive (#86) against real
 * OPFS + IndexedDB: export a seeded project, wipe the browser state,
 * import the archive, and expect the row + media back byte-identically.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { jobsDb, type LocalJob, type VideoAsset } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";
import {
  exportProjectArchive,
  importProjectArchive,
} from "./project-archive";

const JOB_ID = "aabbccdd0011";

function seedRow(): LocalJob {
  return {
    id: JOB_ID,
    title: "Roundtrip Song",
    videoFilename: "take-1.mp4",
    audioFilename: "song.wav",
    createdAt: 123456,
    schemaVersion: 3,
    mode: "direct",
    audioSource: { kind: "opfs", path: `jobs/${JOB_ID}/audio.wav` },
    cuts: [{ atTimeS: 1.25, camId: "cam-1" }],
    trim: { in: 0.5, out: 42 },
    bpm: { value: 120, confidence: 0.9, phase: 0.1, manualOverride: true },
    triageEnvelope: new Float32Array([0.25, 0.5, -0.75, 1]),
    lastRender: { completedAt: 999, outputBytes: 5 },
    editRev: 7,
    videos: [
      {
        kind: "video",
        id: "cam-1",
        filename: "take-1.mp4",
        opfsPath: `jobs/${JOB_ID}/cam-1.mp4`,
        source: { kind: "opfs", path: `jobs/${JOB_ID}/cam-1.mp4` },
        color: "#dd4a1f",
        framesPath: `jobs/${JOB_ID}/frames-cam-1.webp`,
        sync: { offsetMs: 250, driftRatio: 1.0001, confidence: 0.93 },
        trimInS: 1,
      },
    ],
  };
}

function bytes(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed + seed) & 0xff;
  return out;
}

async function seedProject(): Promise<{
  audio: Uint8Array;
  cam: Uint8Array;
  frames: Uint8Array;
  output: Uint8Array;
}> {
  const audio = bytes(3, 2048);
  const cam = bytes(5, 4096);
  const frames = bytes(7, 512);
  const output = bytes(11, 1024);
  await opfs.writeFile(`jobs/${JOB_ID}/audio.wav`, audio);
  await opfs.writeFile(`jobs/${JOB_ID}/cam-1.mp4`, cam);
  await opfs.writeFile(`jobs/${JOB_ID}/frames-cam-1.webp`, frames);
  await opfs.writeFile(`jobs/${JOB_ID}/output.mp4`, output);
  await jobsDb.saveJob(seedRow());
  return { audio, cam, frames, output };
}

async function opfsBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await opfs.readFile(path)).arrayBuffer());
}

/** The export Blob references the OPFS files lazily (that's what makes
 *  a 20 GB export memory-safe) — in real use the browser streams it to
 *  disk on download while the files still exist. To simulate "archive
 *  saved, then browser wiped", materialise the bytes first. */
async function materialize(blob: Blob): Promise<Blob> {
  return new Blob([await blob.arrayBuffer()], { type: blob.type });
}

describe("project archive round-trip (#86)", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
  });

  it("export → wipe → import restores the row and all media byte-identically", async () => {
    const media = await seedProject();

    const { blob, filename } = await exportProjectArchive(JOB_ID);
    expect(filename).toBe("Roundtrip Song.tk1.zip");
    expect(blob.size).toBeGreaterThan(
      media.audio.length + media.cam.length + media.frames.length + media.output.length,
    );
    const archive = await materialize(blob);

    // Simulate a different browser profile.
    await jobsDb.wipeAll();
    await opfs.wipeAll();

    const imported = await importProjectArchive(archive);
    expect(imported.jobId).toBe(JOB_ID); // id was free → kept
    expect(imported.title).toBe("Roundtrip Song");

    const row = await jobsDb.getJob(JOB_ID);
    expect(row).toBeDefined();
    expect(row!.cuts).toEqual([{ atTimeS: 1.25, camId: "cam-1" }]);
    expect(row!.trim).toEqual({ in: 0.5, out: 42 });
    expect(row!.bpm).toEqual({
      value: 120,
      confidence: 0.9,
      phase: 0.1,
      manualOverride: true,
    });
    const cam = row!.videos![0] as VideoAsset;
    expect(cam.sync).toEqual({ offsetMs: 250, driftRatio: 1.0001, confidence: 0.93 });
    expect(cam.trimInS).toBe(1);
    // Float32Array field survives the JSON encoding.
    expect(row!.triageEnvelope).toBeInstanceOf(Float32Array);
    expect(Array.from(row!.triageEnvelope!)).toEqual([0.25, 0.5, -0.75, 1]);
    // Rev tracking restarts in the target browser.
    expect(row!.editRev).toBe(0);

    expect(await opfsBytes(`jobs/${JOB_ID}/audio.wav`)).toEqual(media.audio);
    expect(await opfsBytes(`jobs/${JOB_ID}/cam-1.mp4`)).toEqual(media.cam);
    expect(await opfsBytes(`jobs/${JOB_ID}/frames-cam-1.webp`)).toEqual(media.frames);
    expect(await opfsBytes(`jobs/${JOB_ID}/output.mp4`)).toEqual(media.output);
  }, 30_000);

  it("importing while the id is taken mints a fresh id and rewrites all paths", async () => {
    await seedProject();
    const { blob } = await exportProjectArchive(JOB_ID);

    // Original stays — import the archive on top of it.
    const imported = await importProjectArchive(blob);
    expect(imported.jobId).not.toBe(JOB_ID);
    expect(imported.jobId).toMatch(/^[a-f0-9]{12}$/);

    const row = await jobsDb.getJob(imported.jobId);
    const cam = row!.videos![0] as VideoAsset;
    expect(cam.opfsPath).toBe(`jobs/${imported.jobId}/cam-1.mp4`);
    expect(cam.framesPath).toBe(`jobs/${imported.jobId}/frames-cam-1.webp`);
    expect(row!.audioSource).toEqual({
      kind: "opfs",
      path: `jobs/${imported.jobId}/audio.wav`,
    });
    // Both projects' media exist independently.
    expect(await opfs.exists(`jobs/${JOB_ID}/cam-1.mp4`)).toBe(true);
    expect(await opfs.exists(`jobs/${imported.jobId}/cam-1.mp4`)).toBe(true);
  }, 30_000);

  it("rejects a foreign zip with a clear error and leaves no orphan bytes", async () => {
    const foreign = new Blob(["PK\x03\x04 not really"]);
    await expect(importProjectArchive(foreign)).rejects.toThrow(/not a zip|archive/i);
    expect((await opfs.list("jobs")).filter((e) => e.endsWith("/"))).toEqual([]);
  });

  it("legacy v2 rows (no sources) export via their derived OPFS paths", async () => {
    const audio = bytes(3, 128);
    const cam = bytes(5, 128);
    await opfs.writeFile("jobs/legacy0000ff/audio.wav", audio);
    await opfs.writeFile("jobs/legacy0000ff/cam-1.mp4", cam);
    await jobsDb.saveJob({
      id: "legacy0000ff",
      title: null,
      videoFilename: "v.mp4",
      audioFilename: "a.wav",
      createdAt: 1,
      schemaVersion: 2,
      videos: [
        {
          id: "cam-1",
          filename: "v.mp4",
          opfsPath: "jobs/legacy0000ff/cam-1.mp4",
          color: "#000",
        },
      ],
    });

    const archive = await materialize(
      (await exportProjectArchive("legacy0000ff")).blob,
    );
    await jobsDb.wipeAll();
    await opfs.wipeAll();
    const imported = await importProjectArchive(archive);
    expect(imported.jobId).toBe("legacy0000ff");
    expect(await opfsBytes("jobs/legacy0000ff/cam-1.mp4")).toEqual(cam);
    expect(await opfsBytes("jobs/legacy0000ff/audio.wav")).toEqual(audio);
  }, 30_000);
});
