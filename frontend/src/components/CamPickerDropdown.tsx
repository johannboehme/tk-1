/**
 * Cam-picker dropdown — overlay badge that lists all cams and switches
 * the selection on click.
 *
 * Shared between Triage's `CamPreview` and Arrange's `CamPreviewArrange`
 * so both surfaces have identical interaction. Closed by default;
 * outside-click and Escape close it.
 *
 * Pure presentational — props-driven, no store coupling — so the same
 * component can be wired against any store's selectedCamId / setter
 * pair (Triage, Arrange, future Editor cam-switcher, ...).
 */
import { useEffect, useRef, useState } from "react";

interface CamLite {
  id: string;
  color: string;
}

export interface CamPickerDropdownProps {
  cams: readonly CamLite[];
  selectedCamId: string | null;
  onSelect: (camId: string) => void;
  /** Position the picker via parent — default `absolute top-2 left-2 z-10`.
   *  Override when you need it in a different corner. */
  className?: string;
}

export function CamPickerDropdown({
  cams,
  selectedCamId,
  onSelect,
  className = "absolute top-2 left-2 z-10",
}: CamPickerDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const cam = cams.find((c) => c.id === selectedCamId) ?? cams[0] ?? null;
  const label = cam ? cam.id : "no cams";

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={cams.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          "inline-flex items-center gap-1.5 px-2 py-1 rounded",
          "bg-black/60 backdrop-blur-sm",
          "text-paper-hi font-mono text-[10px] tracking-label uppercase",
          "hover:bg-black/75 transition-colors",
          "disabled:opacity-50",
        ].join(" ")}
        title="Switch cam"
      >
        {cam && (
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: cam.color }}
            aria-hidden
          />
        )}
        <span>{label}</span>
        {cams.length > 1 && (
          <span className="text-paper-hi/60 text-[8px]">▾</span>
        )}
      </button>
      {open && cams.length > 0 && (
        <ul
          role="listbox"
          className={[
            "absolute top-full left-0 mt-1 min-w-[160px]",
            "bg-paper-hi/95 backdrop-blur-md border border-rule rounded shadow-panel",
            "py-1 max-h-60 overflow-y-auto",
          ].join(" ")}
        >
          {cams.map((c) => {
            const active = c.id === (cam?.id ?? null);
            return (
              <li key={c.id} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(c.id);
                    setOpen(false);
                  }}
                  className={[
                    "w-full text-left px-3 py-1.5",
                    "flex items-center gap-2",
                    "font-mono text-[11px] tracking-label uppercase",
                    active
                      ? "bg-hot/15 text-ink"
                      : "text-ink-2 hover:bg-paper-deep",
                  ].join(" ")}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: c.color }}
                    aria-hidden
                  />
                  <span className="truncate">{c.id}</span>
                  {active && (
                    <span className="ml-auto text-hot text-[9px]">●</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
