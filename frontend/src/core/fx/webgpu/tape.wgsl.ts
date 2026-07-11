/**
 * WGSL-Port von tape.frag.ts. Tape-Stop: scanline-band drift, chromatic
 * warp, magnetic-hiss grain, tape losing luminance.
 *
 * Replace-Blend.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const TAPE_WGSL = `
struct Uniforms {
  warp:  f32,
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

fn hash1(x: f32) -> f32 {
  return fract(sin(x * 91.345) * 43758.5453);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let band = floor(in.uv.y * 24.0);
  let bandRand = hash1(band) - 0.5;
  let warpScale = 0.5 + u.warp * 0.5;
  let drift = u.phase * 0.06 * bandRand * warpScale;
  var uv = in.uv;
  uv.x = uv.x + drift;
  uv.x = clamp(uv.x, 0.0, 1.0);
  uv.y = uv.y - u.phase * 0.025 * bandRand * warpScale;
  uv.y = clamp(uv.y, 0.0, 1.0);

  let chrom = u.phase * u.warp * 0.045;
  let r = sampleSrc(vec2f(clamp(uv.x - chrom, 0.0, 1.0), uv.y)).r;
  let g = sampleSrc(uv).g;
  let b = sampleSrc(vec2f(clamp(uv.x + chrom, 0.0, 1.0), uv.y)).b;

  let grain = hash1(in.uv.x * 437.0 + in.uv.y * 813.0 + u.phase * 17.0) - 0.5;
  let grainAmt = u.phase * u.warp * 0.18;
  var outRgb = vec3f(r, g, b) + vec3f(grain * grainAmt);

  outRgb = outRgb * (1.0 - u.phase * 0.20);
  outRgb = clamp(outRgb, vec3f(0.0), vec3f(1.0));
  return vec4f(outRgb, 1.0);
}
`;

export const TAPE_SPEC: FxWebGPUSpec = {
  name: "tape",
  wgsl: TAPE_WGSL,
  uniformFields: [
    { name: "warp", type: "f1" },
    { name: "phase", type: "f1" },
  ],
};
