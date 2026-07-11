/**
 * WGSL-Port von echo.frag.ts. Stateless 5-tap trail entlang einer
 * phase-rotierenden Achse.
 *
 * Replace-Blend.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const ECHO_WGSL = `
struct Uniforms {
  trail: f32,
  mix:   f32,
  phase: f32,
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
  let base = sampleSrc(in.uv).rgb;
  if (u.mix <= 0.001 || u.trail <= 0.001) {
    return vec4f(base, 1.0);
  }
  let a = u.phase * 6.28318530718;
  let axis = vec2f(cos(a), sin(a)) * (u.trail * 0.10);
  var trail = vec3f(0.0);
  var wsum = 0.0;
  for (var i: i32 = 1; i <= 5; i = i + 1) {
    let fi = f32(i) / 5.0;
    let w = exp(-fi * 2.5);
    let uv = clamp(in.uv - axis * fi, vec2f(0.0), vec2f(1.0));
    trail = trail + sampleSrc(uv).rgb * w;
    wsum = wsum + w;
  }
  trail = trail / max(wsum, 0.0001);
  let outRgb = mix(base, max(base, trail), u.mix);
  return vec4f(outRgb, 1.0);
}
`;

export const ECHO_SPEC: FxWebGPUSpec = {
  name: "echo",
  wgsl: ECHO_WGSL,
  uniformFields: [
    { name: "trail", type: "f1" },
    { name: "mix", type: "f1" },
    { name: "phase", type: "f1" },
  ],
};
