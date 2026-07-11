/**
 * ECHO-Fragment-Shader. Stateless multi-tap "trail" — sampled das
 * Source-Layer an mehreren Offsets entlang einer rotierenden Achse,
 * gewichtet mit Decay. Ist KEIN echter frame-feedback (das wäre ein
 * separater Pass mit feedbackTex), aber liefert visuell den
 * Schweif-Eindruck eines Echo solange das Bild bewegt ist.
 *
 * - `u_source`  sampler2D
 * - `u_trail`   0..1   — Schweif-Länge (skaliert auf max ~10 % UV)
 * - `u_mix`     0..1   — Mix der Trail-Echos über das Original
 * - `u_phase`   0..1   — LFO-Phase (vom Backend aus capsule-time +
 *                        TRAIL-Param berechnet); rotiert die Achse
 *                        leicht so dass der Schweif "lebt".
 *
 * Replace-Blend.
 */
export const ECHO_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_trail;
uniform float u_mix;
uniform float u_phase;
out vec4 fragColor;

void main() {
  vec3 base = texture(u_source, v_uv).rgb;
  if (u_mix <= 0.001 || u_trail <= 0.001) {
    fragColor = vec4(base, 1.0);
    return;
  }
  // Trail axis: rotates with phase so the trail breathes on every beat.
  float a = u_phase * 6.28318530718;
  vec2 axis = vec2(cos(a), sin(a)) * (u_trail * 0.10);
  // 5 taps backwards along axis, exponentially decaying weights.
  vec3 trail = vec3(0.0);
  float wsum = 0.0;
  for (int i = 1; i <= 5; i++) {
    float fi = float(i) / 5.0;
    float w = exp(-fi * 2.5);
    vec2 uv = clamp(v_uv - axis * fi, vec2(0.0), vec2(1.0));
    trail += texture(u_source, uv).rgb * w;
    wsum += w;
  }
  trail /= max(wsum, 0.0001);
  vec3 outRgb = mix(base, max(base, trail), u_mix);
  fragColor = vec4(outRgb, 1.0);
}
`;
