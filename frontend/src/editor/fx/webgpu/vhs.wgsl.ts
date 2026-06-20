// VHS — WGSL port (parity with vhs.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const VHS_WGSL = `struct Uniforms {
  tracking: f32,
  bleed: f32,
  noise: f32,
  wobble: f32,
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

fn vhs(src: vec3f, uv: vec2f) -> vec3f {
  // — Per-line horizontal jitter (WOBBLE).
  let line = floor(uv.y * 480.0);
  let jitWave = sin(u.time * 5.0 + line * 0.7) * 0.5 + sin(u.time * 8.3) * 0.5;
  let lineRand = hash(vec2f(line, floor(u.time * 24.0))) - 0.5;
  let jitter = (lineRand * 0.6 + jitWave * 0.4) * u.wobble * 0.012;
  var wuv = vec2f(clamp(uv.x + jitter, 0.0, 1.0), uv.y);

  // — Rolling tracking band (TRACKING).
  let barY = fract(u.time * 0.18);
  let bdist = abs(wuv.y - barY);
  let bwrap = min(bdist, 1.0 - bdist);
  let band = exp(-pow(bwrap / 0.06, 2.0)) * u.tracking;
  wuv.y = clamp(wuv.y + band * 0.02, 0.0, 1.0);

  // — Horizontal Y/C chroma bleed (BLEED).
  let bd = u.bleed * 0.018;
  let dotOff = u.bleed * 0.004 * sign(jitWave);
  let r = sampleSrc(vec2f(clamp(wuv.x - bd - dotOff, 0.0, 1.0), wuv.y)).r;
  let g = sampleSrc(wuv).g;
  let b = sampleSrc(vec2f(clamp(wuv.x + bd + dotOff, 0.0, 1.0), wuv.y)).b;
  let trail = sampleSrc(vec2f(clamp(wuv.x - bd * 2.0, 0.0, 1.0), wuv.y)).rgb;
  let trailLuma = dot(trail, W);
  let trailChroma = trail - vec3f(trailLuma);
  var col = vec3f(r, g, b);
  let colLuma = dot(col, W);
  let colChroma = col - vec3f(colLuma);
  col = vec3f(colLuma) + mix(colChroma, trailChroma, u.bleed * 0.5);

  // Tracking band brightens + desaturates the stripe it crosses.
  let bandL = dot(col, W);
  col = mix(col, vec3f(bandL), band * 0.4);
  col = col + vec3f(band * 0.18);

  // — Scanline combing (NOISE).
  let scan = 0.5 + 0.5 * cos(uv.y * 1100.0);
  col = col * (1.0 - u.noise * 0.18 * scan);

  // — Luma snow (NOISE).
  let frame30 = floor(u.time * 30.0);
  let frame60 = floor(u.time * 60.0);
  let coarse = hash(floor(uv * 300.0) + vec2f(frame30, frame30 * 1.7)) - 0.5;
  let fine = hash(uv * 900.0 + vec2f(frame60, frame60 * 1.3)) - 0.5;
  let snow = coarse * 0.7 + fine * 0.3;
  col = col + vec3f(snow * u.noise * 0.22);

  // — Head-switching tear band fixed at the bottom (NOISE).
  let hs = smoothstep(0.06, 0.0, uv.y);
  let tear = hash(vec2f(floor(uv.x * 220.0), frame30)) - 0.5;
  col = col + vec3f(hs * tear * u.noise * 0.7);
  col = mix(col, vec3f(0.0), hs * u.noise * 0.25);

  // — Slow midtone hue wobble (WOBBLE).
  let hue = sin(u.time * 1.3) * u.wobble * 0.05;
  col.g = col.g + hue;
  col.r = col.r - hue * 0.5;

  // Static cool-green tape cast, scaled by overall character.
  let tapeCast = max(max(u.tracking, u.bleed), max(u.noise, u.wobble));
  col.g = col.g + tapeCast * 0.02;
  col.b = col.b + tapeCast * 0.01;

  return col;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let src = sampleSrc(in.uv).rgb;
  let e = clamp(vhs(src, in.uv), vec3f(0.0), vec3f(1.0));
  return vec4f(mix(src, e, u.amount), 1.0);
}
`;

export const VHS_SPEC: FxWebGPUSpec = {
  name: "vhs",
  wgsl: VHS_WGSL,
  uniformFields: [
    { name: "tracking", type: "f1" },
    { name: "bleed", type: "f1" },
    { name: "noise", type: "f1" },
    { name: "wobble", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
