// 5-step quality slider with tactile snap. Single source of truth for what
// "Tiny / Low / Good / High / Pristine" mean — actual bitrates are derived
// in `exportPresets.qualityToBitrates` so the panel never re-encodes that
// table here.
import type { QualityStep } from "../../core/types";

const STEPS: { value: Exclude<QualityStep, "custom">; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "low", label: "Low" },
  { value: "good", label: "Good" },
  { value: "high", label: "High" },
  { value: "pristine", label: "Pristine" },
];

interface Props {
  value: QualityStep;
  onChange: (q: Exclude<QualityStep, "custom">) => void;
}

export function QualitySlider({ value, onChange }: Props) {
  // "custom" means the user nudged a bitrate in the advanced drawer; we
  // visualise this by floating the thumb at the closest step but greying it.
  const isCustom = value === "custom";
  const stepIdx = isCustom
    ? STEPS.findIndex((s) => s.value === "good")
    : STEPS.findIndex((s) => s.value === value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="label">Quality</span>
        <span
          className={[
            "font-mono text-[10px] tracking-label uppercase",
            isCustom ? "text-ink-3" : "text-ink-2",
          ].join(" ")}
        >
          {isCustom ? "Custom" : STEPS[stepIdx].label}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={STEPS.length - 1}
        step={1}
        value={stepIdx < 0 ? 2 : stepIdx}
        onChange={(e) => onChange(STEPS[parseInt(e.target.value, 10)].value)}
        className={[
          "w-full accent-hot",
          isCustom ? "opacity-60" : "",
        ].join(" ")}
      />
      <div className="flex justify-between text-[9px] font-mono tracking-tight text-ink-3">
        {STEPS.map((s) => (
          <span key={s.value} className="w-12 text-center first:text-left last:text-right">
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
