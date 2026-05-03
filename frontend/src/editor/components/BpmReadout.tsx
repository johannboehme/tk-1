/**
 * Editor-bound wrapper around `BpmReadoutView`. Pulls BPM, detected BPM,
 * and time signature from the editor store and forwards them as props.
 *
 * Triage and other surfaces use `BpmReadoutView` directly with their own
 * state, so the brass-plate visual lives in exactly one place.
 */
import { useEditorStore } from "../store";
import { effectiveBeatsPerBar } from "../selectors/timing";
import { BpmReadoutView } from "./BpmReadoutView";

export function BpmReadout() {
  const bpm = useEditorStore((s) => s.jobMeta?.bpm) ?? null;
  const detectedBpm = useEditorStore((s) => s.jobMeta?.detectedBpm) ?? null;
  const setBpm = useEditorStore((s) => s.setBpm);
  const reset = useEditorStore((s) => s.resetBpmToDetected);
  const beatsPerBar = useEditorStore((s) => effectiveBeatsPerBar(s.jobMeta));
  const setBeatsPerBar = useEditorStore((s) => s.setBeatsPerBar);

  return (
    <BpmReadoutView
      bpm={bpm}
      detectedBpm={detectedBpm}
      beatsPerBar={beatsPerBar}
      onBpm={setBpm}
      onResetBpm={reset}
      onBeatsPerBar={setBeatsPerBar}
    />
  );
}
