// Aspect-ratio picker — five preset chips (16:9, 9:16, 1:1, 4:3, 21:9).
// "custom" is implicit: typing W/H by hand in the ResolutionPicker
// switches the panel into custom mode and de-selects all chips here.
// (Keeping "custom" in the chip group made the segment overflow on
// narrow side-panels and the bottom-sheet on phones.)
import type { AspectRatio } from "../types";
import { ASPECT_RATIO_PRESETS } from "../exportPresets";
import { SegmentedControl } from "./SegmentedControl";

interface Props {
  value: AspectRatio | undefined;
  onChange: (a: AspectRatio) => void;
}

export function AspectPicker({ value, onChange }: Props) {
  const options = ASPECT_RATIO_PRESETS.map((p) => ({ value: p, label: p }));
  // When the active spec is "custom" the value won't match any chip and
  // the SegmentedControl just shows none active — exactly what we want.
  return (
    <SegmentedControl
      label="Aspect"
      value={(value ?? "custom") as Exclude<AspectRatio, "custom">}
      options={options}
      onChange={onChange}
      size="sm"
      fullWidth
    />
  );
}
