/**
 * WGSL-Port von zoom.frag.ts. Beat-Pump-Zoom: sampelt die Source mit
 * einer asymmetrischen Pulse-Skalierung um das Bild-Center.
 *
 * Replace-Blend.
 */
import type { FxWebGPUSpec } from "../../render/webgpu/pipeline-cache";

export const ZOOM_WGSL = `
struct Uniforms {
  punch: f32,
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = clamp(u.phase, 0.0, 1.0);
  let pulse = pow(1.0 - p, 4.0);
  let zoom = 1.0 + u.punch * 0.30 * pulse;
  let c = in.uv - vec2f(0.5);
  var sampleUv = c / zoom + vec2f(0.5);
  sampleUv = clamp(sampleUv, vec2f(0.0), vec2f(1.0));
  return sampleSrc(sampleUv);
}
`;

export const ZOOM_SPEC: FxWebGPUSpec = {
  name: "zoom",
  wgsl: ZOOM_WGSL,
  uniformFields: [
    { name: "punch", type: "f1" },
    { name: "phase", type: "f1" },
  ],
};
