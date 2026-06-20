import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterStack } from "./FilterStack";
import { useEditorStore } from "../store";

describe("FilterStack", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  it("shows an empty state and a working ADD button", () => {
    render(<FilterStack />);
    expect(screen.getByText(/No filters yet/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ADD" }));
    expect(useEditorStore.getState().gradeSlots).toHaveLength(1);
    expect(screen.queryByText(/No filters yet/i)).toBeNull();
  });

  it("renders look select + Amount + four macro sliders per card", () => {
    useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    expect(screen.getByLabelText("Look")).toBeTruthy();
    for (const name of ["Amount", "Warmth", "Fade", "Punch", "Grain"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("changing the look select writes to the store", () => {
    const id = useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    fireEvent.change(screen.getByLabelText("Look"), { target: { value: "ember" } });
    const slot = useEditorStore.getState().gradeSlots.find((s) => s.id === id);
    expect(slot?.lookId).toBe("ember");
  });

  it("Amount slider maps 0..100 to strength 0..1", () => {
    const id = useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "40" } });
    expect(useEditorStore.getState().gradeSlots.find((s) => s.id === id)?.strength).toBeCloseTo(0.4);
  });

  it("a bipolar macro maps -100..100 to -1..1", () => {
    const id = useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    fireEvent.change(screen.getByLabelText("Punch"), { target: { value: "-50" } });
    expect(useEditorStore.getState().gradeSlots.find((s) => s.id === id)?.punch).toBeCloseTo(-0.5);
  });

  it("REMOVE drops the card", () => {
    useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    fireEvent.click(screen.getByRole("button", { name: "REMOVE" }));
    expect(useEditorStore.getState().gradeSlots).toHaveLength(0);
  });

  it("reorder nudges move a slot and are disabled at the ends", () => {
    const a = useEditorStore.getState().addGradeSlot();
    const b = useEditorStore.getState().addGradeSlot();
    render(<FilterStack />);
    const ups = screen.getAllByRole("button", { name: "Move filter up" });
    // first card's up is disabled, second card's up moves b above a
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ups[1]);
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([b, a]);
  });

  it("the card header shows the look's swatch + label", () => {
    const id = useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().updateGradeSlot(id, { lookId: "gold" });
    render(<FilterStack />);
    // GOLD label appears in the header chip line (and as the selected option)
    const headers = screen.getAllByText(/GOLD/);
    expect(headers.length).toBeGreaterThan(0);
  });
});
