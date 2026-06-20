// Global color-grade stack for the Overlays panel. A vertical list of
// filter cards — same idiom as the text-overlay cards: ADD appends, each
// card picks a look + dials Amount and four macros, REMOVE / reorder nudges
// live in the card header. Card order top→bottom IS the serial compose
// order (each look grades the previous one's output). Reuses the panel's
// existing primitives so it reads as part of the panel, not a new widget.
import { useEditorStore } from "../store";
import {
  GRADE_LOOK_IDS,
  GRADE_LOOKS,
  type GradeLookId,
  type GradeSlot,
} from "../fx/looks";
import { ChunkyButton } from "./ChunkyButton";
import { ChevronLeftIcon, PlusIcon, TrashIcon } from "./icons";

export function FilterStack() {
  const slots = useEditorStore((s) => s.gradeSlots);
  const addGradeSlot = useEditorStore((s) => s.addGradeSlot);
  const updateGradeSlot = useEditorStore((s) => s.updateGradeSlot);
  const removeGradeSlot = useEditorStore((s) => s.removeGradeSlot);
  const moveGradeSlot = useEditorStore((s) => s.moveGradeSlot);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label">Filters · {slots.length}</span>
        <ChunkyButton
          size="sm"
          variant="primary"
          iconLeft={<PlusIcon />}
          onClick={() => addGradeSlot()}
        >
          ADD
        </ChunkyButton>
      </div>

      {slots.length === 0 && (
        <div className="rounded-md bg-paper-deep shadow-pressed py-6 text-center">
          <p className="text-xs text-ink-2">
            No filters yet — press ADD to stack a look.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {slots.map((slot, idx) => (
          <FilterCard
            key={slot.id}
            slot={slot}
            idx={idx}
            total={slots.length}
            onLook={(lookId) => updateGradeSlot(slot.id, { lookId })}
            onParam={(patch) => updateGradeSlot(slot.id, patch)}
            onRemove={() => removeGradeSlot(slot.id)}
            onMove={(dir) => moveGradeSlot(slot.id, dir)}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  slot: GradeSlot;
  idx: number;
  total: number;
  onLook: (lookId: GradeLookId) => void;
  onParam: (patch: Partial<GradeSlot>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function FilterCard({ slot, idx, total, onLook, onParam, onRemove, onMove }: CardProps) {
  const look = GRADE_LOOKS[slot.lookId];
  return (
    <div className="rounded-md bg-paper-deep p-3 shadow-pressed flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="inline-block w-3 h-3 rounded-full border border-rule shrink-0"
            style={{ background: look.swatch }}
          />
          <span className="label truncate">
            #{idx + 1} · {look.label}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <NudgeButton dir="up" disabled={idx === 0} onClick={() => onMove(-1)} />
          <NudgeButton dir="down" disabled={idx === total - 1} onClick={() => onMove(1)} />
          <ChunkyButton
            size="sm"
            variant="ghost"
            iconLeft={<TrashIcon />}
            onClick={onRemove}
          >
            REMOVE
          </ChunkyButton>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="label">Look</span>
        <select
          aria-label="Look"
          value={slot.lookId}
          onChange={(e) => onLook(e.target.value as GradeLookId)}
          className="bg-paper-hi border border-rule rounded-md h-10 px-2 font-mono text-sm"
        >
          {GRADE_LOOK_IDS.map((id) => (
            <option key={id} value={id}>
              {GRADE_LOOKS[id].label}
            </option>
          ))}
        </select>
      </label>

      <ParamSlider
        label="Amount"
        unit="%"
        value={Math.round(slot.strength * 100)}
        min={0}
        max={100}
        onChange={(v) => onParam({ strength: v / 100 })}
      />

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-1">
        <ParamSlider label="Warmth" bipolar value={Math.round(slot.warmth * 100)} min={-100} max={100} onChange={(v) => onParam({ warmth: v / 100 })} />
        <ParamSlider label="Fade" bipolar value={Math.round(slot.fade * 100)} min={-100} max={100} onChange={(v) => onParam({ fade: v / 100 })} />
        <ParamSlider label="Punch" bipolar value={Math.round(slot.punch * 100)} min={-100} max={100} onChange={(v) => onParam({ punch: v / 100 })} />
        <ParamSlider label="Grain" bipolar value={Math.round(slot.grain * 100)} min={-100} max={100} onChange={(v) => onParam({ grain: v / 100 })} />
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  /** Centre-zero param — show a leading "+" on positive values. */
  bipolar?: boolean;
  onChange: (v: number) => void;
}

function ParamSlider({ label, value, min, max, unit, bipolar, onChange }: SliderProps) {
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

function NudgeButton({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={dir === "up" ? "Move filter up" : "Move filter down"}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 flex items-center justify-center rounded-md bg-paper-hi border border-rule text-ink-2 hover:text-ink disabled:text-ink-3 disabled:cursor-default"
    >
      <ChevronLeftIcon className={dir === "up" ? "rotate-90" : "-rotate-90"} />
    </button>
  );
}
