import { beforeEach, describe, expect, test } from "vitest";
import { useEditorStore } from "./store";

const baseJobMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1.0,
};

describe("grade slot actions", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  test("initial gradeSlots is empty", () => {
    expect(useEditorStore.getState().gradeSlots).toEqual([]);
  });

  test("addGradeSlot appends a neutral slot and returns its id", () => {
    const id = useEditorStore.getState().addGradeSlot();
    const slots = useEditorStore.getState().gradeSlots;
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe(id);
    expect(slots[0].strength).toBeGreaterThan(0);
    expect(slots[0].warmth).toBe(0);
  });

  test("addGradeSlot stacks in insertion order", () => {
    const a = useEditorStore.getState().addGradeSlot();
    const b = useEditorStore.getState().addGradeSlot();
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([a, b]);
  });

  test("updateGradeSlot merges a partial patch", () => {
    const id = useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().updateGradeSlot(id, { lookId: "ember", warmth: 0.5 });
    const slot = useEditorStore.getState().gradeSlots[0];
    expect(slot.lookId).toBe("ember");
    expect(slot.warmth).toBe(0.5);
    // untouched fields preserved
    expect(slot.strength).toBeGreaterThan(0);
  });

  test("updateGradeSlot ignores unknown ids", () => {
    const id = useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().updateGradeSlot("nope", { warmth: 1 });
    expect(useEditorStore.getState().gradeSlots[0].id).toBe(id);
    expect(useEditorStore.getState().gradeSlots[0].warmth).toBe(0);
  });

  test("removeGradeSlot drops by id", () => {
    const a = useEditorStore.getState().addGradeSlot();
    const b = useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().removeGradeSlot(a);
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([b]);
  });

  test("moveGradeSlot reorders, clamped at the ends", () => {
    const a = useEditorStore.getState().addGradeSlot();
    const b = useEditorStore.getState().addGradeSlot();
    const c = useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().moveGradeSlot(b, -1); // b up
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([b, a, c]);
    useEditorStore.getState().moveGradeSlot(b, -1); // already top, no-op
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([b, a, c]);
    useEditorStore.getState().moveGradeSlot(c, 1); // already bottom, no-op
    expect(useEditorStore.getState().gradeSlots.map((s) => s.id)).toEqual([b, a, c]);
  });

  test("loadJob hydrates gradeSlots from opts.grades", () => {
    useEditorStore.getState().loadJob(baseJobMeta, {
      grades: [
        { id: "x", lookId: "frost", strength: 0.7, warmth: 0, fade: 0, punch: 0.2, grain: 0 },
      ],
    });
    const slots = useEditorStore.getState().gradeSlots;
    expect(slots).toHaveLength(1);
    expect(slots[0].lookId).toBe("frost");
  });

  test("loadJob without grades defaults to empty (old jobs migrate cleanly)", () => {
    useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().loadJob(baseJobMeta);
    expect(useEditorStore.getState().gradeSlots).toEqual([]);
  });

  test("reset clears gradeSlots", () => {
    useEditorStore.getState().addGradeSlot();
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().gradeSlots).toEqual([]);
  });
});
