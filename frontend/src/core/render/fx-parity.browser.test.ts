/**
 * Cross-backend pixel parity: WebGL2 vs WebGPU for every filter and
 * every punch-in FX ("Parität pro FX in beiden GPU-Backends" — the
 * ladder's contract). The grade FX already has this in
 * grade-backend.browser.test.ts; this file extends the same harness to
 * the rest of the catalog: render the SAME synthetic source frame
 * through both backends at a fixed master-time and compare the full
 * output frame per-sample.
 *
 * Stochastic terms (hash(sin·43758…)-noise: snow/grain/dust/scratches)
 * are precision-sensitive — a 1-ULP sin() difference between the GLSL
 * and WGSL compilers flips the hash completely. Each case therefore
 * pins two comparisons:
 *   - pixel: max |Δ| per channel over the whole frame, with the noise
 *     params zeroed where the schema allows (the deterministic look —
 *     geometry, color math, vignettes, bleeds — must match ±TOL).
 *   - mean: per-channel mean |Δ| at FULL defaults (noise included) —
 *     noise is ~zero-mean, so a diverging LOOK (different color math /
 *     placement) shifts the mean even when per-pixel grain differs.
 *
 * Skipped cleanly when WebGPU is unavailable (same pattern as
 * webgpu-backend.browser.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGL2Backend } from "./webgl2-backend";
import { WebGPUBackend } from "./webgpu-backend";
import { fxCatalog } from "../fx/catalog";
import type { FxKind } from "../fx/types";
import type { FrameDescriptor, FrameFx, FrameLayer } from "./frame-descriptor";

const HAS_WEBGPU = typeof navigator !== "undefined" && "gpu" in navigator;
const d = HAS_WEBGPU ? describe : describe.skip;

const W = 120;
const H = 120;
const T_MASTER = 0.7;
const SRC: [number, number, number] = [180, 100, 60];

let bitmap: ImageBitmap;

beforeAll(async () => {
  if (!HAS_WEBGPU) return;
  const off = new OffscreenCanvas(W, H);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = `rgb(${SRC[0]},${SRC[1]},${SRC[2]})`;
  ctx.fillRect(0, 0, W, H);
  // A bright patch so highlight/bloom/halation terms have something to
  // grab, and an off-centre cool patch so displacement/rotation
  // mistakes shift real edges.
  ctx.fillStyle = "rgb(240,235,220)";
  ctx.fillRect(40, 40, 40, 40);
  ctx.fillStyle = "rgb(40,80,160)";
  ctx.fillRect(80, 15, 25, 25);
  bitmap = await createImageBitmap(off);
});

afterAll(() => {
  if (HAS_WEBGPU && bitmap) bitmap.close();
});

const layer: FrameLayer = {
  layerId: "a",
  source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
  weight: 1,
  fitRect: { x: 0, y: 0, w: W, h: H },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  displayW: W,
  displayH: H,
};

function descriptor(fx: FrameFx[]): FrameDescriptor {
  return { tMaster: T_MASTER, output: { w: W, h: H }, layers: [layer], fx };
}

function frameFx(kind: FxKind, params: Record<string, number>): FrameFx {
  return { id: "f", kind, inS: 0, params, wetness: 1 };
}

/** Render through WebGL2 and return the full frame as RGBA bytes in
 *  canvas coordinates (row 0 = top). */
async function webgl2Frame(fx: FrameFx[]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  const backend = new WebGL2Backend();
  await backend.init(canvas, { pixelW: W, pixelH: H });
  backend.drawFrame(descriptor(fx), new Map([["a", { kind: "image", bitmap }]]));
  const gl = canvas.getContext("webgl2")!;
  const glRows = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, glRows);
  backend.dispose();
  // readPixels row 0 is the BOTTOM row — flip into canvas orientation.
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    out.set(glRows.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  }
  return out;
}

/** Render through WebGPU and return the full frame as RGBA bytes in
 *  canvas coordinates. */
async function webgpuFrame(fx: FrameFx[]): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  const backend = new WebGPUBackend();
  await backend.init(canvas, { pixelW: W, pixelH: H });
  backend.drawFrame(descriptor(fx), new Map([["a", { kind: "image", bitmap }]]));
  const px = await backend.readbackForTest(0, 0, W, H);
  backend.dispose();
  return px;
}

/** Max per-channel |Δ| over the frame (RGB, alpha ignored). */
function maxDiff(a: Uint8Array, b: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    m = Math.max(
      m,
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
  }
  return m;
}

/** Worst per-channel |Δ of block means| over an 8×8 grid of 15×15-px
 *  blocks. The right metric for the stochastic comparisons: the
 *  hash-noise (snow/grain/static) is ~zero-mean, so per-block averaging
 *  (225 samples) washes out per-pixel grain divergence between the two
 *  shader compilers, while a diverging LOOK — wrong color math, tint,
 *  vignette, geometry — shifts block means far beyond the tolerance
 *  (noir's dead WGSL module scored >100 here). */
const BLOCK = 15;
function blockMeanDiff(a: Uint8Array, b: Uint8Array): number {
  let worst = 0;
  for (let by = 0; by < H; by += BLOCK) {
    for (let bx = 0; bx < W; bx += BLOCK) {
      const sums = [0, 0, 0, 0, 0, 0];
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const i = (y * W + x) * 4;
          sums[0] += a[i];
          sums[1] += a[i + 1];
          sums[2] += a[i + 2];
          sums[3] += b[i];
          sums[4] += b[i + 1];
          sums[5] += b[i + 2];
        }
      }
      const n = BLOCK * BLOCK;
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(sums[c] - sums[c + 3]) / n);
      }
    }
  }
  return worst;
}

interface ParityCase {
  kind: FxKind;
  /** Deterministic param override for the per-pixel comparison —
   *  defaults with the hash-noise terms zeroed. null → the FX has no
   *  isolatable noise terms; per-pixel runs at defaults. */
  deterministic: Record<string, number> | null;
  /** Per-pixel tolerance for the deterministic comparison. */
  pixelTol: number;
  /** Block-mean tolerance at FULL defaults (noise included). */
  meanTol: number;
}

// Which params seed hash()-noise per FX — derived from the shaders
// (webgl2/<kind>.frag.ts and their WGSL mirrors):
//   vhs:      noise → snow/tear;   wobble → per-line hash jitter;
//             bleed also gates a sign(sin(...)) dot-crawl offset that is
//             precision-chaotic even though it contains no hash
//   super8:   grain → hash grain;  weave → per-frame hash jitter
//   decay:    dust + scratches → hash flecks
//   noir:     grain
//   sepia:    grain
//   polaroid: chem uses one hash-grain term
//   wear:     everything scales with `decay` (grain included) — no
//             isolatable deterministic subset ⇒ block-mean only
//   tape:     per-band hash drift + hash grain scale with stop/warp ⇒
//             block-mean only
//   vignette / rgb / zoom / echo / uv: fully deterministic
const CASES: ParityCase[] = [
  // — filters —
  { kind: "vhs", deterministic: { noise: 0, wobble: 0, bleed: 0 }, pixelTol: 6, meanTol: 6 },
  { kind: "super8", deterministic: { grain: 0, weave: 0 }, pixelTol: 6, meanTol: 6 },
  { kind: "decay", deterministic: { dust: 0, scratches: 0 }, pixelTol: 6, meanTol: 6 },
  { kind: "noir", deterministic: { grain: 0 }, pixelTol: 6, meanTol: 6 },
  { kind: "sepia", deterministic: { grain: 0 }, pixelTol: 6, meanTol: 6 },
  { kind: "polaroid", deterministic: { chem: 0 }, pixelTol: 6, meanTol: 6 },
  // — punch-in FX —
  { kind: "vignette", deterministic: {}, pixelTol: 6, meanTol: 6 },
  { kind: "rgb", deterministic: {}, pixelTol: 6, meanTol: 6 },
  { kind: "zoom", deterministic: {}, pixelTol: 6, meanTol: 6 },
  { kind: "echo", deterministic: {}, pixelTol: 6, meanTol: 6 },
  { kind: "uv", deterministic: {}, pixelTol: 6, meanTol: 6 },
  { kind: "wear", deterministic: null, pixelTol: 6, meanTol: 6 },
  { kind: "tape", deterministic: null, pixelTol: 6, meanTol: 6 },
];

const FILTERS: FxKind[] = ["vhs", "super8", "decay", "noir", "sepia", "polaroid"];

for (const c of CASES) {
  d(`FX "${c.kind}" — WebGL2 ↔ WebGPU parity`, () => {
    const defaults = { ...fxCatalog[c.kind].defaultParams };

    if (c.deterministic !== null) {
      it(`deterministic look matches per-pixel (±${c.pixelTol})`, async () => {
        const params = { ...defaults, ...c.deterministic };
        const gl = await webgl2Frame([frameFx(c.kind, params)]);
        const gpu = await webgpuFrame([frameFx(c.kind, params)]);
        const dMax = maxDiff(gl, gpu);
        console.log(`[parity] ${c.kind} deterministic: maxDiff=${dMax}`);
        expect(dMax).toBeLessThanOrEqual(c.pixelTol);
      });
    }

    it(`full defaults match in block means (±${c.meanTol})`, async () => {
      const gl = await webgl2Frame([frameFx(c.kind, defaults)]);
      const gpu = await webgpuFrame([frameFx(c.kind, defaults)]);
      const dBlock = blockMeanDiff(gl, gpu);
      console.log(
        `[parity] ${c.kind} defaults: blockMeanDiff=${dBlock.toFixed(3)} maxDiff=${maxDiff(gl, gpu)}`,
      );
      expect(dBlock).toBeLessThanOrEqual(c.meanTol);
    });
  });
}

d("Filters — amount=0 identity on WebGPU", () => {
  // Complements the WebGL2-only identity check in
  // grade-filters.browser.test.ts: a WebGPU filter that leaks effect at
  // amount=0 must fail here. Identity is asserted against the backend's
  // own no-FX output, so layer-pass sampling differences cancel out.
  for (const kind of FILTERS) {
    it(`"${kind}" amount=0 equals the no-FX frame`, async () => {
      const defaults = { ...fxCatalog[kind].defaultParams };
      const bare = await webgpuFrame([]);
      const zeroed = await webgpuFrame([
        frameFx(kind, { ...defaults, amount: 0 }),
      ]);
      expect(maxDiff(bare, zeroed)).toBeLessThanOrEqual(2);
    });
  }
});
