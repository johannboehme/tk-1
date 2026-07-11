import { describe, it, expect } from "vitest";
import { DEMO_CAM_SPECS, createDemoJob } from "./demo-project";
import { useOpsStore } from "../ops-store";
import { jobsDb, deleteJob } from "../jobs";
import { isVideoAsset } from "../../storage/jobs-db";

/** Wait until the sync op for `jobId` clears (success) or errors. */
function waitForSyncDone(jobId: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const op = useOpsStore.getState().ops[jobId]?.sync;
      if (op?.error) {
        reject(new Error(`Sync failed: ${op.error}`));
        return;
      }
      if (!op) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Sync timed out at stage ${op.stage}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

describe("createDemoJob (end-to-end through the real pipeline)", () => {
  it("synthesizes the demo assets and the real sync finds cam B's offset", async () => {
    const stages: string[] = [];
    const jobId = await createDemoJob({
      onProgress: (p) => stages.push(`${p.stage}:${p.detail}`),
    });
    expect(jobId).toBeTruthy();
    expect(stages[0]).toBe("song:song");
    expect(stages[stages.length - 1]).toBe("job:job");

    try {
      await waitForSyncDone(jobId);

      const job = await jobsDb.getJob(jobId);
      expect(job).not.toBeNull();
      expect(job!.title).toBe("Demo session");
      expect(job!.mode).toBe("direct");

      const cams = (job!.videos ?? []).filter(isVideoAsset);
      expect(cams).toHaveLength(DEMO_CAM_SPECS.length);

      // Every cam got real prep artifacts: sync + duration + frames.
      for (const cam of cams) {
        expect(cam.sync).toBeDefined();
        expect(cam.durationS).toBeGreaterThan(1);
        expect(cam.framesPath).toBeTruthy();
      }

      // Cam A starts with the song → ~0 ms. Cam B starts one bar late:
      // runCamPrep's convention maps a cam that begins at +startS on the
      // master timeline to offsetMs ≈ -startS·1000 (masterStartS is
      // derived as -offsetMs/1000 downstream).
      const [camA, camB] = cams;
      expect(Math.abs(camA.sync!.offsetMs)).toBeLessThan(60);
      const expectedB = -DEMO_CAM_SPECS[1].songStartS * 1000;
      expect(Math.abs(camB.sync!.offsetMs - expectedB)).toBeLessThan(60);
    } finally {
      await deleteJob(jobId).catch(() => undefined);
    }
  }, 240_000);
});
