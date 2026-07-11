/**
 * Regression test: two back-to-back compositeImage() calls must produce
 * VideoFrames whose pixel content is independent.
 *
 * Bug being guarded: if `new VideoFrame(canvas)` takes a zero-copy
 * reference instead of an immediate snapshot, then mutating the canvas
 * (via the next composite call) silently corrupts the previously
 * returned VideoFrame. The encoder consumes VideoFrames asynchronously,
 * so the corruption surfaces as "frames jumping back and forth" in the
 * exported MP4 — every output frame holds content from the NEXT frame.
 *
 * The test: render two distinctly-coloured ImageBitmaps via two
 * consecutive composite calls, then read pixels from BOTH returned
 * VideoFrames. Each frame must show its own colour, not the other's.
 */
import { describe, expect, it } from "vitest";
import { Compositor } from "./compositor";
import type { BackendCapabilities } from "../../core/render/factory";

const HAS_WEBGPU = typeof navigator !== "undefined" && "gpu" in navigator;

async function makeFilledBitmap(
  w: number,
  h: number,
  rgb: [number, number, number],
): Promise<ImageBitmap> {
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  ctx.fillRect(0, 0, w, h);
  return await createImageBitmap(off);
}

/** Read VideoFrame pixels into a Uint8ClampedArray via OffscreenCanvas. */
async function readFramePixels(frame: VideoFrame): Promise<{
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}> {
  const w = frame.codedWidth;
  const h = frame.codedHeight;
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext("2d")!;
  // VideoFrame is a CanvasImageSource — drawImage works directly.
  ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  return { rgba: data.data, w, h };
}

/** Average RGB at the centre 5×5 region — robust to compression /
 *  filtering noise around edges. */
function centreRgb(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const off = ((cy + dy) * w + (cx + dx)) * 4;
      r += rgba[off];
      g += rgba[off + 1];
      b += rgba[off + 2];
      n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** L1 distance between two RGB triples. */
function rgbDist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

const W = 64;
const H = 64;

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];

async function runIsolationTest(caps: BackendCapabilities): Promise<void> {
  const compositor = await Compositor.create(
    {
      width: W,
      height: H,
      sourceWidth: W,
      sourceHeight: H,
      overlays: [],
      visualizers: [],
      fx: [],
    },
    caps,
  );

  const redBitmap = await makeFilledBitmap(W, H, RED);
  const greenBitmap = await makeFilledBitmap(W, H, GREEN);

  // 1. Composite red frame.
  const v1 = await compositor.compositeImage(
    redBitmap, W, H, 0, 33333, { tTimelineS: 0, tMasterS: 0 },
  );
  // 2. Composite green frame — this MUST NOT corrupt v1's content.
  const v2 = await compositor.compositeImage(
    greenBitmap, W, H, 33333, 33333, { tTimelineS: 0.033333, tMasterS: 0.033333 },
  );

  // Read both. Note: order matters — we read v1 AFTER v2 was created,
  // mirroring the encoder's async-consume pattern.
  const p1 = await readFramePixels(v1);
  const p2 = await readFramePixels(v2);
  const c1 = centreRgb(p1.rgba, p1.w, p1.h);
  const c2 = centreRgb(p2.rgba, p2.w, p2.h);

  v1.close();
  v2.close();
  redBitmap.close();
  greenBitmap.close();
  compositor.destroy();

  // v1 should be ~RED, v2 should be ~GREEN. Tolerance 30 channel-sum.
  expect(rgbDist(c1, RED)).toBeLessThan(30);
  expect(rgbDist(c2, GREEN)).toBeLessThan(30);
  // And critically: c1 ≠ c2. If both look green, the bug is present.
  expect(rgbDist(c1, c2)).toBeGreaterThan(200);
}

describe("Compositor — VideoFrame isolation across consecutive composites", () => {
  it("Canvas2D backend: v1 and v2 hold independent pixel content", async () => {
    await runIsolationTest({ webgl2: false, webgpu: false });
  });

  it("WebGL2 backend: v1 and v2 hold independent pixel content", async () => {
    await runIsolationTest({ webgl2: true, webgpu: false });
  });

  if (HAS_WEBGPU) {
    it("WebGPU backend: v1 and v2 hold independent pixel content", async () => {
      await runIsolationTest({ webgl2: true, webgpu: true });
    });
  }
});

/** Extended: 10 frames with monotonic colour gradient (R=0..255). Checks
 *  that frame N's centre red value matches what was passed in for that
 *  frame, NOT some other frame's content. This is the "frames jumping
 *  back and forth" regression target — if any frame N's content equals
 *  frame N±1's source colour, the test fails. */
async function runSequenceTest(caps: BackendCapabilities): Promise<void> {
  const N = 10;
  const compositor = await Compositor.create(
    {
      width: W,
      height: H,
      sourceWidth: W,
      sourceHeight: H,
      overlays: [],
      visualizers: [],
      fx: [],
    },
    caps,
  );
  const bitmaps: ImageBitmap[] = [];
  const expectedR: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = Math.floor(((i + 1) / (N + 1)) * 255);
    expectedR.push(r);
    bitmaps.push(await makeFilledBitmap(W, H, [r, 0, 0]));
  }

  // Composite all N in sequence first — mimicking the decoder→encoder
  // pipeline that produces frames faster than they're consumed. The
  // encoder reads VideoFrames lazily.
  const frames: VideoFrame[] = [];
  for (let i = 0; i < N; i++) {
    const ts = i * 33333;
    const tS = ts / 1_000_000;
    frames.push(
      await compositor.compositeImage(bitmaps[i], W, H, ts, 33333, {
        tTimelineS: tS,
        tMasterS: tS,
      }),
    );
  }
  // Now read all of them. If VideoFrame holds a stale canvas reference,
  // every frame would read the LAST composite's content (= last red value).
  const actualR: number[] = [];
  for (const f of frames) {
    const p = await readFramePixels(f);
    actualR.push(centreRgb(p.rgba, p.w, p.h)[0]);
  }
  for (const f of frames) f.close();
  for (const b of bitmaps) b.close();
  compositor.destroy();

  // Each frame must show its own red value (within 5 LSBs of tolerance).
  for (let i = 0; i < N; i++) {
    expect(
      Math.abs(actualR[i] - expectedR[i]),
      `frame ${i}: expected R≈${expectedR[i]}, got ${actualR[i]} (full sequence: ${actualR.join(",")})`,
    ).toBeLessThan(8);
  }
}

describe("Compositor — sequence of N composites stays monotonic and per-frame", () => {
  it("Canvas2D: 10 frames each retain own colour after pipeline buffering", async () => {
    await runSequenceTest({ webgl2: false, webgpu: false });
  });

  it("WebGL2: 10 frames each retain own colour after pipeline buffering", async () => {
    await runSequenceTest({ webgl2: true, webgpu: false });
  });

  if (HAS_WEBGPU) {
    it("WebGPU: 10 frames each retain own colour after pipeline buffering", async () => {
      await runSequenceTest({ webgl2: true, webgpu: true });
    });
  }
});
