/**
 * Editor-bound wrapper around `TransportClockView`. Pulls `currentTime`
 * and `duration` from the editor store and forwards them as props.
 *
 * Triage and other surfaces use `TransportClockView` directly with their
 * own state, so the brass-plate visual lives in exactly one place.
 */
import { useEditorStore } from "../store";
import { totalArrDuration } from "../arrangement-time";
import { TransportClockView } from "./TransportClockView";

export function TransportClock({ className = "" }: { className?: string }) {
  // Arrangement-mode: the user thinks in song-time — a continuous 0..total
  // line over the chosen chunks, gaps removed. The walker emits
  // `playback.timelineT` authoritatively (no master→arr scan), so the LCD
  // tracks the playhead correctly even when duplicate-source pills share
  // the same master-time range.
  const currentTime = useEditorStore((s) => s.playback.timelineT);
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
