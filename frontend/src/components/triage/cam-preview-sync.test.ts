import { describe, it, expect } from "vitest";
import { decideCamPreviewAction } from "./cam-preview-sync";

describe("decideCamPreviewAction", () => {
  it("identity when there is no sync offset", () => {
    expect(
      decideCamPreviewAction({
        masterT: 0,
        syncOffsetMs: 0,
        sourceDurationS: 60,
      }),
    ).toEqual({ kind: "seek", sourceT: 0 });
    expect(
      decideCamPreviewAction({
        masterT: 12.5,
        syncOffsetMs: 0,
        sourceDurationS: 60,
      }),
    ).toEqual({ kind: "seek", sourceT: 12.5 });
  });

  it("positive sync offset (cam pre-roll) jumps the source forward", () => {
    // Phone recorded 1.5 s of mic-check before the song; master starts at song.
    // At master t=0 the cam is already 1.5 s in.
    const action = decideCamPreviewAction({
      masterT: 0,
      syncOffsetMs: 1500,
      sourceDurationS: 60,
    });
    expect(action).toEqual({ kind: "seek", sourceT: 1.5 });
  });

  it("regression: 'Maria José' — 193 s of preroll, master at t=0", () => {
    // Real bug: 938 s video, 740 s audio, ~193 s preroll → matcher returned
    // sync.offsetMs ≈ +193000. The old formula (master − offset/1000) gave
    // sourceT = −193 and paused the preview for 3:13; the correct formula
    // gives sourceT = +193 (cam plays from where the song starts in the
    // source).
    const action = decideCamPreviewAction({
      masterT: 0,
      syncOffsetMs: 193_000,
      sourceDurationS: 938.1,
    });
    expect(action).toEqual({ kind: "seek", sourceT: 193 });
  });

  it("negative sync offset (cam started AFTER master) pauses until the cam appears", () => {
    // Master plays 2 s before this cam joins.
    expect(
      decideCamPreviewAction({
        masterT: 0,
        syncOffsetMs: -2000,
        sourceDurationS: 60,
      }),
    ).toEqual({ kind: "pause-before-start" });
    expect(
      decideCamPreviewAction({
        masterT: 1.5,
        syncOffsetMs: -2000,
        sourceDurationS: 60,
      }),
    ).toEqual({ kind: "pause-before-start" });
    // First frame as the cam comes in.
    expect(
      decideCamPreviewAction({
        masterT: 2,
        syncOffsetMs: -2000,
        sourceDurationS: 60,
      }),
    ).toEqual({ kind: "seek", sourceT: 0 });
  });

  it("holds the final frame when the cam runs past its source duration", () => {
    // 60 s cam, master t=70 with 1 s pre-roll → would want sourceT = 71 (>60).
    const action = decideCamPreviewAction({
      masterT: 70,
      syncOffsetMs: 1000,
      sourceDurationS: 60,
    });
    expect(action.kind).toBe("pause-after-end");
    if (action.kind === "pause-after-end") {
      expect(action.sourceT).toBeCloseTo(59.95, 5);
    }
  });

  it("treats unknown source duration as 'seek anyway' (metadata still loading)", () => {
    expect(
      decideCamPreviewAction({
        masterT: 5,
        syncOffsetMs: 1000,
        sourceDurationS: null,
      }),
    ).toEqual({ kind: "seek", sourceT: 6 });
  });

  it("applies driftRatio so a faster-clock cam catches up to master", () => {
    // Cam clock ran 0.1 % faster than master. After 60 s of master the cam
    // is 60 ms ahead at the source.
    expect(
      decideCamPreviewAction({
        masterT: 60,
        syncOffsetMs: 0,
        sourceDurationS: 600,
        driftRatio: 1.001,
      }),
    ).toMatchObject({ kind: "seek" });
    const a = decideCamPreviewAction({
      masterT: 60,
      syncOffsetMs: 0,
      sourceDurationS: 600,
      driftRatio: 1.001,
    });
    if (a.kind === "seek") expect(a.sourceT).toBeCloseTo(60.06, 5);
  });
});
