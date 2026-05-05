import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncProgressPanel } from "./SyncProgressPanel";
import type { LocalJob } from "../../storage/jobs-db";
import { useOpsStore } from "../../local/ops-store";

function makeJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "abc123",
    title: "Test job",
    videoFilename: "shot1.mp4",
    audioFilename: "song.wav",
    createdAt: Date.now(),
    schemaVersion: 2,
    videos: [
      { id: "cam-1", filename: "shot1.mp4", opfsPath: "x", color: "#FF5722" },
      { id: "cam-2", filename: "shot2.mp4", opfsPath: "y", color: "#1F4E8C" },
    ],
    cuts: [],
    ...overrides,
  };
}

beforeEach(() => useOpsStore.setState({ ops: {} }));
afterEach(() => useOpsStore.setState({ ops: {} }));

describe("SyncProgressPanel", () => {
  it("renders one strip per cam", () => {
    useOpsStore.getState().startSyncOp("abc123", { pct: 10, stage: "syncing-cam-1" });
    render(<SyncProgressPanel job={makeJob()} />);
    expect(screen.getByText(/Cam 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Cam 2/i)).toBeInTheDocument();
    expect(screen.getByText("shot1.mp4")).toBeInTheDocument();
    expect(screen.getByText("shot2.mp4")).toBeInTheDocument();
  });

  it("shows the master audio filename", () => {
    useOpsStore.getState().startSyncOp("abc123", { pct: 10, stage: "syncing-cam-1" });
    render(<SyncProgressPanel job={makeJob()} />);
    expect(screen.getByText("song.wav")).toBeInTheDocument();
  });

  it("renders without crashing for an empty videos array", () => {
    const { container } = render(<SyncProgressPanel job={makeJob({ videos: [] })} />);
    expect(container.querySelector('[data-testid="sync-progress-panel"]')).toBeInTheDocument();
  });

  it("highlights the active cam by stage", () => {
    useOpsStore.getState().startSyncOp("abc123", { pct: 10, stage: "syncing-cam-1" });
    const { rerender } = render(<SyncProgressPanel job={makeJob()} />);
    // cam-2 is still pending while cam-1 syncs.
    expect(screen.queryByText(/pending/i)).toBeInTheDocument();
    // Switching to cam-2 active
    useOpsStore.getState().updateSyncOp("abc123", { pct: 50, stage: "syncing-cam-2" });
    rerender(<SyncProgressPanel job={makeJob()} />);
    expect(screen.getAllByText(/done/i).length).toBeGreaterThanOrEqual(1); // cam-1 done
  });

  it("shows ANALYSE indicator during analyzing-audio stage", () => {
    useOpsStore.getState().startSyncOp("abc123", { pct: 95, stage: "analyzing-audio" });
    render(<SyncProgressPanel job={makeJob()} />);
    expect(screen.getByText(/analyse/i)).toBeInTheDocument();
  });

  it("renders done-state when sync data is on the job and op cleared", () => {
    const job = makeJob({
      videos: [
        {
          id: "cam-1",
          filename: "shot1.mp4",
          opfsPath: "x",
          color: "#FF5722",
          sync: { offsetMs: 0, driftRatio: 1, confidence: 1 },
        },
        {
          id: "cam-2",
          filename: "shot2.mp4",
          opfsPath: "y",
          color: "#1F4E8C",
          sync: { offsetMs: 0, driftRatio: 1, confidence: 1 },
        },
      ],
    });
    const { container } = render(<SyncProgressPanel job={job} />);
    expect(container.querySelector('[data-testid="sync-progress-panel"]')).toBeInTheDocument();
    expect(screen.getAllByText(/done/i).length).toBeGreaterThanOrEqual(2);
  });

  it("renders failed-state without crashing", () => {
    useOpsStore.getState().startSyncOp("abc123", { pct: 50, stage: "syncing-cam-2" });
    useOpsStore.getState().failSyncOp("abc123", "decoder boom");
    render(<SyncProgressPanel job={makeJob()} />);
    expect(screen.getByText(/halted/i)).toBeInTheDocument();
  });
});
