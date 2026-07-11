/**
 * Grade domain — the single global color grade plus the opinionated
 * filter stack (VHS / Super-8 / Sepia / …).
 */
import type { FilterSlot, FxKind } from "../../core/fx/types";
import { defaultColorGrade, type GradeParams } from "../../core/fx/looks";
import { fxCatalog } from "../../core/fx/catalog";
import { makeFxId } from "./fx-slice";
import type { SliceCreator } from "./state";

export interface GradeSliceState {
  /** The single global color grade — the corrective/creative pass applied
   *  under everything. One `GradeParams` vector (not a stack); the descriptor
   *  builder emits one `grade` FrameFx unless it's the identity. Edited in the
   *  Overlays "Color grade" section, persisted per-job. */
  colorGrade: GradeParams;
  /** Opinionated filter stack — VHS / Super-8 / Sepia / … . Each slot picks a
   *  filter kind and carries that kind's own params; they compose serially
   *  top→bottom, applied above the grade and under the punch-in accents.
   *  Edited in the Overlays "Filters" section, persisted per-job. */
  filterSlots: FilterSlot[];
}

export interface GradeSliceActions {
  // ---- Color grade (one single global grade) ----
  /** Patch the global color grade (one or more GradeParams). */
  setColorGrade(patch: Partial<GradeParams>): void;
  /** Reset the color grade to the neutral identity. */
  resetColorGrade(): void;

  // ---- Filter stack (opinionated looks) ----
  /** Append a filter slot of `kind`, seeded with that kind's tasteful
   *  defaults. Returns its id. */
  addFilterSlot(kind: FxKind): string;
  /** Set one param of a filter slot (e.g. "tracking", "amount"). */
  setFilterParam(id: string, key: string, value: number): void;
  /** Switch a filter slot to a different kind (reseeds its params). */
  setFilterKind(id: string, kind: FxKind): void;
  /** Remove a filter slot by id. */
  removeFilterSlot(id: string): void;
  /** Nudge a filter slot up (-1) or down (+1) — order is the serial compose
   *  order, so this changes the result. Clamped at ends. */
  moveFilterSlot(id: string, dir: -1 | 1): void;
}

export function initialGradeState(): GradeSliceState {
  return {
    colorGrade: defaultColorGrade(),
    filterSlots: [],
  };
}

export const createGradeSlice: SliceCreator<GradeSliceActions> = (
  set,
  get,
) => ({
  setColorGrade(patch) {
    set({ colorGrade: { ...get().colorGrade, ...patch } });
  },
  resetColorGrade() {
    set({ colorGrade: defaultColorGrade() });
  },
  addFilterSlot(kind) {
    const id = makeFxId();
    const def = fxCatalog[kind];
    const slot: FilterSlot = { id, kind, params: { ...def.defaultParams } };
    set({ filterSlots: [...get().filterSlots, slot] });
    return id;
  },
  setFilterParam(id, key, value) {
    set({
      filterSlots: get().filterSlots.map((s) =>
        s.id === id ? { ...s, params: { ...s.params, [key]: value } } : s,
      ),
    });
  },
  setFilterKind(id, kind) {
    const def = fxCatalog[kind];
    set({
      filterSlots: get().filterSlots.map((s) =>
        s.id === id ? { ...s, kind, params: { ...def.defaultParams } } : s,
      ),
    });
  },
  removeFilterSlot(id) {
    set({ filterSlots: get().filterSlots.filter((s) => s.id !== id) });
  },
  moveFilterSlot(id, dir) {
    const slots = get().filterSlots;
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= slots.length) return;
    const next = slots.slice();
    [next[i], next[j]] = [next[j], next[i]];
    set({ filterSlots: next });
  },
});
