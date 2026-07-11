/**
 * RGB-Split-Fragment-Shader. Source-Sampling-Effect: liest `u_source`
 * (das Layer-Pass-Output), trennt die R/G/B-Kanäle und sampled jeden
 * mit einem eigenen Offset entlang der ANGLE-Achse.
 *
 * - `u_source`     sampler2D — Layer-Pass-Output, vom Backend gebunden
 * - `u_split`      0..1      — Offset-Distanz (skaliert auf ~6 % der Frame-Breite)
 * - `u_angle`      0..1      — Richtung des Splits, 0 = horizontal, 0.25 = vertikal
 *
 * Output ist nicht-premultiplied vollopak — der Backend stellt den
 * Blend-Mode auf "replace", sodass diese Berechnung das Layer-Output
 * komplett ersetzt.
 */
export const RGB_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_split;
uniform float u_angle;
out vec4 fragColor;

void main() {
  // Max-Offset 6 % des UV-Raums. Bei split=0 verschmelzen die Kanäle
  // wieder zu Original.
  float magnitude = u_split * 0.06;
  // angle 0..1 → Richtungsvektor. 0 = (1,0) horizontal, 0.25 = (0,1)
  // vertikal, 0.5 = (-1,0), …
  float a = u_angle * 6.28318530718;
  vec2 dir = vec2(cos(a), sin(a)) * magnitude;
  // R links, G zentriert, B rechts vom Source-Sample.
  float r = texture(u_source, v_uv - dir).r;
  float g = texture(u_source, v_uv).g;
  float b = texture(u_source, v_uv + dir).b;
  fragColor = vec4(r, g, b, 1.0);
}
`;
