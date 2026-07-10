import { describe, it, expect, beforeEach } from "vitest";
import {
  installRenderUnloadGuard,
  removeRenderUnloadGuard,
  activeRenderJobsForTest,
  maybePromptQuotaPrune,
  requestPersistentStorage,
  sweepOrphanJobDirs,
} from "./lifecycle";
import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";
import { useConfirmStore } from "../lib/confirm";

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

/** Auto-answer every destructive confirm dialog that appears while the
 *  returned unsubscribe hasn't been called. Counts the dialogs seen. */
function autoAnswerConfirm(answer: boolean): { seen: () => number; stop: () => void } {
  let seen = 0;
  const respond = () => {
    const top = useConfirmStore.getState().requests[0];
    if (top && top.kind === "destructive") {
      seen++;
      useConfirmStore.getState().resolve(top.id, answer);
    }
  };
  const unsub = useConfirmStore.subscribe(respond);
  respond();
  return { seen: () => seen, stop: unsub };
}

/** Stub navigator.storage.estimate: first call reports `first`, all
 *  later calls report `rest`. Returns a restore function. */
function stubEstimate(
  first: { quota: number; usage: number },
  rest: { quota: number; usage: number },
): () => void {
  const orig = navigator.storage.estimate.bind(navigator.storage);
  let calls = 0;
  (navigator.storage as {
    estimate: () => Promise<{ quota: number; usage: number }>;
  }).estimate = async () => {
    calls++;
    return calls === 1 ? first : rest;
  };
  return () => {
    (navigator.storage as { estimate: typeof orig }).estimate = orig;
  };
}

describe("maybePromptQuotaPrune (#64)", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
    useConfirmStore.setState({ requests: [] });
  });

  it("returns 0 and shows no dialog when usage is below high-water mark", async () => {
    await jobsDb.saveJob(
      makeJob({ id: "done", lastRender: { completedAt: 1, outputBytes: 1 } }),
    );
    // jsdom-fresh storage = ~0 usage. No prune expected.
    const pruned = await maybePromptQuotaPrune();
    expect(pruned).toBe(0);
    expect(useConfirmStore.getState().requests).toEqual([]);
  });

  it("after consent, deletes oldest rendered jobs first, skips protected ids, stops at low water", async () => {
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

    // Above HIGH_WATER on the first call so the guard kicks in, then
    // under LOW_WATER so the delete loop stops after one job.
    const restore = stubEstimate(
      { quota: 100, usage: 90 },
      { quota: 100, usage: 50 },
    );
    const consent = autoAnswerConfirm(true);
    try {
      const pruned = await maybePromptQuotaPrune(["active"]);
      expect(consent.seen()).toBe(1);
      expect(pruned).toBe(1);
      // Oldest gone, others survive (since we stopped after one prune).
      expect(await jobsDb.getJob("old-1")).toBeUndefined();
      expect(await jobsDb.getJob("mid-1")).toBeDefined();
      expect(await jobsDb.getJob("new-1")).toBeDefined();
      expect(await jobsDb.getJob("active")).toBeDefined();
    } finally {
      consent.stop();
      restore();
    }
  });

  it("deletes NOTHING when the user declines", async () => {
    const now = Date.now();
    await jobsDb.saveJob(
      makeJob({
        id: "keep-me",
        lastRender: { completedAt: now, outputBytes: 1024 },
        createdAt: now - 1000_000,
      }),
    );
    const restore = stubEstimate(
      { quota: 100, usage: 90 },
      { quota: 100, usage: 90 },
    );
    const consent = autoAnswerConfirm(false);
    try {
      const pruned = await maybePromptQuotaPrune();
      expect(consent.seen()).toBe(1);
      expect(pruned).toBe(0);
      expect(await jobsDb.getJob("keep-me")).toBeDefined();
    } finally {
      consent.stop();
      restore();
    }
  });

  it("never proposes a job without lastRender, even if it's old", async () => {
    const now = Date.now();
    await jobsDb.saveJob(
      makeJob({ id: "ancient-no-output", createdAt: now - 9_000_000 }),
    );
    const restore = stubEstimate(
      { quota: 100, usage: 90 },
      { quota: 100, usage: 50 },
    );
    const consent = autoAnswerConfirm(true);
    try {
      const pruned = await maybePromptQuotaPrune();
      // No candidates → no dialog, nothing deleted.
      expect(consent.seen()).toBe(0);
      expect(pruned).toBe(0);
      expect(await jobsDb.getJob("ancient-no-output")).toBeDefined();
    } finally {
      consent.stop();
      restore();
    }
  });
});

describe("sweepOrphanJobDirs (#119)", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
    await opfs.wipeAll();
  });

  it("deletes stale jobs/* dirs without a DB row, keeps tracked dirs", async () => {
    await opfs.writeFile("jobs/orphan-1/cam-1.mp4", new Blob([new Uint8Array(64)]));
    await opfs.writeFile("jobs/tracked/cam-1.mp4", new Blob([new Uint8Array(64)]));
    await jobsDb.saveJob(makeJob({ id: "tracked" }));

    // Pass a future "now": freshly-written dirs are otherwise protected
    // by the min-age guard below.
    const removed = await sweepOrphanJobDirs(Date.now() + 2 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await opfs.exists("jobs/orphan-1/cam-1.mp4")).toBe(false);
    expect(await opfs.exists("jobs/tracked/cam-1.mp4")).toBe(true);
  });

  it("spares fresh orphan dirs — they may belong to a createJob in flight", async () => {
    await opfs.writeFile("jobs/mid-create/audio.wav", new Blob([new Uint8Array(64)]));
    const removed = await sweepOrphanJobDirs();
    expect(removed).toBe(0);
    expect(await opfs.exists("jobs/mid-create/audio.wav")).toBe(true);
  });

  it("is a no-op when the jobs/ dir does not exist", async () => {
    expect(await sweepOrphanJobDirs()).toBe(0);
  });
});
