import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEMO_CAM_SPECS,
  canSynthesizeDemo,
  createDemoJob,
  type DemoProgress,
} from "./demo-project";
import { DEMO_SONG, songDurationS } from "./demo-song";
import type { Capabilities } from "../../core/capabilities";
import { createJob } from "../jobs";
import { synthesizeDemoVideo } from "./demo-video";

vi.mock("../jobs", () => ({
  createJob: vi.fn(),
}));

vi.mock("./demo-video", async (importOriginal) => {
  const original = await importOriginal<typeof import("./demo-video")>();
  return {
    ...original,
    synthesizeDemoVideo: vi.fn(),
  };
});

const FULL: Capabilities = {
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

describe("canSynthesizeDemo", () => {
  beforeEach(() => {
    // jsdom has no OffscreenCanvas; the happy path stubs one in.
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {};
    return () => {
      delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    };
  });

  it("requires WebCodecs encoders", () => {
    expect(canSynthesizeDemo(FULL)).toBe(true);
    expect(canSynthesizeDemo({ ...FULL, videoEncoder: false })).toBe(false);
    expect(canSynthesizeDemo({ ...FULL, audioEncoder: false })).toBe(false);
  });

  it("requires OffscreenCanvas", () => {
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    expect(canSynthesizeDemo(FULL)).toBe(false);
  });
});

describe("createDemoJob", () => {
  beforeEach(() => {
    vi.mocked(createJob).mockReset();
    vi.mocked(synthesizeDemoVideo).mockReset();
    vi.mocked(createJob).mockResolvedValue("demo-job-1");
    vi.mocked(synthesizeDemoVideo).mockImplementation(async (opts) => {
      return new File([new Uint8Array(4)], opts.spec.filename, {
        type: "video/mp4",
      });
    });
  });

  it("synthesizes one video per cam spec and feeds the normal createJob path", async () => {
    const jobId = await createDemoJob();
    expect(jobId).toBe("demo-job-1");

    expect(synthesizeDemoVideo).toHaveBeenCalledTimes(DEMO_CAM_SPECS.length);
    const dur = songDurationS(DEMO_SONG);
    for (const [i, spec] of DEMO_CAM_SPECS.entries()) {
      const call = vi.mocked(synthesizeDemoVideo).mock.calls[i][0];
      expect(call.spec).toBe(spec);
      expect(call.sampleRate).toBe(DEMO_SONG.sampleRate);
      expect(call.bpm).toBe(DEMO_SONG.bpm);
      // Each cam covers its start → end of song, all inside the song.
      expect(call.durationS).toBeCloseTo(dur - spec.songStartS, 6);
      expect(call.songPcm.length).toBe(Math.round(dur * DEMO_SONG.sampleRate));
    }

    expect(createJob).toHaveBeenCalledTimes(1);
    const [videoPicks, audioPick, options] = vi.mocked(createJob).mock.calls[0];
    expect(videoPicks).toHaveLength(DEMO_CAM_SPECS.length);
    expect(videoPicks.map((p) => p.file.name)).toEqual(
      DEMO_CAM_SPECS.map((s) => s.filename),
    );
    expect(videoPicks.every((p) => p.handle === null)).toBe(true);
    expect(audioPick.file.name).toBe("demo-song.wav");
    expect(audioPick.file.type).toBe("audio/wav");
    expect(audioPick.handle).toBeNull();
    expect(options).toMatchObject({ title: "Demo session", mode: "direct" });
  });

  it("staggers the cams so sync has real offsets to find", () => {
    expect(DEMO_CAM_SPECS.length).toBeGreaterThanOrEqual(2);
    const starts = DEMO_CAM_SPECS.map((s) => s.songStartS);
    expect(starts[0]).toBe(0);
    expect(Math.max(...starts)).toBeGreaterThan(0.5);
    const dur = songDurationS(DEMO_SONG);
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(dur - 1);
    }
  });

  it("reports progress stages in order: song → cams → job", async () => {
    const stages: DemoProgress[] = [];
    await createDemoJob({ onProgress: (p) => stages.push(p) });
    const kinds = stages.map((s) => s.stage);
    expect(kinds[0]).toBe("song");
    expect(kinds[kinds.length - 1]).toBe("job");
    expect(kinds.filter((k) => k === "cam")).toHaveLength(DEMO_CAM_SPECS.length);
    // cams identified for the button label
    const camDetails = stages.filter((s) => s.stage === "cam").map((s) => s.detail);
    expect(camDetails).toEqual(DEMO_CAM_SPECS.map((s) => s.label));
  });
});
