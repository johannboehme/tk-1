// Decay — Destroyed old film stock: dancing dust and hair, flickering vertical scratches, gate-judder, brightness stutter, and warm light-leaks that crawl across the frame.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const DECAY_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_dust;
uniform float u_scratches;
uniform float u_flicker;
uniform float u_leak;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

float hash11(float x) {
  return fract(sin(x * 91.345) * 43758.5453);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // 24fps projector gate — the stepped time base for all dirt + judder.
  float gate = floor(u_time * 24.0);

  // ---- 1. Gate weave / jitter -----------------------------------------
  // Whole frame nudges a few pixels each gate frame. Driven by flicker so
  // flicker=0 → no weave. Two hashes give an irregular x/y wobble.
  float jx = (hash11(gate) - 0.5) * 0.012 * u_flicker;
  float jy = (hash11(gate + 47.0) - 0.5) * 0.008 * u_flicker;
  vec2 uv = clamp(v_uv + vec2(jx, jy), 0.0, 1.0);

  vec3 col = texture(u_source, uv).rgb;

  // ---- 2. Light leaks (continuous, NOT gate-stepped) ------------------
  // Two warm amber blooms crawl across the frame on slow sin/cos paths.
  vec2 c0 = vec2(0.5 + 0.42 * sin(u_time * 0.41), 0.5 + 0.40 * cos(u_time * 0.53));
  vec2 c1 = vec2(0.5 + 0.45 * cos(u_time * 0.31 + 2.1), 0.5 + 0.38 * sin(u_time * 0.61 + 1.3));
  float d0 = length((uv - c0) * vec2(1.0, 0.75));
  float d1 = length((uv - c1) * vec2(1.0, 0.75));
  float bloom0 = exp(-d0 * d0 * 7.0);
  float bloom1 = exp(-d1 * d1 * 9.0) * 0.7;
  // Leaks pulse a little on the gate so they "breathe" like a damaged seal.
  float leakPulse = 0.7 + 0.3 * hash11(gate + 11.0);
  vec3 leakColor = vec3(1.0, 0.62, 0.26);
  col += leakColor * (bloom0 + bloom1) * u_leak * leakPulse * 0.9;

  // ---- 3. Blown highlights / halation ---------------------------------
  // Decaying prints lose their highlight shoulder — bright areas bloom warm.
  float l = dot(col, W);
  float hot = max(l - 0.62, 0.0) * 2.6;
  col += vec3(0.32, 0.16, 0.06) * hot * (0.4 + u_leak * 1.2);

  // ---- 4. Vertical scratches ------------------------------------------
  // Up to 6 thin vertical lines. Each has a per-gate x-position and an
  // on/off + brightness flicker, so they snap and twitch frame to frame.
  float scratch = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    // Re-roll x position every gate frame; some scratches drift slowly.
    float seed = hash21(vec2(fi * 3.0, gate));
    float xPos = hash11(fi * 17.0) * 0.95 + 0.025 + (seed - 0.5) * 0.03;
    // Per-gate on/off — only the lit ones contribute, gated by SCRATCH.
    float on = step(0.55 - u_scratches * 0.5, hash11(fi * 7.0 + gate * 1.7));
    float dx = abs(uv.x - xPos);
    // ~1px-ish hairline with a soft core.
    float line = exp(-dx * dx * 90000.0);
    // Half the scratches are bright (emulsion gouge), half dark (dirt).
    float polarity = (hash11(fi * 5.0) < 0.5) ? 1.0 : -1.0;
    scratch += line * on * polarity * (0.5 + 0.5 * hash11(fi + gate * 2.3));
  }
  col += vec3(scratch) * u_scratches * 0.6;

  // ---- 5. Dust specks + hair ------------------------------------------
  // Cell-hash dust: divide the frame into a grid; per cell, per gate, a
  // small chance a dark (or bright) speck sits at a hashed sub-position.
  vec2 grid = vec2(64.0, 36.0);
  vec2 cell = floor(uv * grid);
  vec2 frac = fract(uv * grid);
  float cellSeed = hash21(cell + vec2(gate * 0.013, gate * 0.027));
  // Density gated by DUST; even at full dust only a sparse set of cells fire.
  float present = step(1.0 - u_dust * 0.10, cellSeed);
  vec2 spotPos = vec2(hash21(cell + 3.1), hash21(cell + 7.7));
  float dd = length(frac - spotPos);
  float speck = (1.0 - smoothstep(0.06, 0.18, dd)) * present;
  // Mostly dark specks, occasional bright fleck.
  float darkOrLight = (hash21(cell + 19.0) < 0.82) ? -1.0 : 0.7;
  col += vec3(speck * darkOrLight * 0.9);

  // A single stray hair — a soft curved dark thread that repositions per gate.
  float hairY = hash11(gate + 88.0);
  float hairCurve = hairY + sin(uv.x * 9.0 + gate) * 0.05 * hash11(gate + 5.0);
  float hairD = abs(uv.y - hairCurve);
  float hair = (1.0 - smoothstep(0.0015, 0.006, hairD)) * step(0.5, u_dust);
  hair *= step(0.6, hash11(gate + 123.0)); // hair only flickers in sometimes
  col -= vec3(hair * 0.5 * u_dust);

  // ---- 6. Per-frame brightness flicker --------------------------------
  // Multiplicative luma stutter on the gate; the projector lamp / aged
  // emulsion never holds a steady exposure.
  float flick = 1.0 + (hash11(gate + 31.0) - 0.5) * 0.35 * u_flicker;
  col *= flick;

  vec3 decayed = clamp(col, 0.0, 1.0);
  vec3 src = texture(u_source, v_uv).rgb;
  fragColor = vec4(mix(src, decayed, u_amount), 1.0);
}
`;
