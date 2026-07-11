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
import { flushPendingHistory } from "../editor/history";
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

describe("Editor undo/redo shortcuts (#69)", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(baseMeta, {
      clips: [
        {
          id: "cam1",
          filename: "a.mp4",
          color: "#f00",
          sourceDurationS: 60,
          syncOffsetMs: 0,
        },
        {
          id: "cam2",
          filename: "b.mp4",
          color: "#0f0",
          sourceDurationS: 60,
          syncOffsetMs: 0,
        },
      ],
    });
    useShortcutRegistry.setState({ shortcuts: [] });
  });

  /** Record one cut, then wipe it — two committed history entries. */
  function seedClearedCuts() {
    useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
    flushPendingHistory();
    useEditorStore.getState().clearCuts();
    flushPendingHistory();
    expect(useEditorStore.getState().cuts).toHaveLength(0);
  }

  it("Cmd+Z undoes a committed clear; Shift+Cmd+Z redoes", () => {
    mountEditor();
    seedClearedCuts();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(useEditorStore.getState().cuts).toHaveLength(1);
    expect(useEditorStore.getState().notice?.message).toMatch(/Undo/);
    fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
    expect(useEditorStore.getState().cuts).toHaveLength(0);
    expect(useEditorStore.getState().notice?.message).toMatch(/Redo/);
  });

  it("Ctrl+Z / Ctrl+Shift+Z work as the non-Apple chords", () => {
    mountEditor();
    seedClearedCuts();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(useEditorStore.getState().cuts).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(useEditorStore.getState().cuts).toHaveLength(0);
  });

  it("plain Z stays the zoom FX pad — no undo without a modifier", () => {
    mountEditor();
    seedClearedCuts();
    fireEvent.keyDown(window, { key: "z" });
    fireEvent.keyUp(window, { key: "z" });
    // No undo happened…
    expect(useEditorStore.getState().cuts).toHaveLength(0);
    // …and the pad did its paused-latch job instead.
    expect(useEditorStore.getState().selectedFxKind).toBe("zoom");
  });

  it("registers cheat-sheet entries for undo and redo", () => {
    mountEditor();
    const ids = useShortcutRegistry.getState().shortcuts.map((s) => s.id);
    // jsdom is not an Apple platform — the Ctrl chords carry the help.
    expect(ids).toContain("editor.undo.ctrl");
    expect(ids).toContain("editor.redo.ctrl");
  });
});
