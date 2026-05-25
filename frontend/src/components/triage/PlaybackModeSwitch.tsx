/**
 * Triage transport-mode switch — a 3-position cassette plate that
 * replaces the old binary Loop toggle. Reuses the exact deck chrome
 * (brass plate + recessed keys + orange LED pip) from the snap-mode
 * selector so it reads as part of the same tape-deck.
 *
 *   CONT — play the master audio linearly (through gaps + dropped chunks)
 *   LOOP — bounce the focused chunk forever
 *   SEQ  — walk all kept chunks chronologically, gapless, stop at end
 *
 * `L` cycles the three (handled in TriageTransportBar).
 */
import {
  CassetteKey,
  PLATE_STYLE,
} from "../../editor/components/SnapModeButtonsView";
import { useTriageStore } from "../../local/triage/triage-store";
import type { TriageMode } from "../../local/triage/triage-store";

const MODES: { mode: TriageMode; label: string; title: string }[] = [
  { mode: "continue", label: "CONT", title: "Continue — play master audio linearly · L cycles" },
  { mode: "loop", label: "LOOP", title: "Loop — repeat the focused chunk · L cycles" },
  { mode: "sequence", label: "SEQ", title: "Sequence — play kept chunks in order · L cycles" },
];

export function PlaybackModeSwitch() {
  const mode = useTriageStore((s) => s.playback.mode);
  const setMode = useTriageStore((s) => s.setMode);
  return (
    <div
      className="flex items-center gap-1.5 self-center"
      style={PLATE_STYLE}
      role="radiogroup"
      aria-label="Transport mode"
    >
      {MODES.map(({ mode: m, label, title }) => (
        <CassetteKey
          key={m}
          active={mode === m}
          testId={`triage-mode-${m}`}
          title={title}
          ariaLabel={title}
          extraCls="w-12"
          onClick={() => setMode(m)}
        >
          {label}
        </CassetteKey>
      ))}
    </div>
  );
}
