/**
 * FX-Catalog: registry of supported FxKinds with their parameters and
 * draw implementations (Canvas2D + WebGL2 — same parameters, different
 * pixel-producing backends; see ../../plans for the architecture).
 *
 * V1 ships `vignette`. New kinds: add a const + add it to `fxCatalog`.
 */
import type {
  CanvasLikeContext,
  WebGL2DrawContext,
  WebGPUDrawContext,
} from "./renderer-context";
import type { ADSREnvelope } from "./envelope";
import type { FxKind, FxParamDef, PunchFx } from "./types";

export interface FxDefinition {
  kind: FxKind;
  /** Short display label on pads / capsules. ≤ 4 chars. */
  label: string;
  /** Capsule fill colour on the ProgramStrip + LED tint on the pad. */
  capsuleColor: string;
  defaultParams: Record<string, number>;
  /** Encoder-Definition für die zwei FX-Knobs (DEPTH/EDGE etc.). Treibt
   *  die UI im FxHardwarePanel — der Encoder liest min/max/kind hiervon
   *  und schreibt in `fxDefaults` im Store. Optional damit alte Tests, die
   *  ad-hoc FxDefinition-Stubs bauen, nicht brechen. */
  params?: readonly [FxParamDef, FxParamDef];
  /** ADSR-Default für neue Regionen. Wird beim `beginFxHold` in die
   *  PunchFx eingefroren (modulo User-Override via `fxEnvelopes[kind]`).
   *  Optional damit alte Tests Stubs ohne Envelope bauen können —
   *  fehlend → INSTANT_ENVELOPE. */
  defaultEnvelope?: ADSREnvelope;
  /** Default tap-length when the user just taps (no hold) and BPM is set.
   *  Multiplied by `60/bpm`. Falls back to `defaultLengthS` when BPM null. */
  defaultLengthBeats?: number;
  /** Fallback default tap-length when no BPM is detected. */
  defaultLengthS: number;

  /** Canvas2D / OffscreenCanvas2D renderer. Same code runs in:
   *   - Live preview's Canvas2DBackend (when WebGL2 unavailable)
   *   - Final render via `compositor.ts` (also via Canvas2DBackend)
   *  Implementations should NOT touch ctx state outside save/restore;
   *  the backend wraps each call in save/restore for safety.
   *
   *  - `t` is master-time; FX compute capsule-local progress as `t - fx.inS`
   *  - `source` is a snapshot of the backbuffer right BEFORE this FX
   *    runs — i.e. the layer-pass output combined with every FX that
   *    has already been processed in this frame. Source-sampling FX
   *    (RGB, ZOOM, ECHO, TAPE, WEAR) read from it; pure overlays
   *    (Vignette) ignore it. May be null if the backend couldn't take
   *    a snapshot (test stubs / first-frame edge cases) — FX should
   *    no-op gracefully in that case. The re-snapshot per FX is what
   *    lets multiple replace-FX (e.g. WEAR + TAPE) compose serially
   *    instead of clobbering each other. */
  drawCanvas2D(
    ctx: CanvasLikeContext,
    fx: PunchFx,
    w: number,
    h: number,
    t: number,
    source: CanvasImageSource | null,
  ): void;

  /** WebGL2 renderer. Called with a configured fullscreen-quad pipeline;
   *  implementation pulls params, sets uniforms, and issues the draw.
   *  `t` is master-time; the source layer texture is exposed via
   *  `ctx.bindSourceTexture()` and sampled as `u_source` in the shader. */
  drawWebGL2(
    ctx: WebGL2DrawContext,
    fx: PunchFx,
    w: number,
    h: number,
    t: number,
  ): void;

  /** WebGPU renderer. Same parameters and contract as `drawWebGL2`,
   *  driving a `WebGPUDrawContext` instead. Required: every FxKind
   *  must ship a WGSL implementation. */
  drawWebGPU(
    ctx: WebGPUDrawContext,
    fx: PunchFx,
    w: number,
    h: number,
    t: number,
  ): void;

  /** Apply the ADSR-sampled wetness (0..1) to this kind's params and
   *  return the params the renderer should actually draw with. Each
   *  effect knows best how to scale itself: a vignette dims its
   *  intensity, a zoom shrinks its punch toward 1.0×, an RGB-split
   *  collapses its split distance to zero. Generic alpha-blend over
   *  the source doesn't work for displacement effects (zoom would
   *  ghost a half-zoomed image over the original), so each kind ships
   *  its own scaling here.
   *
   *  Contract: at wetness=1 the returned params equal the input
   *  (full effect); at wetness=0 the params yield a no-op (effect
   *  invisible / source pass-through). Optional — kinds without an
   *  override fall back to leaving params untouched, which is fine
   *  for tests that build ad-hoc FxDefinition stubs. */
  applyWetness?(
    params: Record<string, number>,
    wetness: number,
  ): Record<string, number>;
}

const VIGNETTE_DEFAULTS = {
  /** 0..1 — alpha of the darkest corner pixel. Higher = more cinematic. */
  intensity: 0.92,
  /** 0..1 — fraction of the radius over which the falloff happens.
   *  Higher = darkening starts closer to center → more dramatic. */
  falloff: 0.85,
} as const;

function vignetteParams(fx: PunchFx): { intensity: number; falloff: number } {
  const p = fx.params ?? {};
  const intensity = clamp01(
    p.intensity ?? VIGNETTE_DEFAULTS.intensity,
  );
  const falloff = clamp01(p.falloff ?? VIGNETTE_DEFAULTS.falloff);
  return { intensity, falloff };
}

const VIGNETTE: FxDefinition = {
  kind: "vignette",
  defaultEnvelope: { attackS: 0.05, decayS: 0, sustain: 1, releaseS: 0.3 },
  label: "VIGN",
  capsuleColor: "#1F4E5F",
  defaultParams: { ...VIGNETTE_DEFAULTS },
  params: [
    {
      id: "intensity",
      label: "DEPTH",
      kind: "linear",
      defaultValue: VIGNETTE_DEFAULTS.intensity,
      min: 0,
      max: 1,
    },
    {
      id: "falloff",
      label: "EDGE",
      kind: "linear",
      defaultValue: VIGNETTE_DEFAULTS.falloff,
      min: 0,
      max: 1,
    },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, _source) {
    const { intensity, falloff } = vignetteParams(fx);
    if (intensity <= 0) return;
    // Inner radius = where the falloff begins (no darkening before this).
    // Outer radius = the corner distance of the canvas (hypotenuse / 2).
    const cx = w / 2;
    const cy = h / 2;
    const outer = Math.hypot(cx, cy);
    const inner = outer * (1 - falloff);
    const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${intensity})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  },

  drawWebGL2(ctx, fx) {
    const { intensity, falloff } = vignetteParams(fx);
    // Pure overlay — no source sampling, additive premult blend.
    ctx.setBlendMode("over");
    ctx.useProgram("vignette");
    ctx.setUniform1f("u_intensity", intensity);
    ctx.setUniform1f("u_falloff", falloff);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx) {
    const { intensity, falloff } = vignetteParams(fx);
    ctx.setBlendMode("over");
    ctx.useProgram("vignette");
    // Note: WebGPU uniform field names match the WGSL struct (no
    // `u_` prefix), unlike the WebGL2 path which prefixes its globals.
    ctx.setUniform1f("intensity", intensity);
    ctx.setUniform1f("falloff", falloff);
    ctx.drawFullscreenQuad();
  },
  // Vignette is a pure overlay — its alpha IS the intensity, so scaling
  // intensity by wetness directly dims the corner darkness. Falloff
  // (the gradient's geometry) stays put; only the strength fades.
  applyWetness(params, wetness) {
    return { ...params, intensity: (params.intensity ?? 0) * wetness };
  },
};

// — Macro helpers ————————————————————————————————————————————
//
// Time-based movement (the old per-effect "LFO" knobs) is gone: the
// uniform modulation engine (see ./modulation.ts) drives every effect's
// INTENSITY centrally (envelope ⊗ LFO|sidechain) and hands the result in
// as `wetness`. Each effect now exposes two opinionated linear macros and
// scales itself by `wetness` in `applyWetness`. The only residual
// self-animation is WEAR's tracking bar, whose roll is a tasteful macro.

/** WEAR tracking-bar vertical position 0..1, scrolling at a roll-macro-
 *  controlled speed off master-time `t`. roll 0 → static bar. */
function wearDriftPhase(t: number, roll: number): number {
  const hz = clamp01(roll) * 0.5; // up to 0.5 cycles/s (2 s per pass)
  const p = (t * hz) % 1;
  return p < 0 ? p + 1 : p;
}

/** ECHO trail direction — a fixed tasteful up-left diagonal (phase units,
 *  0..1 mapped to 0..2π in the shader / cos-sin axis in canvas2d). */
const ECHO_DIR_PHASE = 0.125;

// — WEAR — Vintage-VHS-Verschleiß ———————————————————————————

const WEAR_DEFAULTS = {
  /** 0..1 — AGE macro. Master wear amount: Y/C bleed, head misalign,
   *  burn-in tint, tracking-bar visibility all scale with it. */
  decay: 0.55,
  /** 0..1 — ROLL macro. Speed the VHS tracking bar scrolls down the
   *  frame. 0 = static bar, 1 = fast roll. */
  roll: 0.4,
} as const;

function wearParams(fx: PunchFx): { decay: number; roll: number } {
  const p = fx.params ?? {};
  const decay = clamp01(p.decay ?? WEAR_DEFAULTS.decay);
  const roll = clamp01(p.roll ?? WEAR_DEFAULTS.roll);
  return { decay, roll };
}

const WEAR: FxDefinition = {
  kind: "wear",
  defaultEnvelope: { attackS: 0.03, decayS: 0, sustain: 1, releaseS: 0.2 },
  label: "WEAR",
  // Faded sepia — sells the "old tape" vibe both on the LED and the
  // capsule colour without clashing with TAPE's amber.
  capsuleColor: "#C8A878",
  defaultParams: { ...WEAR_DEFAULTS },
  params: [
    {
      id: "decay",
      label: "AGE",
      kind: "linear",
      defaultValue: WEAR_DEFAULTS.decay,
      min: 0,
      max: 1,
    },
    {
      id: "roll",
      label: "ROLL",
      kind: "linear",
      defaultValue: WEAR_DEFAULTS.roll,
      min: 0,
      max: 1,
    },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, t, source) {
    const { decay, roll } = wearParams(fx);
    if (!source) return;
    const driftPhase = wearDriftPhase(t, roll);
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Static head misalignment — three offset copies of the source
    // composited via channel-multiply.
    const head = decay * 0.0035 * w;
    if (head > 0.3) {
      drawChannel(ctx, source, w, h, -head, 0, "#FF0000");
      ctx.globalCompositeOperation = "lighter";
      drawChannel(ctx, source, w, h, 0, 0, "#00FF00");
      drawChannel(ctx, source, w, h, head, 0, "#0000FF");
      ctx.globalCompositeOperation = "source-over";
    } else {
      ctx.drawImage(source, 0, 0, w, h);
    }

    // Tracking-bar — subdued, amber-tinted (NOT pure white) so it reads
    // as tape-tracking rather than a TV strobe.
    if (driftPhase >= 0) {
      const barY = (driftPhase % 1) * h;
      const halfBand = h * 0.045;
      const a = decay * 0.18;
      const grad = ctx.createLinearGradient(0, barY - halfBand, 0, barY + halfBand);
      grad.addColorStop(0, "rgba(255,235,191,0)");
      grad.addColorStop(0.5, `rgba(255,235,191,${a.toFixed(3)})`);
      grad.addColorStop(1, "rgba(255,235,191,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = grad;
      ctx.fillRect(0, barY - halfBand, w, halfBand * 2);
      ctx.globalCompositeOperation = "source-over";
    }

    // Burn-in — multiply with a warm-amber tint. Multiply naturally
    // pulls highlights toward the tint (bright pixels get more shifted
    // than dark), which is the "highlights aging into sepia" effect we
    // get for free from blend math without per-pixel ops.
    if (decay > 0.05) {
      const aR = 255;
      const aG = Math.round(255 * (1 - decay * 0.20));
      const aB = Math.round(255 * (1 - decay * 0.45));
      const alpha = decay * 0.55;
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgba(${aR},${aG},${aB},${alpha.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }

    // NOTE: TV-static grain, sat/luma wobble and dropout flecks are
    // WebGL2-only — implementing them in Canvas2D would need
    // putImageData per frame which is too slow for the live preview.
    // The Canvas2D path is a fallback for browsers without WebGL2;
    // accept reduced fidelity there.

    ctx.restore();
  },

  drawWebGL2(ctx, fx, w, h, t) {
    const { decay, roll } = wearParams(fx);
    const driftPhase = wearDriftPhase(t, roll);
    ctx.setBlendMode("replace");
    ctx.useProgram("wear");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_decay", decay);
    ctx.setUniform1f("u_driftPhase", driftPhase);
    ctx.setUniform1f("u_t", t);
    ctx.setUniform2f("u_texel", w > 0 ? 1 / w : 0, h > 0 ? 1 / h : 0);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, w, h, t) {
    const { decay, roll } = wearParams(fx);
    const driftPhase = wearDriftPhase(t, roll);
    ctx.setBlendMode("replace");
    ctx.useProgram("wear");
    ctx.bindSourceTexture();
    ctx.setUniform1f("decay", decay);
    ctx.setUniform1f("driftPhase", driftPhase);
    ctx.setUniform1f("t", t);
    ctx.setUniform2f("texel", w > 0 ? 1 / w : 0, h > 0 ? 1 / h : 0);
    ctx.drawFullscreenQuad();
  },
  // Wear's master amount is `decay` (AGE) — every component (Y/C bleed,
  // tracking-bar visibility, wobble depth, grain density, dropouts,
  // tint) scales internally with it, so dimming it with the intensity
  // (`wetness`) fades the whole effect to a clean pass-through at 0.
  // ROLL (bar scroll speed) keeps its timing.
  applyWetness(params, wetness) {
    return { ...params, decay: (params.decay ?? 0) * wetness };
  },
};

// — RGB — Chroma-Split (source-displacement) ————————————————

const RGB_DEFAULTS = { split: 0.4, angle: 0 } as const;

const RGB: FxDefinition = {
  kind: "rgb",
  defaultEnvelope: { attackS: 0.02, decayS: 0, sustain: 1, releaseS: 0.15 },
  label: "RGB",
  capsuleColor: "#E74C8B",
  defaultParams: { ...RGB_DEFAULTS },
  params: [
    { id: "split", label: "SPLIT", kind: "linear", defaultValue: RGB_DEFAULTS.split, min: 0, max: 1 },
    { id: "angle", label: "ANGLE", kind: "linear", defaultValue: RGB_DEFAULTS.angle, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, source) {
    const p = fx.params ?? {};
    const split = clamp01(p.split ?? RGB_DEFAULTS.split);
    const angle = clamp01(p.angle ?? RGB_DEFAULTS.angle);
    if (split <= 0 || !source) return;
    const mag = split * 0.06 * w;
    const a = angle * Math.PI * 2;
    const dx = Math.cos(a) * mag;
    const dy = Math.sin(a) * mag;
    // Composite three offset copies of the source with channel-mask
    // multiply. We clear the destination first so the FX fully replaces
    // the layer pass output (matching WebGL2 replace-blend semantics).
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    // R channel: shift -dx,-dy. Use multiply to mask out non-red pixels.
    drawChannel(ctx, source, w, h, -dx, -dy, "#FF0000");
    ctx.globalCompositeOperation = "lighter";
    drawChannel(ctx, source, w, h, 0, 0, "#00FF00");
    drawChannel(ctx, source, w, h, dx, dy, "#0000FF");
    ctx.restore();
  },

  drawWebGL2(ctx, fx) {
    const p = fx.params ?? {};
    const split = clamp01(p.split ?? RGB_DEFAULTS.split);
    const angle = clamp01(p.angle ?? RGB_DEFAULTS.angle);
    ctx.setBlendMode("replace");
    ctx.useProgram("rgb");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_split", split);
    ctx.setUniform1f("u_angle", angle);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx) {
    const p = fx.params ?? {};
    const split = clamp01(p.split ?? RGB_DEFAULTS.split);
    const angle = clamp01(p.angle ?? RGB_DEFAULTS.angle);
    ctx.setBlendMode("replace");
    ctx.useProgram("rgb");
    ctx.bindSourceTexture();
    ctx.setUniform1f("split", split);
    ctx.setUniform1f("angle", angle);
    ctx.drawFullscreenQuad();
  },
  // RGB-split's "amount" is the channel-offset distance. At wetness=0
  // split=0 → all channels overlap → identity image. Angle (direction)
  // is preserved.
  applyWetness(params, wetness) {
    return { ...params, split: (params.split ?? 0) * wetness };
  },
};

/** Helper für RGB Canvas2D — zeichnet `source` mit (dx,dy) Offset und
 *  multipliziert mit `mask` (z.B. "#FF0000" für nur-Rot). */
function drawChannel(
  ctx: CanvasLikeContext,
  source: CanvasImageSource,
  w: number,
  h: number,
  dx: number,
  dy: number,
  mask: string,
): void {
  // Zeichne offset-Source in einen Off-Screen-Buffer und multipliziere
  // mit der Channel-Maske, dann blitte additiv auf ctx.
  const off = createOffscreen(w, h);
  if (!off) return;
  off.ctx.drawImage(source, dx, dy, w, h);
  off.ctx.globalCompositeOperation = "multiply";
  off.ctx.fillStyle = mask;
  off.ctx.fillRect(0, 0, w, h);
  ctx.drawImage(off.canvas, 0, 0);
}

function createOffscreen(
  w: number,
  h: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasLikeContext } | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const cx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!cx) return null;
    return { canvas: c, ctx: cx };
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    const cx = c.getContext("2d");
    if (!cx) return null;
    return { canvas: c, ctx: cx };
  }
  return null;
}

// — ZOOM — Beat-Pump (source-resample) ——————————————————————

const ZOOM_DEFAULTS = { punch: 0.5, push: 0.8 } as const;

const ZOOM: FxDefinition = {
  kind: "zoom",
  defaultEnvelope: { attackS: 0.04, decayS: 0, sustain: 1, releaseS: 0.25 },
  label: "ZOOM",
  capsuleColor: "#5BAA46",
  defaultParams: { ...ZOOM_DEFAULTS },
  params: [
    { id: "punch", label: "PUNCH", kind: "linear", defaultValue: ZOOM_DEFAULTS.punch, min: 0, max: 1 },
    // PUSH — how aggressively the zoom engages (static curve shaper).
    { id: "push", label: "PUSH", kind: "linear", defaultValue: ZOOM_DEFAULTS.push, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, source) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const push = clamp01(p.push ?? ZOOM_DEFAULTS.push);
    if (punch <= 0 || !source) return;
    // No internal LFO — the zoom magnitude is driven by `punch` (which the
    // intensity bus scales via wetness). PUSH shapes how much of the punch
    // engages, via the same pow curve the shader uses (phase = 1 - push).
    const phase = 1 - push;
    const pulse = Math.pow(1 - phase, 4);
    const zoom = 1 + punch * 0.3 * pulse;
    if (zoom <= 1.0001) return;
    const cx = w / 2;
    const cy = h / 2;
    const sw = w / zoom;
    const sh = h / zoom;
    const sx = cx - sw / 2;
    const sy = cy - sh / 2;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    ctx.restore();
  },

  drawWebGL2(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const push = clamp01(p.push ?? ZOOM_DEFAULTS.push);
    const phase = 1 - push;
    ctx.setBlendMode("replace");
    ctx.useProgram("zoom");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_punch", punch);
    ctx.setUniform1f("u_phase", phase);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const push = clamp01(p.push ?? ZOOM_DEFAULTS.push);
    const phase = 1 - push;
    ctx.setBlendMode("replace");
    ctx.useProgram("zoom");
    ctx.bindSourceTexture();
    ctx.setUniform1f("punch", punch);
    ctx.setUniform1f("phase", phase);
    ctx.drawFullscreenQuad();
  },
  // Zoom is a displacement effect — alpha-blending source over zoomed
  // would ghost. Scale `punch` (the pulse magnitude) linearly with the
  // envelope's wetness so each pulse's amplitude tracks the envelope
  // proportionally: at wetness 0.5 the peak zoom is half. sqrt was
  // flatter and made the release tail feel like the pulse "stays
  // strong forever" before snapping off; linear matches the curve the
  // user dialed in. `rate` (beat timing) is untouched so cadence
  // doesn't slow down with the fade.
  applyWetness(params, wetness) {
    return {
      ...params,
      punch: (params.punch ?? 0) * Math.max(0, wetness),
    };
  },
};

// — UV — Blacklight Glow (source-derived bloom approximation) ——

const UV_DEFAULTS = { glow: 0.6, tint: 0.5 } as const;

const UV: FxDefinition = {
  kind: "uv",
  defaultEnvelope: { attackS: 0.1, decayS: 0, sustain: 1, releaseS: 0.4 },
  label: "UV",
  capsuleColor: "#3FA9F5",
  defaultParams: { ...UV_DEFAULTS },
  params: [
    { id: "glow", label: "GLOW", kind: "linear", defaultValue: UV_DEFAULTS.glow, min: 0, max: 1 },
    { id: "tint", label: "TINT", kind: "linear", defaultValue: UV_DEFAULTS.tint, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, source) {
    const p = fx.params ?? {};
    const glow = clamp01(p.glow ?? UV_DEFAULTS.glow);
    const tint = clamp01(p.tint ?? UV_DEFAULTS.tint);
    if (!source) return;
    // Canvas2D approximation: dim base, additive tinted blur on top.
    // We don't do a real bloom (would need pixel ops); instead we
    // exploit ctx.filter for a cheap blur and tint via globalComposite.
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    // 1. dim base
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(source, 0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, w, h);
    // 2. blurred copy on top, additively, then tinted
    const blurPx = 6 + glow * 14;
    const off = createOffscreen(w, h);
    if (off && "filter" in off.ctx) {
      (off.ctx as CanvasRenderingContext2D).filter = `blur(${blurPx}px)`;
      off.ctx.drawImage(source, 0, 0, w, h);
      (off.ctx as CanvasRenderingContext2D).filter = "none";
      // Tint: 0 = magenta, 1 = cyan
      const tintColor = tint < 0.5 ? "#FF2DEE" : "#2DEEFF";
      off.ctx.globalCompositeOperation = "multiply";
      off.ctx.fillStyle = tintColor;
      off.ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 + glow * 0.7;
      ctx.drawImage(off.canvas, 0, 0);
    }
    ctx.restore();
  },

  drawWebGL2(ctx, fx, w, h) {
    const p = fx.params ?? {};
    const glow = clamp01(p.glow ?? UV_DEFAULTS.glow);
    const tint = clamp01(p.tint ?? UV_DEFAULTS.tint);
    ctx.setBlendMode("replace");
    ctx.useProgram("uv");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_glow", glow);
    ctx.setUniform1f("u_tint", tint);
    ctx.setUniform2f("u_texel", w > 0 ? 1 / w : 0, h > 0 ? 1 / h : 0);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, w, h) {
    const p = fx.params ?? {};
    const glow = clamp01(p.glow ?? UV_DEFAULTS.glow);
    const tint = clamp01(p.tint ?? UV_DEFAULTS.tint);
    ctx.setBlendMode("replace");
    ctx.useProgram("uv");
    ctx.bindSourceTexture();
    ctx.setUniform1f("glow", glow);
    ctx.setUniform1f("tint", tint);
    ctx.setUniform2f("texel", w > 0 ? 1 / w : 0, h > 0 ? 1 / h : 0);
    ctx.drawFullscreenQuad();
  },
  // UV's `glow` is the intensity (bloom strength). `tint` is a colour
  // selector — scaling it shifts the hue (tint=0.4 vs 0.2 are different
  // colours, not different brightnesses), so a wetness ramp on tint
  // would look like a rainbow chase instead of a fade. Only `glow`
  // fades — the tint colour stays put as the lamp dims.
  applyWetness(params, wetness) {
    return { ...params, glow: (params.glow ?? 0) * wetness };
  },
};

// — ECHO — Stateless Multi-Tap Trail ————————————————————————

const ECHO_DEFAULTS = { spread: 0.6, feedback: 0.5 } as const;

const ECHO: FxDefinition = {
  kind: "echo",
  defaultEnvelope: { attackS: 0.08, decayS: 0, sustain: 1, releaseS: 0.4 },
  label: "ECHO",
  capsuleColor: "#9C5BD9",
  defaultParams: { ...ECHO_DEFAULTS },
  params: [
    { id: "spread", label: "SPREAD", kind: "linear", defaultValue: ECHO_DEFAULTS.spread, min: 0, max: 1 },
    { id: "feedback", label: "FEED", kind: "linear", defaultValue: ECHO_DEFAULTS.feedback, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, source) {
    const p = fx.params ?? {};
    const trail = clamp01(p.spread ?? ECHO_DEFAULTS.spread);
    const mix = clamp01(p.feedback ?? ECHO_DEFAULTS.feedback);
    if (!source || mix <= 0) return;
    // Fixed trail direction — no internal LFO; the beat motion now comes
    // from the intensity bus pumping `feedback` via wetness.
    const a = ECHO_DIR_PHASE * Math.PI * 2;
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    // Stateless trail: draw 5 offset copies behind axis with decaying alpha.
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const magBase = 0.10 * w; // x-axis scale; y-axis uses h
    const magBaseY = 0.10 * h;
    for (let i = 1; i <= 5; i++) {
      const fi = i / 5;
      const dx = -ax * magBaseY * fi * (trail / 1);
      const dy = -ay * magBaseY * fi * (trail / 1);
      void magBase;
      const alpha = Math.exp(-fi * 2.5) * mix;
      ctx.globalAlpha = alpha;
      ctx.drawImage(source, dx, dy, w, h);
    }
    ctx.restore();
  },

  drawWebGL2(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const trail = clamp01(p.spread ?? ECHO_DEFAULTS.spread);
    const mix = clamp01(p.feedback ?? ECHO_DEFAULTS.feedback);
    ctx.setBlendMode("replace");
    ctx.useProgram("echo");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_trail", trail);
    ctx.setUniform1f("u_mix", mix);
    ctx.setUniform1f("u_phase", ECHO_DIR_PHASE);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const trail = clamp01(p.spread ?? ECHO_DEFAULTS.spread);
    const mix = clamp01(p.feedback ?? ECHO_DEFAULTS.feedback);
    ctx.setBlendMode("replace");
    ctx.useProgram("echo");
    ctx.bindSourceTexture();
    ctx.setUniform1f("trail", trail);
    ctx.setUniform1f("mix", mix);
    ctx.setUniform1f("phase", ECHO_DIR_PHASE);
    ctx.drawFullscreenQuad();
  },
  // Echo's `feedback` is its wet/dry — at 0 the additive trails vanish and
  // only the source survives, so dimming it with the intensity (`wetness`)
  // fades the whole effect out. SPREAD (trail length) keeps its reach.
  applyWetness(params, wetness) {
    return { ...params, feedback: (params.feedback ?? 0) * wetness };
  },
};

// — TAPE — Stateless Tape-Stop Approximation ————————————————

const TAPE_DEFAULTS = { stop: 0.7, warp: 0.5 } as const;

const TAPE: FxDefinition = {
  kind: "tape",
  defaultEnvelope: { attackS: 0, decayS: 0, sustain: 1, releaseS: 0 },
  label: "TAPE",
  capsuleColor: "#E5A100",
  defaultParams: { ...TAPE_DEFAULTS },
  params: [
    { id: "stop", label: "STOP", kind: "linear", defaultValue: TAPE_DEFAULTS.stop, min: 0, max: 1 },
    { id: "warp", label: "WARP", kind: "linear", defaultValue: TAPE_DEFAULTS.warp, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, _t, source) {
    const p = fx.params ?? {};
    // STOP = tape-stop progression (band drift / darken depth). WARP =
    // chroma + texture depth. Both are scaled by the intensity bus
    // (wetness) in applyWetness, so the whole stop pumps with envelope /
    // LFO / sidechain and collapses to a clean image at 0.
    const phase = clamp01(p.stop ?? TAPE_DEFAULTS.stop);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    if (!source) return;
    const warpScale = 0.5 + warp * 0.5;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    // Slice into 24 horizontal bands; each band slides by a per-band
    // pseudo-random amount scaled by phase × (warp-scaled).
    const bands = 24;
    const bandH = h / bands;
    for (let i = 0; i < bands; i++) {
      const r = pseudoRand(i) - 0.5;
      const drift = phase * 0.06 * r * warpScale * w;
      const yPull = phase * 0.025 * r * warpScale * h;
      const sy = i * bandH;
      ctx.drawImage(
        source,
        0,
        sy,
        w,
        bandH,
        drift,
        sy + yPull,
        w,
        bandH,
      );
    }
    // Chromatic warp — coefficient bumped 4× so WARP=0 ↔ WARP=1 is a
    // clearly audible difference in the output.
    const chrom = phase * warp * 0.045 * w;
    if (chrom > 0.3) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.45;
      const off = createOffscreen(w, h);
      if (off) {
        off.ctx.drawImage(source, -chrom, 0, w, h);
        off.ctx.globalCompositeOperation = "multiply";
        off.ctx.fillStyle = "#FF0000";
        off.ctx.fillRect(0, 0, w, h);
        ctx.drawImage(off.canvas, 0, 0);
        const off2 = createOffscreen(w, h);
        if (off2) {
          off2.ctx.drawImage(source, chrom, 0, w, h);
          off2.ctx.globalCompositeOperation = "multiply";
          off2.ctx.fillStyle = "#0000FF";
          off2.ctx.fillRect(0, 0, w, h);
          ctx.drawImage(off2.canvas, 0, 0);
        }
      }
    }
    // Slight darken — independent of warp so the "stop" still reads.
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = phase * 0.20;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  },

  drawWebGL2(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const phase = clamp01(p.stop ?? TAPE_DEFAULTS.stop);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    ctx.setBlendMode("replace");
    ctx.useProgram("tape");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_warp", warp);
    ctx.setUniform1f("u_phase", phase);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, _t) {
    const p = fx.params ?? {};
    const phase = clamp01(p.stop ?? TAPE_DEFAULTS.stop);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    ctx.setBlendMode("replace");
    ctx.useProgram("tape");
    ctx.bindSourceTexture();
    ctx.setUniform1f("warp", warp);
    ctx.setUniform1f("phase", phase);
    ctx.drawFullscreenQuad();
  },
  // Tape's stop reads from STOP (u_phase: band drift + darken) and WARP
  // (u_warp: chroma + grain). The intensity bus scales BOTH by wetness so
  // the whole tape-stop pumps with the envelope / LFO / sidechain and
  // collapses to a clean image at wetness 0.
  applyWetness(params, wetness) {
    return {
      ...params,
      stop: (params.stop ?? 0) * wetness,
      warp: (params.warp ?? 0) * wetness,
    };
  },
};

function pseudoRand(seed: number): number {
  return Math.abs(Math.sin(seed * 91.345) * 43758.5453) % 1;
}

export const fxCatalog: Readonly<Record<FxKind, FxDefinition>> = {
  vignette: VIGNETTE,
  wear: WEAR,
  echo: ECHO,
  rgb: RGB,
  tape: TAPE,
  zoom: ZOOM,
  uv: UV,
};

export function getFxDefinition(kind: FxKind): FxDefinition {
  return fxCatalog[kind];
}

/** Default tap-length for a fx kind in seconds, given an optional BPM. */
export function defaultTapLengthS(kind: FxKind, bpm: number | null): number {
  const def = fxCatalog[kind];
  if (def.defaultLengthBeats != null && bpm && bpm > 0) {
    return def.defaultLengthBeats * (60 / bpm);
  }
  return def.defaultLengthS;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
