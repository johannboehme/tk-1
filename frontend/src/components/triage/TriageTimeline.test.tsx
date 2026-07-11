/**
 * TriageTimeline — render isolation of the 60 Hz playhead.
 *
 * During playback the store's `playback.currentTime` updates ~60×/s.
 * Only the playhead line may re-render on those ticks; the chunk lane
 * (one framer-motion block per chunk, tooltip strings built via
 * formatTime), the bar-ruler and the time-ruler must stay untouched —
 * on a 100+ chunk jam re-reconciling all of it per tick is what made
 * triage playback sluggish (issue #112).
 *
 * Probe: `formatTime` is called from every ChunkBlock render (tooltip +
 * label). If a playhead tick re-renders the blocks, the spy fires.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TriageTimeline } from "./TriageTimeline";
import { useTriageStore } from "../../local/triage/triage-store";
import { formatTime } from "../../lib/time-format";
import type { Chunk } from "../../storage/jobs-db";

vi.mock("../../lib/time-format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/time-format")>();
  return { ...actual, formatTime: vi.fn(actual.formatTime) };
});

const formatTimeMock = vi.mocked(formatTime);

beforeAll(() => {
  // framer-motion's useReducedMotion needs matchMedia; jsdom has none.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as never;
  }
});

function makeChunk(
  overrides: Partial<Chunk> & Pick<Chunk, "id" | "startMs" | "endMs">,
): Chunk {
  return {
    bpmOctaveShift: 0,
    effectiveBpm: 0,
    beatsPerBar: 4,
    accepted: true,
    trimMode: "auto",
    ...overrides,
  };
}

beforeEach(() => {
  useTriageStore.getState().reset();
  useTriageStore.setState({
    audioDuration: 600,
    chunks: [
      makeChunk({ id: "c1", startMs: 10_000, endMs: 60_000 }),
      makeChunk({ id: "c2", startMs: 90_000, endMs: 200_000 }),
      makeChunk({ id: "c3", startMs: 220_000, endMs: 380_000, accepted: false }),
    ],
  });
  formatTimeMock.mockClear();
});

afterEach(() => {
  useTriageStore.getState().reset();
});

describe("TriageTimeline — playhead tick isolation", () => {
  it("does not re-render chunk blocks / rulers on 60 Hz playhead ticks", () => {
    render(<TriageTimeline />);
    // Mount renders the chunk lane → tooltips/labels used formatTime.
    expect(formatTimeMock.mock.calls.length).toBeGreaterThan(0);
    formatTimeMock.mockClear();

    act(() => {
      for (let i = 1; i <= 30; i++) {
        useTriageStore.getState().tickTime(i * 0.016);
      }
    });

    expect(formatTimeMock).not.toHaveBeenCalled();
  });

  it("still moves the playhead on ticks", () => {
    render(<TriageTimeline />);
    act(() => {
      useTriageStore.getState().tickTime(0);
    });
    const before = parseFloat(
      screen.getByTestId("triage-playhead").style.left || "0",
    );
    act(() => {
      useTriageStore.getState().tickTime(300);
    });
    const after = parseFloat(
      screen.getByTestId("triage-playhead").style.left || "0",
    );
    // 800 px default width over 600 s → 300 s sits at ~400 px.
    expect(before).toBeCloseTo(0, 1);
    expect(after).toBeCloseTo(400, 0);
  });

  it("hides the playhead when it leaves the visible window", () => {
    render(<TriageTimeline />);
    act(() => {
      useTriageStore.getState().setZoom(10); // visible window: 60 s
      useTriageStore.getState().tickTime(300); // far outside [0, 60]
    });
    expect(screen.queryByTestId("triage-playhead")).not.toBeInTheDocument();
  });
});

describe("TriageTimeline — bar ruler (unified grid)", () => {
  it("renders stride-labeled bar numbers for the focused chunk", () => {
    useTriageStore.setState({
      jobBpm: { value: 120, manualOverride: false },
      focusedChunkId: "c1",
    });
    render(<TriageTimeline />);
    // 800 px over 600 s → pxPerBar ≈ 2.67 at 120 BPM (bar = 2 s) →
    // auto stride 32: bar 1 anchors at c1's start (10 s), the next
    // labeled downbeats are bars 33 and 65 — projected across the view.
    expect(screen.getByText("33")).toBeInTheDocument();
    expect(screen.getByText("65")).toBeInTheDocument();
  });

  it("renders no bar ticks without a focused chunk", () => {
    useTriageStore.setState({
      jobBpm: { value: 120, manualOverride: false },
      focusedChunkId: null,
    });
    render(<TriageTimeline />);
    expect(screen.queryByText("33")).not.toBeInTheDocument();
  });
});
