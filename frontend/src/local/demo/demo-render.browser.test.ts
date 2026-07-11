import { describe, it, expect } from "vitest";
import { createDemoJob } from "./demo-project";
import { useOpsStore } from "../ops-store";
import { runEditRender, deleteJob } from "../jobs";
import { opfs } from "../../storage/opfs";
import { demuxVideoTrack } from "../codec/webcodecs/demux";
import { songDurationS, DEMO_SONG } from "./demo-song";

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

describe("demo project render (end-to-end through the real pipeline)", () => {
  it(
    "renders the demo job to a playable MP4 of roughly song length",
    async () => {
      const jobId = await createDemoJob();
      try {
        await waitForSyncDone(jobId);

        // Same call the editor's Export button makes, with the defaults a
        // user gets when they hit Export without touching anything.
        await runEditRender(jobId, { segments: [], overlays: [] });

        const op = useOpsStore.getState().ops[jobId]?.render;
        expect(op?.error).toBeUndefined();
        expect(op?.done).toBe(true);

        const out = await opfs.readFile(`jobs/${jobId}/output.mp4`);
        expect(out.size).toBeGreaterThan(50_000);

        const reparsed = await demuxVideoTrack(out);
        expect(reparsed).not.toBeNull();
        const expectS = songDurationS(DEMO_SONG);
        expect(reparsed!.info.durationS).toBeGreaterThan(expectS - 1.5);
        expect(reparsed!.info.durationS).toBeLessThan(expectS + 1.5);
      } finally {
        await deleteJob(jobId).catch(() => undefined);
      }
    },
    300_000,
  );
});
