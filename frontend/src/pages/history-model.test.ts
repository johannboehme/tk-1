import { describe, expect, it } from "vitest";
import type { LocalJob } from "../storage/jobs-db";
import type { JobOps } from "../local/ops-store";
import { activePct, jobBadge } from "./history-model";

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  const sync = { offsetMs: 12, driftRatio: 1, confidence: 0.9 };
  return {
    id: "job-1",
    title: "My Song",
    videoFilename: "take-1.mp4",
    audioFilename: "song.wav",
    createdAt: Date.now(),
    schemaVersion: 3,
    mode: "direct",
    sync,
    cuts: [],
    videos: [
      {
        kind: "video",
        id: "cam-1",
        filename: "take-1.mp4",
        opfsPath: "jobs/job-1/cam-1.mp4",
        color: "#dd4a1f",
        sync,
      },
    ],
    ...overrides,
  };
}

const rendered = { lastRender: { completedAt: 1, outputBytes: 100 } };

describe("jobBadge (#92)", () => {
  it("shows 'rendering' only while a render op is live", () => {
    const ops: JobOps = { render: { pct: 40, stage: "encoding" } };
    expect(jobBadge(makeJob(), ops)).toBe("rendering");
  });

  it("treats a done render op as terminal — falls through to 'rendered'", () => {
    const ops: JobOps = {
      render: { pct: 100, stage: "rendered", done: true },
    };
    expect(jobBadge(makeJob(rendered), ops)).toBe("rendered");
  });

  it("does not brand a deliberate cancel as failed", () => {
    const ops: JobOps = {
      render: { pct: 40, stage: "encoding", error: "cancelled" },
    };
    // Sync data exists, no prior render → back to plain "synced".
    expect(jobBadge(makeJob(), ops)).toBe("synced");
    // With an earlier successful render the job is still "rendered".
    expect(jobBadge(makeJob(rendered), ops)).toBe("rendered");
  });

  it("still shows 'failed' for a real render error", () => {
    const ops: JobOps = {
      render: { pct: 40, stage: "encoding", error: "encoder exploded" },
    };
    expect(jobBadge(makeJob(), ops)).toBe("failed");
  });

  it("keeps the sync-derived states without ops", () => {
    expect(jobBadge(makeJob(), undefined)).toBe("synced");
    expect(jobBadge(makeJob(rendered), undefined)).toBe("rendered");
    const unsynced = makeJob();
    delete (unsynced.videos![0] as { sync?: unknown }).sync;
    expect(jobBadge(unsynced, undefined)).toBe("needs-sync");
  });
});

describe("activePct (#92)", () => {
  it("returns the pct of a live render op", () => {
    expect(activePct({ render: { pct: 40, stage: "encoding" } })).toBe(40);
  });

  it("returns null for done or errored render ops", () => {
    expect(
      activePct({ render: { pct: 100, stage: "rendered", done: true } }),
    ).toBeNull();
    expect(
      activePct({ render: { pct: 40, stage: "encoding", error: "cancelled" } }),
    ).toBeNull();
  });

  it("returns the pct of a live sync op, but not a failed one", () => {
    expect(activePct({ sync: { pct: 33, stage: "syncing-cam-1" } })).toBe(33);
    expect(
      activePct({ sync: { pct: 33, stage: "syncing-cam-1", error: "boom" } }),
    ).toBeNull();
  });

  it("returns null without ops", () => {
    expect(activePct(undefined)).toBeNull();
  });
});
