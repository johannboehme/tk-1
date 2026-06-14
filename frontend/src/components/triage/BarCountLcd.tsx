/**
 * Brass-bezel LCD with a click-to-edit integer field and a vertical
 * stencil label — the deck-strip's reusable "bar count" instrument.
 *
 * Same edit pattern as the BpmReadout: click the display to type, Enter
 * commits, Escape cancels. Mint-green when "off", phosphor-amber when
 * engaged. Originally the MIN-bars filter; now shared by the inspector's
 * SLICE control so the whole panel speaks one visual vocabulary.
 *
 * The LCD palette constants live here as the single source of truth and
 * are re-exported for the sibling readouts (KEPT counter, snap LCD).
 */
import { useEffect, useRef, useState } from "react";

export const LCD_BG = `
  repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 3px),
  repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0 1px, transparent 1px 3px),
  radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,0.06), rgba(0,0,0,0) 60%),
  linear-gradient(180deg, #0E1311 0%, #0A0E0C 100%)
`;
export const LCD_SHADOW = [
  "inset 0 1px 0 rgba(255,255,255,0.05)",
  "inset 0 -1px 0 rgba(0,0,0,0.5)",
  "inset 0 0 18px rgba(0,0,0,0.55)",
  "0 1px 0 rgba(255,255,255,0.5)",
].join(", ");
export const LCD_GREEN = "#9DEFD0";
export const LCD_AMBER = "#FFB347";
export const GLOW_GREEN =
  "0 0 5px rgba(157,239,208,0.4), 0 0 1px rgba(157,239,208,0.8)";
export const GLOW_AMBER =
  "0 0 6px rgba(255,179,71,0.55), 0 0 1px rgba(255,179,71,0.9)";

interface BarCountLcdProps {
  value: number;
  onChange: (n: number) => void;
  /** Vertical stencil label, e.g. "MIN" or "BARS". */
  label: string;
  /** Display formatter. Default: `0 → "OFF"`, `n → "≥n"`. */
  format?: (v: number) => string;
  /** Whether a value reads as the mint-green "off" state (vs amber
   *  "engaged"). Default: off when `v === 0`. */
  isOff?: (v: number) => boolean;
  min?: number;
  max?: number;
  title?: string;
  ariaLabel?: string;
}

export function BarCountLcd({
  value,
  onChange,
  label,
  format = (v) => (v === 0 ? "OFF" : `≥${v}`),
  isOff = (v) => v === 0,
  min = 0,
  max = 999,
  title,
  ariaLabel,
}: BarCountLcdProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(value > 0 ? String(value) : "");
    setEditing(true);
  }
  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(min);
    } else {
      const n = Math.floor(Number(trimmed));
      if (Number.isFinite(n) && n >= min && n <= max) {
        onChange(n);
      }
    }
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
  }

  const off = isOff(value);
  const lcdColor = off ? LCD_GREEN : LCD_AMBER;
  const lcdGlow = off ? GLOW_GREEN : GLOW_AMBER;
  const display = format(value);

  const bezel: React.CSSProperties = {
    background:
      "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 50%, #C9BFA6 100%)",
    boxShadow: [
      "inset 0 1px 0 rgba(255,255,255,0.85)",
      "inset 0 -1px 0 rgba(0,0,0,0.18)",
      "0 1px 2px rgba(0,0,0,0.18)",
    ].join(", "),
    borderRadius: 6,
    padding: "5px 6px",
  };

  const lcdShared: React.CSSProperties = {
    height: 28,
    background: LCD_BG,
    boxShadow: LCD_SHADOW,
    color: lcdColor,
    textShadow: lcdGlow,
  };
  const lcdClass = [
    "font-mono tabular tracking-[0.05em]",
    "text-base px-2 rounded-[3px] w-[68px]",
    "border border-black/40",
    "inline-flex items-center justify-center leading-none",
  ].join(" ");

  return (
    <div
      className="inline-flex items-center gap-2 self-center shrink-0"
      style={bezel}
    >
      <span
        aria-hidden
        className="font-display text-[8px] tracking-[0.18em] text-ink-2 leading-tight uppercase"
        style={{
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          letterSpacing: "0.18em",
        }}
      >
        {label}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          step={1}
          value={draft}
          placeholder={String(min)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          className={`${lcdClass} text-right outline-none focus:border-hot`}
          style={{
            ...lcdShared,
            paddingTop: 0,
            paddingBottom: 0,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          aria-label={ariaLabel ?? `${label} ${display} — click to change`}
          title={title}
          className={`${lcdClass} cursor-pointer transition hover:brightness-110`}
          style={lcdShared}
        >
          {display}
        </button>
      )}
    </div>
  );
}
