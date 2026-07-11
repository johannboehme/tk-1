import { describe, it, expect } from "vitest";
import { createDemoJob } from "./demo-project";
import { DEMO_SESSION, buildDemoSessionScore } from "./demo-song";
import { useOpsStore } from "../ops-store";
import { jobsDb, deleteJob } from "../jobs";
import { isVideoAsset } from "../../storage/jobs-db";

/** Wait until the sync op for `jobId` clears (success) or errors. */
function waitForSyncDone(jobId: string, timeoutMs = 240_000): Promise<void> {
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

describe("long-form demo (end-to-end through sync + chunk detection)", () => {
  it(
    "detects the session's sections as chunks with one global tempo",
    async () => {
      const jobId = await createDemoJob({ mode: "longform" });
      try {
        await waitForSyncDone(jobId);

        const job = await jobsDb.getJob(jobId);
        expect(job).not.toBeNull();
        expect(job!.mode).toBe("longform");
        expect(job!.title).toBe("Demo session · long-form");

        // Both cams prepped with real sync offsets.
        const cams = (job!.videos ?? []).filter(isVideoAsset);
        expect(cams).toHaveLength(2);
        for (const cam of cams) {
          expect(cam.sync).toBeDefined();
          expect(cam.framesPath).toBeTruthy();
        }

        // Chunk detection found the session's loud sections — one chunk
        // per synthesized section, boundaries within a couple hundred ms
        // (10 Hz envelope + bar-snap tolerance).
        const { sections } = buildDemoSessionScore(DEMO_SESSION);
        const chunks = job!.chunks ?? [];
        expect(chunks).toHaveLength(sections.length);
        for (const [i, section] of sections.entries()) {
          expect(
            Math.abs(chunks[i].startMs - section.startS * 1000),
            `chunk ${i} start`,
          ).toBeLessThan(400);
          // End may be bar-snapped backwards from the raw silence edge,
          // so allow up to a bar (~2.2 s) early but not late.
          expect(chunks[i].endMs).toBeGreaterThan(section.startS * 1000 + 2000);
          expect(chunks[i].endMs).toBeLessThan(section.endS * 1000 + 400);
        }

        // ONE tempo: global BPM aggregated from the chunks ≈ 112.
        expect(job!.bpm).toBeDefined();
        expect(Math.abs(job!.bpm!.value - DEMO_SESSION.bpm)).toBeLessThan(3);

        // Triage phase gating: no arrangement yet — the user curates it.
        expect(job!.arrangement).toBeUndefined();
      } finally {
        await deleteJob(jobId).catch(() => undefined);
      }
    },
    300_000,
  );
});
