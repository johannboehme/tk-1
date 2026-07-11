/**
 * Implementation des `WebGPUDrawContext`-Interfaces (siehe
 * editor/fx/renderer-context.ts).
 *
 * Lifecycle pro FX:
 *   1. Backend ruft `beginFx(passEncoder, snapshotView)` auf, bindet
 *      so den aktuellen Render-Pass + Source-View an den Context.
 *   2. Catalog-Code (`fxCatalog[kind].drawWebGPU(ctx, ...)`) ruft
 *      `useProgram(name)` → reset Uniform-Scratch.
 *   3. `setUniform*(name, value)` → schreibt in Scratch an den vom
 *      Pipeline-Cache vorberechneten Byte-Offset.
 *   4. `bindSourceTexture()` → markiert dass diese FX die Source-Tex
 *      will (Bind-Group bekommt sie an binding=1).
 *   5. `setBlendMode("over"|"replace")` → wählt pipelineOver vs
 *      pipelineReplace beim nächsten `drawFullscreenQuad`.
 *   6. `drawFullscreenQuad()` → flush Uniform-Scratch ans GPU-Buffer,
 *      build Bind-Group, set Pipeline + Bind-Group, draw 3 verts.
 *
 * Snapshot-Tex ist immer gebunden (FX die sie nicht brauchen — wie
 * Vignette — ignorieren das einfach im Shader). Der `bindSourceTexture`-
 * Call ist Compat mit WebGL2-Convention; in WebGPU ist der Slot fest.
 */
import type {
  FxBlendMode,
  WebGPUDrawContext,
} from "../../fx/renderer-context";
import type { FxPipelineEntry, WebGPUPipelineCache } from "./pipeline-cache";

export class WebGPUDrawContextImpl implements WebGPUDrawContext {
  private device: GPUDevice;
  private cache: WebGPUPipelineCache;
  private sampler: GPUSampler;

  /** Aktive FX-Pipeline-Entry. Set durch `useProgram`. */
  private currentEntry: FxPipelineEntry | null = null;
  /** Float32Array-View auf das Scratch-ArrayBuffer; pro `useProgram`
   *  resized aufs uniform.byteSize. Index in Floats. */
  private currentScratch: Float32Array | null = null;
  /** Int32Array-View auf das gleiche Scratch — für `setUniform1i`. */
  private currentScratchI32: Int32Array | null = null;
  /** "over" oder "replace" — gewählt durch `setBlendMode`. Default
   *  "over". */
  private currentBlend: FxBlendMode = "over";

  /** Set durch beginFx — der aktive RenderPassEncoder + Source-View
   *  fürs Sampling. */
  private pass: GPURenderPassEncoder | null = null;
  private sourceView: GPUTextureView | null = null;

  constructor(device: GPUDevice, cache: WebGPUPipelineCache, sampler: GPUSampler) {
    this.device = device;
    this.cache = cache;
    this.sampler = sampler;
  }

  /** Bind den aktiven Pass + Snapshot-View. Vom Backend pro FX
   *  aufgerufen, BEVOR `fxCatalog[kind].drawWebGPU(ctx, ...)`. */
  beginFx(pass: GPURenderPassEncoder, sourceView: GPUTextureView): void {
    this.pass = pass;
    this.sourceView = sourceView;
    this.currentBlend = "over";  // backend resets between fx
  }

  /** End-of-FX. Cleart die Pass-Bindung damit Catalog-Calls nach
   *  `pass.end()` sauber failen. */
  endFx(): void {
    this.pass = null;
    this.sourceView = null;
    this.currentEntry = null;
    this.currentScratch = null;
    this.currentScratchI32 = null;
  }

  // ---- WebGPUDrawContext ----

  useProgram(name: string): void {
    const entry = this.cache.get(name);
    this.currentEntry = entry;
    // Frischer Scratch der zur Uniform-Größe dieser Pipeline passt.
    const buf = new ArrayBuffer(entry.uniform.byteSize);
    this.currentScratch = new Float32Array(buf);
    this.currentScratchI32 = new Int32Array(buf);
  }

  setUniform1f(name: string, value: number): void {
    this.assertEntry();
    const f = this.currentEntry!.uniform.fields.get(name);
    if (!f) return;
    this.currentScratch![f.byteOffset / 4] = value;
  }
  setUniform2f(name: string, a: number, b: number): void {
    this.assertEntry();
    const f = this.currentEntry!.uniform.fields.get(name);
    if (!f) return;
    const i = f.byteOffset / 4;
    this.currentScratch![i] = a;
    this.currentScratch![i + 1] = b;
  }
  setUniform4f(
    name: string,
    a: number,
    b: number,
    c: number,
    d: number,
  ): void {
    this.assertEntry();
    const f = this.currentEntry!.uniform.fields.get(name);
    if (!f) return;
    const i = f.byteOffset / 4;
    this.currentScratch![i] = a;
    this.currentScratch![i + 1] = b;
    this.currentScratch![i + 2] = c;
    this.currentScratch![i + 3] = d;
  }
  setUniform1i(name: string, value: number): void {
    this.assertEntry();
    const f = this.currentEntry!.uniform.fields.get(name);
    if (!f) return;
    this.currentScratchI32![f.byteOffset / 4] = value;
  }

  bindSourceTexture(_samplerName?: string): void {
    // No-op semantically: in WebGPU der binding-slot ist fest (1) und
    // die Source-View wird von beginFx gesetzt. Catalog-Code ruft das
    // trotzdem auf um Symmetrie mit WebGL2 zu wahren — wir notieren
    // damit die Intent, falls wir später optimieren wollen (z.B. eine
    // FX die source nicht braucht könnte einen leichteren Bind-Group
    // bekommen).
    void _samplerName;
  }

  setBlendMode(mode: FxBlendMode): void {
    this.currentBlend = mode;
  }

  drawFullscreenQuad(): void {
    const entry = this.currentEntry;
    const pass = this.pass;
    const sourceView = this.sourceView;
    const scratch = this.currentScratch;
    if (!entry || !pass || !sourceView || !scratch) return;

    // 1. Flush Uniforms → GPU-Buffer.
    this.device.queue.writeBuffer(
      entry.uniformBuffer,
      0,
      scratch.buffer,
      scratch.byteOffset,
      scratch.byteLength,
    );
    // 2. Bind-Group bauen (sampler + sourceView + uniformBuffer).
    const bg = this.device.createBindGroup({
      layout: entry.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: { buffer: entry.uniformBuffer } },
      ],
    });
    // 3. Pipeline-Variante wählen + binden.
    const pipeline =
      this.currentBlend === "over" ? entry.pipelineOver : entry.pipelineReplace;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    // 4. Fullscreen-Triangle (3 verts, ohne VBO).
    pass.draw(3);
  }

  private assertEntry(): void {
    if (!this.currentEntry || !this.currentScratch || !this.currentScratchI32) {
      throw new Error(
        "WebGPUDrawContextImpl: useProgram() not called before setUniform*",
      );
    }
  }
}
