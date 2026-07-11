/**
 * Pixel-level browser tests for Canvas2DBackend. jsdom can't drive
 * Canvas2D for real, so the rotation/flip parity tests live here.
 *
 * The fixture is a 4-quadrant 100×100 ImageBitmap:
 *
 *     +-------+-------+
 *     |  RED  | GREEN |
 *     |  TL   |  TR   |
 *     +-------+-------+
 *     | BLUE  | YELLOW|
 *     |  BL   |  BR   |
 *     +-------+-------+
 *
 * After drawing the bitmap into a 100×100 backbuffer with each of the
 * 16 (rotation × flipX × flipY) combos, we sample the four quadrant
 * centres and assert which colour landed where. The expected mapping
 * mirrors `compositor.ts`'s translate→rotate→scale order, so when
 * Schritt 8 routes the export through this backend, the existing
 * `format-matrix.browser.test.ts` keeps passing without changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Canvas2DBackend } from "./canvas2d-backend";
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

function colourAt(canvas: HTMLCanvasElement, q: Quadrant): Color | "?" {
  const ctx = canvas.getContext("2d")!;
  const { x, y } = quadrantCentre(q);
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  for (const [name, target] of Object.entries(COLOR) as [Color, [number, number, number]][]) {
    const dr = Math.abs(r - target[0]);
    const dg = Math.abs(g - target[1]);
    const db = Math.abs(b - target[2]);
    if (dr + dg + db < 20) return name;
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

function descriptor(layers: FrameLayer[], fx: FrameDescriptor["fx"] = []): FrameDescriptor {
  return { tMaster: 0, output: { w: 100, h: 100 }, layers, fx };
}

async function paint(layer: FrameLayer): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  const b = new Canvas2DBackend();
  await b.init(canvas, { pixelW: 100, pixelH: 100 });
  b.drawFrame(
    descriptor([layer]),
    new Map([["a", { kind: "image", bitmap }]]),
  );
  return canvas;
}

// Expected quadrant→colour map for each (rot, flipX, flipY) combo.
// translate→rotate→scale order matches compositor.ts compositeImage.
type CombosMap = Record<string, Record<Quadrant, Color>>;
const EXPECTED: CombosMap = {
  // identity
  "0_0_0": { TL: "R", TR: "G", BL: "B", BR: "Y" },
  // flipX only — horizontal mirror
  "0_1_0": { TL: "G", TR: "R", BL: "Y", BR: "B" },
  // flipY only — vertical mirror
  "0_0_1": { TL: "B", TR: "Y", BL: "R", BR: "G" },
  // both flips
  "0_1_1": { TL: "Y", TR: "B", BL: "G", BR: "R" },
  // rotate 90° (clockwise per Canvas2D positive-Y angle)
  "90_0_0": { TL: "B", TR: "R", BL: "Y", BR: "G" },
  // rotate 90° + flipX. Order is translate→rotate→scale→drawImage, so
  // scale(-1,1) acts in the rotated frame — i.e. mirrors the source's
  // vertical axis (the rotated frame's X = source Y).
  "90_1_0": { TL: "Y", TR: "G", BL: "B", BR: "R" },
  // rotate 90° + flipY. Mirrors source horizontal axis pre-rotation.
  "90_0_1": { TL: "R", TR: "B", BL: "G", BR: "Y" },
  "90_1_1": { TL: "G", TR: "Y", BL: "R", BR: "B" },
  // rotate 180°
  "180_0_0": { TL: "Y", TR: "B", BL: "G", BR: "R" },
  "180_1_0": { TL: "B", TR: "Y", BL: "R", BR: "G" },
  "180_0_1": { TL: "G", TR: "R", BL: "Y", BR: "B" },
  "180_1_1": { TL: "R", TR: "G", BL: "B", BR: "Y" },
  // rotate 270°
  "270_0_0": { TL: "G", TR: "Y", BL: "R", BR: "B" },
  "270_1_0": { TL: "R", TR: "B", BL: "G", BR: "Y" },
  "270_0_1": { TL: "Y", TR: "G", BL: "B", BR: "R" },
  "270_1_1": { TL: "B", TR: "R", BL: "Y", BR: "G" },
};

describe("Canvas2DBackend — rotation/flip pixel parity (16 combos)", () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const [rotStr, fxStr, fyStr] = key.split("_");
    const rotationDeg = Number(rotStr) as 0 | 90 | 180 | 270;
    const flipX = fxStr === "1";
    const flipY = fyStr === "1";

    it(`rot=${rotationDeg} flipX=${flipX} flipY=${flipY}`, async () => {
      const canvas = await paint(videoLayer({ rotationDeg, flipX, flipY }));
      const actual = {
        TL: colourAt(canvas, "TL"),
        TR: colourAt(canvas, "TR"),
        BL: colourAt(canvas, "BL"),
        BR: colourAt(canvas, "BR"),
      };
      expect(actual).toEqual(expected);
    });
  }
});

describe("Canvas2DBackend — letterbox / pillarbox pixel parity", () => {
  it("pillarbox: square source in wide canvas → bg visible left/right", async () => {
    const canvas = document.createElement("canvas");
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 200, pixelH: 100 });
    // 100×100 source into 200×100 output → fitRect 100 wide, centred at x=50
    b.drawFrame(
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
    // Sample x=10, y=50 — inside the left pillar, should be background black
    const ctx = canvas.getContext("2d")!;
    const [lr, lg, lb] = ctx.getImageData(10, 50, 1, 1).data;
    expect(lr + lg + lb).toBeLessThan(15); // black
    // Sample inside the source area (x=100, y=50) — at quadrant boundary,
    // colour will be one of the four. Anything but black confirms source is drawn.
    const [cr, cg, cb] = ctx.getImageData(100, 50, 1, 1).data;
    expect(cr + cg + cb).toBeGreaterThan(50);
  });
});

describe("Canvas2DBackend — last-good-frame fallback", () => {
  // The runtime hands the backend a `video` source with
  // `preferFallback=true` + a cached ImageBitmap during the few decode
  // frames after a seek/loop-wrap. The backend must paint pixels from
  // that bitmap, not from the stale/empty <video> — otherwise the
  // black background-clear shows through and the user sees a flash.

  it("draws the fallback bitmap when preferFallback=true", async () => {
    // Use a small distinct bitmap so we can prove the fallback path,
    // not the global 4-quadrant fixture.
    const off = new OffscreenCanvas(20, 20);
    const fctx = off.getContext("2d")!;
    fctx.fillStyle = "rgb(0, 200, 100)"; // teal-ish, unique vs fixture
    fctx.fillRect(0, 0, 20, 20);
    const fallback = await createImageBitmap(off);

    const canvas = document.createElement("canvas");
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 100 });

    // Real <video> element — readyState is 0, so without the fallback
    // the layer would draw nothing and the bg-clear (#000) would win.
    const videoEl = document.createElement("video");
    b.drawFrame(
      descriptor([videoLayer()]),
      new Map([
        [
          "a",
          {
            kind: "video",
            element: videoEl,
            fallback,
            preferFallback: true,
          },
        ],
      ]),
    );
    const ctx = canvas.getContext("2d")!;
    const px = ctx.getImageData(50, 50, 1, 1).data;
    expect(Math.abs(px[0] - 0)).toBeLessThan(20);
    expect(Math.abs(px[1] - 200)).toBeLessThan(20);
    expect(Math.abs(px[2] - 100)).toBeLessThan(20);
    fallback.close();
  });

  it("ignores fallback when preferFallback is not set", async () => {
    const off = new OffscreenCanvas(20, 20);
    const fctx = off.getContext("2d")!;
    fctx.fillStyle = "rgb(0, 200, 100)";
    fctx.fillRect(0, 0, 20, 20);
    const fallback = await createImageBitmap(off);

    const canvas = document.createElement("canvas");
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 100 });

    const videoEl = document.createElement("video"); // readyState=0 → empty
    b.drawFrame(
      descriptor([videoLayer()]),
      new Map([
        [
          "a",
          {
            kind: "video",
            element: videoEl,
            fallback, // present but flag is false → must not paint
            preferFallback: false,
          },
        ],
      ]),
    );
    const ctx = canvas.getContext("2d")!;
    const px = ctx.getImageData(50, 50, 1, 1).data;
    // Background-clear black wins (or whatever the empty <video> draws).
    // Crucially, the teal fallback must NOT be visible.
    const isTeal =
      Math.abs(px[0] - 0) < 20 &&
      Math.abs(px[1] - 200) < 20 &&
      Math.abs(px[2] - 100) < 20;
    expect(isTeal).toBe(false);
    fallback.close();
  });
});

describe("Canvas2DBackend — vignette FX pixel parity", () => {
  it("corners are darker than center after vignette pass", async () => {
    const canvas = document.createElement("canvas");
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 100 });
    b.drawFrame(
      descriptor([videoLayer()], [
        { id: "f1", kind: "vignette", inS: 0, params: { intensity: 0.9, falloff: 0.9 }, wetness: 1 },
      ]),
      new Map([["a", { kind: "image", bitmap }]]),
    );
    const ctx = canvas.getContext("2d")!;
    const corner = ctx.getImageData(2, 2, 1, 1).data; // TL corner — was R(255,0,0)
    const centre = ctx.getImageData(50, 50, 1, 1).data;
    // After vignette, corner channel should be < the unmodulated red.
    // Centre is at the quadrant boundary so it picks one of the 4 colours
    // unmodulated (vignette = 0 at centre).
    expect(corner[0]).toBeLessThan(255);
    // Sum of corner channels should be lower than centre's max channel.
    const cornerSum = corner[0] + corner[1] + corner[2];
    const centreSum = centre[0] + centre[1] + centre[2];
    expect(cornerSum).toBeLessThan(centreSum);
  });
});
