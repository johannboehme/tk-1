import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import History from "./History";
import ConfirmDialogHost from "../components/ConfirmDialogHost";
import { deleteJob, jobsDb } from "../local/jobs";
import { getCachedAnalysis } from "../local/render/audio-analysis";
import type { AudioAnalysis } from "../local/render/audio-analysis";
import type { LocalJob } from "../storage/jobs-db";

vi.mock("../local/jobs", () => ({
  jobEvents: new EventTarget(),
  jobsDb: { listJobs: vi.fn() },
  deleteJob: vi.fn(),
}));

vi.mock("../local/render/audio-analysis", () => ({
  getCachedAnalysis: vi.fn(),
}));

const listJobsMock = vi.mocked(jobsDb.listJobs);
const getCachedAnalysisMock = vi.mocked(getCachedAnalysis);

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

function renderHistory() {
  return render(
    <MemoryRouter>
      <History />
      <ConfirmDialogHost />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listJobsMock.mockResolvedValue([makeJob()]);
  vi.mocked(deleteJob).mockResolvedValue(undefined);
  getCachedAnalysisMock.mockResolvedValue(undefined);
});

describe("History — tile duration (#144)", () => {
  it("shows the master-audio duration, not the first video's", async () => {
    listJobsMock.mockResolvedValue([makeJob({ durationS: 12 })]);
    getCachedAnalysisMock.mockResolvedValue({
      duration: 30,
    } as AudioAnalysis);

    renderHistory();
    expect(await screen.findByText("0:30")).toBeTruthy();
    expect(screen.queryByText("0:12")).toBeNull();
  });

  it("falls back to the job duration when no analysis is cached", async () => {
    listJobsMock.mockResolvedValue([makeJob({ durationS: 12 })]);

    renderHistory();
    expect(await screen.findByText("0:12")).toBeTruthy();
  });
});

describe("History — delete affordance (#133)", () => {
  it("keeps the delete button visible (no opacity gating)", async () => {
    renderHistory();
    const btn = await screen.findByRole("button", { name: /delete job/i });
    expect(btn.className).not.toMatch(/opacity-0/);
  });

  it("deletes via the confirm dialog", async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /delete job/i }));

    // ConfirmDialogHost modal, not window.confirm.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => {
      expect(deleteJob).toHaveBeenCalledWith("job-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("My Song")).toBeNull();
    });
  });

  it("does not delete when the dialog is cancelled", async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /delete job/i }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(deleteJob).not.toHaveBeenCalled();
    expect(screen.getByText("My Song")).toBeTruthy();
  });
});
