/**
 * DetectionPanel — slider-driven re-detection.
 *
 * Covers the destructive-action gate (issue #71): the first slider
 * tweak in a session with downstream work (persisted arrangement or
 * manual chunk edits) must go through the same confirmDestructive()
 * dialog as reject/split/join — and a cancel must leave the config and
 * chunks untouched. Also covers that re-detection results flow through
 * the overlap merge (decisions survive a boundary shift).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DetectionPanel } from "./DetectionPanel";
import { useTriageStore } from "../../local/triage/triage-store";
import { jobsDb } from "../../local/jobs";
import { confirmDestructive } from "../../lib/confirm";
import { detectChunksFromEnvelope } from "../../local/triage/chunk-detect";
import type { Chunk } from "../../storage/jobs-db";

vi.mock("../../local/jobs", () => ({
  jobsDb: { getJob: vi.fn(), updateJob: vi.fn() },
}));
vi.mock("../../lib/confirm", () => ({
  confirmDestructive: vi.fn(),
}));
vi.mock("../../local/triage/chunk-detect", () => ({
  detectChunksFromEnvelope: vi.fn(),
}));

const getJobMock = vi.mocked(jobsDb.getJob);
const confirmMock = vi.mocked(confirmDestructive);
const detectMock = vi.mocked(detectChunksFromEnvelope);

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

function detectionResult(chunks: Chunk[]) {
  return { chunks, envelope: new Float32Array(10), envelopeHz: 10 };
}

function seedStore(chunks: Chunk[]) {
  useTriageStore.getState().reset();
  useTriageStore.setState({
    jobId: "job-1",
    audioDuration: 600,
    pcm: new Float32Array(0),
    pcmSampleRate: 22050,
    pcmDecoding: false,
    envelope: new Float32Array(100),
    envelopeHz: 10,
    chunks,
    silenceConfig: { thresholdDb: -50, minPauseMs: 1500 },
  });
}

async function flush(ms = 100) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getJobMock.mockResolvedValue(undefined as never);
  detectMock.mockResolvedValue(detectionResult([]));
});

afterEach(() => {
  vi.useRealTimers();
  useTriageStore.getState().reset();
});

describe("DetectionPanel — destructive re-detect gate", () => {
  it("asks for confirmation when a persisted arrangement exists; cancel is a no-op", async () => {
    seedStore([makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 })]);
    getJobMock.mockResolvedValue({
      arrangement: [{ id: "a1", chunkId: "chunk-10000-20000" }],
    } as never);
    confirmMock.mockResolvedValue(false);

    render(<DetectionPanel />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Threshold" }), {
      key: "ArrowRight",
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-50);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it("asks for confirmation when chunks carry manual edits (no arrangement)", async () => {
    seedStore([
      makeChunk({ id: "chunk-1", startMs: 10000, endMs: 20000, trimMode: "bar" }),
    ]);
    getJobMock.mockResolvedValue({ arrangement: [] } as never);
    confirmMock.mockResolvedValue(false);

    render(<DetectionPanel />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Threshold" }), {
      key: "ArrowRight",
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-50);
  });

  it("runs the re-detect after the user confirms, and only asks once per session", async () => {
    seedStore([
      makeChunk({
        id: "chunk-10000-20000",
        startMs: 10000,
        endMs: 20000,
        accepted: false,
      }),
    ]);
    getJobMock.mockResolvedValue({
      arrangement: [{ id: "a1", chunkId: "chunk-10000-20000" }],
    } as never);
    confirmMock.mockResolvedValue(true);
    detectMock.mockResolvedValue(
      detectionResult([
        makeChunk({ id: "chunk-9900-20100", startMs: 9900, endMs: 20100 }),
      ]),
    );

    render(<DetectionPanel />);
    const slider = screen.getByRole("slider", { name: "Threshold" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await flush();

    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-49);
    expect(detectMock).toHaveBeenCalledTimes(1);
    // The overlap merge preserved identity + the DROP decision across
    // the 100 ms boundary shift.
    const chunks = useTriageStore.getState().chunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("chunk-10000-20000");
    expect(chunks[0].accepted).toBe(false);
    expect(chunks[0].startMs).toBe(9900);

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-48);
  });

  it("disables the sliders with a hint while the background PCM decode runs", async () => {
    // Cached open seeds the store with a length-0 PCM and decodes in the
    // background — a re-detect in that window would strip analysis from
    // every chunk. The sliders must not fire until PCM lands.
    seedStore([makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 })]);
    act(() => {
      useTriageStore.setState({ pcmDecoding: true });
    });
    getJobMock.mockResolvedValue({ arrangement: [] } as never);

    render(<DetectionPanel />);
    const slider = screen.getByRole("slider", { name: "Threshold" });
    expect(slider).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/decoding audio/i)).toBeInTheDocument();

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await flush();
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-50);
    expect(detectMock).not.toHaveBeenCalled();

    // PCM landed → sliders come back to life.
    act(() => {
      useTriageStore.setState({ pcmDecoding: false });
    });
    expect(screen.queryByText(/decoding audio/i)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Threshold" }), {
      key: "ArrowRight",
    });
    await flush();
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-49);
  });

  it("does not ask on a clean session (no arrangement, no manual edits)", async () => {
    seedStore([makeChunk({ id: "chunk-10000-20000", startMs: 10000, endMs: 20000 })]);
    getJobMock.mockResolvedValue({ arrangement: [] } as never);

    render(<DetectionPanel />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Threshold" }), {
      key: "ArrowRight",
    });
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(useTriageStore.getState().silenceConfig.thresholdDb).toBe(-49);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });
});
