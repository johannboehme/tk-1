/**
 * Timeline 60 Hz repaint regression — real Chromium, real canvases.
 *
 * During playback the audio walker writes playback.currentTime/timelineT
 * ~60×/s. The only pixel-level change per tick is the playhead line, so the
 * multi-lane scene raster (lane thumbnails, waveform column model, trim
 * bands, splice marks, loop band — plus a full canvas backing-store realloc)
 * must NOT re-run per tick; only the stacked playhead overlay may draw.
 *
 * The probe counts Canvas2D ops across playhead-only store updates:
 *   - fillRect  → scene raster fingerprint (background + lanes + dim bands
 *                 all go through fillRect; the overlay uses clearRect+stroke)
 *   - width set → backing-store realloc (canvas.width assignment clears+
 *                 reallocs even at the same value)
 * Doubles as the perf probe: logs ops/frame + wall time for 60 ticks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Timeline } from "./Timeline";
import { useEditorStore } from "../store";
import { buildPeakPyramid } from "../../local/waveform/peak-pyramid";

const SR = 22050;

function makeSinePcm(durationS: number): Float32Array {
  const n = Math.floor(durationS * SR);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  return pcm;
}

const DURATION_S = 60;

function loadTestJob() {
  useEditorStore.getState().reset();
  useEditorStore.getState().loadJob(
    {
      id: "perf-timeline",
      fps: 30,
      duration: DURATION_S,
      width: 1920,
      height: 1080,
      algoOffsetMs: 0,
      driftRatio: 1,
    },
    {
      clips: [
        {
          id: "cam-1",
          filename: "a.mp4",
          color: "#E4572E",
          sourceDurationS: DURATION_S,
          syncOffsetMs: 0,
        },
        {
          id: "cam-2",
          filename: "b.mp4",
          color: "#2E86AB",
          sourceDurationS: DURATION_S,
          syncOffsetMs: 0,
        },
      ],
    },
  );
}

/** Count canvas raster ops via prototype patches (vi spies can miss the
 *  worker-agnostic context object graph; direct patching is exact). */
function instrumentCanvas() {
  const proto = CanvasRenderingContext2D.prototype;
  const origFillRect = proto.fillRect;
  const origStroke = proto.stroke;
  const counts = { fillRect: 0, stroke: 0, widthSets: 0 };
  proto.fillRect = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["fillRect"]>
  ) {
    counts.fillRect++;
    return origFillRect.apply(this, args);
  };
  proto.stroke = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    counts.stroke++;
    return (origStroke as (...a: unknown[]) => void).apply(this, args);
  } as typeof origStroke;

  const widthDesc = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "width",
  )!;
  Object.defineProperty(HTMLCanvasElement.prototype, "width", {
    ...widthDesc,
    set(v: number) {
      counts.widthSets++;
      widthDesc.set!.call(this, v);
    },
  });

  return {
    counts,
    restore() {
      proto.fillRect = origFillRect;
      proto.stroke = origStroke;
      Object.defineProperty(HTMLCanvasElement.prototype, "width", widthDesc);
    },
  };
}

describe("Timeline playback repaint cost", () => {
  beforeEach(loadTestJob);
  afterEach(cleanup);

  it("a playhead-only tick draws the overlay, not the multi-lane scene", async () => {
    const pyramid = buildPeakPyramid(makeSinePcm(DURATION_S), SR);
    const probe = instrumentCanvas();
    try {
      render(
        <Timeline
          cams={{}}
          pyramid={pyramid}
          audioDuration={DURATION_S}
          audioLaneHeight={48}
          videoLaneHeight={48}
        />,
      );
      // Let mount effects (canvas sizing, image-ready bump, ResizeObserver)
      // settle before measuring.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      probe.counts.fillRect = 0;
      probe.counts.stroke = 0;
      probe.counts.widthSets = 0;

      // 60 playhead-only ticks — one second of playback. Zoom is 1, so the
      // playhead never leaves the visible range (no auto-page scroll).
      const FRAMES = 60;
      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        // i+1: the store starts at timelineT=0, and a tick to the same
        // value is (correctly) a no-op for the overlay effect.
        const t = ((i + 1) / FRAMES) * (DURATION_S / 2);
        act(() => {
          useEditorStore.getState().setPlayhead(t, t);
        });
      }
      const ms = performance.now() - t0;

      // eslint-disable-next-line no-console
      console.log(
        `[timeline-repaint] ${FRAMES} playhead ticks: ${ms.toFixed(1)} ms — ` +
          `fillRect=${probe.counts.fillRect} stroke=${probe.counts.stroke} ` +
          `widthSets=${probe.counts.widthSets}`,
      );

      // The playhead must still be drawn every tick…
      expect(probe.counts.stroke).toBeGreaterThanOrEqual(FRAMES);
      // …but the scene raster must not re-run: no lane/background/trim
      // fillRects, no backing-store reallocs.
      expect(probe.counts.fillRect).toBe(0);
      expect(probe.counts.widthSets).toBe(0);
    } finally {
      probe.restore();
    }
  });

  it("the stacked layers really render: scene paper below, playhead ink above at the right column", async () => {
    const pyramid = buildPeakPyramid(makeSinePcm(DURATION_S), SR);
    const { container } = render(
      <Timeline
        cams={{}}
        pyramid={pyramid}
        audioDuration={DURATION_S}
        audioLaneHeight={48}
        videoLaneHeight={48}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const tSeek = DURATION_S / 4;
    act(() => {
      useEditorStore.getState().setPlayhead(tSeek, tSeek);
    });

    const canvases = Array.from(container.querySelectorAll("canvas"));
    // The playhead overlay is the hit-through canvas; the scene canvas
    // (pointer surface) is its immediate previous sibling in the same
    // stacking container. (Other canvases exist — e.g. the BeatRuler.)
    const overlay = canvases.find((c) => c.style.pointerEvents === "none")!;
    expect(overlay).toBeTruthy();
    const scene = overlay.previousElementSibling as HTMLCanvasElement;
    expect(scene?.tagName).toBe("CANVAS");
    // Same CSS geometry, overlay pinned over the scene.
    expect(overlay.style.width).toBe(scene.style.width);
    expect(overlay.style.height).toBe(scene.style.height);

    // Scene: paper background actually painted (opaque, non-blank).
    const sctx = scene.getContext("2d")!;
    const spx = sctx.getImageData(1, 1, 1, 1).data;
    expect(spx[3]).toBe(255);
    expect(spx[0] + spx[1] + spx[2]).toBeGreaterThan(0);

    // Overlay: hot playhead ink (#FF5722) in the expected pixel column —
    // zoom 1 shows [0, DURATION_S], so t=15 s sits at 25% width.
    const cssW = parseFloat(scene.style.width);
    const dpr = overlay.width / cssW;
    const xDev = Math.round((Math.floor((tSeek / DURATION_S) * cssW) + 0.5) * dpr);
    const octx = overlay.getContext("2d")!;
    const strip = octx.getImageData(
      Math.max(0, xDev - 2 * Math.ceil(dpr)),
      Math.round(overlay.height / 2),
      4 * Math.ceil(dpr) + 1,
      1,
    ).data;
    let sawInk = false;
    for (let i = 0; i < strip.length; i += 4) {
      if (strip[i] > 200 && strip[i + 1] < 150 && strip[i + 2] < 100 && strip[i + 3] > 0) {
        sawInk = true;
        break;
      }
    }
    expect(sawInk).toBe(true);
  });
});
