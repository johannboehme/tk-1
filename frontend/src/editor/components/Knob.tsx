// Hardware jog-wheel: drag vertically to adjust. Tick mark + numeric center.
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Pixels of vertical drag that span (max - min). Lower = more sensitive. */
  pixelsPerRange?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  size?: number;
  label?: string;
  disabled?: boolean;
}

// SVG arc path between two value-angles (the same -135..+135 the indicator
// uses, 0° = pointing up) at a given radius. The -90° offset maps that onto
// SVG space (0° = right), so the arc tracks the needle exactly. Round-capped.
function arcPath(startDeg: number, endDeg: number, r: number): string {
  const pt = (deg: number): [number, number] => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [Math.cos(rad) * r, Math.sin(rad) * r];
  };
  const [x1, y1] = pt(startDeg);
  const [x2, y2] = pt(endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg >= startDeg ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`;
}

export function Knob({
  value,
  min,
  max,
  step = 1,
  pixelsPerRange = 600,
  onChange,
  onCommit,
  size = 168,
  label,
  disabled = false,
}: Props) {
  const startYRef = useRef(0);
  const startValRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const range = max - min;
  // Map value to angle: -135° at min, +135° at max — leaves a "dead zone" at the bottom.
  const ratio = Math.max(0, Math.min(1, (value - min) / range));
  const angle = -135 + ratio * 270;
  // Active-range arc: grows from min for one-sided ranges, or from the
  // zero-crossing for bipolar ranges (e.g. PILL OFFSET), so it reads like
  // an Ableton knob — fill always starts where "neutral" is.
  const bipolar = min < 0 && max > 0;
  const centerRatio = bipolar ? (0 - min) / range : 0;
  const arcStart = -135 + centerRatio * 270;
  const arcEnd = angle;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      startYRef.current = e.clientY;
      startValRef.current = value;
      setDragging(true);
    },
    [disabled, value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.preventDefault();
      // Drag UP = increase, drag DOWN = decrease
      const dy = startYRef.current - e.clientY;
      const fineMode = e.shiftKey;
      const sensitivity = fineMode ? pixelsPerRange * 6 : pixelsPerRange;
      const delta = (dy / sensitivity) * range;
      let next = startValRef.current + delta;
      next = Math.max(min, Math.min(max, next));
      if (step > 0) next = Math.round(next / step) * step;
      // numerical noise — clean up to step precision
      const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
      next = Number(next.toFixed(decimals));
      onChange(next);
    },
    [dragging, max, min, onChange, pixelsPerRange, range, step],
  );

  const onPointerUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    onCommit?.(value);
  }, [dragging, onCommit, value]);

  const onDoubleClick = useCallback(() => {
    if (disabled) return;
    // double-click resets to center (0 if 0 in range, else midpoint)
    const center = min < 0 && max > 0 ? 0 : (min + max) / 2;
    onChange(center);
    onCommit?.(center);
  }, [disabled, max, min, onChange, onCommit]);

  // Keyboard: arrow keys nudge by step; shift+arrow by 10x; ctrl+arrow by 100x.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (!el?.dataset?.knob) return;
      let mult = 1;
      if (e.shiftKey) mult = 10;
      if (e.ctrlKey || e.metaKey) mult = 100;
      let next = value;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") next = value + step * mult;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = value - step * mult;
      else return;
      e.preventDefault();
      next = Math.max(min, Math.min(max, next));
      const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
      onChange(Number(next.toFixed(decimals)));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [max, min, onChange, step, value]);

  const inner = size * 0.62;

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      {label && <span className="label">{label}</span>}
      <div
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        tabIndex={disabled ? -1 : 0}
        data-knob="1"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className={[
          "relative rounded-full bg-paper-hi border border-rule",
          "touch-none cursor-grab active:cursor-grabbing",
          dragging ? "shadow-knob-pressed" : "shadow-knob",
          disabled ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
        style={{ width: size, height: size }}
      >
        {/* outer tick ring */}
        <svg
          className="absolute inset-0 pointer-events-none"
          viewBox={`-50 -50 100 100`}
          width={size}
          height={size}
        >
          {Array.from({ length: 25 }).map((_, i) => {
            const t = i / 24;
            // -90° puts the scale's dead-zone at the bottom and lines the
            // ticks up with the indicator (same convention as the FX encoder).
            const a = (-135 + t * 270 - 90) * (Math.PI / 180);
            const r1 = 47;
            const r2 = i % 6 === 0 ? 41 : 44;
            const x1 = Math.cos(a) * r1;
            const y1 = Math.sin(a) * r1;
            const x2 = Math.cos(a) * r2;
            const y2 = Math.sin(a) * r2;
            // Bipolar ranges light from the centre detent outward (matching
            // the arc); one-sided ranges fill from the minimum.
            const filled = bipolar
              ? t >= Math.min(centerRatio, ratio) && t <= Math.max(centerRatio, ratio)
              : t <= ratio;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={filled ? "#FF5722" : "#9A8F80"}
                strokeWidth={i % 6 === 0 ? 1.4 : 0.8}
                strokeLinecap="round"
              />
            );
          })}
          {/* active-range arc — Ableton-style, sits just outside the ticks.
              Faint full-sweep track shows the unused range; the hot arc
              traces from neutral to the current value. */}
          <path
            d={arcPath(-135, 135, 48.2)}
            fill="none"
            stroke="#C9BFA6"
            strokeWidth={2}
            strokeLinecap="round"
          />
          {Math.abs(arcEnd - arcStart) > 0.5 && (
            <>
              <path
                d={arcPath(arcStart, arcEnd, 48.2)}
                fill="none"
                stroke="#FF5722"
                strokeWidth={3.6}
                strokeLinecap="round"
                opacity={0.22}
              />
              <path
                d={arcPath(arcStart, arcEnd, 48.2)}
                fill="none"
                stroke="#FF5722"
                strokeWidth={2}
                strokeLinecap="round"
              />
            </>
          )}
        </svg>
        {/* inner knob */}
        <div
          className="absolute rounded-full bg-paper-hi"
          style={{
            width: inner,
            height: inner,
            left: (size - inner) / 2,
            top: (size - inner) / 2,
            background:
              "radial-gradient(circle at 30% 28%, #FFFFFF 0%, #F2EDE2 38%, #E8E1D0 100%)",
            transform: `rotate(${angle}deg)`,
            transition: dragging ? "none" : "transform 80ms ease-out",
            boxShadow:
              "inset 0 -3px 6px rgba(0,0,0,0.10), inset 0 2px 4px rgba(255,255,255,0.7), 0 1px 2px rgba(0,0,0,0.08)",
          }}
        >
          {/* indicator stripe */}
          <div
            className="absolute bg-ink rounded-full"
            style={{
              width: 4,
              height: inner * 0.32,
              left: "50%",
              top: 8,
              transform: "translateX(-50%)",
            }}
          />
          {/* center dot */}
          <div
            className="absolute bg-hot rounded-full"
            style={{
              width: 8,
              height: 8,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              boxShadow: "0 0 6px rgba(255,87,34,0.5)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
