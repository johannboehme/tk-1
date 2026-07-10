/**
 * Regression tests for issue #141: exports rendered on the WebGL2
 * backend showed the NO-SIGNAL test pattern vertically flipped (the
 * color bars mask the flip, the "● NO SIGNAL" plate text made it
 * obvious in real exported files).
 *
 * Root cause: the WebGL2 backend sets UNPACK_FLIP_Y_WEBGL and relies on
 * it for `kind: "image"` sources. ImageBitmap honours the flag; canvas
 * uploads take Chrome's GPU fast path which IGNORES it — so the
 * OffscreenCanvas the render loop used as the test-pattern source came
 * out upside-down (empirically reproduced: canvas source top pixel was
 * the bottom color on WebGL2, upright on Canvas2D).
 */
import { describe, expect, it } from "vitest";
import { Compositor } from "./compositor";
import { editRenderMulti } from "./edit";
import { makeTestPatternCanvas } from "./test-pattern";
import { CamFrameStream } from "./cam-frame-stream";

const W = 64;
const H = 64;

function orientationProbeCanvas(): OffscreenCanvas {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, W, H / 2); // top half red
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, H / 2, W, H / 2); // bottom half blue
  return c;
}

async function compositeTopPixel(
  caps: { webgl2: boolean; webgpu: boolean },
  src: CanvasImageSource,
): Promise<{ r: number; b: number }> {
  const compositor = await Compositor.create(
    { width: W, height: H, sourceWidth: W, sourceHeight: H, overlays: [] },
    caps,
  );
  const frame = await compositor.compositeImage(src, W, H, 0, 33_333, {
    tTimelineS: 0,
    tMasterS: 0,
  });
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
  frame.close();
  compositor.destroy();
  const px = ctx.getImageData(W / 2, 4, 1, 1).data;
  return { r: px[0], b: px[2] };
}

describe("Static canvas sources keep their orientation (#141)", () => {
  it("WebGL2 backend renders an OffscreenCanvas source upright, matching Canvas2D", async () => {
    const c2d = await compositeTopPixel(
      { webgl2: false, webgpu: false },
      orientationProbeCanvas(),
    );
    expect(c2d.r).toBeGreaterThan(200); // sanity: top is red on Canvas2D

    const gl = await compositeTopPixel(
      { webgl2: true, webgpu: false },
      orientationProbeCanvas(),
    );
    // Pre-fix: {r: 0, b: 255} — the canvas upload ignored
    // UNPACK_FLIP_Y_WEBGL and the frame came out upside-down.
    expect(gl.r).toBeGreaterThan(200);
    expect(gl.b).toBeLessThan(60);
  });
});

// ── End-to-end: the exported NO-SIGNAL frame itself ──

function makeSineWavBlob(durationS: number): Blob {
  const sr = 48000;
  const n = Math.floor(durationS * sr);
  const dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646, false);
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x57415645, false);
  dv.setUint32(12, 0x666d7420, false);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x64617461, false);
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < n; i++) {
    const s = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr);
    dv.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function referenceImageData(w: number, h: number, flipped: boolean): ImageData {
  const ref = makeTestPatternCanvas(w, h);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  if (flipped) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(ref, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

function meanAbsDiff(a: ImageData, b: ImageData): number {
  let sum = 0;
  const n = a.data.length;
  for (let i = 0; i < n; i += 4) {
    sum +=
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (n / 4);
}

describe("Exported NO-SIGNAL frame orientation (#141, WebGL2 export path)", () => {
  it("gap frames in a WebGL2 export match the upright test pattern, not its mirror", async () => {
    // One 1 s image cam on a 3 s master: everything past 1 s has no cam
    // material → the render loop emits the test pattern there.
    const camCanvas = new OffscreenCanvas(320, 180);
    const cctx = camCanvas.getContext("2d")!;
    cctx.fillStyle = "#00aa00";
    cctx.fillRect(0, 0, 320, 180);
    const camImg = await camCanvas.convertToBlob({ type: "image/png" });

    const result = await editRenderMulti({
      cams: [
        { id: "cam", file: camImg, masterStartS: 0, sourceDurationS: 1, kind: "image" },
      ],
      cuts: [],
      masterDurationS: 3,
      audioFile: makeSineWavBlob(3),
      segments: [{ in: 0, out: 3 }],
      overlays: [],
      offsetMs: 0,
      driftRatio: 1.0,
      outputFps: 30,
      capabilities: { webgl2: true, webgpu: false },
    });
    expect(result.output).not.toBeNull();

    // Decode a frame deep inside the gap.
    const stream = await CamFrameStream.create(
      new Blob([result.output! as BlobPart]),
    );
    let frameData: ImageData;
    try {
      const frame = await stream.frameAtOrBefore(2_000_000);
      expect(frame).not.toBeNull();
      const c = new OffscreenCanvas(stream.width, stream.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      frameData = ctx.getImageData(0, 0, stream.width, stream.height);
    } finally {
      stream.close();
    }

    // The color bars are flip-invariant; the "● NO SIGNAL" glyphs are
    // not. Compare the decoded frame against the CPU-rendered pattern
    // and against its vertical mirror — encode noise hits both equally,
    // the glyph mass only matches the upright one.
    const upright = referenceImageData(frameData.width, frameData.height, false);
    const mirrored = referenceImageData(frameData.width, frameData.height, true);
    const dUpright = meanAbsDiff(frameData, upright);
    const dMirrored = meanAbsDiff(frameData, mirrored);
    console.log(
      `[verify-pattern] meanAbsDiff upright=${dUpright.toFixed(2)} mirrored=${dMirrored.toFixed(2)}`,
    );
    expect(dUpright).toBeLessThan(dMirrored);
  }, 120_000);
});
