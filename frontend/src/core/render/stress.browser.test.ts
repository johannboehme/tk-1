/**
 * Stress fixture for the Phase-2 compositor — synthetic 4 layers + 3
 * vignette FX at 720p, target sustained < 16 ms p95 per frame.
 *
 * V2 cuts are exclusive (one active layer at a time), but the descriptor
 * already carries N layers so V3 crossfades drop in without a backend
 * change. This stress is the V3-readiness check: the backend can iterate
 * 4 layers + 3 fx in one pass without breaching the 60 fps frame budget.
 *
 * 720p chosen because it's the editor's typical live-preview resolution
 * (the OutputFrameBox sits in a panel, rarely full-screen) AND keeps the
 * test cheap enough to be stable in CI (1080p × 4 layers gets sketchy on
 * shared runners). The scale-dial would ratchet 1080p down to ~720p
 * automatically anyway.
 *
 * If this test fails on the user's dev machine, the Schritt-9
 * `setScale(0.75)` dial is the immediate workaround; an auto-degrader
 * with PerfMonitor hysteresis lands as a follow-up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Canvas2DBackend } from "./canvas2d-backend";
import { WebGL2Backend } from "./webgl2-backend";
import type { CompositorBackend, LayerSource, SourcesMap } from "./backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

const W = 1280;
const H = 720;
const N_LAYERS = 4;
const N_FX = 3;
const N_FRAMES = 60;
const N_WARMUP = 5;
const P95_BUDGET_MS = 16;

let bitmaps: ImageBitmap[] = [];

beforeAll(async () => {
  // Four distinct ImageBitmaps — one per "cam". Different colours so a
  // mis-bound texture would jump out, but the actual pixel content
  // doesn't matter for the perf measurement.
  const colours = ["#c44", "#4a8", "#48c", "#cc4"];
  bitmaps = await Promise.all(
    colours.map(async (c) => {
      const off = new OffscreenCanvas(W, H);
      const ctx = off.getContext("2d")!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, W, H);
      // Add a couple of small detail rects so a renderer that's
      // accidentally scaling/clipping leaves a visible artefact (and
      // also costs a non-trivial draw on the upload).
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(W / 2 - 50, H / 2 - 50, 100, 100);
      return createImageBitmap(off);
    }),
  );
});

afterAll(() => {
  for (const bm of bitmaps) bm.close();
});

function makeStressDescriptor(): FrameDescriptor {
  const layers: FrameLayer[] = [];
  for (let i = 0; i < N_LAYERS; i++) {
    layers.push({
      layerId: `cam${i}`,
      source: { kind: "video", clipId: `cam${i}`, sourceTimeS: 0, sourceDurS: 1 },
      // V2 is exclusive but for the stress we light all 4 to test
      // worst-case texture upload + draw cost. V3 crossfade math.
      weight: 1,
      fitRect: { x: 0, y: 0, w: W, h: H },
      rotationDeg: 0,
      flipX: false,
      flipY: false,
      displayW: W,
      displayH: H,
    });
  }
  const fx = [];
  for (let i = 0; i < N_FX; i++) {
    fx.push({
      id: `fx${i}`,
      kind: "vignette" as const,
      inS: 0,
      params: { intensity: 0.5 + i * 0.15, falloff: 0.4 + i * 0.2 },
      wetness: 1,
    });
  }
  return { tMaster: 0, output: { w: W, h: H }, layers, fx };
}

function makeSourcesMap(): SourcesMap {
  const map = new Map<string, LayerSource>();
  for (let i = 0; i < N_LAYERS; i++) {
    map.set(`cam${i}`, { kind: "image", bitmap: bitmaps[i] });
  }
  return map;
}

function p(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function timeBackend(backend: CompositorBackend): Promise<{ p50: number; p95: number; max: number }> {
  const descriptor = makeStressDescriptor();
  const sources = makeSourcesMap();
  // Warm-up frames — first paint pays texture upload + shader compile
  // cost we don't want polluting the measurement. The plan baseline
  // (Phase 1) measures steady-state.
  for (let i = 0; i < N_WARMUP; i++) {
    backend.drawFrame(descriptor, sources);
  }
  const samples: number[] = [];
  for (let i = 0; i < N_FRAMES; i++) {
    const t0 = performance.now();
    backend.drawFrame(descriptor, sources);
    samples.push(performance.now() - t0);
  }
  return {
    p50: p(samples, 0.5),
    p95: p(samples, 0.95),
    max: samples.reduce((a, b) => Math.max(a, b), 0),
  };
}

describe("Compositor stress fixture — 4 layers + 3 FX @ 720p", () => {
  it("Canvas2DBackend: p95 < 16 ms (60 fps budget)", async () => {
    const canvas = document.createElement("canvas");
    const backend = new Canvas2DBackend();
    await backend.init(canvas, { pixelW: W, pixelH: H });
    const stats = await timeBackend(backend);
    backend.dispose();
    console.log(`[stress canvas2d] p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`);
    expect(stats.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it("WebGL2Backend: p95 < 16 ms (60 fps budget)", async () => {
    const canvas = document.createElement("canvas");
    const backend = new WebGL2Backend();
    await backend.init(canvas, { pixelW: W, pixelH: H });
    await backend.warmup();
    const stats = await timeBackend(backend);
    backend.dispose();
    console.log(`[stress webgl2] p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`);
    expect(stats.p95).toBeLessThan(P95_BUDGET_MS);
  });
});
