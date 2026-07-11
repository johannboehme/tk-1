// SEPIA — WGSL port (parity with sepia.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const SEPIA_WGSL = `struct Uniforms {
  tone: f32,
  contrast: f32,
  fade: f32,
  grain: f32,
  amount: f32,
  time: f32,
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

fn sepia(cin: vec3f, uv: vec2f) -> vec3f {
  // 1. luma collapse.
  var l = dot(cin, W);
  // 2. S-curve contrast about mid-grey, mixed in by u.contrast.
  let s = smoothstep(0.0, 1.0, l);
  l = mix(l, s, u.contrast);
  // 3. duotone anchors — TONE rotates the palette.
  let warm = u.tone * 0.5;
  var shadowCol = vec3f(0.13, 0.09, 0.05) + vec3f(warm * 0.05, -warm * 0.01, -warm * 0.03);
  let midCol    = vec3f(0.52, 0.38, 0.24) + vec3f(warm * 0.10,  warm * 0.01, -warm * 0.10);
  var highCol   = vec3f(0.96, 0.87, 0.72) + vec3f(warm * 0.02, -warm * 0.01, -warm * 0.08);
  // 4. matte fade.
  let paper = vec3f(0.86, 0.79, 0.66);
  shadowCol = mix(shadowCol, paper, u.fade * 0.55);
  highCol = mix(highCol, midCol, u.fade * 0.30);
  // 5. luma -> duotone ramp.
  let lower = mix(shadowCol, midCol, smoothstep(0.0, 0.5, l));
  let upper = mix(midCol, highCol, smoothstep(0.5, 1.0, l));
  var toned = mix(lower, upper, step(0.5, l));
  // 6. oval vignette.
  let d = (uv - vec2f(0.5)) * vec2f(1.15, 1.0);
  let r = length(d) * 1.4142136;
  toned = toned * (1.0 - 0.45 * smoothstep(0.55, 1.0, r));
  // 7. fine toner grain.
  let n = hash(uv * 1024.0 + vec2f(u.time));
  toned = toned + u.grain * (n - 0.5) * 0.12;
  return toned;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let src = sampleSrc(in.uv).rgb;
  let e = clamp(sepia(src, in.uv), vec3f(0.0), vec3f(1.0));
  return vec4f(mix(src, e, u.amount), 1.0);
}`;

export const SEPIA_SPEC: FxWebGPUSpec = {
  name: "sepia",
  wgsl: SEPIA_WGSL,
  uniformFields: [
    { name: "tone", type: "f1" },
    { name: "contrast", type: "f1" },
    { name: "fade", type: "f1" },
    { name: "grain", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
