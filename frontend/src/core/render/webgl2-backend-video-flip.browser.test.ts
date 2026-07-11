/**
 * Reproduction test for "uploaded videos appear vertically flipped".
 *
 * Loads an actual video file fixture into a `<video>` element and
 * renders it through BOTH the Canvas2DBackend and the WebGL2Backend
 * with the same descriptor. The two backends MUST produce visually
 * identical output (the parity guarantee). If the WebGL2 backend
 * disagrees with Canvas2D on the orientation, that's the bug.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGL2Backend } from "./webgl2-backend";
import { Canvas2DBackend } from "./canvas2d-backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

const VIDEO_URL = "/__test_fixtures__/video-test-redblue.mp4";

let videoEl: HTMLVideoElement;

beforeAll(async () => {
  videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.crossOrigin = "anonymous";
  videoEl.src = VIDEO_URL;
  // Seek to a known frame so the video has data.
  await new Promise<void>((resolve, reject) => {
    videoEl.addEventListener("loadedmetadata", () => resolve(), { once: true });
    videoEl.addEventListener("error", () => reject(new Error("video load")), { once: true });
  });
  videoEl.currentTime = 0.5;
  await new Promise<void>((resolve) => {
    videoEl.addEventListener("seeked", () => resolve(), { once: true });
  });
}, 15000);

afterAll(() => {
  if (videoEl) {
    videoEl.removeAttribute("src");
    videoEl.load();
  }
});

const W = 128;
const H = 128;

function videoLayer(): FrameLayer {
  return {
    layerId: "v",
    source: { kind: "video", clipId: "v", sourceTimeS: 0, sourceDurS: 1 },
    weight: 1,
    fitRect: { x: 0, y: 0, w: W, h: H },
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    displayW: W,
    displayH: H,
  };
}

function descriptor(): FrameDescriptor {
  return { tMaster: 0, output: { w: W, h: H }, layers: [videoLayer()], fx: [] };
}

function readWebGLPixel(gl: WebGL2RenderingContext, x: number, yTop: number): [number, number, number] {
  // WebGL framebuffer Y origin is at the bottom; flip the Y for "top-down" sample.
  const data = new Uint8Array(4);
  gl.readPixels(x, H - yTop - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return [data[0], data[1], data[2]];
}

function readCanvas2DPixel(ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number] {
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

describe("WebGL2Backend vs Canvas2DBackend — video source orientation parity", () => {
  it("WebGL2 video output matches Canvas2D top-vs-bottom orientation", async () => {
    const c2d = document.createElement("canvas");
    const c2dBackend = new Canvas2DBackend();
    await c2dBackend.init(c2d, { pixelW: W, pixelH: H });
    c2dBackend.drawFrame(
      descriptor(),
      new Map([["v", { kind: "video", element: videoEl }]]),
    );
    const ctx = c2d.getContext("2d")!;
    const c2dTop = readCanvas2DPixel(ctx, W / 2, 8);
    const c2dBot = readCanvas2DPixel(ctx, W / 2, H - 8);

    const gl = document.createElement("canvas");
    const glBackend = new WebGL2Backend();
    await glBackend.init(gl, { pixelW: W, pixelH: H });
    glBackend.drawFrame(
      descriptor(),
      new Map([["v", { kind: "video", element: videoEl }]]),
    );
    const glCtx = gl.getContext("webgl2")!;
    const glTop = readWebGLPixel(glCtx, W / 2, 8);
    const glBot = readWebGLPixel(glCtx, W / 2, H - 8);

    c2dBackend.dispose();
    glBackend.dispose();

    // Diagnostic: log the four samples so the failure message is readable.
    // eslint-disable-next-line no-console
    console.log("c2dTop", c2dTop, "c2dBot", c2dBot, "glTop", glTop, "glBot", glBot);

    // Parity: WebGL2 top sample should match Canvas2D top sample (and
    // bottom matches bottom). If WebGL2 is flipped, glTop ~= c2dBot.
    const topMatchesTop = colorDist(c2dTop, glTop);
    const topMatchesBot = colorDist(c2dBot, glTop);
    expect(topMatchesTop).toBeLessThan(topMatchesBot);
  }, 15000);

  it("WebGL2 fallback-bitmap render keeps the same orientation as live <video>", async () => {
    // Regression: when the runtime hands a `preferFallback=true` source
    // with a cached ImageBitmap (the seek-bridging path), the WebGL2
    // backend uploads the bitmap, NOT the <video>. ImageBitmaps honour
    // UNPACK_FLIP_Y_WEBGL=true and arrive already flipped — if the
    // shader's u_srcFlipY is still 1 (because src.kind === "video"),
    // the second flip in the fragment shader produces an upside-down
    // frame. This was visible at every pill / cam transition in the
    // editor preview during the seek-fallback window.
    const cachedBitmap = await createImageBitmap(videoEl);

    // First render: live <video> path (no fallback).
    const live = document.createElement("canvas");
    const liveBackend = new WebGL2Backend();
    await liveBackend.init(live, { pixelW: W, pixelH: H });
    liveBackend.drawFrame(
      descriptor(),
      new Map([["v", { kind: "video", element: videoEl }]]),
    );
    const liveGl = live.getContext("webgl2")!;
    const liveTop = readWebGLPixel(liveGl, W / 2, 8);
    const liveBot = readWebGLPixel(liveGl, W / 2, H - 8);

    // Second render: preferFallback=true, same video frame as the cache.
    const fb = document.createElement("canvas");
    const fbBackend = new WebGL2Backend();
    await fbBackend.init(fb, { pixelW: W, pixelH: H });
    fbBackend.drawFrame(
      descriptor(),
      new Map([
        [
          "v",
          {
            kind: "video",
            element: videoEl,
            fallback: cachedBitmap,
            preferFallback: true,
          },
        ],
      ]),
    );
    const fbGl = fb.getContext("webgl2")!;
    const fbTop = readWebGLPixel(fbGl, W / 2, 8);
    const fbBot = readWebGLPixel(fbGl, W / 2, H - 8);

    liveBackend.dispose();
    fbBackend.dispose();
    cachedBitmap.close();

    // eslint-disable-next-line no-console
    console.log("liveTop", liveTop, "liveBot", liveBot, "fbTop", fbTop, "fbBot", fbBot);

    // The fallback render must keep the SAME orientation as the live
    // render. If srcFlipY is wrong for the bitmap path, fbTop matches
    // liveBot (and vice versa) — a clear inversion signature.
    const topMatchesTop = colorDist(liveTop, fbTop);
    const topMatchesBot = colorDist(liveBot, fbTop);
    expect(topMatchesTop).toBeLessThan(topMatchesBot);
  }, 15000);
});
