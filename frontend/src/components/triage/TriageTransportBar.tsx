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
import { useRegisterShortcut } from "../../editor/shortcuts/useRegisterShortcut";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
} from "../../editor/components/icons";
import { useTriageStore } from "../../local/triage/triage-store";

export function TriageTransportBar() {
  const isPlaying = useTriageStore((s) => s.playback.isPlaying);
  const setPlaying = useTriageStore((s) => s.setPlaying);
  const loopEnabled = useTriageStore((s) => s.playback.loopEnabled);
  const setLoopEnabled = useTriageStore((s) => s.setLoopEnabled);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const focusRelative = useTriageStore((s) => s.focusRelative);
  const acceptFocused = useTriageStore((s) => s.acceptFocused);
  const rejectFocused = useTriageStore((s) => s.rejectFocused);
  const chunks = useTriageStore((s) => s.chunks);
  const audioDuration = useTriageStore((s) => s.audioDuration);
  // Don't subscribe to currentTime — it changes 60×/s. Pull imperatively
  // when needed (only the clock readout cares) and render that as a
  // separate component so updates stay scoped.
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
    description: "Toggle loop on focused chunk",
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
        rejectFocused();
      } else if (e.code === "KeyL") {
        e.preventDefault();
        const cur = useTriageStore.getState().playback.loopEnabled;
        setLoopEnabled(!cur);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setPlaying, focusRelative, acceptFocused, rejectFocused, setLoopEnabled]);

  return (
    <div
      className={[
        "grid items-center gap-2 px-3 py-2 bg-paper-hi border-t border-rule",
        // Symmetric side-rails (10rem each) keep the centered cluster
        // visually balanced AND reserve right-edge space for the
        // floating Footer overlay (impressum / datenschutz) so Keep
        // and Drop never sit underneath it.
        "grid-cols-[10rem_1fr_10rem]",
      ].join(" ")}
    >
      {/* Left rail — clock readout */}
      <TransportClock audioDuration={audioDuration} />

      {/* Centered transport cluster */}
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
          variant={loopEnabled ? "primary" : "secondary"}
          size="sm"
          onClick={() => setLoopEnabled(!loopEnabled)}
          title={loopEnabled ? "Loop on · L to disable" : "Loop off · L to enable"}
          aria-label={loopEnabled ? "Disable loop" : "Enable loop"}
          aria-pressed={loopEnabled}
        >
          ⟲ Loop
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
          onClick={() => rejectFocused()}
          disabled={!focusedChunkId}
          title="Drop focused chunk · Backspace"
          aria-label="Drop focused chunk"
        >
          Drop
        </ChunkyButton>
      </div>

      {/* Right rail — kept counter (footer overlay floats over this
       *  same area; the counter is unimportant enough to be partially
       *  obscured if the user has nothing focused). */}
      <span className="font-mono text-[10px] tracking-label uppercase text-ink-3 tabular text-right hidden md:inline-block">
        {acceptedCount} / {chunks.length} kept
      </span>
    </div>
  );
}

function TransportClock({ audioDuration }: { audioDuration: number }) {
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  return (
    <span className="font-mono text-xs tabular text-ink ml-2 sm:ml-4">
      {formatTimeMs(currentTime)} <span className="text-ink-3">/</span>{" "}
      {formatTime(audioDuration)}
    </span>
  );
}

function formatTimeMs(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00.00";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}
function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
