import { describe, it, expect, beforeEach } from "vitest";
import {
  addVideoToJob,
  createJob,
  jobEvents,
  runQuickRender,
  deleteJob,
  resolveJobAssetUrl,
} from "./jobs";
import { useOpsStore } from "./ops-store";
import {
  isVideoAsset,
  jobsDb,
  type MediaAsset,
  type VideoAsset,
} from "../storage/jobs-db";
import { opfs } from "../storage/opfs";

/** Test helper: assert a media asset is a VideoAsset and narrow its type. */
function asVideo(asset: MediaAsset | undefined): VideoAsset {
  if (!asset || !isVideoAsset(asset)) {
    throw new Error("expected a VideoAsset");
  }
  return asset;
}

const VIDEO_FIXTURE_URL = "/__test_fixtures__/tone-3s.mp4";

function makeWavBlob(): Blob {
  const sr = 48000;
  const n = sr * 3;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 880 * i) / sr);
  }
  const dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function fetchVideoFile(): Promise<File> {
  const blob = await (await fetch(VIDEO_FIXTURE_URL)).blob();
  return new File([blob], "tone-3s.mp4", { type: "video/mp4" });
}

/** Wrap a File as a PickedAsset without a handle — exercises the
 *  legacy / unsupported-browser code path that copies bytes to OPFS. */
function pick(file: File): { file: File; handle: null } {
  return { file, handle: null };
}

/** Wait until the sync op for `jobId` clears (success) or carries an
 *  error (failure). Polls the in-memory ops-store. */
function waitForSyncDone(jobId: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const op = useOpsStore.getState().ops[jobId]?.sync;
      if (op?.error) {
        reject(new Error(`Sync failed: ${op.error}`));
        return;
      }
      if (!op) {
        // No op = either never started yet, or finished. Disambiguate
        // by checking whether the videos have a sync result.
        jobsDb
          .getJob(jobId)
          .then((j) => {
            if (j?.videos?.some((v) => isVideoAsset(v) && Boolean(v.sync))) {
              resolve();
              return;
            }
            if (Date.now() - start > timeoutMs) {
              reject(new Error("Timed out waiting for sync to complete"));
              return;
            }
            setTimeout(tick, 200);
          })
          .catch(reject);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for sync to complete"));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}


describe("local jobs lifecycle", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
  });

  it("createJob persists files in OPFS, sync runs end-to-end", async () => {
    const video = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });

    const jobId = await createJob([pick(video)], pick(audio), { title: "Test take" });
    expect(jobId).toMatch(/^[a-f0-9]{12}$/);

    // Files persisted in OPFS under the V2 cam-N naming convention.
    expect(await opfs.exists(`jobs/${jobId}/cam-1.mp4`)).toBe(true);
    expect(await opfs.exists(`jobs/${jobId}/audio.wav`)).toBe(true);

    // Wait for sync to complete.
    await waitForSyncDone(jobId);
    const job = await jobsDb.getJob(jobId);
    expect(job!.schemaVersion).toBe(3);
    expect(job!.videos).toHaveLength(1);
    const cam0 = asVideo(job!.videos![0]);
    expect(cam0.id).toBe("cam-1");
    expect(cam0.sync).toBeDefined();
    expect(cam0.sync!.driftRatio).toBeCloseTo(1.0, 1);
    // Legacy mirror still populated for backward compat.
    expect(job!.sync).toBeDefined();
    expect(typeof job!.sync!.offsetMs).toBe("number");
    expect(job!.title).toBe("Test take");
    expect(job!.durationS).toBeCloseTo(3.0, 0);
    // Pre-processing also extracted the timeline frame strip — now per-cam.
    expect(job!.hasFrames).toBe(true);
    expect(await opfs.exists(`jobs/${jobId}/frames-cam-1.webp`)).toBe(true);
    expect(cam0.framesPath).toBe(`jobs/${jobId}/frames-cam-1.webp`);
    const framesUrl = await resolveJobAssetUrl(jobId, "frames");
    expect(framesUrl).toMatch(/^blob:/);
    if (framesUrl) URL.revokeObjectURL(framesUrl);
  }, 120_000);

  it("createJob persists multiple cams + syncs each against the master audio", async () => {
    const v1 = await fetchVideoFile();
    const v2 = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });

    const jobId = await createJob([pick(v1), pick(v2)], pick(audio), { title: "Two cams" });

    expect(await opfs.exists(`jobs/${jobId}/cam-1.mp4`)).toBe(true);
    expect(await opfs.exists(`jobs/${jobId}/cam-2.mp4`)).toBe(true);

    await waitForSyncDone(jobId);
    const job = await jobsDb.getJob(jobId);
    expect(job!.videos).toHaveLength(2);
    expect(job!.videos![0].id).toBe("cam-1");
    expect(job!.videos![1].id).toBe("cam-2");
    // Each cam got its own sync result.
    expect(asVideo(job!.videos![0]).sync).toBeDefined();
    expect(asVideo(job!.videos![1]).sync).toBeDefined();
    // Each cam got its own thumbnail strip.
    expect(await opfs.exists(`jobs/${jobId}/frames-cam-1.webp`)).toBe(true);
    expect(await opfs.exists(`jobs/${jobId}/frames-cam-2.webp`)).toBe(true);
    // Cam-1 stats are mirrored to legacy top-level fields.
    expect(job!.sync).toEqual(asVideo(job!.videos![0]).sync);
    expect(job!.cuts).toEqual([]);
  }, 180_000);

  it("runQuickRender produces an output file in OPFS", async () => {
    const video = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });

    const jobId = await createJob([pick(video)], pick(audio));
    await waitForSyncDone(jobId);

    await runQuickRender(jobId);
    const job = await jobsDb.getJob(jobId);
    expect(job!.lastRender).toBeDefined();
    expect(job!.lastRender!.outputBytes).toBeGreaterThan(1000);
    expect(await opfs.exists(`jobs/${jobId}/output.mp4`)).toBe(true);
    // The render op is in `done` state until something else clears it.
    const renderOp = useOpsStore.getState().ops[jobId]?.render;
    expect(renderOp?.done).toBe(true);

    const url = await resolveJobAssetUrl(jobId, "output");
    expect(url).toMatch(/^blob:/);
    if (url) URL.revokeObjectURL(url);
  }, 120_000);

  it("if runQuickRender throws, the render op carries the error and the sync result on the job is preserved", async () => {
    const video = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });
    const jobId = await createJob([pick(video)], pick(audio));
    await waitForSyncDone(jobId);

    // Sabotage by deleting the audio file from OPFS — render will throw
    // when it tries to read it.
    await opfs.deletePath(`jobs/${jobId}/audio.wav`);

    let threw = false;
    try {
      await runQuickRender(jobId);
    } catch {
      threw = true;
    }
    expect(threw, "runQuickRender should rethrow on failure").toBe(true);

    const op = useOpsStore.getState().ops[jobId]?.render;
    expect(op?.error).toBeTruthy();
    const after = await jobsDb.getJob(jobId);
    expect(after?.lastRender).toBeUndefined();
    expect(after?.sync).toBeDefined(); // sync result is preserved → user can retry
  }, 120_000);

  it("deleteJob removes both OPFS files and the IndexedDB row", async () => {
    const video = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });
    const jobId = await createJob([pick(video)], pick(audio));
    await waitForSyncDone(jobId);

    await deleteJob(jobId);
    expect(await jobsDb.getJob(jobId)).toBeUndefined();
    expect(await opfs.exists(`jobs/${jobId}/cam-1.mp4`)).toBe(false);
    expect(await opfs.exists(`jobs/${jobId}/audio.wav`)).toBe(false);
  }, 120_000);
});

// -----------------------------------------------------------------------------
// addVideoToJob — appending a cam to an existing project
// -----------------------------------------------------------------------------

function waitForCamReady(
  jobId: string,
  camId: string,
  field: "sync" | "framesPath",
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{
        jobId: string;
        job: { videos?: Array<{ id: string; sync?: unknown; framesPath?: string }> };
      }>).detail;
      if (detail.jobId !== jobId) return;
      const cam = detail.job.videos?.find((v) => v.id === camId);
      if (!cam) return;
      const ready = field === "sync" ? cam.sync !== undefined : cam.framesPath !== undefined;
      if (ready) {
        jobEvents.removeEventListener("update", onUpdate);
        resolve();
      }
    };
    jobEvents.addEventListener("update", onUpdate);
    const tick = () => {
      if (Date.now() - start > timeoutMs) {
        jobEvents.removeEventListener("update", onUpdate);
        reject(new Error(`Timed out waiting for cam ${camId}.${field}`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

describe("addVideoToJob", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
  });

  it("appends a cam to videos[] immediately and runs sync in the background", async () => {
    const v1 = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });
    const jobId = await createJob([pick(v1)], pick(audio), { title: "B-roll test" });
    await waitForSyncDone(jobId);

    const v2 = await fetchVideoFile();
    const camId = await addVideoToJob(jobId, pick(v2));
    expect(camId).toBe("cam-2");

    // Lane shows up immediately, sync still pending.
    const immediate = await jobsDb.getJob(jobId);
    expect(immediate!.videos).toHaveLength(2);
    expect(immediate!.videos![1].id).toBe("cam-2");
    expect(asVideo(immediate!.videos![1]).sync).toBeUndefined();

    // Eventually the sync result fills in.
    await waitForCamReady(jobId, "cam-2", "sync");
    const after = await jobsDb.getJob(jobId);
    const cam2 = asVideo(after!.videos![1]);
    expect(cam2.sync).toBeDefined();
    expect(cam2.framesPath).toBeDefined();
    expect(await opfs.exists(`jobs/${jobId}/cam-2.mp4`)).toBe(true);
    expect(await opfs.exists(`jobs/${jobId}/frames-cam-2.webp`)).toBe(true);
    // Cam-1 untouched.
    expect(after!.videos![0].id).toBe("cam-1");
    expect(asVideo(after!.videos![0]).sync).toBeDefined();
  }, 180_000);

  it("with skipSync, leaves sync undefined but still extracts thumbnails", async () => {
    const v1 = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });
    const jobId = await createJob([pick(v1)], pick(audio));
    await waitForSyncDone(jobId);

    const v2 = await fetchVideoFile();
    const camId = await addVideoToJob(jobId, pick(v2), { skipSync: true });

    // Wait for frames since that's the marker that prep finished.
    await waitForCamReady(jobId, camId, "framesPath");
    const after = await jobsDb.getJob(jobId);
    const cam = asVideo(after!.videos!.find((v) => v.id === camId));
    expect(cam.sync).toBeUndefined();
    expect(cam.framesPath).toBeDefined();
    // Dimensions still probed.
    expect(cam.durationS).toBeDefined();
  }, 120_000);

  it("multiple sequential adds produce cam-N, cam-N+1", async () => {
    const v1 = await fetchVideoFile();
    const audio = new File([makeWavBlob()], "studio.wav", { type: "audio/wav" });
    const jobId = await createJob([pick(v1)], pick(audio));
    await waitForSyncDone(jobId);

    const a = await addVideoToJob(jobId, pick(await fetchVideoFile()), { skipSync: true });
    expect(a).toBe("cam-2");
    await waitForCamReady(jobId, a, "framesPath");

    const b = await addVideoToJob(jobId, pick(await fetchVideoFile()), { skipSync: true });
    expect(b).toBe("cam-3");
    await waitForCamReady(jobId, b, "framesPath");

    const after = await jobsDb.getJob(jobId);
    expect(after!.videos!.map((v) => v.id)).toEqual(["cam-1", "cam-2", "cam-3"]);
  }, 180_000);
});
