/**
 * Drag/wheel/dblclick interaction layer for the Stage in the live preview.
 *
 * The overlay sits on top of the compositor canvas inside `OutputFrameBox`.
 * It targets the CURRENTLY ACTIVE element (per the cuts at the playhead) —
 * exactly what the compositor draws — and lets the user pan/zoom that
 * element's viewport transform in place.
 *
 * Visual language:
 *   - On hover OR while interacting: 4 hot-orange L-shaped corner marks
 *     anchored to the active element's bounds (not the Stage). Marks may
 *     overflow the Stage when the element is scaled / translated past the
 *     edge — that's deliberate, the user is meant to see where the element
 *     actually is.
 *   - During drag/wheel: marks go fully opaque + soft glow + a small
 *     readout chip tracks the current scale + offset (mono digits, top-
 *     left of Stage).
 *   - When the transform is non-default: a tiny "↻ reset" hint is visible
 *     bottom-right; click resets, double-click on the element does the same.
 *
 * Why no permanent resize handles: the brief was "no 2D-Studio aesthetic".
 * Drag = translate. Wheel = scale. That's it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../store";
import {
  buildElementFitRect,
  DEFAULT_VIEWPORT_TRANSFORM,
} from "../render/element-transform";
import { resolveOutputDims } from "../output-frame";
import {
  clipEffectiveDisplayDims,
  type ViewportTransform,
} from "../types";

// Default speeds tuned for trackpad / scroll-wheel control. Alt-held
// gives an extra ~4–5× precision boost for fine framing.
const SCALE_STEP = 1.01; // wheel-tick multiplier
const SCALE_STEP_FINE = 1.002; // alt-held
const DRAG_FACTOR = 0.2;
const PRECISION_DRAG_FACTOR = 0.05; // alt-held
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
const READOUT_TIMEOUT_MS = 800;

export function StageInteractionOverlay() {
  const exportSpec = useEditorStore((s) => s.exportSpec);
  const clips = useEditorStore((s) => s.clips);
  const currentTime = useEditorStore((s) => s.playback.currentTime);
  const activeCamId = useEditorStore((s) => s.activeCamId(currentTime));
  const setClipViewportTransform = useEditorStore(
    (s) => s.setClipViewportTransform,
  );
  const resetClipViewportTransform = useEditorStore(
    (s) => s.resetClipViewportTransform,
  );

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [readoutVisible, setReadoutVisible] = useState(false);
  const readoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active clip + its dims + its current transform.
  const activeClip = useMemo(
    () => clips.find((c) => c.id === activeCamId) ?? null,
    [clips, activeCamId],
  );
  const stage = useMemo(
    () => resolveOutputDims(clips, exportSpec.resolution),
    [clips, exportSpec.resolution],
  );
  const elemDims = activeClip ? clipEffectiveDisplayDims(activeClip) : null;
  const transform: ViewportTransform =
    activeClip?.viewportTransform ?? DEFAULT_VIEWPORT_TRANSFORM;
  const isDefault =
    transform.scale === 1 && transform.x === 0 && transform.y === 0;

  // Stage-px element rect — same math the compositor uses.
  const elemRect =
    stage && elemDims ? buildElementFitRect(elemDims, stage, transform) : null;

  // Map Stage-px → CSS-px (the overlay div is sized to the Stage in CSS).
  const overlayRect = overlayRef.current?.getBoundingClientRect();
  const cssScaleX =
    stage && overlayRect && stage.w > 0 ? overlayRect.width / stage.w : 1;
  const cssScaleY =
    stage && overlayRect && stage.h > 0 ? overlayRect.height / stage.h : 1;

  function showReadout() {
    setReadoutVisible(true);
    if (readoutTimer.current) clearTimeout(readoutTimer.current);
    readoutTimer.current = setTimeout(() => {
      setReadoutVisible(false);
    }, READOUT_TIMEOUT_MS);
  }

  // ---- Drag (translate) ----
  // We track "last client x/y" + "last transform x/y" so each move
  // event applies an INCREMENTAL delta scaled by the current alt-state.
  // (Tracking a fixed start would jump the element when alt is pressed
  // mid-drag because the cumulative delta would suddenly be re-scaled.)
  const dragRef = useRef<{
    lastClientX: number;
    lastClientY: number;
    lastX: number;
    lastY: number;
    pointerId: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activeClip || !stage) return;
      // Left button only.
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        lastX: transform.x,
        lastY: transform.y,
        pointerId: e.pointerId,
      };
      setInteracting(true);
    },
    [activeClip, stage, transform.x, transform.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !activeClip || !stage) return;
      // Incremental client-pixel delta → stage-pixel delta, scaled by
      // alt-precision factor for fine control.
      const sx = cssScaleX === 0 ? 1 : 1 / cssScaleX;
      const sy = cssScaleY === 0 ? 1 : 1 / cssScaleY;
      const k = e.altKey ? PRECISION_DRAG_FACTOR : DRAG_FACTOR;
      const dx = (e.clientX - drag.lastClientX) * sx * k;
      const dy = (e.clientY - drag.lastClientY) * sy * k;
      const nextX = drag.lastX + dx;
      const nextY = drag.lastY + dy;
      drag.lastClientX = e.clientX;
      drag.lastClientY = e.clientY;
      drag.lastX = nextX;
      drag.lastY = nextY;
      setClipViewportTransform(activeClip.id, { x: nextX, y: nextY });
      showReadout();
    },
    [activeClip, stage, cssScaleX, cssScaleY, setClipViewportTransform],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === e.pointerId) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // Capture may already be lost — non-fatal.
        }
        dragRef.current = null;
        setInteracting(false);
      }
    },
    [],
  );

  // ---- Wheel (scale) ----
  // We attach a non-passive native wheel listener so we can preventDefault
  // the page-scroll behaviour. React's onWheel is passive in modern Chrome,
  // and `e.preventDefault()` on a passive listener silently no-ops.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el || !activeClip) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.altKey ? SCALE_STEP_FINE : SCALE_STEP;
      const factor = e.deltaY < 0 ? step : 1 / step;
      const next = Math.max(
        SCALE_MIN,
        Math.min(SCALE_MAX, transform.scale * factor),
      );
      if (next === transform.scale) return;
      setClipViewportTransform(activeClip.id, { scale: next });
      showReadout();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
    // We intentionally re-bind on transform.scale change so the handler
    // closes over the latest value — cheap (one event listener swap per
    // wheel tick) and keeps the multiplier stable.
  }, [activeClip, transform.scale, setClipViewportTransform]);

  function onDoubleClick() {
    if (!activeClip) return;
    resetClipViewportTransform(activeClip.id);
    showReadout();
  }

  // No active element → no overlay (TestPattern is showing).
  if (!activeClip || !stage || !elemRect) {
    return (
      <div
        ref={overlayRef}
        aria-hidden
        className="absolute inset-0"
        style={{ pointerEvents: "none" }}
      />
    );
  }

  // Element rect in CSS pixels, relative to the Stage origin (top-left).
  const cssElem = {
    left: elemRect.x * cssScaleX,
    top: elemRect.y * cssScaleY,
    width: elemRect.w * cssScaleX,
    height: elemRect.h * cssScaleY,
  };

  const showMarks = hovered || interacting;
  const cursor = interacting ? "grabbing" : "grab";

  return (
    <div
      ref={overlayRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onDoubleClick={onDoubleClick}
      className="absolute inset-0 select-none touch-none"
      // The OutputFrameBox wrapper has `pointer-events: none` so the
      // CSS layer beneath the canvas doesn't eat clicks. We need to
      // re-enable pointer events on this overlay explicitly so drag /
      // wheel / dblclick reach us.
      style={{ cursor, zIndex: 5, pointerEvents: "auto" }}
    >
      {(showMarks || readoutVisible) && (
        <ElementCornerMarks rect={cssElem} active={interacting || readoutVisible} />
      )}
      {readoutVisible && <Readout transform={transform} />}
      {!isDefault && !interacting && !readoutVisible && (
        <ResetHint onClick={onDoubleClick} />
      )}
    </div>
  );
}

function ElementCornerMarks({
  rect,
  active,
}: {
  rect: { left: number; top: number; width: number; height: number };
  active: boolean;
}) {
  const SIZE = 14;
  const W = 2;
  const COLOR = active ? "rgba(255,87,34,1)" : "rgba(255,87,34,0.65)";
  const glow = active ? "drop-shadow(0 0 4px rgba(255,87,34,0.55))" : "none";
  return (
    <div
      aria-hidden
      className="absolute pointer-events-none"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        filter: glow,
        transition: "filter 0.12s ease",
      }}
    >
      {/* Top-left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: SIZE,
          height: W,
          backgroundColor: COLOR,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: W,
          height: SIZE,
          backgroundColor: COLOR,
        }}
      />
      {/* Top-right */}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: SIZE,
          height: W,
          backgroundColor: COLOR,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: W,
          height: SIZE,
          backgroundColor: COLOR,
        }}
      />
      {/* Bottom-left */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: SIZE,
          height: W,
          backgroundColor: COLOR,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: W,
          height: SIZE,
          backgroundColor: COLOR,
        }}
      />
      {/* Bottom-right */}
      <div
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: SIZE,
          height: W,
          backgroundColor: COLOR,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: W,
          height: SIZE,
          backgroundColor: COLOR,
        }}
      />
    </div>
  );
}

function Readout({ transform }: { transform: ViewportTransform }) {
  const pct = Math.round(transform.scale * 100);
  const x = Math.round(transform.x);
  const y = Math.round(transform.y);
  return (
    <div
      aria-hidden
      className="absolute font-mono text-[11px] tabular text-paper-hi pointer-events-none"
      style={{
        left: 8,
        top: 8,
        padding: "3px 7px",
        backgroundColor: "rgba(0,0,0,0.55)",
        borderRadius: 4,
        letterSpacing: 0.5,
      }}
    >
      {pct}% · {x},{y}
    </div>
  );
}

function ResetHint({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      // Stop pointer-down from bubbling to the overlay's drag handler —
      // otherwise the parent captures the pointer and we never receive
      // the click. (No drag should start when aiming for this button.)
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute font-display text-[10px] tracking-label uppercase text-paper-hi/80 hover:text-paper-hi"
      style={{
        right: 8,
        bottom: 8,
        padding: "3px 7px",
        backgroundColor: "rgba(0,0,0,0.45)",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      ↻ reset
    </button>
  );
}
