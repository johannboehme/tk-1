/**
 * Pixel-level browser tests for WebGL2Backend. Mirrors the
 * Canvas2DBackend browser test 1:1 — same fixture, same expectations,
 * so the parity assertion is the entire test suite passing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGL2Backend } from "./webgl2-backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

type Color = "R" | "G" | "B" | "Y";
type Quadrant = "TL" | "TR" | "BL" | "BR";

const COLOR: Record<Color, [number, number, number]> = {
  R: [255, 0, 0],
  G: [0, 255, 0],
  B: [0, 0, 255],
  Y: [255, 255, 0],
};

let bitmap: ImageBitmap;

beforeAll(async () => {
  const off = new OffscreenCanvas(100, 100);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = "rgb(255,0,0)";
  ctx.fillRect(0, 0, 50, 50);
  ctx.fillStyle = "rgb(0,255,0)";
  ctx.fillRect(50, 0, 50, 50);
  ctx.fillStyle = "rgb(0,0,255)";
  ctx.fillRect(0, 50, 50, 50);
  ctx.fillStyle = "rgb(255,255,0)";
  ctx.fillRect(50, 50, 50, 50);
  bitmap = await createImageBitmap(off);
});

afterAll(() => {
  bitmap.close();
});

function quadrantCentre(q: Quadrant): { x: number; y: number } {
  switch (q) {
    case "TL":
      return { x: 25, y: 25 };
    case "TR":
      return { x: 75, y: 25 };
    case "BL":
      return { x: 25, y: 75 };
    case "BR":
      return { x: 75, y: 75 };
  }
}

/** WebGL2 readPixels reads from the bottom-left of the framebuffer.
 *  Convert the canvas-Y-down sample point to readPixels coords. */
function colourAt(
  gl: WebGL2RenderingContext,
  q: Quadrant,
  canvasH: number,
): Color | "?" {
  const { x, y } = quadrantCentre(q);
  const data = new Uint8Array(4);
  gl.readPixels(x, canvasH - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  for (const [name, target] of Object.entries(COLOR) as [
    Color,
    [number, number, number],
  ][]) {
    const dr = Math.abs(data[0] - target[0]);
    const dg = Math.abs(data[1] - target[1]);
    const db = Math.abs(data[2] - target[2]);
    if (dr + dg + db < 30) return name;
  }
  return "?";
}

function videoLayer(over: Partial<FrameLayer> = {}): FrameLayer {
  return {
    layerId: "a",
    source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
    weight: 1,
    fitRect: { x: 0, y: 0, w: 100, h: 100 },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    displayW: 100,
    displayH: 100,
    ...over,
  };
}

function descriptor(
  layers: FrameLayer[],
  fx: FrameDescriptor["fx"] = [],
): FrameDescriptor {
  return { tMaster: 0, output: { w: 100, h: 100 }, layers, fx };
}

async function paint(
  layer: FrameLayer,
): Promise<{ canvas: HTMLCanvasElement; backend: WebGL2Backend }> {
  const canvas = document.createElement("canvas");
  const backend = new WebGL2Backend();
  await backend.init(canvas, { pixelW: 100, pixelH: 100 });
  backend.drawFrame(
    descriptor([layer]),
    new Map([["a", { kind: "image", bitmap }]]),
  );
  return { canvas, backend };
}

// Same expected map as canvas2d-backend.browser.test.ts — these MUST
// match identically for Phase 2 parity to hold.
type CombosMap = Record<string, Record<Quadrant, Color>>;
const EXPECTED: CombosMap = {
  "0_0_0": { TL: "R", TR: "G", BL: "B", BR: "Y" },
  "0_1_0": { TL: "G", TR: "R", BL: "Y", BR: "B" },
  "0_0_1": { TL: "B", TR: "Y", BL: "R", BR: "G" },
  "0_1_1": { TL: "Y", TR: "B", BL: "G", BR: "R" },
  "90_0_0": { TL: "B", TR: "R", BL: "Y", BR: "G" },
  "90_1_0": { TL: "Y", TR: "G", BL: "B", BR: "R" },
  "90_0_1": { TL: "R", TR: "B", BL: "G", BR: "Y" },
  "90_1_1": { TL: "G", TR: "Y", BL: "R", BR: "B" },
  "180_0_0": { TL: "Y", TR: "B", BL: "G", BR: "R" },
  "180_1_0": { TL: "B", TR: "Y", BL: "R", BR: "G" },
  "180_0_1": { TL: "G", TR: "R", BL: "Y", BR: "B" },
  "180_1_1": { TL: "R", TR: "G", BL: "B", BR: "Y" },
  "270_0_0": { TL: "G", TR: "Y", BL: "R", BR: "B" },
  "270_1_0": { TL: "R", TR: "B", BL: "G", BR: "Y" },
  "270_0_1": { TL: "Y", TR: "G", BL: "B", BR: "R" },
  "270_1_1": { TL: "B", TR: "R", BL: "Y", BR: "G" },
};

describe("WebGL2Backend — rotation/flip pixel parity vs Canvas2DBackend", () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const [rotStr, fxStr, fyStr] = key.split("_");
    const rotationDeg = Number(rotStr) as 0 | 90 | 180 | 270;
    const flipX = fxStr === "1";
    const flipY = fyStr === "1";

    it(`rot=${rotationDeg} flipX=${flipX} flipY=${flipY}`, async () => {
      const { canvas, backend } = await paint(
        videoLayer({ rotationDeg, flipX, flipY }),
      );
      const gl = canvas.getContext("webgl2")!;
      const actual = {
        TL: colourAt(gl, "TL", canvas.height),
        TR: colourAt(gl, "TR", canvas.height),
        BL: colourAt(gl, "BL", canvas.height),
        BR: colourAt(gl, "BR", canvas.height),
      };
      backend.dispose();
      expect(actual).toEqual(expected);
    });
  }
});

describe("WebGL2Backend — letterbox / pillarbox pixel parity", () => {
  it("pillarbox: bg pillars are opaque black, source area not", async () => {
    const canvas = document.createElement("canvas");
    const backend = new WebGL2Backend();
    await backend.init(canvas, { pixelW: 200, pixelH: 100 });
    backend.drawFrame(
      {
        tMaster: 0,
        output: { w: 200, h: 100 },
        layers: [
          {
            layerId: "a",
            source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
            weight: 1,
            fitRect: { x: 50, y: 0, w: 100, h: 100 },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            displayW: 100,
            displayH: 100,
          },
        ],
        fx: [],
      },
      new Map([["a", { kind: "image", bitmap }]]),
    );
    const gl = canvas.getContext("webgl2")!;
    const left = new Uint8Array(4);
    gl.readPixels(10, 50, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, left);
    expect(left[0] + left[1] + left[2]).toBeLessThan(15);
    backend.dispose();
  });
});

describe("WebGL2Backend — vignette FX pixel parity", () => {
  it("corners darker than center after vignette pass", async () => {
    const canvas = document.createElement("canvas");
    const backend = new WebGL2Backend();
    await backend.init(canvas, { pixelW: 100, pixelH: 100 });
    await backend.warmup();
    backend.drawFrame(
      descriptor(
        [videoLayer()],
        [{ id: "f1", kind: "vignette", inS: 0, params: { intensity: 0.9, falloff: 0.9 }, wetness: 1 }],
      ),
      new Map([["a", { kind: "image", bitmap }]]),
    );
    const gl = canvas.getContext("webgl2")!;
    const corner = new Uint8Array(4);
    const centre = new Uint8Array(4);
    gl.readPixels(2, 100 - 2 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner);
    gl.readPixels(50, 100 - 50 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, centre);
    const cornerSum = corner[0] + corner[1] + corner[2];
    const centreSum = centre[0] + centre[1] + centre[2];
    expect(cornerSum).toBeLessThan(centreSum);
    backend.dispose();
  });
});

describe("WebGL2Backend — lifecycle + warmup", () => {
  it("warmup compiles registered fx programs without error", async () => {
    const canvas = document.createElement("canvas");
    const backend = new WebGL2Backend();
    await backend.init(canvas, { pixelW: 16, pixelH: 16 });
    await expect(backend.warmup()).resolves.toBeUndefined();
    backend.dispose();
  });

  it("dispose() is idempotent (safe to call twice)", async () => {
    const canvas = document.createElement("canvas");
    const backend = new WebGL2Backend();
    await backend.init(canvas, { pixelW: 16, pixelH: 16 });
    backend.dispose();
    expect(() => backend.dispose()).not.toThrow();
  });
});
