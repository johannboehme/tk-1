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

describe("RenderScreen — no render in progress (#93)", () => {
  it("shows an explicit empty state instead of fake perpetual progress", async () => {
    vi.useFakeTimers();
    renderPage(); // ops store is empty — nothing is rendering

    await act(async () => {
      vi.advanceTimersByTime(2500); // let the grace window elapse
    });

    expect(screen.getByText(/no render in progress/i)).toBeTruthy();
    // No fake progress console, no ghost cancel button.
    expect(screen.queryByText("Rendering…")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /cancel render/i }),
    ).toBeNull();

    // Primary exit takes the user back to the editor.
    fireEvent.click(screen.getByRole("button", { name: /back to editor/i }));
    expect(screen.getByText("editor")).toBeTruthy();
  });

  it("keeps the live progress console when an op appears in time", async () => {
    vi.useFakeTimers();
    renderPage();
    act(() => {
      useOpsStore
        .getState()
        .startRenderOp("job-1", { pct: 10, stage: "render-prep" });
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText(/no render in progress/i)).toBeNull();
    expect(screen.getByText("Rendering…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /cancel render/i }),
    ).toBeTruthy();
  });
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
