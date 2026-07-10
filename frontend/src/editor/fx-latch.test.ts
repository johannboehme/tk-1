import { beforeEach, describe, expect, it } from "vitest";
import { toggleFxPreviewLatch } from "./fx-latch";
import { useEditorStore } from "./store";

const baseMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1,
};

function holds() {
  return useEditorStore.getState().fxHolds;
}
function previewEntries() {
  return Object.entries(holds()).filter(([, h]) => h.mode === "preview");
}

describe("toggleFxPreviewLatch (paused FX audition — shared by pad clicks and hotkeys)", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(baseMeta);
    // Paused is the default after loadJob — latching only happens paused.
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
  });

  it("latches a preview hold for the given kind", () => {
    const result = toggleFxPreviewLatch(
      useEditorStore.getState(),
      "key:V",
      "vignette",
    );
    expect(result).toBe("latched");
    const entries = previewEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("key:V");
    expect(entries[0][1].kind).toBe("vignette");
    // Preview only — nothing written to the timeline.
    expect(useEditorStore.getState().fx).toHaveLength(0);
  });

  it("tapping the same kind again unlatches it", () => {
    toggleFxPreviewLatch(useEditorStore.getState(), "key:V", "vignette");
    const result = toggleFxPreviewLatch(
      useEditorStore.getState(),
      "key:V",
      "vignette",
    );
    expect(result).toBe("unlatched");
    expect(previewEntries()).toHaveLength(0);
  });

  it("tapping a different kind swaps the single preview", () => {
    toggleFxPreviewLatch(useEditorStore.getState(), "key:V", "vignette");
    const result = toggleFxPreviewLatch(
      useEditorStore.getState(),
      "key:W",
      "wear",
    );
    expect(result).toBe("swapped");
    const entries = previewEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1].kind).toBe("wear");
  });

  it("toggles off a preview latched under a DIFFERENT slot (pad click ↔ hotkey parity)", () => {
    // Pad click latches under its own slot key …
    useEditorStore.getState().beginFxHold("pad:vignette", "vignette", 0);
    expect(previewEntries()).toHaveLength(1);
    // … and the hotkey for the same kind must toggle it OFF, not stack.
    const result = toggleFxPreviewLatch(
      useEditorStore.getState(),
      "key:V",
      "vignette",
    );
    expect(result).toBe("unlatched");
    expect(previewEntries()).toHaveLength(0);
  });
});
