/**
 * Reproduction test for the video orientation flip-flicker bug. Drives
 * the WebGPUBackend with a known-orientation source and reads the
 * canvas pixels back; we assert that the TOP of the input lands at the
 * TOP of the canvas — the most basic invariant a compositor must hold
 * and the one we've been failing on.
 *
 * Two source-kind variants of the same fixture image (red top half,
 * green bottom half):
 *
 *   - `kind: "image"` — the existing path. Sets the baseline; if this
 *     fails, the bug is in the layer pipeline itself, not the
 *     video-specific upload.
 *   - `kind: "video"` with a `preferFallback: true` ImageBitmap — the
 *     post-fix production video path. The runtime captures
 *     `createImageBitmap(<video>)` and hands it to the backend with
 *     `preferFallback`; if this fails, the backend's video-source
 *     orientation handling is wrong (which is exactly the user-visible
 *     bug they keep reporting).
 *
 * A third test covers the live `<video>` element via the
 * `createImageBitmap(<video>)` capture path — same orientation
 * expectation. That one tells us whether Chrome's bitmap from a video
 * is top-down or bottom-up, which is the missing empirical data point
 * that I've been guessing at.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebGPUBackend } from "./webgpu-backend";
import type { LayerSource } from "./backend";
import type { FrameDescriptor, FrameLayer } from "./frame-descriptor";

const HAS_WEBGPU = typeof navigator !== "undefined" && "gpu" in navigator;
const d = HAS_WEBGPU ? describe : describe.skip;

const W = 100;
const H = 100;
const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];

let topBottomBitmap: ImageBitmap;

beforeAll(async () => {
  if (!HAS_WEBGPU) return;
  // Red top half, green bottom half — DOM convention (y=0 is top).
  const off = new OffscreenCanvas(W, H);
  const ctx = off.getContext("2d")!;
  ctx.fillStyle = "rgb(255,0,0)";
  ctx.fillRect(0, 0, W, H / 2);
  ctx.fillStyle = "rgb(0,255,0)";
  ctx.fillRect(0, H / 2, W, H / 2);
  topBottomBitmap = await createImageBitmap(off);
});

afterAll(() => {
  if (HAS_WEBGPU && topBottomBitmap) topBottomBitmap.close();
});

function videoLayer(): FrameLayer {
  return {
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
}

function descriptor(layers: FrameLayer[]): FrameDescriptor {
  return { tMaster: 0, output: { w: W, h: H }, layers, fx: [] };
}

async function paint(source: LayerSource): Promise<WebGPUBackend> {
  const canvas = document.createElement("canvas");
  const backend = new WebGPUBackend();
  await backend.init(canvas, { pixelW: W, pixelH: H });
  backend.drawFrame(descriptor([videoLayer()]), new Map([["a", source]]));
  return backend;
}

function colorDist(a: Uint8Array, b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function isCloseTo(a: Uint8Array, b: [number, number, number]): boolean {
  return colorDist(a, b) < 30;
}

async function readTopAndBottom(
  backend: WebGPUBackend,
): Promise<{ top: Uint8Array; bottom: Uint8Array }> {
  const top = await backend.readbackForTest(W / 2, 10, 1, 1);
  const bottom = await backend.readbackForTest(W / 2, H - 10, 1, 1);
  return { top, bottom };
}

d("WebGPUBackend — orientation invariant: top of source lands at top of canvas", () => {
  it("kind=image: red-top / green-bottom bitmap renders right-side up (baseline)", async () => {
    const backend = await paint({ kind: "image", bitmap: topBottomBitmap });
    const { top, bottom } = await readTopAndBottom(backend);
    backend.dispose();
    // eslint-disable-next-line no-console
    console.info("[test] image-kind", "top=", [...top], "bottom=", [...bottom]);
    expect(isCloseTo(top, RED)).toBe(true);
    expect(isCloseTo(bottom, GREEN)).toBe(true);
  });

  it("kind=video + preferFallback=true: same bitmap renders right-side up", async () => {
    // This mirrors the runtime's production behaviour: video sources
    // are routed through `createImageBitmap` and handed to the backend
    // as `kind: "video"` with `preferFallback: true`. The shader's
    // srcFlipY logic must produce the same correct orientation for
    // the video path as for the image path on this same bitmap.
    const backend = await paint({
      kind: "video",
      element: document.createElement("video"), // unused (preferFallback wins)
      fallback: topBottomBitmap,
      preferFallback: true,
    });
    const { top, bottom } = await readTopAndBottom(backend);
    backend.dispose();
    // eslint-disable-next-line no-console
    console.info("[test] video-kind fallback", "top=", [...top], "bottom=", [...bottom]);
    expect(isCloseTo(top, RED)).toBe(true);
    expect(isCloseTo(bottom, GREEN)).toBe(true);
  });
});

const VIDEO_URL = "/__test_fixtures__/video-test-redblue.mp4";

/** Reproduces the user's Maria-José case: a video whose codec is
 *  landscape but whose display matrix says rotate 90° clockwise (so
 *  the on-screen `<video>` plays portrait). The fixture is a 0.5 s
 *  re-encode of the actual user file, with codec dims 320×178 and a
 *  `rotate=90` track-level tag. This is the case my synthetic-bitmap
 *  test couldn't reach. */
d("WebGPUBackend — rotated portrait video (user repro fixture)", () => {
  it("matches the on-screen <video> orientation pixel-for-pixel", async () => {
    const videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.crossOrigin = "anonymous";
    videoEl.src = "/__test_fixtures__/user-rotated-sample.mp4";
    await new Promise<void>((resolve, reject) => {
      videoEl.addEventListener("loadedmetadata", () => resolve(), { once: true });
      videoEl.addEventListener("error", () => reject(new Error("video load")), { once: true });
    });
    videoEl.currentTime = 0.2;
    await new Promise<void>((resolve) => {
      videoEl.addEventListener("seeked", () => resolve(), { once: true });
    });

    // Empirical: what does Chrome report for the video's intrinsic
    // dimensions? Per spec these are POST-rotation (display dims).
    const dispW = videoEl.videoWidth;
    const dispH = videoEl.videoHeight;
    // eslint-disable-next-line no-console
    console.info("[test rot] videoEl.videoWidth/Height", dispW, "x", dispH);

    // Empirical: what does createImageBitmap give us — display dims
    // (rotation applied) or codec dims (rotation NOT applied)?
    const bitmap = await createImageBitmap(videoEl);
    // eslint-disable-next-line no-console
    console.info("[test rot] bitmap.width/height", bitmap.width, "x", bitmap.height);

    // Canvas2D drawImage(<video>) is the reference — it goes through
    // the same display pipeline as the on-screen <video> tag.
    const refCanvas = new OffscreenCanvas(dispW, dispH);
    const refCtx = refCanvas.getContext("2d")!;
    refCtx.drawImage(videoEl, 0, 0);
    // Sample at 4 quadrant centres to characterise orientation.
    const refTL = refCtx.getImageData(dispW * 0.25, dispH * 0.25, 1, 1).data;
    const refTR = refCtx.getImageData(dispW * 0.75, dispH * 0.25, 1, 1).data;
    const refBL = refCtx.getImageData(dispW * 0.25, dispH * 0.75, 1, 1).data;
    const refBR = refCtx.getImageData(dispW * 0.75, dispH * 0.75, 1, 1).data;
    // eslint-disable-next-line no-console
    console.info(
      "[test rot] reference quadrants",
      "TL=", [refTL[0], refTL[1], refTL[2]],
      "TR=", [refTR[0], refTR[1], refTR[2]],
      "BL=", [refBL[0], refBL[1], refBL[2]],
      "BR=", [refBR[0], refBR[1], refBR[2]],
    );

    // Drive WebGPU at the display dims with the createImageBitmap
    // result as fallback (mirrors production runtime path).
    const canvas = document.createElement("canvas");
    const backend = new WebGPUBackend();
    await backend.init(canvas, { pixelW: dispW, pixelH: dispH });
    backend.drawFrame(
      {
        tMaster: 0,
        output: { w: dispW, h: dispH },
        layers: [
          {
            layerId: "a",
            source: { kind: "video", clipId: "a", sourceTimeS: 0, sourceDurS: 1 },
            weight: 1,
            fitRect: { x: 0, y: 0, w: dispW, h: dispH },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            displayW: dispW,
            displayH: dispH,
          },
        ],
        fx: [],
      },
      new Map([
        ["a", {
          kind: "video",
          element: videoEl,
          fallback: bitmap,
          preferFallback: true,
        }],
      ]),
    );
    const gpuTL = await backend.readbackForTest(Math.floor(dispW * 0.25), Math.floor(dispH * 0.25), 1, 1);
    const gpuTR = await backend.readbackForTest(Math.floor(dispW * 0.75), Math.floor(dispH * 0.25), 1, 1);
    const gpuBL = await backend.readbackForTest(Math.floor(dispW * 0.25), Math.floor(dispH * 0.75), 1, 1);
    const gpuBR = await backend.readbackForTest(Math.floor(dispW * 0.75), Math.floor(dispH * 0.75), 1, 1);
    backend.dispose();
    bitmap.close();
    videoEl.removeAttribute("src");
    videoEl.load();

    // eslint-disable-next-line no-console
    console.info(
      "[test rot] webgpu quadrants",
      "TL=", [gpuTL[0], gpuTL[1], gpuTL[2]],
      "TR=", [gpuTR[0], gpuTR[1], gpuTR[2]],
      "BL=", [gpuBL[0], gpuBL[1], gpuBL[2]],
      "BR=", [gpuBR[0], gpuBR[1], gpuBR[2]],
    );

    // Each WebGPU quadrant must be CLOSER to its matching reference
    // quadrant than to ANY of the other reference quadrants — which
    // is the only orientation-correctness invariant that holds
    // regardless of what colours the fixture happens to have.
    const dist = (a: Uint8Array, b: Uint8ClampedArray) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const refs = { TL: refTL, TR: refTR, BL: refBL, BR: refBR };
    const gpus = { TL: gpuTL, TR: gpuTR, BL: gpuBL, BR: gpuBR };
    for (const corner of ["TL", "TR", "BL", "BR"] as const) {
      const myMatch = dist(gpus[corner], refs[corner]);
      for (const other of ["TL", "TR", "BL", "BR"] as const) {
        if (other === corner) continue;
        const otherMatch = dist(gpus[corner], refs[other]);
        expect(
          myMatch,
          `gpu ${corner} should be closer to ref ${corner} than ref ${other}`,
        ).toBeLessThanOrEqual(otherMatch);
      }
    }
  }, 15000);
});

d("WebGPUBackend — orientation invariant: live <video> via createImageBitmap", () => {
  it("captures the video's CURRENT displayed top at the canvas top", async () => {
    // Empirical orientation check on the createImageBitmap(<video>)
    // path. The fixture `video-test-redblue.mp4` is constructed with
    // a known top/bottom split (the existing WebGL2 test relies on
    // it). Whatever Chrome's bitmap orientation convention is, the
    // top of the displayed frame must end up at the top of our canvas
    // — that's the user-facing invariant.
    const videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.crossOrigin = "anonymous";
    videoEl.src = VIDEO_URL;
    await new Promise<void>((resolve, reject) => {
      videoEl.addEventListener("loadedmetadata", () => resolve(), { once: true });
      videoEl.addEventListener("error", () => reject(new Error("video load")), { once: true });
    });
    videoEl.currentTime = 0.5;
    await new Promise<void>((resolve) => {
      videoEl.addEventListener("seeked", () => resolve(), { once: true });
    });

    const fallback = await createImageBitmap(videoEl);
    // Compare orientation against a Canvas2D drawImage of the same
    // video — Canvas2D's `drawImage(<video>)` is the reference
    // orientation (it's what the on-screen <video> tag does
    // internally when it composites to a 2D canvas).
    const refCanvas = new OffscreenCanvas(fallback.width, fallback.height);
    const refCtx = refCanvas.getContext("2d")!;
    refCtx.drawImage(videoEl, 0, 0);
    const refTop = refCtx.getImageData(fallback.width / 2, 5, 1, 1).data;
    const refBot = refCtx.getImageData(
      fallback.width / 2,
      fallback.height - 5,
      1,
      1,
    ).data;
    // eslint-disable-next-line no-console
    console.info(
      "[test] reference (Canvas2D drawImage video)",
      "top=", [refTop[0], refTop[1], refTop[2]],
      "bottom=", [refBot[0], refBot[1], refBot[2]],
    );

    const backend = await paint({
      kind: "video",
      element: videoEl,
      fallback,
      preferFallback: true,
    });
    const { top, bottom } = await readTopAndBottom(backend);
    backend.dispose();
    fallback.close();
    videoEl.removeAttribute("src");
    videoEl.load();

    // eslint-disable-next-line no-console
    console.info("[test] webgpu video-kind via createImageBitmap", "top=", [...top], "bottom=", [...bottom]);

    // The backend's top sample should match the Canvas2D reference's
    // top sample (i.e. orientation-preserving). If the WebGPU output
    // is flipped, `top` will instead match the reference's BOTTOM.
    const topVsRefTop = Math.abs(top[0] - refTop[0]) + Math.abs(top[1] - refTop[1]) + Math.abs(top[2] - refTop[2]);
    const topVsRefBot = Math.abs(top[0] - refBot[0]) + Math.abs(top[1] - refBot[1]) + Math.abs(top[2] - refBot[2]);
    expect(topVsRefTop).toBeLessThan(topVsRefBot);
  }, 15000);
});
