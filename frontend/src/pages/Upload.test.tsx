import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Upload from "./Upload";
import * as caps from "../local/capabilities";
import * as picker from "../local/file-picker";

vi.mock("../local/jobs", () => ({
  createJob: vi.fn(),
}));

const FULL_SUPPORT: caps.Capabilities = {
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

const NO_WEBCODECS: caps.Capabilities = {
  ...FULL_SUPPORT,
  audioDecoder: false,
  videoDecoder: false,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <Upload />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Upload page — large-file capability handling", () => {
  it("does not show the legacy-browser banner when WebCodecs is available", () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    expect(
      screen.queryByText(/WebCodecs AudioDecoder\/VideoDecoder yet/i),
    ).toBeNull();
  });

  it("shows a legacy-browser banner when WebCodecs decoders are missing", () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(NO_WEBCODECS);
    renderPage();
    expect(
      screen.getByText(/WebCodecs AudioDecoder\/VideoDecoder yet/i),
    ).toBeInTheDocument();
  });

  it(
    "rejects an oversize video on legacy browsers with a clear message and " +
      "leaves the file list untouched",
    async () => {
      vi.spyOn(caps, "getCapabilities").mockReturnValue(NO_WEBCODECS);
      // Mock the picker so a click on the picker-videos button returns a
      // synthetic 3 GiB pick (no real file IO).
      const big = makeSyntheticFile("huge.mp4", 3 * 1024 * 1024 * 1024, "video/mp4");
      vi.spyOn(picker, "pickVideoFiles").mockResolvedValue([
        { file: big, handle: null },
      ]);
      renderPage();
      const button = document.getElementById("picker-videos") as HTMLButtonElement;
      expect(button).not.toBeNull();
      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByText(/Try Chrome \/ Edge \/ Brave/i)).toBeInTheDocument();
      });
      // The file shouldn't have been added to the list.
      expect(screen.queryByText("huge.mp4")).toBeNull();
    },
  );

  it("accepts the same oversize video on a WebCodecs-capable browser", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    const big = makeSyntheticFile("huge.mp4", 3 * 1024 * 1024 * 1024, "video/mp4");
    vi.spyOn(picker, "pickVideoFiles").mockResolvedValue([
      { file: big, handle: null },
    ]);
    renderPage();
    const button = document.getElementById("picker-videos") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText("huge.mp4")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Try Chrome \/ Edge \/ Brave/i)).toBeNull();
  });
});

describe("Upload page — drag & drop", () => {
  function dt(files: File[]): { files: File[]; types: string[] } {
    return { files, types: ["Files"] };
  }

  it("prevents the browser default on dragover of a drop zone", () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const zone = document.getElementById("picker-audio") as HTMLButtonElement;
    const notCancelled = fireEvent.dragOver(zone, { dataTransfer: dt([]) });
    // fireEvent returns false when preventDefault() was called.
    expect(notCancelled).toBe(false);
  });

  it("adds a dropped video file to the video list without navigating", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const main = screen.getByRole("main");
    const file = makeSyntheticFile("clip.mp4", 1000, "video/mp4");
    const notCancelled = fireEvent.drop(main, { dataTransfer: dt([file]) });
    expect(notCancelled).toBe(false); // default (navigate-to-file) prevented
    await waitFor(() => {
      expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    });
  });

  it("routes a mixed drop by type: audio → song slot, videos → list", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const main = screen.getByRole("main");
    const song = makeSyntheticFile("song.wav", 1000, "audio/wav");
    const v1 = makeSyntheticFile("cam1.mp4", 1000, "video/mp4");
    const v2 = makeSyntheticFile("cam2.mov", 1000, "video/quicktime");
    fireEvent.drop(main, { dataTransfer: dt([v1, song, v2]) });
    await waitFor(() => {
      expect(screen.getByText("song.wav")).toBeInTheDocument();
      expect(screen.getByText("cam1.mp4")).toBeInTheDocument();
      expect(screen.getByText("cam2.mov")).toBeInTheDocument();
    });
  });

  it("replaces the song when a new audio file is dropped", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const main = screen.getByRole("main");
    fireEvent.drop(main, {
      dataTransfer: dt([makeSyntheticFile("first.wav", 1000, "audio/wav")]),
    });
    await waitFor(() => {
      expect(screen.getByText("first.wav")).toBeInTheDocument();
    });
    fireEvent.drop(main, {
      dataTransfer: dt([makeSyntheticFile("second.wav", 1000, "audio/wav")]),
    });
    await waitFor(() => {
      expect(screen.getByText("second.wav")).toBeInTheDocument();
    });
    expect(screen.queryByText("first.wav")).toBeNull();
  });

  it("shows an error when the drop contains nothing usable", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const main = screen.getByRole("main");
    fireEvent.drop(main, {
      dataTransfer: dt([makeSyntheticFile("notes.txt", 10, "text/plain")]),
    });
    await waitFor(() => {
      expect(screen.getByText(/audio or video/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("rejects an oversize dropped video on legacy browsers", async () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(NO_WEBCODECS);
    renderPage();
    const main = screen.getByRole("main");
    const big = makeSyntheticFile("huge.mp4", 3 * 1024 * 1024 * 1024, "video/mp4");
    fireEvent.drop(main, { dataTransfer: dt([big]) });
    await waitFor(() => {
      expect(screen.getByText(/Try Chrome \/ Edge \/ Brave/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("huge.mp4")).toBeNull();
  });

  it("prevents navigation for a stray drop outside the drop zones", () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    // Window-level safety net: a drop anywhere must never replace the SPA.
    const notCancelledOver = fireEvent.dragOver(document.body, {
      dataTransfer: dt([makeSyntheticFile("a.mp4", 10, "video/mp4")]),
    });
    expect(notCancelledOver).toBe(false);
    const notCancelledDrop = fireEvent.drop(document.body, {
      dataTransfer: dt([makeSyntheticFile("a.mp4", 10, "video/mp4")]),
    });
    expect(notCancelledDrop).toBe(false);
  });
});

/** Build a File whose `.size` reports an arbitrary value without
 *  allocating that many bytes. We never read the bytes in this test —
 *  Upload only inspects `.size` and `.name`. */
function makeSyntheticFile(name: string, size: number, type: string): File {
  // A 1-byte File whose size we override via Object.defineProperty.
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, "size", { value: size, configurable: true });
  return f;
}
