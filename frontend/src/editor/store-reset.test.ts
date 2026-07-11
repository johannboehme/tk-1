/**
 * Pins the reset() contract (#121): resetting must restore EVERY data
 * field of the store to its pristine initial value. Historically the
 * initial state was hand-enumerated in three places (create / reset /
 * loadJob) with nothing enforcing sync — a new field forgotten in
 * reset() silently leaked state from the previous job into the next.
 *
 * The test is enumeration-free on purpose: it pollutes every data field
 * it finds on the live store with a sentinel, so a future field that
 * reset() misses fails here without anyone updating the test.
 */
import { describe, expect, test } from "vitest";
import { useEditorStore } from "./store";

function dataSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(useEditorStore.getState())) {
    if (typeof v === "function") continue;
    out[k] = v;
  }
  return out;
}

describe("store reset()", () => {
  test("restores every data field after all of them were polluted", () => {
    useEditorStore.getState().reset();
    const pristine = dataSnapshot();
    // The store is not an empty shell — sanity-check the scan itself.
    expect(Object.keys(pristine).length).toBeGreaterThan(20);

    const polluted: Record<string, unknown> = {};
    for (const key of Object.keys(pristine)) {
      polluted[key] = { __polluted: key };
    }
    useEditorStore.setState(polluted as never);
    expect(dataSnapshot()).not.toEqual(pristine);

    useEditorStore.getState().reset();
    expect(dataSnapshot()).toEqual(pristine);
  });

  test("loadJob starts from a clean slate for job-scoped fields", () => {
    const s = useEditorStore.getState();
    s.reset();
    // Dirty a handful of job-scoped fields via real actions.
    s.setPlaying(true);
    s.setColorGrade({ exposure: 0.5 });
    s.setMasterAudioVolume(2);
    s.addOverlay({ type: "text", text: "x", start: 0, end: 1 });
    s.setFxDefault("vignette", "intensity", 0.9);

    useEditorStore.getState().loadJob({
      id: "job-2",
      fps: 30,
      duration: 10,
      width: 1920,
      height: 1080,
      algoOffsetMs: 0,
      driftRatio: 1,
    });

    const after = useEditorStore.getState();
    expect(after.playback.isPlaying).toBe(false);
    expect(after.colorGrade.exposure).toBe(0);
    expect(after.audioVolume).toBe(1);
    expect(after.overlays).toEqual([]);
    expect(after.fxDefaults).toEqual({});
  });
});
