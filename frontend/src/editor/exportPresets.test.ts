import { describe, expect, it } from "vitest";
import {
  applyPreset,
  classifyAspectRatio,
  deriveResolution,
  estimateFileSizeBytes,
  qualityToBitrates,
  resolveResolution,
  type SourceProbe,
} from "./exportPresets";

const SOURCE_LANDSCAPE_1080: SourceProbe = { w: 1920, h: 1080, durationS: 60 };
const SOURCE_PORTRAIT_1080: SourceProbe = { w: 1080, h: 1920, durationS: 60 };

describe("qualityToBitrates", () => {
  it("returns increasing video and audio bitrates for each step", () => {
    const tiny = qualityToBitrates("tiny", { w: 1920, h: 1080 });
    const low = qualityToBitrates("low", { w: 1920, h: 1080 });
    const good = qualityToBitrates("good", { w: 1920, h: 1080 });
    const high = qualityToBitrates("high", { w: 1920, h: 1080 });
    const pristine = qualityToBitrates("pristine", { w: 1920, h: 1080 });

    expect(tiny.videoKbps).toBeLessThan(low.videoKbps);
    expect(low.videoKbps).toBeLessThan(good.videoKbps);
    expect(good.videoKbps).toBeLessThan(high.videoKbps);
    expect(high.videoKbps).toBeLessThan(pristine.videoKbps);

    expect(tiny.audioKbps).toBeLessThan(pristine.audioKbps);
  });

  it("scales video bitrate with pixel area", () => {
    const at720p = qualityToBitrates("good", { w: 1280, h: 720 });
    const at1080p = qualityToBitrates("good", { w: 1920, h: 1080 });
    const at4k = qualityToBitrates("good", { w: 3840, h: 2160 });

    expect(at720p.videoKbps).toBeLessThan(at1080p.videoKbps);
    expect(at1080p.videoKbps).toBeLessThan(at4k.videoKbps);
    // 4K has 4× the pixels of 1080p → bitrate around 4× higher.
    expect(at4k.videoKbps / at1080p.videoKbps).toBeCloseTo(4, 0);
  });

  it("does not scale audio bitrate with resolution", () => {
    const at720p = qualityToBitrates("good", { w: 1280, h: 720 });
    const at4k = qualityToBitrates("good", { w: 3840, h: 2160 });
    expect(at720p.audioKbps).toBe(at4k.audioKbps);
  });
});

describe("resolveResolution", () => {
  it("source-pass-through returns source dimensions", () => {
    expect(resolveResolution("source", SOURCE_LANDSCAPE_1080)).toEqual({
      w: 1920,
      h: 1080,
    });
    expect(resolveResolution("source", SOURCE_PORTRAIT_1080)).toEqual({
      w: 1080,
      h: 1920,
    });
  });

  it("explicit dimensions are returned as-is", () => {
    expect(resolveResolution({ w: 640, h: 480 }, SOURCE_LANDSCAPE_1080)).toEqual({
      w: 640,
      h: 480,
    });
  });
});

describe("applyPreset — opinionated recipes", () => {
  function spec(over: Partial<Parameters<typeof applyPreset>[1]> = {}): Parameters<typeof applyPreset>[1] {
    return { preset: "custom", ...over };
  }

  it("WEB always sets 16:9 1920×1080 + H.264 + Good", () => {
    const out = applyPreset(
      "web",
      spec({ aspectRatio: "9:16", resolutionLongSide: 720, resolution: { w: 405, h: 720 } }),
    );
    expect(out.preset).toBe("web");
    expect(out.aspectRatio).toBe("16:9");
    expect(out.resolutionLongSide).toBe(1920);
    expect(out.resolution).toEqual({ w: 1920, h: 1080 });
    expect(out.video_codec).toBe("h264");
    expect(out.quality).toBe("good");
  });

  it("MOBILE always sets 9:16 1080×1920 + H.264 + Low", () => {
    const out = applyPreset(
      "mobile",
      spec({ aspectRatio: "16:9", resolutionLongSide: 3840, resolution: { w: 3840, h: 2160 } }),
    );
    expect(out.preset).toBe("mobile");
    expect(out.aspectRatio).toBe("9:16");
    expect(out.resolutionLongSide).toBe(1920);
    expect(out.resolution).toEqual({ w: 1080, h: 1920 });
    expect(out.video_codec).toBe("h264");
    expect(out.quality).toBe("low");
  });

  it("ARCHIVE keeps the user's aspect + dims, flips to H.265 + Pristine", () => {
    const out = applyPreset(
      "archive",
      spec({
        aspectRatio: "9:16",
        resolutionLongSide: 1920,
        resolution: { w: 1080, h: 1920 },
      }),
    );
    expect(out.preset).toBe("archive");
    expect(out.aspectRatio).toBe("9:16");
    expect(out.resolution).toEqual({ w: 1080, h: 1920 });
    expect(out.video_codec).toBe("h265");
    expect(out.quality).toBe("pristine");
  });

  it("ARCHIVE on a fresh spec falls back to 16:9 4K", () => {
    const out = applyPreset("archive", spec({}));
    expect(out.aspectRatio).toBe("16:9");
    expect(out.resolutionLongSide).toBe(3840);
    expect(out.resolution).toEqual({ w: 3840, h: 2160 });
  });

  it("CUSTOM only flips the discriminator — keeps user-set aspect / dims / codec", () => {
    const out = applyPreset("custom", spec({}));
    expect(out.preset).toBe("custom");
    expect(out.resolution).toBeUndefined();
    expect(out.video_codec).toBeUndefined();
  });
});

describe("estimateFileSizeBytes", () => {
  it("computes bytes ≈ (videoKbps + audioKbps) × duration / 8", () => {
    const bytes = estimateFileSizeBytes({
      videoKbps: 3500,
      audioKbps: 128,
      durationS: 60,
    });
    // (3500 + 128) kbps × 60 s / 8 ≈ 27_210 KB ≈ 27.2 MB
    expect(bytes).toBeGreaterThan(26_000_000);
    expect(bytes).toBeLessThan(28_500_000);
  });

  it("scales linearly with duration", () => {
    const a = estimateFileSizeBytes({ videoKbps: 3000, audioKbps: 128, durationS: 30 });
    const b = estimateFileSizeBytes({ videoKbps: 3000, audioKbps: 128, durationS: 60 });
    expect(b / a).toBeCloseTo(2, 1);
  });

  it("returns 0 for zero duration or non-positive bitrate", () => {
    expect(estimateFileSizeBytes({ videoKbps: 3000, audioKbps: 128, durationS: 0 })).toBe(0);
    expect(estimateFileSizeBytes({ videoKbps: 0, audioKbps: 0, durationS: 60 })).toBe(0);
  });
});

describe("deriveResolution", () => {
  it("16:9 with long-side 1920 → 1920×1080", () => {
    expect(deriveResolution("16:9", 1920)).toEqual({ w: 1920, h: 1080 });
  });

  it("9:16 with long-side 1920 → 1080×1920", () => {
    expect(deriveResolution("9:16", 1920)).toEqual({ w: 1080, h: 1920 });
  });

  it("1:1 with long-side 1920 → 1920×1920", () => {
    expect(deriveResolution("1:1", 1920)).toEqual({ w: 1920, h: 1920 });
  });

  it("4:3 with long-side 1920 → 1920×1440", () => {
    expect(deriveResolution("4:3", 1920)).toEqual({ w: 1920, h: 1440 });
  });

  it("21:9 with long-side 1920 → 1920×~822 (even)", () => {
    const r = deriveResolution("21:9", 1920);
    expect(r.w).toBe(1920);
    expect(r.h % 2).toBe(0);
    expect(r.h).toBe(822);
  });

  it("rounds odd intermediates down to even pixels", () => {
    // 16:9 with long-side 1281 → 1280×720 (1281 rounds down to 1280).
    expect(deriveResolution("16:9", 1281)).toEqual({ w: 1280, h: 720 });
  });

  it("4K presets work for all aspects", () => {
    expect(deriveResolution("16:9", 3840)).toEqual({ w: 3840, h: 2160 });
    expect(deriveResolution("9:16", 3840)).toEqual({ w: 2160, h: 3840 });
    expect(deriveResolution("1:1", 3840)).toEqual({ w: 3840, h: 3840 });
  });
});

describe("classifyAspectRatio", () => {
  it("matches 16:9 from 1920×1080", () => {
    expect(classifyAspectRatio({ w: 1920, h: 1080 })).toBe("16:9");
  });

  it("matches 9:16 from 1080×1920", () => {
    expect(classifyAspectRatio({ w: 1080, h: 1920 })).toBe("9:16");
  });

  it("matches 1:1 from 1080×1080", () => {
    expect(classifyAspectRatio({ w: 1080, h: 1080 })).toBe("1:1");
  });

  it("returns custom for non-preset ratios", () => {
    expect(classifyAspectRatio({ w: 1234, h: 567 })).toBe("custom");
  });

  it("returns custom for invalid dims", () => {
    expect(classifyAspectRatio({ w: 0, h: 100 })).toBe("custom");
    expect(classifyAspectRatio({ w: 100, h: 0 })).toBe("custom");
  });
});
