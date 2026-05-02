/**
 * Output-Frame-Berechnung für Live-Preview und Render-Pipeline.
 *
 * Output (Stage) ist EXPLIZIT in `exportSpec.resolution` festgelegt. Wenn
 * der User noch nichts gewählt hat, fällt die Berechnung auf die dims
 * des ERSTEN Clips auf der Timeline zurück (nach `startS` sortiert).
 *
 * Die alte bbox-Logik `(max(W_i), max(H_i))` produzierte bei Multi-AR-
 * Mixen unsinnige Ergebnisse (Widescreen + Portrait → quadratisch). Per-
 * Element-Transform übernimmt jetzt die Per-Clip-Platzierung — siehe
 * {@link applyViewportTransform}.
 */
import type { Clip } from "./types";
import { clipEffectiveDisplayDims, clipRangeS } from "./types";
import type { ExportSpec } from "./types";

export interface OutputFrameBox {
  /** Position des Output-Frames innerhalb des Containers (CSS-pixel). */
  left: number;
  top: number;
  /** Größe des Output-Frames (CSS-pixel). */
  width: number;
  height: number;
}

export interface OutputDims {
  w: number;
  h: number;
}

/**
 * Bestimmt die intendierten Output-Dimensionen.
 *
 * 1. Wenn `resolution` explizit gesetzt ist → die.
 * 2. Sonst: dims des ERSTEN Clips auf der Timeline (nach `startS`).
 * 3. `null` solange kein Clip seine `displayW/H` gemeldet hat.
 */
export function resolveOutputDims(
  clips: readonly Clip[],
  resolution: ExportSpec["resolution"],
): OutputDims | null {
  if (
    resolution &&
    resolution !== "source" &&
    resolution.w > 0 &&
    resolution.h > 0
  ) {
    return { w: resolution.w, h: resolution.h };
  }
  // First clip on the timeline (by start time on the master timeline)
  // that has reported its dims. Image clips and video clips both count.
  const sorted = [...clips].sort(
    (a, b) => clipRangeS(a).startS - clipRangeS(b).startS,
  );
  for (const c of sorted) {
    const dims = clipEffectiveDisplayDims(c);
    if (dims) return { w: dims.w, h: dims.h };
  }
  return null;
}

/** Convenience for callers that only care about the AR. */
export function resolveOutputAspectRatio(args: {
  resolution: ExportSpec["resolution"];
  clips: readonly Clip[];
}): number | null {
  const dims = resolveOutputDims(args.clips, args.resolution);
  if (!dims) return null;
  return dims.w / dims.h;
}

/**
 * Berechnet das Output-Frame-Rechteck — aspect-fit, zentriert in den
 * Container. Für eine Output-AR > Container-AR (z.B. 16:9 in 21:9):
 * letterbox top/bottom. Für Output-AR < Container-AR: pillarbox links/
 * rechts. AR-Match: füllt den Container.
 */
export function computeOutputFrameBox(
  outputAspect: number,
  container: { width: number; height: number },
): OutputFrameBox {
  const cw = Math.max(0, container.width);
  const ch = Math.max(0, container.height);
  if (outputAspect <= 0 || cw === 0 || ch === 0) {
    return { left: 0, top: 0, width: cw, height: ch };
  }
  const containerAspect = cw / ch;
  if (Math.abs(containerAspect - outputAspect) < 1e-3) {
    return { left: 0, top: 0, width: cw, height: ch };
  }
  if (outputAspect > containerAspect) {
    // Container relatively taller → output letterboxes top/bottom.
    const w = cw;
    const h = w / outputAspect;
    return {
      left: 0,
      top: (ch - h) / 2,
      width: w,
      height: h,
    };
  }
  // Output relatively taller → output pillarboxes left/right.
  const h = ch;
  const w = h * outputAspect;
  return {
    left: (cw - w) / 2,
    top: 0,
    width: w,
    height: h,
  };
}
