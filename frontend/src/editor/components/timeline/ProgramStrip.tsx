/**
 * PROGRAM-Strip — the "golden path" above the lanes.
 *
 * Looks like a piece of brushed-metal magnetic tape running across the
 * timeline. The active cam at each time is shown as an inset colored
 * segment — like painted leader tape. Cuts appear as small brass splice
 * tabs between two segments.
 *
 * Future-proof: the strip will also carry beat/bar tick marks (Schritt 1
 * lays down the visual frame; the marks themselves come later). The
 * sprocket-hole row at the top is the natural place for those ticks.
 */
import {
  CSSProperties,
  memo,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Cut } from "../../../storage/jobs-db";
import { activeCamAt } from "../../cuts";
import type { PunchFx } from "../../fx/types";
import { FxStripLayer } from "./FxStripLayer";
import { tapeHeightForMode } from "./tape-height";
import { useLongPressClear } from "./useLongPressClear";

import { clamp } from "../../../lib/clamp";
/** Hold-to-clear duration: 3 s feels deliberate (an accidental click
 *  doesn't trigger it) but not punishing. The user cancels by lifting
 *  or pressing Esc. */
const CLEAR_HOLD_MS = 3000;

interface CamLookup {
  id: string;
  color: string;
  range: { startS: number; endS: number };
}

interface Props {
  cuts: readonly Cut[];
  cams: readonly CamLookup[];
  /** Master timeline duration in seconds (for unzoomed coverage). */
  duration: number;
  viewStartS: number;
  viewEndS: number;
  width: number;
  height?: number;
  /** Called when the user clicks the × on a hovered splice to delete it. */
  onRemoveCut?: (atTimeS: number, camId: string) => void;
  /** Called continuously while the user drags a splice tab. Receives the
   *  raw new master-time and the modifier-key state; the parent applies
   *  snap (or not) and returns the time the cut actually committed to
   *  so we can use it as the next drag-tick's identity. */
  onCutDrag?: (
    fromAtTimeS: number,
    camId: string,
    rawNewAtTimeS: number,
    e: { shiftKey: boolean },
  ) => number;
  /** Live paint preview for an active hold gesture in paint mode. Renders
   * a translucent cam-color wash from `fromS` to the playhead and a
   * pulsing "head" at the leading edge — the on-air tape recorder vibe. */
  paintPreview?: {
    fromS: number;
    toS: number;
    color: string;
    camLabel: string;
  } | null;
  /** Match-snap candidates surfaced for the user — tall ticks across the
   *  tape so they're visible during a clip-drag in MATCH mode. Coloured
   *  entirely by confidence (red→amber→green heatmap); cam attribution
   *  is implicit because the user is dragging exactly one cam. */
  matchMarkers?: ReadonlyArray<{
    /** Master-timeline time (seconds) where the candidate would land
     *  the dragging clip's start. */
    t: number;
    /** 0..1 confidence — drives the heatmap colour and the badge text. */
    confidence: number;
    /** Whether this is the currently selected candidate (highlight). */
    isPrimary: boolean;
  }>;
  /** Display mode — what the strip shows. Default "cuts" preserves the
   *  legacy single-purpose look. "fx" replaces cam-color program-segments
   *  with the FX-tape (full strip height). "both" splits: cuts on top,
   *  fx on bottom, divided by a 1px etched line. */
  mode?: "cuts" | "fx" | "both";
  fx?: readonly PunchFx[];
  /** FX IDs currently being live-extended via a hold gesture. Drives the
   *  fx-tape's leading-edge pulse animation. */
  liveFxIds?: ReadonlySet<string>;
  /** Long-press-to-clear handlers — fired after a 3 s hold on the
   *  matching strip. Visual feedback (red fill animation) is rendered
   *  by ProgramStrip itself; the parent only commits the deletion. */
  onClearCuts?: () => void;
  onClearFx?: () => void;
  /** Optional 0..1 progress from the keyboard-driven X-hold-to-clear
   *  gesture. Mirrored onto whichever lanes the current `mode` shows
   *  so the user gets the same red sweep regardless of whether they
   *  held the strip with a finger or held X with the keyboard. */
  externalClearProgress?: number | null;
}

const EMPTY_LIVE_FX_IDS: ReadonlySet<string> = new Set();

/** Memoized: the Timeline re-renders every playback frame (its canvas
 *  subscribes to timelineT), but the strip's inputs only change on real
 *  edits / scroll / zoom. With stable props from the Timeline, memo()
 *  drops the strip's per-frame DOM reconciliation (program segments +
 *  splice tabs + FX capsules) during passive playback. */
export const ProgramStrip = memo(ProgramStripImpl);

function ProgramStripImpl({
  cuts,
  cams,
  duration,
  viewStartS,
  viewEndS,
  width,
  height,
  onRemoveCut,
  onCutDrag,
  paintPreview,
  matchMarkers,
  mode = "cuts",
  fx,
  liveFxIds = EMPTY_LIVE_FX_IDS,
  onClearCuts,
  onClearFx,
  externalClearProgress = null,
}: Props) {
  // Long-press timers per strip — independent so a hold on the cuts
  // strip doesn't show a phantom red fill on the FX strip and vice versa.
  const cutsLP = useLongPressClear({
    durationMs: CLEAR_HOLD_MS,
    onComplete: () => onClearCuts?.(),
    disabled: !onClearCuts,
  });
  const fxLP = useLongPressClear({
    durationMs: CLEAR_HOLD_MS,
    onComplete: () => onClearFx?.(),
    disabled: !onClearFx,
  });
  // Default height is mode-dependent so FX-only and both layouts get
  // chunkier strips without the caller having to pass it through.
  const stripHeight = height ?? tapeHeightForMode(mode);
  const showCuts = mode === "cuts" || mode === "both";
  const showFx = mode === "fx" || mode === "both";
  // Vertical layout (in CSS px from the strip's content area):
  //   cuts mode: cuts fill 3..(height-3)
  //   fx mode:   fx fills 3..(height-3)
  //   both mode: cuts top half, fx bottom half (with 1px etched divider)
  // Slim 3-px top/bottom rims keep the embossed inner highlight visible
  // without stealing height from the tape itself.
  const contentTop = 3;
  const contentBottom = 3;
  const contentHeight = Math.max(0, stripHeight - contentTop - contentBottom);
  const splitMidY = mode === "both" ? contentTop + Math.floor(contentHeight / 2) : 0;
  const fxLayerTop = mode === "both" ? splitMidY + 1 : contentTop;
  const fxLayerHeight =
    mode === "both"
      ? contentTop + contentHeight - fxLayerTop - contentBottom
      : contentHeight;
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Drag state for moving an existing cut. Tracks the cut's *current*
   *  master-time (which evolves on every pointer-move tick) plus the
   *  grab-offset so the cursor stays anchored to the same point on the
   *  tab. The state lives here (not in SpliceTab) because the cut's
   *  atTimeS — and therefore the SpliceTab's React key — changes during
   *  the drag; a remount would otherwise drop the pointer capture. */
  const dragCutRef = useRef<{
    camId: string;
    currentT: number;
    grabOffsetT: number;
  } | null>(null);

  const beginCutDrag = (cut: Cut, e: ReactPointerEvent<HTMLElement>) => {
    if (!onCutDrag) return;
    if (!containerRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const visibleSpan = Math.max(1e-6, viewEndS - viewStartS);
    const pointerT = viewStartS + ((e.clientX - rect.left) / width) * visibleSpan;
    dragCutRef.current = {
      camId: cut.camId,
      currentT: cut.atTimeS,
      grabOffsetT: pointerT - cut.atTimeS,
    };

    const onMove = (ev: PointerEvent) => {
      const drag = dragCutRef.current;
      if (!drag || !containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const newPointerT = viewStartS + ((ev.clientX - r.left) / width) * visibleSpan;
      const requestedT = newPointerT - drag.grabOffsetT;
      const committedT = onCutDrag(drag.currentT, drag.camId, requestedT, {
        shiftKey: ev.shiftKey,
      });
      drag.currentT = committedT;
    };
    const onUp = () => {
      dragCutRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const [hoveredCut, setHoveredCut] = useState<{ atTimeS: number; camId: string } | null>(null);
  // Compute the program — a flat list of {startS, endS, color} segments
  // covering [0, duration]. Each segment ends where the active cam changes
  // (either via a cut or because the chosen cam runs out of material and
  // activeCamAt falls back).
  const segments = useMemo(
    () => buildProgram(cuts, cams, duration),
    [cuts, cams, duration],
  );

  const visibleSpan = Math.max(1e-6, viewEndS - viewStartS);
  const tToX = (t: number) => ((t - viewStartS) / visibleSpan) * width;

  const tapeStyle: CSSProperties = {
    background: `
      repeating-linear-gradient(90deg, transparent 0, transparent 1.5px, rgba(0,0,0,0.05) 1.6px, transparent 2.2px),
      linear-gradient(180deg, #C8BC9A 0%, #D6CCAE 35%, #BFB18C 100%)
    `,
    boxShadow:
      "inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.25), 0 1px 1px rgba(0,0,0,0.08)",
    height: stripHeight,
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full border-y border-[#9F9170] select-none"
      style={tapeStyle}
    >
      {/* Cam-color program segments — inset like painted leader tape.
        * In `both` mode the segments are clipped to the top half so the FX
        * lane fills the bottom half. In `fx` mode they're skipped entirely.
        * Long-press anywhere on this lane (3 s) wipes all cuts; splice
        * tabs stop event propagation so dragging / X-click them does NOT
        * fire the clear gesture. */}
      {showCuts && (
      <div
        className="absolute left-0 right-0 overflow-hidden"
        style={{
          top: contentTop,
          // In "both" mode, leave room for the FX layer + 1 px etched divider.
          bottom: mode === "both" ? stripHeight - splitMidY : contentBottom,
          touchAction: onClearCuts ? "none" : undefined,
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
        onPointerDown={onClearCuts ? cutsLP.start : undefined}
        onPointerUp={onClearCuts ? cutsLP.cancel : undefined}
        onPointerCancel={onClearCuts ? cutsLP.cancel : undefined}
        onPointerLeave={onClearCuts ? cutsLP.cancel : undefined}
        // Block the long-press callout — the 3-s hold-to-clear-all-cuts
        // gesture would otherwise be hijacked by the platform context
        // menu on Android Chrome / iOS Safari.
        onContextMenu={(e) => e.preventDefault()}
      >
        {segments.map((seg, i) => {
          const x1 = tToX(seg.startS);
          const x2 = tToX(seg.endS);
          if (x2 < 0 || x1 > width) return null;
          const left = Math.max(0, x1);
          const right = Math.min(width, x2);
          if (right <= left) return null;
          if (seg.color === null) {
            // No-cam segment — show as the bare tape, no painted strip
            return null;
          }
          return (
            <div
              key={i}
              className="absolute top-0 bottom-0"
              style={{
                left,
                width: right - left,
                background: `linear-gradient(180deg, ${seg.color} 0%, ${seg.color} 50%, ${darken(seg.color, 0.18)} 100%)`,
                boxShadow:
                  "inset 0 1px 1px rgba(255,255,255,0.4), inset 0 -1px 1px rgba(0,0,0,0.28)",
              }}
              title={`${seg.startS.toFixed(2)}s — ${seg.endS.toFixed(2)}s`}
            />
          );
        })}
      </div>
      )}

      {/* Live paint preview — translucent wash from press start to current
        * playhead, plus a pulsing "head" at the leading edge. Sits above
        * the cam-color program segments so the user sees what their hold
        * gesture will commit on release. */}
      {showCuts && paintPreview && (() => {
        const lo = Math.min(paintPreview.fromS, paintPreview.toS);
        const hi = Math.max(paintPreview.fromS, paintPreview.toS);
        const x1 = tToX(lo);
        const x2 = tToX(hi);
        if (x2 <= 0 || x1 >= width) return null;
        const left = Math.max(0, x1);
        const right = Math.min(width, x2);
        const headIsRight = paintPreview.toS >= paintPreview.fromS;
        return (
          <>
            <div
              className="absolute pointer-events-none"
              style={{
                left,
                width: right - left,
                top: 9,
                bottom: 3,
                background: `linear-gradient(180deg, ${paintPreview.color}cc 0%, ${paintPreview.color} 50%, ${darken(paintPreview.color, 0.18)}cc 100%)`,
                boxShadow:
                  "inset 0 1px 1px rgba(255,255,255,0.55), inset 0 -1px 1px rgba(0,0,0,0.32), 0 0 6px rgba(255,51,38,0.45)",
              }}
            />
            {/* Leading edge — the "tape recorder head" */}
            <div
              className="absolute pointer-events-none"
              style={{
                left: (headIsRight ? right : left) - 1,
                top: 5,
                bottom: -1,
                width: 2,
                background: "#FFF",
                boxShadow: `0 0 6px ${paintPreview.color}, 0 0 10px rgba(255,51,38,0.7)`,
                animation: "vas-paint-head 0.7s ease-in-out infinite",
              }}
            />
            {/* "REC · CAM N" badge floating above the head */}
            <div
              className="absolute font-display font-semibold text-[9px] tracking-label uppercase pointer-events-none"
              style={{
                left: Math.max(2, Math.min(width - 60, (headIsRight ? right : left) - 28)),
                top: -16,
                color: "#FF3326",
                textShadow: "0 0 6px rgba(255,51,38,0.8), 0 1px 0 rgba(0,0,0,0.25)",
                whiteSpace: "nowrap",
              }}
            >
              ● REC · {paintPreview.camLabel}
            </div>
          </>
        );
      })()}

      {/* Match-snap candidate markers — shown over the tape during a
       * clip-drag in MATCH mode. The user already knows which cam they're
       * dragging (it's the one under their finger), so the marker itself
       * is colored entirely by *confidence* (red→amber→green heatmap):
       * cam attribution is irrelevant here. Numeric badges show the
       * percentage; if two markers are too close, the lower-confidence
       * label is hidden so they never overlap. */}
      {showCuts && matchMarkers && matchMarkers.length > 0 &&
        (() => {
          // Pre-compute screen positions and sort by x so we can do a
          // single-pass collision check on the percent labels.
          const items = matchMarkers
            .map((m, i) => {
              const x = tToX(m.t);
              return { m, i, x };
            })
            .filter(({ x }) => x >= -10 && x <= width + 10)
            .sort((a, b) => a.x - b.x);
          const LABEL_W = 22;
          const LABEL_GAP = 2;
          // Hide the label of any marker whose label box would intersect
          // a higher-confidence neighbour. Primary always wins.
          const showLabel = new Array<boolean>(items.length).fill(true);
          for (let a = 0; a < items.length; a++) {
            for (let b = a + 1; b < items.length; b++) {
              if (Math.abs(items[a].x - items[b].x) > LABEL_W + LABEL_GAP) break;
              const aWins =
                items[a].m.isPrimary ||
                (!items[b].m.isPrimary &&
                  items[a].m.confidence >= items[b].m.confidence);
              if (aWins) showLabel[b] = false;
              else showLabel[a] = false;
            }
          }
          return items.map(({ m, i, x }, listIdx) => {
            const headSize = m.isPrimary ? 11 : 8;
            const minLeft = headSize / 2 + 1;
            const maxLeft = width - headSize / 2 - 1;
            const xClamped = Math.max(minLeft, Math.min(maxLeft, x));
            const tickW = m.isPrimary ? 3 : 2;
            const conf = Math.max(0, Math.min(1, m.confidence));
            const heatColor = confidenceColor(conf);
            const opacity = m.isPrimary ? 1 : Math.max(0.6, conf);
            return (
              <div
                key={`mm-${i}`}
                className="absolute pointer-events-none"
                style={{
                  left: Math.floor(xClamped) - tickW / 2,
                  top: 0,
                  bottom: 0,
                  width: tickW,
                  background: heatColor,
                  opacity,
                  boxShadow: m.isPrimary
                    ? `0 0 6px ${heatColor}, 0 0 1px rgba(0,0,0,0.6)`
                    : "0 0 1px rgba(0,0,0,0.5)",
                }}
              >
                {/* Diamond head — same heat color as the body. Active
                 * candidate gets a brighter inner halo. */}
                <span
                  className="absolute pointer-events-none"
                  style={{
                    top: -3,
                    left: tickW / 2 - headSize / 2,
                    width: headSize,
                    height: headSize,
                    background: heatColor,
                    transform: "rotate(45deg)",
                    boxShadow: m.isPrimary
                      ? `0 0 0 1.5px rgba(0,0,0,0.5), 0 0 6px ${heatColor}`
                      : "0 0 0 1px rgba(0,0,0,0.5)",
                  }}
                  title={`Match candidate · ${Math.round(conf * 100)}% confidence${m.isPrimary ? " (active)" : ""}`}
                />
                {showLabel[listIdx] && (
                  <span
                    className="absolute font-mono leading-none pointer-events-none"
                    style={{
                      top: 8,
                      left: tickW / 2 - LABEL_W / 2,
                      width: LABEL_W,
                      fontSize: 8,
                      textAlign: "center",
                      color: "rgba(255,255,255,0.95)",
                      textShadow: "0 1px 1px rgba(0,0,0,0.85)",
                      fontWeight: m.isPrimary ? 700 : 500,
                    }}
                  >
                    {Math.round(conf * 100)}
                  </span>
                )}
              </div>
            );
          });
        })()}

      {/* Brass splice tabs at every cut. Hover lifts the tab + reveals an
        * × button for delete. Pointer-down on the tab body starts a
        * drag — pointermove pulls the cut along with the cursor (snap-
        * aware via the parent's onCutDrag callback). In "both" mode the
        * tab height is halved so it fits the top half of the strip. */}
      {showCuts && cuts.map((cut, i) => {
        const x = tToX(cut.atTimeS);
        if (x < -8 || x > width + 8) return null;
        const isHovered =
          hoveredCut !== null &&
          hoveredCut.atTimeS === cut.atTimeS &&
          hoveredCut.camId === cut.camId;
        const tabHeight =
          mode === "both" ? Math.max(12, splitMidY - contentTop + 9) : stripHeight;
        return (
          <SpliceTab
            key={`${cut.atTimeS}-${cut.camId}-${i}`}
            x={x}
            height={tabHeight}
            hovered={isHovered}
            onEnter={() => setHoveredCut({ atTimeS: cut.atTimeS, camId: cut.camId })}
            onLeave={() => setHoveredCut(null)}
            onDelete={(e) => {
              e.stopPropagation();
              onRemoveCut?.(cut.atTimeS, cut.camId);
              setHoveredCut(null);
            }}
            onDragStart={
              onCutDrag ? (e) => beginCutDrag(cut, e) : undefined
            }
          />
        );
      })}

      {/* Etched divider between the cuts (top) and fx (bottom) halves. */}
      {mode === "both" && (
        <div
          aria-hidden
          className="absolute left-0 right-0 pointer-events-none"
          style={{
            top: splitMidY,
            height: 1,
            background:
              "linear-gradient(90deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.18) 50%, rgba(0,0,0,0.45) 100%)",
            boxShadow: "0 1px 0 rgba(255,255,255,0.45)",
          }}
        />
      )}

      {/* FX-Capsule-Lane — full strip in "fx" mode, bottom half in "both".
        * Long-press anywhere on this lane (3 s) wipes all FX. The
        * FxStripLayer itself is `pointer-events: none`, so the wrapper
        * catches every press without children intercepting. */}
      {showFx && fx && (
        <div
          className="absolute left-0 right-0"
          style={{
            top: fxLayerTop,
            height: fxLayerHeight,
            touchAction: onClearFx ? "none" : undefined,
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
          }}
          onPointerDown={onClearFx ? fxLP.start : undefined}
          onPointerUp={onClearFx ? fxLP.cancel : undefined}
          onPointerCancel={onClearFx ? fxLP.cancel : undefined}
          onPointerLeave={onClearFx ? fxLP.cancel : undefined}
          onContextMenu={(e) => e.preventDefault()}
        >
          <FxStripLayer
            fx={fx}
            viewStartS={viewStartS}
            viewEndS={viewEndS}
            width={width}
            height={fxLayerHeight}
            liveFxIds={liveFxIds}
          />
        </div>
      )}

      {/* Long-press red-fill overlays — animate left-to-right while the
       *  user holds. Sit ABOVE the lanes so the user sees the timer
       *  visually walking across. Pointer-events:none so they don't
       *  swallow the still-active long-press handlers underneath. */}
      {(() => {
        // Combine the per-strip pointer-driven progress with the
        // shared keyboard-driven `externalClearProgress`. The keyboard
        // hold targets whichever lanes the current `mode` shows, so we
        // route it onto the cuts lane when cuts are visible, the fx
        // lane when fx is visible, or both lanes in "both" mode.
        const cutsProgress =
          showCuts
            ? Math.max(cutsLP.progress ?? -1, externalClearProgress ?? -1)
            : -1;
        const fxProgress =
          showFx
            ? Math.max(fxLP.progress ?? -1, externalClearProgress ?? -1)
            : -1;
        return (
          <>
            {cutsProgress >= 0 && (
              <ClearProgressOverlay
                progress={cutsProgress}
                top={contentTop}
                bottom={mode === "both" ? stripHeight - splitMidY : contentBottom}
                label="DELETE ALL CUTS"
              />
            )}
            {fxProgress >= 0 && (
              <ClearProgressOverlay
                progress={fxProgress}
                top={fxLayerTop}
                bottom={stripHeight - (fxLayerTop + fxLayerHeight)}
                label="DELETE ALL FX"
              />
            )}
          </>
        );
      })()}
    </div>
  );
}

/** Red bar that fills left-to-right tracking long-press progress.
 *  Positioned absolutely inside the ProgramStrip's container; each
 *  caller passes top/bottom insets so the overlay covers the right
 *  lane region (top half for cuts in "both" mode, bottom half for fx,
 *  full strip otherwise). */
function ClearProgressOverlay({
  progress,
  top,
  bottom,
  label,
}: {
  progress: number;
  top: number;
  bottom: number;
  label: string;
}) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div
      aria-hidden
      className="absolute left-0 right-0 pointer-events-none overflow-hidden"
      style={{
        top,
        bottom,
        // Mute the underlying strip so the red bar reads against a
        // dimmer background — gives the gesture more visual weight
        // without a separate dim layer.
        backgroundColor: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{
          width: `${pct}%`,
          background:
            "linear-gradient(90deg, rgba(192,57,43,0.55) 0%, rgba(192,57,43,0.85) 80%, #FFFFFF 100%)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18), 0 0 8px rgba(192,57,43,0.6)",
          transition: "width 60ms linear",
        }}
      />
      {pct > 18 && (
        <span
          className="absolute top-1/2 -translate-y-1/2 font-display tracking-label uppercase pointer-events-none"
          style={{
            left: 8,
            fontSize: 9,
            color: "#FFF6F4",
            textShadow: "0 1px 0 rgba(0,0,0,0.55), 0 0 6px rgba(192,57,43,0.9)",
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          {label} · {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}

function SpliceTab({
  x,
  height,
  hovered,
  onEnter,
  onLeave,
  onDelete,
  onDragStart,
}: {
  x: number;
  height: number;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onDelete: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Pointer-down on the tab body starts a drag. The parent wires this
   *  up to its own drag-state machinery (window-level pointermove/up). */
  onDragStart?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onDragStart) return;
    // Don't start a drag if the user grabbed the × button.
    const target = e.target as HTMLElement | null;
    if (target?.closest("button")) return;
    onDragStart(e);
  };
  return (
    <div
      // Hit area is wider than the visible tab so it's tappable even on touch.
      className="absolute top-[-2px]"
      style={{
        left: x - 8,
        width: 16,
        height: height + 4,
        cursor: onDragStart ? "ew-resize" : "pointer",
        touchAction: "none",
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onPointerDown={onPointerDown}
    >
      {/* Visible brass tab. When hovered, lift it ~6 px above the strip so
        * the × button has somewhere to live without being clipped. */}
      <div
        className="absolute pointer-events-none transition-transform duration-100"
        style={{
          left: 6,
          width: 4,
          top: 7,
          height: height - 9,
          background:
            "linear-gradient(180deg, #F0D079 0%, #C99A3B 50%, #F0D079 100%)",
          boxShadow:
            "0 0 2px rgba(0,0,0,0.45), inset 0 0 1px rgba(255,255,255,0.55)",
          borderRadius: 1,
          transform: hovered ? "translateY(-6px)" : "translateY(0)",
        }}
      >
        <span
          className="absolute left-[1px] right-[1px] top-[2px] h-[1px] block"
          style={{ background: "rgba(0,0,0,0.45)" }}
        />
        <span
          className="absolute left-[1px] right-[1px] bottom-[2px] h-[1px] block"
          style={{ background: "rgba(0,0,0,0.45)" }}
        />
      </div>

      {/* Delete button — appears above the lifted tab when hovered. */}
      {hovered && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove cut"
          className="absolute z-10 flex items-center justify-center rounded-full bg-paper-hi border border-rule shadow text-ink-2 hover:text-danger hover:border-danger font-mono leading-none"
          style={{
            left: 0,
            top: -2,
            width: 16,
            height: 16,
            fontSize: 11,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

interface ProgramSegment {
  startS: number;
  endS: number;
  /** null = no cam active (will render as bare tape → preview shows test pattern) */
  color: string | null;
}

/**
 * Walk the master timeline from 0 to `duration`, sampling activeCamAt at
 * every cut boundary + every cam-range boundary. Coalesce consecutive
 * samples into segments.
 *
 * Pure: kept inside this file because the data shape (CamLookup includes
 * the color) is UI-specific. The cuts.ts resolver handles the active-cam
 * resolution itself.
 */
function buildProgram(
  cuts: readonly Cut[],
  cams: readonly CamLookup[],
  duration: number,
): ProgramSegment[] {
  if (duration <= 0) return [];

  // Collect interesting timestamps: 0, every cut atTimeS, every cam start/end
  // (clamped to [0, duration]), and `duration`.
  const ts = new Set<number>([0, duration]);
  for (const c of cuts) ts.add(clamp(c.atTimeS, 0, duration));
  for (const cam of cams) {
    ts.add(clamp(cam.range.startS, 0, duration));
    ts.add(clamp(cam.range.endS, 0, duration));
  }
  const sorted = [...ts].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);

  const camRanges = cams.map((c) => ({
    id: c.id,
    startS: c.range.startS,
    endS: c.range.endS,
  }));
  const colorById = new Map(cams.map((c) => [c.id, c.color] as const));

  const segments: ProgramSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = sorted[i];
    const tNext = sorted[i + 1];
    if (tNext - t < 1e-9) continue;
    // Sample mid-point so we land cleanly inside a region (avoids ambiguity
    // exactly at a boundary where startS is inclusive and endS exclusive).
    const sampleT = (t + tNext) / 2;
    const camId = activeCamAt(cuts, sampleT, camRanges);
    const color = camId === null ? null : colorById.get(camId) ?? null;

    if (segments.length > 0 && segments[segments.length - 1].color === color) {
      segments[segments.length - 1].endS = tNext;
    } else {
      segments.push({ startS: t, endS: tNext, color });
    }
  }
  return segments;
}


function darken(hex: string, fraction: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return hex;
  const r = Math.round(parseInt(c.slice(0, 2), 16) * (1 - fraction));
  const g = Math.round(parseInt(c.slice(2, 4), 16) * (1 - fraction));
  const b = Math.round(parseInt(c.slice(4, 6), 16) * (1 - fraction));
  return `#${[r, g, b].map((n) => Math.max(0, n).toString(16).padStart(2, "0")).join("")}`;
}

/** Map a 0..1 confidence value to a heatmap color.
 *  Non-linear hue mapping (≈ pow 2.2) compresses the low end and
 *  expands the high end, so 80 % vs 100 % are clearly different greens
 *  instead of two shades of the same green. Saturation + lightness
 *  also climb with confidence, so high-quality matches *glow* more
 *  than weak ones. */
function confidenceColor(c: number): string {
  const v = Math.max(0, Math.min(1, c));
  // Stretch the high end of the hue ramp:
  //   v=1.00 → hue 135 (full green)
  //   v=0.90 → hue ≈ 105 (green-cyan)
  //   v=0.80 → hue ≈  82 (yellow-green)
  //   v=0.70 → hue ≈  62 (yellow)
  //   v=0.50 → hue ≈  29 (orange)
  //   v=0.30 → hue ≈  10 (red-orange)
  //   v=0.00 → hue   0 (red)
  const hue = Math.pow(v, 2.2) * 135;
  const sat = 70 + 25 * v; // 70 % → 95 %
  const light = 38 + 18 * v; // 38 % → 56 %
  return `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
}
