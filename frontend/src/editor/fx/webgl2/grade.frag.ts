/**
 * Global color-grade fragment shader (WebGL2 / GLSL 300 es).
 *
 * Source-sampling REPLACE effect: reads the pre-FX snapshot (`u_source`),
 * runs the fixed grade pipeline, and outputs `mix(source, graded, strength)`
 * so strength=0 is a literal identity pass. Every stage is a no-op at its
 * default, so a look only pays for the params it sets.
 *
 * Bit-parity contract: the WGSL port in `../webgpu/grade.wgsl.ts` performs
 * the EXACT same operations in the EXACT same order with the same constants.
 * `precision highp float` matches WGSL f32 so the two GPU backends agree to
 * ±1 LSB on the deterministic colour stages (grain/halation excluded — they
 * use a sin-hash whose last bit is driver-dependent).
 *
 * Stage order: exposure → matte(fade+blackPoint) → contrast → gamma →
 * temp/tint → split-tone(shadow/highlight/splitWarm) → saturation+vibrance →
 * vignette → halation → grain → strength mix.
 */
export const GRADE_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_vibrance;
uniform float u_temp;
uniform float u_tint;
uniform float u_shadowTone;
uniform float u_highlightTone;
uniform float u_splitWarm;
uniform float u_blackPoint;
uniform float u_fade;
uniform float u_gamma;
uniform float u_vignette;
uniform float u_grain;
uniform float u_halation;
uniform float u_strength;
uniform float u_shadowsLift;
uniform float u_highlightsGain;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 grade(vec3 c, vec2 uv) {
  // exposure (linear stops)
  c *= exp2(u_exposure);
  // matte floor: fade + positive blackPoint lift; negative blackPoint crush
  float floorLift = u_fade * 0.18 + max(u_blackPoint, 0.0) * 0.5;
  c = c * (1.0 - floorLift) + floorLift;
  c = c - max(-u_blackPoint, 0.0) * 0.3;
  // shadows lift (luminance, shadow-masked) — lift before the curve
  float lLift = dot(c, W);
  float sWl = 1.0 - smoothstep(0.0, 0.5, lLift);
  c += u_shadowsLift * 0.15 * sWl;
  // contrast about mid-grey
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
  // gamma (midtone bend)
  c = pow(max(c, 0.0), vec3(1.0 / (1.0 + u_gamma * 0.6)));
  // temp / tint
  c.r += u_temp * 0.10; c.b -= u_temp * 0.10;
  c.r += u_tint * 0.05; c.b += u_tint * 0.05; c.g -= u_tint * 0.05;
  // split tone
  float l = dot(c, W);
  float sW = 1.0 - smoothstep(0.0, 0.5, l);
  float hW = smoothstep(0.5, 1.0, l);
  c.r -= u_shadowTone * 0.10 * sW;    c.b += u_shadowTone * 0.10 * sW;
  c.r += u_highlightTone * 0.10 * hW; c.b -= u_highlightTone * 0.10 * hW;
  c.r -= u_splitWarm * 0.08 * sW;     c.b += u_splitWarm * 0.10 * sW;
  c.r += u_splitWarm * 0.10 * hW;     c.b -= u_splitWarm * 0.08 * hW;
  // highlights gain (luminance, highlight-masked)
  c *= 1.0 + u_highlightsGain * 0.25 * hW;
  // saturation + vibrance (luma-weighted, no HSV)
  float l2 = dot(c, W);
  c = mix(vec3(l2), c, u_saturation);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float vib = u_vibrance * (1.0 - (mx - mn));
  c = mix(vec3(l2), c, 1.0 + vib);
  // vignette
  float d = length(uv - 0.5) * 1.4142136;
  c *= 1.0 - u_vignette * smoothstep(0.5, 1.0, d);
  // halation (warm highlight glow)
  float hl = max(l2 - 0.6, 0.0) * 2.5;
  c += u_halation * hl * vec3(0.30, 0.12, 0.04);
  // grain (frame-coherent luma hash)
  float n = hash(uv * 1024.0 + u_time);
  c += u_grain * (n - 0.5) * 0.15;
  return c;
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  vec3 g = clamp(grade(src, v_uv), 0.0, 1.0);
  fragColor = vec4(mix(src, g, u_strength), 1.0);
}
`;
