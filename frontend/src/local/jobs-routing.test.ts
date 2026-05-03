import { describe, it, expect } from "vitest";
import { nextRouteForJob } from "./jobs-routing";
import type { LocalJob } from "../storage/jobs-db";

function baseJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "job-1",
    title: null,
    videoFilename: "video.mp4",
    audioFilename: "audio.wav",
    status: "synced",
    progress: { pct: 100, stage: "synced" },
    hasOutput: false,
    createdAt: 0,
    ...overrides,
  };
}

describe("nextRouteForJob", () => {
  it("routes direct-mode jobs straight to /edit", () => {
    const job = baseJob({ mode: "direct" });
    expect(nextRouteForJob(job)).toBe("edit");
  });

  it("treats jobs without explicit mode as direct (legacy default)", () => {
    const job = baseJob({});
    expect(nextRouteForJob(job)).toBe("edit");
  });

  it("routes longform without arrangement to /triage (even if chunks auto-detected)", () => {
    const job = baseJob({ mode: "longform" });
    expect(nextRouteForJob(job)).toBe("triage");
  });

  it("treats auto-detected chunks alone as 'still in triage'", () => {
    const job = baseJob({
      mode: "longform",
      chunks: [
        {
          id: "c1",
          startMs: 0,
          endMs: 10_000,
          bpmOctaveShift: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "auto",
        },
      ],
    });
    expect(nextRouteForJob(job)).toBe("triage");
  });

  it("treats arrangement === [] as 'triage done, arrange empty' → /arrange", () => {
    const job = baseJob({
      mode: "longform",
      chunks: [
        {
          id: "c1",
          startMs: 0,
          endMs: 10_000,
          bpmOctaveShift: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "auto",
        },
      ],
      arrangement: [],
    });
    expect(nextRouteForJob(job)).toBe("arrange");
  });

  it("routes longform with arrangement items to /edit", () => {
    const job = baseJob({
      mode: "longform",
      chunks: [
        {
          id: "c1",
          startMs: 0,
          endMs: 10_000,
          bpmOctaveShift: 0,
          effectiveBpm: 120,
          beatsPerBar: 4,
          accepted: true,
          trimMode: "auto",
        },
      ],
      arrangement: [{ id: "a1", chunkId: "c1" }],
    });
    expect(nextRouteForJob(job)).toBe("edit");
  });
});
