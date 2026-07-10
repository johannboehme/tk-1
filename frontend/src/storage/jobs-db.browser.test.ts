import { describe, it, expect, beforeEach } from "vitest";
import { jobsDb, type LocalJob } from "./jobs-db";

/**
 * IndexedDB-Tests im echten Chromium. jsdom hätte fake-indexeddb, aber
 * Transaction-Semantik weicht in Edge-Cases ab — und die ganze Migration ist
 * darauf angewiesen dass die Persistenz im echten Browser funktioniert.
 */

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "job-" + Math.random().toString(36).slice(2, 10),
    title: null,
    videoFilename: "video.mp4",
    audioFilename: "audio.wav",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("jobs-db (real Chromium IndexedDB)", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
  });

  describe("saveJob + getJob", () => {
    it("stores a job and reads it back identically", async () => {
      const job = makeJob({ title: "My take" });
      await jobsDb.saveJob(job);

      const back = await jobsDb.getJob(job.id);
      expect(back).toEqual(job);
    });

    it("getJob returns undefined for missing id", async () => {
      expect(await jobsDb.getJob("nope")).toBeUndefined();
    });

    it("saveJob overwrites an existing job with the same id", async () => {
      const job = makeJob({ id: "fixed-id", title: "first" });
      await jobsDb.saveJob(job);
      await jobsDb.saveJob({ ...job, title: "second" });

      const back = await jobsDb.getJob("fixed-id");
      expect(back?.title).toBe("second");
    });
  });

  describe("listJobs", () => {
    it("returns empty array on empty store", async () => {
      expect(await jobsDb.listJobs()).toEqual([]);
    });

    it("returns jobs sorted by createdAt descending (newest first)", async () => {
      const a = makeJob({ id: "a", createdAt: 1000 });
      const b = makeJob({ id: "b", createdAt: 3000 });
      const c = makeJob({ id: "c", createdAt: 2000 });

      await jobsDb.saveJob(a);
      await jobsDb.saveJob(b);
      await jobsDb.saveJob(c);

      const list = await jobsDb.listJobs();
      expect(list.map((j) => j.id)).toEqual(["b", "c", "a"]);
    });
  });

  describe("updateJob", () => {
    it("merges patch onto existing job and returns the updated job", async () => {
      const job = makeJob({ title: "before" });
      await jobsDb.saveJob(job);

      const updated = await jobsDb.updateJob(job.id, {
        title: "after",
        sync: { offsetMs: 250, driftRatio: 1.0001, confidence: 0.85 },
      });
      expect(updated.title).toBe("after");
      expect(updated.sync).toEqual({
        offsetMs: 250,
        driftRatio: 1.0001,
        confidence: 0.85,
      });
      // Felder, die nicht im patch waren, bleiben erhalten:
      expect(updated.videoFilename).toBe("video.mp4");
    });

    it("throws when updating a non-existent job (does not silently create)", async () => {
      await expect(
        jobsDb.updateJob("ghost", { title: "x" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("deleteJob", () => {
    it("removes the job from the store", async () => {
      const job = makeJob();
      await jobsDb.saveJob(job);
      await jobsDb.deleteJob(job.id);
      expect(await jobsDb.getJob(job.id)).toBeUndefined();
    });

    it("does not throw when deleting a missing job", async () => {
      await expect(jobsDb.deleteJob("ghost")).resolves.toBeUndefined();
    });
  });
});

// -----------------------------------------------------------------------------
// #129 — updateJobGuarded: compare-and-set on editRev, atomic in one tx
// -----------------------------------------------------------------------------

describe("updateJobGuarded (#129)", () => {
  beforeEach(async () => {
    await jobsDb.wipeAll();
  });

  it("writes the patch and bumps editRev when the expected rev matches", async () => {
    const job = makeJob({ id: "g1", title: "before" });
    await jobsDb.saveJob(job); // no editRev yet → treated as rev 0

    const res = await jobsDb.updateJobGuarded("g1", 0, { title: "after" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.job.title).toBe("after");
      expect(res.job.editRev).toBe(1);
    }
    const back = await jobsDb.getJob("g1");
    expect(back?.title).toBe("after");
    expect(back?.editRev).toBe(1);
  });

  it("refuses the write and reports the current rev on mismatch", async () => {
    await jobsDb.saveJob(makeJob({ id: "g2", title: "tab-B-version", editRev: 5 }));

    const res = await jobsDb.updateJobGuarded("g2", 1, { title: "tab-A-stale" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.currentRev).toBe(5);
    // Nothing was clobbered.
    const back = await jobsDb.getJob("g2");
    expect(back?.title).toBe("tab-B-version");
    expect(back?.editRev).toBe(5);
  });

  it("sequential guarded writes with tracked revs all land", async () => {
    await jobsDb.saveJob(makeJob({ id: "g3" }));
    const r1 = await jobsDb.updateJobGuarded("g3", 0, { title: "one" });
    expect(r1.ok).toBe(true);
    const r2 = await jobsDb.updateJobGuarded("g3", 1, { title: "two" });
    expect(r2.ok).toBe(true);
    const back = await jobsDb.getJob("g3");
    expect(back?.title).toBe("two");
    expect(back?.editRev).toBe(2);
  });

  it("throws for a missing job", async () => {
    await expect(jobsDb.updateJobGuarded("missing", 0, {})).rejects.toThrow(
      /not found/i,
    );
  });

  it("a patch cannot smuggle its own editRev/id past the guard", async () => {
    await jobsDb.saveJob(makeJob({ id: "g4" }));
    const res = await jobsDb.updateJobGuarded("g4", 0, {
      editRev: 999,
      id: "hijack",
    } as Partial<LocalJob>);
    expect(res.ok).toBe(true);
    const back = await jobsDb.getJob("g4");
    expect(back?.editRev).toBe(1);
    expect(back?.id).toBe("g4");
  });
});
