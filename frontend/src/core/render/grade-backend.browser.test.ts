/**
 * End-to-end GPU verification of the global color-grade FX: compiles the
 * real grade.frag / grade.wgsl on a live GPU, drives a known source frame
 * through it, and checks the graded pixels. Also asserts WebGL2 ≡ WebGPU
 * (the "Parität pro FX in beiden GPU-Backends" contract).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGL2Backend } from "./webgl2-backend";
import { WebGPUBackend } from "./webgpu-backend";
import type { FrameDescriptor, FrameFx, FrameLayer } from "./frame-descriptor";
import { ENGINE_DEFAULTS } from "../fx/looks";

// A non-grey source so saturation / temperature shifts are observable.
const SRC: [number, number, number] = [180, 100, 60];
let bitmap: ImageBitmap;

beforeAll(async () => {
  const off = new OffscreenCanvas(100, 100);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = `rgb(${SRC[0]},${SRC[1]},${SRC[2]})`;
  ctx.fillRect(0, 0, 100, 100);
  bitmap = await createImageBitmap(off);
});

afterAll(() => bitmap.close());

const layer: FrameLayer = {
  layerId: "a",
  source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
  weight: 1,
  fitRect: { x: 0, y: 0, w: 100, h: 100 },
  rotationDeg: 0,
  flipX: false,
  flipY: false,
  displayW: 100,
  displayH: 100,
};

const gradeFx = (params: Record<string, number>): FrameFx => ({
  id: "g",
  kind: "grade",
  inS: 0,
  params,
  wetness: 1,
});

function descriptor(fx: FrameFx[]): FrameDescriptor {
  return { tMaster: 0, output: { w: 100, h: 100 }, layers: [layer], fx };
}

const asRecord = (p: object) => p as unknown as Record<string, number>;

async function webgl2Centre(params: Record<string, number>): Promise<[number, number, number]> {
  const canvas = document.createElement("canvas");
  const backend = new WebGL2Backend();
  await backend.init(canvas, { pixelW: 100, pixelH: 100 });
  backend.drawFrame(descriptor([gradeFx(params)]), new Map([["a", { kind: "image", bitmap }]]));
  const gl = canvas.getContext("webgl2")!;
  const data = new Uint8Array(4);
  gl.readPixels(50, 100 - 50 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  backend.dispose();
  return [data[0], data[1], data[2]];
}

async function webgpuCentre(params: Record<string, number>): Promise<[number, number, number]> {
  const canvas = document.createElement("canvas");
  const backend = new WebGPUBackend();
  await backend.init(canvas, { pixelW: 100, pixelH: 100 });
  backend.drawFrame(descriptor([gradeFx(params)]), new Map([["a", { kind: "image", bitmap }]]));
  const px = await backend.readbackForTest(50, 50, 1, 1);
  backend.dispose();
  return [px[0], px[1], px[2]];
}

describe("grade FX — WebGL2 GPU correctness", () => {
  it("strength 0 is a literal identity pass", async () => {
    const [r, g, b] = await webgl2Centre(asRecord({ ...ENGINE_DEFAULTS, strength: 0, temp: 1 }));
    expect(Math.abs(r - SRC[0])).toBeLessThan(4);
    expect(Math.abs(g - SRC[1])).toBeLessThan(4);
    expect(Math.abs(b - SRC[2])).toBeLessThan(4);
  });

  it("warm temperature lifts red and drops blue", async () => {
    const [r, , b] = await webgl2Centre(asRecord({ ...ENGINE_DEFAULTS, temp: 0.5 }));
    expect(r).toBeGreaterThan(SRC[0]);
    expect(b).toBeLessThan(SRC[2]);
  });

  it("saturation 0 collapses to grey (R≈G≈B)", async () => {
    const [r, g, b] = await webgl2Centre(asRecord({ ...ENGINE_DEFAULTS, saturation: 0 }));
    expect(Math.abs(r - g)).toBeLessThan(8);
    expect(Math.abs(g - b)).toBeLessThan(8);
  });
});

describe("grade FX — WebGPU correctness + GPU↔GPU parity", () => {
  it("strength 0 is a literal identity pass on WebGPU too", async () => {
    const [r, g, b] = await webgpuCentre(asRecord({ ...ENGINE_DEFAULTS, strength: 0, temp: 1 }));
    expect(Math.abs(r - SRC[0])).toBeLessThan(4);
    expect(Math.abs(g - SRC[1])).toBeLessThan(4);
    expect(Math.abs(b - SRC[2])).toBeLessThan(4);
  });

  it("WebGL2 and WebGPU grade a warm look to the same pixel (±6 LSB)", async () => {
    const params = asRecord({
      ...ENGINE_DEFAULTS,
      temp: 0.35,
      contrast: 0.3,
      saturation: 1.1,
      vibrance: 0.45,
      shadowsLift: 0.2,
      highlightsGain: 0.25,
    });
    const gl = await webgl2Centre(params);
    const gpu = await webgpuCentre(params);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(gl[i] - gpu[i]), `channel ${i}`).toBeLessThanOrEqual(6);
    }
  });
});
