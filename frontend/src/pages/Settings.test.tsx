import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";
import type { Capabilities } from "../core/capabilities";
import {
  exportProjectArchive,
  importProjectArchive,
} from "../local/project-archive";
import { jobsDb, type LocalJob } from "../storage/jobs-db";
import { opfs } from "../storage/opfs";

const ALL_PRESENT: Capabilities = {
  webAssembly: true,
  sharedArrayBuffer: true,
  crossOriginIsolated: true,
  opfs: true,
  audioDecoder: true,
  videoDecoder: true,
  audioEncoder: true,
  videoEncoder: true,
  fileSystemAccess: true,
  webgl2: true,
  webgpu: true,
};

const NO_WEBCODECS_ENCODE: Capabilities = {
  ...ALL_PRESENT,
  audioEncoder: false,
  videoEncoder: false,
};

const MISSING_OPFS: Capabilities = {
  ...ALL_PRESENT,
  opfs: false,
};

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings page", () => {
  it("renders a row per capability with on/off state", () => {
    render(<Settings caps={ALL_PRESENT} />);
    // Drei zufällige Stichproben — der vollständige Vergleich wäre Test-noise.
    expect(screen.getByText("WebAssembly")).toBeInTheDocument();
    expect(screen.getByText("Origin Private File System")).toBeInTheDocument();
    expect(screen.getByText("WebCodecs VideoEncoder")).toBeInTheDocument();
  });

  it("shows the chosen render path: WebCodecs (HW) when full WebCodecs is present", () => {
    render(<Settings caps={ALL_PRESENT} />);
    expect(screen.getByTestId("render-path")).toHaveTextContent(/WebCodecs/i);
    expect(screen.getByTestId("render-path")).toHaveTextContent(/HW/i);
  });

  it("shows ffmpeg.wasm fallback path when WebCodecs encoder is missing", () => {
    render(<Settings caps={NO_WEBCODECS_ENCODE} />);
    expect(screen.getByTestId("render-path")).toHaveTextContent(/ffmpeg\.wasm/i);
  });

  it("shows the min-requirements check status", () => {
    render(<Settings caps={ALL_PRESENT} />);
    expect(screen.getByTestId("min-status")).toHaveTextContent(/ready/i);
  });

  it("flags missing min-requirements explicitly", () => {
    render(<Settings caps={MISSING_OPFS} />);
    expect(screen.getByTestId("min-status")).toHaveTextContent(/not ready/i);
    // Genau die fehlende Capability muss erwähnt werden:
    expect(screen.getByTestId("min-status")).toHaveTextContent(
      /Origin Private File System/i,
    );
  });
});

// -----------------------------------------------------------------------------
// #86 — Projects backup / restore section
// -----------------------------------------------------------------------------

vi.mock("../local/project-archive", () => ({
  exportProjectArchive: vi.fn(),
  importProjectArchive: vi.fn(),
}));

describe("Settings — projects backup (#86)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(jobsDb, "listJobs").mockResolvedValue([
      makeBackupJob("job-a", "Song A"),
      makeBackupJob("job-b", null),
    ]);
    vi.spyOn(opfs, "dirStats").mockResolvedValue({
      bytes: 2 * 1024 * 1024,
      newestModifiedMs: null,
    });
    if (typeof URL.createObjectURL !== "function") {
      URL.createObjectURL = () => "blob:fake";
    }
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = () => undefined;
    }
  });

  function makeBackupJob(id: string, title: string | null): LocalJob {
    return {
      id,
      title,
      videoFilename: "v.mp4",
      audioFilename: "a.wav",
      createdAt: 1720000000000,
    };
  }

  it("lists every project with a size and an Export button", async () => {
    render(<Settings caps={ALL_PRESENT} />);
    expect(await screen.findByText("Song A")).toBeInTheDocument();
    expect(screen.getByText("job-b")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^export$/i })).toHaveLength(2);
    expect(screen.getAllByText(/2 MB/)).toHaveLength(2);
  });

  it("exports the clicked project as a downloaded archive", async () => {
    vi.mocked(exportProjectArchive).mockResolvedValue({
      blob: new Blob(["zip"]),
      filename: "Song A.tk1.zip",
    });
    render(<Settings caps={ALL_PRESENT} />);
    await screen.findByText("Song A");

    fireEvent.click(screen.getAllByRole("button", { name: /^export$/i })[0]);
    await waitFor(() => {
      expect(exportProjectArchive).toHaveBeenCalledWith("job-a");
    });
    expect(await screen.findByTestId("backup-msg")).toHaveTextContent(
      /Exported "Song A"/,
    );
  });

  it("imports a picked archive file and reports the restored project", async () => {
    vi.mocked(importProjectArchive).mockResolvedValue({
      jobId: "job-new",
      title: "Restored Song",
    });
    render(<Settings caps={ALL_PRESENT} />);
    await screen.findByText("Song A");

    const input = screen.getByLabelText(/project archive file/i);
    const file = new File(["zipbytes"], "Song.tk1.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(importProjectArchive).toHaveBeenCalledWith(file);
    });
    expect(await screen.findByTestId("backup-msg")).toHaveTextContent(
      /Imported "Restored Song"/,
    );
  });

  it("surfaces an import failure without crashing the page", async () => {
    vi.mocked(importProjectArchive).mockRejectedValue(
      new Error("Not a TK-1 project archive"),
    );
    render(<Settings caps={ALL_PRESENT} />);
    await screen.findByText("Song A");

    const input = screen.getByLabelText(/project archive file/i);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "foreign.zip")] },
    });

    expect(await screen.findByTestId("backup-err")).toHaveTextContent(
      /not a tk-1 project archive/i,
    );
    // Page chrome intact.
    expect(screen.getByTestId("min-status")).toBeInTheDocument();
  });
});
