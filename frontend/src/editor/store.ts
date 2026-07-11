/**
 * Editor state. zustand because:
 *  - currentTime updates at ~60Hz; we don't want a useReducer/Context to
 *    re-render the whole tree on every tick. Selectors keep the timeline
 *    and transport bar isolated from panel re-renders.
 *  - Slices are kept logically grouped for extensibility — future
 *    tracks/clips slot in without restructuring.
 *
 * The store is assembled from domain slices in `./store/` (#121): each
 * slice owns one cohesive domain (state fields + actions + its pure
 * helpers) and exports an initial-data factory. The composed state is
 * FLAT and identical to the pre-split store, and this module remains
 * the single public entry point — consumers keep importing
 * `useEditorStore` (and the shared types) from here.
 *
 * `reset()` spreads `initialEditorState()` — the same composition used
 * below — so the create/reset initial-data lists can no longer drift
 * apart (a field forgotten in reset() used to leak state from the
 * previous job into the next).
 */
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { EditorState } from "./store/state";
import { createJobSlice, initialEditorState } from "./store/job-slice";
import { createPlaybackSlice } from "./store/playback-slice";
import { createClipsSlice } from "./store/clips-slice";
import { createPillsSlice } from "./store/pills-slice";
import { createCutsSlice } from "./store/cuts-slice";
import { createQuantizeSlice } from "./store/quantize-slice";
import { createFxSlice } from "./store/fx-slice";
import { createGradeSlice } from "./store/grade-slice";
import { createOutputSlice } from "./store/output-slice";
import { createUiSlice } from "./store/ui-slice";

export type {
  BpmInfo,
  JobMeta,
  OffsetSlice,
  TrimRegion,
} from "./store/job-slice";
export type { PlaybackSlice } from "./store/playback-slice";
export type { PanelTab, UiSlice } from "./store/ui-slice";
export type { FxHoldEntry } from "./store/fx-slice";
export type {
  ClipInit,
  ImageClipInit,
  VideoClipInit,
} from "./store/clips-slice";

export const useEditorStore = create<EditorState>()(
  subscribeWithSelector((...a) => ({
    ...initialEditorState(),
    ...createJobSlice(...a),
    ...createPlaybackSlice(...a),
    ...createClipsSlice(...a),
    ...createPillsSlice(...a),
    ...createCutsSlice(...a),
    ...createQuantizeSlice(...a),
    ...createFxSlice(...a),
    ...createGradeSlice(...a),
    ...createOutputSlice(...a),
    ...createUiSlice(...a),
  })),
);
