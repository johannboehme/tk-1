// Toggle group with a sliding active indicator.
//
// Single always-mounted indicator slides between the actual button rects
// using a measured offset/width pair. (Earlier version used Framer's
// `layoutId` shared-layout animation with `{active && <motion.span>}` —
// that unmount/mount-races on switch and produced a single-frame "no
// indicator visible" gap which left the active label as white text on a
// light background.)
import { motion } from "framer-motion";
import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface Option<V extends string> {
  value: V;
  label: ReactNode;
}

interface Props<V extends string> {
  value: V;
  options: Option<V>[];
  onChange: (v: V) => void;
  size?: "sm" | "md";
  fullWidth?: boolean;
  label?: string;
}

export function SegmentedControl<V extends string>({
  value,
  options,
  onChange,
  size = "md",
  fullWidth = false,
  label,
}: Props<V>) {
  // Narrow phones drop md-size text from 14 px → 11 px so a 4-segment
  // fullWidth control (e.g. Export's WEB / ARCHIVE / MOBILE / CUSTOM)
  // doesn't overflow the bottom-sheet on a 390-px-wide iPhone.
  const heightCls =
    size === "sm" ? "h-9 text-xs" : "h-11 text-[11px] sm:text-sm";
  // Padding shrinks with size — at sm we run out of room to keep px-3
  // when 4 segments share a 380 px sidebar (e.g. WEB / ARCHIVE / MOBILE
  // / CUSTOM each gets ~82 px of room, and ARCHIVE alone needs ~98 px
  // with px-3). px-2 shaves 16 px off each segment's padding budget so
  // the labels actually fit.
  const paddingCls = size === "sm" ? "px-2" : "px-2 sm:px-3";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );

  const matchedIndex = options.findIndex((o) => o.value === value);
  const activeIndex = matchedIndex; // -1 when no chip matches → no pill
  const showPill = matchedIndex >= 0;

  const measure = useCallback(() => {
    const c = containerRef.current;
    const btn = buttonRefs.current[activeIndex];
    if (!c || !btn) {
      setPill(null);
      return;
    }
    const cb = c.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    setPill({ left: bb.left - cb.left, width: bb.width });
  }, [activeIndex]);

  useLayoutEffect(() => {
    measure();
  }, [measure, options.length]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    if (typeof ResizeObserver === "undefined") {
      // jsdom & older browsers — fall back to a window-resize listener.
      const onResize = () => measure();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => measure());
    ro.observe(c);
    for (const b of buttonRefs.current) if (b) ro.observe(b);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="label">{label}</span>}
      <div
        ref={containerRef}
        role="tablist"
        className={[
          "relative inline-flex items-stretch rounded-md p-1 gap-1",
          "bg-paper-deep shadow-pressed",
          fullWidth ? "w-full" : "",
        ].join(" ")}
      >
        {pill && showPill && (
          <motion.span
            aria-hidden
            className="absolute rounded-[5px] bg-ink shadow-emboss pointer-events-none"
            style={{ top: 4, bottom: 4 }}
            initial={false}
            animate={{ left: pill.left, width: pill.width }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          />
        )}
        {options.map((o, i) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(o.value)}
              className={[
                // Always nowrap — a 12-char label like "B • OVERRIDE"
                // shouldn't break onto two lines.
                // `flex-1` only when the control is fullWidth (segments
                // need to share leftover room equally). When the control
                // is auto-sized inline, segments grow to fit their text
                // — adding `flex-1 min-w-0` there caused "B • OVERRIDE"
                // to be clipped to "B • OVERRID".
                "relative z-10 rounded-[5px] font-display tracking-label uppercase",
                "whitespace-nowrap",
                "transition-colors",
                heightCls,
                paddingCls,
                fullWidth ? "flex-1 min-w-0" : "",
                active ? "text-paper-hi" : "text-ink-2 hover:text-ink",
              ].join(" ")}
              style={{ minWidth: 44 }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
