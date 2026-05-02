/**
 * Per-frame compositor for the edit-render pipeline.
 *
 * Pipeline per output frame:
 *   1. Layer + FX pass via the shared CompositorBackend
 *      (WebGPU → WebGL2 → Canvas2D fallback ladder, picked by
 *      `createBackend()` from `editor/render/factory.ts`). The
 *      backend writes its result into an internal `OffscreenCanvas`.
 *   2. The internal backend canvas is blitted into the final 2D
 *      `OffscreenCanvas` via `drawImage()` — once per frame.
 *   3. Audio-reactive Visualizer layers are painted on top with 2D ctx.
 *   4. Text overlays are burned in via the Canvas2D ASS-subset renderer.
 *   5. The final 2D canvas is wrapped as a new VideoFrame for the encoder.
 *
 * Rationale for the two-canvas pattern: the live preview now uses the
 * same `createBackend()` factory, which means the export's backend may
 * be WebGPU/WebGL2 (GPU context) — and a single canvas can't hold both
 * a GPU context and a 2D context. Visualizers + overlays still render
 * via Canvas2D (they're audio-reactive + text-rendering code, not
 * shader-friendly), so we composite GPU output into a 2D canvas first.
 *
 * Result: preview and export share the same backend code AND the same
 * backend choice, eliminating the long-standing "WEAR/TAPE look
 * different in render vs preview" bug. See [memory:
 * Render-Backends mit Fallback-Ladder].
 */

import type { TextOverlay, EnergyCurves } from "./ass-builder";
import { buildAss } from "./ass-builder";
import { renderOverlays } from "./ass-renderer";
import type { Visualizer } from "./visualizer/types";
import type { PunchFx } from "../../editor/fx/types";
import type { ViewportTransform } from "../../editor/types";
import { activeFxAt } from "../../editor/fx/active";
import { fxCatalog } from "../../editor/fx/catalog";
import { envelopeAt, INSTANT_ENVELOPE } from "../../editor/fx/envelope";
import {
  createBackend,
  type BackendCapabilities,
} from "../../editor/render/factory";
import type {
  CompositorBackend,
  LayerSource,
  SourcesMap,
} from "../../editor/render/backend";
import { WebGPUBackend } from "../../editor/render/webgpu-backend";
import {
  buildElementFitRect,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "../../editor/render/element-transform";
import type {
  FrameDescriptor,
  FrameFx,
  FrameLayer,
} from "../../editor/render/frame-descriptor";

export interface CompositorOptions {
  /** Output canvas dimensions — what's encoded. Overlays + visualizers are
   *  laid out relative to these. */
  width: number;
  height: number;
  /** Source video dimensions. Defaults to width/height when not provided
   *  (i.e. pass-through, no scaling). When source ≠ output, the source frame
   *  is fit aspect-preserving and any spare canvas is filled with black. */
  sourceWidth?: number;
  sourceHeight?: number;
  overlays: TextOverlay[];
  energy?: EnergyCurves | null;
  visualizers?: Visualizer[];
  /** Punch-in FX with in/out spans on the master timeline. Active fx at
   *  the current frame's timestamp paint over the source frame BEFORE
   *  visualizers and text overlays. Same `fxCatalog[kind]` impl as the
   *  live preview — single source of truth per kind. */
  fx?: readonly PunchFx[];
}

// Per-element placement is shared with the live preview via
// `buildElementFitRect` from `editor/render/element-transform.ts` —
// don't reintroduce a local letterbox helper here. The two pipelines
// MUST stay byte-identical on placement.

export class Compositor {
  /** Final 2D output canvas — blitted backend output + visualizers +
   *  overlays end up here, gets wrapped in the VideoFrame. */
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  /** Internal backend canvas (GPU- or 2D-context, depending on
   *  Backend tier). Layer + FX render here. */
  private backendCanvas: OffscreenCanvas;
  private backend: CompositorBackend;
  private opts: CompositorOptions;
  private assBlob: string | null = null;

  /** Konstruktor ist private; Aufrufer nutzen `Compositor.create()` weil
   *  der Backend-Factory async ist. */
  private constructor(
    opts: CompositorOptions,
    canvas: OffscreenCanvas,
    ctx: OffscreenCanvasRenderingContext2D,
    backendCanvas: OffscreenCanvas,
    backend: CompositorBackend,
  ) {
    this.opts = opts;
    this.canvas = canvas;
    this.ctx = ctx;
    this.backendCanvas = backendCanvas;
    this.backend = backend;
  }

  /** Async-Factory. Picks the best backend for `capabilities` via
   *  `createBackend()` and binds it to an internal OffscreenCanvas. */
  static async create(
    opts: CompositorOptions,
    capabilities: BackendCapabilities,
  ): Promise<Compositor> {
    const canvas = new OffscreenCanvas(opts.width, opts.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Compositor: OffscreenCanvas 2d context unavailable");
    }
    const backendCanvas = new OffscreenCanvas(opts.width, opts.height);
    const backend = await createBackend(
      backendCanvas,
      { pixelW: opts.width, pixelH: opts.height },
      capabilities,
    );
    await backend.warmup();
    return new Compositor(opts, canvas, ctx, backendCanvas, backend);
  }

  /** Pre-build the ASS string (used for external download / debugging). */
  async ensureSubtitleEngine(): Promise<void> {
    if (this.opts.overlays.length === 0) return;
    this.assBlob = buildAss(
      this.opts.overlays,
      this.opts.width,
      this.opts.height,
      this.opts.energy ?? null,
    );
  }

  /** Returns the generated ASS document, or null if no overlays were set. */
  getAssDocument(): string | null {
    return this.assBlob;
  }

  /** Composite `frame` for `timestampUs` and return a fresh VideoFrame whose
   *  caller MUST `.close()` after encoding. */
  composite(frame: VideoFrame, timestampUs: number): Promise<VideoFrame> {
    return this.compositeImage(
      frame as unknown as CanvasImageSource,
      this.opts.sourceWidth ?? frame.codedWidth,
      this.opts.sourceHeight ?? frame.codedHeight,
      timestampUs,
      frame.duration ?? 0,
    );
  }

  async compositeImage(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    timestampUs: number,
    durationUs: number,
    rotationDeg: 0 | 90 | 180 | 270 = 0,
    userTransform: {
      rotation?: number;
      flipX?: boolean;
      flipY?: boolean;
      /** Per-element Stage placement (cover-fit + scale + translate).
       *  Shared with the live preview via `buildElementFitRect` so the
       *  two pipelines never drift on placement. */
      viewportTransform?: ViewportTransform;
    } = {},
    /**
     * Master-timeline time in seconds for FX lookup. **Must be passed
     * by callers that use segments**, because `timestampUs` is the
     * output-relative timestamp (starts at 0 each segment) — looking
     * up FX with that ignores the master-time offset and the FX never
     * "fire" in the export. When omitted, falls back to
     * `timestampUs / 1e6` (correct only for whole-video renders where
     * output time == master time). */
    tMasterS?: number,
  ): Promise<VideoFrame> {
    const intrinsic = rotationDeg % 360;
    const userRot =
      ((Math.round((userTransform.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
    const rot = ((intrinsic + userRot) % 360) as 0 | 90 | 180 | 270;
    const flipX = !!userTransform.flipX;
    const flipY = !!userTransform.flipY;
    const swap = rot === 90 || rot === 270;
    const dispW = swap ? srcH : srcW;
    const dispH = swap ? srcW : srcH;
    const fit = buildElementFitRect(
      { w: dispW, h: dispH },
      { w: this.opts.width, h: this.opts.height },
      userTransform.viewportTransform ?? DEFAULT_VIEWPORT_TRANSFORM,
    );

    const t = timestampUs / 1_000_000;
    // FX live on the master timeline (e.g. fx.inS = 13.43s). When the
    // export uses segments, `timestampUs` is segment-relative and lookups
    // with it would miss every FX. Callers pass `tMasterS` for the
    // correct master-time FX query.
    const tFx = tMasterS ?? t;

    const layer: FrameLayer = {
      layerId: "src",
      source: { kind: "video", clipId: "src", sourceTimeS: 0, sourceDurS: 0 },
      weight: 1,
      fitRect: fit,
      rotationDeg: rot,
      flipX,
      flipY,
      displayW: dispW,
      displayH: dispH,
    };

    const fxFrame: FrameFx[] = this.opts.fx
      ? activeFxAt(this.opts.fx, tFx)
          .map((fx) => {
            const def = fxCatalog[fx.kind];
            const env = fx.envelope ?? INSTANT_ENVELOPE;
            const wetness = envelopeAt(env, fx.outS - fx.inS, tFx - fx.inS);
            const merged = { ...def.defaultParams, ...(fx.params ?? {}) };
            const params =
              def.applyWetness && wetness < 1
                ? def.applyWetness(merged, wetness)
                : merged;
            return { id: fx.id, kind: fx.kind, inS: fx.inS, params, wetness };
          })
          .filter((f) => f.wetness > 0)
      : [];

    const descriptor: FrameDescriptor = {
      tMaster: tFx,
      output: { w: this.opts.width, h: this.opts.height },
      layers: [layer],
      fx: fxFrame,
    };

    const sources: SourcesMap = new Map<string, LayerSource>([
      ["src", classifySource(source)],
    ]);

    // 1. Backend rendert Layer + FX in den internen backendCanvas
    //    (oder, im WebGPU-Fall, in den internen renderTarget).
    this.backend.drawFrame(descriptor, sources);

    // 2. Backend-Output → finalCanvas.
    //
    // **WebGPU-Pfad: GPU→CPU readback statt canvas-swap-chain.**
    // Hintergrund: WebGPU's canvas-Surface verwendet eine implizite
    // double-buffer Swap-Chain (`context.getCurrentTexture()` rotiert
    // zwischen 2+ slots). Im Export-Loop ohne VSync-Anker feuert der
    // VideoDecoder synchron alle Frames hintereinander, sodass
    // `transferToImageBitmap()` den FALSCHEN swap-slot lesen kann —
    // einmal slot A (frame N), dann slot B (frame N-1 oder N+1), dann
    // wieder A. Empirisch reproduziert: PSNR(frame N → frame N+2) >
    // PSNR(frame N → frame N+1), das klassische "alternierende"
    // back-and-forth Muster. Bypass: lies das interne `renderTarget`
    // direkt via copyTextureToBuffer und schreibe per `putImageData`
    // ins finalCanvas. Live-Preview nutzt weiter die
    // Canvas-Swap-Chain — RAF gibt VSync-Anker.
    //
    // Optimierungen:
    //   - WebGPU-Pfad geht ImageData → putImageData (keinen
    //     createImageBitmap-Roundtrip), spart eine GPU-bitmap-Allokation
    //     und einen async-Hop pro Frame.
    //   - Backend-seitig sind Buffer + RGBA-Array gecached (siehe
    //     WebGPUBackend.readbackToImageData) → kein 33 MB
    //     allocate/free pro 4K-Frame.
    //
    // Andere Backends (Canvas2D, WebGL2): canvas.transferToImageBitmap()
    // ist spec-garantiert korrekt + GPU-accelerated — die haben keinen
    // double-buffer Swap-Chain in dem Sinne, und drawImage(bitmap) ist
    // ein einziger GPU-blit.
    if (this.backend instanceof WebGPUBackend) {
      const imageData = await this.backend.readbackToImageData();
      // putImageData ist ein raw-write — überschreibt jeden Pixel,
      // ignoriert Transformationen und Blending. Genau richtig hier:
      // wir wollen 1:1 die Backend-Pixel im finalCanvas haben.
      this.ctx.putImageData(imageData, 0, 0);
    } else {
      const bitmap = this.backendCanvas.transferToImageBitmap();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.opts.width, this.opts.height);
      this.ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }

    // 3. Visualizer + Overlays auf den finalen 2D-Context.
    if (this.opts.visualizers && this.opts.visualizers.length > 0) {
      for (const v of this.opts.visualizers) {
        v.draw(this.ctx, t, this.opts.width, this.opts.height);
      }
    }
    if (this.opts.overlays.length > 0) {
      renderOverlays(
        this.ctx,
        this.opts.overlays,
        this.opts.width,
        this.opts.height,
        t,
        this.opts.energy ?? null,
      );
    }

    // 4. Snapshot finalCanvas → ImageBitmap → VideoFrame.
    //
    // **Critical**: `new VideoFrame(canvas)` may take a *reference*
    // (zero-copy) instead of a deep copy in some Chromium builds. The
    // encoder.pushFrame() consumes VideoFrames asynchronously — if the
    // canvas mutates between VideoFrame construction and encoder
    // consumption (i.e. the next composite() call writes new pixels),
    // the encoded N-th frame ends up holding the (N+1)-th content.
    // This was the user-reported "frames jumping back and forth"
    // bug in exports.
    //
    // ImageBitmap is spec-immutable; constructing VideoFrame from a
    // bitmap forces an independent snapshot regardless of internal
    // zero-copy strategy. transferToImageBitmap() also clears the
    // canvas, but we reset/clear it ourselves at the start of each
    // composite() call anyway, so that's a no-op for our use.
    const finalBitmap = this.canvas.transferToImageBitmap();
    return new VideoFrame(finalBitmap, {
      timestamp: timestampUs,
      duration: durationUs,
    });
  }

  destroy(): void {
    this.backend.dispose();
  }
}

/** Map a generic CanvasImageSource into the backend's LayerSource union. */
function classifySource(source: CanvasImageSource): LayerSource {
  if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
    return { kind: "videoframe", frame: source };
  }
  return { kind: "image", bitmap: source as ImageBitmap | HTMLImageElement };
}
