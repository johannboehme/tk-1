import { beforeEach, describe, expect, test } from "vitest";
import { useEditorStore } from "./store";
import { ENGINE_DEFAULTS } from "./fx/looks";
import { fxCatalog } from "./fx/catalog";

const baseJobMeta = {
  id: "j1",
  fps: 30,
  duration: 60,
  width: 1920,
  height: 1080,
  algoOffsetMs: 0,
  driftRatio: 1.0,
};
const S = () => useEditorStore.getState();

describe("color grade actions", () => {
  beforeEach(() => S().reset());

  test("initial colorGrade is the identity", () => {
    expect(S().colorGrade).toEqual(ENGINE_DEFAULTS);
  });

  test("setColorGrade patches one or more params, leaving the rest", () => {
    S().setColorGrade({ exposure: 0.3, temp: -0.2 });
    expect(S().colorGrade.exposure).toBe(0.3);
    expect(S().colorGrade.temp).toBe(-0.2);
    expect(S().colorGrade.saturation).toBe(1); // untouched
  });

  test("resetColorGrade restores the identity", () => {
    S().setColorGrade({ contrast: 0.5, shadowsLift: 0.4 });
    S().resetColorGrade();
    expect(S().colorGrade).toEqual(ENGINE_DEFAULTS);
  });
});

describe("filter slot actions", () => {
  beforeEach(() => S().reset());

  test("initial filterSlots is empty", () => {
    expect(S().filterSlots).toEqual([]);
  });

  test("addFilterSlot seeds the kind's tasteful defaults and returns its id", () => {
    const id = S().addFilterSlot("vhs");
    const slots = S().filterSlots;
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe(id);
    expect(slots[0].kind).toBe("vhs");
    expect(slots[0].params).toEqual(fxCatalog.vhs.defaultParams);
    expect(slots[0].params.amount).toBeGreaterThan(0); // immediately visible
  });

  test("setFilterParam updates one param only", () => {
    const id = S().addFilterSlot("vhs");
    S().setFilterParam(id, "tracking", 0.9);
    const slot = S().filterSlots[0];
    expect(slot.params.tracking).toBe(0.9);
    expect(slot.params.bleed).toBe(fxCatalog.vhs.defaultParams.bleed); // untouched
  });

  test("setFilterKind switches kind and reseeds that kind's defaults", () => {
    const id = S().addFilterSlot("vhs");
    S().setFilterParam(id, "tracking", 0.9);
    S().setFilterKind(id, "sepia");
    const slot = S().filterSlots[0];
    expect(slot.kind).toBe("sepia");
    expect(slot.params).toEqual(fxCatalog.sepia.defaultParams);
    expect(slot.params.tracking).toBeUndefined();
  });

  test("removeFilterSlot drops by id", () => {
    const a = S().addFilterSlot("vhs");
    const b = S().addFilterSlot("sepia");
    S().removeFilterSlot(a);
    expect(S().filterSlots.map((s) => s.id)).toEqual([b]);
  });

  test("moveFilterSlot reorders, clamped at the ends", () => {
    const a = S().addFilterSlot("vhs");
    const b = S().addFilterSlot("sepia");
    const c = S().addFilterSlot("noir");
    S().moveFilterSlot(b, -1);
    expect(S().filterSlots.map((s) => s.id)).toEqual([b, a, c]);
    S().moveFilterSlot(b, -1); // already top
    expect(S().filterSlots.map((s) => s.id)).toEqual([b, a, c]);
    S().moveFilterSlot(c, 1); // already bottom
    expect(S().filterSlots.map((s) => s.id)).toEqual([b, a, c]);
  });
});

describe("loadJob hydration", () => {
  beforeEach(() => S().reset());

  test("hydrates colorGrade + filterSlots from opts", () => {
    S().loadJob(baseJobMeta, {
      colorGrade: { ...ENGINE_DEFAULTS, exposure: 0.4 },
      filterSlots: [{ id: "x", kind: "super8", params: { ...fxCatalog.super8.defaultParams } }],
    });
    expect(S().colorGrade.exposure).toBe(0.4);
    expect(S().filterSlots).toHaveLength(1);
    expect(S().filterSlots[0].kind).toBe("super8");
  });

  test("a partial persisted colorGrade still loads with every key present", () => {
    S().loadJob(baseJobMeta, { colorGrade: { exposure: 0.5 } as never });
    expect(S().colorGrade.exposure).toBe(0.5);
    expect(S().colorGrade.saturation).toBe(1); // default filled in
    expect(S().colorGrade.shadowsLift).toBe(0);
  });

  test("without grade/filters, defaults to identity + empty (old jobs migrate cleanly)", () => {
    S().addFilterSlot("vhs");
    S().setColorGrade({ exposure: 0.9 });
    S().loadJob(baseJobMeta);
    expect(S().colorGrade).toEqual(ENGINE_DEFAULTS);
    expect(S().filterSlots).toEqual([]);
  });

  test("reset clears colorGrade + filterSlots", () => {
    S().addFilterSlot("vhs");
    S().setColorGrade({ contrast: 0.7 });
    S().reset();
    expect(S().colorGrade).toEqual(ENGINE_DEFAULTS);
    expect(S().filterSlots).toEqual([]);
  });
});
