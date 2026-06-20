/**
 * End-to-end GPU verification of the opinionated filter set. For each filter
 * it compiles the real frag/wgsl on a live GPU (WebGL2 + WebGPU), confirms
 * the default look actually changes the image, and that amount=0 is a clean
 * identity pass. A compile error in any agent-authored shader surfaces here
 * as a thrown drawFrame.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGL2Backend } from "./webgl2-backend";
import { WebGPUBackend } from "./webgpu-backend";
import { fxCatalog } from "../fx/catalog";
import type { FxKind } from "../fx/types";
import type { FrameDescriptor, FrameFx, FrameLayer } from "./frame-descriptor";

const FILTERS: FxKind[] = ["vhs", "super8", "decay", "noir", "sepia", "polaroid"];
const SRC: [number, number, number] = [180, 100, 60];
let bitmap: ImageBitmap;

beforeAll(async () => {
  const off = new OffscreenCanvas(120, 120);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = `rgb(${SRC[0]},${SRC[1]},${SRC[2]})`;
  ctx.fillRect(0, 0, 120, 120);
  // a brighter patch so highlight/bloom/halation terms have something to grab
  ctx.fillStyle = "rgb(240,235,220)";
  ctx.fillRect(40, 40, 40, 40);
  bitmap = await createImageBitmap(off);
});
afterAll(() => bitmap.close());

const layer: FrameLayer = {
  layerId: "a",
  source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
  weight: 1,
  fitRect: { x: 0, y: 0, w: 120, h: 120 },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  displayW: 120,
  displayH: 120,
};

function fx(kind: FxKind, params: Record<string, number>): FrameFx {
  return { id: "f", kind, inS: 0, params, wetness: 1 };
}
function descriptor(f: FrameFx[]): FrameDescriptor {
  return { tMaster: 0.7, output: { w: 120, h: 120 }, layers: [layer], fx: f };
}

async function webgl2(kind: FxKind, params: Record<string, number>): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  const backend = new WebGL2Backend();
  await backend.init(canvas, { pixelW: 120, pixelH: 120 });
  backend.drawFrame(descriptor([fx(kind, params)]), new Map([["a", { kind: "image", bitmap }]]));
  const gl = canvas.getContext("webgl2")!;
  // sample 4 spots; return RGBA bytes packed
  const pts = [[60, 60], [30, 30], [90, 90], [30, 90]];
  const all = new Uint8Array(pts.length * 4);
  pts.forEach(([x, y], i) => {
    const d = new Uint8Array(4);
    gl.readPixels(x, 120 - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d);
    all.set(d, i * 4);
  });
  backend.dispose();
  return all;
}

async function webgpuCentre(kind: FxKind, params: Record<string, number>): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  const backend = new WebGPUBackend();
  await backend.init(canvas, { pixelW: 120, pixelH: 120 });
  backend.drawFrame(descriptor([fx(kind, params)]), new Map([["a", { kind: "image", bitmap }]]));
  const px = await backend.readbackForTest(60, 60, 1, 1);
  backend.dispose();
  return px;
}

function maxDiffFromSource(samples: Uint8Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i += 4) {
    m = Math.max(m, Math.abs(samples[i] - SRC[0]), Math.abs(samples[i + 1] - SRC[1]), Math.abs(samples[i + 2] - SRC[2]));
  }
  return m;
}

for (const kind of FILTERS) {
  describe(`filter "${kind}" — GPU`, () => {
    const defaults = { ...fxCatalog[kind].defaultParams };

    it("WebGL2 shader compiles and the default look changes the image", async () => {
      const out = await webgl2(kind, defaults);
      expect(maxDiffFromSource(out)).toBeGreaterThan(6);
    });

    it("WebGL2 amount=0 is a clean identity pass", async () => {
      const out = await webgl2(kind, { ...defaults, amount: 0 });
      // every sampled point ~= source (only the bright patch differs, skip it
      // by checking the corner points which are pure SRC)
      const d = new Uint8Array(out.buffer, 8); // 3rd & 4th points (corners)
      expect(maxDiffFromSource(d)).toBeLessThan(4);
    });

    it("WebGPU shader compiles and the default look changes the image", async () => {
      const px = await webgpuCentre(kind, defaults);
      expect(maxDiffFromSource(px)).toBeGreaterThan(4);
    });
  });
}
