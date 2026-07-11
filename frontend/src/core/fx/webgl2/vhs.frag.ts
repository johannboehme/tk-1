// VHS — Worn analog videotape — chroma bleed, a rolling tracking band, scanlines, snow and head-switch tearing that all crawl over time.
// Generated filter shader (reviewed + GPU-verified in grade-filters.browser.test).
export const VHS_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform float u_tracking;
uniform float u_bleed;
uniform float u_noise;
uniform float u_wobble;
uniform float u_amount;
uniform float u_time;
out vec4 fragColor;

const vec3 W = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 vhs(vec3 src, vec2 uv) {
  // — Per-line horizontal jitter (WOBBLE). Two phase-mismatched sines
  // seed a per-scanline pseudo-random offset so the picture wobbles
  // left/right line-by-line, breathing irregularly over time.
  float line = floor(uv.y * 480.0);
  float jitWave = sin(u_time * 5.0 + line * 0.7) * 0.5 + sin(u_time * 8.3) * 0.5;
  float lineRand = hash(vec2(line, floor(u_time * 24.0))) - 0.5;
  float jitter = (lineRand * 0.6 + jitWave * 0.4) * u_wobble * 0.012;
  vec2 wuv = vec2(clamp(uv.x + jitter, 0.0, 1.0), uv.y);

  // — Rolling tracking band (TRACKING). A horizontal stripe rolls down
  // the frame with time; near it the picture is vertically displaced
  // and brightened, like tape tracking drift.
  float barY = fract(u_time * 0.18);
  float bdist = abs(wuv.y - barY);
  float bwrap = min(bdist, 1.0 - bdist);
  float band = exp(-pow(bwrap / 0.06, 2.0)) * u_tracking;
  wuv.y = clamp(wuv.y + band * 0.02, 0.0, 1.0);

  // — Horizontal Y/C chroma bleed (BLEED). Multi-tap red/blue smear that
  // drags chroma sideways off edges, plus a small dotOff-crawl offset.
  float bd = u_bleed * 0.018;
  float dotOff = u_bleed * 0.004 * sign(jitWave);
  float r = texture(u_source, vec2(clamp(wuv.x - bd - dotOff, 0.0, 1.0), wuv.y)).r;
  float g = texture(u_source, wuv).g;
  float b = texture(u_source, vec2(clamp(wuv.x + bd + dotOff, 0.0, 1.0), wuv.y)).b;
  // Extra trailing chroma tap for the "smear drag" off the left.
  vec3 trail = texture(u_source, vec2(clamp(wuv.x - bd * 2.0, 0.0, 1.0), wuv.y)).rgb;
  float trailLuma = dot(trail, W);
  vec3 trailChroma = trail - vec3(trailLuma);
  vec3 col = vec3(r, g, b);
  float colLuma = dot(col, W);
  vec3 colChroma = col - vec3(colLuma);
  col = vec3(colLuma) + mix(colChroma, trailChroma, u_bleed * 0.5);

  // Tracking band brightens + desaturates the stripe it crosses.
  float bandL = dot(col, W);
  col = mix(col, vec3(bandL), band * 0.4);
  col += band * 0.18;

  // — Scanline combing (NOISE). Dark every-other-line modulation.
  float scan = 0.5 + 0.5 * cos(uv.y * 1100.0);
  col *= 1.0 - u_noise * 0.18 * scan;

  // — Luma snow (NOISE). Coarse blocks shimmer per-frame, fine grain on top.
  float frame30 = floor(u_time * 30.0);
  float frame60 = floor(u_time * 60.0);
  float coarse = hash(floor(uv * 300.0) + vec2(frame30, frame30 * 1.7)) - 0.5;
  float fine = hash(uv * 900.0 + vec2(frame60, frame60 * 1.3)) - 0.5;
  float snow = coarse * 0.7 + fine * 0.3;
  col += snow * u_noise * 0.22;

  // — Head-switching tear band fixed at the very bottom (NOISE).
  float hs = smoothstep(0.06, 0.0, uv.y);
  float tear = hash(vec2(floor(uv.x * 220.0), frame30)) - 0.5;
  col += hs * tear * u_noise * 0.7;
  col = mix(col, vec3(0.0), hs * u_noise * 0.25);

  // — Slow midtone hue wobble (WOBBLE) — cool-green tape cast that breathes.
  float hue = sin(u_time * 1.3) * u_wobble * 0.05;
  col.g += hue;
  col.r -= hue * 0.5;

  // Static cool-green tape cast in midtones, scaled by overall character.
  float tapeCast = max(max(u_tracking, u_bleed), max(u_noise, u_wobble));
  col.g += tapeCast * 0.02;
  col.b += tapeCast * 0.01;

  return col;
}

void main() {
  vec3 src = texture(u_source, v_uv).rgb;
  vec3 e = clamp(vhs(src, v_uv), 0.0, 1.0);
  fragColor = vec4(mix(src, e, u_amount), 1.0);
}
`;
