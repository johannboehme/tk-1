/**
 * Pure presentational variant of the brass-plate transport clock.
 *
 * Identical visuals to `TransportClock` (one bezel, TIM + DUR LCDs,
 * engraved divider, scanline screens), but takes `currentTime` and
 * `duration` as props so non-editor surfaces (Triage, future Arrange)
 * can reuse the chrome without pulling in the editor store. The editor
 * wrapper in `TransportClock.tsx` forwards its store values into this
 * view.
 */
import { formatTime } from "./MonoReadout";

const LCD_BG = `
  repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 3px),
  repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0 1px, transparent 1px 3px),
  radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,0.06), rgba(0,0,0,0) 60%),
  linear-gradient(180deg, #0E1311 0%, #0A0E0C 100%)
`;
const LCD_SHADOW = [
  "inset 0 1px 0 rgba(255,255,255,0.05)",
  "inset 0 -1px 0 rgba(0,0,0,0.5)",
  "inset 0 0 18px rgba(0,0,0,0.55)",
  "0 1px 0 rgba(255,255,255,0.5)",
].join(", ");
const LCD_GREEN = "#9DEFD0";
const GLOW_GREEN =
  "0 0 5px rgba(157,239,208,0.4), 0 0 1px rgba(157,239,208,0.8)";

export interface TransportClockViewProps {
  /** Current playhead position in seconds. */
  currentTime: number;
  /** Total duration in seconds. */
  duration: number;
  className?: string;
}

export function TransportClockView({
  currentTime,
  duration,
  className = "",
}: TransportClockViewProps) {
  const bezel: React.CSSProperties = {
    background:
      "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 50%, #C9BFA6 100%)",
    boxShadow: [
      "inset 0 1px 0 rgba(255,255,255,0.85)",
      "inset 0 -1px 0 rgba(0,0,0,0.18)",
      "0 1px 2px rgba(0,0,0,0.18)",
    ].join(", "),
    borderRadius: 8,
    padding: "8px 6px",
  };

  const dividerStyle: React.CSSProperties = {
    width: 2,
    background:
      "linear-gradient(90deg, rgba(0,0,0,0.18) 0 1px, rgba(255,255,255,0.7) 1px 2px)",
    alignSelf: "stretch",
    margin: "1px 2px",
    borderRadius: 1,
  };

  const lcd: React.CSSProperties = {
    height: 36,
    background: LCD_BG,
    boxShadow: LCD_SHADOW,
    color: LCD_GREEN,
    textShadow: GLOW_GREEN,
  };

  const lcdClass = [
    "font-mono tabular tracking-[0.05em]",
    "text-base w-[78px] px-1.5 sm:text-2xl sm:w-[130px] sm:px-3",
    "rounded-[3px] border border-black/40",
    "inline-flex items-center justify-center leading-none",
  ].join(" ");

  const stencilClass =
    "font-display text-[8px] tracking-[0.2em] text-ink-2 leading-tight uppercase";
  const stencilStyle: React.CSSProperties = {
    writingMode: "vertical-rl",
    transform: "rotate(180deg)",
    letterSpacing: "0.18em",
  };

  return (
    <div
      className={`inline-flex items-center gap-2 self-center ${className}`}
      style={bezel}
      aria-label="Transport clock"
    >
      <span aria-hidden className={stencilClass} style={stencilStyle}>
        TIM
      </span>
      <div data-testid="transport-clock-time" className={lcdClass} style={lcd}>
        {formatTime(currentTime)}
      </div>
      <div aria-hidden style={dividerStyle} />
      <span aria-hidden className={stencilClass} style={stencilStyle}>
        DUR
      </span>
      <div
        data-testid="transport-clock-duration"
        className={lcdClass}
        style={lcd}
      >
        {formatTime(duration)}
      </div>
    </div>
  );
}
