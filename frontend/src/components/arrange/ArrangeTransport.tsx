/**
 * Bottom transport bar for the Arrange page.
 *
 * Two zones inside one bar:
 *   - LEFT: transport controls (prev/play/next, cursor nav, counter)
 *   - RIGHT: focused-frame inspector (when a frame is focused) —
 *     SOURCE / BARS / LENGTH metadata + ◀ shift / shift ▶ /
 *     duplicate / drop buttons. Lives here instead of in a
 *     side-panel so the strip + contact sheet get the full width.
 *
 * The right edge has a chunky padding so the floating Footer overlay
 * (Impressum · Datenschutz, fixed bottom-right) doesn't sit on top of
 * any actionable buttons.
 */
import { useEffect, useMemo } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useRegisterShortcut } from "../../editor/shortcuts/useRegisterShortcut";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
} from "../../editor/components/icons";
import {
  effectiveBarsForChunk,
  useArrangeStore,
} from "../../local/arrange/arrange-store";

interface ArrangeTransportProps {
  /** When true, show ◀cur cur▶ buttons (mobile-only). Hidden on
   *  desktop because there the user clicks the cursor directly. */
  showCursorControls?: boolean;
}

export function ArrangeTransport({
  showCursorControls = false,
}: ArrangeTransportProps) {
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const setPlaying = useArrangeStore((s) => s.setPlaying);
  const arrangement = useArrangeStore((s) => s.arrangement);
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const focusRelative = useArrangeStore((s) => s.focusRelative);
  const removeItem = useArrangeStore((s) => s.removeItem);
  const shiftItem = useArrangeStore((s) => s.shiftItem);
  const duplicateItem = useArrangeStore((s) => s.duplicateItem);
  const insertionIndex = useArrangeStore((s) => s.insertionIndex);
  const nudgeCursor = useArrangeStore((s) => s.nudgeCursor);
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
  const seek = useArrangeStore((s) => s.seek);
  const chunks = useArrangeStore((s) => s.chunks);

  // Shortcut registration so HelpOverlay surfaces them.
  useRegisterShortcut({
    id: "arrange.playpause",
    keys: ["Space"],
    description: "Play / pause",
    group: "Transport",
  });
  useRegisterShortcut({
    id: "arrange.prev-item",
    keys: ["⇧←"],
    description: "Focus previous frame",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.next-item",
    keys: ["⇧→"],
    description: "Focus next frame",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.cursor-prev",
    keys: ["←"],
    description: "Move insertion cursor left",
    group: "Arrange",
  });
  useRegisterShortcut({
    id: "arrange.cursor-next",
    keys: ["→"],
    description: "Move insertion cursor right",
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
    keys: ["⌘D"],
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
    function handler(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useArrangeStore.getState().playback.isPlaying);
      } else if (e.shiftKey && e.code === "ArrowLeft") {
        e.preventDefault();
        focusRelative(-1);
        const next = useArrangeStore.getState().focusedItemId;
        if (next) {
          const item = useArrangeStore
            .getState()
            .arrangement.find((a) => a.id === next);
          const ck = item
            ? useArrangeStore
                .getState()
                .chunks.find((c) => c.id === item.chunkId)
            : null;
          if (ck) seek(ck.startMs / 1000);
        }
      } else if (e.shiftKey && e.code === "ArrowRight") {
        e.preventDefault();
        focusRelative(1);
        const next = useArrangeStore.getState().focusedItemId;
        if (next) {
          const item = useArrangeStore
            .getState()
            .arrangement.find((a) => a.id === next);
          const ck = item
            ? useArrangeStore
                .getState()
                .chunks.find((c) => c.id === item.chunkId)
            : null;
          if (ck) seek(ck.startMs / 1000);
        }
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        nudgeCursor(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        nudgeCursor(+1);
      } else if (e.code === "Backspace") {
        const id = useArrangeStore.getState().focusedItemId;
        if (id) {
          e.preventDefault();
          removeItem(id);
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.code === "KeyD" || e.key === "d")) {
        const id = useArrangeStore.getState().focusedItemId;
        if (id) {
          e.preventDefault();
          duplicateItem(id);
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setPlaying, focusRelative, nudgeCursor, removeItem, duplicateItem, seek]);

  const onPrevItem = () => {
    focusRelative(-1);
    const next = useArrangeStore.getState().focusedItemId;
    if (next) {
      const item = arrangement.find((a) => a.id === next);
      const ck = item ? chunks.find((c) => c.id === item.chunkId) : null;
      if (ck) seek(ck.startMs / 1000);
    }
  };
  const onNextItem = () => {
    focusRelative(1);
    const next = useArrangeStore.getState().focusedItemId;
    if (next) {
      const item = arrangement.find((a) => a.id === next);
      const ck = item ? chunks.find((c) => c.id === item.chunkId) : null;
      if (ck) seek(ck.startMs / 1000);
    }
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

      {showCursorControls && (
        <>
          <span className="w-px h-6 bg-rule mx-1" aria-hidden />
          <ChunkyButton
            variant="ghost"
            size="sm"
            onClick={() => nudgeCursor(-1)}
            disabled={arrangement.length === 0 || insertionIndex === 0}
            title="Cursor left · ←"
            aria-label="Move insertion cursor left"
          >
            ◀ cur
          </ChunkyButton>
          <ChunkyButton
            variant="ghost"
            size="sm"
            onClick={() => nudgeCursor(+1)}
            disabled={
              arrangement.length === 0 ||
              insertionIndex === arrangement.length
            }
            title="Cursor right · →"
            aria-label="Move insertion cursor right"
          >
            cur ▶
          </ChunkyButton>
        </>
      )}

      {/* Inspector — only when a frame is focused. Sits LEFT-of-spacer
       *  so the floating Impressum/Datenschutz overlay (fixed bottom-
       *  right) doesn't cover any actionable buttons. */}
      {focusedItem && focusedChunk && (
        <div className="flex items-stretch gap-2 min-w-0">
          <span className="w-px h-9 bg-rule mx-1" aria-hidden />
          <div className="flex flex-col justify-center font-mono text-[10px] tabular text-ink-2 leading-tight min-w-0">
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
            title="Shift left · Shift+←"
            aria-label="Shift frame left"
          >
            ◀
          </ChunkyButton>
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => shiftItem(focusedItem.id, +1)}
            disabled={focusedIdx === arrangement.length - 1 || focusedIdx === -1}
            title="Shift right · Shift+→"
            aria-label="Shift frame right"
          >
            ▶
          </ChunkyButton>
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => duplicateItem(focusedItem.id)}
            title="Duplicate frame · Cmd/Ctrl+D"
          >
            <span className="hidden sm:inline">Dup</span>
            <span className="inline sm:hidden">×2</span>
          </ChunkyButton>
          <ChunkyButton
            variant="secondary"
            size="sm"
            onClick={() => removeItem(focusedItem.id)}
            title="Drop frame · Backspace"
          >
            Drop
          </ChunkyButton>
        </div>
      )}

      <div className="flex-1" />

      {/* Footer-clearance reserve — keeps Impressum/Datenschutz from
       *  sitting on top of any actionable content. */}
      <span className="w-[210px] shrink-0" aria-hidden />
    </div>
  );
}
