// SUPER-8 — WGSL port (parity with super8.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const SUPER8_WGSL = `struct Uniforms {
  grain:   f32,
  weave:   f32,
  flicker: f32,
  warmth:  f32,
  amount:  f32,
  time:    f32,
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

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

const W = vec3f(0.299, 0.587, 0.114);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // — Gate weave.
  let wx = sin(u.time * 5.7) * 0.6 + sin(u.time * 11.3 + 1.7) * 0.4;
  let wy = sin(u.time * 4.3 + 2.1) * 0.6 + sin(u.time * 9.1 + 0.5) * 0.4;
  var weaveUv = in.uv + vec2f(wx * u.weave * 0.012, wy * u.weave * 0.010);
  weaveUv = clamp(weaveUv, vec2f(0.0), vec2f(1.0));

  let src = sampleSrc(in.uv).rgb;
  var c = sampleSrc(weaveUv).rgb;

  // — Flicker.
  let flick = 1.0 + u.flicker * (sin(u.time * 8.0) * 0.5 + sin(u.time * 21.7 + 1.3) * 0.5) * 0.12;
  c = c * flick;

  // — Warm faded stock.
  let lift = u.warmth * 0.10;
  c = c * (1.0 - lift) + lift * vec3f(0.06, 0.04, 0.02);
  c = c - vec3f(u.warmth * 0.02);
  c.r = c.r + u.warmth * 0.10;
  c.g = c.g + u.warmth * 0.03;
  c.b = c.b - u.warmth * 0.08;
  c = (c - vec3f(0.5)) * (1.0 + u.warmth * 0.12) + vec3f(0.5);

  // — Halation.
  let l = dot(c, W);
  let hl = max(l - 0.55, 0.0) * 2.2;
  c = c + u.warmth * hl * vec3f(0.34, 0.14, 0.05);

  // — Vignette.
  let d = length(in.uv - vec2f(0.5)) * 1.4142136;
  c = c * (1.0 - u.warmth * 0.55 * smoothstep(0.45, 1.0, d));

  // — Organic grain (24fps quantized).
  let frame = floor(u.time * 24.0);
  let n = hash(in.uv * 1024.0 + vec2f(frame, frame * 1.7));
  c = c + u.grain * (n - 0.5) * 0.22;

  c = clamp(c, vec3f(0.0), vec3f(1.0));
  return vec4f(mix(src, c, u.amount), 1.0);
}
`;

export const SUPER8_SPEC: FxWebGPUSpec = {
  name: "super8",
  wgsl: SUPER8_WGSL,
  uniformFields: [
    { name: "grain", type: "f1" },
    { name: "weave", type: "f1" },
    { name: "flicker", type: "f1" },
    { name: "warmth", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
