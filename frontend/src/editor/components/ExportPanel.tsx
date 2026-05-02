// Studio-Console export dialog.
//
// V2 layout (post Stage redesign — see plan file):
//   1. ASPECT picker — picks Stage shape independently of pixels.
//   2. RESOLUTION picker — long-side presets, derived from aspect.
//   3. Big mono LCD readout — "1920 × 1080" so the user always sees
//      the concrete pixels they will get.
//   4. PRESET (Web/Archive/Mobile/Custom) — bitrate + codec recipe.
//   5. QUALITY slider — bitrate ladder.
//   6. Advanced drawer — codecs, bitrates, filename.
//
// IOReadout (Source vs Output) is gone. There's no single "source" in
// a multi-clip edit — the Stage shape is what the user picks here.
//
// Everything reads/writes through the editor store's `exportSpec`. The
// onSubmit handler in `Editor.tsx` translates the spec to the renderer's
// raw options via `exportSpecToRenderOpts`.

import { useEffect, useMemo } from "react";
import {
  applyPreset,
  classifyAspectRatio,
  deriveResolution,
  estimateFileSizeBytes,
  qualityToBitrates,
  resolveResolution,
} from "../exportPresets";
import { useEditorStore } from "../store";
import type { AspectRatio, ExportPreset, ExportSpec, QualityStep } from "../types";
import { AdvancedDrawer } from "./AdvancedDrawer";
import { AspectPicker } from "./AspectPicker";
import { ChunkyButton } from "./ChunkyButton";
import { FilenameInput } from "./FilenameInput";
import { QualitySlider } from "./QualitySlider";
import { ResolutionPicker } from "./ResolutionPicker";
import { SegmentedControl } from "./SegmentedControl";
import { SizeEstimate } from "./SizeEstimate";
import { DownloadIcon } from "./icons";

interface Props {
  onSubmit: () => void;
  submitting: boolean;
}

export function ExportPanel({ onSubmit, submitting }: Props) {
  const exportSpec = useEditorStore((s) => s.exportSpec);
  const setExport = useEditorStore((s) => s.setExport);
  const jobMeta = useEditorStore((s) => s.jobMeta);

  // Source dims are still needed for `applyPreset` (preset's bitrate
  // ladder scales with output area, and a "source pass-through" preset
  // needs *some* concrete fallback dims). When no clip has reported its
  // dims yet we fall back to the legacy job meta — typically 1920×1080.
  const source = useMemo(
    () => ({
      w: jobMeta?.width ?? 1920,
      h: jobMeta?.height ?? 1080,
      durationS: jobMeta?.duration ?? 0,
    }),
    [jobMeta?.width, jobMeta?.height, jobMeta?.duration],
  );

  const output = useMemo(
    () => resolveResolution(exportSpec.resolution, source),
    [exportSpec.resolution, source],
  );

  // Re-derive bitrates from the quality step whenever the output resolution
  // changes — otherwise picking a new preset / resolution would leave bitrate
  // unchanged and break the "what Quality means at this resolution" promise.
  // We skip when quality is "custom", because then the user has set bitrate
  // explicitly and we must not overwrite their choice.
  useEffect(() => {
    if (exportSpec.quality === "custom") return;
    if (!exportSpec.quality) return;
    const { videoKbps, audioKbps } = qualityToBitrates(exportSpec.quality, output);
    if (
      exportSpec.video_bitrate_kbps === videoKbps &&
      exportSpec.audio_bitrate_kbps === audioKbps
    ) {
      return;
    }
    setExport({
      video_bitrate_kbps: videoKbps,
      audio_bitrate_kbps: audioKbps,
    });
  }, [
    exportSpec.quality,
    output.w,
    output.h,
    exportSpec.video_bitrate_kbps,
    exportSpec.audio_bitrate_kbps,
    output,
    setExport,
  ]);

  const sizeBytes = estimateFileSizeBytes({
    videoKbps: exportSpec.video_bitrate_kbps ?? 0,
    audioKbps: exportSpec.audio_bitrate_kbps ?? 0,
    durationS: source.durationS,
  });

  function selectPreset(p: ExportPreset) {
    setExport(applyPreset(p, exportSpec));
  }

  function selectQuality(q: Exclude<QualityStep, "custom">) {
    const { videoKbps, audioKbps } = qualityToBitrates(q, output);
    setExport({
      quality: q,
      video_bitrate_kbps: videoKbps,
      audio_bitrate_kbps: audioKbps,
    });
  }

  // Aspect change: keep the existing long-side, derive new {w,h}.
  function pickAspect(a: AspectRatio) {
    if (a === "custom") {
      // Custom means: use whatever {w,h} is currently set. Just flip
      // the picker state — don't touch resolution.
      setExport({ aspectRatio: "custom", preset: "custom" });
      return;
    }
    const longSide =
      exportSpec.resolutionLongSide ?? Math.max(output.w, output.h);
    const dims = deriveResolution(a, longSide);
    setExport({
      aspectRatio: a,
      resolutionLongSide: longSide,
      resolution: dims,
      preset: "custom",
    });
  }

  // Long-side change: re-derive {w,h} from active aspect.
  function pickLongSide(longSide: number) {
    const aspect = exportSpec.aspectRatio;
    if (!aspect || aspect === "custom") return;
    const dims = deriveResolution(aspect, longSide);
    setExport({
      resolutionLongSide: longSide,
      resolution: dims,
      preset: "custom",
    });
  }

  // Manual W/H: flips aspect to "custom" because the dims may not match
  // any preset.
  function setCustomDims(dims: { w: number; h: number }) {
    const matched = classifyAspectRatio(dims);
    setExport({
      resolution: dims,
      aspectRatio: matched,
      resolutionLongSide: Math.max(dims.w, dims.h),
      preset: "custom",
    });
  }

  function setVideoCodec(c: ExportSpec["video_codec"]) {
    setExport({ video_codec: c, preset: "custom" });
  }

  function setAudioCodec(c: ExportSpec["audio_codec"]) {
    setExport({ audio_codec: c, preset: "custom" });
  }

  function setVideoBitrate(kbps: number) {
    setExport({ video_bitrate_kbps: kbps, quality: "custom" });
  }

  function setAudioBitrate(kbps: number) {
    setExport({ audio_bitrate_kbps: kbps, quality: "custom" });
  }

  function setFilename(name: string) {
    setExport({ filename: name });
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="font-display text-lg leading-none">Export</h2>
        <p className="text-xs text-ink-2 mt-1">
          Pick the Stage shape, dial in the size, hit render.
        </p>
      </header>

      <SegmentedControl
        label="Preset"
        value={exportSpec.preset}
        options={[
          { value: "web", label: "WEB" },
          { value: "archive", label: "ARCHIVE" },
          { value: "mobile", label: "MOBILE" },
          { value: "custom", label: "CUSTOM" },
        ]}
        onChange={selectPreset}
        fullWidth
      />

      <AspectPicker value={exportSpec.aspectRatio} onChange={pickAspect} />

      <ResolutionPicker
        aspect={exportSpec.aspectRatio}
        value={output}
        onPickLongSide={pickLongSide}
        onCustomDims={setCustomDims}
      />

      <QualitySlider
        value={exportSpec.quality ?? "good"}
        onChange={selectQuality}
      />

      <SizeEstimate
        bytes={sizeBytes}
        durationS={source.durationS}
        format={exportSpec.format ?? "mp4"}
        videoCodec={exportSpec.video_codec ?? "h264"}
        audioCodec={exportSpec.audio_codec ?? "aac"}
      />

      <AdvancedDrawer>
        <FormField label="Video codec">
          <SegmentedControl
            value={exportSpec.video_codec ?? "h264"}
            options={[
              { value: "h264", label: "H.264" },
              { value: "h265", label: "H.265" },
            ]}
            onChange={(v) => setVideoCodec(v as "h264" | "h265")}
            size="sm"
            fullWidth
          />
        </FormField>

        <FormField label="Audio codec">
          <SegmentedControl
            value={exportSpec.audio_codec ?? "aac"}
            options={[
              { value: "aac", label: "AAC" },
              { value: "opus", label: "Opus" },
            ]}
            onChange={(v) => setAudioCodec(v as "aac" | "opus")}
            size="sm"
            fullWidth
          />
        </FormField>

        <FormField label={`Video bitrate · ${exportSpec.video_bitrate_kbps ?? 0} kbps`}>
          <input
            type="range"
            min={500}
            max={20000}
            step={100}
            value={exportSpec.video_bitrate_kbps ?? 3500}
            onChange={(e) => setVideoBitrate(parseInt(e.target.value, 10))}
            className="w-full accent-hot"
          />
        </FormField>

        <FormField label={`Audio bitrate · ${exportSpec.audio_bitrate_kbps ?? 0} kbps`}>
          <input
            type="range"
            min={64}
            max={320}
            step={16}
            value={exportSpec.audio_bitrate_kbps ?? 128}
            onChange={(e) => setAudioBitrate(parseInt(e.target.value, 10))}
            className="w-full accent-hot"
          />
        </FormField>

        <FilenameInput
          value={exportSpec.filename ?? ""}
          onChange={setFilename}
          extension={exportSpec.format ?? "mp4"}
        />
      </AdvancedDrawer>

      <ChunkyButton
        variant="primary"
        size="lg"
        fullWidth
        disabled={submitting}
        iconLeft={<DownloadIcon />}
        onClick={onSubmit}
      >
        {submitting ? "Submitting…" : "Render"}
      </ChunkyButton>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

