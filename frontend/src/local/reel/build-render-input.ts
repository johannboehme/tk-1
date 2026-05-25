/**
 * buildRenderInputFromJob — reconstruct a job's full render input
 * (`EditSpecLocal`) from its persisted `LocalJob`, WITHOUT mounting the
 * editor. Mirrors `useEditorStore.buildEditSpec()` + the editor's submit
 * transform (`Editor.tsx#onSubmit`) so a job rendered headlessly (e.g. as a
 * Reel member) is identical to the same job rendered from the editor.
 *
 * Depends on WS1 persisting `overlays` / `visualizer` / `offsetOverrideMs`
 * onto the job — without those the headless render would silently drop text
 * overlays + visualizers.
 *
 * Pure function — no IO, no React, no store.
 */
import {
  isImageAsset,
  type LocalJob,
} from "../../storage/jobs-db";
import { projectLegacyCutsFx, synthesizeJobLoadShape } from "../../editor/job-synth";
import { sliceByArrSegments } from "../../editor/arrangement-time";
import { exportSpecToRenderOpts } from "../../editor/exportPresets";
import type { ExportSpec, Pill, Segment } from "../../editor/types";
import type { EditSpecLocal } from "../jobs";

/** Master-trim window for a job, mirroring the editor's load defaults: a
 *  persisted trim is clamped to the master range; otherwise the window is
 *  derived from the arrangement-segment bounds (direct-mode collapses to
 *  the full [0, duration]). */
function resolveTrim(
  job: LocalJob,
  durationS: number,
  arrangementSegments: readonly Segment[],
): { in: number; out: number } {
  if (job.trim) {
    const tin = Math.max(0, Math.min(job.trim.in, durationS));
    const tout = Math.max(tin, Math.min(job.trim.out, durationS));
    return { in: tin, out: tout };
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const seg of arrangementSegments) {
    if (seg.in < lo) lo = seg.in;
    if (seg.out > hi) hi = seg.out;
  }
  return lo < hi ? { in: lo, out: hi } : { in: 0, out: durationS };
}

export function buildRenderInputFromJob(job: LocalJob): EditSpecLocal {
  const durationS = job.durationS ?? 0;
  let { arrangementSegments } = synthesizeJobLoadShape(job, durationS);

  // Longform safety net: if the project was triaged but has no arrangement
  // (never sequenced, or arrangement not persisted), `synthesizeJobLoadShape`
  // falls back to the WHOLE recording — which would render the full 30-min
  // original instead of the kept chunks. Honour triage by rendering the
  // accepted chunks in recording order. (With a real arrangement this branch
  // is skipped and the arranged order wins.)
  if (
    job.mode === "longform" &&
    (!job.arrangement || job.arrangement.length === 0) &&
    Array.isArray(job.chunks)
  ) {
    const accepted = job.chunks
      .filter((c) => c.accepted)
      .sort((a, b) => a.startMs - b.startMs)
      .map((c) => ({ in: c.startMs / 1000, out: c.endMs / 1000 }));
    if (accepted.length > 0) arrangementSegments = accepted;
  }

  // Legacy cut migration (shared with the editor mount). fx is migrated by
  // the same helper but lives on the job, not in EditSpecLocal — the reel
  // orchestrator reads `projectLegacyCutsFx(...).fx` separately.
  const { cuts } = projectLegacyCutsFx(job, arrangementSegments);

  // Segments: slice the arrangement segments to the trim window, passing
  // through chunk-anchored metadata — byte-for-byte the same as
  // buildEditSpec().
  const trim = resolveTrim(job, durationS, arrangementSegments);
  const slices = sliceByArrSegments(trim.in, trim.out, arrangementSegments);
  const segments: Segment[] = slices.map((sl) => {
    const out: Segment = { in: sl.masterStartS, out: sl.masterEndS };
    const seg = arrangementSegments.find(
      (g) => g.in <= sl.masterStartS && g.out >= sl.masterEndS,
    );
    if (seg?.audioStartMs != null) out.audioStartMs = seg.audioStartMs;
    if (seg?.chunkId != null) out.chunkId = seg.chunkId;
    return out;
  });

  // Overlays: editor TextOverlay (nested `reactive`) → render overlay shape
  // (flat `reactiveBand`/`reactiveParam`/`reactiveAmount`). Same mapping as
  // Editor.tsx#onSubmit.
  const overlays: EditSpecLocal["overlays"] = (job.overlays ?? []).map((o) => ({
    text: o.text ?? "",
    start: o.start ?? 0,
    end: o.end ?? 0,
    preset: o.preset ?? "plain",
    x: o.x ?? 0.5,
    y: o.y ?? 0.85,
    animation: (o.animation ??
      "fade") as EditSpecLocal["overlays"][number]["animation"],
    reactiveBand: o.reactive?.band ?? null,
    reactiveParam: (o.reactive?.param ??
      "scale") as EditSpecLocal["overlays"][number]["reactiveParam"],
    reactiveAmount: o.reactive?.amount ?? 0.3,
  }));

  const visualizers: EditSpecLocal["visualizers"] = job.visualizer
    ? [{ type: job.visualizer.type === "showfreqs" ? "showfreqs" : "showwaves" }]
    : undefined;

  // Canonical global sync nudge. Prefer the explicit field (WS1); fall back
  // to cam-1's syncOverrideMs for jobs persisted before it existed.
  const cam1 = job.videos?.[0];
  const cam1Override =
    cam1 && !isImageAsset(cam1) ? (cam1.syncOverrideMs ?? 0) : 0;
  const offsetOverrideMs = job.offsetOverrideMs ?? cam1Override;

  const sourceDims = { w: job.width ?? 1920, h: job.height ?? 1080 };
  const exportOpts =
    job.exportSpec && typeof job.exportSpec === "object"
      ? exportSpecToRenderOpts(job.exportSpec as ExportSpec, sourceDims)
      : undefined;

  // Per-cam overrides off the persisted asset rows (the editor's live
  // clipOverrides aren't available headlessly; the asset rows are the
  // persisted source of truth).
  const clipOverrides = (job.videos ?? []).map((v) => ({
    id: v.id,
    syncOverrideMs: isImageAsset(v) ? 0 : (v.syncOverrideMs ?? 0),
    startOffsetS: v.startOffsetS ?? 0,
    rotation: v.rotation,
    flipX: v.flipX,
    flipY: v.flipY,
    viewportTransform: v.viewportTransform,
  }));

  return {
    segments,
    overlays,
    offsetOverrideMs,
    visualizers,
    exportOpts,
    outputFilename:
      (job.exportSpec as ExportSpec | undefined)?.filename ??
      job.title ??
      undefined,
    clipOverrides,
    cuts,
    pills: (job.pills ?? []) as Pill[],
    audioVolume: job.audioVolume,
  };
}
