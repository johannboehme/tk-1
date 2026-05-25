import { describe, expect, test } from "vitest";
import { buildRenderInputFromJob } from "./build-render-input";
import type { LocalJob, VideoAsset } from "../../storage/jobs-db";

function directJob(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "j1",
    title: "My Clip",
    videoFilename: "v.mp4",
    audioFilename: "a.wav",
    durationS: 60,
    width: 1920,
    height: 1080,
    mode: "direct",
    editorSchema: "v2-timeline",
    videos: [
      {
        id: "cam-1",
        filename: "v.mp4",
        opfsPath: "jobs/j1/cam-1.mp4",
        color: "#ff0",
        durationS: 60,
        syncOverrideMs: 0,
        sync: { offsetMs: 250, driftRatio: 1, confidence: 0.9 },
      } satisfies VideoAsset,
    ],
    createdAt: 0,
    ...overrides,
  };
}

describe("buildRenderInputFromJob", () => {
  test("direct job: trim window becomes the single render segment", () => {
    const spec = buildRenderInputFromJob(
      directJob({ trim: { in: 5, out: 50 } }),
    );
    expect(spec.segments).toEqual([{ in: 5, out: 50 }]);
  });

  test("direct job with no trim covers the full master duration", () => {
    const spec = buildRenderInputFromJob(directJob({ trim: undefined }));
    expect(spec.segments).toEqual([{ in: 0, out: 60 }]);
  });

  test("maps editor overlays to the flat render overlay shape", () => {
    const spec = buildRenderInputFromJob(
      directJob({
        overlays: [
          {
            type: "text",
            text: "hi",
            start: 1,
            end: 3,
            preset: "boxed",
            reactive: { band: "bass", param: "scale", amount: 0.5 },
          },
        ],
      }),
    );
    expect(spec.overlays).toEqual([
      {
        text: "hi",
        start: 1,
        end: 3,
        preset: "boxed",
        x: 0.5,
        y: 0.85,
        animation: "fade",
        reactiveBand: "bass",
        reactiveParam: "scale",
        reactiveAmount: 0.5,
      },
    ]);
  });

  test("maps visualizer config to a render descriptor", () => {
    expect(
      buildRenderInputFromJob(directJob({ visualizer: { type: "showfreqs" } }))
        .visualizers,
    ).toEqual([{ type: "showfreqs" }]);
    expect(
      buildRenderInputFromJob(directJob({ visualizer: { type: "showwaves" } }))
        .visualizers,
    ).toEqual([{ type: "showwaves" }]);
    expect(buildRenderInputFromJob(directJob()).visualizers).toBeUndefined();
  });

  test("derives encoder opts from the persisted exportSpec", () => {
    const spec = buildRenderInputFromJob(
      directJob({
        exportSpec: {
          preset: "custom",
          resolution: { w: 1280, h: 720 },
          video_codec: "h264",
          audio_codec: "aac",
          video_bitrate_kbps: 3000,
          audio_bitrate_kbps: 128,
        },
      }),
    );
    expect(spec.exportOpts?.width).toBe(1280);
    expect(spec.exportOpts?.height).toBe(720);
    expect(spec.exportOpts?.videoCodec).toBe("h264");
    expect(spec.exportOpts?.audioCodec).toBe("aac");
  });

  test("uses offsetOverrideMs, falling back to cam-1 syncOverrideMs", () => {
    expect(
      buildRenderInputFromJob(directJob({ offsetOverrideMs: -40 }))
        .offsetOverrideMs,
    ).toBe(-40);
    // No explicit field → fall back to cam-1's persisted override.
    const job = directJob();
    job.videos![0] = { ...(job.videos![0] as VideoAsset), syncOverrideMs: 17 };
    expect(buildRenderInputFromJob(job).offsetOverrideMs).toBe(17);
  });

  test("passes v2 cuts through unchanged", () => {
    const spec = buildRenderInputFromJob(
      directJob({
        editorSchema: "v2-timeline",
        cuts: [{ atTimeS: 10, camId: "cam-1" }],
      }),
    );
    expect(spec.cuts).toEqual([{ atTimeS: 10, camId: "cam-1" }]);
  });

  test("projects legacy (v1-master) cuts — identity for direct mode", () => {
    const spec = buildRenderInputFromJob(
      directJob({
        editorSchema: "v1-master",
        cuts: [{ atTimeS: 12, camId: "cam-1" }],
      }),
    );
    // Direct-mode single segment [0,60] → master==timeline, so the value
    // is unchanged, but the migration path still runs without error.
    expect(spec.cuts).toEqual([{ atTimeS: 12, camId: "cam-1" }]);
  });

  test("carries per-cam overrides from the asset rows", () => {
    const job = directJob();
    job.videos![0] = {
      ...(job.videos![0] as VideoAsset),
      rotation: 90,
      flipX: true,
      startOffsetS: 0.5,
    };
    const spec = buildRenderInputFromJob(job);
    expect(spec.clipOverrides?.[0]).toMatchObject({
      id: "cam-1",
      rotation: 90,
      flipX: true,
      startOffsetS: 0.5,
    });
  });
});
