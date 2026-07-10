import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test } from "vitest";
import { useEditorStore } from "../store";
import { camQuickPicks, SyncTuner } from "./SyncTuner";

const meta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 250,
  driftRatio: 1.0,
};

describe("<SyncTuner />", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    useEditorStore.getState().loadJob(meta, {
      lastSyncOverrideMs: -120,
      clips: [
        {
          id: "cam-1",
          filename: "cam-1.mp4",
          color: "#3b6dff",
          sourceDurationS: 60,
          syncOffsetMs: 250,
        },
      ],
    });
  });

  test("nudge buttons update the store", async () => {
    render(<SyncTuner lastSyncOverrideMs={-120} />);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(-120);
    const plus10 = screen.getByRole("button", { name: "+10" });
    await userEvent.click(plus10);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(-110);
  });

  test("A/B segmented control toggles abBypass", async () => {
    render(<SyncTuner lastSyncOverrideMs={null} />);
    const algo = screen.getByRole("tab", { name: /A.*ALGO/i });
    await userEvent.click(algo);
    expect(useEditorStore.getState().offset.abBypass).toBe(true);
  });

  test("RESET TO ALGO sets userOverrideMs to 0", async () => {
    render(<SyncTuner lastSyncOverrideMs={null} />);
    const reset = screen.getByRole("button", { name: /RESET TO ALGO/i });
    await userEvent.click(reset);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(0);
  });

  test("USE LAST is shown when lastSyncOverrideMs differs from current", async () => {
    useEditorStore.getState().setOffset(0);
    render(<SyncTuner lastSyncOverrideMs={-120} />);
    const useLast = screen.getByRole("button", { name: /USE LAST/i });
    await userEvent.click(useLast);
    expect(useEditorStore.getState().offset.userOverrideMs).toBe(-120);
  });

  test("USE LAST is hidden when lastSyncOverrideMs equals current", () => {
    render(<SyncTuner lastSyncOverrideMs={-120} />);
    expect(screen.queryByRole("button", { name: /USE LAST/i })).toBeNull();
  });

  test("loop preset buttons set a loop region around the playhead", async () => {
    useEditorStore.getState().setCurrentTime(10);
    useEditorStore.getState().setTrim({ in: 0, out: 60 });
    render(<SyncTuner lastSyncOverrideMs={null} />);
    const oneSec = screen.getByRole("button", { name: /^1s$/ });
    await userEvent.click(oneSec);
    const loop = useEditorStore.getState().playback.loop;
    expect(loop).not.toBeNull();
    expect(loop!.end - loop!.start).toBeCloseTo(1, 5);
  });
});

// Quick-pick chips in the empty state must use the same POSITIONAL cam
// numbering as the timeline lane headers (`Cam ${i + 1}` over the
// unfiltered clips array), the panel's own header, and the digit hotkeys
// (`s.clips[n - 1]`). Ids are never renumbered on cam removal, so
// id-derived labels drift away from every other surface.
describe("SyncTuner quick-pick chips", () => {
  const videoClip = (id: string, filename: string, color: string) => ({
    id,
    filename,
    color,
    sourceDurationS: 60,
    syncOffsetMs: 0,
  });

  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  test("chips number cams by position after a cam removal", () => {
    // A 3-cam project after "Cam 1" (cam-1) was removed: ids keep their
    // numbers, lanes/hotkeys renumber to Cam 1 / Cam 2.
    useEditorStore.getState().loadJob(meta, {
      clips: [
        videoClip("cam-2", "b.mp4", "#3b6dff"),
        videoClip("cam-3", "c.mp4", "#ff3b6d"),
      ],
    });
    render(<SyncTuner lastSyncOverrideMs={null} />);
    expect(screen.getByRole("button", { name: "Cam 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cam 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cam 3" })).toBeNull();
  });

  test("clicking a chip opens the panel with a matching header", async () => {
    useEditorStore.getState().loadJob(meta, {
      clips: [
        videoClip("cam-2", "b.mp4", "#3b6dff"),
        videoClip("cam-3", "c.mp4", "#ff3b6d"),
      ],
    });
    render(<SyncTuner lastSyncOverrideMs={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Cam 1" }));
    // Chip "Cam 1" = clips[0] = cam-2, exactly what hotkey 1 selects.
    expect(useEditorStore.getState().selectedClipId).toBe("cam-2");
    expect(
      screen.getByRole("heading", { name: /Sync · Cam 1/ }),
    ).toBeTruthy();
  });

  test("image clips keep their lane slot but get no chip", () => {
    useEditorStore.getState().loadJob(meta, {
      clips: [
        videoClip("cam-1", "a.mp4", "#3b6dff"),
        {
          kind: "image" as const,
          id: "img-1",
          filename: "still.png",
          color: "#22cc88",
          durationS: 5,
        },
        videoClip("cam-2", "c.mp4", "#ff3b6d"),
      ],
    });
    render(<SyncTuner lastSyncOverrideMs={null} />);
    // Lanes read Cam 1 / Cam 2 / Cam 3; the image lane (Cam 2) has no
    // sync, so the chips are Cam 1 and Cam 3.
    expect(screen.getByRole("button", { name: "Cam 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cam 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cam 3" })).toBeTruthy();
  });

  test("camQuickPicks labels by unfiltered index and skips image clips", () => {
    useEditorStore.getState().loadJob(meta, {
      clips: [
        videoClip("cam-7", "a.mp4", "#3b6dff"),
        {
          kind: "image" as const,
          id: "img-1",
          filename: "still.png",
          color: "#22cc88",
          durationS: 5,
        },
        videoClip("weird-id", "c.mp4", "#ff3b6d"),
      ],
    });
    const picks = camQuickPicks(useEditorStore.getState().clips);
    expect(picks).toEqual([
      { id: "cam-7", color: "#3b6dff", label: "Cam 1" },
      { id: "weird-id", color: "#ff3b6d", label: "Cam 3" },
    ]);
  });
});
