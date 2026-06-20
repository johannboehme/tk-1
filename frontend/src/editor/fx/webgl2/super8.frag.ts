// SUPER-8 — 8mm home-movie stock — heavy organic grain, warm faded color, gate weave, exposure flicker and halation glow.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const SUPER8_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_grain;
uniform float u_weave;
uniform float u_flicker;
uniform float u_warmth;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // — Gate weave: displace the sampling UV with two incommensurate
  //   sines per axis so the frame drifts organically over time.
  float wx = sin(u_time * 5.7) * 0.6 + sin(u_time * 11.3 + 1.7) * 0.4;
  float wy = sin(u_time * 4.3 + 2.1) * 0.6 + sin(u_time * 9.1 + 0.5) * 0.4;
  vec2 weaveUv = v_uv + vec2(wx * u_weave * 0.012, wy * u_weave * 0.010);
  weaveUv = clamp(weaveUv, 0.0, 1.0);

  vec3 src = texture(u_source, v_uv).rgb;
  vec3 c = texture(u_source, weaveUv).rgb;

  // — Flicker: global exposure pulse (projector lamp wobble).
  float flick = 1.0 + u_flicker * (sin(u_time * 8.0) * 0.5 + sin(u_time * 21.7 + 1.3) * 0.5) * 0.12;
  c *= flick;

  // — Warm faded stock: matte floor (lift blacks toward a warm dark),
  //   crush the very bottom a touch, then push an amber tint.
  float lift = u_warmth * 0.10;
  c = c * (1.0 - lift) + lift * vec3(0.06, 0.04, 0.02);
  c = c - u_warmth * 0.02;
  c.r += u_warmth * 0.10;
  c.g += u_warmth * 0.03;
  c.b -= u_warmth * 0.08;
  // gentle warm contrast lift so it doesn't go flat
  c = (c - 0.5) * (1.0 + u_warmth * 0.12) + 0.5;

  // — Halation: warm bloom added on the highlights of the (weaved) frame.
  float l = dot(c, W);
  float hl = max(l - 0.55, 0.0) * 2.2;
  c += u_warmth * hl * vec3(0.34, 0.14, 0.05);

  // — Vignette: soft corner darken, scaled by warmth.
  float d = length(v_uv - 0.5) * 1.4142136;
  c *= 1.0 - u_warmth * 0.55 * smoothstep(0.45, 1.0, d);

  // — Organic grain: per-FILM-frame luma hash (24fps quantized time) so
  //   the pattern jumps each frame instead of smoothly sliding.
  float frame = floor(u_time * 24.0);
  float n = hash(v_uv * 1024.0 + vec2(frame, frame * 1.7));
  c += u_grain * (n - 0.5) * 0.22;

  c = clamp(c, 0.0, 1.0);
  fragColor = vec4(mix(src, c, u_amount), 1.0);
}
`;
