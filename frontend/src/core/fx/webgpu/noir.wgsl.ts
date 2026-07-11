// NOIR — WGSL port (parity with noir.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

// NOTE: the catalog param id is "filter", but `filter` is a RESERVED
// WORD in WGSL — using it as a struct member made the whole module fail
// to compile, so the noir filter silently never rendered on WebGPU
// (found by fx-parity.browser.test.ts). The member is therefore named
// `colorFilter`; the JS-side uniform name stays "filter" (uniformFields
// below), which only drives the byte-offset layout, not WGSL identifiers.
export const NOIR_WGSL = `struct Uniforms {
  colorFilter: f32,
  contrast: f32,
  grain: f32,
  vignette: f32,
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

const LUMA = vec3f(0.299, 0.587, 0.114);

fn noir(cin: vec3f, uv: vec2f) -> vec3f {
  // 1. Colour-filter response.
  let warm = max(-u.colorFilter, 0.0);
  let cool = max( u.colorFilter, 0.0);
  var w = LUMA;
  w.r = w.r + warm * 0.55 - cool * 0.22;
  w.b = w.b + cool * 0.55 - warm * 0.22;
  w = max(w, vec3f(0.0));
  w = w / max(w.r + w.g + w.b, 1e-4);
  var mono = dot(cin, w);

  // 2. Filmic S-curve about mid-grey.
  var s = smoothstep(0.0, 1.0, mono);
  s = mix(mono, s, u.contrast);
  s = max(s - u.contrast * 0.06, 0.0);
  s = s * (1.0 + u.contrast * 0.10);
  mono = clamp(s, 0.0, 1.0);

  // 3. Film grain — frame-coherent at ~24fps, luma-modulated.
  let frame = floor(u.time * 24.0);
  let n = hash(uv * 1024.0 + vec2f(frame, frame * 1.7)) - 0.5;
  let grainMask = (1.0 - smoothstep(0.55, 1.0, mono)) * (0.35 + mono * 0.65);
  mono = mono + u.grain * n * 0.18 * grainMask;

  // 4. Heavy noir vignette.
  let d = length(uv - vec2f(0.5)) * 1.4142136;
  mono = mono * (1.0 - u.vignette * smoothstep(0.35, 1.0, d));

  return vec3f(clamp(mono, 0.0, 1.0));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let src = sampleSrc(in.uv).rgb;
  let n = noir(src, in.uv);
  return vec4f(mix(src, n, u.amount), 1.0);
}
`;

export const NOIR_SPEC: FxWebGPUSpec = {
  name: "noir",
  wgsl: NOIR_WGSL,
  uniformFields: [
    { name: "filter", type: "f1" },
    { name: "contrast", type: "f1" },
    { name: "grain", type: "f1" },
    { name: "vignette", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
