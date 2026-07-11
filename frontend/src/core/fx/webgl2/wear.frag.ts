/**
 * WEAR-Fragment-Shader. Vintage-VHS-Verschleiß als kontinuierlicher
 * Zustand (≠ TAPE, das ist eine einmalige Verlangsamungs-Aktion).
 *
 * Komponenten — alle skalieren mit DECAY, sodass DECAY=0 ein clean-pass
 * und DECAY=1 ein totales Wrack ergibt:
 *
 *  1. **Static head misalignment** — winziger permanenter R/B-Offset
 *  2. **Y/C-Bleed** — saturierte Pixel "schmieren" horizontal in die
 *     Nachbarpixel (klassischer NTSC-Y/C-Trennungs-Bug)
 *  3. **Tracking-Bar** — eine schwach amber-getintete (NICHT weiße)
 *     horizontale Bar wandert vertikal mit DRIFT-Geschwindigkeit. Sehr
 *     subtil — soll wie Tape-Tracking-Drift wirken, kein TV-Strobe.
 *     OFF-Detent (u_driftPhase = -1) versteckt die Bar
 *  4. **Sat + Luma Wobble** — zwei phasenverschobene Sinus-Wellen geben
 *     der Sättigung und Helligkeit einen unregelmäßigen Atem
 *  5. **TV-Static-Grain** — Multi-scale Rauschen: grobe Blöcke (~5px)
 *     dominieren das Bild, feines Pixel-Korn modulisiert obendrauf,
 *     plus subtile Pro-Channel-Variation für Static-Chroma-Fringe.
 *     Die Block-Inhalte ändern sich pro Frame (frame-coherent), die
 *     Block-POSITIONEN driften nicht — fühlt sich wie analog-TV-Static
 *     an, nicht wie scrolling Film-Grain
 *  6. **Dropout-Flecken** — bei DECAY > 0.6 erscheinen gelegentliche
 *     kurze schwarz/weiße Linien-Artefakte
 *  7. **Burn-in** — Highlights bekommen einen warm-amber Tint (Tape-
 *     Magnetalterung), Shadows bleiben neutral. Ersetzt das frühere
 *     globale Desaturieren — der Charakter des Bildes bleibt so
 *     erhalten, kriegt aber den "altes Tape"-Yellow-Cast
 *
 * Replace-Blend.
 */
export const WEAR_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_decay;
uniform float u_driftPhase;
uniform float u_t;
uniform vec2 u_texel;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  // 1. Static head misalignment.
  float headMag = u_decay * 0.0035;
  float r = texture(u_source, v_uv + vec2(-headMag, 0.0)).r;
  float g = texture(u_source, v_uv).g;
  float b = texture(u_source, v_uv + vec2(headMag, 0.0)).b;
  vec3 base = vec3(r, g, b);

  // 2. Y/C-Bleed.
  float bleedDist = u_texel.x * 8.0;
  vec3 sl = texture(u_source, v_uv + vec2(-bleedDist, 0.0)).rgb;
  vec3 sr = texture(u_source, v_uv + vec2( bleedDist, 0.0)).rgb;
  vec3 sChroma = (sl - vec3(luma(sl))) * 0.5 + (sr - vec3(luma(sr))) * 0.5;
  float baseLuma = luma(base);
  vec3 myChroma = base - vec3(baseLuma);
  base = vec3(baseLuma) + mix(myChroma, sChroma, u_decay * 0.45);

  // 3. Tracking-bar — subdued amber tint, not pure white.
  if (u_driftPhase >= 0.0) {
    float barY = fract(u_driftPhase);
    float dist = abs(v_uv.y - barY);
    float wraparound = min(dist, 1.0 - dist);
    // ~half the previous brightness, amber-tinted (R high, B low).
    float bar = exp(-pow(wraparound / 0.045, 2.0)) * u_decay * 0.18;
    vec3 barTint = vec3(1.0, 0.92, 0.75);
    base += barTint * bar;
  }

  // 4. Sat + luma wobble — two phase-mismatched sines so it doesn't
  // read as a clean LFO. Saturation can dip 20% / lift 20% at full
  // decay, luma wobbles ~6%.
  float satWobble = sin(u_t * 1.7) * 0.13 + sin(u_t * 0.9) * 0.07;
  float satMul = clamp(1.0 - satWobble * u_decay, 0.0, 2.0);
  vec3 wlSat = vec3(luma(base));
  base = wlSat + (base - wlSat) * satMul;
  float lumWobble = sin(u_t * 2.3) * 0.06 * u_decay;
  base *= (1.0 + lumWobble);

  // 5. TV-Static-Grain — multi-scale, frame-coherent.
  // Coarse: ~5px blocks at 1080p, hashed by block index + integer
  // frame counter so content changes per frame but blocks don't drift.
  float frame30 = floor(u_t * 30.0);
  float frame60 = floor(u_t * 60.0);
  vec2 coarseGrid = floor(v_uv * 240.0);
  float coarse = hash(coarseGrid + vec2(frame30, frame30 * 1.7)) - 0.5;
  // Fine: per-pixel modulation, finer time grain.
  float fine = hash(v_uv * 600.0 + vec2(frame60, frame60 * 1.3)) - 0.5;
  // Per-channel chroma fringe — TV static has slight RGB-imbalance.
  float chR = hash(coarseGrid + vec2(frame30, frame30 * 1.7) + vec2(11.3, 0.0)) - 0.5;
  float chG = hash(coarseGrid + vec2(frame30, frame30 * 1.7) + vec2(0.0, 17.7)) - 0.5;
  float chB = hash(coarseGrid + vec2(frame30, frame30 * 1.7) + vec2(31.1, 5.5)) - 0.5;
  // Decay gates the grain non-linearly so low DECAY stays calm but
  // mid-to-high DECAY ramps up fast.
  float staticAmt = pow(u_decay, 1.4) * 0.35;
  vec3 staticRgb =
      vec3(coarse * 0.85)
    + vec3(fine * 0.30)
    + vec3(chR, chG, chB) * 0.20;
  base += staticRgb * staticAmt;

  // 6. Dropout flecks — gated by decay > 0.6.
  float bucketY = floor(v_uv.y * 90.0);
  float bucketT = floor(u_t * 8.0);
  float fleckSeed = hash(vec2(bucketY, bucketT));
  float fleckActivity = max(0.0, u_decay - 0.6) / 0.4;
  float threshold = 0.998 - fleckActivity * 0.018;
  if (fleckSeed > threshold) {
    float blackOrWhite = step(0.5, hash(vec2(bucketY * 13.0, bucketT * 7.0)));
    base = mix(base, vec3(blackOrWhite), 0.85);
  }

  // 7. Burn-in — warm-amber tint scaled by luminance × decay.
  // Highlights age into sepia-warm, shadows stay neutral. The
  // smoothstep feathered in the mid-tones so the transition is gentle.
  vec3 amber = vec3(0.95, 0.78, 0.55);
  float lum = luma(base);
  float burnMask = smoothstep(0.18, 0.95, lum);
  base = mix(base, base * amber, burnMask * u_decay * 0.55);

  base = clamp(base, 0.0, 1.0);
  fragColor = vec4(base, 1.0);
}
`;
