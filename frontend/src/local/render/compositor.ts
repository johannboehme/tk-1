/**
 * Per-frame compositor for the edit-render pipeline.
 *
 * Pipeline per output frame:
 *   1. Layer + FX pass via the shared CompositorBackend
 *      (WebGPU → WebGL2 → Canvas2D fallback ladder, picked by
 *      `createBackend()` from `core/render/factory.ts`). The
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
import type { FilterSlot, PunchFx } from "../../core/fx/types";
import type { ViewportTransform } from "../../core/types";
import { activeFxAt } from "../../core/fx/active";
import { fxCatalog } from "../../core/fx/catalog";
import { INSTANT_ENVELOPE } from "../../core/fx/envelope";
import {
  computeIntensity,
  followerFor,
  legacyModulation,
  type AudioEnvelope,
} from "../../core/fx/modulation";
import type { GradeParams } from "../../core/fx/looks";
import {
  colorGradeFrameFx,
  filterFrameFx,
} from "../../core/render/build-descriptor";
import {
  createBackend,
  type BackendCapabilities,
} from "../../core/render/factory";
import type {
  CompositorBackend,
  LayerSource,
  SourcesMap,
} from "../../core/render/backend";
import { WebGPUBackend } from "../../core/render/webgpu-backend";
import {
  buildElementFitRect,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "../../core/render/element-transform";
import type {
  FrameDescriptor,
  FrameFx,
  FrameLayer,
} from "../../core/render/frame-descriptor";

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
  /** Real song tempo for beat-synced LFO modulation. null → no beat-sync. */
  bpm?: number | null;
  /** Master-time of beat 0 (grid anchor for beat-synced LFO). */
  beatPhaseS?: number;
  beatsPerBar?: number;
  /** Normalized master-loudness curve for sidechain modulation. */
  audioEnv?: AudioEnvelope | null;
  /** The single global color grade. Applied to every frame under everything,
   *  so the export matches the preview. */
  colorGrade?: GradeParams;
  /** The opinionated filter stack. Applied above the grade, under the
   *  punch-in accents, every frame. */
  filterSlots?: readonly FilterSlot[];
}

// Per-element placement is shared with the live preview via
// `buildElementFitRect` from `core/render/element-transform.ts` —
// don't reintroduce a local letterbox helper here. The two pipelines
// MUST stay byte-identical on placement.

/**
 * The two SEMANTIC time axes of a composited frame. `timestampUs` (the
 * output-relative muxer timestamp, restarts at 0) is deliberately NOT
 * part of this struct — it is a container detail and must never be used
 * for FX / modulation / visualizer lookups. Both fields are required so
 * a segments-style caller can't silently fall back to output time (the
 * bug class that shipped once: every punch-in FX vanished from exports).
 *
 * Mirrors the live preview's `buildFrameDescriptor(tMaster, tTimeline)`
 * split (editor/render/build-descriptor.ts).
 */
export interface FrameTimes {
  /** Timeline-time (arrangement/song axis, seconds). FX in/out windows
   *  and the region-local ADSR envelope live here. In direct mode this
   *  equals master-time. */
  tTimelineS: number;
  /** Master-audio time (seconds) of the audio audible at this output
   *  frame. The beat grid (`beatPhaseS`), the sidechain loudness curve
   *  (`audioEnv`), visualizer PCM/energy and overlay windows are all
   *  anchored here. */
  tMasterS: number;
}

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

  /** Which backend tier the factory picked ("webgpu" | "webgl2" | "canvas2d"). */
  get backendId(): string {
    return this.backend.id;
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

  /**
   * Composite one output frame.
   *
   * `timestampUs` is the OUTPUT-relative muxer timestamp (restarts at 0,
   * concatenated across segments) — used only to stamp the returned
   * VideoFrame. All FX / modulation lookups read from `times`, the
   * explicit semantic time axes: `times.tTimelineS` for FX windows +
   * envelopes, `times.tMasterS` for the beat grid + sidechain follower
   * + visualizers + overlays. `times` is REQUIRED: an earlier optional
   * variant silently fell back to `timestampUs / 1e6`, which made every
   * punch-in FX vanish from segment exports.
   *
   * Returns a fresh VideoFrame the caller MUST `.close()` after encoding.
   */
  async compositeImage(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    timestampUs: number,
    durationUs: number,
    times: FrameTimes,
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

    // The two semantic axes — see FrameTimes. FX in/out windows live in
    // timeline-time (e.g. fx.inS = 13.43s on the song axis); beat grid +
    // sidechain loudness live in master-audio time. `timestampUs` is
    // output-relative and never valid for either lookup.
    const tTimeline = times.tTimelineS;
    const tMaster = times.tMasterS;

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

    // Uniform engine, same as the live preview's buildFx (build-
    // descriptor.ts): global grade + opinionated filters first (the
    // "film stock"), then punch-in accents on top. Active-FX lookup and
    // the envelope run on the timeline axis; beat-sync + sidechain run
    // on the master axis — identical to the preview, so modulated FX
    // land on the audible beat in every export.
    const bpm = this.opts.bpm ?? null;
    const beatPhaseS = this.opts.beatPhaseS ?? 0;
    const beatsPerBar = this.opts.beatsPerBar ?? 4;
    const audioEnv = this.opts.audioEnv ?? null;
    const punchFx: FrameFx[] = this.opts.fx
      ? activeFxAt(this.opts.fx, tTimeline)
          .map((fx) => {
            const def = fxCatalog[fx.kind];
            const env = fx.modulation?.envelope ?? fx.envelope ?? INSTANT_ENVELOPE;
            const mod = fx.modulation ?? legacyModulation(env);
            const sidechainCurve =
              mod.timeMod === "sidechain" ? followerFor(audioEnv, mod.side) : null;
            const { level, phase } = computeIntensity(mod, {
              tMasterS: tMaster,
              tTimelineS: tTimeline,
              regionInS: fx.inS,
              regionDurS: fx.outS - fx.inS,
              holding: false,
              bpm,
              beatPhaseS,
              beatsPerBar,
              sidechainCurve,
            });
            const merged = { ...def.defaultParams, ...(fx.params ?? {}) };
            const params =
              def.applyWetness && level < 1
                ? def.applyWetness(merged, level)
                : merged;
            return { id: fx.id, kind: fx.kind, inS: fx.inS, params, wetness: level, phase };
          })
          .filter((f) => f.wetness > 0)
      : [];
    const fxFrame: FrameFx[] = [
      ...colorGradeFrameFx(this.opts.colorGrade),
      ...filterFrameFx(this.opts.filterSlots),
      ...punchFx,
    ];

    const descriptor: FrameDescriptor = {
      tMaster,
      output: { w: this.opts.width, h: this.opts.height },
      layers: [layer],
      fx: fxFrame,
    };

    // Canvas sources must be snapshotted into an ImageBitmap before the
    // backend upload: the WebGL2 backend relies on UNPACK_FLIP_Y_WEBGL
    // for `kind: "image"` sources, which ImageBitmap honours but
    // Chrome's GPU fast path for canvas uploads IGNORES — a raw
    // OffscreenCanvas source (the NO-SIGNAL test pattern) rendered
    // vertically flipped in WebGL2 exports (issue #141). Hot callers
    // should hand in an ImageBitmap themselves (see
    // makeTestPatternBitmap) — this per-frame snapshot is the safety
    // net for arbitrary canvas sources.
    let canvasSnapshot: ImageBitmap | null = null;
    const isCanvasSource =
      (typeof OffscreenCanvas !== "undefined" &&
        source instanceof OffscreenCanvas) ||
      (typeof HTMLCanvasElement !== "undefined" &&
        source instanceof HTMLCanvasElement);
    if (isCanvasSource) {
      canvasSnapshot = await createImageBitmap(
        source as OffscreenCanvas | HTMLCanvasElement,
      );
    }
    const sources: SourcesMap = new Map<string, LayerSource>([
      ["src", classifySource(canvasSnapshot ?? source)],
    ]);

    // 1. Backend rendert Layer + FX in den internen backendCanvas
    //    (oder, im WebGPU-Fall, in den internen renderTarget).
    this.backend.drawFrame(descriptor, sources);
    // drawFrame has uploaded the pixels; the snapshot is no longer
    // needed.
    canvasSnapshot?.close();

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

    // 3. Visualizer + Overlays auf den finalen 2D-Context — beide auf
    // der MASTER-Achse. Visualizer besitzen PCM/Energy aus dem VOLLEN
    // Master-Audio (jobs.ts decodiert untrimmed), Overlays werden im
    // Editor an `playback.currentTime` (= Master-Zeit) geankert. Mit dem
    // output-relativen Timestamp zeigte jeder Long-form-Export den
    // falschen Song-Abschnitt (z.B. die Waveform des gedroppten Intros
    // unter dem hörbaren Chorus) — issue #106.
    if (this.opts.visualizers && this.opts.visualizers.length > 0) {
      for (const v of this.opts.visualizers) {
        v.draw(this.ctx, tMaster, this.opts.width, this.opts.height);
      }
    }
    if (this.opts.overlays.length > 0) {
      renderOverlays(
        this.ctx,
        this.opts.overlays,
        this.opts.width,
        this.opts.height,
        tMaster,
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
