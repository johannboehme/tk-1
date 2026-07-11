/**
 * TransportBar undo/redo affordance (#69): the buttons mirror the
 * history depths from the store and drive the real history module.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TransportBar } from "./TransportBar";
import { useEditorStore } from "../store";
import {
  flushPendingHistory,
  initEditorHistory,
  resetEditorHistory,
} from "../history";

// jsdom has no matchMedia — useIsNarrowViewport needs it. matches:false
// = desktop layout, which is where the undo/redo buttons live.
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

let dispose: (() => void) | null = null;

describe("TransportBar undo/redo buttons (#69)", () => {
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
    dispose = initEditorHistory();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    resetEditorHistory();
  });

  it("buttons disable at zero depth and enable after an edit", () => {
    render(<TransportBar />);
    const undoBtn = screen.getByRole("button", { name: "Undo the last edit" });
    const redoBtn = screen.getByRole("button", {
      name: "Redo the last undone edit",
    });
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).toBeDisabled();

    act(() => {
      useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
      flushPendingHistory();
    });
    expect(undoBtn).toBeEnabled();
    expect(redoBtn).toBeDisabled();
  });

  it("clicking undo restores the document and arms redo", () => {
    render(<TransportBar />);
    act(() => {
      useEditorStore.getState().addCut({ atTimeS: 1, camId: "cam2" });
      flushPendingHistory();
      useEditorStore.getState().clearCuts();
      flushPendingHistory();
    });
    expect(useEditorStore.getState().cuts).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Undo the last edit" }),
    );
    expect(useEditorStore.getState().cuts).toHaveLength(1);

    const redoBtn = screen.getByRole("button", {
      name: "Redo the last undone edit",
    });
    expect(redoBtn).toBeEnabled();
    fireEvent.click(redoBtn);
    expect(useEditorStore.getState().cuts).toHaveLength(0);
  });
});
