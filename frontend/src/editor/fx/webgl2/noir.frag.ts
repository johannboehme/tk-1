// NOIR — High-contrast black & white film with a colour-filter response, deep blacks, film grain and a heavy vignette.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const NOIR_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_filter;
uniform float u_contrast;
uniform float u_grain;
uniform float u_vignette;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

// Panchromatic (neutral) B&W luma weights — the FILTER param leans these
// toward red-response or blue-response and we renormalise so overall
// brightness stays put.
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 noir(vec3 c, vec2 uv) {
  // 1. Colour-filter response. A red filter (u_filter<0) boosts the red
  //    channel weight (warm tones bright) and cuts blue (skies dark); a
  //    blue filter (u_filter>0) does the inverse. Green is the anchor.
  float warm = max(-u_filter, 0.0); // red-filter strength
  float cool = max( u_filter, 0.0); // blue-filter strength
  vec3 w = LUMA;
  w.r += warm * 0.55 - cool * 0.22;
  w.b += cool * 0.55 - warm * 0.22;
  w = max(w, vec3(0.0));
  w /= max(w.r + w.g + w.b, 1e-4); // renormalise → preserve overall exposure
  float mono = dot(c, w);

  // 2. Filmic S-curve about mid-grey — deep blacks, snappy mids. At
  //    u_contrast=0 the smoothstep-blend collapses to the identity value.
  float s = smoothstep(0.0, 1.0, mono);          // toe + shoulder
  s = mix(mono, s, u_contrast);
  // Extra black-point bite that scales with contrast (deep noir blacks).
  s = max(s - u_contrast * 0.06, 0.0);
  // Re-expand a touch so highlights stay glossy.
  s = s * (1.0 + u_contrast * 0.10);
  mono = clamp(s, 0.0, 1.0);

  // 3. Film grain — frame-coherent at ~24fps, luma-modulated so it lives
  //    in the shadows/mids (clean highlights), like real emulsion.
  float frame = floor(u_time * 24.0);
  float n = hash(uv * 1024.0 + vec2(frame, frame * 1.7)) - 0.5;
  float grainMask = (1.0 - smoothstep(0.55, 1.0, mono)) * (0.35 + mono * 0.65);
  mono += u_grain * n * 0.18 * grainMask;

  // 4. Heavy noir vignette — circular spotlight pull-down.
  float d = length(uv - 0.5) * 1.4142136;
  mono *= 1.0 - u_vignette * smoothstep(0.35, 1.0, d);

  return vec3(clamp(mono, 0.0, 1.0));
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  vec3 n = noir(src, v_uv);
  fragColor = vec4(mix(src, n, u_amount), 1.0);
}
`;
