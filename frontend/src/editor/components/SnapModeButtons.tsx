/**
 * Editor-bound wrapper around `SnapModeButtonsView`. Pulls `snapMode`,
 * `lanesLocked`, and BPM/match availability from the editor store and
 * forwards them as props.
 *
 * Triage and other surfaces use `SnapModeButtonsView` directly with their
 * own state, so the visual chrome lives in exactly one place.
 */
import { useEditorStore } from "../store";
import { isVideoClip } from "../types";
import { SnapModeButtonsView } from "./SnapModeButtonsView";

export function SnapModeButtons() {
  const snapMode = useEditorStore((s) => s.ui.snapMode);
  const lanesLocked = useEditorStore((s) => s.ui.lanesLocked);
  const setSnapMode = useEditorStore((s) => s.setSnapMode);
  const setLanesLocked = useEditorStore((s) => s.setLanesLocked);
  const hasBpm = useEditorStore((s) => Boolean(s.jobMeta?.bpm));
  // MATCH only makes sense for clips with audio-match candidates. When a
  // B-roll cam (no candidates) is selected, the button greys out — the
  // store also auto-downgrades the mode if it happens to be MATCH at that
  // moment, but disabling here keeps the UI honest about availability.
  const matchAvailable = useEditorStore((s) => {
    if (s.selectedClipId === null) return true;
    const clip = s.clips.find((c) => c.id === s.selectedClipId);
    if (!clip) return true;
    if (!isVideoClip(clip)) return false;
    return clip.candidates.length > 0;
  });

  return (
    <SnapModeButtonsView
      snapMode={snapMode}
      onSnapModeChange={setSnapMode}
      hasBpm={hasBpm}
      matchAvailable={matchAvailable}
      lock={{
        locked: lanesLocked,
        onToggle: () => setLanesLocked(!lanesLocked),
        titleLock: "Lanes unlocked — click again to lock",
        titleUnlock: "Lanes locked — press to unlock and drag clips",
      }}
    />
  );
}
