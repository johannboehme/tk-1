/**
 * WGSL-Port von rgb.frag.ts. Source-Sampling: liest die Pre-FX-Snapshot
 * (`u_source` in WebGL2-Sprech, hier `src` an binding=1) und splittet
 * R/G/B entlang einer Achse.
 *
 * Output non-premultiplied opak — Blend-Mode "replace" (siehe Catalog).
 *
 * Sampling-Convention: `sampleSrc(uv)` flippt Y intern, damit
 * `v_uv` (Clip-Y-Up, uv.y=1 = top of canvas) wie in WebGL2 verwendet
 * werden kann. Source-Texture hat top-origin (WebGPU-default), also
 * sampelt `textureSample(src, samp, vec2(uv.x, 1.0 - uv.y))` an der
 * korrekten Stelle.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const RGB_WGSL = `
struct Uniforms {
  split: f32,
  angle: f32,
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
  let p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var out: VsOut;
  out.pos = vec4f(p[idx], 0.0, 1.0);
  out.uv = vec2f(p[idx].x * 0.5 + 0.5, p[idx].y * 0.5 + 0.5);
  return out;
}

fn sampleSrc(uv: vec2f) -> vec4f {
  return textureSample(u_source, u_samp, vec2f(uv.x, 1.0 - uv.y));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let magnitude = u.split * 0.06;
  let a = u.angle * 6.28318530718;
  let dir = vec2f(cos(a), sin(a)) * magnitude;
  let r = sampleSrc(in.uv - dir).r;
  let g = sampleSrc(in.uv).g;
  let b = sampleSrc(in.uv + dir).b;
  return vec4f(r, g, b, 1.0);
}
`;

export const RGB_SPEC: FxWebGPUSpec = {
  name: "rgb",
  wgsl: RGB_WGSL,
  uniformFields: [
    { name: "split", type: "f1" },
    { name: "angle", type: "f1" },
  ],
};
