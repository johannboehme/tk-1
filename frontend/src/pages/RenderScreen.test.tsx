import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RenderScreen from "./RenderScreen";
import { useOpsStore } from "../local/ops-store";
import { cancelEditRender, jobsDb } from "../local/jobs";

vi.mock("../local/jobs", () => ({
  jobEvents: new EventTarget(),
  jobsDb: { getJob: vi.fn() },
  cancelEditRender: vi.fn(),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/job/job-1/render"]}>
      <Routes>
        <Route path="/job/:id/render" element={<RenderScreen />} />
        <Route path="/job/:id" element={<div>job page</div>} />
        <Route path="/job/:id/edit" element={<div>editor</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useOpsStore.setState({ ops: {} });
  vi.mocked(jobsDb.getJob).mockResolvedValue(undefined);
  vi.mocked(cancelEditRender).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RenderScreen — op lifecycle (#92)", () => {
  it("clears the render op when auto-navigating after done", async () => {
    useOpsStore.getState().startRenderOp("job-1", { pct: 90, stage: "writing" });
    useOpsStore.getState().finishRenderOp("job-1");

    vi.useFakeTimers();
    renderPage();
    expect(screen.getByText("Render done")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByText("job page")).toBeTruthy();
    expect(useOpsStore.getState().ops["job-1"]?.render).toBeUndefined();
  });

  it("clears the render op on cancel so History doesn't show FAIL", async () => {
    useOpsStore.getState().startRenderOp("job-1", { pct: 40, stage: "encoding" });
    // Mimic cancelEditRender's store side effect (jobs.ts flags the op).
    vi.mocked(cancelEditRender).mockImplementation(async (jobId: string) => {
      useOpsStore.getState().failRenderOp(jobId, "cancelled");
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /cancel render/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("editor")).toBeTruthy();
    });
    expect(cancelEditRender).toHaveBeenCalledWith("job-1");
    expect(useOpsStore.getState().ops["job-1"]?.render).toBeUndefined();
  });
});
