import { describe, it, expect, beforeEach } from "vitest";
import {
  installRenderUnloadGuard,
  removeRenderUnloadGuard,
  activeRenderJobsForTest,
  pruneIfQuotaTight,
  requestPersistentStorage,
} from "./lifecycle";
import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "j-" + Math.random().toString(36).slice(2, 10),
    title: null,
    videoFilename: "v.mp4",
    audioFilename: "a.wav",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("install/removeRenderUnloadGuard", () => {
  it("tracks active jobs in a shared set", () => {
    expect(activeRenderJobsForTest().size).toBe(0);
    installRenderUnloadGuard("a");
    installRenderUnloadGuard("b");
    expect(activeRenderJobsForTest().has("a")).toBe(true);
    expect(activeRenderJobsForTest().has("b")).toBe(true);
    removeRenderUnloadGuard("a");
    expect(activeRenderJobsForTest().has("a")).toBe(false);
    removeRenderUnloadGuard("b");
    expect(activeRenderJobsForTest().size).toBe(0);
  });
});

describe("requestPersistentStorage", () => {
  it("returns a boolean (true if granted, false if denied/unavailable)", async () => {
    const r = await requestPersistentStorage();
    expect(typeof r).toBe("boolean");
  });
});

describe("pruneIfQuotaTight", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
  });

  it("returns 0 when usage is below high-water mark", async () => {
    // jsdom-fresh storage = ~0 usage. No prune expected.
    const pruned = await pruneIfQuotaTight();
    expect(pruned).toBe(0);
  });

  it("when forced (high watermark surpassed via stub) deletes oldest rendered jobs first and skips protected ids", async () => {
    // Set up: three jobs with `lastRender` of varying age + one without.
    const now = Date.now();
    const lastRender = (completedAt: number) => ({
      completedAt,
      outputBytes: 1024,
    });
    await jobsDb.saveJob(
      makeJob({ id: "old-1", lastRender: lastRender(now - 1000_000), createdAt: now - 1000_000 }),
    );
    await jobsDb.saveJob(
      makeJob({ id: "mid-1", lastRender: lastRender(now - 500_000), createdAt: now - 500_000 }),
    );
    await jobsDb.saveJob(
      makeJob({ id: "new-1", lastRender: lastRender(now - 100_000), createdAt: now - 100_000 }),
    );
    await jobsDb.saveJob(makeJob({ id: "active", createdAt: now }));

    // Stub navigator.storage.estimate to lie that we're full.
    const origEstimate = navigator.storage.estimate.bind(navigator.storage);
    let queriedTimes = 0;
    (navigator.storage as { estimate: () => Promise<{ quota: number; usage: number }> }).estimate =
      async () => {
        queriedTimes++;
        // Stay above HIGH_WATER for the first call so prune kicks in,
        // then drop to under LOW_WATER to stop the loop after one prune.
        if (queriedTimes === 1) return { quota: 100, usage: 90 };
        return { quota: 100, usage: 50 };
      };

    try {
      const pruned = await pruneIfQuotaTight(["active"]);
      expect(pruned).toBe(1);
      // Oldest gone, others survive (since we stopped after one prune).
      expect(await jobsDb.getJob("old-1")).toBeUndefined();
      expect(await jobsDb.getJob("mid-1")).toBeDefined();
      expect(await jobsDb.getJob("new-1")).toBeDefined();
      expect(await jobsDb.getJob("active")).toBeDefined();
    } finally {
      (navigator.storage as { estimate: typeof origEstimate }).estimate = origEstimate;
    }
  });

  it("never prunes a job without lastRender, even if it's old", async () => {
    const now = Date.now();
    await jobsDb.saveJob(makeJob({ id: "ancient-no-output", createdAt: now - 9_000_000 }));

    const origEstimate = navigator.storage.estimate.bind(navigator.storage);
    let queriedTimes = 0;
    (navigator.storage as { estimate: () => Promise<{ quota: number; usage: number }> }).estimate =
      async () => {
        queriedTimes++;
        return queriedTimes === 1
          ? { quota: 100, usage: 90 }
          : { quota: 100, usage: 50 };
      };

    try {
      const pruned = await pruneIfQuotaTight();
      expect(pruned).toBe(0);
      expect(await jobsDb.getJob("ancient-no-output")).toBeDefined();
    } finally {
      (navigator.storage as { estimate: typeof origEstimate }).estimate = origEstimate;
    }
  });
});
