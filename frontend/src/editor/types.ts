/**
 * Editor-internal types. Previously these were re-used from the backend
 * API client; now that the app is fully local we keep them here so the
 * editor remains backend-agnostic.
 */

/** Sentinel id for selecting the master-audio "lane" in the SyncTuner.
 *  Cam clips own real ids; this synthetic id flips the SyncTuner into
 *  audio-nudge mode. `clips.find(c => c.id === MASTER_AUDIO_ID)` is
 *  always undefined — every existing read-site already handles that
 *  gracefully (returns null/falsy). */
export const MASTER_AUDIO_ID = "master-audio";

export interface Segment {
  in: number;
  out: number;
}

export interface ReactiveModulation {
  band: "bass" | "low_mids" | "mids" | "highs";
  param: "scale" | "y" | "rotate";
  amount: number;
}

export interface TextOverlay {
  type: "text";
  text: string;
  start: number;
  end: number;
  preset?: "plain" | "boxed" | "outline" | "glow" | "gradient";
  x?: number;
  y?: number;
  animation?: "fade" | "pop" | "slide_in" | "word_reveal" | "wobble" | "none";
  reactive?: ReactiveModulation;
}

export interface VisualizerConfig {
  type: "showcqt" | "showfreqs" | "showwaves" | "showspectrum" | "avectorscope";
  position?: "top" | "center" | "bottom";
  height_pct?: number;
  opacity?: number;
}

export type ExportPreset = "web" | "archive" | "mobile" | "custom";

export type QualityStep = "tiny" | "low" | "good" | "high" | "pristine" | "custom";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "21:9" | "custom";

/**
 * Per-element placement on the Stage (output frame).
 *
 * The default (cover-fit) is the identity `{ scale: 1, x: 0, y: 0 }`.
 * `scale` is a multiplier on top of cover-fit (1 = element exactly
 * covers the stage). `x` and `y` are pixel offsets in stage-coordinate
 * space, applied AFTER the scale, around the cover-fit centre.
 *
 * Optional on clips — `undefined` means "use the default" (also the
 * reset state when the user double-clicks the element in the preview).
 */
export interface ViewportTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ExportSpec {
  preset: ExportPreset;
  /** Output container. Currently only MP4 (mp4-muxer constraint). */
  format?: "mp4";
  /** Output dimensions, or "source" to keep the source's. Concrete dims
   *  are the source of truth — `aspectRatio` + `resolutionLongSide`
   *  are picker UI hints kept in sync via the store. */
  resolution?: { w: number; h: number } | "source";
  /** UI hint: aspect picker selection. Stays in sync with `resolution`
   *  via the store. `undefined` until first set. */
  aspectRatio?: AspectRatio;
  /** UI hint: long-side resolution preset (px). Combined with
   *  `aspectRatio` derives `resolution`. `undefined` until first set. */
  resolutionLongSide?: number;
  video_codec?: "h264" | "h265";
  audio_codec?: "aac" | "opus";
  video_bitrate_kbps?: number;
  audio_bitrate_kbps?: number;
  /** Snap-step the user picked on the quality slider. "custom" means they
   *  edited a bitrate manually so the slider visualises a free position. */
  quality?: QualityStep;
  /** Output filename (without extension — extension is derived from format). */
  filename?: string;
}

export interface EditSpec {
  version: 1;
  segments: Segment[];
  overlays: TextOverlay[];
  visualizer: VisualizerConfig | null;
  sync_override_ms?: number;
  export?: ExportSpec;
}

export interface MatchCandidate {
  offsetMs: number;
  confidence: number;
  overlapFrames: number;
}

/**
 * In-memory representation of one video clip on the master timeline.
 *
 * Built from the persisted `VideoAsset` plus user-editable bits
 * (per-cam nudge, drag-on-timeline offset). The derived position on the
 * master timeline is `clipRangeS(clip)` — the single place that knows the
 * sign convention between the sync algorithm and the master clock.
 */
export interface VideoClip {
  /** Discriminator. Optional for backward-compat in tests; defaults to
   *  "video" when absent. */
  kind?: "video";
  id: string;
  filename: string;
  color: string;
  sourceDurationS: number;
  /** Algorithm-derived sync offset (ms) of this cam vs. the master audio.
   *  Mirror of `candidates[selectedCandidateIdx].offsetMs` when candidates
   *  are present, kept as a flat field for legacy consumers. */
  syncOffsetMs: number;
  /** Per-cam user nudge (ms) — added on top of syncOffsetMs. */
  syncOverrideMs: number;
  /** Additional drag-on-timeline offset (seconds). 0 = positioned purely by sync. */
  startOffsetS: number;
  /** Per-cam drift relative to the master audio. > 1 means the cam clock
   *  ran faster than master, so each master-second corresponds to slightly
   *  more cam-source-time. Default 1 = no drift. Used by the preview and
   *  render to compute cam-source-time via `camSourceTimeS()`. */
  driftRatio: number;
  /** Top-K alternative offsets ranked by sample-level confidence. May be
   *  empty for legacy jobs; the editor falls back to syncOffsetMs alone. */
  candidates: MatchCandidate[];
  /** Index into `candidates` of the user-selected primary. Defaults to 0
   *  (top-confidence candidate). The user can move this with match-snap. */
  selectedCandidateIdx: number;
  /** Per-clip in-point (seconds, 0..sourceDurationS). Optional —
   *  undefined / 0 = play from source frame 0. Functions as a real cut
   *  from the front: the visible master-timeline range narrows on the
   *  left by `trimInS`, and the cam plays from source-time `trimInS`
   *  onward at the new visible left edge. The anchor (`anchorS` from
   *  `clipRangeS`) — where source-time 0 lives on the master timeline —
   *  stays fixed regardless of trim. */
  trimInS?: number;
  /** Per-clip out-point (seconds, in source-time). Undefined = play
   *  through end of source. Same anchor-vs-visible semantics as
   *  `trimInS` — narrows the visible range from the right; the anchor
   *  is unaffected. */
  trimOutS?: number;
  /** Post-rotation displayed width/height (CSS-pixel scale, browser-
   *  decoded). Filled in lazily when the underlying `<video>` reports
   *  loadedmetadata. Used by the output-frame resolver to compute the
   *  bounding-box (max W, max H) over all clips so the preview + render
   *  always covers every cam regardless of which is currently active. */
  displayW?: number;
  displayH?: number;
  /** User-applied rotation on top of the stored MP4 rotation matrix.
   *  V1 supports 90° steps only (0/90/180/270); the wider type keeps the
   *  door open for free rotation later without a breaking change. */
  rotation?: number;
  /** Mirror the cam horizontally / vertically. Applied in the same step
   *  as `rotation` (rotate-then-flip in the compositor). */
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element placement on the Stage. `undefined` = cover-fit default. */
  viewportTransform?: ViewportTransform;
}

/**
 * In-memory representation of a still-image clip on the master timeline.
 *
 * Image clips have no audio track, no sync, no drift — only a user-set
 * duration and a free placement offset. They share the cam-id namespace
 * with VideoClips so cuts (which reference cam IDs) work transparently.
 */
export interface ImageClip {
  kind: "image";
  id: string;
  filename: string;
  color: string;
  /** User-chosen length on the master timeline (seconds). */
  durationS: number;
  /** Master-timeline placement offset (seconds). The clip occupies
   *  [startOffsetS, startOffsetS + durationS). */
  startOffsetS: number;
  /** Natural pixel size of the image. Same role as VideoClip's
   *  displayW/H — feeds the output-frame bounding-box resolver. */
  displayW?: number;
  displayH?: number;
  /** User-applied rotation. V1: 0/90/180/270. */
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Per-element placement on the Stage. `undefined` = cover-fit default. */
  viewportTransform?: ViewportTransform;
}

export type Clip = VideoClip | ImageClip;

/** True iff the clip is an image clip (kind === "image"). VideoClips may
 *  have kind undefined or "video"; both count as video. */
export function isImageClip(c: Clip): c is ImageClip {
  return c.kind === "image";
}
export function isVideoClip(c: Clip): c is VideoClip {
  return c.kind !== "image";
}

/** Normalise a user-rotation value into the canonical 0/90/180/270 range.
 *  Values that aren't already a multiple of 90 are snapped to the nearest
 *  multiple — V1 doesn't render free angles cleanly. */
export function normaliseRotation(rot: number | undefined): 0 | 90 | 180 | 270 {
  const n = Math.round(((rot ?? 0) % 360 + 360) % 360 / 90) * 90;
  switch (n) {
    case 90:
      return 90;
    case 180:
      return 180;
    case 270:
      return 270;
    default:
      return 0;
  }
}

/** Effective on-screen dims of a clip after user rotation has been applied.
 *  90° / 270° swap W ↔ H; 0° / 180° leave them unchanged. Returns undefined
 *  when the clip hasn't reported its native dims yet. */
export function clipEffectiveDisplayDims(
  c: Clip,
): { w: number; h: number } | undefined {
  const w = c.displayW;
  const h = c.displayH;
  if (!w || !h) return undefined;
  const rot = normaliseRotation(c.rotation);
  if (rot === 90 || rot === 270) return { w: h, h: w };
  return { w, h };
}

/**
 * Compute where a clip lives on the master timeline.
 *
 * Returns three values that callers must NOT confuse:
 *   - `anchorS`: where this clip's source-time 0 sits on the master
 *     timeline. Trim does NOT move it — only sync does. Feed this into
 *     `camSourceTimeS()` / `camSourceTimeUs()`.
 *   - `startS` / `endS`: the visible range [startS, endS) the clip
 *     occupies on the tape. Narrowed by `trimInS` / `trimOutS` so a
 *     trim drag works as a true cut. Use these for hit-testing,
 *     drawing, cuts routing (`activeCamAt`).
 *
 * For image clips, `anchorS === startS` (no sync, no trim).
 *
 * Video sign convention: `syncOffsetMs` is the delay applied to the master
 * audio to align with this video's audio. When positive, the master audio
 * starts later than the video → the video begins *before* master t=0, so
 * `anchorS` is negative. `syncOverrideMs` and `startOffsetS` add to this.
 */
export function clipRangeS(
  clip: Clip,
): { anchorS: number; startS: number; endS: number } {
  if (isImageClip(clip)) {
    return {
      anchorS: clip.startOffsetS,
      startS: clip.startOffsetS,
      endS: clip.startOffsetS + clip.durationS,
    };
  }
  const totalSyncS = (clip.syncOffsetMs + clip.syncOverrideMs) / 1000;
  const baseStartS = -totalSyncS + clip.startOffsetS;
  const trimInS = clip.trimInS ?? 0;
  const trimOutS = clip.trimOutS ?? clip.sourceDurationS;
  return {
    anchorS: baseStartS,
    startS: baseStartS + trimInS,
    endS: baseStartS + trimOutS,
  };
}

