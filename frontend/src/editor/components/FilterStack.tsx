// Filters section for the Overlays panel — a stack of opinionated looks
// (VHS / Super-8 / Decay / Noir / Sepia / Instant). ADD appends a filter
// card; each card picks a kind and renders THAT kind's OWN controls (read
// from FxDefinition.filterParams), so a VHS card shows TRACK/BLEED/SNOW and a
// Sepia card shows TONE/CONTRAST/FADE — no shared macro block. Card order
// top→bottom is the serial compose order. Reuses the panel's card + slider
// idioms.
import { useEditorStore } from "../store";
import { fxCatalog } from "../../core/fx/catalog";
import type { FilterSlot, FxKind } from "../../core/fx/types";
import { ChunkyButton } from "./ChunkyButton";
import { ParamSlider } from "./ParamSlider";
import { ChevronLeftIcon, PlusIcon, TrashIcon } from "./icons";

/** The shippable filter kinds, in picker order. */
const FILTER_KINDS: FxKind[] = ["vhs", "super8", "decay", "noir", "sepia", "polaroid"];

export function FilterStack() {
  const slots = useEditorStore((s) => s.filterSlots);
  const addFilterSlot = useEditorStore((s) => s.addFilterSlot);
  const setFilterKind = useEditorStore((s) => s.setFilterKind);
  const setFilterParam = useEditorStore((s) => s.setFilterParam);
  const removeFilterSlot = useEditorStore((s) => s.removeFilterSlot);
  const moveFilterSlot = useEditorStore((s) => s.moveFilterSlot);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="label">Filters · {slots.length}</span>
        <ChunkyButton
          size="sm"
          variant="primary"
          iconLeft={<PlusIcon />}
          onClick={() => addFilterSlot(FILTER_KINDS[0])}
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
            onKind={(kind) => setFilterKind(slot.id, kind)}
            onParam={(key, v) => setFilterParam(slot.id, key, v)}
            onRemove={() => removeFilterSlot(slot.id)}
            onMove={(dir) => moveFilterSlot(slot.id, dir)}
          />
        ))}
      </div>
    </section>
  );
}

interface CardProps {
  slot: FilterSlot;
  idx: number;
  total: number;
  onKind: (kind: FxKind) => void;
  onParam: (key: string, value: number) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function FilterCard({ slot, idx, total, onKind, onParam, onRemove, onMove }: CardProps) {
  const def = fxCatalog[slot.kind];
  const params = def.filterParams ?? [];
  return (
    <div className="rounded-md bg-paper-deep p-3 shadow-pressed flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="inline-block w-3 h-3 rounded-full border border-rule shrink-0"
            style={{ background: def.capsuleColor }}
          />
          <span className="label truncate">#{idx + 1}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <NudgeButton dir="up" disabled={idx === 0} onClick={() => onMove(-1)} />
          <NudgeButton dir="down" disabled={idx === total - 1} onClick={() => onMove(1)} />
          <ChunkyButton size="sm" variant="ghost" iconLeft={<TrashIcon />} onClick={onRemove}>
            REMOVE
          </ChunkyButton>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="label">Filter</span>
        <select
          aria-label="Filter"
          value={slot.kind}
          onChange={(e) => onKind(e.target.value as FxKind)}
          className="bg-paper-hi border border-rule rounded-md h-10 px-2 font-mono text-sm"
        >
          {FILTER_KINDS.map((k) => (
            <option key={k} value={k}>
              {fxCatalog[k].label}
            </option>
          ))}
        </select>
      </label>

      {params.map((p) => {
        const raw = slot.params[p.id] ?? p.defaultValue;
        return (
          <ParamSlider
            key={p.id}
            label={p.label}
            value={Math.round(raw * 100)}
            min={Math.round(p.min * 100)}
            max={Math.round(p.max * 100)}
            unit={p.id === "amount" ? "%" : undefined}
            bipolar={p.min < 0}
            onChange={(v) => onParam(p.id, v / 100)}
          />
        );
      })}
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
