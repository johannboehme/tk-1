/**
 * Editor-bound wrapper around `TransportClockView`. Pulls `currentTime`
 * and `duration` from the editor store and forwards them as props.
 *
 * Triage and other surfaces use `TransportClockView` directly with their
 * own state, so the brass-plate visual lives in exactly one place.
 */
import { useEditorStore } from "../store";
import { TransportClockView } from "./TransportClockView";

export function TransportClock({ className = "" }: { className?: string }) {
  const currentTime = useEditorStore((s) => s.playback.currentTime);
  const duration = useEditorStore((s) => s.jobMeta?.duration ?? 0);
  return (
    <TransportClockView
      currentTime={currentTime}
      duration={duration}
      className={className}
    />
  );
}
