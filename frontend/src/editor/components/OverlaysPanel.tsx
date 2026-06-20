// Re-skin of the existing overlays UI: card-based, TE-typed.
import { TextOverlay, VisualizerConfig } from "../types";
import { useEditorStore } from "../store";
import { ChunkyButton } from "./ChunkyButton";
import { SegmentedControl } from "./SegmentedControl";
import { FilterStack } from "./FilterStack";
import { PlusIcon, TrashIcon } from "./icons";

const VIS_OPTIONS: { value: VisualizerConfig["type"] | ""; label: string }[] = [
  { value: "", label: "None" },
  { value: "showcqt", label: "Spectrum bars" },
  { value: "showfreqs", label: "Frequency bars" },
  { value: "showwaves", label: "Waveform" },
  { value: "showspectrum", label: "Spectrogram" },
  { value: "avectorscope", label: "Vectorscope" },
];

const PRESETS: TextOverlay["preset"][] = ["plain", "boxed", "outline", "glow", "gradient"];
const ANIMATIONS: NonNullable<TextOverlay["animation"]>[] = [
  "fade",
  "pop",
  "slide_in",
  "word_reveal",
  "wobble",
  "none",
];

export function OverlaysPanel() {
  const overlays = useEditorStore((s) => s.overlays);
  const addOverlay = useEditorStore((s) => s.addOverlay);
  const updateOverlay = useEditorStore((s) => s.updateOverlay);
  const removeOverlay = useEditorStore((s) => s.removeOverlay);
  const visualizer = useEditorStore((s) => s.visualizer);
  const setVisualizer = useEditorStore((s) => s.setVisualizer);
  // currentTime is only read inside the click handler; subscribing
  // would re-render this whole panel 60×/sec while playback runs.
  const trim = useEditorStore((s) => s.trim);

  function add() {
    const t = useEditorStore.getState().playback.currentTime;
    addOverlay({
      type: "text",
      text: "Your text",
      start: t,
      end: Math.min(trim.out, t + 2),
      preset: "outline",
      x: 0.5,
      y: 0.85,
      animation: "fade",
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="font-display text-lg leading-none">Overlays & FX</h2>
        <p className="text-xs text-ink-2 mt-1">
          Filters · text overlays · audio visualizer.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span className="label">Visualizer</span>
        <select
          value={visualizer?.type ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setVisualizer(
              v
                ? {
                    type: v as VisualizerConfig["type"],
                    position: "bottom",
                    height_pct: 0.2,
                    opacity: 0.7,
                  }
                : null,
            );
          }}
          className="bg-paper-hi border border-rule rounded-md h-10 px-2 font-mono text-sm"
        >
          {VIS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <FilterStack />

      <div className="flex items-center justify-between">
        <span className="label">Text overlays · {overlays.length}</span>
        <ChunkyButton size="sm" variant="primary" iconLeft={<PlusIcon />} onClick={add}>
          ADD
        </ChunkyButton>
      </div>

      {overlays.length === 0 && (
        <div className="rounded-md bg-paper-deep shadow-pressed py-6 text-center">
          <p className="text-xs text-ink-2">
            No overlays yet — press ADD to drop one in at the playhead.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {overlays.map((o, idx) => (
          <div
            key={idx}
            className="rounded-md bg-paper-deep p-3 shadow-pressed flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="label">#{idx + 1}</span>
              <ChunkyButton
                size="sm"
                variant="ghost"
                iconLeft={<TrashIcon />}
                onClick={() => removeOverlay(idx)}
              >
                REMOVE
              </ChunkyButton>
            </div>
            <input
              type="text"
              value={o.text}
              onChange={(e) => updateOverlay(idx, { text: e.target.value })}
              className="bg-paper-hi border border-rule rounded-md h-10 px-2 font-mono text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Start">
                <input
                  type="number"
                  step={0.1}
                  value={o.start}
                  onChange={(e) =>
                    updateOverlay(idx, { start: parseFloat(e.target.value) })
                  }
                  className="bg-paper-hi border border-rule rounded-md h-9 px-2 font-mono text-xs w-full"
                />
              </Field>
              <Field label="End">
                <input
                  type="number"
                  step={0.1}
                  value={o.end}
                  onChange={(e) =>
                    updateOverlay(idx, { end: parseFloat(e.target.value) })
                  }
                  className="bg-paper-hi border border-rule rounded-md h-9 px-2 font-mono text-xs w-full"
                />
              </Field>
            </div>
            <SegmentedControl
              label="Style"
              size="sm"
              value={o.preset ?? "plain"}
              options={PRESETS.map((p) => ({ value: p ?? "plain", label: (p ?? "plain").slice(0, 4).toUpperCase() }))}
              onChange={(v) => updateOverlay(idx, { preset: v as TextOverlay["preset"] })}
              fullWidth
            />
            <Field label="Animation">
              <select
                aria-label="Animation"
                value={o.animation ?? "none"}
                onChange={(e) =>
                  updateOverlay(idx, {
                    animation: e.target.value as TextOverlay["animation"],
                  })
                }
                className="bg-paper-hi border border-rule rounded-md h-9 px-2 font-mono text-xs w-full"
              >
                {ANIMATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
