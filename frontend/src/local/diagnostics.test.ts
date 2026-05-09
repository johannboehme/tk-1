import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSyncFailureReport, formatReport } from "./diagnostics";
import { useOpsStore } from "./ops-store";

beforeEach(() => {
  useOpsStore.setState({ ops: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useOpsStore.setState({ ops: {} });
});

describe("collectSyncFailureReport", () => {
  it("captures stage, file-in-flight, and Error.name + message", async () => {
    useOpsStore.getState().startSyncOp("job-1", { stage: "decoding-studio-audio" });
    useOpsStore.getState().updateSyncOp("job-1", {
      currentFile: {
        name: "studio.wav",
        size: 1024 * 1024,
        type: "audio/wav",
        sourceKind: "opfs",
      },
    });

    const err = new TypeError("boom");
    const { summary, report, data } = await collectSyncFailureReport("job-1", err);

    expect(summary).toContain("[decoding-studio-audio]");
    expect(summary).toContain("TypeError");
    expect(summary).toContain("boom");

    expect(data.error.name).toBe("TypeError");
    expect(data.error.message).toBe("boom");
    expect(data.file?.name).toBe("studio.wav");
    expect(data.file?.sourceKind).toBe("opfs");
    expect(data.stage).toBe("decoding-studio-audio");

    expect(report).toContain("Job:    job-1");
    expect(report).toContain("Stage:  decoding-studio-audio");
    expect(report).toContain("Name:    TypeError");
    expect(report).toContain("Message: boom");
    expect(report).toContain("Name:   studio.wav");
    expect(report).toContain("Source: opfs");
  });

  it("survives a non-Error throw and stack-less errors", async () => {
    const err = new Error("oops");
    err.stack = undefined as unknown as string; // simulate stripped stack
    const { data } = await collectSyncFailureReport("job-x", err);
    expect(data.error.message).toBe("oops");
    expect(data.error.stack).toEqual([]);

    const string = await collectSyncFailureReport("job-y", "raw string fail");
    expect(string.data.error.name).toBe("string");
    expect(string.data.error.message).toBe("raw string fail");
    expect(string.summary).toContain("raw string fail");
  });

  it("falls back to 'unknown' stage when the op is absent", async () => {
    const { data, summary } = await collectSyncFailureReport(
      "missing",
      new Error("no op for this jobId"),
    );
    expect(data.stage).toBe("unknown");
    expect(summary).not.toContain("[unknown]"); // no stage prefix when unknown
    expect(summary).toContain("no op for this jobId");
  });

  it("renders capability rows in the report (live snapshot)", async () => {
    const { report } = await collectSyncFailureReport("job-c", new Error("x"));
    expect(report).toContain("WebCodecs (audio):");
    expect(report).toContain("OPFS:");
    expect(report).toContain("WebGPU:");
  });
});

describe("formatReport", () => {
  it("omits the 'File in flight' section when no file is set", () => {
    const out = formatReport({
      jobId: "j",
      stage: "loading",
      whenIso: "2026-05-09T00:00:00.000Z",
      error: { name: "Error", message: "x", stack: [] },
      browser: { userAgent: "ua", platform: "p", language: "l" },
      capabilities: {
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
        webgpu: false,
      },
    });
    expect(out).not.toContain("File in flight");
    expect(out).toContain("WebGPU:             no");
  });
});
