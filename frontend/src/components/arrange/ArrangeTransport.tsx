/**
 * Bottom transport bar for the Arrange page.
 *
 * LEFT: transport (prev / play / next).
 * RIGHT (only when a frame is focused): metadata + a single mutation
 * cluster — SHIFT◀ surrounds Dup/Drop on the left, SHIFT▶ on the right.
 * The two SHIFT buttons reorder the selected item in the arrangement
 * and re-center the strip on it.
 *
 * The right edge has a chunky padding so the floating Footer overlay
 * (Impressum · Datenschutz, fixed bottom-right) doesn't sit on top of
 * any actionable buttons.
 */
import { useMemo } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useGlobalShortcut } from "../../editor/shortcuts/keymap";
import {
  CopyIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
  StepBackIcon,
  StepFwdIcon,
  TrashIcon,
} from "../../editor/components/icons";
import {
  effectiveBarsForChunk,
  useArrangeStore,
} from "../../local/arrange/arrange-store";
import {
  duplicateItemWithEdits,
  removeItemGuarded,
} from "../../local/arrange/arrange-guarded-actions";

export function ArrangeTransport() {
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const focusRelative = useArrangeStore((s) => s.focusRelative);
  const shiftItem = useArrangeStore((s) => s.shiftItem);
  const chunkPool = useArrangeStore((s) => s.chunks);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const jobBeatsPerBar = useArrangeStore((s) => s.jobBeatsPerBar);

  // Focused-frame derivations (read inline; cheap, only fires on
  // store changes that matter).
  const focusedItem = focusedItemId
    ? arrangement.find((a) => a.id === focusedItemId) ?? null
    : null;
  const focusedChunk =
    focusedItem != null
      ? chunkPool.find((c) => c.id === focusedItem.chunkId) ?? null
      : null;
  const focusedIdx = focusedItem
    ? arrangement.findIndex((a) => a.id === focusedItem.id)
    : -1;
  const focusedBars = useMemo(
    () => (focusedChunk ? effectiveBarsForChunk(focusedChunk, jobBpm, jobBeatsPerBar) : 0),
    [focusedChunk, jobBpm, jobBeatsPerBar],
  );

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  // Declared through the central keymap: guards (typing target, exact
  // modifiers — Cmd+D bookmark, Cmd+Backspace etc. never reach these —
  // repeat, modal scope) live in the dispatcher, and each binding
  // registers its cheat-sheet entry from the same declaration.
  function focusAndSeek(delta: -1 | 1) {
    focusRelative(delta);
    const next = useArrangeStore.getState().focusedItemId;
    if (next) useArrangeStore.getState().seekToItem(next);
  }

  useGlobalShortcut({
    id: "arrange.playpause",
    codes: ["Space"],
    onDown: () => setPlaying(!useArrangeStore.getState().playback.isPlaying),
    help: { keys: ["Space"], description: "Play / pause", group: "Transport" },
  });
  useGlobalShortcut({
    id: "arrange.prev-item",
    codes: ["ArrowLeft"],
    allowRepeat: true,
    onDown: () => focusAndSeek(-1),
    help: { keys: ["←"], description: "Focus previous frame", group: "Arrange" },
  });
  useGlobalShortcut({
    id: "arrange.next-item",
    codes: ["ArrowRight"],
    allowRepeat: true,
    onDown: () => focusAndSeek(+1),
    help: { keys: ["→"], description: "Focus next frame", group: "Arrange" },
  });
  useGlobalShortcut({
    id: "arrange.shift-left",
    codes: ["ArrowLeft"],
    modifiers: ["shift"],
    onDown: () => {
      const id = useArrangeStore.getState().focusedItemId;
      if (id) shiftItem(id, -1);
    },
    help: {
      keys: ["⇧←"],
      description: "Move focused frame left",
      group: "Arrange",
    },
  });
  useGlobalShortcut({
    id: "arrange.shift-right",
    codes: ["ArrowRight"],
    modifiers: ["shift"],
    onDown: () => {
      const id = useArrangeStore.getState().focusedItemId;
      if (id) shiftItem(id, +1);
    },
    help: {
      keys: ["⇧→"],
      description: "Move focused frame right",
      group: "Arrange",
    },
  });
  useGlobalShortcut({
    id: "arrange.remove",
    codes: ["Backspace"],
    preventDefault: false, // only consume the key when a frame is focused
    onDown: (e) => {
      const id = useArrangeStore.getState().focusedItemId;
      if (id) {
        e.preventDefault();
        void removeItemGuarded(id);
      }
    },
    help: {
      keys: ["Backspace"],
      description: "Drop focused frame",
      group: "Arrange",
    },
  });
  useGlobalShortcut({
    id: "arrange.duplicate",
    // Physical D on any layout, plus produced-character fallback for
    // exotic layouts; CapsLock "D" arrives without Shift and matches.
    codes: ["KeyD"],
    keys: ["d", "D"],
    preventDefault: false,
    onDown: (e) => {
      const id = useArrangeStore.getState().focusedItemId;
      if (id) {
        e.preventDefault();
        void duplicateItemWithEdits(id);
      }
    },
    help: {
      keys: ["D"],
      description: "Duplicate focused frame",
      group: "Arrange",
    },
  });

  const seekToItem = useArrangeStore((s) => s.seekToItem);
  const onPrevItem = () => {
    focusRelative(-1);
    const next = useArrangeStore.getState().focusedItemId;
    if (next) seekToItem(next);
  };
  const onNextItem = () => {
    focusRelative(1);
    const next = useArrangeStore.getState().focusedItemId;
    if (next) seekToItem(next);
  };

  // Footer overlay (Impressum · Datenschutz, fixed bottom-right) eats
  // ~220 px of the right edge. Inspector + transport controls cluster
  // on the LEFT; flex-1 absorbs the rest so nothing actionable sits
  // under the footer.
  return (
    <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-2 bg-paper-hi border-t border-rule">
      <ChunkyButton
        variant="secondary"
        size="sm"
        onClick={onPrevItem}
        disabled={arrangement.length === 0}
        title="Previous frame · Shift+←"
        iconLeft={<SkipBackIcon className="w-4 h-4" />}
      >
        <span className="hidden sm:inline">Prev</span>
      </ChunkyButton>

      <ChunkyButton
        variant="primary"
        size="md"
        onClick={() => setPlaying(!isPlaying)}
        disabled={arrangement.length === 0}
        title={isPlaying ? "Pause · Space" : "Play · Space"}
        iconLeft={
          isPlaying ? (
            <PauseIcon className="w-4 h-4" />
          ) : (
            <PlayIcon className="w-4 h-4" />
          )
        }
      >
        <span className="hidden sm:inline">{isPlaying ? "Pause" : "Play"}</span>
      </ChunkyButton>

      <ChunkyButton
        variant="secondary"
        size="sm"
        onClick={onNextItem}
        disabled={arrangement.length === 0}
        title="Next frame · Shift+→"
        iconRight={<SkipFwdIcon className="w-4 h-4" />}
      >
        <span className="hidden sm:inline">Next</span>
      </ChunkyButton>

      {/* Inspector — only when a frame is focused. Four standard
       *  ChunkyButtons in one row with hairline dividers between
       *  the move-pair (SHIFT◀ / SHIFT▶) and the edit-pair (Dup / Drop)
       *  so the function-grouping reads at a glance without needing
       *  a separate plate. Tooltips carry the shortcut hints. */}
      {focusedItem && focusedChunk && (
        <div className="flex items-stretch gap-1.5 min-w-0">
          <span className="w-px h-9 bg-rule mx-1" aria-hidden />
          <div className="flex flex-col justify-center font-mono text-[10px] tabular text-ink-2 leading-tight min-w-0 mr-1">
            <span className="font-display tracking-label uppercase text-[9px] text-ink-3">
              FRAME {focusedIdx + 1}/{arrangement.length}
            </span>
            <span className="truncate">
              {focusedBars.toFixed(focusedBars >= 10 ? 0 : 1)}br ·{" "}
              {((focusedChunk.endMs - focusedChunk.startMs) / 1000).toFixed(1)}s
            </span>
          </div>
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => shiftItem(focusedItem.id, -1)}
            disabled={focusedIdx <= 0}
            title="Move frame left · Shift+←"
            aria-label="Move frame left"
            iconLeft={<StepBackIcon className="w-4 h-4" />}
          />
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => shiftItem(focusedItem.id, +1)}
            disabled={
              focusedIdx === arrangement.length - 1 || focusedIdx === -1
            }
            title="Move frame right · Shift+→"
            aria-label="Move frame right"
            iconLeft={<StepFwdIcon className="w-4 h-4" />}
          />
          <span className="w-px h-7 bg-rule mx-0.5 self-center" aria-hidden />
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => void duplicateItemWithEdits(focusedItem.id)}
            title="Duplicate frame · D"
            aria-label="Duplicate frame"
            iconLeft={<CopyIcon className="w-4 h-4" />}
          />
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => void removeItemGuarded(focusedItem.id)}
            title="Drop frame · Backspace"
            aria-label="Drop frame"
            iconLeft={<TrashIcon className="w-4 h-4" />}
          />
        </div>
      )}

      <div className="flex-1" />

      {/* Footer-clearance reserve — keeps Impressum/Datenschutz from
       *  sitting on top of any actionable content. */}
      <span className="w-[210px] shrink-0" aria-hidden />
    </div>
  );
}
