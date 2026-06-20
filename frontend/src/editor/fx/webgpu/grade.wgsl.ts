/**
 * WGSL port of grade.frag.ts. Source-sampling REPLACE effect — reads the
 * pre-FX snapshot (`u_source` / binding=1), runs the IDENTICAL grade
 * pipeline (same stage order + constants as the GLSL), and outputs
 * `mix(source, graded, strength)`.
 *
 * Parity: keep every operation byte-for-byte aligned with grade.frag.ts so
 * WebGL2 and WebGPU agree to ±1 LSB on the deterministic colour stages.
 * The uniform struct field order MUST match `GRADE_SPEC.uniformFields`
 * (which mirrors `GRADE_PARAM_KEYS` + `time`).
 *
 * Sampling convention mirrors rgb.wgsl: `sampleSrc` flips Y so `in.uv`
 * (clip-Y-up) addresses the top-origin source texture correctly.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const GRADE_WGSL = `
struct Uniforms {
  exposure: f32,
  contrast: f32,
  saturation: f32,
  vibrance: f32,
  temp: f32,
  tint: f32,
  shadowTone: f32,
  highlightTone: f32,
  splitWarm: f32,
  blackPoint: f32,
  fade: f32,
  gamma: f32,
  vignette: f32,
  grain: f32,
  halation: f32,
  strength: f32,
  shadowsLift: f32,
  highlightsGain: f32,
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

fn grade(cin: vec3f, uv: vec2f) -> vec3f {
  var c = cin;
  // exposure
  c = c * exp2(u.exposure);
  // matte floor
  let floorLift = u.fade * 0.18 + max(u.blackPoint, 0.0) * 0.5;
  c = c * (1.0 - floorLift) + vec3f(floorLift);
  c = c - vec3f(max(-u.blackPoint, 0.0) * 0.3);
  // shadows lift (luminance, shadow-masked)
  let lLift = dot(c, W);
  let sWl = 1.0 - smoothstep(0.0, 0.5, lLift);
  c = c + vec3f(u.shadowsLift * 0.15 * sWl);
  // contrast
  c = (c - vec3f(0.5)) * (1.0 + u.contrast) + vec3f(0.5);
  // gamma
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / (1.0 + u.gamma * 0.6)));
  // temp / tint
  c.r = c.r + u.temp * 0.10; c.b = c.b - u.temp * 0.10;
  c.r = c.r + u.tint * 0.05; c.b = c.b + u.tint * 0.05; c.g = c.g - u.tint * 0.05;
  // split tone
  let l = dot(c, W);
  let sW = 1.0 - smoothstep(0.0, 0.5, l);
  let hW = smoothstep(0.5, 1.0, l);
  c.r = c.r - u.shadowTone * 0.10 * sW;    c.b = c.b + u.shadowTone * 0.10 * sW;
  c.r = c.r + u.highlightTone * 0.10 * hW; c.b = c.b - u.highlightTone * 0.10 * hW;
  c.r = c.r - u.splitWarm * 0.08 * sW;     c.b = c.b + u.splitWarm * 0.10 * sW;
  c.r = c.r + u.splitWarm * 0.10 * hW;     c.b = c.b - u.splitWarm * 0.08 * hW;
  // highlights gain (luminance, highlight-masked)
  c = c * (1.0 + u.highlightsGain * 0.25 * hW);
  // saturation + vibrance
  let l2 = dot(c, W);
  c = mix(vec3f(l2), c, u.saturation);
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let vib = u.vibrance * (1.0 - (mx - mn));
  c = mix(vec3f(l2), c, 1.0 + vib);
  // vignette
  let d = length(uv - vec2f(0.5)) * 1.4142136;
  c = c * (1.0 - u.vignette * smoothstep(0.5, 1.0, d));
  // halation
  let hl = max(l2 - 0.6, 0.0) * 2.5;
  c = c + u.halation * hl * vec3f(0.30, 0.12, 0.04);
  // grain
  let n = hash(uv * 1024.0 + vec2f(u.time));
  c = c + u.grain * (n - 0.5) * 0.15;
  return c;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let src = sampleSrc(in.uv).rgb;
  let g = clamp(grade(src, in.uv), vec3f(0.0), vec3f(1.0));
  return vec4f(mix(src, g, u.strength), 1.0);
}
`;

export const GRADE_SPEC: FxWebGPUSpec = {
  name: "grade",
  wgsl: GRADE_WGSL,
  uniformFields: [
    { name: "exposure", type: "f1" },
    { name: "contrast", type: "f1" },
    { name: "saturation", type: "f1" },
    { name: "vibrance", type: "f1" },
    { name: "temp", type: "f1" },
    { name: "tint", type: "f1" },
    { name: "shadowTone", type: "f1" },
    { name: "highlightTone", type: "f1" },
    { name: "splitWarm", type: "f1" },
    { name: "blackPoint", type: "f1" },
    { name: "fade", type: "f1" },
    { name: "gamma", type: "f1" },
    { name: "vignette", type: "f1" },
    { name: "grain", type: "f1" },
    { name: "halation", type: "f1" },
    { name: "strength", type: "f1" },
    { name: "shadowsLift", type: "f1" },
    { name: "highlightsGain", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
