/**
 * TAPE-Stop-Fragment-Shader. Stateless Approximation eines analog-tape
 * Stopps — vertikale Scanline-Shifts + chromatic warp die mit der
 * BEND-Phase aufbauen. Echter Frame-Freeze braucht ein Feedback-Texture
 * (kommt in einer Backend-Refactor-Iteration).
 *
 * - `u_source`  sampler2D
 * - `u_warp`    0..1   — Master-Intensität der chromatic-Verzerrung
 *                        + zusätzliche band-Drift. WARP=0 → cleaner
 *                        slowdown ohne Farbsalat; WARP=1 → kompletter
 *                        Color-Bleed-Mess.
 * - `u_phase`   0..1   — One-shot 0→1 über die BEND-Periode (vom
 *                        catalog clamped, nicht modulo). Bei phase=1
 *                        hält der Effekt sein Maximum, weil Tape-Stop
 *                        eine einmalige Verlangsamung ist, kein LFO.
 *
 * Replace-Blend.
 */
export const TAPE_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_warp;
uniform float u_phase;
out vec4 fragColor;

float hash(float x) {
  return fract(sin(x * 91.345) * 43758.5453);
}

void main() {
  // Scanline displacement: divide screen into ~24 horizontal bands.
  // Each band slides by an amount proportional to phase × (0.5 + warp/2)
  // → minimal drift even at WARP=0 ("clean slow-down"), much more drift
  // at WARP=1 ("messy bleed"). Per-band pseudo-random magnitude.
  float band = floor(v_uv.y * 24.0);
  float bandRand = hash(band) - 0.5;
  float warpScale = 0.5 + u_warp * 0.5;
  float drift = u_phase * 0.06 * bandRand * warpScale;
  vec2 uv = v_uv;
  uv.x += drift;
  uv.x = clamp(uv.x, 0.0, 1.0);
  // Vertical pull: lower bands sag more with phase.
  uv.y -= u_phase * 0.025 * bandRand * warpScale;
  uv.y = clamp(uv.y, 0.0, 1.0);

  // Chromatic warp: R/B sample with horizontal offset that grows with
  // phase × warp. Coefficient is now 4× the original so the difference
  // between WARP=0 (no chrom split) and WARP=1 (heavy split) is loud.
  float chrom = u_phase * u_warp * 0.045;
  float r = texture(u_source, vec2(clamp(uv.x - chrom, 0.0, 1.0), uv.y)).r;
  float g = texture(u_source, uv).g;
  float b = texture(u_source, vec2(clamp(uv.x + chrom, 0.0, 1.0), uv.y)).b;

  // Tape grain — subtle white noise that intensifies with phase × warp.
  // Adds the "magnetic hiss" feel without needing a real noise texture.
  float grain = (hash(v_uv.x * 437.0 + v_uv.y * 813.0 + u_phase * 17.0) - 0.5);
  float grainAmt = u_phase * u_warp * 0.18;
  vec3 outRgb = vec3(r, g, b) + vec3(grain * grainAmt);

  // Tape losing speed → losing luminance. Independent of warp so the
  // "stop" feels real even with WARP=0.
  outRgb *= (1.0 - u_phase * 0.20);
  outRgb = clamp(outRgb, 0.0, 1.0);
  fragColor = vec4(outRgb, 1.0);
}
`;
