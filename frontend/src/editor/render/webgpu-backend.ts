/**
 * WebGPU compositor backend.
 *
 * Phase 1: Layer-Pass + Present-Blit. Keine FX-Loop noch — die kommt
 * in Phase 2, wenn der Pipeline-Cache + DrawContext steht. Das
 * `renderTarget` und `snapshotTex` sind aber bereits allokiert, damit
 * Phase 2 nur die FX-Loop hinzufügt ohne die Init-Logik zu berühren.
 *
 * Render-Target-Architektur (siehe Plan):
 *   1. Layer-Pass: render in `renderTarget` (offscreen `bgra8unorm`),
 *      load=clear, blend "over"
 *   2. (Phase 2) FX-Loop: per FX `copyTextureToTexture(renderTarget →
 *      snapshotTex)`, dann load=load FX-Pass auf `renderTarget`
 *   3. Present: `copyTextureToTexture(renderTarget →
 *      context.getCurrentTexture())`
 *
 * Source-Import: in Phase 1 alle Source-Kinds via
 * `queue.copyExternalImageToTexture` (akzeptiert ImageBitmap,
 * HTMLVideoElement, VideoFrame). `importExternalTexture` als
 * Zero-Copy-Optimierung für Video ist ein Phase-2/3-Follow-up.
 */
import { fxCatalog } from "../fx/catalog";
import { FX_WEBGPU_SPECS } from "../fx/webgpu/registry";
import type { PunchFx } from "../fx/types";
import { uvMatrixCM } from "./webgl2-backend";
import {
  LAYER_BLIT_WGSL,
  LAYER_UNIFORM_SIZE,
  writeLayerUniforms,
} from "./webgpu/layer-blit.wgsl";
import { WebGPUDrawContextImpl } from "./webgpu/draw-context";
import { WebGPUPipelineCache } from "./webgpu/pipeline-cache";
import type {
  BackendCaps,
  CompositorBackend,
  LayerSource,
  SourcesMap,
} from "./backend";
import { BackendError } from "./backend";
import type { FrameDescriptor } from "./frame-descriptor";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Canvas-Format that we render to. `bgra8unorm` is the W3C-recommended
 *  preferred canvas format on all platforms; `getPreferredCanvasFormat()`
 *  returns this on Windows/Mac/Linux. We pin to it explicitly so the
 *  internal `renderTarget` and `snapshotTex` formats line up with the
 *  canvas without renegotiation. */
const CANVAS_FORMAT: GPUTextureFormat = "bgra8unorm";

export class WebGPUBackend implements CompositorBackend {
  readonly id = "webgpu" as const;

  private canvas: AnyCanvas | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private caps: BackendCaps = { pixelW: 1, pixelH: 1 };

  /** Offscreen-Texture die Layer + (später) FX-Passes treffen.
   *  Wird am Frame-Ende per `copyTextureToTexture` ins Canvas geblittet. */
  private renderTarget: GPUTexture | null = null;
  /** Spiegel von `renderTarget` für die Pre-FX-Snapshots in Phase 2. */
  private snapshotTex: GPUTexture | null = null;

  private layerPipeline: GPURenderPipeline | null = null;
  private layerBindGroupLayout: GPUBindGroupLayout | null = null;
  private layerSampler: GPUSampler | null = null;
  /** Wiederverwendete Layer-Source-Texture, lazy-resized auf das aktuelle
   *  Source-Pixel-Format. Mirrors WebGL2's `layerTexture` Mapping. */
  private layerTex: GPUTexture | null = null;
  private layerTexW = 0;
  private layerTexH = 0;
  private layerUniformBuffer: GPUBuffer | null = null;
  /** Scratch-Float32Array für die Uniform-Writes. Wiederverwendet pro Frame. */
  private layerUniformScratch = new Float32Array(LAYER_UNIFORM_SIZE / 4);

  /** FX-Pipeline-Cache + DrawContext (Phase 2+). */
  private fxPipelineCache: WebGPUPipelineCache | null = null;
  private fxDrawContext: WebGPUDrawContextImpl | null = null;
  /** Sampler shared zwischen layer-pass und FX-pass. */
  private fxSampler: GPUSampler | null = null;

  /** Reused readback resources — allokier einmal pro (w,h)-config, nicht
   *  pro Frame. Das war der dominante hot-path-overhead beim Export
   *  (33 MB allocation + 33 MB deallocation pro 4K-Frame).
   *  `Uint8ClampedArray<ArrayBuffer>` (nicht …<ArrayBufferLike>) damit
   *  der ImageData-Konstruktor in strict-TS direkt akzeptiert. */
  private readbackBuffer: GPUBuffer | null = null;
  private readbackBytesPerRow = 0;
  private readbackRowCount = 0;
  private readbackRgba: Uint8ClampedArray<ArrayBuffer> | null = null;



  async init(canvas: AnyCanvas, caps: BackendCaps): Promise<void> {
    this.canvas = canvas;
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new BackendError("init", "WebGPUBackend: navigator.gpu missing");
    }
    const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
    let adapter: GPUAdapter | null;
    try {
      adapter = await gpu.requestAdapter();
    } catch (err) {
      throw new BackendError(
        "init",
        `WebGPUBackend: requestAdapter threw: ${String(err)}`,
      );
    }
    if (!adapter) {
      throw new BackendError(
        "init",
        "WebGPUBackend: requestAdapter returned null (no compatible adapter)",
      );
    }
    let device: GPUDevice;
    try {
      device = await adapter.requestDevice();
    } catch (err) {
      throw new BackendError(
        "init",
        `WebGPUBackend: requestDevice threw: ${String(err)}`,
      );
    }
    this.device = device;

    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) {
      throw new BackendError(
        "init",
        "WebGPUBackend: getContext('webgpu') returned null",
      );
    }
    this.context = context;
    context.configure({
      device,
      format: CANVAS_FORMAT,
      alphaMode: "premultiplied",
      // CANVAS_TEXTURE_BINDING wäre nötig, wenn wir den Canvas direkt
      // sampeln wollten — wir blitten aber per copyTextureToTexture vom
      // renderTarget ins Canvas, brauchen also nur COPY_DST + Default
      // RENDER_ATTACHMENT.
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    try {
      this.setupLayerPipeline(device);
      // Shared FX-Sampler (linear, clamp).
      this.fxSampler = device.createSampler({
        label: "fx-sampler",
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
      this.fxPipelineCache = new WebGPUPipelineCache(
        device,
        CANVAS_FORMAT,
        FX_WEBGPU_SPECS,
      );
      this.fxDrawContext = new WebGPUDrawContextImpl(
        device,
        this.fxPipelineCache,
        this.fxSampler,
      );
    } catch (err) {
      this.dispose();
      if (err instanceof BackendError) throw err;
      throw new BackendError(
        "compile",
        `WebGPUBackend layer-pipeline setup failed: ${String(err)}`,
      );
    }

    this.resize(caps);
  }

  resize(caps: BackendCaps): void {
    this.caps = caps;
    if (!this.canvas || !this.device) return;
    const w = Math.max(1, Math.round(caps.pixelW));
    const h = Math.max(1, Math.round(caps.pixelH));
    this.canvas.width = w;
    this.canvas.height = h;
    // Container drives CSS sizing — same reasoning as Canvas2DBackend.

    // Recreate offscreen-Targets bei Größenwechsel.
    if (this.renderTarget) {
      this.renderTarget.destroy();
      this.renderTarget = null;
    }
    if (this.snapshotTex) {
      this.snapshotTex.destroy();
      this.snapshotTex = null;
    }
    this.renderTarget = this.device.createTexture({
      label: "webgpu-backend renderTarget",
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: CANVAS_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    this.snapshotTex = this.device.createTexture({
      label: "webgpu-backend snapshotTex",
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: CANVAS_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Invalidate cached readback resources — sized to old dims.
    if (this.readbackBuffer) {
      this.readbackBuffer.destroy();
      this.readbackBuffer = null;
    }
    this.readbackBytesPerRow = 0;
    this.readbackRowCount = 0;
    this.readbackRgba = null;
  }

  async warmup(): Promise<void> {
    if (this.fxPipelineCache) await this.fxPipelineCache.warmupAll();
  }

  drawFrame(d: FrameDescriptor, sources: SourcesMap): void {
    const device = this.device;
    const context = this.context;
    const renderTarget = this.renderTarget;
    const pipeline = this.layerPipeline;
    const layerBindGroupLayout = this.layerBindGroupLayout;
    const layerSampler = this.layerSampler;
    const layerUniformBuffer = this.layerUniformBuffer;
    if (
      !device ||
      !context ||
      !renderTarget ||
      !pipeline ||
      !layerBindGroupLayout ||
      !layerSampler ||
      !layerUniformBuffer
    ) {
      return;
    }

    const encoder = device.createCommandEncoder({ label: "webgpu drawFrame" });

    // Clear the renderTarget. Output==null → transparent clear (matches
    // canvas2d/webgl2 behaviour: nothing renderable yet, leave the canvas
    // empty for the surrounding page background to show through).
    const clearAlpha = d.output ? 1 : 0;
    const layerPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderTarget.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: clearAlpha },
        },
      ],
    });

    if (d.output) {
      layerPass.setPipeline(pipeline);
      for (const layer of d.layers) {
        if (layer.weight <= 0) continue;
        const src = sources.get(layer.layerId);
        if (!src || src.kind === "test-pattern") continue;
        const upload = this.uploadSource(device, src);
        if (!upload) continue;

        // Empirically verified via `webgpu-backend-video-flip.browser.test.ts`:
        // both `createImageBitmap(<video>)` AND `createImageBitmap(<canvas>)`
        // produce top-down bitmaps in Chrome (DOM convention). Uploading
        // with `flipY: false` preserves orientation; sampling with
        // `srcFlipY=false` reads correctly. No video-specific flip is
        // needed here — the WebGL2 backend's flip is a workaround for
        // GL's flipped Y-axis convention, not for any video-decoder
        // bottom-up storage. We're DOM-convention top-to-bottom on the
        // WebGPU side and stay that way.
        writeLayerUniforms(
          this.layerUniformScratch,
          d.output.w,
          d.output.h,
          layer.fitRect,
          uvMatrixCM(layer),
          false,
        );
        device.queue.writeBuffer(
          layerUniformBuffer,
          0,
          this.layerUniformScratch.buffer,
          this.layerUniformScratch.byteOffset,
          this.layerUniformScratch.byteLength,
        );

        const bindGroup = device.createBindGroup({
          layout: layerBindGroupLayout,
          entries: [
            { binding: 0, resource: layerSampler },
            { binding: 1, resource: upload.createView() },
            { binding: 2, resource: { buffer: layerUniformBuffer } },
          ],
        });
        layerPass.setBindGroup(0, bindGroup);
        layerPass.draw(4);
      }
    }
    layerPass.end();

    // FX-Loop. Wir nehmen vor JEDEM FX einen frischen Snapshot vom
    // renderTarget — so sehen replace-FX (RGB, ZOOM, ECHO, TAPE, WEAR)
    // den kumulativen Stand inkl. aller bisherigen FX in diesem Frame,
    // nicht nur den bare Layer-Pass. Mirrors WebGL2's
    // copyBackbufferToSourceTex-Pattern, hier per
    // copyTextureToTexture (cheaper than CPU readback).
    const drawCtx = this.fxDrawContext;
    const snapshotTex = this.snapshotTex;
    if (
      d.output &&
      d.fx.length > 0 &&
      drawCtx &&
      snapshotTex
    ) {
      const w = d.output.w;
      const h = d.output.h;
      for (const fx of d.fx) {
        const def = fxCatalog[fx.kind];
        if (!def) continue;
        // Snapshot des aktuellen renderTarget-Inhalts (= layer-pass +
        // alle vorherigen FX dieses Frames).
        encoder.copyTextureToTexture(
          { texture: renderTarget },
          { texture: snapshotTex },
          {
            width: this.caps.pixelW,
            height: this.caps.pixelH,
            depthOrArrayLayers: 1,
          },
        );
        const fxPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: renderTarget.createView(),
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        drawCtx.beginFx(fxPass, snapshotTex.createView());
        const punch: PunchFx = {
          id: fx.id,
          kind: fx.kind,
          inS: fx.inS,
          outS: 0,
          params: fx.params,
        };
        // Catalog-Code ruft setBlendMode("over"|"replace"); der
        // DrawContext startet jeden FX standardmäßig auf "over"
        // (durch beginFx).
        def.drawWebGPU(drawCtx, punch, w, h, d.tMaster);
        drawCtx.endFx();
        fxPass.end();
      }
    }

    // Present: renderTarget → context.getCurrentTexture()
    encoder.copyTextureToTexture(
      { texture: renderTarget },
      { texture: context.getCurrentTexture() },
      {
        width: this.caps.pixelW,
        height: this.caps.pixelH,
        depthOrArrayLayers: 1,
      },
    );

    device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    if (this.fxPipelineCache) this.fxPipelineCache.dispose();
    if (this.renderTarget) this.renderTarget.destroy();
    if (this.snapshotTex) this.snapshotTex.destroy();
    if (this.layerTex) this.layerTex.destroy();
    if (this.layerUniformBuffer) this.layerUniformBuffer.destroy();
    if (this.readbackBuffer) this.readbackBuffer.destroy();
    this.readbackBuffer = null;
    this.readbackRgba = null;
    // Pipelines / shader modules / samplers: no explicit destroy in the
    // WebGPU API — refcounted and freed when GPUDevice goes out of scope.
    if (this.device) this.device.destroy();
    this.canvas = null;
    this.device = null;
    this.context = null;
    this.renderTarget = null;
    this.snapshotTex = null;
    this.layerPipeline = null;
    this.layerBindGroupLayout = null;
    this.layerSampler = null;
    this.layerTex = null;
    this.layerTexW = 0;
    this.layerTexH = 0;
    this.layerUniformBuffer = null;
    this.fxPipelineCache = null;
    this.fxDrawContext = null;
    this.fxSampler = null;
  }

  /**
   * Liest den vollen renderTarget aus und gibt ihn als ImageData
   * zurück. Bypassed die Canvas-Swap-Chain komplett — das ist der
   * Compositor-Pfad für den Export, weil WebGPU's
   * `context.getCurrentTexture()` + `transferToImageBitmap()` im sync
   * Decoder→Encoder-Loop double-buffered chaos produzieren kann
   * (alternierende Frames aus zwei Swap-Slots → "frames hin und her
   * springen").
   *
   * Implementation:
   *   - Buffer + RGBA-Output-Array werden über Frames hinweg gecached
   *     (gerendert pro size-change in resize()). Spart 33 MB
   *     allocate/free pro 4K-Frame.
   *   - BGRA → RGBA Swap via Uint32-View statt per-Byte: 4× weniger
   *     Schleifen-Iterationen, gleicher Output.
   *   - Zero-copy aus dem mapped GPU buffer — kein .slice() copy.
   *
   * `caller MUST consume the returned ImageData synchronously` — die
   * underlying RGBA-Bytes werden für den nächsten readback wieder
   * überschrieben. putImageData() im Compositor passt dazu.
   */
  async readbackToImageData(): Promise<ImageData> {
    const device = this.device;
    const renderTarget = this.renderTarget;
    if (!device || !renderTarget) {
      throw new Error(
        "WebGPUBackend.readbackToImageData: backend not initialised",
      );
    }
    const w = this.caps.pixelW;
    const h = this.caps.pixelH;
    const bytesPerRowUnaligned = w * 4;
    const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256;

    // Reuse cached buffer + rgba array if dims unchanged (steady state
    // of the export loop). Allocation/free per frame is the dominant
    // overhead at 4K — caching lifts that out of the hot path.
    if (
      !this.readbackBuffer ||
      this.readbackBytesPerRow !== bytesPerRow ||
      this.readbackRowCount !== h
    ) {
      if (this.readbackBuffer) this.readbackBuffer.destroy();
      this.readbackBuffer = device.createBuffer({
        label: "webgpu readback (cached)",
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.readbackBytesPerRow = bytesPerRow;
      this.readbackRowCount = h;
      this.readbackRgba = null;
    }
    if (!this.readbackRgba || this.readbackRgba.length !== w * h * 4) {
      // Explicit ArrayBuffer (vs. default ArrayBufferLike) so the
      // resulting Uint8ClampedArray satisfies ImageData's constructor
      // signature in strict TS — without this, ImageDataArray's
      // generic mismatch fires.
      const buf = new ArrayBuffer(w * h * 4);
      this.readbackRgba = new Uint8ClampedArray(buf) as Uint8ClampedArray<ArrayBuffer>;
    }

    const buffer = this.readbackBuffer;
    const rgba = this.readbackRgba;
    const encoder = device.createCommandEncoder({ label: "readback" });
    encoder.copyTextureToBuffer(
      { texture: renderTarget },
      { buffer, bytesPerRow, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    // Direct view into the mapped GPU range — valid only until unmap().
    const padded = new Uint8Array(buffer.getMappedRange());

    // BGRA (renderTarget format) → RGBA (ImageData format) via Uint32
    // swap — little-endian CPU reads bytes [B,G,R,A] as uint32
    // 0xAARRGGBB; we want bytes [R,G,B,A] = uint32 0xAABBGGRR. Swap
    // R↔B (bits 0..7 ↔ 16..23), keep G + A in place. 4× fewer loop
    // iterations than the per-byte approach.
    const noPadding = bytesPerRow === w * 4;
    if (noPadding) {
      const src32 = new Uint32Array(padded.buffer, padded.byteOffset, w * h);
      const dst32 = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
      for (let i = 0; i < src32.length; i++) {
        const x = src32[i];
        dst32[i] =
          (x & 0xff00ff00) |
          ((x & 0x00ff0000) >>> 16) |
          ((x & 0x000000ff) << 16);
      }
    } else {
      // Padded rows — process row-by-row, each row densely.
      for (let row = 0; row < h; row++) {
        const src32 = new Uint32Array(
          padded.buffer,
          padded.byteOffset + row * bytesPerRow,
          w,
        );
        const dst32 = new Uint32Array(
          rgba.buffer,
          rgba.byteOffset + row * w * 4,
          w,
        );
        for (let col = 0; col < w; col++) {
          const x = src32[col];
          dst32[col] =
            (x & 0xff00ff00) |
            ((x & 0x00ff0000) >>> 16) |
            ((x & 0x000000ff) << 16);
        }
      }
    }

    buffer.unmap();
    return new ImageData(rgba, w, h);
  }

  /** Convenience-Wrapper für Pixel-Tests / Settings-Probes. Im
   *  Compositor selber benutzen wir `readbackToImageData()` direkt mit
   *  `putImageData()` — das spart den createImageBitmap-Roundtrip. */
  async readbackToImageBitmap(): Promise<ImageBitmap> {
    const data = await this.readbackToImageData();
    return await createImageBitmap(data);
  }

  /** Test-only readback. Liest `[w*h]` RGBA-pixel aus dem renderTarget
   *  beim Punkt `(x, y)` (canvas-Y-down). Returns Uint8Array(w*h*4) im
   *  RGBA-Format (auch wenn das Texture-Format BGRA ist — wir swappen
   *  hier am Ende in den korrekten Channel-Order, damit Tests
   *  Backend-agnostisch sind). */
  async readbackForTest(
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<Uint8Array> {
    const device = this.device;
    const renderTarget = this.renderTarget;
    if (!device || !renderTarget) {
      throw new Error("WebGPUBackend.readbackForTest: backend not initialised");
    }
    // bytesPerRow muss auf 256 gepaddet sein (WebGPU-Constraint).
    const bytesPerPixel = 4;
    const bytesPerRowUnaligned = w * bytesPerPixel;
    const bytesPerRow = Math.ceil(bytesPerRowUnaligned / 256) * 256;
    const buffer = device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({ label: "readbackForTest" });
    encoder.copyTextureToBuffer(
      { texture: renderTarget, origin: { x, y, z: 0 } },
      { buffer, bytesPerRow, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    // Strip row padding und swap BGRA → RGBA (renderTarget is bgra8unorm).
    const out = new Uint8Array(w * h * bytesPerPixel);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const srcOff = row * bytesPerRow + col * 4;
        const dstOff = row * w * 4 + col * 4;
        out[dstOff + 0] = padded[srcOff + 2]; // R ← B
        out[dstOff + 1] = padded[srcOff + 1]; // G ← G
        out[dstOff + 2] = padded[srcOff + 0]; // B ← R
        out[dstOff + 3] = padded[srcOff + 3]; // A
      }
    }
    return out;
  }

  // ---- internals ----

  private setupLayerPipeline(device: GPUDevice): void {
    const module = device.createShaderModule({
      label: "layer-blit",
      code: LAYER_BLIT_WGSL,
    });
    const bgl = device.createBindGroupLayout({
      label: "layer-blit BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.layerBindGroupLayout = bgl;
    const layout = device.createPipelineLayout({
      label: "layer-blit PL",
      bindGroupLayouts: [bgl],
    });
    this.layerPipeline = device.createRenderPipeline({
      label: "layer-blit pipeline",
      layout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format: CANVAS_FORMAT,
            // "Over"-Blend (premultiplied): matched WebGL2-Backend's
            // gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA). For opaque sources
            // this is identical to "replace".
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
    });
    this.layerSampler = device.createSampler({
      label: "layer-blit sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.layerUniformBuffer = device.createBuffer({
      label: "layer-blit uniforms",
      size: LAYER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Lädt die Source-Pixel in `this.layerTex` und gibt das Texture
   *  zurück; null wenn die Source noch nicht ready ist.
   *
   *  Live `<video>` sources are NEVER passed in here — the runtime's
   *  `buildSourcesMap` resolves them to a freshly captured
   *  `ImageBitmap` (refreshed via `requestVideoFrameCallback` against
   *  the underlying element). That keeps Chrome's
   *  `copyExternalImageToTexture(<video>)` orientation bug out of the
   *  hot path entirely — the bitmap path is reliably correct because
   *  `createImageBitmap` always honours the source's display matrix. */
  private uploadSource(
    device: GPUDevice,
    src: LayerSource,
  ): GPUTexture | null {
    let imageSource: VideoFrame | ImageBitmap | HTMLImageElement;
    let srcW: number;
    let srcH: number;
    switch (src.kind) {
      case "image":
        imageSource = src.bitmap;
        if (src.bitmap instanceof HTMLImageElement) {
          srcW = src.bitmap.naturalWidth;
          srcH = src.bitmap.naturalHeight;
        } else {
          srcW = src.bitmap.width;
          srcH = src.bitmap.height;
        }
        break;
      case "video":
        // The runtime always supplies a fallback bitmap for video and
        // sets `preferFallback`; the live element is kept around for
        // metadata but never sampled by the GPU here. If no bitmap
        // exists yet (cold start, before the first rVFC has fired),
        // skip — the next tick will have one.
        if (!src.fallback) return null;
        imageSource = src.fallback;
        srcW = src.fallback.width || 1;
        srcH = src.fallback.height || 1;
        break;
      case "videoframe":
        imageSource = src.frame;
        srcW = src.frame.displayWidth;
        srcH = src.frame.displayHeight;
        break;
      case "test-pattern":
        return null;
    }

    if (
      !this.layerTex ||
      this.layerTexW !== srcW ||
      this.layerTexH !== srcH
    ) {
      if (this.layerTex) this.layerTex.destroy();
      this.layerTex = device.createTexture({
        label: "webgpu-backend layerTex",
        size: { width: srcW, height: srcH, depthOrArrayLayers: 1 },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.layerTexW = srcW;
      this.layerTexH = srcH;
    }

    device.queue.copyExternalImageToTexture(
      { source: imageSource, flipY: false },
      { texture: this.layerTex },
      { width: srcW, height: srcH, depthOrArrayLayers: 1 },
    );
    return this.layerTex;
  }
}
