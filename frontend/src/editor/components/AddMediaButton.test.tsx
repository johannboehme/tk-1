import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddMediaButton } from "./AddMediaButton";
import { useEditorStore } from "../store";

vi.mock("../../local/jobs", () => ({
  addVideoToJob: vi.fn(async () => "cam-2"),
  addImageToJob: vi.fn(async () => "cam-3"),
}));

vi.mock("../../local/file-picker", () => ({
  pickVideoOrImageFiles: vi.fn(async () => []),
}));

import { addImageToJob, addVideoToJob } from "../../local/jobs";
import { pickVideoOrImageFiles } from "../../local/file-picker";

const mockedPick = vi.mocked(pickVideoOrImageFiles);

function file(name: string, type: string): File {
  return new File(["dummy"], name, { type });
}

function pick(f: File) {
  return { file: f, handle: null as null };
}

describe("AddMediaButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.getState().reset();
  });

  it("renders one add button + a match-audio toggle", () => {
    render(<AddMediaButton jobId="job-x" />);
    expect(screen.getByTestId("add-media-button")).toBeInTheDocument();
    expect(screen.getByTestId("add-media-match-toggle")).toBeInTheDocument();
  });

  it("routes a video pick through addVideoToJob with the toggle's setting (default ON)", async () => {
    const f = file("shot.mp4", "video/mp4");
    mockedPick.mockResolvedValueOnce([pick(f)]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-button"));

    await new Promise((r) => setTimeout(r, 0));
    expect(addVideoToJob).toHaveBeenCalledWith("job-x", pick(f), {
      skipSync: false,
    });
  });

  it("toggling MATCH off causes videos to skip sync", async () => {
    const f = file("broll.mp4", "video/mp4");
    mockedPick.mockResolvedValueOnce([pick(f)]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-match-toggle"));
    expect(
      screen.getByTestId("add-media-match-toggle").getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByTestId("add-media-button"));

    await new Promise((r) => setTimeout(r, 0));
    expect(addVideoToJob).toHaveBeenCalledWith("job-x", pick(f), {
      skipSync: true,
    });
  });

  it("routes an image pick through addImageToJob (toggle is irrelevant)", async () => {
    const f = file("still.png", "image/png");
    mockedPick.mockResolvedValueOnce([pick(f)]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-button"));

    await new Promise((r) => setTimeout(r, 0));
    expect(addImageToJob).toHaveBeenCalledWith("job-x", pick(f));
    expect(addVideoToJob).not.toHaveBeenCalled();
  });

  it("a mixed selection dispatches to the correct entry per file", async () => {
    const v = file("a.mp4", "video/mp4");
    const i = file("b.png", "image/png");
    mockedPick.mockResolvedValueOnce([pick(v), pick(i)]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-button"));

    await new Promise((r) => setTimeout(r, 5));
    expect(addVideoToJob).toHaveBeenCalledTimes(1);
    expect(addImageToJob).toHaveBeenCalledTimes(1);
  });

  it("posts a notice on success summarising what was added", async () => {
    const f = file("shot.mp4", "video/mp4");
    mockedPick.mockResolvedValueOnce([pick(f)]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-button"));

    await new Promise((r) => setTimeout(r, 0));
    expect(useEditorStore.getState().notice?.message).toMatch(/added/i);
  });

  it("user-cancelled pick (empty array) is a silent no-op", async () => {
    mockedPick.mockResolvedValueOnce([]);
    render(<AddMediaButton jobId="job-x" />);
    fireEvent.click(screen.getByTestId("add-media-button"));
    await new Promise((r) => setTimeout(r, 0));
    expect(addVideoToJob).not.toHaveBeenCalled();
    expect(addImageToJob).not.toHaveBeenCalled();
    expect(useEditorStore.getState().notice).toBeFalsy();
  });
});
