/**
 * Keyboard-path tests for the Editor page's FX hotkeys (#88): the
 * documented paused-audition latch must be reachable from the keyboard,
 * not only from pad clicks.
 *
 * The page is mounted WITHOUT a job id, so the asset-loading effect
 * no-ops (jsdom has no OPFS/WebCodecs) while the global keyboard
 * bindings — unconditional effects — are live. Store state is driven
 * directly via loadJob.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Editor from "./Editor";
import { useEditorStore } from "../editor/store";
import { useShortcutRegistry } from "../editor/shortcuts/registry";

// jsdom has no matchMedia — useIsNarrowViewport needs it.
if (typeof window.matchMedia === "undefined") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const baseMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1,
};

function mountEditor() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Editor />} />
      </Routes>
    </MemoryRouter>,
  );
}

function previewEntries() {
  return Object.entries(useEditorStore.getState().fxHolds).filter(
    ([, h]) => h.mode === "preview",
  );
}

describe("Editor FX hotkeys — paused audition latch (#88)", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(baseMeta);
    useShortcutRegistry.setState({ shortcuts: [] });
  });

  it("tapping V while paused latches a vignette preview (and moves the recording head)", () => {
    mountEditor();
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
    fireEvent.keyDown(window, { key: "v" });
    const entries = previewEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1].kind).toBe("vignette");
    expect(useEditorStore.getState().selectedFxKind).toBe("vignette");
    // Preview only — nothing recorded to the timeline.
    expect(useEditorStore.getState().fx).toHaveLength(0);
  });

  it("the latch survives keyup and a second tap unlatches", () => {
    mountEditor();
    fireEvent.keyDown(window, { key: "v" });
    fireEvent.keyUp(window, { key: "v" });
    expect(previewEntries()).toHaveLength(1); // latched, not a hold
    fireEvent.keyDown(window, { key: "v" });
    fireEvent.keyUp(window, { key: "v" });
    expect(previewEntries()).toHaveLength(0);
  });

  it("tapping another pad swaps the preview kind", () => {
    mountEditor();
    fireEvent.keyDown(window, { key: "v" });
    fireEvent.keyUp(window, { key: "v" });
    fireEvent.keyDown(window, { key: "w" });
    fireEvent.keyUp(window, { key: "w" });
    const entries = previewEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1].kind).toBe("wear");
    expect(useEditorStore.getState().selectedFxKind).toBe("wear");
  });

  it("while playing, the key records a hold (press) and ends it (release) — no latch", () => {
    mountEditor();
    useEditorStore.getState().setPlaying(true);
    fireEvent.keyDown(window, { key: "v" });
    expect(
      Object.values(useEditorStore.getState().fxHolds).some(
        (h) => h.mode === "persistent",
      ),
    ).toBe(true);
    expect(useEditorStore.getState().fx.length).toBeGreaterThan(0);
    fireEvent.keyUp(window, { key: "v" });
    expect(Object.keys(useEditorStore.getState().fxHolds)).toHaveLength(0);
  });
});
