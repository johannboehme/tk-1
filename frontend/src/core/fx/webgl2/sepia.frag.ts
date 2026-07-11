// SEPIA — Antique toned monochrome — a real luma to duotone print, paper-cream fade, fine grain, oval vignette.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const SEPIA_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_tone;
uniform float u_contrast;
uniform float u_fade;
uniform float u_grain;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 sepia(vec3 c, vec2 uv) {
  // 1. luma collapse — destroy all source chroma so this is a true
  //    monochrome re-tone, not a tint over colour.
  float l = dot(c, W);
  // 2. S-curve contrast about mid-grey via smoothstep, mixed in by
  //    u_contrast (0 = linear luma, no-op).
  float s = smoothstep(0.0, 1.0, l);
  l = mix(l, s, u_contrast);
  // 3. duotone anchors — shadow / mid / highlight. TONE rotates the
  //    palette: classic sepia at 0, cool selenium at -1, copper at +1.
  float warm = u_tone * 0.5;
  vec3 shadowCol = vec3(0.13, 0.09, 0.05) + vec3(warm * 0.05, -warm * 0.01, -warm * 0.03);
  vec3 midCol    = vec3(0.52, 0.38, 0.24) + vec3(warm * 0.10,  warm * 0.01, -warm * 0.10);
  vec3 highCol   = vec3(0.96, 0.87, 0.72) + vec3(warm * 0.02, -warm * 0.01, -warm * 0.08);
  // 4. matte fade — lift shadow anchor toward paper, pull highlight down.
  vec3 paper = vec3(0.86, 0.79, 0.66);
  shadowCol = mix(shadowCol, paper, u_fade * 0.55);
  highCol = mix(highCol, midCol, u_fade * 0.30);
  // 5. luma -> duotone ramp: shadow->mid in lower half, mid->high in upper.
  vec3 lower = mix(shadowCol, midCol, smoothstep(0.0, 0.5, l));
  vec3 upper = mix(midCol, highCol, smoothstep(0.5, 1.0, l));
  vec3 toned = mix(lower, upper, step(0.5, l));
  // 6. oval vignette — feather corners; aspect-squash gives an oval.
  vec2 d = (uv - 0.5) * vec2(1.15, 1.0);
  float r = length(d) * 1.4142136;
  toned *= 1.0 - 0.45 * smoothstep(0.55, 1.0, r);
  // 7. fine toner grain — frame-coherent, re-rolls with u_time.
  float n = hash(uv * 1024.0 + u_time);
  toned += u_grain * (n - 0.5) * 0.12;
  return toned;
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  vec3 e = clamp(sepia(src, v_uv), 0.0, 1.0);
  fragColor = vec4(mix(src, e, u_amount), 1.0);
}
`;
