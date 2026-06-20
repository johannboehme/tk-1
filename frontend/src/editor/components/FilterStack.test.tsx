import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterStack } from "./FilterStack";
import { useEditorStore } from "../store";

const S = () => useEditorStore.getState();

describe("FilterStack", () => {
  beforeEach(() => S().reset());

  it("shows an empty state and a working ADD button", () => {
    render(<FilterStack />);
    expect(screen.getByText(/No filters yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ADD" }));
    expect(S().filterSlots).toHaveLength(1);
    expect(screen.queryByText(/No filters yet/i)).toBeNull();
  });

  it("renders the Filter picker + the selected kind's OWN controls", () => {
    S().addFilterSlot("vhs");
    render(<FilterStack />);
    expect(screen.getByLabelText("Filter")).toBeTruthy();
    // VHS shows its own param sliders
    for (const name of ["TRACK", "BLEED", "SNOW", "WOBBLE", "AMOUNT"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("switching the filter kind swaps the whole control set", () => {
    const id = S().addFilterSlot("vhs");
    render(<FilterStack />);
    expect(screen.queryByLabelText("TRACK")).toBeTruthy();
    expect(screen.queryByLabelText("TONE")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "sepia" } });
    expect(S().filterSlots.find((s) => s.id === id)?.kind).toBe("sepia");
    // now Sepia's controls render, VHS's are gone
    expect(screen.queryByLabelText("TONE")).toBeTruthy();
    expect(screen.queryByLabelText("TRACK")).toBeNull();
  });

  it("a param slider writes back to the slot (0..100 -> 0..1)", () => {
    const id = S().addFilterSlot("vhs");
    render(<FilterStack />);
    fireEvent.change(screen.getByLabelText("TRACK"), { target: { value: "80" } });
    expect(S().filterSlots.find((s) => s.id === id)?.params.tracking).toBeCloseTo(0.8);
  });

  it("REMOVE drops the card", () => {
    S().addFilterSlot("vhs");
    render(<FilterStack />);
    fireEvent.click(screen.getByRole("button", { name: "REMOVE" }));
    expect(S().filterSlots).toHaveLength(0);
  });

  it("reorder nudges move a slot and are disabled at the ends", () => {
    const a = S().addFilterSlot("vhs");
    const b = S().addFilterSlot("sepia");
    render(<FilterStack />);
    const ups = screen.getAllByRole("button", { name: "Move filter up" });
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ups[1]);
    expect(S().filterSlots.map((s) => s.id)).toEqual([b, a]);
  });

  it("the card header shows the kind's swatch", () => {
    S().addFilterSlot("noir");
    const { container } = render(<FilterStack />);
    // swatch chip is an aria-hidden span with a background colour
    expect(container.querySelector('span[aria-hidden]')).toBeTruthy();
  });
});
