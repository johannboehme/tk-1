import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Upload from "./Upload";
import * as caps from "../local/capabilities";

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
    () => {
      vi.spyOn(caps, "getCapabilities").mockReturnValue(NO_WEBCODECS);
      renderPage();
      const input = document.getElementById("picker-videos") as HTMLInputElement;
      expect(input).not.toBeNull();
      // 3 GiB synthetic File — Blob lazy-allocates, so this is cheap.
      const big = makeSyntheticFile("huge.mp4", 3 * 1024 * 1024 * 1024, "video/mp4");
      act(() => {
        Object.defineProperty(input, "files", {
          value: makeFileList([big]),
          configurable: true,
        });
        fireEvent.change(input);
      });
      expect(
        screen.getByText(/Try Chrome \/ Edge \/ Brave/i),
      ).toBeInTheDocument();
      // The file shouldn't have been added to the list.
      expect(screen.queryByText("huge.mp4")).toBeNull();
    },
  );

  it("accepts the same oversize video on a WebCodecs-capable browser", () => {
    vi.spyOn(caps, "getCapabilities").mockReturnValue(FULL_SUPPORT);
    renderPage();
    const input = document.getElementById("picker-videos") as HTMLInputElement;
    const big = makeSyntheticFile("huge.mp4", 3 * 1024 * 1024 * 1024, "video/mp4");
    act(() => {
      Object.defineProperty(input, "files", {
        value: makeFileList([big]),
        configurable: true,
      });
      fireEvent.change(input);
    });
    // No reject message; file shows up in the list.
    expect(screen.queryByText(/Try Chrome \/ Edge \/ Brave/i)).toBeNull();
    expect(screen.getByText("huge.mp4")).toBeInTheDocument();
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

function makeFileList(files: File[]): FileList {
  // Quick FileList shim — has length, indexed access, and item().
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f;
    },
  } as unknown as FileList;
  files.forEach((f, i) => {
    (list as unknown as Record<number, File>)[i] = f;
  });
  return list;
}
