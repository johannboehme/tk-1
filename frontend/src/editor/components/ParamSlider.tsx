// Shared panel slider — matches QualitySlider's idiom (label-left, mono
// value-right, range accent-hot). Used by the Color-grade section and every
// filter card. Values are integers; `bipolar` prints a leading "+" and shows
// a centre-zero range.
interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  /** Centre-zero param — show a leading "+" on positive values. */
  bipolar?: boolean;
  onChange: (v: number) => void;
}

export function ParamSlider({ label, value, min, max, unit, bipolar, onChange }: Props) {
  const display = bipolar && value > 0 ? `+${value}` : `${value}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="font-mono text-[10px] tracking-label uppercase text-ink-2">
          {display}
          {unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-hot"
      />
    </div>
  );
}
