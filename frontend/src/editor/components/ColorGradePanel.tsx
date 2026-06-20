// Color-grade section for the Overlays panel — the corrective/creative grade
// applied UNDER the filters and accents. ONE grade per project (no add/remove,
// no looks): grouped grading controls in pipeline order, each writing the
// `colorGrade` GradeParams vector. Reuses the panel's card + slider idioms.
import { useEditorStore } from "../store";
import type { GradeParams } from "../fx/looks";
import { ChunkyButton } from "./ChunkyButton";
import { ParamSlider } from "./ParamSlider";

type Group = "TONE" | "COLOR" | "WHEELS";

interface Control {
  key: keyof GradeParams;
  label: string;
  group: Group;
  /** unipolar 0..100 (else bipolar -100..100). */
  uni?: boolean;
  /** engine value -> display int. */
  to: (v: number) => number;
  /** display int -> engine value. */
  from: (d: number) => number;
}

// Display maps the engine ranges to friendly -100..100 / 0..100 sliders.
const CONTROLS: Control[] = [
  { key: "exposure", label: "EXPOSURE", group: "TONE", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "contrast", label: "CONTRAST", group: "TONE", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "blackPoint", label: "BLACK", group: "TONE", to: (v) => Math.round((v / 0.2) * 100), from: (d) => (d / 100) * 0.2 },
  { key: "fade", label: "FADE", group: "TONE", uni: true, to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "saturation", label: "SATURATION", group: "COLOR", to: (v) => Math.round((v - 1) * 100), from: (d) => 1 + d / 100 },
  { key: "temp", label: "TEMP", group: "COLOR", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "tint", label: "TINT", group: "COLOR", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "shadowsLift", label: "SHADOWS", group: "WHEELS", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "gamma", label: "MIDTONES", group: "WHEELS", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
  { key: "highlightsGain", label: "HIGHLIGHTS", group: "WHEELS", to: (v) => Math.round(v * 100), from: (d) => d / 100 },
];

const GROUPS: { id: Group; title: string }[] = [
  { id: "TONE", title: "Tone" },
  { id: "COLOR", title: "Color" },
  { id: "WHEELS", title: "Shadows · Midtones · Highlights" },
];

export function ColorGradePanel() {
  const colorGrade = useEditorStore((s) => s.colorGrade);
  const setColorGrade = useEditorStore((s) => s.setColorGrade);
  const resetColorGrade = useEditorStore((s) => s.resetColorGrade);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label">Color grade</span>
        <ChunkyButton size="sm" variant="ghost" onClick={resetColorGrade}>
          RESET
        </ChunkyButton>
      </div>

      <div className="rounded-md bg-paper-deep p-3 shadow-pressed flex flex-col gap-3">
        {GROUPS.map((g, gi) => (
          <div
            key={g.id}
            className={[
              "flex flex-col gap-2",
              gi > 0 ? "pt-3 border-t border-rule" : "",
            ].join(" ")}
          >
            <span className="font-mono text-[9px] tracking-label uppercase text-ink-3">
              {g.title}
            </span>
            {CONTROLS.filter((c) => c.group === g.id).map((c) => (
              <ParamSlider
                key={c.key}
                label={c.label}
                value={c.to(colorGrade[c.key])}
                min={c.uni ? 0 : -100}
                max={100}
                bipolar={!c.uni}
                onChange={(d) => setColorGrade({ [c.key]: c.from(d) })}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
