/**
 * WGSL-Port von wear.frag.ts. VHS-Wear: head-misalignment, Y/C-Bleed,
 * Tracking-Bar, Sat/Luma-Wobble, multi-scale TV-Static, Dropout-Flecks,
 * Burn-in. Skaliert mit u.decay.
 *
 * Replace-Blend.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const WEAR_WGSL = `
struct Uniforms {
  decay:      f32,
  driftPhase: f32,
  t:          f32,
  _pad0:      f32,
  texel:      vec2f,
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

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // 1. Static head misalignment.
  let headMag = u.decay * 0.0035;
  let r = sampleSrc(in.uv + vec2f(-headMag, 0.0)).r;
  let g = sampleSrc(in.uv).g;
  let b = sampleSrc(in.uv + vec2f(headMag, 0.0)).b;
  var base = vec3f(r, g, b);

  // 2. Y/C-Bleed.
  let bleedDist = u.texel.x * 8.0;
  let sl = sampleSrc(in.uv + vec2f(-bleedDist, 0.0)).rgb;
  let sr = sampleSrc(in.uv + vec2f( bleedDist, 0.0)).rgb;
  let sChroma = (sl - vec3f(luma(sl))) * 0.5 + (sr - vec3f(luma(sr))) * 0.5;
  let baseLuma = luma(base);
  let myChroma = base - vec3f(baseLuma);
  base = vec3f(baseLuma) + mix(myChroma, sChroma, u.decay * 0.45);

  // 3. Tracking-bar.
  if (u.driftPhase >= 0.0) {
    let barY = fract(u.driftPhase);
    let dist = abs(in.uv.y - barY);
    let wraparound = min(dist, 1.0 - dist);
    let bar = exp(-pow(wraparound / 0.045, 2.0)) * u.decay * 0.18;
    let barTint = vec3f(1.0, 0.92, 0.75);
    base = base + barTint * bar;
  }

  // 4. Sat + luma wobble.
  let satWobble = sin(u.t * 1.7) * 0.13 + sin(u.t * 0.9) * 0.07;
  let satMul = clamp(1.0 - satWobble * u.decay, 0.0, 2.0);
  let wlSat = vec3f(luma(base));
  base = wlSat + (base - wlSat) * satMul;
  let lumWobble = sin(u.t * 2.3) * 0.06 * u.decay;
  base = base * (1.0 + lumWobble);

  // 5. TV-Static-Grain.
  let frame30 = floor(u.t * 30.0);
  let frame60 = floor(u.t * 60.0);
  let coarseGrid = floor(in.uv * 240.0);
  let coarse = hash2(coarseGrid + vec2f(frame30, frame30 * 1.7)) - 0.5;
  let fine = hash2(in.uv * 600.0 + vec2f(frame60, frame60 * 1.3)) - 0.5;
  let chR = hash2(coarseGrid + vec2f(frame30, frame30 * 1.7) + vec2f(11.3, 0.0)) - 0.5;
  let chG = hash2(coarseGrid + vec2f(frame30, frame30 * 1.7) + vec2f(0.0, 17.7)) - 0.5;
  let chB = hash2(coarseGrid + vec2f(frame30, frame30 * 1.7) + vec2f(31.1, 5.5)) - 0.5;
  let staticAmt = pow(u.decay, 1.4) * 0.35;
  let staticRgb =
      vec3f(coarse * 0.85)
    + vec3f(fine * 0.30)
    + vec3f(chR, chG, chB) * 0.20;
  base = base + staticRgb * staticAmt;

  // 6. Dropout flecks.
  let bucketY = floor(in.uv.y * 90.0);
  let bucketT = floor(u.t * 8.0);
  let fleckSeed = hash2(vec2f(bucketY, bucketT));
  let fleckActivity = max(0.0, u.decay - 0.6) / 0.4;
  let threshold = 0.998 - fleckActivity * 0.018;
  if (fleckSeed > threshold) {
    let blackOrWhite = step(0.5, hash2(vec2f(bucketY * 13.0, bucketT * 7.0)));
    base = mix(base, vec3f(blackOrWhite), 0.85);
  }

  // 7. Burn-in.
  let amber = vec3f(0.95, 0.78, 0.55);
  let lum = luma(base);
  let burnMask = smoothstep(0.18, 0.95, lum);
  base = mix(base, base * amber, burnMask * u.decay * 0.55);

  base = clamp(base, vec3f(0.0), vec3f(1.0));
  return vec4f(base, 1.0);
}
`;

export const WEAR_SPEC: FxWebGPUSpec = {
  name: "wear",
  wgsl: WEAR_WGSL,
  uniformFields: [
    { name: "decay", type: "f1" },
    { name: "driftPhase", type: "f1" },
    { name: "t", type: "f1" },
    // texel @ offset 16 (vec2 needs vec2-align, also struct enforces
    // 16-byte struct-alignment after a vec2 → padded by computeUniformLayout).
    { name: "texel", type: "f2" },
  ],
};
