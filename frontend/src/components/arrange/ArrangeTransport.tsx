/**
 * Bottom transport bar for the Arrange page.
 *
 * Play/Pause + cursor controls (◀ cursor ▶ on mobile, hidden on
 * desktop where the user clicks the cursor directly), prev/next item
 * jump, and counter readout.
 */
import { useEffect } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { useRegisterShortcut } from "../../editor/shortcuts/useRegisterShortcut";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
} from "../../editor/components/icons";
import { useArrangeStore } from "../../local/arrange/arrange-store";

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
  const insertionIndex = useArrangeStore((s) => s.insertionIndex);
  const nudgeCursor = useArrangeStore((s) => s.nudgeCursor);
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
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setPlaying, focusRelative, nudgeCursor, removeItem, seek]);

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

      <div className="flex-1" />

      <ChunkyButton
        variant="secondary"
        size="sm"
        onClick={() => focusedItemId && removeItem(focusedItemId)}
        disabled={!focusedItemId}
        title="Drop focused frame · Backspace"
      >
        Drop
      </ChunkyButton>

      <span className="font-mono text-[10px] tracking-label uppercase text-ink-3 tabular hidden md:inline-block">
        {arrangement.length} {arrangement.length === 1 ? "frame" : "frames"}
      </span>
    </div>
  );
}
