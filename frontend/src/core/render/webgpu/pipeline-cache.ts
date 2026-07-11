/**
 * Lazy-Compile-Cache für FX-RenderPipelines (WebGPU).
 *
 * Spiegelt `editor/fx/webgl2/program-cache.ts`: jeder FxKind hat ein
 * eigenes WGSL-Module + Uniform-Layout, das beim ersten `get(name)`
 * compiled und gecacht wird. `warmupAll()` compileliert alle
 * registrierten Specs eagerly damit der erste Frame keinen
 * Compile-Stall hat.
 *
 * Pro FX-Kind speichern wir ZWEI Pipelines (`pipelineOver` und
 * `pipelineReplace`), weil WebGPU den Blend-State in die Pipeline
 * baked. `setBlendMode("over"|"replace")` swappt nur welche aktiv ist.
 */

/** Pro-Field-Definition für ein FX-Uniform-Struct. Order = WGSL-Struct-
 *  Field-Order, woraus der Cache die std140-Byte-Offsets ableitet. */
export type UniformFieldType = "f1" | "f2" | "f4" | "i1";
export interface UniformFieldDef {
  name: string;
  type: UniformFieldType;
}

export interface FxWebGPUSpec {
  /** Catalog-Kind ("vignette", "rgb", "zoom" …). */
  name: string;
  /** Vollständiger WGSL-Quelltext (vs_main + fs_main). */
  wgsl: string;
  /** Uniform-Felder in Declaration-Order (matched die WGSL-Struct). */
  uniformFields: readonly UniformFieldDef[];
}

export interface FxUniformLayout {
  /** Gesamtgröße des Uniform-Buffers in Bytes (16-byte-padded). */
  byteSize: number;
  /** name → byte-offset + size (in floats). */
  fields: ReadonlyMap<
    string,
    { byteOffset: number; floats: number; type: UniformFieldType }
  >;
}

export interface FxPipelineEntry {
  pipelineOver: GPURenderPipeline;
  pipelineReplace: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniform: FxUniformLayout;
  /** Eigener Uniform-Buffer pro FX, wiederverwendet pro Frame. */
  uniformBuffer: GPUBuffer;
}

/** Berechnet std140-konforme Byte-Offsets aus einer Field-Liste.
 *  - f1/i1: align 4, size 4
 *  - f2:    align 8, size 8
 *  - f4:    align 16, size 16
 *  Final-struct-Größe wird auf 16 padded. */
export function computeUniformLayout(
  fields: readonly UniformFieldDef[],
): FxUniformLayout {
  const map = new Map<
    string,
    { byteOffset: number; floats: number; type: UniformFieldType }
  >();
  let off = 0;
  for (const f of fields) {
    const align = f.type === "f4" ? 16 : f.type === "f2" ? 8 : 4;
    off = Math.ceil(off / align) * align;
    const size = f.type === "f4" ? 16 : f.type === "f2" ? 8 : 4;
    const floats = size / 4;
    map.set(f.name, { byteOffset: off, floats, type: f.type });
    off += size;
  }
  const byteSize = Math.max(16, Math.ceil(off / 16) * 16);
  return { byteSize, fields: map };
}

const OVER_BLEND: GPUBlendState = {
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
};

export class WebGPUPipelineCache {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private specs: Map<string, FxWebGPUSpec> = new Map();
  private cache: Map<string, FxPipelineEntry> = new Map();

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    specs: ReadonlyArray<FxWebGPUSpec>,
  ) {
    this.device = device;
    this.format = format;
    for (const s of specs) this.specs.set(s.name, s);
  }

  /** Names of all registered FX shaders — exposed so callers can warm
   *  the cache eagerly. */
  registeredNames(): readonly string[] {
    return [...this.specs.keys()];
  }

  /** Get-or-compile. Throws on unknown name. */
  get(name: string): FxPipelineEntry {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const spec = this.specs.get(name);
    if (!spec) {
      throw new Error(`WebGPUPipelineCache: no spec registered for '${name}'`);
    }
    const entry = this.compile(spec);
    this.cache.set(name, entry);
    return entry;
  }

  /** Pre-compile all registered specs. Resolves once all are done. */
  warmupAll(): Promise<void> {
    for (const name of this.specs.keys()) {
      try {
        this.get(name);
      } catch (err) {
        console.warn(`[webgpu-pipeline-cache] warmup '${name}' failed:`, err);
      }
    }
    return Promise.resolve();
  }

  dispose(): void {
    for (const entry of this.cache.values()) {
      entry.uniformBuffer.destroy();
      // GPURenderPipeline / GPUBindGroupLayout: refcounted, freed with device.
    }
    this.cache.clear();
  }

  private compile(spec: FxWebGPUSpec): FxPipelineEntry {
    const device = this.device;
    const module = device.createShaderModule({
      label: `fx-${spec.name}`,
      code: spec.wgsl,
    });
    const bgl = device.createBindGroupLayout({
      label: `fx-${spec.name} BGL`,
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
    const layout = device.createPipelineLayout({
      label: `fx-${spec.name} PL`,
      bindGroupLayouts: [bgl],
    });
    const buildPipeline = (blend: GPUBlendState | undefined) =>
      device.createRenderPipeline({
        label: `fx-${spec.name} pipeline (${blend ? "over" : "replace"})`,
        layout,
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format: this.format, blend }],
        },
        primitive: { topology: "triangle-list" },
      });
    const pipelineOver = buildPipeline(OVER_BLEND);
    // "Replace" = no blending, FX shader fully owns the output.
    const pipelineReplace = buildPipeline(undefined);
    const uniform = computeUniformLayout(spec.uniformFields);
    const uniformBuffer = device.createBuffer({
      label: `fx-${spec.name} uniforms`,
      size: uniform.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return { pipelineOver, pipelineReplace, bindGroupLayout: bgl, uniform, uniformBuffer };
  }
}
