import { beforeEach, describe, expect, test } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TransportBar } from "./TransportBar";
import { useEditorStore } from "../store";
import { useShortcutRegistry } from "../shortcuts/registry";

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

function press(key: string, opts: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...opts });
}

describe("TransportBar keyboard shortcuts", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(baseMeta);
    useShortcutRegistry.setState({ shortcuts: [] });
  });

  test("Space toggles play/pause", () => {
    render(<TransportBar />);
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
    press(" ");
    expect(useEditorStore.getState().playback.isPlaying).toBe(true);
    press(" ");
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
  });

  test("L toggles a loop region", () => {
    render(<TransportBar />);
    expect(useEditorStore.getState().playback.loop).toBeNull();
    press("l");
    expect(useEditorStore.getState().playback.loop).not.toBeNull();
    press("l");
    expect(useEditorStore.getState().playback.loop).toBeNull();
  });

  test("I / O set the master trim points at the playhead", () => {
    render(<TransportBar />);
    useEditorStore.getState().seek(10);
    press("i");
    expect(useEditorStore.getState().trim.in).toBeCloseTo(10, 5);
    useEditorStore.getState().seek(42);
    press("o");
    expect(useEditorStore.getState().trim.out).toBeCloseTo(42, 5);
  });

  // #96 — browser chords must never fall through into transport edits.
  test.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
  ] as const)("%s+L does not toggle the loop", (_label, mods) => {
    render(<TransportBar />);
    press("l", mods);
    expect(useEditorStore.getState().playback.loop).toBeNull();
  });

  test.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
  ] as const)("%s+I / +O do not move the trim points", (_label, mods) => {
    render(<TransportBar />);
    useEditorStore.getState().seek(10);
    press("i", mods);
    press("o", mods);
    const { trim } = useEditorStore.getState();
    expect(trim.in).toBe(0);
    expect(trim.out).toBe(60);
  });

  test.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
  ] as const)("%s+Space does not toggle playback", (_label, mods) => {
    render(<TransportBar />);
    press(" ", mods);
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
  });

  test("Cmd+ArrowRight (history navigation) does not step the playhead", () => {
    render(<TransportBar />);
    press("ArrowRight", { metaKey: true });
    expect(useEditorStore.getState().playback.currentTime).toBe(0);
  });

  test("Alt+ArrowRight still shifts the loop (documented alt-arrow binding)", () => {
    render(<TransportBar />);
    press("l"); // create a loop first
    const before = useEditorStore.getState().playback.loop;
    expect(before).not.toBeNull();
    press("ArrowRight", { altKey: true });
    const after = useEditorStore.getState().playback.loop;
    expect(after).not.toBeNull();
    expect(after!.start).toBeGreaterThan(before!.start);
  });

  test("plain ArrowRight steps the playhead forward", () => {
    render(<TransportBar />);
    press("ArrowRight");
    expect(useEditorStore.getState().playback.currentTime).toBeGreaterThan(0);
  });

  test("keys are ignored while typing in an input", () => {
    const { container } = render(
      <>
        <TransportBar />
        <input data-testid="txt" />
      </>,
    );
    const input = container.querySelector("input[data-testid='txt']")!;
    (input as HTMLInputElement).focus();
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "l" });
    expect(useEditorStore.getState().playback.isPlaying).toBe(false);
    expect(useEditorStore.getState().playback.loop).toBeNull();
  });
});
