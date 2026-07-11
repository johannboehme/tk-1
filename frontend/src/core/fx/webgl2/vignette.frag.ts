/**
 * GLSL-300-es-Fragment-Shader für die Vignette-FX.
 *
 * Vertex-Output `v_uv` ist [0..1] über das Output-Quad. Wir rechnen den
 * radial-falloff vom Zentrum zur Ecke (max-radius = √2 / 2 ≈ 0.707), der
 * smoothstep-Range wird über `u_falloff` gesteuert: bei falloff=1 startet
 * das Dunkeln im Zentrum, bei falloff=0 nur an der äußeren Ecke.
 *
 * Output ist *transparent über schwarz* — der Compositor blendet die
 * vignette per `gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` additiv über
 * die zuvor gerenderte Source-Layer. Kein Read-Pixel des Videos nötig.
 */
export const VIGNETTE_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform float u_intensity;
uniform float u_falloff;
out vec4 fragColor;
void main() {
  vec2 p = v_uv - 0.5;
  // length(p) ranges 0 (centre) → 0.707 (corner). Normalise to 0..1.
  float r = length(p) * 1.4142136;
  float a = smoothstep(1.0 - u_falloff, 1.0, r) * u_intensity;
  fragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/** Gemeinsamer Fullscreen-Quad-Vertex-Shader. Wird von jedem FX-Programm
 *  verwendet — der gleiche Shader, nur die Fragments unterscheiden sich. */
export const FULLSCREEN_VERT = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
