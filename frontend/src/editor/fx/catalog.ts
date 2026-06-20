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
import { ENGINE_DEFAULTS, GRADE_PARAM_KEYS, type GradeParams } from "./looks";

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
  /** Per-FILTER control schema (variable length, 2-6 entries). Distinct
   *  from `params` (the fixed 2-knob hardware-encoder pair): this drives the
   *  Overlays "Filters" card, which renders one slider per entry — so each
   *  filter shows ITS OWN controls (VHS: TRACK/BLEED/SNOW/WOBBLE; Sepia:
   *  TONE/CONTRAST/FADE/GRAIN; …). Must include a master "amount". */
  filterParams?: readonly FxParamDef[];
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

// — Helpers für Bipolar-Params (LFO-Style) ——————————————————
//
// Mehrere FX (ECHO, ZOOM, TAPE) haben einen Time-Param der bipolar
// im Encoder geführt wird: linke Hälfte free, rechte Hälfte synced
// auf Beat-Divisions {1/16, 1/8, 1/4, 1/2, 1, 2, 4}. Die Backend-Logic
// muss daraus eine Periode (in Sekunden) ableiten, die dann mit der
// capsule-local-time zu einem 0..1 Phase-Wert wird (für sin-LFOs etc.).

const BEAT_STOPS_S: readonly number[] = [
  // Sekunden bei 120 BPM Default (= 0.5 s pro Beat). Wenn das Job-BPM
  // gesetzt ist, könnte der Renderer das mitziehen — V1 ist bewusst
  // BPM-frei (der Backend-Pass sieht keinen BPM-Context), wir nehmen
  // den Default als pragmatische Konstante.
  // 1/16, 1/8, 1/4, 1/2, 1, 2, 4 beats at 120 BPM:
  0.5 / 4, // 1/16 = 0.125 s
  0.5 / 2, // 1/8  = 0.25 s
  0.5 / 1, // 1/4  = 0.5 s
  0.5 * 2, // 1/2  = 1.0 s
  0.5 * 4, // 1    = 2.0 s
  0.5 * 8, // 2    = 4.0 s
  0.5 * 16, // 4    = 8.0 s
];

/** Resolve a bipolar 0..1 value to a period in seconds.
 *  - ~0.5:    "OFF" → returns Infinity (no LFO modulation)
 *  - 0..0.48: free side; near OFF = slowest, full left = fastest
 *  - 0.52..1: synced side; near OFF = slowest beat (4×), far right = 1/16
 *
 *  TE convention: the OFF detent at 12 o'clock is the "do nothing" pose,
 *  so the SLOWEST modulation lives one nudge away from OFF (it's the
 *  closest thing to "barely doing anything"), and the fastest sits at
 *  the extremes. Going far from centre = pushing harder. Returns
 *  Infinity for OFF so callers can branch on isFinite. */
function bipolarPeriodS(v: number): number {
  if (v >= 0.48 && v <= 0.52) return Infinity; // OFF detent
  if (v < 0.5) {
    // Free: t=0 at full left (fastest), t=1 near OFF (slowest free).
    const t = v / 0.48;
    return 0.04 + t * (2.0 - 0.04);
  }
  // Synced: 7 buckets evenly across 0.52..1.0. Near OFF maps to the
  // slowest beat (4×), far right maps to 1/16. Indexing into
  // BEAT_STOPS_S in reverse gives the TE-style "extreme = fast" layout.
  const tt = (v - 0.5) / 0.5; // 0..1
  const idx = Math.min(6, Math.max(0, Math.round(tt * 7 - 0.5)));
  return BEAT_STOPS_S[BEAT_STOPS_S.length - 1 - idx];
}

/** Compute the LFO phase 0..1 within the current period for a capsule
 *  at master-time `t` (capsule started at `inS`). For "OFF" period
 *  returns 0 so the FX shader sees a stationary phase. */
function lfoPhase(t: number, inS: number, period: number): number {
  if (!isFinite(period) || period <= 0) return 0;
  const local = Math.max(0, t - inS);
  return (local % period) / period;
}

/** One-shot phase: ramps 0→1 over the period and HOLDS at 1. Used for
 *  effects whose semantics are "this happens once and stays" — TAPE-stop
 *  is the canonical case (the tape slows down, then is stationary;
 *  it does NOT periodically un-stop). */
function oneShotPhase(t: number, inS: number, period: number): number {
  if (!isFinite(period) || period <= 0) return 0;
  const local = Math.max(0, t - inS);
  return Math.min(1, local / period);
}

// — WEAR — Vintage-VHS-Verschleiß ———————————————————————————

const WEAR_DEFAULTS = {
  /** 0..1 — Master-Intensität. 0 = clean pass-through, 1 = totales
   *  VHS-Wrack mit Dropout-Flecken und maximalem Color-Bleed. */
  decay: 0.55,
  /** 0..1 — bipolar; siehe `bipolarPeriodS`. Steuert die Periode der
   *  Tracking-Bar-Bewegung. OFF-Detent = Bar versteckt. Default 0.821
   *  = synced auf 1 Beat (langsame, ruhige Wanderung). */
  drift: 0.821,
} as const;

function wearParams(fx: PunchFx): { decay: number; drift: number } {
  const p = fx.params ?? {};
  const decay = clamp01(p.decay ?? WEAR_DEFAULTS.decay);
  const drift = clamp01(p.drift ?? WEAR_DEFAULTS.drift);
  return { decay, drift };
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
      label: "DECAY",
      kind: "linear",
      defaultValue: WEAR_DEFAULTS.decay,
      min: 0,
      max: 1,
    },
    {
      id: "drift",
      label: "DRIFT",
      kind: "bipolar",
      defaultValue: WEAR_DEFAULTS.drift,
      min: 0,
      max: 1,
    },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, t, source) {
    const { decay, drift } = wearParams(fx);
    if (!source) return;
    const period = bipolarPeriodS(drift);
    const driftPhase = isFinite(period) ? lfoPhase(t, fx.inS, period) : -1;
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
    const { decay, drift } = wearParams(fx);
    const period = bipolarPeriodS(drift);
    const driftPhase = isFinite(period) ? lfoPhase(t, fx.inS, period) : -1;
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
    const { decay, drift } = wearParams(fx);
    const period = bipolarPeriodS(drift);
    const driftPhase = isFinite(period) ? lfoPhase(t, fx.inS, period) : -1;
    ctx.setBlendMode("replace");
    ctx.useProgram("wear");
    ctx.bindSourceTexture();
    ctx.setUniform1f("decay", decay);
    ctx.setUniform1f("driftPhase", driftPhase);
    ctx.setUniform1f("t", t);
    ctx.setUniform2f("texel", w > 0 ? 1 / w : 0, h > 0 ? 1 / h : 0);
    ctx.drawFullscreenQuad();
  },
  // Wear's master amount is `decay` — every component (Y/C bleed,
  // tracking-bar visibility, wobble depth, grain density, dropouts,
  // tint) scales internally with it. Drift (LFO timing) keeps its
  // direction; only the wear-amount fades with the envelope.
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

const ZOOM_DEFAULTS = { punch: 0.5, rate: 0.821 } as const;

const ZOOM: FxDefinition = {
  kind: "zoom",
  defaultEnvelope: { attackS: 0.04, decayS: 0, sustain: 1, releaseS: 0.25 },
  label: "ZOOM",
  capsuleColor: "#5BAA46",
  defaultParams: { ...ZOOM_DEFAULTS },
  params: [
    { id: "punch", label: "PUNCH", kind: "linear", defaultValue: ZOOM_DEFAULTS.punch, min: 0, max: 1 },
    // RATE bipolar — left=free, right=beat-synced (1/16..4)
    { id: "rate", label: "RATE", kind: "bipolar", defaultValue: ZOOM_DEFAULTS.rate, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, t, source) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const rate = clamp01(p.rate ?? ZOOM_DEFAULTS.rate);
    if (punch <= 0 || !source) return;
    const period = bipolarPeriodS(rate);
    const phase = lfoPhase(t, fx.inS, period);
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

  drawWebGL2(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const rate = clamp01(p.rate ?? ZOOM_DEFAULTS.rate);
    const period = bipolarPeriodS(rate);
    const phase = lfoPhase(t, fx.inS, period);
    ctx.setBlendMode("replace");
    ctx.useProgram("zoom");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_punch", punch);
    ctx.setUniform1f("u_phase", phase);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const punch = clamp01(p.punch ?? ZOOM_DEFAULTS.punch);
    const rate = clamp01(p.rate ?? ZOOM_DEFAULTS.rate);
    const period = bipolarPeriodS(rate);
    const phase = lfoPhase(t, fx.inS, period);
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

const ECHO_DEFAULTS = { trail: 0.679, mix: 0.5 } as const;

const ECHO: FxDefinition = {
  kind: "echo",
  defaultEnvelope: { attackS: 0.08, decayS: 0, sustain: 1, releaseS: 0.4 },
  label: "ECHO",
  capsuleColor: "#9C5BD9",
  defaultParams: { ...ECHO_DEFAULTS },
  params: [
    { id: "trail", label: "TRAIL", kind: "bipolar", defaultValue: ECHO_DEFAULTS.trail, min: 0, max: 1 },
    { id: "mix", label: "MIX", kind: "linear", defaultValue: ECHO_DEFAULTS.mix, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, t, source) {
    const p = fx.params ?? {};
    const trail = clamp01(p.trail ?? ECHO_DEFAULTS.trail);
    const mix = clamp01(p.mix ?? ECHO_DEFAULTS.mix);
    if (!source || mix <= 0) return;
    const period = bipolarPeriodS(trail);
    const phase = lfoPhase(t, fx.inS, period);
    const a = phase * Math.PI * 2;
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

  drawWebGL2(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const trail = clamp01(p.trail ?? ECHO_DEFAULTS.trail);
    const mix = clamp01(p.mix ?? ECHO_DEFAULTS.mix);
    const period = bipolarPeriodS(trail);
    const phase = lfoPhase(t, fx.inS, period);
    ctx.setBlendMode("replace");
    ctx.useProgram("echo");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_trail", trail);
    ctx.setUniform1f("u_mix", mix);
    ctx.setUniform1f("u_phase", phase);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const trail = clamp01(p.trail ?? ECHO_DEFAULTS.trail);
    const mix = clamp01(p.mix ?? ECHO_DEFAULTS.mix);
    const period = bipolarPeriodS(trail);
    const phase = lfoPhase(t, fx.inS, period);
    ctx.setBlendMode("replace");
    ctx.useProgram("echo");
    ctx.bindSourceTexture();
    ctx.setUniform1f("trail", trail);
    ctx.setUniform1f("mix", mix);
    ctx.setUniform1f("phase", phase);
    ctx.drawFullscreenQuad();
  },
  // Echo's `mix` is its wet/dry — at mix=0 the additive trails vanish
  // and only the source survives. Trail (LFO timing) keeps direction.
  applyWetness(params, wetness) {
    return { ...params, mix: (params.mix ?? 0) * wetness };
  },
};

// — TAPE — Stateless Tape-Stop Approximation ————————————————

const TAPE_DEFAULTS = { bend: 0.679, warp: 0.5 } as const;

const TAPE: FxDefinition = {
  kind: "tape",
  defaultEnvelope: { attackS: 0, decayS: 0, sustain: 1, releaseS: 0 },
  label: "TAPE",
  capsuleColor: "#E5A100",
  defaultParams: { ...TAPE_DEFAULTS },
  params: [
    { id: "bend", label: "BEND", kind: "bipolar", defaultValue: TAPE_DEFAULTS.bend, min: 0, max: 1 },
    { id: "warp", label: "WARP", kind: "linear", defaultValue: TAPE_DEFAULTS.warp, min: 0, max: 1 },
  ],
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  drawCanvas2D(ctx, fx, w, h, t, source) {
    const p = fx.params ?? {};
    const bend = clamp01(p.bend ?? TAPE_DEFAULTS.bend);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    if (!source) return;
    const period = bipolarPeriodS(bend);
    // One-shot: tape decelerates over `period`, then stays stopped.
    // The envelope's wetness raises the phase floor — with a rectangle
    // envelope (wetness=1 from t=0) the tape is already at full warp
    // when the region starts, instead of waiting for `bend`'s slow
    // ramp. With a soft attack, the floor rises gradually.
    const oneShot = oneShotPhase(t, fx.inS, period);
    const phaseFloor = clamp01(p.phaseFloor ?? 0);
    const phase = Math.max(oneShot, phaseFloor);
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

  drawWebGL2(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const bend = clamp01(p.bend ?? TAPE_DEFAULTS.bend);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    const period = bipolarPeriodS(bend);
    const oneShot = oneShotPhase(t, fx.inS, period);
    const phaseFloor = clamp01(p.phaseFloor ?? 0);
    const phase = Math.max(oneShot, phaseFloor);
    ctx.setBlendMode("replace");
    ctx.useProgram("tape");
    ctx.bindSourceTexture("u_source");
    ctx.setUniform1f("u_warp", warp);
    ctx.setUniform1f("u_phase", phase);
    ctx.drawFullscreenQuad();
  },
  drawWebGPU(ctx, fx, _w, _h, t) {
    const p = fx.params ?? {};
    const bend = clamp01(p.bend ?? TAPE_DEFAULTS.bend);
    const warp = clamp01(p.warp ?? TAPE_DEFAULTS.warp);
    const period = bipolarPeriodS(bend);
    const oneShot = oneShotPhase(t, fx.inS, period);
    const phaseFloor = clamp01(p.phaseFloor ?? 0);
    const phase = Math.max(oneShot, phaseFloor);
    ctx.setBlendMode("replace");
    ctx.useProgram("tape");
    ctx.bindSourceTexture();
    ctx.setUniform1f("warp", warp);
    ctx.setUniform1f("phase", phase);
    ctx.drawFullscreenQuad();
  },
  // Tape's visual stop is driven by `warp` (chroma + darken depth).
  // At wetness=0 the warp collapses to 0 → no smear, no darkening,
  // no chromatic split → identity image. Bend (which sets the one-shot
  // ramp duration) is left alone so the timing the user dialed in
  // still applies if/when wetness rises.
  //
  // We also pass wetness as a `phaseFloor` synthetic param: with a
  // rectangle envelope (wetness=1 instantly) the tape phase jumps to
  // full at t=0 instead of waiting for `bend`'s ramp — matches the
  // user's mental model that "rectangle envelope = effect on now".
  // With a soft envelope, the floor rises gradually; bend's one-shot
  // can still overtake if it's faster.
  applyWetness(params, wetness) {
    return {
      ...params,
      warp: (params.warp ?? 0) * wetness,
      phaseFloor: wetness,
    };
  },
};

function pseudoRand(seed: number): number {
  return Math.abs(Math.sin(seed * 91.345) * 43758.5453) % 1;
}

// — GRADE — Global color-grade (the "film stock" layer) ————————————
//
// Unlike the punch-in kinds, GRADE is not a momentary accent: the
// descriptor builder emits one `grade` FrameFx per active GradeSlot with
// the full `GradeParams` vector already merged in (look + macros + the
// STRENGTH blend), prepended ahead of the accents so they composite on the
// graded frame. So this entry exposes no 2-knob `params` tuple (its editing
// surface is the Overlays panel), and no `applyWetness` (its dry/wet IS the
// `strength` param, mixed inside the shader as `mix(source, graded,
// strength)`). Source-sampling REPLACE effect — same backend contract as
// RGB/ZOOM: bindSourceTexture + setBlendMode("replace").

function gradeParamsOf(fx: PunchFx): GradeParams {
  return { ...ENGINE_DEFAULTS, ...(fx.params ?? {}) } as GradeParams;
}

const GRADE: FxDefinition = {
  kind: "grade",
  label: "GRAD",
  capsuleColor: "#8C7BE0",
  defaultParams: { ...ENGINE_DEFAULTS },
  defaultLengthBeats: 0,
  defaultLengthS: 0,

  // Canvas2D fallback / export: a reduced approximation built from the same
  // idiom as the other source-FX (drawImage + ctx.filter + overlay passes).
  // Covers the dominant perceptual ops (exposure / contrast / saturation /
  // temperature / fade / vignette); grain, halation and split-tone are
  // GPU-only — the documented WEAR/UV-style fallback. Drawing the graded
  // source at alpha=strength over the (identical) backbuffer realises the
  // `mix(source, graded, strength)` blend without a second buffer.
  drawCanvas2D(ctx, fx, w, h, _t, source) {
    if (!source) return;
    const p = gradeParamsOf(fx);
    const strength = clamp01(p.strength);
    if (strength <= 0) return;
    const brightness = Math.pow(2, p.exposure);
    const contrast = Math.max(0, 1 + p.contrast);
    const saturate = Math.max(0, p.saturation);
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
    ctx.drawImage(source, 0, 0, w, h);
    ctx.filter = "none";
    if (p.temp !== 0) {
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = strength * Math.min(Math.abs(p.temp) * 0.5, 0.4);
      ctx.fillStyle = p.temp > 0 ? "#ff9b3d" : "#3da6ff";
      ctx.fillRect(0, 0, w, h);
    }
    if (p.fade > 0) {
      ctx.globalCompositeOperation = "lighten";
      ctx.globalAlpha = strength * p.fade * 0.25;
      ctx.fillStyle = "#8c8c8c";
      ctx.fillRect(0, 0, w, h);
    }
    if (p.vignette > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = strength * p.vignette;
      const cx = w / 2;
      const cy = h / 2;
      const outer = Math.hypot(cx, cy);
      const grad = ctx.createRadialGradient(cx, cy, outer * 0.5, cx, cy, outer);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  },

  drawWebGL2(ctx, fx, _w, _h, t) {
    const p = gradeParamsOf(fx);
    if (clamp01(p.strength) <= 0) return;
    ctx.setBlendMode("replace");
    ctx.useProgram("grade");
    ctx.bindSourceTexture("u_source");
    for (const key of GRADE_PARAM_KEYS) {
      ctx.setUniform1f(`u_${key}`, p[key]);
    }
    ctx.setUniform1f("u_time", t);
    ctx.drawFullscreenQuad();
  },

  drawWebGPU(ctx, fx, _w, _h, t) {
    const p = gradeParamsOf(fx);
    if (clamp01(p.strength) <= 0) return;
    ctx.setBlendMode("replace");
    ctx.useProgram("grade");
    ctx.bindSourceTexture();
    for (const key of GRADE_PARAM_KEYS) {
      ctx.setUniform1f(key, p[key]);
    }
    ctx.setUniform1f("time", t);
    ctx.drawFullscreenQuad();
  },
};

// — FILTERS — opinionated global looks ————————————————————————
//
// Each filter is a source-sampling REPLACE effect (same backend contract as
// RGB / GRADE): bindSourceTexture + setBlendMode("replace") + one uniform
// per param (u_<id> WebGL2 / <id> WebGPU) + u_time/time for the animated
// ones. The shader lives in webgl2/<kind>.frag.ts + webgpu/<kind>.wgsl.ts
// and outputs mix(source, effect, amount), so amount=0 is identity. Unlike
// the punch-ins, filters expose a VARIABLE-LENGTH `filterParams` schema
// (their OWN controls) instead of the 2-knob `params` tuple, and seed a
// tasteful non-zero default so a freshly-added filter immediately looks like
// the thing. All draws share one factory — the look lives entirely in the
// shader + the param schema.

interface FilterParamInit {
  id: string;
  label: string;
  default: number;
  min: number;
  max: number;
}

function makeFilterDef(
  kind: FxKind,
  label: string,
  capsuleColor: string,
  cssFilter: string,
  paramsInit: readonly FilterParamInit[],
): FxDefinition {
  const filterParams: FxParamDef[] = paramsInit.map((p) => ({
    id: p.id,
    label: p.label,
    kind: "linear",
    defaultValue: p.default,
    min: p.min,
    max: p.max,
  }));
  const ids = filterParams.map((p) => p.id);
  const defaultParams: Record<string, number> = {};
  for (const p of filterParams) defaultParams[p.id] = p.defaultValue;
  const read = (fx: PunchFx): Record<string, number> => ({
    ...defaultParams,
    ...(fx.params ?? {}),
  });

  return {
    kind,
    label,
    capsuleColor,
    defaultParams,
    filterParams,
    defaultLengthS: 0,

    // Reduced fallback — Canvas2D is the rare no-GPU live path (export uses
    // WebGPU). A CSS filter approximates the look; grain/texture/temporal
    // detail is GPU-only, per the WEAR/UV reduced-fidelity contract.
    drawCanvas2D(ctx, fx, w, h, _t, source) {
      if (!source) return;
      const amount = clamp01(read(fx).amount ?? 1);
      if (amount <= 0) return;
      ctx.save();
      ctx.globalAlpha = amount;
      ctx.filter = cssFilter;
      ctx.drawImage(source, 0, 0, w, h);
      ctx.filter = "none";
      ctx.restore();
    },

    drawWebGL2(ctx, fx, _w, _h, t) {
      const p = read(fx);
      if ((p.amount ?? 1) <= 0) return;
      ctx.setBlendMode("replace");
      ctx.useProgram(kind);
      ctx.bindSourceTexture("u_source");
      for (const id of ids) ctx.setUniform1f(`u_${id}`, p[id]);
      ctx.setUniform1f("u_time", t);
      ctx.drawFullscreenQuad();
    },

    drawWebGPU(ctx, fx, _w, _h, t) {
      const p = read(fx);
      if ((p.amount ?? 1) <= 0) return;
      ctx.setBlendMode("replace");
      ctx.useProgram(kind);
      ctx.bindSourceTexture();
      for (const id of ids) ctx.setUniform1f(id, p[id]);
      ctx.setUniform1f("time", t);
      ctx.drawFullscreenQuad();
    },

    // The master amount is the dry/wet — fold the ADSR wetness into it.
    applyWetness(params, wetness) {
      return { ...params, amount: (params.amount ?? 1) * wetness };
    },
  };
}

const VHS = makeFilterDef("vhs", "VHS", "#3CC3C3", "saturate(1.15) contrast(1.05)", [
  { id: "tracking", label: "TRACK", default: 0.35, min: 0, max: 1 },
  { id: "bleed", label: "BLEED", default: 0.5, min: 0, max: 1 },
  { id: "noise", label: "SNOW", default: 0.35, min: 0, max: 1 },
  { id: "wobble", label: "WOBBLE", default: 0.3, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.85, min: 0, max: 1 },
]);

const SUPER8 = makeFilterDef("super8", "SUPER-8", "#C98A3A", "sepia(0.35) saturate(0.9) brightness(1.05)", [
  { id: "grain", label: "GRAIN", default: 0.5, min: 0, max: 1 },
  { id: "weave", label: "WEAVE", default: 0.4, min: 0, max: 1 },
  { id: "flicker", label: "FLICKER", default: 0.3, min: 0, max: 1 },
  { id: "warmth", label: "WARMTH", default: 0.5, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.8, min: 0, max: 1 },
]);

const DECAY = makeFilterDef("decay", "DECAY", "#8A6A4A", "sepia(0.2) contrast(1.1) brightness(0.97)", [
  { id: "dust", label: "DUST", default: 0.4, min: 0, max: 1 },
  { id: "scratches", label: "SCRATCH", default: 0.4, min: 0, max: 1 },
  { id: "flicker", label: "FLICKER", default: 0.35, min: 0, max: 1 },
  { id: "leak", label: "LEAK", default: 0.3, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.8, min: 0, max: 1 },
]);

const NOIR = makeFilterDef("noir", "NOIR", "#4A4A52", "grayscale(1) contrast(1.4)", [
  { id: "filter", label: "FILTER", default: 0.3, min: -1, max: 1 },
  { id: "contrast", label: "CONTRAST", default: 0.5, min: 0, max: 1 },
  { id: "grain", label: "GRAIN", default: 0.3, min: 0, max: 1 },
  { id: "vignette", label: "VIGN", default: 0.5, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.9, min: 0, max: 1 },
]);

const SEPIA = makeFilterDef("sepia", "SEPIA", "#A87B45", "sepia(0.85) contrast(1.1)", [
  { id: "tone", label: "TONE", default: 0.3, min: -1, max: 1 },
  { id: "contrast", label: "CONTRAST", default: 0.4, min: 0, max: 1 },
  { id: "fade", label: "FADE", default: 0.3, min: 0, max: 1 },
  { id: "grain", label: "GRAIN", default: 0.3, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.9, min: 0, max: 1 },
]);

const POLAROID = makeFilterDef("polaroid", "INSTANT", "#E8E0D0", "saturate(0.95) brightness(1.08) contrast(0.92)", [
  { id: "fade", label: "FADE", default: 0.4, min: 0, max: 1 },
  { id: "bloom", label: "BLOOM", default: 0.4, min: 0, max: 1 },
  { id: "chem", label: "CAST", default: 0.4, min: 0, max: 1 },
  { id: "vignette", label: "VIGN", default: 0.5, min: 0, max: 1 },
  { id: "border", label: "FRAME", default: 0, min: 0, max: 1 },
  { id: "amount", label: "AMOUNT", default: 0.85, min: 0, max: 1 },
]);

export const fxCatalog: Readonly<Record<FxKind, FxDefinition>> = {
  vignette: VIGNETTE,
  wear: WEAR,
  echo: ECHO,
  rgb: RGB,
  tape: TAPE,
  zoom: ZOOM,
  uv: UV,
  grade: GRADE,
  vhs: VHS,
  super8: SUPER8,
  decay: DECAY,
  noir: NOIR,
  sepia: SEPIA,
  polaroid: POLAROID,
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
