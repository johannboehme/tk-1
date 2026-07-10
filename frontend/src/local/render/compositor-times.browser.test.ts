/**
 * Time-axis contract tests for Compositor.compositeImage (issue #78/#85).
 *
 * The compositor receives THREE distinct time axes per frame:
 *   - `timestampUs`  — output-relative (restarts at 0, muxer timestamps)
 *   - `tTimelineS`   — arrangement/song axis (FX in/out windows, envelope)
 *   - `tMasterS`     — master-audio axis (beat grid, sidechain follower)
 *
 * The export bug class this protects against: passing a single time for
 * everything. Beat-synced LFOs and sidechain followers are anchored to
 * MASTER time (jobs.ts builds beatPhaseS and audioEnv over the full
 * master PCM), while FX activation windows live in TIMELINE time. Any
 * arrangement where the axes diverge (DROP chunks, master trim) exposed
 * the mixup: FX pumped against the wrong audio position in every
 * long-form export while the preview looked correct.
 *
 * A vignette FX is used as the probe: at level 1 the frame corner goes
 * near-black; at level 0 the FX is culled entirely (wetness filter) and
 * the corner keeps the source color.
 */
import { describe, expect, it } from "vitest";
import { Compositor, type FrameTimes } from "./compositor";
import type { PunchFx } from "../../editor/fx/types";
import type { AudioEnvelope, Modulation } from "../../editor/fx/modulation";
import { INSTANT_ENVELOPE } from "../../editor/fx/envelope";

const W = 64;
const H = 64;

function solidBitmap(color: string): ImageBitmap {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return c.transferToImageBitmap();
}

async function cornerPixel(
  compositor: Compositor,
  source: ImageBitmap,
  timestampUs: number,
  times: FrameTimes,
): Promise<{ r: number; g: number; b: number }> {
  const frame = await compositor.compositeImage(
    source,
    W,
    H,
    timestampUs,
    33_333,
    times,
  );
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
  frame.close();
  const px = ctx.getImageData(2, 2, 1, 1).data;
  return { r: px[0], g: px[1], b: px[2] };
}

function vignetteFx(mod?: Modulation): PunchFx {
  return {
    id: "fx1",
    kind: "vignette",
    inS: 3.0,
    outS: 4.0,
    params: { intensity: 1, falloff: 0.9 },
    modulation: mod,
  };
}

const baseOpts = {
  width: W,
  height: H,
  sourceWidth: W,
  sourceHeight: H,
  overlays: [],
};

const caps = { webgl2: false, webgpu: false };

describe("Compositor time axes (export must match preview semantics)", () => {
  it("FX activation window is keyed by tTimelineS, not output time or master time", async () => {
    const compositor = await Compositor.create(
      { ...baseOpts, fx: [vignetteFx()] },
      caps,
    );

    // Inside the window on the timeline axis — output time and master
    // time both far outside. FX must fire.
    const active = await cornerPixel(compositor, solidBitmap("#ff0000"), 0, {
      tTimelineS: 3.5,
      tMasterS: 100,
    });
    expect(active.r).toBeLessThan(128);

    // Timeline outside the window; master time inside it. FX must NOT
    // fire (the pre-fix export passed one value for both).
    const inactive = await cornerPixel(compositor, solidBitmap("#ff0000"), 3_500_000, {
      tTimelineS: 0.5,
      tMasterS: 3.5,
    });
    expect(inactive.r).toBeGreaterThan(200);

    compositor.destroy();
  });

  it("sidechain follower samples the MASTER axis", async () => {
    // Loudness envelope: silent everywhere except master 9.5..10.5 s.
    const fps = 30;
    const data = new Float32Array(20 * fps);
    for (let i = 0; i < data.length; i++) {
      const tS = i / fps;
      data[i] = tS >= 9.5 && tS <= 10.5 ? 1 : 0;
    }
    const audioEnv: AudioEnvelope = { data, fps };
    const mod: Modulation = {
      envelope: INSTANT_ENVELOPE,
      timeMod: "sidechain",
      depth: 1,
      lfo: { shape: "sine", rate: 0.75, beatSync: true },
      side: { threshold: 0.35, attackS: 0.001, releaseS: 0.05, invert: false },
    };
    const compositor = await Compositor.create(
      { ...baseOpts, fx: [vignetteFx(mod)], audioEnv },
      caps,
    );

    // Timeline inside the FX window; master time on the loud section →
    // follower ≈ 1 → vignette at full level.
    const loud = await cornerPixel(compositor, solidBitmap("#ff0000"), 0, {
      tTimelineS: 3.2,
      tMasterS: 10.2,
    });
    expect(loud.r).toBeLessThan(128);

    // Same timeline position, master time on silence → follower 0 →
    // level 0 → FX culled. The pre-fix export fed the timeline value
    // into the follower, which is exactly this broken case.
    const silent = await cornerPixel(compositor, solidBitmap("#ff0000"), 0, {
      tTimelineS: 3.2,
      tMasterS: 3.2,
    });
    expect(silent.r).toBeGreaterThan(200);

    compositor.destroy();
  });

  it("beat-synced LFO phase is anchored to the MASTER beat grid", async () => {
    // 120 BPM, rate 0.75 → 1/2-note division → 1.0 s period. Square
    // shape: full level in the first half of the cycle, zero in the
    // second half.
    const mod: Modulation = {
      envelope: INSTANT_ENVELOPE,
      timeMod: "lfo",
      depth: 1,
      lfo: { shape: "square", rate: 0.75, beatSync: true },
      side: { threshold: 0.35, attackS: 0.01, releaseS: 0.18, invert: false },
    };
    const compositor = await Compositor.create(
      {
        ...baseOpts,
        fx: [vignetteFx(mod)],
        bpm: 120,
        beatPhaseS: 0,
        beatsPerBar: 4,
      },
      caps,
    );

    // Master 10.2 s → phase 0.2 → square high → dark corner.
    const high = await cornerPixel(compositor, solidBitmap("#ff0000"), 0, {
      tTimelineS: 3.2,
      tMasterS: 10.2,
    });
    expect(high.r).toBeLessThan(128);

    // Master 10.7 s → phase 0.7 → square low → FX culled. If the LFO
    // read the timeline axis (3.2 → phase 0.2) both probes would be
    // dark and this assertion catches it.
    const low = await cornerPixel(compositor, solidBitmap("#ff0000"), 0, {
      tTimelineS: 3.2,
      tMasterS: 10.7,
    });
    expect(low.r).toBeGreaterThan(200);

    compositor.destroy();
  });
});
