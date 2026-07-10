import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobPage from "./JobPage";
import { useOpsStore } from "../local/ops-store";
import {
  deleteJob,
  jobsDb,
  resolveJobAssetUrl,
  runQuickRender,
  type LocalJob,
} from "../local/jobs";

vi.mock("../local/jobs", () => ({
  jobEvents: new EventTarget(),
  jobsDb: { getJob: vi.fn(), updateJob: vi.fn() },
  deleteJob: vi.fn(),
  resolveJobAssetUrl: vi.fn(),
  runQuickRender: vi.fn(),
}));

const getJobMock = vi.mocked(jobsDb.getJob);
const resolveUrlMock = vi.mocked(resolveJobAssetUrl);
const runQuickRenderMock = vi.mocked(runQuickRender);

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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/job/job-1"]}>
      <Routes>
        <Route path="/job/:id" element={<JobPage />} />
        <Route path="/jobs" element={<div>jobs list</div>} />
        <Route path="/job/:id/edit" element={<div>editor</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useOpsStore.setState({ ops: {} });
  getJobMock.mockResolvedValue(makeJob());
  resolveUrlMock.mockResolvedValue(null);
  vi.mocked(deleteJob).mockResolvedValue(undefined);
  // jsdom ships createObjectURL/revokeObjectURL-less URL — the page's
  // object-URL cleanup must not explode on unmount.
  if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => undefined;
  }
});

describe("JobPage — quick render feedback + double-start guard (#91)", () => {
  it("disables the button and shows progress while a render op is active", async () => {
    renderPage();
    await screen.findByRole("button", { name: /quick render/i });

    act(() => {
      useOpsStore
        .getState()
        .startRenderOp("job-1", { pct: 42, stage: "encoding" });
    });

    const btn = screen.getByRole("button", {
      name: /rendering/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Progress console: stage label + pct readout.
    expect(screen.getByText("Encoding video")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    // Status badge flips to "rendering".
    expect(screen.getByText("rendering")).toBeTruthy();
  });

  it("starts only one render on a double click", async () => {
    let release!: () => void;
    runQuickRenderMock.mockImplementation(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    renderPage();

    const btn = await screen.findByRole("button", { name: /quick render/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(runQuickRenderMock).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /quick render/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });
});

describe("JobPage — inline rename (#143)", () => {
  it("renames the job via the title edit affordance", async () => {
    const renamed = makeJob({ title: "Neon Nights" });
    vi.mocked(jobsDb.updateJob).mockResolvedValue(renamed);
    renderPage();
    await screen.findByText("My Song");

    fireEvent.click(screen.getByRole("button", { name: /rename job/i }));
    const input = screen.getByRole("textbox", { name: /job title/i });
    fireEvent.change(input, { target: { value: "Neon Nights" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(jobsDb.updateJob).toHaveBeenCalledWith("job-1", {
        title: "Neon Nights",
      });
    });
    expect(await screen.findByText("Neon Nights")).toBeTruthy();
  });

  it("cancels the rename on Escape without saving", async () => {
    renderPage();
    await screen.findByText("My Song");

    fireEvent.click(screen.getByRole("button", { name: /rename job/i }));
    const input = screen.getByRole("textbox", { name: /job title/i });
    fireEvent.change(input, { target: { value: "typo" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(jobsDb.updateJob).not.toHaveBeenCalled();
    expect(screen.getByText("My Song")).toBeTruthy();
  });
});

describe("JobPage — download filename (#142)", () => {
  it("does not double the extension when the title is a filename", async () => {
    getJobMock.mockResolvedValue(
      makeJob({
        title: "take-1.mp4",
        lastRender: { completedAt: Date.now(), outputBytes: 1234 },
      }),
    );
    resolveUrlMock.mockResolvedValue("blob:fake-output");

    renderPage();
    const link = await screen.findByRole("link", { name: /download mp4/i });
    expect(link.getAttribute("download")).toBe("take-1.mp4");
  });
});

describe("JobPage — inline player for the rendered video (#132)", () => {
  it("shows an inline <video> fed by the output URL next to Download", async () => {
    getJobMock.mockResolvedValue(
      makeJob({ lastRender: { completedAt: Date.now(), outputBytes: 1234 } }),
    );
    resolveUrlMock.mockResolvedValue("blob:fake-output");

    const { container } = renderPage();
    await screen.findByText(/download mp4/i);

    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video!.getAttribute("src")).toBe("blob:fake-output");
    expect(video!.hasAttribute("controls")).toBe(true);
  });

  it("shows no player when the job has no render output", async () => {
    const { container } = renderPage();
    await screen.findByRole("button", { name: /quick render/i });
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("JobPage — render op cleanup (#92)", () => {
  it("clears the finished render op after a successful quick render", async () => {
    runQuickRenderMock.mockImplementation(async (jobId: string) => {
      // Mimic runQuickRender's store lifecycle: start, then finish.
      useOpsStore.getState().startRenderOp(jobId, { pct: 5, stage: "render-prep" });
      useOpsStore.getState().finishRenderOp(jobId);
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /quick render/i }));
    await waitFor(() => {
      expect(useOpsStore.getState().ops["job-1"]?.render).toBeUndefined();
    });
  });
});

describe("JobPage — quick-render error handling (#90)", () => {
  it("keeps the full page layout when quick render fails", async () => {
    runQuickRenderMock.mockRejectedValue(new Error("Render exploded"));
    renderPage();

    const btn = await screen.findByRole("button", { name: /quick render/i });
    fireEvent.click(btn);

    // Error banner appears…
    expect(await screen.findByText("Render exploded")).toBeTruthy();
    // …but the page chrome is still there: title, quick render, delete.
    expect(screen.getByText("My Song")).toBeTruthy();
    expect(screen.getByRole("button", { name: /quick render/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("lets the user dismiss the quick-render error", async () => {
    runQuickRenderMock.mockRejectedValue(new Error("Render exploded"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /quick render/i }));
    expect(await screen.findByText("Render exploded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => {
      expect(screen.queryByText("Render exploded")).toBeNull();
    });
  });

  it("clears a previous error when quick render is retried", async () => {
    runQuickRenderMock.mockRejectedValueOnce(new Error("Render exploded"));
    runQuickRenderMock.mockResolvedValueOnce(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /quick render/i }));
    expect(await screen.findByText("Render exploded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /quick render/i }));
    await waitFor(() => {
      expect(screen.queryByText("Render exploded")).toBeNull();
    });
  });
});
