import { describe, expect, it, vi } from "vitest";
import { Canvas2DBackend } from "./canvas2d-backend";
import type { LayerSource, SourcesMap } from "./backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

/** Records ctx-method calls in order so we can assert sequence (clear,
 *  setTransform, fillRect, drawImage, …). jsdom has no real Canvas2D
 *  context — this is the same mock pattern as canvas2d-renderer.test.ts. */
interface MockCtx {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  createRadialGradient: ReturnType<typeof vi.fn>;
  fillStyle: unknown;
}

function makeMockCanvas(): {
  canvas: HTMLCanvasElement;
  calls: { name: string; args: unknown[] }[];
  ctx: MockCtx;
} {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args });
    });
  const ctx: MockCtx = {
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    fillRect: rec("fillRect"),
    drawImage: rec("drawImage"),
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    rotate: rec("rotate"),
    scale: rec("scale"),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "" as unknown,
  };
  const canvas = document.createElement("canvas");
  (canvas as unknown as { getContext: () => MockCtx }).getContext = () => ctx;
  return { canvas, calls, ctx };
}

function videoLayer(over: Partial<FrameLayer> = {}): FrameLayer {
  return {
    layerId: "a",
    source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 60 },
    weight: 1,
    fitRect: { x: 0, y: 0, w: 100, h: 50 },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    displayW: 100,
    displayH: 50,
    ...over,
  };
}

function descriptor(over: Partial<FrameDescriptor> = {}): FrameDescriptor {
  return {
    tMaster: 0,
    output: { w: 100, h: 50 },
    layers: [],
    fx: [],
    ...over,
  };
}

function sources(...entries: [string, LayerSource][]): SourcesMap {
  return new Map(entries);
}

const fakeImg = document.createElement("img") as unknown as HTMLImageElement;

// ----------------------------------------------------------------------

describe("Canvas2DBackend — lifecycle", () => {
  it("init() acquires the 2d context and resizes the canvas", async () => {
    const { canvas } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 200, pixelH: 100 });
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
  });

  it("init() throws BackendError when context unavailable", async () => {
    const canvas = document.createElement("canvas");
    (canvas as unknown as { getContext: () => null }).getContext = () => null;
    const b = new Canvas2DBackend();
    await expect(b.init(canvas, { pixelW: 1, pixelH: 1 })).rejects.toThrow(
      /getContext/,
    );
  });

  it("resize() updates only the backbuffer pixel dims (no inline CSS)", async () => {
    const { canvas } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.resize({ pixelW: 400, pixelH: 200, cssW: 200, cssH: 100 });
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    // Intentionally untouched — the container drives CSS size.
    expect(canvas.style.width).toBe("");
  });

  it("warmup() resolves immediately (no compile step)", async () => {
    const { canvas } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 1, pixelH: 1 });
    await expect(b.warmup()).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------

describe("Canvas2DBackend — drawFrame structure", () => {
  it("clears the backbuffer on every frame", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(descriptor(), new Map());
    expect(calls.find((c) => c.name === "clearRect")).toBeTruthy();
  });

  it("returns early when output is null", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(descriptor({ output: null }), new Map());
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(0);
    expect(calls.filter((c) => c.name === "fillRect")).toHaveLength(0);
  });

  it("paints background fillRect when output is set", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(descriptor(), new Map());
    expect(calls.find((c) => c.name === "fillRect")).toBeTruthy();
  });

  it("scales output→pixel via setTransform when caps differ from output", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    // pixel = 200×100, output = 100×50 → scale 2×2
    await b.init(canvas, { pixelW: 200, pixelH: 100 });
    b.drawFrame(descriptor({ output: { w: 100, h: 50 } }), new Map());
    const lastSetTransform = [...calls].reverse().find((c) => c.name === "setTransform");
    expect(lastSetTransform?.args.slice(0, 4)).toEqual([2, 0, 0, 2]);
  });

  it("skips a layer when its source is missing from the sources map", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(descriptor({ layers: [videoLayer()] }), new Map());
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(0);
  });

  it("skips test-pattern source (DOM overlay handles it)", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({
        layers: [videoLayer({ source: { kind: "test-pattern" } })],
      }),
      sources(["a", { kind: "test-pattern" }]),
    );
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(0);
  });

  it("skips layer with weight <= 0", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({ layers: [videoLayer({ weight: 0 })] }),
      sources(["a", { kind: "image", bitmap: fakeImg }]),
    );
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------

describe("Canvas2DBackend — layer rotation/flip composition", () => {
  it("rotation 0 + no flip: single drawImage at fitRect (no transform stack)", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({ layers: [videoLayer()] }),
      sources(["a", { kind: "image", bitmap: fakeImg }]),
    );
    const draws = calls.filter((c) => c.name === "drawImage");
    expect(draws).toHaveLength(1);
    expect(draws[0].args.slice(1)).toEqual([0, 0, 100, 50]);
    // No save/restore stack for the layer itself when no transform needed.
    expect(calls.filter((c) => c.name === "save")).toHaveLength(0);
  });

  it("rotation 90: translate→rotate→drawImage with swapped draw dims", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({
        layers: [
          videoLayer({
            rotationDeg: 90,
            displayW: 50,
            displayH: 100,
            fitRect: { x: 0, y: 0, w: 100, h: 50 },
          }),
        ],
      }),
      sources(["a", { kind: "image", bitmap: fakeImg }]),
    );
    const seq = calls.map((c) => c.name);
    const i = seq.indexOf("save");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(seq.slice(i, i + 5)).toEqual([
      "save",
      "translate",
      "rotate",
      "drawImage",
      "restore",
    ]);
    const draw = calls.find((c) => c.name === "drawImage")!;
    // For 90°: drawW = fitRect.h = 50, drawH = fitRect.w = 100; placed
    // symmetrically around the (0,0) of the rotated coord system.
    expect(draw.args.slice(1)).toEqual([-25, -50, 50, 100]);
  });

  it("flipX only (no rotation): translate→scale(-1,1)→drawImage", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({ layers: [videoLayer({ flipX: true })] }),
      sources(["a", { kind: "image", bitmap: fakeImg }]),
    );
    const scaleCall = calls.find((c) => c.name === "scale");
    expect(scaleCall?.args).toEqual([-1, 1]);
    const seq = calls.map((c) => c.name);
    expect(seq).toContain("save");
    expect(seq).toContain("restore");
  });

  it("rotation 180 + flipY: rotate then scale(1,-1) (post-rotation flip)", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({
        layers: [videoLayer({ rotationDeg: 180, flipY: true })],
      }),
      sources(["a", { kind: "image", bitmap: fakeImg }]),
    );
    const seq = calls.map((c) => c.name);
    const rotIdx = seq.indexOf("rotate");
    const sclIdx = seq.indexOf("scale", rotIdx);
    expect(rotIdx).toBeGreaterThan(0);
    expect(sclIdx).toBe(rotIdx + 1);
    const scl = calls.find((c) => c.name === "scale");
    expect(scl?.args).toEqual([1, -1]);
  });
});

// ----------------------------------------------------------------------

describe("Canvas2DBackend — fx pass", () => {
  it("calls fxCatalog.drawCanvas2D wrapped in save/restore for each active fx", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(
      descriptor({
        fx: [
          { id: "f1", kind: "vignette", inS: 0, params: { intensity: 0.5, falloff: 0.5 }, wetness: 1 },
          { id: "f2", kind: "vignette", inS: 0, params: { intensity: 0.3, falloff: 0.7 }, wetness: 1 },
        ],
      }),
      new Map(),
    );
    // Vignette draws a single fillRect each.
    const fillRects = calls.filter((c) => c.name === "fillRect");
    // 1 background + 2 fx = 3 fillRects
    expect(fillRects).toHaveLength(3);
    // save/restore must be paired and equal in count
    const saves = calls.filter((c) => c.name === "save").length;
    const restores = calls.filter((c) => c.name === "restore").length;
    expect(saves).toBe(restores);
    expect(saves).toBeGreaterThanOrEqual(2); // at least one per fx
  });

  it("no fx draws when descriptor.fx is empty", async () => {
    const { canvas, calls } = makeMockCanvas();
    const b = new Canvas2DBackend();
    await b.init(canvas, { pixelW: 100, pixelH: 50 });
    b.drawFrame(descriptor(), new Map());
    expect(calls.filter((c) => c.name === "createRadialGradient")).toHaveLength(0);
  });
});
