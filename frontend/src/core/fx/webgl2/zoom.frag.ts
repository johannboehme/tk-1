/**
 * ZOOM-Fragment-Shader. Beat-Pump auf das Source-Layer.
 *
 * - `u_source`  sampler2D
 * - `u_punch`   0..1   — Maximaler Zoom (0 = no-op, 1 = bis +30 %)
 * - `u_phase`   0..1   — Aktuelle LFO-Phase (0..1 → eine volle Pulse).
 *                        Wird vom Backend aus capsule-local time +
 *                        RATE-Param berechnet (siehe catalog.ts).
 *
 * Pulse-Form: gauss-artig kurz nach dem Beat (asymmetrisch, schnelles
 * Anschnappen, langsames Auslaufen). Macht den klassischen Kick-Zoom-
 * Punch der dem Audio-Beat-Detect-Look ähnelt.
 *
 * Replace-Blend — Output ersetzt das Layer-Output.
 */
export const ZOOM_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_punch;
uniform float u_phase;
out vec4 fragColor;

void main() {
  // Asymmetric pulse: snap up at phase=0, decay over the rest of the cycle.
  // pow shape with attack of ~5 % cycle then exponential decay.
  float p = clamp(u_phase, 0.0, 1.0);
  float pulse = pow(1.0 - p, 4.0);
  float zoom = 1.0 + u_punch * 0.30 * pulse;
  // Sample around the centre with the inverse of zoom (zoom-in = sample
  // a smaller window).
  vec2 c = v_uv - 0.5;
  vec2 sampleUv = c / zoom + 0.5;
  // Outside the source: just clamp — pads outside transparent black.
  sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0));
  fragColor = texture(u_source, sampleUv);
}
`;
