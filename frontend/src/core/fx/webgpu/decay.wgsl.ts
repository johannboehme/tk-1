// Decay — WGSL port (parity with decay.frag.ts).
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const DECAY_WGSL = `struct Uniforms {
  dust: f32,
  scratches: f32,
  flicker: f32,
  leak: f32,
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

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 91.345) * 43758.5453);
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

const W = vec3f(0.299, 0.587, 0.114);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // 24fps projector gate — the stepped time base for all dirt + judder.
  let gate = floor(u.time * 24.0);

  // ---- 1. Gate weave / jitter -----------------------------------------
  let jx = (hash11(gate) - 0.5) * 0.012 * u.flicker;
  let jy = (hash11(gate + 47.0) - 0.5) * 0.008 * u.flicker;
  let uv = clamp(in.uv + vec2f(jx, jy), vec2f(0.0), vec2f(1.0));

  var col = sampleSrc(uv).rgb;

  // ---- 2. Light leaks (continuous, NOT gate-stepped) ------------------
  let c0 = vec2f(0.5 + 0.42 * sin(u.time * 0.41), 0.5 + 0.40 * cos(u.time * 0.53));
  let c1 = vec2f(0.5 + 0.45 * cos(u.time * 0.31 + 2.1), 0.5 + 0.38 * sin(u.time * 0.61 + 1.3));
  let d0 = length((uv - c0) * vec2f(1.0, 0.75));
  let d1 = length((uv - c1) * vec2f(1.0, 0.75));
  let bloom0 = exp(-d0 * d0 * 7.0);
  let bloom1 = exp(-d1 * d1 * 9.0) * 0.7;
  let leakPulse = 0.7 + 0.3 * hash11(gate + 11.0);
  let leakColor = vec3f(1.0, 0.62, 0.26);
  col = col + leakColor * (bloom0 + bloom1) * u.leak * leakPulse * 0.9;

  // ---- 3. Blown highlights / halation ---------------------------------
  let l = dot(col, W);
  let hot = max(l - 0.62, 0.0) * 2.6;
  col = col + vec3f(0.32, 0.16, 0.06) * hot * (0.4 + u.leak * 1.2);

  // ---- 4. Vertical scratches ------------------------------------------
  var scratch = 0.0;
  for (var i = 0; i < 6; i = i + 1) {
    let fi = f32(i);
    let seed = hash21(vec2f(fi * 3.0, gate));
    let xPos = hash11(fi * 17.0) * 0.95 + 0.025 + (seed - 0.5) * 0.03;
    let on = step(0.55 - u.scratches * 0.5, hash11(fi * 7.0 + gate * 1.7));
    let dx = abs(uv.x - xPos);
    let line = exp(-dx * dx * 90000.0);
    var polarity = -1.0;
    if (hash11(fi * 5.0) < 0.5) {
      polarity = 1.0;
    }
    scratch = scratch + line * on * polarity * (0.5 + 0.5 * hash11(fi + gate * 2.3));
  }
  col = col + vec3f(scratch) * u.scratches * 0.6;

  // ---- 5. Dust specks + hair ------------------------------------------
  let grid = vec2f(64.0, 36.0);
  let cell = floor(uv * grid);
  let frac = fract(uv * grid);
  let cellSeed = hash21(cell + vec2f(gate * 0.013, gate * 0.027));
  let present = step(1.0 - u.dust * 0.10, cellSeed);
  let spotPos = vec2f(hash21(cell + 3.1), hash21(cell + 7.7));
  let dd = length(frac - spotPos);
  let speck = (1.0 - smoothstep(0.06, 0.18, dd)) * present;
  var darkOrLight = 0.7;
  if (hash21(cell + 19.0) < 0.82) {
    darkOrLight = -1.0;
  }
  col = col + vec3f(speck * darkOrLight * 0.9);

  let hairY = hash11(gate + 88.0);
  let hairCurve = hairY + sin(uv.x * 9.0 + gate) * 0.05 * hash11(gate + 5.0);
  let hairD = abs(uv.y - hairCurve);
  var hair = (1.0 - smoothstep(0.0015, 0.006, hairD)) * step(0.5, u.dust);
  hair = hair * step(0.6, hash11(gate + 123.0));
  col = col - vec3f(hair * 0.5 * u.dust);

  // ---- 6. Per-frame brightness flicker --------------------------------
  let flick = 1.0 + (hash11(gate + 31.0) - 0.5) * 0.35 * u.flicker;
  col = col * flick;

  let decayed = clamp(col, vec3f(0.0), vec3f(1.0));
  let src = sampleSrc(in.uv).rgb;
  return vec4f(mix(src, decayed, u.amount), 1.0);
}
`;

export const DECAY_SPEC: FxWebGPUSpec = {
  name: "decay",
  wgsl: DECAY_WGSL,
  uniformFields: [
    { name: "dust", type: "f1" },
    { name: "scratches", type: "f1" },
    { name: "flicker", type: "f1" },
    { name: "leak", type: "f1" },
    { name: "amount", type: "f1" },
    { name: "time", type: "f1" },
  ],
};
