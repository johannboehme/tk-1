/**
 * Lane-Header: hardware control strip on the left of each video lane.
 *
 * Vintage-tally aesthetic — sepia/paper tones for the body, cam color
 * reduced to a left-edge stripe + a small tally LED. The TAKE button
 * itself is a recessed paper-toned hardware button (no candy gradients,
 * no halo glow). Status is communicated by the small TALLY LED, not by
 * tinting the button.
 *
 * Sized to fit a 44 × 44 button + name/filename column without clipping.
 */
import { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

export type CamStatus = "off" | "available" | "on-air";

interface Props {
  name: string;
  filename: string;
  color: string;
  status: CamStatus;
  /** "1".."9" for the keyboard shortcut, undefined for cam 10+. */
  hotkeyLabel?: string;
  selected?: boolean;
  /** True while this cam is being held (TAKE pressed or hotkey down). */
  pressed?: boolean;
  /** True once the hold has crossed the paint-mode threshold. */
  painting?: boolean;
  /** Cam is in background prep (decoding / matching / extracting frames).
   *  Surfaces as a pulsing "PREP" badge; the TAKE button still works
   *  because the cam can already be cut to (the video plays even
   *  before the matcher finishes). */
  preparing?: boolean;
  onSelectClip?: () => void;
  /** Tap → quick cut. Hold gestures fire onTakeStart/Finish in addition. */
  onTake?: () => void;
  /** Pointer pressed down on TAKE — record the press start time externally. */
  onTakeStart?: () => void;
  /** Pointer released on TAKE — overwrite from press-start to release. */
  onTakeFinish?: () => void;
  /** True when this cam has been nudged off its primary algorithm
   *  alignment (override / drag / alternate candidate selected). When
   *  true a small ↺ button appears so the user can revert. */
  canReset?: boolean;
  /** Reset this cam to the primary candidate, no override, no startOffset. */
  onReset?: () => void;
  /** Optional delete handler. When provided, a small × button shows on
   *  hover. Caller is responsible for any confirm gating before
   *  destroying the cam — keeps the count-aware confirm dialog at the
   *  caller, which can read pills/cuts/fx. */
  onDelete?: () => void;
  height?: number;
  /** When true, render a compact (~64 px) variant: drop the filename
   *  + reset chevron + delete affordance, condense "CAM 1" to "1",
   *  shrink the TAKE button to a square. Used on phone-sized
   *  viewports where the default 156 px header eats >50% of the
   *  timeline canvas. */
  compact?: boolean;
}

const HEADER_W = 156;
/** Compact width — keeps a 28 px square TAKE button + a one-digit cam
 *  number column inside a column small enough that the timeline canvas
 *  retains the lion's share of a 280–390 px wide phone screen. */
export const HEADER_W_COMPACT = 64;

export function LaneHeader({
  name,
  filename,
  color,
  status,
  hotkeyLabel,
  selected = false,
  pressed = false,
  painting = false,
  preparing = false,
  onSelectClip,
  onTake,
  onTakeStart,
  onTakeFinish,
  canReset = false,
  onReset,
  onDelete,
  height = 80,
  compact = false,
}: Props) {
  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Tap = onTake (insert the cut at press time). Hold release later
    // calls onTakeFinish to apply the overwrite-range.
    onTake?.();
    onTakeStart?.();
  };
  const handlePointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onTakeFinish?.();
  };
  const handlePointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onTakeFinish?.();
  };

  // The header packs into a half-height row (48 px by default). Layout:
  //
  //   ┌─┬───────────────────────────────┬────────┐
  //   │ │ ● CAM 1                    ↺  │   ¹    │
  //   │■│ try2handy.mp4 …               │  TAKE  │
  //   └─┴───────────────────────────────┴────────┘
  //
  // - Left: cam-colour edge stripe (full height).
  // - Top text row: tally dot + cam name. Status is encoded by the dot
  //   colour alone (no "ON AIR" / "READY" text).
  // - Bottom text row: filename, full inner width, single line truncated.
  // - Reset (↺) tucks into the top-right of the labels area.
  // - Right: TAKE button with the keyboard-shortcut number as a small
  //   superscript badge in its top-right corner — replaces the standalone
  //   hotkey "1" badge that used to look like a clickable button.
  const TAKE_W = compact ? 28 : 44;
  const TAKE_H = Math.max(28, height - 8);
  const tallyColor =
    status === "on-air"
      ? "#FF3326"
      : status === "available"
        ? "#3F8F5A"
        : "#9A8F80";
  const tallyShadow =
    status === "on-air" ? "0 0 4px rgba(255,51,38,0.55)" : "inset 0 0 0 0.5px rgba(0,0,0,0.15)";
  // "Cam 1" → "1" on compact (~64 px width). Strip the prefix once at
  // render time so the JSX stays one path and the shortcut hotkey badge
  // (which uses the cam index) still aligns.
  const compactName =
    name.replace(/^cam\s+/i, "") || name;
  return (
    <div
      className="group relative shrink-0 select-none flex items-stretch overflow-hidden border-r border-b border-rule cursor-pointer bg-paper-hi hover:bg-paper transition-colors"
      style={{
        width: compact ? HEADER_W_COMPACT : HEADER_W,
        height,
        boxShadow: selected ? `inset 3px 0 0 ${color}` : undefined,
      }}
      onClick={onSelectClip}
    >
      {/* Delete affordance — pinned to the top-left corner of the
       *  whole header (over the cam-color stripe edge), styled like
       *  the transport's secondary ChunkyButton: paper-hi face,
       *  embossed shadow, ink text. Always-visible so the affordance
       *  is discoverable without hover. Confirm gating is the
       *  caller's responsibility (Editor.tsx — needs cut/FX counts). */}
      {onDelete && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute top-0 left-0 z-20 w-[14px] h-[14px] flex items-center justify-center rounded-br-md border-r border-b border-rule/60 bg-hot text-paper-hi shadow-emboss hover:bg-hot-pressed active:shadow-pressed font-mono text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ×
        </button>
      )}
      {/* Cam-color edge stripe — full-height solid bar. Slimmer in
       *  compact mode so the inside columns get more breathing room. */}
      <div
        className="shrink-0"
        style={{ width: compact ? 3 : 5, background: color }}
      />

      {/* Module body — px-1 in compact (8 px less padding to widen the
       *  TAKE/label region inside ~64 px). */}
      <div
        className={[
          "flex-1 relative flex items-center min-w-0",
          compact ? "px-1 py-1 gap-1" : "px-2 py-1.5 gap-2",
        ].join(" ")}
      >
        <div className={`flex-1 min-w-0 flex flex-col gap-0.5 ${compact ? "" : "pr-1"}`}>
          {/* Top row: tally dot + cam name + reset action. */}
          <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
            <span
              aria-hidden
              className="block w-[6px] h-[6px] rounded-full shrink-0"
              style={{
                background: tallyColor,
                boxShadow: tallyShadow,
                opacity: status === "off" ? 0.45 : 1,
              }}
              title={
                status === "on-air"
                  ? "On air"
                  : status === "available"
                    ? "Ready"
                    : "Off"
              }
            />
            <span className="font-display font-semibold text-[11px] tracking-label uppercase text-ink leading-none truncate">
              {compact ? compactName : name}
            </span>
            {canReset && onReset && !compact && (
              <button
                type="button"
                aria-label="Reset alignment to detected"
                title="Reset alignment to detected"
                onClick={(e) => {
                  e.stopPropagation();
                  onReset();
                }}
                className="ml-auto shrink-0 w-4 h-4 flex items-center justify-center font-mono text-[12px] leading-none text-ink-3 hover:text-hot transition-colors"
              >
                ↺
              </button>
            )}
          </div>
          {/* Filename — desktop only. On compact phone widths it would
           *  be cut off after 4–5 chars and just adds visual noise. The
           *  full filename is still available via the cam's tooltip /
           *  the OPTIONS panel when the lane is selected. */}
          {!compact && (
            <span
              className="font-mono text-[9px] text-ink-3 leading-snug truncate min-w-0"
              title={filename}
            >
              {filename}
            </span>
          )}
          {preparing && (
            <span
              className="inline-flex items-center gap-1 font-display tracking-label uppercase text-[8.5px] text-hot mt-0.5"
              role="status"
              aria-live="polite"
            >
              <span
                aria-hidden
                className="inline-block w-[5px] h-[5px] rounded-full bg-hot animate-pulse"
                style={{ boxShadow: "0 0 4px rgba(255,87,34,0.85)" }}
              />
              {compact ? "" : "prep"}
            </span>
          )}
        </div>

        {/* TAKE button — slimmer, with the keyboard-hotkey number as a
         * small superscript badge in the top-right so the user knows
         * which key fires this button. The badge is purely decorative
         * (the global keydown handler in Editor.tsx does the dispatch). */}
        <button
          type="button"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          // Suppress the platform long-press callout so the
          // hold-to-paint gesture isn't interrupted by a "save image
          // / select all" context menu on phones.
          onContextMenu={(e) => e.preventDefault()}
          aria-label={
            hotkeyLabel
              ? `Take ${name} — keyboard shortcut ${hotkeyLabel} (hold to overwrite range)`
              : `Take ${name} (hold to overwrite range)`
          }
          className="relative shrink-0 transition-transform"
          style={{
            width: TAKE_W,
            height: TAKE_H,
            transform: pressed ? "translateY(2px)" : undefined,
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
            touchAction: "none",
          }}
        >
          <span
            className="absolute inset-0 rounded-md flex items-center justify-center"
            style={takeFace(status === "on-air", pressed, painting, color)}
          >
            <span
              className={[
                "font-display font-semibold tracking-label uppercase leading-none",
                // Compact (~28 px square button): 8 px caption, "REC"
                // and "TAKE" both still fit comfortably without
                // truncation. Full size keeps the original 10 px.
                compact ? "text-[8px]" : "text-[10px]",
              ].join(" ")}
              style={{
                color: painting
                  ? "#FFF"
                  : status === "on-air"
                    ? "#FF3326"
                    : "#1A1816",
                textShadow: painting
                  ? "0 1px 1px rgba(0,0,0,0.45)"
                  : status === "on-air"
                    ? "0 0 4px rgba(255,51,38,0.35)"
                    : "0 1px 0 rgba(255,255,255,0.4)",
                transition: "color 120ms ease",
              }}
            >
              {painting ? "REC" : "TAKE"}
            </span>
          </span>
          {hotkeyLabel && (
            <span
              aria-hidden
              className="absolute font-mono leading-none pointer-events-none"
              style={{
                top: 2,
                right: 3,
                fontSize: 8,
                color: "rgba(26,24,22,0.55)",
                fontWeight: 600,
                letterSpacing: "0.04em",
              }}
            >
              {hotkeyLabel}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

LaneHeader.WIDTH = HEADER_W;
LaneHeader.WIDTH_COMPACT = HEADER_W_COMPACT;

/**
 * Recessed paper-toned button face.
 *   - Resting: subtle inset rule.
 *   - ON AIR: inset cam-red stroke around the perimeter.
 *   - Pressed (hold start): button face goes pressed-shadow.
 *   - Painting (hold > 500 ms): face fills with cam color, "REC" pulses
 *     above. The cam color creeping out of the recessed face mirrors the
 *     live cam-color paint creeping across the PROGRAM strip — same
 *     gesture, two visual cues.
 */
function takeFace(
  onAir: boolean,
  pressed: boolean,
  painting: boolean,
  color: string,
): CSSProperties {
  if (painting) {
    return {
      background: `linear-gradient(180deg, ${color} 0%, ${color}cc 100%)`,
      boxShadow:
        "inset 0 0 0 1.5px rgba(255,255,255,0.45), inset 0 2px 3px rgba(0,0,0,0.35), 0 0 8px rgba(255,51,38,0.55)",
      animation: "vas-rec-pulse 1.1s ease-in-out infinite",
    };
  }
  if (pressed) {
    return {
      background: "linear-gradient(180deg, #E2D9C0 0%, #D5CAA8 100%)",
      boxShadow:
        "inset 0 2px 3px rgba(0,0,0,0.22), inset 0 -1px 0 rgba(255,255,255,0.25), 0 0 0 1.5px rgba(0,0,0,0.15)",
    };
  }
  return {
    background: "linear-gradient(180deg, #FAF6EC 0%, #EFE7D2 100%)",
    boxShadow: onAir
      ? "inset 0 0 0 1.5px #FF3326, inset 0 1px 0 rgba(255,255,255,0.65), inset 0 -1px 0 rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)"
      : "inset 0 0 0 1px rgba(154,143,128,0.55), inset 0 1px 0 rgba(255,255,255,0.65), inset 0 -1px 0 rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
  };
}
