/**
 * Export-preset / quality helpers.
 *
 * The Studio-Console export panel composes three orthogonal choices —
 * destination preset, output resolution, and quality step — into a single
 * `ExportSpec`. These helpers define the contracts for each axis so the UI
 * and the render pipeline stay in sync.
 *
 * Aspect-aware presets fix the long-standing Mobile bug: the old preset
 * hardcoded 1280×720, which made portrait phone footage look wrong.
 */

import type {
  AspectRatio,
  ExportPreset,
  ExportSpec,
  QualityStep,
} from "./types";

export interface SourceProbe {
  w: number;
  h: number;
  durationS: number;
}

export interface BitratePair {
  videoKbps: number;
  audioKbps: number;
}

/**
 * Base bitrate ladder, expressed at 1080p. Real bitrates scale with pixel
 * area so that a 4K render gets ~4× this and a 720p render ~0.45×.
 */
const QUALITY_LADDER: Record<Exclude<QualityStep, "custom">, BitratePair> = {
  tiny: { videoKbps: 800, audioKbps: 64 },
  low: { videoKbps: 2000, audioKbps: 96 },
  good: { videoKbps: 3500, audioKbps: 128 },
  high: { videoKbps: 6000, audioKbps: 192 },
  pristine: { videoKbps: 12000, audioKbps: 256 },
};

const REFERENCE_PIXELS = 1920 * 1080;

/**
 * Returns the bitrate pair for a quality step at a given output resolution.
 * Audio bitrate is independent of resolution; video scales with pixel area.
 *
 * Falls back to "good" semantics for the "custom" step — the panel uses a
 * different code path when the user has set bitrates explicitly, so this
 * is a safe default for any caller that asks naively.
 */
export function qualityToBitrates(
  step: QualityStep,
  resolution: { w: number; h: number },
): BitratePair {
  const key = step === "custom" ? "good" : step;
  const base = QUALITY_LADDER[key];
  const pixelScale = (resolution.w * resolution.h) / REFERENCE_PIXELS;
  return {
    videoKbps: Math.round(base.videoKbps * pixelScale),
    audioKbps: base.audioKbps,
  };
}

/**
 * Translate the `resolution` field of an ExportSpec into concrete pixels.
 */
export function resolveResolution(
  resolution: ExportSpec["resolution"],
  source: { w: number; h: number },
): { w: number; h: number } {
  if (resolution === undefined || resolution === "source") {
    return { w: source.w, h: source.h };
  }
  return resolution;
}

function roundEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

/**
 * Aspect-ratio presets shown in the Export panel's AspectPicker.
 * Order = display order in the picker. "custom" requires the caller to
 * supply explicit w/h instead of going through `deriveResolution`.
 */
export const ASPECT_RATIO_PRESETS: Exclude<AspectRatio, "custom">[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "21:9",
];

/**
 * Long-side resolution presets (in pixels). Combined with an
 * `AspectRatio` they produce the concrete output dimensions via
 * {@link deriveResolution}.
 */
export const RESOLUTION_LONG_SIDE_PRESETS = [3840, 2560, 1920, 1280, 854] as const;

/** Parse `"16:9"` → `[16, 9]`. */
function parseAspect(a: Exclude<AspectRatio, "custom">): [number, number] {
  const [w, h] = a.split(":").map(Number);
  return [w, h];
}

/**
 * Compute concrete pixel dims from an aspect-ratio preset + the long
 * side in pixels. Always rounds to even pixels (encoder requirement).
 */
export function deriveResolution(
  aspect: Exclude<AspectRatio, "custom">,
  longSide: number,
): { w: number; h: number } {
  const [wRatio, hRatio] = parseAspect(aspect);
  if (wRatio >= hRatio) {
    return {
      w: roundEven(longSide),
      h: roundEven((longSide * hRatio) / wRatio),
    };
  }
  return {
    w: roundEven((longSide * wRatio) / hRatio),
    h: roundEven(longSide),
  };
}

/**
 * Best-fit AspectRatio preset for given dims. Used to seed the picker
 * when the user (or an auto-default) sets a `resolution` directly.
 * Returns `"custom"` if no preset matches within a small tolerance.
 */
export function classifyAspectRatio(dims: {
  w: number;
  h: number;
}): AspectRatio {
  if (dims.w <= 0 || dims.h <= 0) return "custom";
  const ar = dims.w / dims.h;
  for (const preset of ASPECT_RATIO_PRESETS) {
    const [wRatio, hRatio] = parseAspect(preset);
    const presetAr = wRatio / hRatio;
    if (Math.abs(ar - presetAr) < 0.01) return preset;
  }
  return "custom";
}

/**
 * Build an ExportSpec for a preset. Presets are OPINIONATED — they set
 * aspect, resolution, codec, AND bitrate so the user gets one consistent
 * recipe with one click.
 *
 * - WEB: 16:9 · 1920×1080 · H.264 · Good
 * - ARCHIVE: keep current aspect + dims, switch codec to H.265 · Pristine
 * - MOBILE: 9:16 · 1080×1920 · H.264 · Low
 * - CUSTOM: discriminator only — what the user lands on after manual edits.
 */
export function applyPreset(
  preset: ExportPreset,
  current: ExportSpec,
): Partial<ExportSpec> & { preset: ExportPreset } {
  if (preset === "custom") {
    return { preset: "custom" };
  }
  switch (preset) {
    case "web": {
      const dims = deriveResolution("16:9", 1920);
      const { videoKbps, audioKbps } = qualityToBitrates("good", dims);
      return {
        preset: "web",
        format: "mp4",
        aspectRatio: "16:9",
        resolutionLongSide: 1920,
        resolution: dims,
        video_codec: "h264",
        audio_codec: "aac",
        video_bitrate_kbps: videoKbps,
        audio_bitrate_kbps: audioKbps,
        quality: "good",
      };
    }
    case "archive": {
      // Keep the user's aspect + dims (their high-quality master). Only
      // flip codec/quality. Fallback for first-touch: 16:9 4K.
      const aspect: AspectRatio =
        current.aspectRatio && current.aspectRatio !== "custom"
          ? current.aspectRatio
          : "16:9";
      const longSide = current.resolutionLongSide ?? 3840;
      const dims =
        current.resolution && current.resolution !== "source"
          ? current.resolution
          : deriveResolution(aspect, longSide);
      const { videoKbps, audioKbps } = qualityToBitrates("pristine", dims);
      return {
        preset: "archive",
        format: "mp4",
        aspectRatio: aspect,
        resolutionLongSide: longSide,
        resolution: dims,
        video_codec: "h265",
        audio_codec: "aac",
        video_bitrate_kbps: videoKbps,
        audio_bitrate_kbps: audioKbps,
        quality: "pristine",
      };
    }
    case "mobile": {
      const dims = deriveResolution("9:16", 1920);
      const { videoKbps, audioKbps } = qualityToBitrates("low", dims);
      return {
        preset: "mobile",
        format: "mp4",
        aspectRatio: "9:16",
        resolutionLongSide: 1920,
        resolution: dims,
        video_codec: "h264",
        audio_codec: "aac",
        video_bitrate_kbps: videoKbps,
        audio_bitrate_kbps: audioKbps,
        quality: "low",
      };
    }
  }
}

/**
 * Estimate output file size from the bitrate × duration formula. Returns
 * bytes; the UI formats them into KB/MB/GB. Rounds to bytes (no fractional).
 */
export function estimateFileSizeBytes(input: {
  videoKbps: number;
  audioKbps: number;
  durationS: number;
}): number {
  if (input.durationS <= 0) return 0;
  const totalKbps = input.videoKbps + input.audioKbps;
  if (totalKbps <= 0) return 0;
  return Math.round((totalKbps * 1000 * input.durationS) / 8);
}

/**
 * Format `bytes` as a human-readable string. Mirrors the convention the
 * rest of the app uses (decimal SI prefixes — what file managers show).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export interface RenderOutputOpts {
  width?: number;
  height?: number;
  videoCodec: "h264" | "h265";
  audioCodec: "aac" | "opus";
  videoBitrateBps: number;
  audioBitrateBps: number;
}

/**
 * Translate a UI-layer `ExportSpec` into the raw render-pipeline options.
 * Source dimensions are required because "source" resolution in the spec
 * is shorthand that the renderer can't follow on its own.
 */
export function exportSpecToRenderOpts(
  spec: ExportSpec,
  source: { w: number; h: number },
): RenderOutputOpts {
  const res = resolveResolution(spec.resolution, source);
  return {
    width: res.w,
    height: res.h,
    videoCodec: spec.video_codec ?? "h264",
    audioCodec: spec.audio_codec ?? "aac",
    videoBitrateBps: (spec.video_bitrate_kbps ?? 3500) * 1000,
    audioBitrateBps: (spec.audio_bitrate_kbps ?? 128) * 1000,
  };
}
