/**
 * Editor-bound wrapper around `TransportClockView`. Pulls `currentTime`
 * and `duration` from the editor store and forwards them as props.
 *
 * Triage and other surfaces use `TransportClockView` directly with their
 * own state, so the brass-plate visual lives in exactly one place.
 */
import { useEditorStore } from "../store";
import { masterToArr, totalArrDuration } from "../arrangement-time";
import { TransportClockView } from "./TransportClockView";

export function TransportClock({ className = "" }: { className?: string }) {
  // Arrangement-mode (long-form jobs): the user thinks in song-time —
  // a continuous 0..total line over the chosen chunks, gaps removed.
  // Master-time would jump backwards/forwards across chunk boundaries
  // and read like static. masterToArr is a stable mapping (the playhead
  // never sits in a master-time gap during playback), so the LCD just
  // reflects the audio walker's progress through the song.
  const currentTime = useEditorStore((s) => {
    const segs = s.arrangementSegments;
    return segs.length > 0
      ? masterToArr(s.playback.currentTime, segs)
      : s.playback.currentTime;
  });
  const duration = useEditorStore((s) => {
    const segs = s.arrangementSegments;
    return segs.length > 0 ? totalArrDuration(segs) : (s.jobMeta?.duration ?? 0);
  });
  return (
    <TransportClockView
      currentTime={currentTime}
      duration={duration}
      className={className}
    />
  );
}
