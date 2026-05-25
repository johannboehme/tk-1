/**
 * Triage transport bar — visually consistent with the editor's TransportBar
 * (ChunkyButton primary play, mono time readout) but trimmed to the
 * Triage workflow's actions: Play/Pause, prev/next chunk, accept/reject
 * focused chunk.
 *
 * Shortcuts (registered with the global registry so the HelpOverlay
 * picks them up):
 *   - Space            → Play / pause
 *   - Shift+←  Shift+→ → Previous / next chunk
 *   - Enter            → Keep focused chunk (auto-advance)
 *   - Backspace        → Drop focused chunk (auto-advance)
 */
import { useEffect } from "react";
import { ChunkyButton } from "../../editor/components/ChunkyButton";
import { TransportClockView } from "../../editor/components/TransportClockView";
import { useRegisterShortcut } from "../../editor/shortcuts/useRegisterShortcut";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
} from "../../editor/components/icons";
import { useTriageStore } from "../../local/triage/triage-store";
import { PlaybackModeSwitch } from "./PlaybackModeSwitch";
import {
  joinFocusedGuarded,
  rejectFocusedGuarded,
  splitFocusedGuarded,
} from "../../local/triage/triage-guarded-actions";

export function TriageTransportBar() {
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const setPlaying = useTriageStore((s) => s.setPlaying);
  const setMode = useTriageStore((s) => s.setMode);
  const openSeam = useTriageStore((s) => s.openSeam);
  const closeSeam = useTriageStore((s) => s.closeSeam);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const focusRelative = useTriageStore((s) => s.focusRelative);
  const acceptFocused = useTriageStore((s) => s.acceptFocused);
  const chunks = useTriageStore((s) => s.chunks);
  const audioDuration = useTriageStore((s) => s.audioDuration);
  // Don't subscribe to currentTime — it changes 60×/s. Pull imperatively
  // when needed (only the clock readout cares) and render that as a
  // separate component so updates stay scoped.
  const resetChunk = useTriageStore((s) => s.resetChunk);
  const conformChunk = useTriageStore((s) => s.conformChunk);
  const insertChunkAtPlayhead = useTriageStore((s) => s.insertChunkAtPlayhead);
  const acceptedCount = chunks.filter((c) => c.accepted).length;

  // ─── Shortcut registration + keydown handler ─────────────────────────
  useRegisterShortcut({
    id: "triage.playpause",
    keys: ["Space"],
    description: "Play / pause",
    group: "Transport",
  });
  useRegisterShortcut({
    id: "triage.prev-chunk",
    keys: ["⇧←"],
    description: "Focus previous chunk",
    group: "Triage",
  });
  useRegisterShortcut({
    id: "triage.next-chunk",
    keys: ["⇧→"],
    description: "Focus next chunk",
    group: "Triage",
  });
  useRegisterShortcut({
    id: "triage.accept",
    keys: ["Enter"],
    description: "Keep focused chunk (auto-advance)",
    group: "Triage",
  });
  useRegisterShortcut({
    id: "triage.reject",
    keys: ["Backspace"],
    description: "Drop focused chunk (auto-advance)",
    group: "Triage",
  });
  useRegisterShortcut({
    id: "triage.loop",
    keys: ["L"],
    description: "Cycle transport mode (Continue · Loop · Sequence)",
    group: "Transport",
  });
  useRegisterShortcut({
    id: "triage.split",
    keys: ["S"],
    description: "Split chunk at the playhead (or create one in empty space)",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.join-prev",
    keys: ["J"],
    description: "Merge focused chunk with previous",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.join-next",
    keys: ["⇧J"],
    description: "Merge focused chunk with next",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.new-chunk",
    keys: ["N"],
    description: "Insert a new chunk at the playhead (in silence)",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.conform",
    keys: ["C"],
    description: "Re-fit focused chunk's bar grid from its audio",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.reset-chunk",
    keys: ["R"],
    description: "Reset focused chunk to detection boundaries",
    group: "Triage · Edit",
  });
  useRegisterShortcut({
    id: "triage.seam",
    keys: ["T"],
    description: "Seam preview — audition the transition from the focused chunk",
    group: "Transport",
  });
  useRegisterShortcut({
    id: "triage.seam-close",
    keys: ["Esc"],
    description: "Close seam preview",
    group: "Transport",
  });

  useEffect(() => {
    function isTextInput(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      );
    }
    function handler(e: KeyboardEvent) {
      if (isTextInput(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useTriageStore.getState().playback.isPlaying);
      } else if (e.shiftKey && e.code === "ArrowLeft") {
        e.preventDefault();
        focusRelative(-1);
      } else if (e.shiftKey && e.code === "ArrowRight") {
        e.preventDefault();
        focusRelative(1);
      } else if (e.code === "Enter") {
        e.preventDefault();
        acceptFocused();
      } else if (e.code === "Backspace") {
        e.preventDefault();
        void rejectFocusedGuarded();
      } else if (e.code === "KeyL") {
        e.preventDefault();
        const cur = useTriageStore.getState().playback.mode;
        setMode(
          cur === "continue" ? "loop" : cur === "loop" ? "sequence" : "continue",
        );
      } else if (e.code === "KeyS" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const st = useTriageStore.getState();
        const tMs = Math.round(st.playback.currentTime * 1000);
        const focused = st.focusedChunkId
          ? st.chunks.find((c) => c.id === st.focusedChunkId)
          : null;
        const insideFocused =
          focused != null && tMs > focused.startMs + 50 && tMs < focused.endMs - 50;
        if (insideFocused) {
          void splitFocusedGuarded(tMs);
        } else if (!st.chunks.some((c) => tMs > c.startMs && tMs < c.endMs)) {
          // Empty space → create a new chunk here instead of splitting.
          insertChunkAtPlayhead();
        }
      } else if (e.code === "KeyJ" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const st = useTriageStore.getState();
        if (st.focusedChunkId) {
          void joinFocusedGuarded(e.shiftKey ? "next" : "prev");
        }
      } else if (e.code === "KeyN" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        insertChunkAtPlayhead();
      } else if (e.code === "KeyC" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const st = useTriageStore.getState();
        if (st.focusedChunkId) conformChunk(st.focusedChunkId);
      } else if (e.code === "KeyR" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const st = useTriageStore.getState();
        if (st.focusedChunkId) resetChunk(st.focusedChunkId);
      } else if (e.code === "KeyT" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const st = useTriageStore.getState();
        if (st.playback.seam) closeSeam();
        else if (st.focusedChunkId) openSeam(st.focusedChunkId);
      } else if (e.code === "Escape") {
        const st = useTriageStore.getState();
        if (st.playback.seam) {
          e.preventDefault();
          closeSeam();
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    setPlaying,
    focusRelative,
    acceptFocused,
    setMode,
    openSeam,
    closeSeam,
    conformChunk,
    insertChunkAtPlayhead,
    resetChunk,
  ]);

  return (
    <div
      className={[
        "grid items-center gap-3 px-3 py-2 bg-paper-hi border-t border-rule",
        // Equal-fraction side rails make the centered cluster
        // mathematically centered in the viewport regardless of how
        // wide the brass-plate clock or counter become. The right
        // rail also doubles as clearance for the floating Footer
        // overlay (impressum / datenschutz).
        "grid-cols-[1fr_auto_1fr]",
      ].join(" ")}
    >
      {/* Left rail — TE-style brass clock, reused from the editor.
       *  Subscribed via TriageClock so the rest of the bar doesn't
       *  re-render every RAF tick. */}
      <div className="justify-self-start">
        <TriageClock duration={audioDuration} />
      </div>

      {/* Centered transport cluster. Loop sits at the far right
       *  because it's the least-used control — keep it out of the
       *  hot-path between Play and Keep/Drop. */}
      <div className="flex justify-center items-center gap-2 sm:gap-3">
        <ChunkyButton
          variant="secondary"
          size="sm"
          onClick={() => focusRelative(-1)}
          disabled={chunks.length === 0}
          title="Previous chunk · Shift+←"
          aria-label="Previous chunk"
          iconLeft={<SkipBackIcon className="w-4 h-4" />}
        >
          <span className="hidden sm:inline">Prev</span>
        </ChunkyButton>

        <ChunkyButton
          variant="primary"
          size="md"
          onClick={() => setPlaying(!isPlaying)}
          title={isPlaying ? "Pause · Space" : "Play · Space"}
          aria-label={isPlaying ? "Pause" : "Play"}
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
          onClick={() => focusRelative(1)}
          disabled={chunks.length === 0}
          title="Next chunk · Shift+→"
          aria-label="Next chunk"
          iconRight={<SkipFwdIcon className="w-4 h-4" />}
        >
          <span className="hidden sm:inline">Next</span>
        </ChunkyButton>

        <span className="h-6 w-px bg-rule mx-1" aria-hidden />

        <ChunkyButton
          variant="secondary"
          size="sm"
          onClick={() => acceptFocused()}
          disabled={!focusedChunkId}
          title="Keep focused chunk · Enter"
          aria-label="Keep focused chunk"
        >
          Keep
        </ChunkyButton>
        <ChunkyButton
          variant="secondary"
          size="sm"
          onClick={() => void rejectFocusedGuarded()}
          disabled={!focusedChunkId}
          title="Drop focused chunk · Backspace"
          aria-label="Drop focused chunk"
        >
          Drop
        </ChunkyButton>

        <span className="h-6 w-px bg-rule mx-1" aria-hidden />

        <PlaybackModeSwitch />
      </div>

      {/* Right rail — kept counter (the floating Footer overlay sits
       *  at bottom-right and may partially obscure this on narrow
       *  viewports; the counter is non-essential, the deck-strip
       *  shows the same number more prominently). */}
      <span className="justify-self-end font-mono text-[10px] tracking-label uppercase text-ink-3 tabular hidden md:inline-block">
        {acceptedCount} / {chunks.length} kept
      </span>
    </div>
  );
}

/** Local wrapper that subscribes to `playback.currentTime` so only this
 *  component re-renders on every RAF tick — the rest of the
 *  TransportBar stays static. Forwards into the editor's brass-plate
 *  TransportClockView. */
function TriageClock({ duration }: { duration: number }) {
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  return <TransportClockView currentTime={currentTime} duration={duration} />;
}
