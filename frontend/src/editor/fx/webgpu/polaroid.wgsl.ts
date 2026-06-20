// INSTANT — WGSL port (parity with polaroid.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const POLAROID_WGSL = `struct Uniforms {
  fade: f32,
  bloom: f32,
  chem: f32,
  vignette: f32,
  border: f32,
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

const W = vec3f(0.299, 0.587, 0.114);

fn diffuse(uv: vec2f, radius: f32) -> vec3f {
  var c = sampleSrc(uv).rgb * 0.4;
  c = c + sampleSrc(uv + vec2f( radius,  radius)).rgb * 0.15;
  c = c + sampleSrc(uv + vec2f(-radius,  radius)).rgb * 0.15;
  c = c + sampleSrc(uv + vec2f( radius, -radius)).rgb * 0.15;
  c = c + sampleSrc(uv + vec2f(-radius, -radius)).rgb * 0.15;
  return c;
}

fn polaroid(src: vec3f, uv: vec2f) -> vec3f {
  var c = src;

  // 1. Soft center diffusion + highlight bloom.
  let radius = u.bloom * 0.006;
  let soft = diffuse(uv, radius);
  let lb = dot(c, W);
  let hi = smoothstep(0.45, 0.95, lb);
  c = mix(c, soft, u.bloom * (0.35 + 0.45 * hi));
  c = c + vec3f(u.bloom * 0.05);

  // 2. Milky matte floor + creamy de-contrast.
  let floorLift = u.fade * 0.22;
  c = c * (1.0 - floorLift) + floorLift * vec3f(1.0, 0.98, 0.95);
  c = (c - vec3f(0.5)) * (1.0 - u.fade * 0.18) + vec3f(0.5);

  // 3. Baked warm/cool instant-film split (gated by master amount).
  let l = dot(c, W);
  let sW = 1.0 - smoothstep(0.0, 0.55, l);
  let hW = smoothstep(0.45, 1.0, l);
  c.r = c.r - u.amount * 0.055 * sW; c.g = c.g + u.amount * 0.025 * sW; c.b = c.b + u.amount * 0.070 * sW;
  c.r = c.r + u.amount * 0.075 * hW; c.g = c.g + u.amount * 0.035 * hW; c.b = c.b - u.amount * 0.045 * hW;

  // 4. Chemical magenta/green chem with slow shimmer.
  var shim = 0.5 + 0.5 * sin(u.time * 0.7);
  shim = mix(shim, 0.5 + 0.5 * sin(u.time * 1.9), 0.25);
  let castAmt = u.chem * (0.65 + 0.35 * shim);
  c.r = c.r + castAmt * 0.05; c.b = c.b + castAmt * 0.05; c.g = c.g - castAmt * 0.04;
  c.g = c.g + u.chem * (1.0 - shim) * 0.03;

  // 5. Strong soft vignette + creamy edge desaturation.
  let d = length(uv - vec2f(0.5)) * 1.4142136;
  let vig = smoothstep(0.35, 1.0, d);
  c = c * (1.0 - u.vignette * 0.55 * vig);
  let le = dot(c, W);
  c = mix(c, vec3f(le), u.vignette * 0.25 * vig);

  return c;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let src = sampleSrc(in.uv).rgb;
  let p = clamp(polaroid(src, in.uv), vec3f(0.0), vec3f(1.0));
  var outc = mix(src, p, u.amount);

  // 6. Off-white instant-film BORDER (geometry, after the colour mix).
  if (u.border > 0.0) {
    let side = u.border * 0.05;
    let top  = u.border * 0.05;
    let chin = u.border * 0.16;
    let inX = min(in.uv.x - side, (1.0 - side) - in.uv.x);
    let inY = min(in.uv.y - chin, (1.0 - top) - in.uv.y);
    let frameMask = step(min(inX, inY), 0.0);
    let g = fract(sin(dot(in.uv, vec2f(12.9898, 78.233))) * 43758.5453);
    let paper = vec3f(0.96, 0.95, 0.92) - vec3f(g * 0.015);
    outc = mix(outc, paper, frameMask);
  }

  return vec4f(outc, 1.0);
}`;

export const POLAROID_SPEC: FxWebGPUSpec = {
  name: "polaroid",
  wgsl: POLAROID_WGSL,
  uniformFields: [
    { name: "fade", type: "f1" },
    { name: "bloom", type: "f1" },
    { name: "chem", type: "f1" },
    { name: "vignette", type: "f1" },
    { name: "border", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
