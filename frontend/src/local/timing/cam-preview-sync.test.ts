import { describe, it, expect } from "vitest";
import { decideCamPreviewAction } from "./cam-preview-sync";

/** Convenience: builds an input with the cold-start defaults (no
 *  previous master tick, no observed video currentTime). The decider
 *  always returns `seek` on first contact so the element snaps to the
 *  current target. */
function coldInput(
  masterT: number,
  syncOffsetMs: number,
  sourceDurationS: number | null = 60,
) {
  return {
    masterT,
    syncOffsetMs,
    sourceDurationS,
    videoCurrentTimeS: null,
    prevMasterT: null,
  };
}

describe("decideCamPreviewAction — sign + duration handling", () => {
  it("identity when there is no sync offset", () => {
    expect(decideCamPreviewAction(coldInput(0, 0))).toEqual({
      kind: "seek",
      sourceT: 0,
    });
    expect(decideCamPreviewAction(coldInput(12.5, 0))).toEqual({
      kind: "seek",
      sourceT: 12.5,
    });
  });

  it("positive sync offset (cam pre-roll) jumps the source forward", () => {
    // Phone recorded 1.5 s of mic-check before the song; master starts at song.
    // At master t=0 the cam is already 1.5 s in.
    expect(decideCamPreviewAction(coldInput(0, 1500))).toEqual({
      kind: "seek",
      sourceT: 1.5,
    });
  });

  it("regression: 'Maria José' — 193 s of preroll, master at t=0", () => {
    // Real bug: 938 s video, 740 s audio, ~193 s preroll → matcher returned
    // sync.offsetMs ≈ +193000. The old formula (master − offset/1000) gave
    // sourceT = −193 and paused the preview for 3:13; the correct formula
    // gives sourceT = +193 (cam plays from where the song starts in the
    // source).
    expect(decideCamPreviewAction(coldInput(0, 193_000, 938.1))).toEqual({
      kind: "seek",
      sourceT: 193,
    });
  });

  it("negative sync offset (cam started AFTER master) pauses until the cam appears", () => {
    expect(decideCamPreviewAction(coldInput(0, -2000))).toEqual({
      kind: "pause-before-start",
    });
    expect(decideCamPreviewAction(coldInput(1.5, -2000))).toEqual({
      kind: "pause-before-start",
    });
    expect(decideCamPreviewAction(coldInput(2, -2000))).toEqual({
      kind: "seek",
      sourceT: 0,
    });
  });

  it("holds the final frame when the cam runs past its source duration", () => {
    const action = decideCamPreviewAction(coldInput(70, 1000, 60));
    expect(action.kind).toBe("pause-after-end");
    if (action.kind === "pause-after-end") {
      expect(action.sourceT).toBeCloseTo(59.95, 5);
    }
  });

  it("treats unknown source duration as 'seek anyway' (metadata still loading)", () => {
    expect(decideCamPreviewAction(coldInput(5, 1000, null))).toEqual({
      kind: "seek",
      sourceT: 6,
    });
  });

  it("applies driftRatio so a faster-clock cam catches up to master", () => {
    const a = decideCamPreviewAction({
      ...coldInput(60, 0, 600),
      driftRatio: 1.001,
    });
    expect(a.kind).toBe("seek");
    if (a.kind === "seek") expect(a.sourceT).toBeCloseTo(60.06, 5);
  });
});

describe("decideCamPreviewAction — stutter avoidance during playback", () => {
  it("first observed tick (cold prevMasterT) seeks once to align the element", () => {
    expect(
      decideCamPreviewAction({
        ...coldInput(10, 0),
        videoCurrentTimeS: 9.95,
        prevMasterT: null,
      }),
    ).toEqual({ kind: "seek", sourceT: 10 });
  });

  it("natural advance with element keeping up → hold (do NOT seek)", () => {
    // Master ticks 10.0 → 10.016 (one RAF). Element is at 10.014 — natural
    // micro-drift from a separate clock. Re-seeking here is the bug that
    // caused the post-seek stutter loop.
    expect(
      decideCamPreviewAction({
        ...coldInput(10.016, 0),
        videoCurrentTimeS: 10.014,
        prevMasterT: 10.0,
      }),
    ).toMatchObject({ kind: "hold" });
  });

  it("natural advance with sub-half-second drift → still hold", () => {
    // 250 ms drift — visible on a side-by-side test, but for a single
    // hidden cam preview it's far below what the user notices, and
    // forcing a seek would tear the decoder open mid-flight.
    expect(
      decideCamPreviewAction({
        ...coldInput(10.016, 0),
        videoCurrentTimeS: 9.766,
        prevMasterT: 10.0,
      }),
    ).toMatchObject({ kind: "hold" });
  });

  it("natural advance with > 500 ms drift → seek to recover", () => {
    expect(
      decideCamPreviewAction({
        ...coldInput(10.016, 0),
        videoCurrentTimeS: 9.4,
        prevMasterT: 10.0,
      }),
    ).toEqual({ kind: "seek", sourceT: 10.016 });
  });

  it("forward jump > 500 ms (chunk click / scrub forward) → seek precisely", () => {
    // User clicked a chunk further down the timeline. masterT jumped from
    // 10 → 95. The element is still at 10 — diff way past the jump
    // threshold, snap.
    expect(
      decideCamPreviewAction({
        ...coldInput(95, 0, 600),
        videoCurrentTimeS: 10,
        prevMasterT: 10,
      }),
    ).toEqual({ kind: "seek", sourceT: 95 });
  });

  it("backward jump (loop wrap) → seek even when video is barely past target", () => {
    // Loop wraps from 14.0 back to 10.0. The element is still at 13.98
    // (about to wrap with us). Backward delta classifies as jump, so we
    // issue an explicit `currentTime` write to snap the muted preview.
    expect(
      decideCamPreviewAction({
        ...coldInput(10.0, 0),
        videoCurrentTimeS: 13.98,
        prevMasterT: 14.0,
      }),
    ).toEqual({ kind: "seek", sourceT: 10.0 });
  });

  it("forward jump but element already on target → hold (no redundant seek)", () => {
    // Edge case: jump dispatched, the element happened to seek at the
    // same time (e.g. via separate seek-event listener) and is already
    // there. Don't issue another seek that would wipe its decoder.
    expect(
      decideCamPreviewAction({
        ...coldInput(95.0, 0, 600),
        videoCurrentTimeS: 95.01,
        prevMasterT: 10,
      }),
    ).toMatchObject({ kind: "hold" });
  });

  it("tiny backward jitter (under 20 ms) is NOT classified as a jump", () => {
    // `<audio>.currentTime` can jiggle by a few ms between RAFs. We must
    // not treat that as a wrap.
    expect(
      decideCamPreviewAction({
        ...coldInput(10.005, 0),
        videoCurrentTimeS: 10.005,
        prevMasterT: 10.01,
      }),
    ).toMatchObject({ kind: "hold" });
  });
});
