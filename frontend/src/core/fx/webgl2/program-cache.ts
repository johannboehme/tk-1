/**
 * Lazy-Compile-Cache für FX-Shader-Programme.
 *
 * Jedes FxKind (vignette, später strobe, glitch …) hat einen eigenen
 * Fragment-Shader; der Vertex-Shader (Fullscreen-Quad) wird geteilt. Der
 * Cache compiliert on-demand, hält die Programme bis `destroy()`.
 */
import { FULLSCREEN_VERT, VIGNETTE_FRAG } from "./vignette.frag";
import { WEAR_FRAG } from "./wear.frag";
import { RGB_FRAG } from "./rgb.frag";
import { ZOOM_FRAG } from "./zoom.frag";
import { UV_FRAG } from "./uv.frag";
import { ECHO_FRAG } from "./echo.frag";
import { TAPE_FRAG } from "./tape.frag";
import { GRADE_FRAG } from "./grade.frag";
import { VHS_FRAG } from "./vhs.frag";
import { SUPER8_FRAG } from "./super8.frag";
import { DECAY_FRAG } from "./decay.frag";
import { NOIR_FRAG } from "./noir.frag";
import { SEPIA_FRAG } from "./sepia.frag";
import { POLAROID_FRAG } from "./polaroid.frag";
import { emit, PERF_ENABLED } from "../../perf/marks";

const FRAGMENTS: Record<string, string> = {
  vignette: VIGNETTE_FRAG,
  wear: WEAR_FRAG,
  rgb: RGB_FRAG,
  zoom: ZOOM_FRAG,
  uv: UV_FRAG,
  echo: ECHO_FRAG,
  tape: TAPE_FRAG,
  grade: GRADE_FRAG,
  vhs: VHS_FRAG,
  super8: SUPER8_FRAG,
  decay: DECAY_FRAG,
  noir: NOIR_FRAG,
  sepia: SEPIA_FRAG,
  polaroid: POLAROID_FRAG,
};

/** Names of all registered fragment shaders — exposed so callers (e.g.
 *  WebGL2Backend) can warm the cache eagerly at mount instead of paying the
 *  compile cost on first activation. */
export const REGISTERED_FRAGMENTS: readonly string[] = Object.keys(FRAGMENTS);

export interface CachedProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export class ProgramCache {
  private gl: WebGL2RenderingContext;
  private vert: WebGLShader;
  private cache = new Map<string, CachedProgram>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vert = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
  }

  /** Get or compile the program for `name`. Throws on unknown name or
   *  link failure (so init-time problems surface, not at first frame). */
  get(name: string): CachedProgram {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const fragSrc = FRAGMENTS[name];
    if (!fragSrc) {
      throw new Error(`ProgramCache: no fragment shader registered for '${name}'`);
    }
    // Cold path: compile + link is the dominant first-FX-activation cost
    // (1-50 ms depending on driver). Time it for the perf HUD.
    const t0 = PERF_ENABLED ? performance.now() : 0;
    const frag = compile(this.gl, this.gl.FRAGMENT_SHADER, fragSrc);
    const program = link(this.gl, this.vert, frag);
    this.gl.deleteShader(frag);
    const cached: CachedProgram = { program, uniforms: new Map() };
    this.cache.set(name, cached);
    if (PERF_ENABLED) {
      emit({
        kind: "shader-cold",
        name,
        durationMs: performance.now() - t0,
        perfNow: t0,
      });
    }
    return cached;
  }

  /** Lookup-with-cache for a uniform location. Avoids repeated string
   *  lookups in the hot path. */
  getUniform(p: CachedProgram, name: string): WebGLUniformLocation | null {
    const cached = p.uniforms.get(name);
    if (cached !== undefined) return cached;
    const loc = this.gl.getUniformLocation(p.program, name);
    p.uniforms.set(name, loc);
    return loc;
  }

  destroy(): void {
    for (const cached of this.cache.values()) {
      this.gl.deleteProgram(cached.program);
    }
    this.cache.clear();
    this.gl.deleteShader(this.vert);
  }
}

function compile(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("compile: createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`compile: shader compile failed: ${log ?? "(no log)"}`);
  }
  return shader;
}

function link(
  gl: WebGL2RenderingContext,
  vert: WebGLShader,
  frag: WebGLShader,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("link: createProgram failed");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  // Force a_position at attribute 0 so the shared fullscreen-quad VBO
  // setup works for every program without per-program rebinding.
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`link: program link failed: ${log ?? "(no log)"}`);
  }
  return program;
}
