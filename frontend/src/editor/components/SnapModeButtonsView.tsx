/**
 * Pure presentational variant of the cassette-deck snap-mode selector.
 *
 * Identical visuals to `SnapModeButtons`, but takes all state as props so
 * non-editor surfaces (Triage, future Arrange) can reuse the chrome without
 * pulling in the editor store. The editor wrapper in `SnapModeButtons.tsx`
 * forwards its store values into this view.
 *
 * The lock key is optional — surfaces that don't have a lockable thing
 * (e.g. Triage) just omit `lock` and the divider + lock key disappear.
 */
import type { SnapMode } from "../snap";

export interface SnapModeButtonsViewProps {
  snapMode: SnapMode;
  onSnapModeChange: (mode: SnapMode) => void;
  /** When false, grid modes (1, 1/2, 1/4, 1/8, 1/16) are disabled. */
  hasBpm: boolean;
  /** When false, the MATCH key is disabled (no candidate positions). */
  matchAvailable?: boolean;
  /** Subset of modes to render. Omit to show all. Use this to hide
   *  modes that don't make sense for the surface — e.g. Triage has
   *  no audio-match candidates so it leaves MATCH out entirely. */
  modes?: ReadonlyArray<SnapMode>;
  /** Optional lock toggle — omit to hide the lock key + divider. */
  lock?: {
    locked: boolean;
    onToggle: () => void;
    /** Tooltip when unlocked → click would lock. */
    titleLock: string;
    /** Tooltip when locked → click would unlock. */
    titleUnlock: string;
  };
}

const MODE_BUTTONS: { mode: SnapMode; label: string; needsBpm: boolean }[] = [
  { mode: "off", label: "OFF", needsBpm: false },
  { mode: "match", label: "MATCH", needsBpm: false },
  { mode: "1", label: "1", needsBpm: true },
  { mode: "1/2", label: "1/2", needsBpm: true },
  { mode: "1/4", label: "1/4", needsBpm: true },
  { mode: "1/8", label: "1/8", needsBpm: true },
  { mode: "1/16", label: "1/16", needsBpm: true },
];

/** Brass cassette plate that hosts a row of CassetteKeys. Exported so
 *  other transport surfaces (e.g. the Triage playback-mode switch) share
 *  the exact deck chrome. */
export const PLATE_STYLE: React.CSSProperties = {
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

const KEY_REST: React.CSSProperties = {
  background:
    "linear-gradient(180deg, #2A2520 0%, #1A1612 60%, #2A2520 100%)",
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.10)",
    "inset 0 -1px 0 rgba(0,0,0,0.6)",
    "0 2px 0 rgba(0,0,0,0.45)",
    "0 3px 4px rgba(0,0,0,0.35)",
  ].join(", "),
  color: "#FAF6EC",
};

const KEY_ACTIVE: React.CSSProperties = {
  background:
    "linear-gradient(180deg, #0E0B08 0%, #1A1612 100%)",
  boxShadow: [
    "inset 0 1px 2px rgba(0,0,0,0.7)",
    "inset 0 -1px 0 rgba(255,255,255,0.06)",
    "0 1px 0 rgba(255,255,255,0.15)",
  ].join(", "),
  color: "#FAF6EC",
  transform: "translateY(2px)",
};

const KEY_BASE_CLS = [
  "relative shrink-0",
  "h-7 min-w-[30px] px-2 text-[10px] font-display tracking-label",
  "rounded-[3px] border border-black/40",
  "select-none transition-transform duration-75",
  "disabled:opacity-25 disabled:cursor-not-allowed",
  "flex items-center justify-center gap-1",
].join(" ");

interface KeyProps {
  active: boolean;
  disabled?: boolean;
  testId?: string;
  title?: string;
  ariaLabel?: string;
  extraCls?: string;
  onClick: () => void;
  children: React.ReactNode;
}

/** One recessed deck key with an orange LED pip when active. Exported so
 *  other transport plates reuse the identical key chrome. */
export function CassetteKey({
  active,
  disabled,
  testId,
  title,
  ariaLabel,
  extraCls,
  onClick,
  children,
}: KeyProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={extraCls ? `${KEY_BASE_CLS} ${extraCls}` : KEY_BASE_CLS}
      style={active ? KEY_ACTIVE : KEY_REST}
      title={title}
    >
      <span
        aria-hidden
        className="absolute top-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
        style={{
          background: active ? "#FF5722" : "rgba(255,255,255,0.18)",
          boxShadow: active
            ? "0 0 4px rgba(255,87,34,0.9), 0 0 1px rgba(255,87,34,0.6)"
            : "inset 0 1px 1px rgba(0,0,0,0.4)",
        }}
      />
      <span className="leading-none mt-1">{children}</span>
    </button>
  );
}

export function SnapModeButtonsView({
  snapMode,
  onSnapModeChange,
  hasBpm,
  matchAvailable = true,
  modes,
  lock,
}: SnapModeButtonsViewProps) {
  const visibleButtons = modes
    ? MODE_BUTTONS.filter((b) => modes.includes(b.mode))
    : MODE_BUTTONS;
  return (
    <div
      className="flex items-center gap-1.5 self-center max-w-full overflow-x-auto no-native-scrollbar sm:inline-flex sm:overflow-visible sm:max-w-none"
      style={PLATE_STYLE}
      role="group"
      aria-label="Snap mode"
    >
      {visibleButtons.map(({ mode, label, needsBpm }) => {
        const active = snapMode === mode;
        const disabled =
          (needsBpm && !hasBpm) || (mode === "match" && !matchAvailable);
        return (
          <CassetteKey
            key={mode}
            active={active}
            disabled={disabled}
            testId={`snap-mode-${mode}`}
            title={
              mode === "match" && !matchAvailable
                ? "Match: no audio-match candidates"
                : `Snap: ${label}`
            }
            extraCls={needsBpm ? "w-10" : undefined}
            onClick={() => onSnapModeChange(mode)}
          >
            {label}
          </CassetteKey>
        );
      })}
      {lock && (
        <>
          <span
            aria-hidden
            className="self-stretch w-px mx-1"
            style={{ background: "rgba(0,0,0,0.18)" }}
          />
          <CassetteKey
            active={!lock.locked}
            testId="snap-lock"
            title={lock.locked ? lock.titleUnlock : lock.titleLock}
            ariaLabel={lock.locked ? "Unlock lanes" : "Lock lanes"}
            onClick={lock.onToggle}
          >
            {lock.locked ? "🔒" : "🔓"}
          </CassetteKey>
        </>
      )}
    </div>
  );
}
