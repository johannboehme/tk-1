/**
 * WGSL-Pendant zu vignette.frag.ts. Pure Overlay (no source sampling),
 * Output ist transparent über schwarz — der Backend blittet additive
 * über das Layer-Pass-Resultat per "over"-Blend (premultiplied alpha).
 *
 * Convention: Vertex-Shader emit `v_uv = (clip + 1) * 0.5` — matched
 * WebGL2's `(a_position + 1) * 0.5`. uv.y=1 entspricht dem TOP des
 * Canvas-Inhalts (Clip-Y-Up). Vignette ist symmetrisch, also irrelevant
 * hier; für displacement-FX werden wir `sampleSrc(uv)` als Helper
 * nutzen, der den Y-Flip beim Sampling der renderTarget-Snapshot-Tex
 * macht (siehe Phase 3).
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const VIGNETTE_WGSL = `
struct Uniforms {
  intensity: f32,
  falloff:   f32,
};

@group(0) @binding(0) var u_samp: sampler;
@group(0) @binding(1) var u_source: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  // Fullscreen-Triangle (3 verts, no buffer).
  let p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var out: VsOut;
  out.pos = vec4f(p[idx], 0.0, 1.0);
  // (clip + 1) * 0.5 — matched WebGL2 v_uv convention (Y-up,
  // uv.y=1 = top of canvas content).
  out.uv = vec2f(p[idx].x * 0.5 + 0.5, p[idx].y * 0.5 + 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = in.uv - vec2f(0.5);
  let r = length(p) * 1.4142136;
  let a = smoothstep(1.0 - u.falloff, 1.0, r) * u.intensity;
  return vec4f(0.0, 0.0, 0.0, a);
}
`;

export const VIGNETTE_SPEC: FxWebGPUSpec = {
  name: "vignette",
  wgsl: VIGNETTE_WGSL,
  uniformFields: [
    { name: "intensity", type: "f1" },
    { name: "falloff", type: "f1" },
  ],
};
