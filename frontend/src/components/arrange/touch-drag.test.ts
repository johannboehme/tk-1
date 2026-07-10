/**
 * TouchLongPressArmer — drag-intent detection for touch gestures.
 *
 * Regression tests for #74: on touch devices a plain swipe over a
 * Polaroid / strip frame must stay a native scroll; only a deliberate
 * long-press (hold still, then move) may promote the gesture to a
 * chunk-drag / reorder-drag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  TouchLongPressArmer,
} from "./touch-drag";

describe("TouchLongPressArmer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make() {
    const onStart = vi.fn();
    const armer = new TouchLongPressArmer({ onStart });
    return { armer, onStart };
  }

  it("fires onStart after the long-press delay when held still", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(100, 200);
  });

  it("a swipe (movement beyond the slop) cancels the press — scroll wins", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    armer.move(1, 100, 200 + TOUCH_SLOP_PX + 1); // vertical swipe
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onStart).not.toHaveBeenCalled();
    expect(armer.isArmed).toBe(false);
  });

  it("finger tremble within the slop keeps the press armed and reports the last position", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    armer.move(1, 103, 204); // within 8 px slop
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onStart).toHaveBeenCalledWith(103, 204);
  });

  it("lifting the finger (cancel) before the delay prevents the drag", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    armer.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ignores moves from other pointers (multi-touch)", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    armer.move(2, 500, 500); // second finger elsewhere
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onStart).toHaveBeenCalledWith(100, 200);
  });

  it("a new down restarts the timer for the new press", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    vi.advanceTimersByTime(LONG_PRESS_MS - 10);
    armer.down(2, 300, 400);
    vi.advanceTimersByTime(20);
    expect(onStart).not.toHaveBeenCalled(); // old press was superseded
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(300, 400);
  });

  it("does not fire twice for one press", () => {
    const { armer, onStart } = make();
    armer.down(1, 100, 200);
    vi.advanceTimersByTime(LONG_PRESS_MS * 3);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
