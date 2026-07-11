/**
 * UV-Glow-Fragment-Shader. "Blacklight"-Stil:
 *  - Schatten gehen tief blau-violett (UV-Ambient-Look)
 *  - Highlights werden zu saturierten Neon-Farben (magenta↔cyan)
 *  - Bloom: 9-tap radial blur, additiv über die getroffenen Pixel
 *  - Mid-Tones bekommen einen Schub Saturation entlang der Tint-Achse
 *
 * Aggressive Tone-Curve (s-shape) macht das Bild Hochkontrast und
 * sortiert die Pixel klar in "fast schwarz" oder "leuchtend bunt".
 *
 * - `u_source`  sampler2D
 * - `u_glow`    0..1   — Bloom-Stärke + Highlight-Boost
 * - `u_tint`    0..1   — Cyan ↔ Magenta (0 = magenta, 1 = cyan)
 * - `u_texel`   vec2   — 1/textureSize für sample offsets
 *
 * Replace-Blend.
 */
export const UV_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_glow;
uniform float u_tint;
uniform vec2 u_texel;
out vec4 fragColor;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec3 base = texture(u_source, v_uv).rgb;

  // 9-tap radial blur over u_source — radius scales with glow.
  vec3 blur = vec3(0.0);
  float r = 8.0 + u_glow * 18.0;
  vec2 d = u_texel * r;
  blur += texture(u_source, v_uv).rgb * 0.30;
  blur += texture(u_source, v_uv + vec2( d.x,  0.0)).rgb * 0.0875;
  blur += texture(u_source, v_uv + vec2(-d.x,  0.0)).rgb * 0.0875;
  blur += texture(u_source, v_uv + vec2( 0.0,  d.y)).rgb * 0.0875;
  blur += texture(u_source, v_uv + vec2( 0.0, -d.y)).rgb * 0.0875;
  blur += texture(u_source, v_uv + vec2( d.x,  d.y) * 0.7071).rgb * 0.0625;
  blur += texture(u_source, v_uv + vec2(-d.x,  d.y) * 0.7071).rgb * 0.0625;
  blur += texture(u_source, v_uv + vec2( d.x, -d.y) * 0.7071).rgb * 0.0625;
  blur += texture(u_source, v_uv + vec2(-d.x, -d.y) * 0.7071).rgb * 0.0625;

  // Tint axis: magenta ↔ cyan. The third anchor (deep violet) sits
  // under the shadows so the look stays "blacklight" rather than
  // generic "neon".
  vec3 magenta = vec3(1.0, 0.10, 0.95);
  vec3 cyan = vec3(0.10, 0.95, 1.0);
  vec3 highlight = mix(magenta, cyan, u_tint);
  vec3 violet = vec3(0.10, 0.04, 0.18);

  // Aggressive S-curve on luma → push shadows toward violet, mids
  // toward saturated tint, highlights to saturated neon.
  float l = luma(base);
  float lo = smoothstep(0.0, 0.45, l);  // 0..1 across shadows→mid
  float hi = smoothstep(0.55, 0.95, l); // 0..1 across mid→highlight

  // Shadow → violet, mid → tint at moderate brightness, highlight → tint full neon.
  vec3 shadowOut = violet;
  vec3 midOut = highlight * (0.55 + lo * 0.30); // grows brighter into the mid
  vec3 highOut = highlight * (1.0 + u_glow * 0.6); // can punch over 1.0 → bloom
  vec3 tonemapped = mix(shadowOut, midOut, lo);
  tonemapped = mix(tonemapped, highOut, hi);

  // Add the blurred highlights ON TOP, weighted by their own brightness.
  // This is the "halation" — bright pixels bleed into their neighbours.
  float blurL = luma(blur);
  float halationMask = smoothstep(0.45, 0.85, blurL);
  vec3 halation = blur * highlight * halationMask * (0.8 + u_glow * 1.2);

  vec3 outRgb = tonemapped + halation;

  // Subtle chromatic offset on the high-contrast edges — sells the
  // "X-ray film" energy. Cheap fake: blend a tiny amount of sideways
  // sample weighted by halation strength.
  float chrom = u_glow * 0.004;
  if (chrom > 0.0) {
    float rChan = texture(u_source, v_uv + vec2(-chrom, 0.0)).r * highlight.r;
    float bChan = texture(u_source, v_uv + vec2( chrom, 0.0)).b * highlight.b;
    outRgb.r += rChan * halationMask * 0.25;
    outRgb.b += bChan * halationMask * 0.25;
  }

  outRgb = clamp(outRgb, 0.0, 1.0);
  fragColor = vec4(outRgb, 1.0);
}
`;
