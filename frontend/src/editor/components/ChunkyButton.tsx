// Hardware-feel button: bevel + subtle press-down. Three variants, three sizes.
import { motion } from "framer-motion";
import { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "xs" | "sm" | "md" | "lg";

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "ref" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart" | "onAnimationEnd"
>;

interface Props extends ButtonProps {
  variant?: Variant;
  size?: Size;
  pressed?: boolean;
  /** Optional: an icon-only button can omit children entirely. */
  children?: ReactNode;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT: Record<Variant, { rest: string; pressed: string }> = {
  primary: {
    rest: "bg-hot text-paper-hi shadow-emboss hover:bg-hot-pressed",
    pressed: "bg-hot-pressed text-paper-hi shadow-pressed",
  },
  secondary: {
    rest: "bg-paper-hi text-ink shadow-emboss hover:bg-paper-deep",
    pressed: "bg-paper-deep text-ink shadow-pressed",
  },
  ghost: {
    rest: "bg-transparent text-ink hover:bg-paper-deep",
    pressed: "bg-paper-deep text-ink shadow-pressed",
  },
  danger: {
    rest: "bg-paper-hi text-danger shadow-emboss hover:bg-paper-deep",
    pressed: "bg-paper-deep text-danger shadow-pressed",
  },
};

const SIZE: Record<Size, string> = {
  // xs is below the 44 px Apple HIG / 48 dp Material guideline, but the
  // mobile transport row uses it for icon-only buttons that need to
  // fit 8-up across a 280 px Galaxy-Fold-folded screen. No min-width:
  // an icon-only xs button ends up ~28 px wide (16 px icon + 12 px
  // px-1.5), which is the absolute floor we accept for fingertips.
  xs: "h-8 px-1.5 text-xs gap-1",
  sm: "h-9 px-3 text-xs gap-1.5 min-w-[44px]",
  md: "h-11 px-4 text-sm gap-2 min-w-[44px]",
  lg: "h-14 px-6 text-base gap-2.5 min-w-[44px]",
};

export function ChunkyButton({
  variant = "secondary",
  size = "md",
  pressed = false,
  children,
  iconLeft,
  iconRight,
  fullWidth = false,
  disabled,
  className = "",
  ...rest
}: Props) {
  const v = pressed ? VARIANT[variant].pressed : VARIANT[variant].rest;
  return (
    <motion.button
      whileTap={disabled ? undefined : { y: 1, scale: 0.98 }}
      transition={{ duration: 0.08, ease: "easeOut" }}
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center select-none",
        "rounded-md border border-rule/60 font-display tracking-label uppercase",
        "transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        SIZE[size],
        v,
        fullWidth ? "w-full" : "",
        className,
      ].join(" ")}
      {...rest}
    >
      {iconLeft}
      {children !== undefined && children !== null && children !== "" ? (
        <span className="leading-none">{children}</span>
      ) : null}
      {iconRight}
    </motion.button>
  );
}
