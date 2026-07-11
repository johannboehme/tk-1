// INSTANT — Instant-film look: creamy warm highlights, cyan milky shadows, soft center bloom, heavy vignette, optional off-white frame.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const POLAROID_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_fade;
uniform float u_bloom;
uniform float u_chem;
uniform float u_vignette;
uniform float u_border;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

// Cheap 5-tap diffusion: center + 4 diagonal neighbours, radius grows with
// bloom. Used both for the soft-focus center and the highlight halo.
vec3 diffuse(vec2 uv, float radius) {
  vec3 c = texture(u_source, uv).rgb * 0.4;
  c += texture(u_source, uv + vec2( radius,  radius)).rgb * 0.15;
  c += texture(u_source, uv + vec2(-radius,  radius)).rgb * 0.15;
  c += texture(u_source, uv + vec2( radius, -radius)).rgb * 0.15;
  c += texture(u_source, uv + vec2(-radius, -radius)).rgb * 0.15;
  return c;
}

vec3 polaroid(vec3 src, vec2 uv) {
  vec3 c = src;

  // 1. Soft center diffusion + highlight bloom. Blur radius scales with
  //    bloom; highlights lerp toward the softened bright neighbourhood and
  //    the whole frame gets a small overexposure lift (the instant-print
  //    "too much light" feel). No-op at bloom=0 (radius 0, weight 0).
  float radius = u_bloom * 0.006;
  vec3 soft = diffuse(uv, radius);
  float lb = dot(c, W);
  float hi = smoothstep(0.45, 0.95, lb);
  c = mix(c, soft, u_bloom * (0.35 + 0.45 * hi));
  c += u_bloom * 0.05;

  // 2. Milky matte floor — lift blacks toward a faintly warm grey, plus a
  //    gentle de-contrast so the toe goes creamy. No-op at fade=0.
  float floorLift = u_fade * 0.22;
  c = c * (1.0 - floorLift) + floorLift * vec3(1.0, 0.98, 0.95);
  c = (c - 0.5) * (1.0 - u_fade * 0.18) + 0.5;

  // 3. Baked warm/cool instant-film split (gated by master amount so it is
  //    part of the look's identity, not a per-param toggle): shadows lean
  //    cyan-teal, highlights go warm cream. Scaled by u_amount so amount=0
  //    is a literal source pass.
  float l = dot(c, W);
  float sW = 1.0 - smoothstep(0.0, 0.55, l);
  float hW = smoothstep(0.45, 1.0, l);
  c.r -= u_amount * 0.055 * sW; c.g += u_amount * 0.025 * sW; c.b += u_amount * 0.070 * sW;
  c.r += u_amount * 0.075 * hW; c.g += u_amount * 0.035 * hW; c.b -= u_amount * 0.045 * hW;

  // 4. Chemical magenta/green cast with a slow shimmer. shim breathes the
  //    magenta push and a faint counter-green so the chemistry drifts.
  //    No-op at cast=0 (every term multiplied by u_chem).
  float shim = 0.5 + 0.5 * sin(u_time * 0.7);
  shim = mix(shim, 0.5 + 0.5 * sin(u_time * 1.9), 0.25);
  float castAmt = u_chem * (0.65 + 0.35 * shim);
  c.r += castAmt * 0.05; c.b += castAmt * 0.05; c.g -= castAmt * 0.04;
  c.g += u_chem * (1.0 - shim) * 0.03;

  // 5. Strong soft vignette with a creamy edge desaturation — corners
  //    darken AND wash toward the matte grey. No-op at vignette=0.
  float d = length(uv - 0.5) * 1.4142136;
  float vig = smoothstep(0.35, 1.0, d);
  c *= 1.0 - u_vignette * 0.55 * vig;
  float le = dot(c, W);
  c = mix(c, vec3(le), u_vignette * 0.25 * vig);

  return c;
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  vec3 p = clamp(polaroid(src, v_uv), 0.0, 1.0);
  vec3 outc = mix(src, p, u_amount);

  // 6. Off-white instant-film BORDER drawn on top (geometry, after the
  //    colour mix). Thin top/sides, fat bottom "chin" — the integral-film
  //    signature. No-op at border=0. The frame is the classic warm paper
  //    white; the image is inset, not scaled, so it reads as a physical
  //    print laid over the frame.
  if (u_border > 0.0) {
    float side = u_border * 0.05;
    float top  = u_border * 0.05;
    float chin = u_border * 0.16;
    // distance INTO the image region: positive inside, <=0 on the frame.
    float inX = min(v_uv.x - side, (1.0 - side) - v_uv.x);
    float inY = min(v_uv.y - chin, (1.0 - top) - v_uv.y);
    float frameMask = step(min(inX, inY), 0.0);
    // subtle paper grain so the white isn't dead-flat.
    float g = fract(sin(dot(v_uv, vec2(12.9898, 78.233))) * 43758.5453);
    vec3 paper = vec3(0.96, 0.95, 0.92) - g * 0.015;
    outc = mix(outc, paper, frameMask);
  }

  fragColor = vec4(outc, 1.0);
}
`;
