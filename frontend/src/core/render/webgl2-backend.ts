/**
 * WebGL2 compositor backend.
 *
 * Drives the live preview when WebGL2 is available. Layers are sampled
 * as 2D textures (uploaded fresh per RAF tick), composed into the
 * backbuffer with rotation/flip/letterbox parity to Canvas2DBackend
 * (and therefore parity to today's `compositor.ts`), then FX kinds
 * paint as additive fullscreen-quad passes via the existing
 * `editor/fx/webgl2/` infrastructure.
 *
 * Why use the existing webgl2/ helpers:
 *   - `program-cache.ts` provides lazy compile + uniform-loc caching +
 *     warmup. Cold-start numbers carry over without re-instrumentation.
 *   - `quad.ts` provides a fullscreen-quad VAO with `a_position` at
 *     attribute 0. We drive both the layer-blit pass and the FX passes
 *     off the same quad — one VBO bind per frame, not per pass.
 */
import { fxCatalog } from "../fx/catalog";
import type { WebGL2DrawContext } from "../fx/renderer-context";
import type { PunchFx } from "../fx/types";
import {
  ProgramCache,
  REGISTERED_FRAGMENTS,
  type CachedProgram,
} from "../fx/webgl2/program-cache";
import { makeFullscreenQuad } from "../fx/webgl2/quad";
import type {
  BackendCaps,
  CompositorBackend,
  LayerSource,
  SourcesMap,
} from "./backend";
import { BackendError } from "./backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Vertex shader for the layer-blit pass. Drives `gl_Position` from the
 *  layer's `fitRect` in output-pixel coords, and computes `v_uv` by
 *  applying `u_uvMat` (rotation+flip) to the standard quad uv around
 *  centre. Y is inverted on output so canvas-Y-down matches GL-Y-up.
 *  `u_srcFlipY` is a per-source compensation: 1 → flip the texture's
 *  Y axis at sample time. Used to work around Chrome's hardware video
 *  upload path silently ignoring UNPACK_FLIP_Y_WEBGL — set to 1 for
 *  HTMLVideoElement / VideoFrame sources, 0 for ImageBitmap. */
const LAYER_VERT = `#version 300 es
in vec2 a_position;
uniform vec2 u_output;
uniform vec4 u_destRect;
uniform mat2 u_uvMat;
uniform float u_srcFlipY;
out vec2 v_uv;
void main() {
  vec2 quadUv = a_position * 0.5 + 0.5;
  vec2 destPos = u_destRect.xy + u_destRect.zw * quadUv;
  vec2 clip = vec2(
    destPos.x / u_output.x * 2.0 - 1.0,
    1.0 - destPos.y / u_output.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vec2 srcUv = u_uvMat * (quadUv - 0.5) + 0.5;
  v_uv = vec2(srcUv.x, mix(srcUv.y, 1.0 - srcUv.y, u_srcFlipY));
}
`;

/** Fragment passthrough. Source is uploaded with UNPACK_FLIP_Y so v=0
 *  is the top of the image — matches Canvas2D convention. */
const LAYER_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
  fragColor = texture(u_tex, v_uv);
}
`;

export class WebGL2Backend implements CompositorBackend {
  readonly id = "webgl2" as const;

  private canvas: AnyCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private programs: ProgramCache | null = null;
  private quad: ReturnType<typeof makeFullscreenQuad> | null = null;
  private layerProgram: WebGLProgram | null = null;
  private layerTexture: WebGLTexture | null = null;
  private layerLocs: {
    output: WebGLUniformLocation | null;
    destRect: WebGLUniformLocation | null;
    uvMat: WebGLUniformLocation | null;
    tex: WebGLUniformLocation | null;
    srcFlipY: WebGLUniformLocation | null;
  } = { output: null, destRect: null, uvMat: null, tex: null, srcFlipY: null };
  private currentProgram: CachedProgram | null = null;
  private caps: BackendCaps = { pixelW: 1, pixelH: 1 };
  private drawCtx: WebGL2DrawContext | null = null;
  /** Source-texture for FX shaders that need to sample the layer pass.
   *  We copy the backbuffer into this texture once before each FX pass
   *  via `copyTexSubImage2D` — cheap and avoids the full FBO refactor.
   *  Reserved on TEXTURE1; FX shaders read it via `u_source`. */
  private sourceTex: WebGLTexture | null = null;
  private sourceTexW = 0;
  private sourceTexH = 0;

  async init(canvas: AnyCanvas, caps: BackendCaps): Promise<void> {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new BackendError(
        "init",
        "WebGL2Backend: getContext('webgl2') returned null",
      );
    }
    this.gl = gl;

    try {
      this.programs = new ProgramCache(gl);
      this.quad = makeFullscreenQuad(gl);
      this.layerProgram = this.compileLayerProgram(gl);
      this.layerLocs = {
        output: gl.getUniformLocation(this.layerProgram, "u_output"),
        destRect: gl.getUniformLocation(this.layerProgram, "u_destRect"),
        uvMat: gl.getUniformLocation(this.layerProgram, "u_uvMat"),
        tex: gl.getUniformLocation(this.layerProgram, "u_tex"),
        srcFlipY: gl.getUniformLocation(this.layerProgram, "u_srcFlipY"),
      };
      this.layerTexture = gl.createTexture();
      if (!this.layerTexture) {
        throw new BackendError("init", "WebGL2Backend: createTexture failed");
      }
      gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // FX source texture — bound to TEXTURE1, sized lazily in
      // ensureSourceTex(). Holds the backbuffer's pre-FX content for
      // source-sampling FX shaders (RGB, ZOOM, ECHO, TAPE, UV).
      this.sourceTex = gl.createTexture();
      if (!this.sourceTex) {
        throw new BackendError("init", "WebGL2Backend: createTexture failed (sourceTex)");
      }
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch (err) {
      this.dispose();
      if (err instanceof BackendError) throw err;
      throw new BackendError("compile", `WebGL2Backend setup failed: ${String(err)}`);
    }

    // Alpha-over so stacked FX passes composite additively over the
    // source layer — `(ONE, ONE_MINUS_SRC_ALPHA)` blend. Combined with
    // `premultipliedAlpha: true` on the context, vignette output matches
    // Canvas2D parity within ±1 LSB per channel.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.drawCtx = this.makeDrawCtx();
    this.resize(caps);
  }

  resize(caps: BackendCaps): void {
    this.caps = caps;
    if (!this.canvas || !this.gl) return;
    this.canvas.width = Math.max(1, Math.round(caps.pixelW));
    this.canvas.height = Math.max(1, Math.round(caps.pixelH));
    // Same reasoning as Canvas2DBackend.resize — the surrounding
    // container drives CSS size; an inline style would clobber the
    // Tailwind layout.
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  warmup(): Promise<void> {
    if (!this.programs) return Promise.resolve();
    for (const name of REGISTERED_FRAGMENTS) {
      try {
        this.programs.get(name);
      } catch (err) {
        console.warn(`[compositor] webgl2 warmup '${name}' failed:`, err);
      }
    }
    return Promise.resolve();
  }

  drawFrame(d: FrameDescriptor, sources: SourcesMap): void {
    const gl = this.gl;
    if (!gl || !this.layerProgram || !this.layerTexture || !this.quad) return;

    gl.viewport(0, 0, this.caps.pixelW, this.caps.pixelH);
    // Clear to opaque black — matches Canvas2DBackend's `fillRect` bg
    // so letterbox / pillarbox bars look identical across backends.
    gl.clearColor(0, 0, 0, d.output ? 1 : 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!d.output) return;

    // Layer pass.
    gl.useProgram(this.layerProgram);
    gl.uniform2f(this.layerLocs.output, d.output.w, d.output.h);
    gl.uniform1i(this.layerLocs.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);

    for (const layer of d.layers) {
      if (layer.weight <= 0) continue;
      const src = sources.get(layer.layerId);
      if (!src || src.kind === "test-pattern") continue;
      const upload = uploadSource(gl, src);
      if (!upload) continue;
      gl.uniform4f(
        this.layerLocs.destRect,
        layer.fitRect.x,
        layer.fitRect.y,
        layer.fitRect.w,
        layer.fitRect.h,
      );
      gl.uniformMatrix2fv(this.layerLocs.uvMat, false, uvMatrixCM(layer));
      // HTMLVideoElement / VideoFrame uploads ignore UNPACK_FLIP_Y_WEBGL
      // on Chrome's hardware path, so we compensate at sample time.
      // ImageBitmap honours the flag — flip stays at 0 there. Critical
      // edge: `kind === "video"` with `preferFallback` set uploads the
      // CACHED ImageBitmap, NOT the <video> element. That bitmap
      // honours UNPACK_FLIP_Y_WEBGL like any other ImageBitmap, so
      // srcFlipY MUST be 0 here — otherwise the shader flips again,
      // and the user sees a single upside-down frame at every pill /
      // cam transition while the seek-fallback bridges the decode gap.
      const usingFallbackBitmap =
        src.kind === "video" && src.preferFallback && src.fallback != null;
      const needsShaderFlip =
        (src.kind === "video" && !usingFallbackBitmap) ||
        src.kind === "videoframe";
      gl.uniform1f(this.layerLocs.srcFlipY, needsShaderFlip ? 1 : 0);
      this.quad.draw();
    }

    // FX pass.
    //
    // Source texture lives at backbuffer pixel size (caps), NOT at
    // descriptor output size — the layer pass writes into the viewport
    // which is sized to caps. Sizing sourceTex to d.output.* would
    // surface as "preview rendered tiny in the bottom-left corner"
    // when caps ≠ output (DPR ≠ 1, resolution-scale dial down, etc.).
    //
    // We re-snapshot the backbuffer into sourceTex BEFORE EACH FX, so
    // replace-blend FX (WEAR, TAPE, RGB, ZOOM, UV) see the cumulative
    // result of every previous FX in this frame instead of the bare
    // pre-FX layer pass. Without this, two replace-FX active at the
    // same time would each clobber each other and only the last one
    // in the array would be visible. The cost is one extra
    // `copyTexSubImage2D` per FX per frame — cheap; on tested drivers
    // a full-frame copy is < 0.2 ms even at 4K.
    if (d.fx.length > 0 && this.drawCtx) {
      const fxW = this.caps.pixelW;
      const fxH = this.caps.pixelH;
      this.ensureSourceTex(fxW, fxH);
      for (const fx of d.fx) {
        const def = fxCatalog[fx.kind];
        if (!def) continue;
        // Snapshot whatever the backbuffer currently shows (= layer
        // pass + every prior FX in this frame).
        this.copyBackbufferToSourceTex(fxW, fxH);
        const punch: PunchFx = {
          id: fx.id,
          kind: fx.kind,
          inS: fx.inS,
          // outS isn't read by draws — only inS for capsule-local time.
          outS: 0,
          params: fx.params,
        };
        // Reset to default ("over") before each FX — they opt in to
        // "replace" via setBlendMode() if they need it.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        def.drawWebGL2(this.drawCtx, punch, fxW, fxH, d.tMaster);
        // No envelope mix-pass here — the descriptor builder has
        // scaled this fx's params by ADSR wetness via def.applyWetness,
        // so the draw above already renders at the right intensity.
        // See the matching note in canvas2d-backend.ts for why a
        // generic alpha-blend over source is wrong for displacement
        // effects (zoom, rgb, wear, …).
      }
      this.currentProgram = null;
    }
  }

  /** Resize sourceTex to (w,h) if needed. Lazy — only allocates the
   *  texture storage when the output size changes. */
  private ensureSourceTex(w: number, h: number): void {
    const gl = this.gl;
    if (!gl || !this.sourceTex) return;
    if (this.sourceTexW === w && this.sourceTexH === h) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      w,
      h,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    this.sourceTexW = w;
    this.sourceTexH = h;
  }

  /** Copy the current backbuffer (layer-pass output) into sourceTex.
   *  Called once before the FX loop. Uses copyTexSubImage2D which is
   *  fast on most drivers (no GPU stall). */
  private copyBackbufferToSourceTex(w: number, h: number): void {
    const gl = this.gl;
    if (!gl || !this.sourceTex) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    // Backbuffer is the default framebuffer; READ_BUFFER defaults to BACK.
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    void w;
    void h;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl) {
      if (this.quad) this.quad.destroy();
      if (this.programs) this.programs.destroy();
      if (this.layerProgram) gl.deleteProgram(this.layerProgram);
      if (this.layerTexture) gl.deleteTexture(this.layerTexture);
      if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    }
    this.gl = null;
    this.canvas = null;
    this.programs = null;
    this.quad = null;
    this.layerProgram = null;
    this.layerTexture = null;
    this.sourceTex = null;
    this.sourceTexW = 0;
    this.sourceTexH = 0;
    this.drawCtx = null;
    this.currentProgram = null;
  }

  // ---- internals ----

  private compileLayerProgram(gl: WebGL2RenderingContext): WebGLProgram {
    const vs = compileShader(gl, gl.VERTEX_SHADER, LAYER_VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, LAYER_FRAG);
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new BackendError("compile", "WebGL2Backend: createProgram failed");
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_position");
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? "(no log)";
      gl.deleteProgram(prog);
      throw new BackendError("compile", `WebGL2Backend layer link failed: ${log}`);
    }
    return prog;
  }

  private makeDrawCtx(): WebGL2DrawContext {
    return {
      useProgram: (name: string) => {
        if (!this.programs || !this.gl) return;
        const p = this.programs.get(name);
        this.gl.useProgram(p.program);
        this.currentProgram = p;
      },
      setUniform1i: (name: string, value: number) => {
        if (!this.programs || !this.gl || !this.currentProgram) return;
        const loc = this.programs.getUniform(this.currentProgram, name);
        if (loc !== null) this.gl.uniform1i(loc, value);
      },
      setUniform1f: (name: string, value: number) => {
        if (!this.programs || !this.gl || !this.currentProgram) return;
        const loc = this.programs.getUniform(this.currentProgram, name);
        if (loc !== null) this.gl.uniform1f(loc, value);
      },
      setUniform2f: (name: string, a: number, b: number) => {
        if (!this.programs || !this.gl || !this.currentProgram) return;
        const loc = this.programs.getUniform(this.currentProgram, name);
        if (loc !== null) this.gl.uniform2f(loc, a, b);
      },
      setUniform4f: (
        name: string,
        a: number,
        b: number,
        c: number,
        d: number,
      ) => {
        if (!this.programs || !this.gl || !this.currentProgram) return;
        const loc = this.programs.getUniform(this.currentProgram, name);
        if (loc !== null) this.gl.uniform4f(loc, a, b, c, d);
      },
      bindSourceTexture: (samplerName?: string) => {
        if (!this.programs || !this.gl || !this.currentProgram || !this.sourceTex) return;
        // Bind the source texture to TEXTURE1 and tell the FX shader to
        // read from sampler unit 1. Bind layerTexture back to TEXTURE0
        // afterwards so subsequent layer-pass uploads still work.
        this.gl.activeTexture(this.gl.TEXTURE1);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTex);
        const loc = this.programs.getUniform(
          this.currentProgram,
          samplerName ?? "u_source",
        );
        if (loc !== null) this.gl.uniform1i(loc, 1);
      },
      setBlendMode: (mode: "over" | "replace") => {
        if (!this.gl) return;
        if (mode === "over") {
          this.gl.enable(this.gl.BLEND);
          this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
        } else {
          // Replace = no blending, FX shader fully owns the output.
          this.gl.disable(this.gl.BLEND);
        }
      },
      drawFullscreenQuad: () => {
        if (this.quad) this.quad.draw();
      },
    };
  }
}

// ---- helpers ----

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new BackendError("compile", "createShader returned null");
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "(no log)";
    gl.deleteShader(sh);
    throw new BackendError("compile", `shader compile failed: ${log}`);
  }
  return sh;
}

/** Column-major mat2 (GLSL convention) that maps centred dest-uv into
 *  centred source-uv for the given rotation/flip. Derivation in
 *  webgl2-backend.test.ts comments. */
export function uvMatrixCM(layer: FrameLayer): Float32Array {
  const swap = layer.rotationDeg === 90 || layer.rotationDeg === 270;
  const drawW = swap ? layer.fitRect.h : layer.fitRect.w;
  const drawH = swap ? layer.fitRect.w : layer.fitRect.h;
  const sx = layer.flipX ? -1 : 1;
  const sy = layer.flipY ? -1 : 1;
  const fitW = layer.fitRect.w || 1;
  const fitH = layer.fitRect.h || 1;
  const dW = drawW || 1;
  const dH = drawH || 1;
  const cosT = Math.cos((layer.rotationDeg * Math.PI) / 180);
  const sinT = Math.sin((layer.rotationDeg * Math.PI) / 180);
  // R^T (transpose) — inverse for orthogonal rotation.
  const rt00 = cosT;
  const rt01 = sinT;
  const rt10 = -sinT;
  const rt11 = cosT;
  // diag(1/drawW, 1/drawH) * S * R^T * diag(fitW, fitH)
  const m00 = (sx * rt00 * fitW) / dW;
  const m01 = (sx * rt01 * fitH) / dW;
  const m10 = (sy * rt10 * fitW) / dH;
  const m11 = (sy * rt11 * fitH) / dH;
  // Float32Array column-major: [m00, m10, m01, m11].
  return new Float32Array([m00, m10, m01, m11]);
}

function uploadSource(
  gl: WebGL2RenderingContext,
  src: LayerSource,
): boolean {
  // Caller already bound the layer texture to TEXTURE_2D@TEXTURE0.
  switch (src.kind) {
    case "image":
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src.bitmap,
      );
      return true;
    case "video":
      if (src.preferFallback && src.fallback) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          src.fallback,
        );
        return true;
      }
      if (src.element.readyState < 2) return false;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src.element,
      );
      return true;
    case "videoframe":
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src.frame as unknown as TexImageSource,
      );
      return true;
    case "test-pattern":
      return false;
  }
}
