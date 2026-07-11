/**
 * Editor store shape — the intersection of all domain slices.
 *
 * Each slice module owns one cohesive domain (state fields + actions +
 * its module-level pure helpers) and exports:
 *   - `XxxSliceState`   — its top-level data fields
 *   - `XxxSliceActions` — its actions
 *   - `initialXxxState()` — the initial data, used by the assembly's
 *     create() AND by reset()/loadJob() (via `initialEditorState()` in
 *     job-slice.ts), so the three can never drift apart again.
 *   - `createXxxSlice`  — the StateCreator producing the actions
 *
 * The state layout is FLAT and identical to the pre-split store —
 * consumers of `useEditorStore` see the exact same shape.
 *
 * Import discipline: this module imports slice types ONLY (type-only,
 * erased at runtime); slices import `EditorState`/`SliceCreator` from
 * here type-only in return. The value-level graph stays acyclic.
 */
import type { StateCreator } from "zustand";
import type { JobSliceState, JobSliceActions } from "./job-slice";
import type { PlaybackSliceState, PlaybackSliceActions } from "./playback-slice";
import type { ClipsSliceState, ClipsSliceActions } from "./clips-slice";
import type { PillsSliceState, PillsSliceActions } from "./pills-slice";
import type { CutsSliceState, CutsSliceActions } from "./cuts-slice";
import type { QuantizeSliceState, QuantizeSliceActions } from "./quantize-slice";
import type { FxSliceState, FxSliceActions } from "./fx-slice";
import type { GradeSliceState, GradeSliceActions } from "./grade-slice";
import type { OutputSliceState, OutputSliceActions } from "./output-slice";
import type { UiSliceState, UiSliceActions } from "./ui-slice";

/** Data-only part of the store (everything reset() restores). */
export type EditorStateData = JobSliceState &
  PlaybackSliceState &
  ClipsSliceState &
  PillsSliceState &
  CutsSliceState &
  QuantizeSliceState &
  FxSliceState &
  GradeSliceState &
  OutputSliceState &
  UiSliceState;

export type EditorState = EditorStateData &
  JobSliceActions &
  PlaybackSliceActions &
  ClipsSliceActions &
  PillsSliceActions &
  CutsSliceActions &
  QuantizeSliceActions &
  FxSliceActions &
  GradeSliceActions &
  OutputSliceActions &
  UiSliceActions;

/** StateCreator alias for one slice of the editor store under the
 *  subscribeWithSelector middleware. */
export type SliceCreator<T> = StateCreator<
  EditorState,
  [["zustand/subscribeWithSelector", never]],
  [],
  T
>;
