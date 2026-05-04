/**
 * Arrange-Editor State.
 *
 * Lives in its own store (mirroring `triage-store`) — Arrange has a
 * different mental model: a sequence of `ArrangementItem`s pointing at
 * `Chunk`s, with a "where will the next inserted item land" cursor.
 *
 * Defaults are non-destructive: if a job arrives at Arrange already
 * carrying an arrangement (the Triage handoff seeds this), the user
 * doesn't have to touch anything to graduate to the editor.
 */
import { create } from "zustand";
import type {
  ArrangementItem,
  Chunk,
  VideoAsset,
} from "../../storage/jobs-db";

export interface ArrangePlayback {
  /** Master-audio time (seconds). The arrangement playback walks
   *  through the chunks' master-time ranges in sequence — currentTime
   *  is what the audio master is *currently* playing. */
  currentTime: number;
  isPlaying: boolean;
  /** ID of the ArrangementItem the playhead is inside (or about to
   *  enter on the next item-hop). Null when no item is current. */
  currentItemId: string | null;
}

export interface ArrangeView {
  /** Horizontal scroll offset on the film strip (pixels from left).
   *  Lives in store so the playhead-following logic can keep the
   *  strip auto-scrolled without prop-drilling refs. */
  stripScrollPx: number;
  /** Last measured strip-viewport width in px. Updated by the
   *  FilmStrip on resize. Used to decide whether to show the mini-map. */
  stripViewportWidthPx: number;
  /** Last measured strip content width (sum of frame widths). Drives
   *  mini-map enablement when contentWidth > viewportWidth. */
  stripContentWidthPx: number;
}

/**
 * State for an in-flight drag of a chunk from the Contact Sheet onto
 * the Film Strip. Lives in the store so the Polaroid (drag origin),
 * the floating drag-ghost, the FilmStrip (drop target highlighting),
 * and the global pointer-event controller can all stay in sync without
 * prop-drilling refs.
 *
 * `dropTargetIndex`:
 *   - non-null when the pointer is over a valid drop position on the
 *     strip (between or at either end of the existing frames). The
 *     FilmStrip highlights the corresponding InsertionCursor.
 *   - null when the pointer is outside the strip's drop zone — the
 *     ghost still follows the cursor but releasing here cancels.
 */
export interface ArrangeDrag {
  chunkId: string;
  /** Optional thumbnail URL for the floating ghost. Falls back to a
   *  cam-color tile if missing. */
  thumbUrl: string | null;
  /** Cam-color hint for the empty-thumb fallback. */
  camColor: string;
  /** Live cursor position in viewport pixels — updated on every
   *  pointermove. Used to position the ghost. */
  cursorX: number;
  cursorY: number;
  dropTargetIndex: number | null;
}

export interface ArrangeState {
  // ─── Inputs ───────────────────────────────────────────────────────────
  jobId: string | null;
  /** Length of the master audio in seconds (used by cam-preview offset
   *  math + bounds checks). */
  audioDuration: number;
  /** All accepted (and rejected, but those are filtered at display time)
   *  chunks from triage. The pool the user picks from. */
  chunks: Chunk[];
  /** The mix — order matters; same chunkId may appear multiple times. */
  arrangement: ArrangementItem[];
  /** Cams available for preview. The user picks one to "watch" while
   *  the arrangement plays back. */
  cams: VideoAsset[];
  /** Song-global BPM (mirrors `job.bpm.value`). Drives the bar-grid
   *  math for frame widths. Null = no BPM detected/set; we fall back
   *  to a duration-based heuristic for sizing. */
  jobBpm: number | null;
  /** Song-global beats-per-bar numerator. Default 4 (4/4 time). */
  jobBeatsPerBar: number;

  // ─── UI state ─────────────────────────────────────────────────────────
  /** ArrangementItem.id of the focused frame (one click). Null = nothing
   *  selected. */
  focusedItemId: string | null;
  /** Where the next inserted item lands in `arrangement` (0..length).
   *  Default = end of arrangement. Click between two frames to move. */
  insertionIndex: number;
  /** ID of the cam the preview shows + audio is synced against. Null
   *  defaults to the first cam if any. */
  selectedCamId: string | null;

  playback: ArrangePlayback;
  view: ArrangeView;
  /** In-flight drag of a chunk from the Contact Sheet onto the Strip.
   *  Null when not dragging. */
  drag: ArrangeDrag | null;

  // ─── Actions ──────────────────────────────────────────────────────────
  initFromJob(args: {
    jobId: string;
    audioDuration: number;
    chunks: Chunk[];
    arrangement: ArrangementItem[];
    cams: VideoAsset[];
    jobBpm: number | null;
    jobBeatsPerBar: number;
  }): void;
  reset(): void;

  // Cursor.
  setInsertionIndex(idx: number): void;
  nudgeCursor(delta: number): void;

  // Mutations.
  insertChunkAtCursor(chunkId: string): void;
  removeItem(itemId: string): void;
  shiftItem(itemId: string, delta: number): void;
  reorderItem(itemId: string, targetIndex: number): void;
  duplicateItem(itemId: string): void;

  // Focus.
  focusItem(itemId: string | null): void;
  focusRelative(delta: -1 | 1): void;

  // Cam.
  setSelectedCamId(camId: string | null): void;
  nudgeCamSyncOverride(camId: string, deltaMs: number): void;

  // Playback.
  setPlaying(p: boolean): void;
  seek(t: number): void;
  tickTime(t: number): void;
  setCurrentItemId(id: string | null): void;

  // View.
  setStripScrollPx(px: number): void;
  setStripMetrics(viewportWidthPx: number, contentWidthPx: number): void;

  // Chunk-drag (Polaroid → FilmStrip).
  beginChunkDrag(args: {
    chunkId: string;
    thumbUrl: string | null;
    camColor: string;
    cursorX: number;
    cursorY: number;
  }): void;
  updateChunkDrag(args: {
    cursorX: number;
    cursorY: number;
    dropTargetIndex: number | null;
  }): void;
  /** Commit if `dropTargetIndex` is non-null and there's a drag in
   *  flight; otherwise no-op. Always clears the drag state. Returns
   *  true on a successful drop. */
  commitChunkDrag(): boolean;
  cancelChunkDrag(): void;

  // Derived helpers.
  totalDurationMs(): number;
  usageCounts(): Record<string, number>;
}

const INITIAL_PLAYBACK: ArrangePlayback = {
  currentTime: 0,
  isPlaying: false,
  currentItemId: null,
};

const INITIAL_VIEW: ArrangeView = {
  stripScrollPx: 0,
  stripViewportWidthPx: 0,
  stripContentWidthPx: 0,
};

let arrangementCounter = 0;
function freshArrId(chunkId: string): string {
  arrangementCounter += 1;
  return `arr-${chunkId}-${Date.now()}-${arrangementCounter}`;
}

function clampIdx(idx: number, max: number): number {
  if (!Number.isFinite(idx)) return 0;
  return Math.max(0, Math.min(max, Math.round(idx)));
}

export const useArrangeStore = create<ArrangeState>((set, get) => ({
  jobId: null,
  audioDuration: 0,
  chunks: [],
  arrangement: [],
  cams: [],
  jobBpm: null,
  jobBeatsPerBar: 4,

  focusedItemId: null,
  insertionIndex: 0,
  selectedCamId: null,
  playback: INITIAL_PLAYBACK,
  view: INITIAL_VIEW,
  drag: null,

  initFromJob(args) {
    set({
      jobId: args.jobId,
      audioDuration: args.audioDuration,
      chunks: args.chunks,
      arrangement: args.arrangement,
      cams: args.cams,
      jobBpm: args.jobBpm,
      jobBeatsPerBar: args.jobBeatsPerBar,
      focusedItemId: null,
      insertionIndex: args.arrangement.length,
      selectedCamId: args.cams[0]?.id ?? null,
      playback: INITIAL_PLAYBACK,
      view: INITIAL_VIEW,
      drag: null,
    });
  },

  reset() {
    set({
      jobId: null,
      audioDuration: 0,
      chunks: [],
      arrangement: [],
      cams: [],
      jobBpm: null,
      jobBeatsPerBar: 4,
      focusedItemId: null,
      insertionIndex: 0,
      selectedCamId: null,
      playback: INITIAL_PLAYBACK,
      view: INITIAL_VIEW,
      drag: null,
    });
  },

  setInsertionIndex(idx) {
    const max = get().arrangement.length;
    set({ insertionIndex: clampIdx(idx, max) });
  },

  nudgeCursor(delta) {
    const s = get();
    set({
      insertionIndex: clampIdx(s.insertionIndex + delta, s.arrangement.length),
    });
  },

  insertChunkAtCursor(chunkId) {
    const s = get();
    if (!s.chunks.some((c) => c.id === chunkId)) return;
    const idx = clampIdx(s.insertionIndex, s.arrangement.length);
    const item: ArrangementItem = { id: freshArrId(chunkId), chunkId };
    const next = [...s.arrangement];
    next.splice(idx, 0, item);
    set({ arrangement: next, insertionIndex: idx + 1 });
  },

  removeItem(itemId) {
    const s = get();
    const idx = s.arrangement.findIndex((a) => a.id === itemId);
    if (idx === -1) return;
    const next = s.arrangement.filter((a) => a.id !== itemId);
    const focused = s.focusedItemId === itemId ? null : s.focusedItemId;
    const cursor = clampIdx(
      s.insertionIndex > idx ? s.insertionIndex - 1 : s.insertionIndex,
      next.length,
    );
    set({ arrangement: next, focusedItemId: focused, insertionIndex: cursor });
  },

  shiftItem(itemId, delta) {
    const s = get();
    const idx = s.arrangement.findIndex((a) => a.id === itemId);
    if (idx === -1) return;
    const target = clampIdx(idx + delta, s.arrangement.length - 1);
    if (target === idx) return;
    const next = [...s.arrangement];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    set({ arrangement: next });
  },

  reorderItem(itemId, targetIndex) {
    const s = get();
    const idx = s.arrangement.findIndex((a) => a.id === itemId);
    if (idx === -1) return;
    const dest = clampIdx(targetIndex, s.arrangement.length - 1);
    if (dest === idx) return;
    const next = [...s.arrangement];
    const [moved] = next.splice(idx, 1);
    next.splice(dest, 0, moved);
    set({ arrangement: next });
  },

  duplicateItem(itemId) {
    const s = get();
    const idx = s.arrangement.findIndex((a) => a.id === itemId);
    if (idx === -1) return;
    const source = s.arrangement[idx];
    const copy: ArrangementItem = {
      id: freshArrId(source.chunkId),
      chunkId: source.chunkId,
    };
    const next = [...s.arrangement];
    next.splice(idx + 1, 0, copy);
    set({ arrangement: next });
  },

  focusItem(itemId) {
    set({ focusedItemId: itemId });
  },

  focusRelative(delta) {
    const s = get();
    if (s.arrangement.length === 0) return;
    const currentIdx = s.focusedItemId
      ? s.arrangement.findIndex((a) => a.id === s.focusedItemId)
      : -1;
    const next = clampIdx(currentIdx + delta, s.arrangement.length - 1);
    if (next === currentIdx) return;
    set({ focusedItemId: s.arrangement[next].id });
  },

  setSelectedCamId(camId) {
    set({ selectedCamId: camId });
  },

  nudgeCamSyncOverride(camId, deltaMs) {
    set((s) => ({
      cams: s.cams.map((c) =>
        c.id === camId
          ? { ...c, syncOverrideMs: (c.syncOverrideMs ?? 0) + deltaMs }
          : c,
      ),
    }));
  },

  setPlaying(p) {
    set((s) => ({ playback: { ...s.playback, isPlaying: p } }));
  },

  seek(t) {
    set((s) => ({
      playback: {
        ...s.playback,
        currentTime: Math.max(0, Math.min(s.audioDuration, t)),
      },
    }));
  },

  tickTime(t) {
    set((s) => ({ playback: { ...s.playback, currentTime: t } }));
  },

  setCurrentItemId(id) {
    set((s) => ({ playback: { ...s.playback, currentItemId: id } }));
  },

  setStripScrollPx(px) {
    set((s) => ({ view: { ...s.view, stripScrollPx: Math.max(0, px) } }));
  },

  setStripMetrics(viewportWidthPx, contentWidthPx) {
    set((s) => ({
      view: {
        ...s.view,
        stripViewportWidthPx: viewportWidthPx,
        stripContentWidthPx: contentWidthPx,
      },
    }));
  },

  beginChunkDrag(args) {
    set({
      drag: {
        chunkId: args.chunkId,
        thumbUrl: args.thumbUrl,
        camColor: args.camColor,
        cursorX: args.cursorX,
        cursorY: args.cursorY,
        dropTargetIndex: null,
      },
    });
  },

  updateChunkDrag(args) {
    set((s) => {
      if (!s.drag) return {};
      return {
        drag: {
          ...s.drag,
          cursorX: args.cursorX,
          cursorY: args.cursorY,
          dropTargetIndex: args.dropTargetIndex,
        },
      };
    });
  },

  commitChunkDrag() {
    const s = get();
    if (!s.drag || s.drag.dropTargetIndex === null) {
      set({ drag: null });
      return false;
    }
    const { chunkId, dropTargetIndex } = s.drag;
    if (!s.chunks.some((c) => c.id === chunkId)) {
      set({ drag: null });
      return false;
    }
    const idx = clampIdx(dropTargetIndex, s.arrangement.length);
    const item: ArrangementItem = { id: freshArrId(chunkId), chunkId };
    const next = [...s.arrangement];
    next.splice(idx, 0, item);
    set({
      arrangement: next,
      insertionIndex: idx + 1,
      drag: null,
    });
    return true;
  },

  cancelChunkDrag() {
    set({ drag: null });
  },

  totalDurationMs() {
    const s = get();
    const lookup = new Map(s.chunks.map((c) => [c.id, c.endMs - c.startMs]));
    let total = 0;
    for (const item of s.arrangement) {
      total += lookup.get(item.chunkId) ?? 0;
    }
    return total;
  },

  usageCounts() {
    const s = get();
    const counts: Record<string, number> = {};
    for (const item of s.arrangement) {
      counts[item.chunkId] = (counts[item.chunkId] ?? 0) + 1;
    }
    return counts;
  },
}));

/** Map a chunk's bar count to a frame width (CSS pixels). Sublinear
 *  scaling so a 64-bar monster doesn't dominate a 4-bar one-shot —
 *  uses sqrt to compress the high end while still giving real visual
 *  feedback for length differences in the 1-16 bar range. */
export const FRAME_MIN_PX = 64;
export const FRAME_MAX_PX = 200;

export function frameWidthForBars(bars: number): number {
  if (!Number.isFinite(bars) || bars <= 0) return FRAME_MIN_PX;
  // sqrt(bars) maps:
  //   1 → 1.00, 4 → 2.00, 8 → 2.83, 16 → 4.00, 32 → 5.66, 64 → 8.00
  // We want bar=1 → MIN, bar=16 → MAX. Scale factor = (MAX-MIN)/(sqrt(16)-sqrt(1))=(MAX-MIN)/3.
  const scale = (FRAME_MAX_PX - FRAME_MIN_PX) / (Math.sqrt(16) - 1);
  const w = FRAME_MIN_PX + (Math.sqrt(bars) - 1) * scale;
  return Math.max(FRAME_MIN_PX, Math.min(FRAME_MAX_PX, Math.round(w)));
}

/** Compute the effective bar count for a chunk under the new
 *  song-global tempo model. BPM is `job.bpm.value`; per-chunk BPM is
 *  storage-only legacy and intentionally NOT consulted here. Falls back
 *  to a duration-based heuristic when no BPM is set so frames still
 *  scale proportionally. */
export function effectiveBarsForChunk(
  chunk: Chunk,
  jobBpm: number | null,
  jobBeatsPerBar: number = 4,
): number {
  const seconds = (chunk.endMs - chunk.startMs) / 1000;
  if (!jobBpm || jobBpm <= 0) {
    // No BPM yet — assume "1 bar ≈ 2 seconds" so longer chunks still
    // size up. The user can fix the BPM in Triage / Editor and the
    // strip re-renders.
    return Math.max(1, seconds / 2);
  }
  const sPerBar = (60 / jobBpm) * (jobBeatsPerBar || 4);
  return Math.max(0.25, seconds / sPerBar);
}
