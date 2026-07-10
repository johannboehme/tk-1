/**
 * Human-readable labels for render-op stages. Shared by every surface
 * that shows render progress (RenderScreen, JobPage quick-render console)
 * so a stage never leaks as its raw machine name in one place while
 * being translated in another.
 */
const STAGE_LABELS: Record<string, string> = {
  "render-prep": "Preparing",
  "audio-decode": "Decoding audio",
  "audio-encode": "Encoding audio",
  "energy-curves": "Analyzing audio energy",
  "extracting-frames": "Extracting preview frames",
  encoding: "Encoding video",
  "encoder-flush": "Flushing last frames",
  muxing: "Muxing audio + video",
  finalizing: "Finalizing file",
  writing: "Writing MP4",
  rendered: "Done",
  cancelled: "Cancelled",
};

export function renderStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
