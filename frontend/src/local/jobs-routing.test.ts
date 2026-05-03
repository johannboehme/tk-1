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

  it("routes longform jobs without chunks to /triage", () => {
    const job = baseJob({ mode: "longform" });
    expect(nextRouteForJob(job)).toBe("triage");
  });

  it("routes longform jobs with empty chunks[] to /triage", () => {
    const job = baseJob({ mode: "longform", chunks: [] });
    expect(nextRouteForJob(job)).toBe("triage");
  });

  it("routes longform with chunks but no arrangement to /arrange", () => {
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
    expect(nextRouteForJob(job)).toBe("arrange");
  });

  it("routes longform with chunks and empty arrangement[] to /arrange", () => {
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

  it("routes longform with chunks and arrangement to /edit", () => {
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

  it("ignores arrangement when chunks are missing (defensive)", () => {
    const job = baseJob({
      mode: "longform",
      arrangement: [{ id: "a1", chunkId: "c1" }],
    });
    expect(nextRouteForJob(job)).toBe("triage");
  });
});
