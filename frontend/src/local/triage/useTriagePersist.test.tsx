/**
 * Triage auto-persist hook — write scheduling.
 *
 * The critical property under test: a pending debounced write is
 * FLUSHED on unmount, not dropped. Dropping it (the old behaviour) let
 * "tweak a slider, quickly hit Back / Continue" leave IDB with a new
 * silenceConfig paired with a stale chunk list — after which Arrange's
 * mount reconcile pruned arrangement items referencing chunk ids that
 * were never persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTriagePersist } from "./useTriagePersist";
import { useTriageStore } from "./triage-store";
import { jobsDb } from "../jobs";
import type { Chunk } from "../../storage/jobs-db";

vi.mock("../jobs", () => ({
  jobsDb: { getJob: vi.fn(), updateJob: vi.fn() },
}));

const getJobMock = vi.mocked(jobsDb.getJob);
const updateJobMock = vi.mocked(jobsDb.updateJob);

function makeChunk(
  overrides: Partial<Chunk> & Pick<Chunk, "id" | "startMs" | "endMs">,
): Chunk {
  return {
    bpmOctaveShift: 0,
    effectiveBpm: 0,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...overrides,
  };
}

function seedStore(chunks: Chunk[]) {
  useTriageStore.setState({
    jobId: "job-1",
    audioDuration: 600,
    pcm: new Float32Array(0),
    pcmSampleRate: 22050,
    envelope: new Float32Array(100),
    envelopeHz: 10,
    cams: [],
    chunks,
    silenceConfig: { thresholdDb: -50, minPauseMs: 1500 },
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useTriageStore.getState().reset();
  getJobMock.mockResolvedValue({
    id: "job-1",
    videos: [],
    arrangement: [],
    ui: {},
  } as never);
  updateJobMock.mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
  useTriageStore.getState().reset();
});

describe("useTriagePersist — debounced writes", () => {
  it("writes the watched slice 250 ms after a mutation", async () => {
    const { unmount } = renderHook(() => useTriagePersist());
    act(() => seedStore([makeChunk({ id: "c1", startMs: 0, endMs: 5000 })]));
    await flush(300);
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock.mock.calls[0][1]).toMatchObject({
      chunks: [expect.objectContaining({ id: "c1" })],
      silenceConfig: { thresholdDb: -50, minPauseMs: 1500 },
    });
    unmount();
  });

  it("flushes a pending write on unmount instead of dropping it", async () => {
    const { unmount } = renderHook(() => useTriagePersist());
    act(() => seedStore([makeChunk({ id: "c1", startMs: 0, endMs: 5000 })]));
    await flush(300); // initial hydration write lands
    updateJobMock.mockClear();

    // Mutate, then unmount within the debounce window — the classic
    // "slider tweak → immediately hit Back" sequence.
    act(() => {
      useTriageStore.setState({
        silenceConfig: { thresholdDb: -42, minPauseMs: 1500 },
        chunks: [makeChunk({ id: "c1-trimmed", startMs: 100, endMs: 4800 })],
      });
    });
    unmount();
    await flush(0);

    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock.mock.calls[0][1]).toMatchObject({
      silenceConfig: { thresholdDb: -42, minPauseMs: 1500 },
      chunks: [expect.objectContaining({ id: "c1-trimmed" })],
    });
  });

  it("does not write on unmount when nothing is pending", async () => {
    const { unmount } = renderHook(() => useTriagePersist());
    act(() => seedStore([makeChunk({ id: "c1", startMs: 0, endMs: 5000 })]));
    await flush(300);
    updateJobMock.mockClear();

    unmount();
    await flush(0);
    expect(updateJobMock).not.toHaveBeenCalled();
  });
});
