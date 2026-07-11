/**
 * Backend-agnostic snapshot of one renderable frame.
 *
 * Pure data — no React, no DOM, no `<video>` references. Backends consume
 * this descriptor + a runtime `SourcesMap` (layerId → GPU-importable
 * source) and produce pixels. Same shape drives:
 *   - the live preview compositor (Canvas2D / WebGL2 / WebGPU backends)
 *   - the export compositor (Canvas2D backend)
 *
 * Cuts vs FX semantic split is structural here:
 *   - `layers` come from `activeCamAt` — exclusive (V2: 0 or 1 entries)
 *   - `fx` come from `activeFxAt` — polyphonic, paint additively
 * A backend cannot conflate the two by mistake; they live in different
 * fields. See [memory: P-FX vs Cuts Semantik].
 */
import type { FxKind } from "../fx/types";

export interface OutputDims {
  /** Output canvas width in pixels (integer-snapped by the builder). */
  w: number;
  /** Output canvas height in pixels (integer-snapped by the builder). */
  h: number;
}

export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayerSourceRef =
  /** Live `<video>` (preview) or decoded `VideoFrame` (export). The layer
   *  needs the source-time + duration so the backend can request the
   *  right frame from the source map. */
  | { kind: "video"; clipId: string; sourceTimeS: number; sourceDurS: number }
  /** Static image clip — same lifecycle for both preview and export. */
  | { kind: "image"; clipId: string }
  /** Synthetic test pattern when no cam has material. The backend may
   *  skip this entry and let a DOM-side TestPattern overlay take over,
   *  or render its own SMPTE bars — both are valid. */
  | { kind: "test-pattern" };

export interface FrameLayer {
  /** Stable across frames. Backends key textures off this. */
  layerId: string;
  source: LayerSourceRef;
  /** Alpha multiplier ∈ [0, 1]. V2 ships exactly one layer at weight 1.
   *  V3-ready slot for crossfades / transitions between cams without
   *  changing the descriptor shape. */
  weight: number;
  /** Where in the output to place the source, post-fit. Already accounts
   *  for letterbox / pillarbox of the source's display AR vs the output
   *  bbox. Backend just blits — no fit math required at draw time. */
  fitRect: FitRect;
  /** Rotation the backend must apply to the source pixel buffer it gets
   *  via `SourcesMap`. For preview, where `<video>` already shows the
   *  intrinsic MP4 matrix, this is user-rotation only. For export, where
   *  VideoFrame is pre-intrinsic, this is `(intrinsic + user) % 360`.
   *  Either way, the backend treats this as the absolute rotation to
   *  apply to whatever pixels it receives. */
  rotationDeg: 0 | 90 | 180 | 270;
  /** Mirror after rotation. Same convention as today's CSS transform
   *  (`rotate(${rot}deg) scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`)
   *  and Canvas2D `compositor.ts` (translate → rotate → scale). */
  flipX: boolean;
  flipY: boolean;
  /** Source pixel buffer dimensions AFTER `rotationDeg` has been applied
   *  (i.e. swap-aware). Carried so backends can pick sampler / scale
   *  without redoing the rotation math. Equals `fitRect.w × fitRect.h`
   *  ratio-wise; used for parity asserts. */
  displayW: number;
  displayH: number;
}

export interface FrameFx {
  id: string;
  kind: FxKind;
  /** Master-time inclusive start of the punched capsule. The backend
   *  passes this to FX renderers so they can compute capsule-local time
   *  (`tMaster - inS`) for animated effects (TAPE-stop progress, ZOOM
   *  beat-pump phase, ECHO-trail offsets). */
  inS: number;
  /** Already merged with the FX kind's `defaultParams` so the backend
   *  doesn't need to know about defaults. */
  params: Record<string, number>;
  /** ADSR-sampled wet/dry mix factor ∈ [0, 1] for THIS frame.
   *   - 1 → render the FX at full strength (no source rebound)
   *   - 0 → no effect (skip)
   *   - 0..1 → backend rebinds the pre-FX source over the FX result with
   *     alpha (1 - wetness) to softly fade in/out. The descriptor builder
   *     samples the envelope so backends stay envelope-agnostic. */
  wetness: number;
  /** Modulation cycle phase ∈ [0,1) for THIS frame (LFO mode). Effects
   *  with internal periodic geometry (zoom pulse, echo sweep) read this
   *  instead of computing their own period — so the timing is centralized
   *  and beat-correct. 0 in sidechain mode / for legacy (depth-0) fx. */
  phase?: number;
}

/**
 * One renderable frame. Backends iterate `layers` in array order
 * (back-to-front), then iterate `fx` in array order (additive on top).
 */
export interface FrameDescriptor {
  /** Master-timeline second this frame represents. */
  tMaster: number;
  /** Output dims (integer-pixel-snapped). `null` means: nothing is
   *  renderable yet (no clips have reported displayDims and no explicit
   *  resolution is set). Backend should clear to background and bail. */
  output: OutputDims | null;
  /** Stacked source layers. Empty → backend renders test pattern (or
   *  yields to DOM TestPattern overlay). */
  layers: readonly FrameLayer[];
  /** Active P-FX at `tMaster`. Empty when nothing is held. */
  fx: readonly FrameFx[];
}
