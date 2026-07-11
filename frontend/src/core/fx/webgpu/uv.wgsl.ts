/**
 * WGSL-Port von uv.frag.ts. Blacklight-Glow mit 9-tap radial blur,
 * Tone-S-Curve, Halation, subtiler chromatic-offset auf Edges.
 *
 * Replace-Blend.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const UV_WGSL = `
struct Uniforms {
  glow:  f32,
  tint:  f32,
  texel: vec2f,
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

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let base = sampleSrc(in.uv).rgb;

  let r = 8.0 + u.glow * 18.0;
  let d = u.texel * r;
  var blur = vec3f(0.0);
  blur = blur + sampleSrc(in.uv).rgb * 0.30;
  blur = blur + sampleSrc(in.uv + vec2f( d.x,  0.0)).rgb * 0.0875;
  blur = blur + sampleSrc(in.uv + vec2f(-d.x,  0.0)).rgb * 0.0875;
  blur = blur + sampleSrc(in.uv + vec2f( 0.0,  d.y)).rgb * 0.0875;
  blur = blur + sampleSrc(in.uv + vec2f( 0.0, -d.y)).rgb * 0.0875;
  blur = blur + sampleSrc(in.uv + vec2f( d.x,  d.y) * 0.7071).rgb * 0.0625;
  blur = blur + sampleSrc(in.uv + vec2f(-d.x,  d.y) * 0.7071).rgb * 0.0625;
  blur = blur + sampleSrc(in.uv + vec2f( d.x, -d.y) * 0.7071).rgb * 0.0625;
  blur = blur + sampleSrc(in.uv + vec2f(-d.x, -d.y) * 0.7071).rgb * 0.0625;

  let magenta = vec3f(1.0, 0.10, 0.95);
  let cyan    = vec3f(0.10, 0.95, 1.0);
  let highlight = mix(magenta, cyan, u.tint);
  let violet  = vec3f(0.10, 0.04, 0.18);

  let l  = luma(base);
  let lo = smoothstep(0.0, 0.45, l);
  let hi = smoothstep(0.55, 0.95, l);

  let shadowOut = violet;
  let midOut    = highlight * (0.55 + lo * 0.30);
  let highOut   = highlight * (1.0 + u.glow * 0.6);
  var tonemapped = mix(shadowOut, midOut, lo);
  tonemapped = mix(tonemapped, highOut, hi);

  let blurL = luma(blur);
  let halationMask = smoothstep(0.45, 0.85, blurL);
  let halation = blur * highlight * halationMask * (0.8 + u.glow * 1.2);

  var outRgb = tonemapped + halation;

  let chrom = u.glow * 0.004;
  if (chrom > 0.0) {
    let rChan = sampleSrc(in.uv + vec2f(-chrom, 0.0)).r * highlight.r;
    let bChan = sampleSrc(in.uv + vec2f( chrom, 0.0)).b * highlight.b;
    outRgb.r = outRgb.r + rChan * halationMask * 0.25;
    outRgb.b = outRgb.b + bChan * halationMask * 0.25;
  }

  outRgb = clamp(outRgb, vec3f(0.0), vec3f(1.0));
  return vec4f(outRgb, 1.0);
}
`;

export const UV_SPEC: FxWebGPUSpec = {
  name: "uv",
  wgsl: UV_WGSL,
  uniformFields: [
    { name: "glow", type: "f1" },
    { name: "tint", type: "f1" },
    { name: "texel", type: "f2" },
  ],
};
