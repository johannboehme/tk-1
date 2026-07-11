/**
 * Backend-agnostic compositor interface. Same shape for live preview
 * (WebGPU/WebGL2/Canvas2D) and export (Canvas2D — driving the same
 * code path as the preview fallback so the two never drift).
 *
 * Lifecycle:
 *   const b = await createBackend(canvas, caps, capabilities);
 *   await b.warmup();           // optional — eager shader compile
 *   b.drawFrame(descriptor, sources);  // one per RAF / per export tick
 *   b.resize({ pixelW, pixelH });      // when output dims change
 *   b.dispose();                       // tear down GPU resources
 *
 * Backends MUST NOT retain references to anything in `sources` past
 * the `drawFrame` call — the runtime owns lifetimes (WebCodecs
 * VideoFrames in particular must be `.close()`-able right after).
 */
import type { FrameDescriptor } from "./frame-descriptor";

/** Runtime mapping from `FrameLayer.layerId` → GPU-importable source.
 *  The backend looks up each layer's source by the layerId at draw
 *  time. A missing entry means the source isn't ready yet — the
 *  backend MAY skip that layer or substitute background. */
export type LayerSource =
  | {
      kind: "video";
      element: HTMLVideoElement;
      /** Last-good frame snapshot held by the runtime. When the
       *  `<video>` is mid-seek (`seeking || readyState < 2`) the
       *  runtime sets `preferFallback=true` so the backend draws this
       *  bitmap instead of the empty/transparent video element —
       *  hides the black flash that would otherwise show the
       *  background-clear through during loop wraps and scrubs. */
      fallback?: ImageBitmap;
      preferFallback?: boolean;
    }
  | { kind: "videoframe"; frame: VideoFrame }
  | { kind: "image"; bitmap: ImageBitmap | HTMLImageElement }
  | { kind: "test-pattern" };

export type SourcesMap = ReadonlyMap<string, LayerSource>;

export interface BackendCaps {
  /** Backbuffer pixel dimensions. Same as the canvas's `.width/.height`.
   *  For preview = `cssW * dpr * scale`. For export = output frame dims. */
  pixelW: number;
  pixelH: number;
  /** Optional CSS dims — preview only, undefined for export. Backends
   *  that need to set the canvas's CSS size for layout (live preview)
   *  use these; the export backend ignores them. */
  cssW?: number;
  cssH?: number;
}

/** Phase the BackendError happened in. Lets the factory / runtime
 *  decide whether to fall back a tier or just warn. */
export type BackendErrorPhase = "init" | "compile" | "draw" | "lost-context";

export class BackendError extends Error {
  readonly phase: BackendErrorPhase;
  constructor(phase: BackendErrorPhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.phase = phase;
    this.name = "BackendError";
  }
}

export type BackendId = "webgpu" | "webgl2" | "canvas2d";

export interface CompositorBackend {
  readonly id: BackendId;

  /** Bind to a canvas + size. Throws `BackendError("init", ...)` if the
   *  backing context can't be created. Resolves once ready to draw. */
  init(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    caps: BackendCaps,
  ): Promise<void>;

  /** Resize the backbuffer (and CSS size, if cssW/cssH set). Idempotent. */
  resize(caps: BackendCaps): void;

  /** Eager pipeline / shader compile. Backends without a compile step
   *  (Canvas2D) treat this as a no-op. Safe to call multiple times. */
  warmup(): Promise<void>;

  /** Paint one frame. The `sources` map is read-only and MUST NOT be
   *  retained past this call. */
  drawFrame(descriptor: FrameDescriptor, sources: SourcesMap): void;

  /** Drop GPU resources. Idempotent. */
  dispose(): void;

  /** Optional hook for backends whose device/context can die
   *  asynchronously (WebGPU's `GPUDevice.lost`). The backend invokes it
   *  once when the device is lost OUTSIDE of `dispose()` — after that,
   *  `drawFrame` silently no-ops, so the owner must tear the backend
   *  down and rebuild on a lower tier (the session capability has
   *  already been downgraded by then). Assigned by the owner after
   *  `init()`; backends without async loss never call it. */
  onContextLost?: (info: { reason: string; message: string }) => void;
}
