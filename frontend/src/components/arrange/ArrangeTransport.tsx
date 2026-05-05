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
import { useEffect, useMemo } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useRegisterShortcut } from "../../editor/shortcuts/useRegisterShortcut";
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

export function ArrangeTransport() {
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const focusRelative = useArrangeStore((s) => s.focusRelative);
  const removeItem = useArrangeStore((s) => s.removeItem);
  const shiftItem = useArrangeStore((s) => s.shiftItem);
  const duplicateItem = useArrangeStore((s) => s.duplicateItem);
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

  // Shortcut registration so HelpOverlay surfaces them.
  useRegisterShortcut({
    id: "arrange.playpause",
    keys: ["Space"],
    description: "Play / pause",
    group: "Transport",
  });
  useRegisterShortcut({
    id: "arrange.prev-item",
    keys: ["←"],
    description: "Focus previous frame",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.next-item",
    keys: ["→"],
    description: "Focus next frame",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.shift-left",
    keys: ["⇧←"],
    description: "Move focused frame left",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.shift-right",
    keys: ["⇧→"],
    description: "Move focused frame right",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.remove",
    keys: ["Backspace"],
    description: "Drop focused frame",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.duplicate",
    keys: ["D"],
    description: "Duplicate focused frame",
    group: "Arrange",
  });

  // Keyboard handler.
  useEffect(() => {
    function isTextInput(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t.isContentEditable
      );
    }
    function focusAndSeek(delta: -1 | 1) {
      focusRelative(delta);
      const next = useArrangeStore.getState().focusedItemId;
      if (next) useArrangeStore.getState().seekToItem(next);
    }

    function handler(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useArrangeStore.getState().playback.isPlaying);
      } else if (e.shiftKey && e.code === "ArrowLeft") {
        // Move focused frame one position to the left.
        e.preventDefault();
        const id = useArrangeStore.getState().focusedItemId;
        if (id) shiftItem(id, -1);
      } else if (e.shiftKey && e.code === "ArrowRight") {
        e.preventDefault();
        const id = useArrangeStore.getState().focusedItemId;
        if (id) shiftItem(id, +1);
      } else if (e.code === "ArrowLeft") {
        // Bare left = walk focus to the previous frame and seek.
        e.preventDefault();
        focusAndSeek(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        focusAndSeek(+1);
      } else if (e.code === "Backspace") {
        const id = useArrangeStore.getState().focusedItemId;
        if (id) {
          e.preventDefault();
          removeItem(id);
        }
      } else if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.code === "KeyD" || e.key === "d" || e.key === "D")
      ) {
        // Plain "D" — no modifiers. Stays out of the way of browser
        // shortcuts (Cmd+D = bookmark) and doesn't fight the user when
        // they're just typing a letter (focus would be in a text input
        // and isTextInput() filters above already).
        const id = useArrangeStore.getState().focusedItemId;
        if (id) {
          e.preventDefault();
          duplicateItem(id);
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setPlaying, focusRelative, shiftItem, removeItem, duplicateItem]);

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
            onClick={() => duplicateItem(focusedItem.id)}
            title="Duplicate frame · D"
            aria-label="Duplicate frame"
            iconLeft={<CopyIcon className="w-4 h-4" />}
          />
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => removeItem(focusedItem.id)}
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
