/**
 * Backend-agnostic context types used by `FxDefinition.drawCanvas2D` and
 * `drawWebGL2`. Keeps the catalog independent of concrete renderer
 * classes — a definition can be unit-tested by passing a stub here.
 */
import type { PunchFx } from "./types";

/** Subset of CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D
 *  that we actually use in fx draws. Matches both real APIs. */
export type CanvasLikeContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** Wie der Shader auf das Source-Layer-Output (Canvas2D-Snapshot oder
 *  WebGL2-FBO-Texture) zugreift. Source-Sampling-Effekte wie RGB,
 *  ZOOM, UV, ECHO, TAPE setzen dies; reine Overlays (Vignette, Wash)
 *  ignorieren es. */
export type FxBlendMode = "over" | "replace";

/** Minimal API a WebGL2 fx draw needs. Hides program-cache + quad-VBO
 *  details from the catalog so unit-tests can stub it cheaply. */
export interface WebGL2DrawContext {
  /** Bind the program registered under `name` (compiled lazily). */
  useProgram(name: string): void;
  setUniform1i(name: string, value: number): void;
  setUniform1f(name: string, value: number): void;
  setUniform2f(name: string, a: number, b: number): void;
  setUniform4f(name: string, a: number, b: number, c: number, d: number): void;
  /** Bind the layer-pass output texture to the given texture unit and
   *  set `samplerName` (defaults to "u_source") to that unit. The unit
   *  is reserved by the backend for source sampling — implementations
   *  pick a fixed slot (typically 0). */
  bindSourceTexture(samplerName?: string): void;
  /** "over" = additive premultiplied (Vignette/Wash). "replace" =
   *  no blending, the FX shader fully owns the output (RGB-Split,
   *  ZOOM, ECHO, TAPE). Backend resets to "over" between fx. */
  setBlendMode(mode: FxBlendMode): void;
  /** Issue the fullscreen-quad draw call with the active program. */
  drawFullscreenQuad(): void;
}

/** WebGPU-Pendant zu WebGL2DrawContext. Bewahrt strukturparallele
 *  Catalog-Aufrufe (`useProgram` / `setUniform*` / `bindSourceTexture` /
 *  `setBlendMode` / `drawFullscreenQuad`) damit `drawWebGPU` 1:1 zu
 *  `drawWebGL2` aussieht — anderer Backend, gleiche FX-Logik.
 *
 *  Implementation lebt in `editor/render/webgpu/draw-context.ts` und
 *  managed:
 *   - GPURenderPipeline-Cache (pro FX-Kind, in 2 Blend-Varianten)
 *   - Scratch-Uniform-Buffer mit Per-Field-Offsets aus dem FX-Spec
 *   - SnapshotTex-Bindung (Pre-FX-Source) auf festem Texture-Binding
 *   - Bind-Group-Allocation pro `drawFullscreenQuad`
 *
 *  Lifecycle: Backend setzt die aktive Render-Pass + Snapshot-View
 *  über interne Methoden; Catalog-Code sieht nur die Public-API hier. */
export interface WebGPUDrawContext {
  /** Aktive FX-Pipeline binden (lazy-compiled durch den Cache). */
  useProgram(name: string): void;
  setUniform1i(name: string, value: number): void;
  setUniform1f(name: string, value: number): void;
  setUniform2f(name: string, a: number, b: number): void;
  setUniform4f(name: string, a: number, b: number, c: number, d: number): void;
  /** Source-Texture (= Pre-FX-Snapshot) ans Sampler-Slot binden. Der
   *  Backend reserviert die Slots (typischerweise binding=0 sampler,
   *  binding=1 source-tex, binding=2 uniforms). `samplerName` ist
   *  Compat-API mit WebGL2 — bei WebGPU informationell, weil das
   *  Layout-Slot fest ist. */
  bindSourceTexture(samplerName?: string): void;
  setBlendMode(mode: FxBlendMode): void;
  /** Flush Uniforms → GPU, set Bind-Group, draw 3 (fullscreen triangle). */
  drawFullscreenQuad(): void;
}

/** Shared helper for tests / debug logging — describes a fx call site. */
export function fxLogId(fx: PunchFx): string {
  return `${fx.kind}#${fx.id}`;
}
