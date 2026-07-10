import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LaneHeader } from "./LaneHeader";

describe("LaneHeader", () => {
  test("is memoized — 60 Hz parent renders with stable props must skip its subtree", () => {
    // Timeline re-renders every playback frame (it subscribes to the
    // playhead). ProgramStrip is memo()ed for exactly this reason; the
    // LaneHeader control strip (~360 lines of skeuomorph DOM × N cams)
    // must be too, or the header column reconciles at 60 Hz.
    expect((LaneHeader as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("memo wrapper keeps the control strip rendering + wiring intact", () => {
    const onSelectClip = vi.fn();
    const onDelete = vi.fn();
    render(
      <LaneHeader
        name="Cam 1"
        filename="take.mp4"
        color="#E4572E"
        status="on-air"
        hotkeyLabel="1"
        onSelectClip={onSelectClip}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByText("Cam 1")).toBeTruthy();
    expect(screen.getByText("take.mp4")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /take cam 1/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Cam 1"));
    expect(onSelectClip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /remove cam 1/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSelectClip).toHaveBeenCalledTimes(1); // delete stops propagation
  });
});
