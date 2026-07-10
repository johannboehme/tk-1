/**
 * Renders the SMPTE color-bars test pattern onto an OffscreenCanvas.
 *
 * Used as the source frame in the multi-cam render pipeline whenever
 * `activeCamAt()` returns null (no cam has material at the current
 * playhead position). Visually identical to the in-browser TestPattern
 * preview component.
 */
const SMPTE_BARS = [
  "#C0C0C0",
  "#C0C000",
  "#00C0C0",
  "#00C000",
  "#C000C0",
  "#C00000",
  "#0000C0",
  "#1A1A1A",
];

export function makeTestPatternCanvas(
  width: number,
  height: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("test-pattern: 2D context unavailable");
  const barW = width / SMPTE_BARS.length;
  for (let i = 0; i < SMPTE_BARS.length; i++) {
    ctx.fillStyle = SMPTE_BARS[i];
    ctx.fillRect(Math.floor(i * barW), 0, Math.ceil(barW), height);
  }
  // "NO SIGNAL" plate — same look as the in-browser preview.
  const plateText = "● NO SIGNAL";
  const plateFontPx = Math.max(14, Math.min(36, Math.floor(height / 18)));
  ctx.font = `600 ${plateFontPx}px ui-sans-serif, system-ui, sans-serif`;
  const metrics = ctx.measureText(plateText);
  const padX = plateFontPx * 0.7;
  const padY = plateFontPx * 0.4;
  const plateW = metrics.width + padX * 2;
  const plateH = plateFontPx + padY * 2;
  const plateX = (width - plateW) / 2;
  const plateY = (height - plateH) / 2;
  ctx.fillStyle = "rgba(26,24,22,0.85)";
  ctx.fillRect(plateX, plateY, plateW, plateH);
  ctx.fillStyle = "#F2EDE2";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(plateText, width / 2, plateY + plateH / 2);
  return canvas;
}

/**
 * Same pattern as an ImageBitmap. The render pipeline uses this instead
 * of the raw canvas: WebGL2's texture upload honours
 * UNPACK_FLIP_Y_WEBGL for ImageBitmap but ignores it on Chrome's GPU
 * fast path for canvases, which made the exported NO-SIGNAL frame
 * vertically flipped on the WebGL2 backend (issue #141). One-time,
 * synchronous conversion (`transferToImageBitmap` moves the backing
 * store); caller owns the bitmap and should `.close()` it on teardown.
 */
export function makeTestPatternBitmap(
  width: number,
  height: number,
): ImageBitmap {
  return makeTestPatternCanvas(width, height).transferToImageBitmap();
}
