/**
 * FX-Hardware-Panel — pill-shaped pull tab in the gap-3 between transport
 * and timeline, plus an expandable pad row.
 *
 * Layout strategy:
 *   - Collapsed: container is 12 px tall with mt:-6 and mb:-6, so it
 *     consumes ZERO net vertical space (it slots exactly into the
 *     existing gap-3 with 6 px breathing room above + below). The tab
 *     itself is a small ~96 × 12 px pill centered in the gap, NOT a
 *     full-width strip — that's why the previous design read as
 *     "abgeschnitten" at the edges.
 *   - Expanded: container grows to ~122 px and goes back into normal
 *     flex flow (mt/mb 0). LCD + 2 encoders + pads render below the tab.
 *     Re-clicking the same tab collapses again.
 *
 * Mobile (`pointer: coarse`): always expanded — pads are the only trigger
 *   without a keyboard. Tab is non-interactive on mobile.
 *
 * Recording-Head-Semantik:
 *   - Pad-Press (Tastatur oder Maus) → setzt `selectedFxKind` + startet
 *     `beginFxHold` mit den aktuellen `fxDefaults[kind]`-Werten.
 *   - Encoder-Drehen → schreibt `setFxDefault(kind, paramId, …)`. Die
 *     bereits gepunchten Capsules auf der Timeline sind frozen und
 *     bleiben unangetastet — du editierst nur, was als nächstes
 *     geschrieben wird (wie eine Tape-Maschine).
 */
import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../store";
import { fxCatalog, defaultTapLengthS } from "../fx/catalog";
import type { FxKind, FxParamDef } from "../fx/types";
import { INSTANT_ENVELOPE, type ADSREnvelope } from "../fx/envelope";
import { useIsNarrowViewport } from "../use-is-narrow";

interface PadDef {
  slotKey: string;
  kind: FxKind;
  /** Single-character keyboard letter shown on the pad. */
  letter: string;
}

const PADS: readonly PadDef[] = [
  { slotKey: "pad:0", kind: "vignette", letter: "V" },
  { slotKey: "pad:1", kind: "wear", letter: "W" },
  { slotKey: "pad:2", kind: "echo", letter: "E" },
  { slotKey: "pad:3", kind: "rgb", letter: "R" },
  { slotKey: "pad:4", kind: "tape", letter: "T" },
  { slotKey: "pad:5", kind: "zoom", letter: "Z" },
  { slotKey: "pad:6", kind: "uv", letter: "U" },
];

/** Beat-division stops for bipolar encoders (TE-LFO style). */
const BEAT_STOPS = ["1/16", "1/8", "1/4", "1/2", "1", "2", "4"] as const;

const TAB_H = 12;
const PAD_BODY_H = 110;
// Mobile pad layout pieces — used to compute panel height per-viewport
// so the bottom padding under the pad row matches the top padding
// above the LCD (`py-1.5` = 6 px). At fold-folded (280 px wide) we get
// 3 pads per row → 3 rows; at iPhone-12 (390) we get 5 → 2 rows; at
// 540+ we get 7 → 1 row.
//
// Narrow mobile structure (top → bottom):
//   - LCD (full-width, taller — keeps the ENV editor usable)
//   - Encoder row: [mode buttons | encoder1 | encoder2]
//   - Pad grid (wraps across `rows`)
const PAD_SIZE_NARROW = 60; // pad width = pad height on phones
const PAD_GAP_NARROW = 4; // matches `gap-1` in the JSX below
const LCD_H_NARROW = 96; // matches lcdStyle(narrow=true).height
const ENCODER_ROW_H_NARROW = 60; // ENC_OUTER (50) + gap (3) + label (~7)
const PADBODY_INNER_PY_NARROW = 12; // 2× py-1.5
const PADBODY_INNER_PX_NARROW = 16; // 2× px-2
const PADBODY_INNER_GAP_NARROW = 6; // gap-1.5 between rows
function padBodyHeightNarrow(rows: number): number {
  return (
    PADBODY_INNER_PY_NARROW +
    LCD_H_NARROW +
    PADBODY_INNER_GAP_NARROW +
    ENCODER_ROW_H_NARROW +
    PADBODY_INNER_GAP_NARROW +
    rows * PAD_SIZE_NARROW +
    (rows - 1) * PAD_GAP_NARROW
  );
}
function padsPerRowNarrow(containerCssWidth: number): number {
  // The pad row sits inside `px-2` (16) of the panel body. Each pad is
  // 60 px wide and the inter-pad gap is `gap-1` (4 px).
  const inner = Math.max(0, containerCssWidth - PADBODY_INNER_PX_NARROW);
  const fits = Math.floor((inner + PAD_GAP_NARROW) / (PAD_SIZE_NARROW + PAD_GAP_NARROW));
  return Math.max(1, Math.min(PADS.length, fits));
}
const TAB_WIDTH = 110;

/**
 * Layout strategy — "drawer pulled out of the timeline":
 *   - Tab is at the TOP of the container (y stays put across states).
 *     mt:-12 always, so tab-top is flush with transport-bottom.
 *   - **Collapsed** (h = TAB_H, mb:-12): the tab fills the existing 12 px
 *     gap-3 between transport and timeline. Zero net layout impact.
 *   - **Expanded** (h = TAB_H + PAD_BODY_H, mb:-12): the tab stays at
 *     top with the compartment (pad body) directly under it (no gap
 *     between them — the tab IS the visual separator from transport).
 *     The compartment is rendered as a recessed cavity (rounded top,
 *     flat bottom merged with timeline-top); the timeline's top
 *     corners go flat in the EditorShell when the FX panel is open
 *     so the silhouette reads as one continuous "drawer pulled out
 *     of the timeline" shape.
 */
export function FxHardwarePanel() {
  const fxPanelOpen = useEditorStore((s) => s.ui.fxPanelOpen);
  const setFxPanelOpen = useEditorStore((s) => s.setFxPanelOpen);
  const isNarrow = useIsNarrowViewport();
  // Mobile users asked to be able to fold the FX panel away on demand —
  // before it was permanently expanded (open = isMobile || ...). Now it
  // tracks the same `fxPanelOpen` flag everywhere; the tab is always
  // toggleable, so a coarse-pointer user can also press the pull-tab to
  // collapse / expand the pad bank.
  const open = fxPanelOpen;

  // On mobile we measure the panel's actual rendered width (via a
  // ResizeObserver) so we can derive the exact pad-row count → exact
  // panel height. The earlier static `PAD_BODY_H_NARROW = 256` was
  // sized for the worst case (3 rows of pads at fold-folded) and left
  // ~36 px of dead space under the pads on iPhone-class viewports
  // where the pads actually fit in 2 rows. Now the bottom padding
  // matches the LCD's top padding (`py-1.5` = 6 px) at every width.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isNarrow) return;
    const apply = () => setContainerW(el.clientWidth);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isNarrow]);
  const padRowsNarrow = Math.ceil(PADS.length / padsPerRowNarrow(containerW || 280));
  const padBodyH = isNarrow ? padBodyHeightNarrow(padRowsNarrow) : PAD_BODY_H;
  const expandedH = TAB_H + padBodyH;

  // Margin strategy:
  //   - Desktop: gap-3 (12 px) parent gap. We pull the panel up by 12
  //     and down by 12 so the tab fits exactly into the parent gap and
  //     reads as a single "drawer pulled out of the timeline" silhouette
  //     spanning both transport-bottom and timeline-top edges.
  //   - Mobile: gap-2 (8 px) parent gap. The user wants the tab to
  //     attach to the timeline panel below (drawer handle pulled out
  //     OF the snap panel) but keep visible breathing room from the
  //     transport panel above. So we leave mt:0 (parent gap renders
  //     above the tab) and set mb:-8 to pull the next sibling
  //     (timeline panel) flush against the tab's bottom edge.
  const marginTopPx = isNarrow ? 0 : -12;
  const marginBottomPx = isNarrow ? -8 : -12;
  return (
    <div
      ref={containerRef}
      className="relative shrink-0 w-full select-none"
      style={{
        height: open ? expandedH : TAB_H,
        marginTop: marginTopPx,
        marginBottom: marginBottomPx,
        overflow: "visible",
        transition: "height 200ms ease-out",
      }}
    >
      <div
        className="absolute"
        style={{
          top: TAB_H,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
        }}
      >
        <div
          className="absolute"
          style={{
            bottom: 0,
            left: 0,
            right: 0,
            height: padBodyH,
          }}
        >
          <PadBody narrow={isNarrow} />
        </div>
      </div>
      <Tab
        open={open}
        onClick={() => setFxPanelOpen(!fxPanelOpen)}
        toggleable
      />
    </div>
  );
}

/** Anodized-aluminum pull-tab — analogue to the right-side PanelHandle.
 *  Sits at the TOP of the panel container, flush against transport-bottom
 *  in both states. Top corners rounded, bottom corners flat (the tab
 *  visually emerges DOWNWARD into the gap when collapsed; in the
 *  expanded state its flat bottom merges with the pad body's flat top
 *  edge — together they form one "drawer with a handle"). */
function Tab({
  open,
  onClick,
  toggleable,
}: {
  open: boolean;
  onClick: () => void;
  toggleable: boolean;
}) {
  return (
    <button
      type="button"
      onClick={toggleable ? onClick : undefined}
      aria-label={open ? "Hide FX panel" : "Show FX panel"}
      title={
        toggleable ? (open ? "Hide FX panel" : "Show FX panel") : undefined
      }
      className="absolute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hot/40"
      style={{
        top: 0,
        left: "50%",
        transform: "translateX(-50%)",
        width: TAB_WIDTH,
        height: TAB_H,
        borderRadius: "6px 6px 0 0",
        cursor: toggleable ? "pointer" : "default",
        ...ALUMINUM_BODY,
        borderBottom: "none",
      }}
    >
      {/* Tap-area extender — invisible, expands the hit-rect to ~36 px
       *  tall × 144 px wide so a fingertip can grab the 12 px tab on
       *  touch devices. Clicks on this transparent overlay still
       *  trigger the parent button's onClick. */}
      <span
        aria-hidden
        className="absolute"
        style={{ left: -16, right: -16, top: -12, bottom: -12 }}
      />
      <span
        aria-hidden
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ ...KNURLED_GRIP, height: 6, width: 40, borderRadius: 1 }}
      />
      <span
        aria-hidden
        className="absolute left-2 top-1/2 -translate-y-1/2 font-display leading-none"
        style={{ fontSize: 8, letterSpacing: 0.5, ...ALUMINUM_LABEL }}
      >
        FX
      </span>
      <span
        aria-hidden
        className="absolute right-2 top-1/2 -translate-y-1/2 leading-none"
        style={{ fontSize: 9, ...ALUMINUM_LABEL }}
      >
        {open ? "▴" : "▾"}
      </span>
    </button>
  );
}

function PadBody({ narrow = false }: { narrow?: boolean }) {
  const selectedFxKind = useEditorStore((s) => s.selectedFxKind);
  const def = fxCatalog[selectedFxKind];
  // Local-only state — no persistence and no need for cross-component
  // sync, so we keep it out of the Zustand store. Re-mounted with the
  // panel itself, which is fine.
  const [screenMode, setScreenMode] = useState<ScreenMode>("params");

  return (
    <div className="relative w-full h-full" style={MECHANISM_BODY}>
      <Screw left={5} top={5} />
      <Screw right={5} top={5} />
      <Screw left={5} bottom={5} />
      <Screw right={5} bottom={5} />

      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={BRUSHED_GRAIN}
      />

      {narrow ? (
        // Narrow phones: the LCD gets its own full-width row so the
        // ENV-mode plot and finger-friendly knot hit-targets have real
        // estate to live in. Mode-buttons + encoders sit horizontally
        // below the LCD, then the pad bank wraps underneath. This trades
        // a few extra vertical pixels for a usable envelope editor on
        // mobile.
        <div className="relative h-full flex flex-col gap-1.5 px-2 py-1.5">
          <Lcd kind={selectedFxKind} mode={screenMode} narrow />
          <div className="flex items-center justify-center gap-3 shrink-0">
            <ScreenModeColumn
              mode={screenMode}
              setMode={setScreenMode}
              narrow
            />
            {def.params && (
              <div className="flex items-end gap-2">
                <Encoder
                  kind={selectedFxKind}
                  param={def.params[0]}
                  tint={ENCODER_HOT}
                />
                <Encoder
                  kind={selectedFxKind}
                  param={def.params[1]}
                  tint={ENCODER_COBALT}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1 justify-center">
            {PADS.map((p) => (
              <FxPad key={p.slotKey} pad={p} />
            ))}
          </div>
        </div>
      ) : (
        <div className="relative h-full flex items-center gap-2 pl-2 pr-5">
          <ScreenModeColumn mode={screenMode} setMode={setScreenMode} />
          <Lcd kind={selectedFxKind} mode={screenMode} />
          {def.params && (
            <div className="flex items-end gap-3 self-center ml-1">
              <Encoder
                kind={selectedFxKind}
                param={def.params[0]}
                tint={ENCODER_HOT}
              />
              <Encoder
                kind={selectedFxKind}
                param={def.params[1]}
                tint={ENCODER_COBALT}
              />
            </div>
          )}
          <Divider />
          <div className="flex items-center gap-2">
            {PADS.map((p) => (
              <FxPad key={p.slotKey} pad={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type ScreenMode = "params" | "env";

// — Pad ————————————————————————————————————————————————————

function FxPad({ pad }: { pad: PadDef }) {
  const def = fxCatalog[pad.kind];
  const heldByThisSlot = useEditorStore((s) => Boolean(s.fxHolds[pad.slotKey]));
  const isSelected = useEditorStore((s) => s.selectedFxKind === pad.kind);
  const beginFxHold = useEditorStore((s) => s.beginFxHold);
  const endFxHold = useEditorStore((s) => s.endFxHold);
  const setSelectedFxKind = useEditorStore((s) => s.setSelectedFxKind);
  const [glow, setGlow] = useState(0);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (heldByThisSlot) {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      setGlow(1);
    } else if (glow > 0) {
      releaseTimerRef.current = setTimeout(() => {
        setGlow(0);
        releaseTimerRef.current = null;
      }, 220);
    }
    return () => {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };
  }, [heldByThisSlot, glow]);

  function handleDown(e: ReactPointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    // We deliberately don't `setPointerCapture` here — capture works
    // fine for one finger but on Android Chrome routes additional
    // touch pointers in unpredictable ways, swallowing the second
    // pad's pointerdown so multi-touch chords (V + W to overlay
    // vignette + wear) silently drop one of the two. Without capture,
    // each finger's pointerdown lands on the pad it touched, both
    // store entries get added, both pads light up.
    //
    // We also drop `e.stopPropagation()` for the same reason: when
    // the FX panel is wrapped in a container with its own pointer
    // listener (e.g. the editor's no-long-press handler), stopping
    // propagation can leave the container's "active touch" tracker
    // out of sync and cancel sibling pointers.
    setSelectedFxKind(pad.kind);
    const s = useEditorStore.getState();

    // Audition mode (paused playback): clicks LATCH the preview.
    // Clicking a pad while a different preview is active swaps to the
    // new kind. Clicking the same pad again drops the preview. This
    // frees the user's mouse to drag encoders / ADSR knots while the
    // effect sits on the live frame — without it, the effect would
    // disappear the moment the pointer lifts off the pad.
    if (!s.playback.isPlaying) {
      // Find any existing preview-mode hold (only one preview at a
      // time — keeps the LCD readout and live override unambiguous).
      let existingSlot: string | null = null;
      let existingKind: FxKind | null = null;
      for (const [slot, h] of Object.entries(s.fxHolds)) {
        if (h.mode === "preview") {
          existingSlot = slot;
          existingKind = h.kind;
          break;
        }
      }
      if (existingSlot != null && existingKind === pad.kind) {
        // Same pad → toggle off.
        endFxHold(existingSlot);
        return;
      }
      if (existingSlot != null) {
        // Different pad → drop the prior preview before latching new.
        endFxHold(existingSlot);
      }
      const t = s.snapTimelineTime(s.playback.timelineT);
      beginFxHold(pad.slotKey, pad.kind, t);
      return;
    }

    // Playback running → record-mode (press-and-hold).
    const t = s.snapTimelineTime(s.playback.timelineT);
    beginFxHold(pad.slotKey, pad.kind, t);
  }
  function handleUp() {
    // While paused, the hold latches — only end on the next click.
    const s = useEditorStore.getState();
    if (!s.playback.isPlaying) return;
    endFxHold(pad.slotKey);
  }
  // Tap-feedback transform replaces framer-motion's `whileTap`. Framer
  // installs document-level pointer listeners to drive that animation,
  // and on Android Chrome those listeners interfere with sibling pads'
  // multi-touch routing (the second pad's pointerdown gets eaten by
  // framer's "this tap is for the first pad" tracker). Pure CSS scale
  // sidesteps the issue and looks identical.
  const pressScale = heldByThisSlot ? 0.94 : 1;

  return (
    <button
      type="button"
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      // Suppress the system long-press callout — pads are hold-to-play,
      // and on Android Chrome the platform "save / share" menu used to
      // hijack the gesture and abort the FX hold.
      onContextMenu={(e) => e.preventDefault()}
      aria-label={`Trigger ${def.label}`}
      title={`${def.label} — hold to play (${pad.letter})`}
      className="relative rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hot/40"
      style={{
        ...padBodyStyle(heldByThisSlot, isSelected, def.capsuleColor, glow),
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        touchAction: "none",
        transform: `scale(${pressScale})`,
        transition: "transform 50ms ease-out",
      }}
    >
      {/* keyboard letter — top-left, small etched */}
      <span
        aria-hidden
        className="absolute left-1.5 top-1 leading-none"
        style={{
          fontSize: 8,
          letterSpacing: 0.6,
          color: "rgba(255,255,255,0.55)",
          textShadow: "0 1px 0 rgba(0,0,0,0.55)",
          fontFamily:
            '"JetBrains Mono Variable", ui-monospace, monospace',
          fontWeight: 700,
        }}
      >
        {pad.letter}
      </span>
      <span
        aria-hidden
        className="absolute inset-[3px] rounded-[5px]"
        style={padRubberStyle(heldByThisSlot, def.capsuleColor)}
      />
      <span
        aria-hidden
        className="relative font-display text-[10px] uppercase tracking-label"
        style={{
          color: heldByThisSlot ? "#FFFFFF" : "rgba(255,255,255,0.85)",
          textShadow: heldByThisSlot
            ? `0 0 6px ${def.capsuleColor}, 0 1px 0 rgba(0,0,0,0.4)`
            : "0 1px 0 rgba(0,0,0,0.45)",
        }}
      >
        {def.label}
      </span>
    </button>
  );
}

// — LCD ————————————————————————————————————————————————————

function Lcd({
  kind,
  mode,
  narrow = false,
}: {
  kind: FxKind;
  mode: ScreenMode;
  narrow?: boolean;
}) {
  return (
    <div
      aria-hidden
      className="relative flex flex-col justify-between leading-tight"
      style={lcdStyle(narrow)}
    >
      {/* horizontal scan-line overlay — sells the "phosphor" feel.
       *  Sits ABOVE the per-mode content so both PARAMS and ENV inherit
       *  the same scanlines without each view re-implementing them. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 2px)",
          mixBlendMode: "multiply",
          borderRadius: 2,
          zIndex: 2,
        }}
      />
      {/* Mode-keyed remount so the CRT-glitch keyframe re-fires on each
       *  switch — the screen doesn't fade, it briefly twitches like an
       *  80er Röhrenmonitor that just got its sync signal swapped. */}
      <div
        key={mode}
        className="relative flex flex-col h-full vas-crt-glitch"
        style={{ zIndex: 1 }}
      >
        {mode === "params" ? (
          <LcdParamsView kind={kind} />
        ) : (
          <LcdEnvelopeView kind={kind} narrow={narrow} />
        )}
      </div>
    </div>
  );
}

function LcdParamsView({ kind }: { kind: FxKind }) {
  const def = fxCatalog[kind];
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value ?? null);
  const tapLen = defaultTapLengthS(kind, bpm);
  // Subscribe to the per-kind defaults map so the LCD updates the moment
  // an encoder writes — pulling the slice for THIS kind only keeps the
  // re-render local.
  const fxDefaults = useEditorStore((s) => s.fxDefaults[kind]);

  const params = def.params;
  const v1 = params
    ? fxDefaults?.[params[0].id] ?? params[0].defaultValue
    : null;
  const v2 = params
    ? fxDefaults?.[params[1].id] ?? params[1].defaultValue
    : null;

  return (
    <div className="flex flex-col h-full justify-between px-2 py-1.5">
      <div
        className="flex items-baseline justify-between"
        style={{ ...LCD_TEXT_DIM, fontSize: 7, letterSpacing: 1.4 }}
      >
        <span>VAS · FX</span>
        <span>{tapLen.toFixed(2)}S</span>
      </div>
      <div
        style={{
          fontFamily:
            '"JetBrains Mono Variable", ui-monospace, monospace',
          fontSize: 22,
          letterSpacing: 2,
          lineHeight: 1,
          fontWeight: 700,
          ...LCD_TEXT,
        }}
      >
        {def.label}
      </div>
      {params && v1 !== null && v2 !== null ? (
        <div
          className="flex justify-between items-baseline"
          style={{
            fontFamily:
              '"JetBrains Mono Variable", ui-monospace, monospace',
            fontSize: 9,
            letterSpacing: 0.5,
            ...LCD_TEXT,
          }}
        >
          <span>
            <span style={LCD_HOT_DOT}>●</span>{" "}
            {params[0].label} {fmt(params[0], v1)}
          </span>
          <span>
            <span style={LCD_COBALT_DOT}>●</span>{" "}
            {params[1].label} {fmt(params[1], v2)}
          </span>
        </div>
      ) : (
        <div
          style={{
            ...LCD_TEXT_DIM,
            fontSize: 8,
            letterSpacing: 1,
            fontFamily:
              '"JetBrains Mono Variable", ui-monospace, monospace',
          }}
        >
          NO PARAMS
        </div>
      )}
    </div>
  );
}

// — Encoder ————————————————————————————————————————————————

interface EncoderProps {
  kind: FxKind;
  param: FxParamDef;
  tint: string;
}

/** Skeuomorpher 80er-Hardware-Pot:
 *  - matter schwarzer Mantel (Bakelit-Look) mit Knurled-Ring
 *  - poliertes, leicht erhabenes Cap-Top mit fixem Top-Left-Reflex (Lichtquelle steht)
 *  - dünne, getintete Indikator-Linie auf dem Cap — die ROTIERT mit dem Wert
 *    und ist gleichzeitig die Farb-Kodierung des Encoders
 *  - SVG-Skala um den Knob herum mit Tick-Filling in derselben Tint-Farbe.
 *
 *  Drag-Verhalten: vertikal ziehen, 200 px = full sweep. Shift = fine
 *  (6×). Doppelklick reset auf catalog-Default. Shift+Pfeile auf Tastatur
 *  nudgen feiner (vgl. existing Knob.tsx).
 */
function Encoder({ kind, param, tint }: EncoderProps) {
  const fxDefaults = useEditorStore((s) => s.fxDefaults[kind]);
  const setFxDefault = useEditorStore((s) => s.setFxDefault);
  const value = fxDefaults?.[param.id] ?? param.defaultValue;

  const startY = useRef(0);
  const startVal = useRef(0);
  const [dragging, setDragging] = useState(false);

  const range = param.max - param.min;
  // Display sweep is 0..1 regardless of storage range; angle -135..+135.
  const ratio = Math.max(
    0,
    Math.min(1, range > 0 ? (value - param.min) / range : 0),
  );
  const angle = -135 + ratio * 270;

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      e.preventDefault();
      // Click-on-scale shortcut: if the click lands outside the knob body
      // (i.e. on the etched scale ring) we map the click angle to a value
      // and jump there immediately. Drag continues from the new baseline,
      // so click → release ist "instant set" and click → drag is "set then
      // fine-tune". Inside the knob body we keep pure drag-only.
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const r = Math.hypot(dx, dy);
      // Knob-Body-Radius mit 1 px Toleranz; Klicks außerhalb → Skala.
      const KNOB_HIT_R = ENC_BODY / 2 + 1;
      let baseline = value;
      if (r > KNOB_HIT_R) {
        // Click angle: top = 0, right-half positive, left-half negative.
        // atan2(dx, -dy) gives exactly that orientation.
        const aDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
        const clamped = Math.max(-135, Math.min(135, aDeg));
        const ratioFromClick = (clamped + 135) / 270;
        let next = param.min + ratioFromClick * range;
        if (param.kind === "bipolar") {
          next = snapBipolar(next, param.min, param.max);
        } else {
          const decimals = range <= 1.5 ? 2 : 0;
          next = roundTo(next, decimals);
        }
        setFxDefault(kind, param.id, next);
        baseline = next;
      }
      startY.current = e.clientY;
      startVal.current = baseline;
      setDragging(true);
    },
    [
      value,
      kind,
      param.id,
      param.kind,
      param.min,
      param.max,
      range,
      setFxDefault,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      // Stale-drag guard: if the up event was lost (cursor left the
      // window during the drag) the next move would otherwise keep
      // adjusting the knob without a button held.
      if (e.buttons === 0) {
        setDragging(false);
        return;
      }
      e.preventDefault();
      // Drag UP increases the value. 200 px maps to the full storage
      // range; Shift slows this 6×.
      const dy = startY.current - e.clientY;
      const sensitivity = e.shiftKey ? 1200 : 200;
      let next = startVal.current + (dy / sensitivity) * range;
      next = Math.max(param.min, Math.min(param.max, next));
      if (param.kind === "bipolar") {
        next = snapBipolar(next, param.min, param.max);
      } else {
        // Round to a sensible step. For 0..1 ranges, two decimals; for
        // 0..100 ranges, integers; pick whichever makes sense from the
        // range size.
        const decimals = range <= 1.5 ? 2 : 0;
        next = roundTo(next, decimals);
      }
      setFxDefault(kind, param.id, next);
    },
    [dragging, kind, param.id, param.kind, param.min, param.max, range, setFxDefault],
  );

  const onPointerUp = useCallback(() => setDragging(false), []);

  // Belt-and-suspenders for off-window releases. The local up handler
  // never fires when the cursor lands outside the document, so we
  // listen on window too.
  useEffect(() => {
    if (!dragging) return;
    function clear() {
      setDragging(false);
    }
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, [dragging]);

  const onDoubleClick = useCallback(() => {
    setFxDefault(kind, param.id, param.defaultValue);
  }, [kind, param.id, param.defaultValue, setFxDefault]);

  return (
    <div className="flex flex-col items-center" style={{ gap: 3 }}>
      <div
        role="slider"
        aria-valuemin={param.min}
        aria-valuemax={param.max}
        aria-valuenow={value}
        aria-label={param.label}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className="relative touch-none cursor-grab active:cursor-grabbing"
        style={{ width: ENC_OUTER, height: ENC_OUTER }}
      >
        {/* etched scale around the knob */}
        <svg
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          viewBox="-50 -50 100 100"
          width={ENC_OUTER}
          height={ENC_OUTER}
        >
          {param.kind === "linear"
            ? linearTicks(ratio, tint)
            : bipolarTicks(value, param.min, param.max, tint)}
        </svg>

        {/* knob body — matte black, fixed (does NOT rotate; the indicator does) */}
        <div
          aria-hidden
          className="absolute rounded-full"
          style={{
            left: ENC_BODY_INSET,
            top: ENC_BODY_INSET,
            width: ENC_BODY,
            height: ENC_BODY,
            background:
              "radial-gradient(circle at 32% 22%, #2C2A26 0%, #16140F 65%, #050402 100%)",
            boxShadow: [
              // crisp drop-shadow under the knob — sells the "raised over the plate" feel
              "0 3px 4px -1px rgba(0,0,0,0.6)",
              "0 1px 0 rgba(0,0,0,0.4)",
              // subtle inner top-rim highlight, fixed lighting
              "inset 0 1px 0 rgba(255,255,255,0.10)",
              // bottom-half darken — sphere-ish curvature
              "inset 0 -3px 6px rgba(0,0,0,0.55)",
            ].join(", "),
          }}
        />

        {/* knurled ring — outer 2-3px annulus with conic grooves */}
        <div
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: ENC_BODY_INSET,
            top: ENC_BODY_INSET,
            width: ENC_BODY,
            height: ENC_BODY,
            background:
              "repeating-conic-gradient(from 0deg, rgba(255,255,255,0.10) 0deg 1.5deg, rgba(0,0,0,0.55) 1.5deg 3deg)",
            // mask to a thin ring at the body's outer edge
            WebkitMask:
              "radial-gradient(circle, transparent 70%, black 78%, black 96%, transparent 100%)",
            mask: "radial-gradient(circle, transparent 70%, black 78%, black 96%, transparent 100%)",
          }}
        />

        {/* polished cap — slightly raised, lighter, fixed top-left highlight */}
        <div
          aria-hidden
          className="absolute rounded-full"
          style={{
            left: ENC_CAP_INSET,
            top: ENC_CAP_INSET,
            width: ENC_CAP,
            height: ENC_CAP,
            background:
              "radial-gradient(circle at 32% 22%, #4A4640 0%, #2A2722 55%, #14110E 100%)",
            boxShadow: [
              "inset 0 1px 0 rgba(255,255,255,0.16)",
              "inset 0 -1px 1px rgba(0,0,0,0.6)",
              "0 1px 1px rgba(0,0,0,0.4)",
            ].join(", "),
          }}
        >
          {/* fixed specular highlight — does NOT rotate (light source is overhead) */}
          <span
            aria-hidden
            className="absolute rounded-full pointer-events-none"
            style={{
              top: 2,
              left: 3,
              width: ENC_CAP * 0.45,
              height: ENC_CAP * 0.32,
              background:
                "radial-gradient(ellipse at center, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.08) 55%, transparent 100%)",
              filter: "blur(0.5px)",
            }}
          />
        </div>

        {/* indicator — thin colored line that ROTATES with value.
         *  Color = encoder tint. This IS the entire color marker on the
         *  encoder; the knob itself stays neutral black so it reads as
         *  hardware, not "UI element". */}
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            left: "50%",
            top: "50%",
            width: 0,
            height: 0,
            transform: `translate(-50%, -50%) rotate(${angle}deg)`,
            transition: dragging ? "none" : "transform 80ms ease-out",
          }}
        >
          <span
            aria-hidden
            className="absolute"
            style={{
              left: "50%",
              top: -ENC_CAP / 2 + 2,
              transform: "translate(-50%, 0)",
              width: 2,
              height: 7,
              borderRadius: 1,
              background: tint,
              boxShadow: `0 0 3px ${tint}cc, 0 0 1px ${tint}, inset 0 0 0 0.5px rgba(0,0,0,0.5)`,
            }}
          />
        </div>

        {/* tiny etched centre divot — gives the cap a 3D "machined" feel */}
        <span
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: "50%",
            top: "50%",
            width: 2.5,
            height: 2.5,
            transform: "translate(-50%, -50%)",
            background: "rgba(0,0,0,0.7)",
            boxShadow: "0 0.5px 0 rgba(255,255,255,0.06)",
          }}
        />
      </div>

      {/* engraved label below */}
      <span
        style={{
          fontSize: 7.5,
          letterSpacing: 1.5,
          color: "rgba(245,240,225,0.5)",
          textShadow: "0 1px 0 rgba(0,0,0,0.55)",
          fontWeight: 700,
          textTransform: "uppercase",
          fontFamily:
            '"JetBrains Mono Variable", ui-monospace, monospace',
          lineHeight: 1,
        }}
      >
        {param.label}
      </span>
    </div>
  );
}

// — Tick rendering ————————————————————————————————————————

function linearTicks(ratio: number, fillColor: string) {
  const out = [];
  const TICK_COUNT = 21;
  for (let i = 0; i < TICK_COUNT; i++) {
    const t = i / (TICK_COUNT - 1);
    const a = ((-135 + t * 270) * Math.PI) / 180;
    const offsetA = a - Math.PI / 2; // SVG: angle 0 = right; we want top.
    const major = i % 5 === 0;
    const r1 = 49;
    const r2 = major ? 41 : 45;
    const filled = t <= ratio;
    out.push(
      <line
        key={i}
        x1={Math.cos(offsetA) * r1}
        y1={Math.sin(offsetA) * r1}
        x2={Math.cos(offsetA) * r2}
        y2={Math.sin(offsetA) * r2}
        stroke={filled ? fillColor : "rgba(245,240,225,0.18)"}
        strokeWidth={major ? 1.4 : 0.8}
        strokeLinecap="round"
      />,
    );
  }
  return out;
}

function bipolarTicks(
  value: number,
  min: number,
  max: number,
  fillColor: string,
) {
  // Center is the midpoint of the storage range.
  const range = max - min;
  const center = min + range / 2;
  const out = [];
  // Free side: fine grey ticks running from -135° to 0° (left half).
  const FREE_TICKS = 9;
  for (let i = 0; i < FREE_TICKS; i++) {
    const t = i / (FREE_TICKS - 1);
    const a = (-135 + t * 135) * (Math.PI / 180) - Math.PI / 2;
    const r1 = 49;
    const r2 = 46;
    const lit = value < center && t >= 1 - (center - value) / (range / 2);
    out.push(
      <line
        key={`f${i}`}
        x1={Math.cos(a) * r1}
        y1={Math.sin(a) * r1}
        x2={Math.cos(a) * r2}
        y2={Math.sin(a) * r2}
        stroke={lit ? fillColor : "rgba(245,240,225,0.18)"}
        strokeWidth={0.7}
        strokeLinecap="round"
      />,
    );
  }
  // Centre detent — fat tick at the very top.
  const cAng = -Math.PI / 2;
  out.push(
    <line
      key="centre"
      x1={Math.cos(cAng) * 49}
      y1={Math.sin(cAng) * 49}
      x2={Math.cos(cAng) * 39}
      y2={Math.sin(cAng) * 39}
      stroke={value === center ? fillColor : "rgba(245,240,225,0.42)"}
      strokeWidth={1.8}
      strokeLinecap="round"
    />,
  );
  // Sync side: 7 prominent stops at even angular spacing across right half.
  for (let i = 0; i < BEAT_STOPS.length; i++) {
    const t = (i + 0.5) / BEAT_STOPS.length; // centre of bucket (0.5..1.0)
    const a = ((t * 135 + 0) * Math.PI) / 180 - Math.PI / 2;
    // Map current value → stop index on right half if value > centre.
    const rightSide = value > center;
    const halfRange = range / 2;
    const stopIdx = rightSide
      ? Math.min(
          BEAT_STOPS.length - 1,
          Math.max(
            0,
            Math.round(((value - center) / halfRange) * BEAT_STOPS.length - 0.5),
          ),
        )
      : -1;
    const lit = stopIdx === i;
    const r1 = 49;
    const r2 = 39;
    out.push(
      <line
        key={`s${i}`}
        x1={Math.cos(a) * r1}
        y1={Math.sin(a) * r1}
        x2={Math.cos(a) * r2}
        y2={Math.sin(a) * r2}
        stroke={lit ? fillColor : "rgba(245,240,225,0.42)"}
        strokeWidth={1.4}
        strokeLinecap="round"
      />,
    );
  }
  return out;
}

// — Helpers ————————————————————————————————————————————————

function fmt(param: FxParamDef, value: number): string {
  if (param.kind === "bipolar") return bipolarLabel(value, param.min, param.max);
  // Linear: show as 0..100 integer regardless of storage range.
  const ratio = (value - param.min) / (param.max - param.min);
  return String(Math.round(ratio * 100)).padStart(3, " ");
}

function bipolarLabel(value: number, min: number, max: number): string {
  const range = max - min;
  const center = min + range / 2;
  const halfRange = range / 2;
  // ±2% of the range counts as "OFF" detent.
  const detentEps = halfRange * 0.04;
  if (Math.abs(value - center) <= detentEps) return "OFF";
  if (value < center) {
    const dist = Math.round(((center - value) / halfRange) * 100);
    return `FR${String(dist).padStart(2, " ")}`;
  }
  const idx = Math.min(
    BEAT_STOPS.length - 1,
    Math.max(
      0,
      Math.round(((value - center) / halfRange) * BEAT_STOPS.length - 0.5),
    ),
  );
  return BEAT_STOPS[idx];
}

function snapBipolar(raw: number, min: number, max: number): number {
  const range = max - min;
  const center = min + range / 2;
  const halfRange = range / 2;
  const detentEps = halfRange * 0.04;
  if (Math.abs(raw - center) <= detentEps) return center;
  if (raw < center) return raw;
  // Right side: snap to nearest of BEAT_STOPS.length stop centres.
  const t = (raw - center) / halfRange; // 0..1
  const idx = Math.min(
    BEAT_STOPS.length - 1,
    Math.max(0, Math.round(t * BEAT_STOPS.length - 0.5)),
  );
  return center + ((idx + 0.5) / BEAT_STOPS.length) * halfRange;
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function Screw({
  left,
  right,
  top,
  bottom,
}: {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}) {
  return (
    <span
      aria-hidden
      className="absolute"
      style={{
        left,
        right,
        top,
        bottom,
        width: 7,
        height: 7,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 35% 30%, #DCD3BB 0%, #ADA28A 55%, #837A66 100%)",
        boxShadow:
          "inset 0 -1px 0 rgba(0,0,0,0.35), 0 0.5px 0.5px rgba(0,0,0,0.4)",
      }}
    >
      <span
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(0deg, transparent 44%, rgba(0,0,0,0.55) 44%, rgba(0,0,0,0.55) 56%, transparent 56%), linear-gradient(90deg, transparent 44%, rgba(0,0,0,0.55) 44%, rgba(0,0,0,0.55) 56%, transparent 56%)",
        }}
      />
    </span>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      className="self-stretch my-3"
      style={{
        width: 1,
        background:
          "linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.6) 18%, rgba(0,0,0,0.6) 82%, transparent 100%)",
        boxShadow: "1px 0 0 rgba(255,255,255,0.04)",
      }}
    />
  );
}

// — Screen-Mode Switch (PARAMS / ENV) ——————————————————————

/**
 * Two stacked plastic buttons, sit-in-the-bezel style — like the CH▲/CH▼
 * pair on an 80er VHS-Player wedged next to the screen. Switches the LCD
 * between PARAMS view (encoder readout) and ENV view (draggable ADSR
 * curve). Local-only state — no Zustand. */
function ScreenModeColumn({
  mode,
  setMode,
  narrow = false,
}: {
  mode: ScreenMode;
  setMode: (m: ScreenMode) => void;
  narrow?: boolean;
}) {
  // Wide: vertical pair beside the LCD (CH▲/CH▼ feel). Narrow: horizontal
  // pair so the row Buttons|Encoders|Encoders stays compact under the
  // full-width LCD.
  return (
    <div
      className={
        (narrow
          ? "flex flex-row items-center justify-center gap-1.5"
          : "flex flex-col items-center justify-center gap-1") +
        " self-center shrink-0"
      }
    >
      <ScreenModeButton
        active={mode === "params"}
        label="P"
        onClick={() => setMode("params")}
        ariaLabel="Show parameters"
      />
      <ScreenModeButton
        active={mode === "env"}
        label="E"
        onClick={() => setMode("env")}
        ariaLabel="Show envelope"
      />
    </div>
  );
}

function ScreenModeButton({
  active,
  label,
  onClick,
  ariaLabel,
}: {
  active: boolean;
  label: "P" | "E";
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className="relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hot/40"
      style={{
        width: 18,
        height: 14,
        borderRadius: 2.5,
        background: "linear-gradient(180deg,#2C2925 0%,#1A1815 100%)",
        border: "1px solid rgba(0,0,0,0.7)",
        boxShadow: active
          ? "inset 0 2px 3px rgba(0,0,0,0.6)"
          : "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 1px rgba(0,0,0,0.55), 0 1px 1px rgba(0,0,0,0.4)",
        transform: active ? "translateY(1px)" : "translateY(0)",
        transition: "transform 50ms, box-shadow 80ms",
        cursor: "pointer",
      }}
    >
      {/* Touch-target extender — 28×28 invisible hit-rect for fingers. */}
      <span
        aria-hidden
        className="absolute"
        style={{ left: -5, right: -5, top: -7, bottom: -7 }}
      />
      {/* Phosphor LED — same green as the LCD text so it reads as
       *  "wired into the screen" rather than as an unrelated knob. */}
      <span
        aria-hidden
        className="absolute"
        style={{
          top: 2,
          right: 2,
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: active ? "#9FE08E" : "#1F2A1E",
          boxShadow: active
            ? "0 0 4px rgba(159,224,142,0.85), 0 0 1px #9FE08E"
            : "inset 0 0 1px rgba(0,0,0,0.6)",
        }}
      />
      <span
        aria-hidden
        className="absolute leading-none"
        style={{
          left: 4,
          top: 3,
          fontSize: 9,
          fontFamily:
            '"JetBrains Mono Variable", ui-monospace, monospace',
          fontWeight: 700,
          color: "rgba(245,240,225,0.55)",
          textShadow: "0 1px 0 rgba(0,0,0,0.6)",
        }}
      >
        {label}
      </span>
    </button>
  );
}

// — LCD ENV mode (ADSR-Editor) ——————————————————————————————

/** Bounds for the four draggable ADSR knots, in absolute seconds /
 *  level. Constraints match musical/instrument intuition: sub-2 s
 *  attacks, sub-3 s releases, sustain ∈ [0, 1]. */
const ADSR_MAX_A_S = 2.0;
const ADSR_MAX_D_S = 2.0;
const ADSR_MAX_R_S = 3.0;
/** Horizontal seconds-mapped scale for the curve. The curve compresses
 *  at long durations — we anchor visual full-width to ~5 s of total
 *  duration so the typical defaults (a few hundred ms) land in the
 *  left half of the plot, leaving headroom for big releases. */
const ADSR_TOTAL_VIS_S = 5.0;

function LcdEnvelopeView({
  kind,
  narrow = false,
}: {
  kind: FxKind;
  narrow?: boolean;
}) {
  const userEnv = useEditorStore((s) => s.fxEnvelopes[kind]);
  const def = fxCatalog[kind];
  const env: ADSREnvelope =
    userEnv ?? def?.defaultEnvelope ?? INSTANT_ENVELOPE;

  // SVG plot is sized in logical units. px-2 = 8 px on each side gives
  // 142 units of horizontal plot. py-1.5 = 6 px top/bottom — wide LCD is
  // 78 px tall (66 plot units), narrow LCD is 96 px tall (84 plot units)
  // so the curve and finger-friendly knot hit-targets get more vertical
  // breathing room on phones.
  const PLOT_W = 142;
  const PLOT_H = narrow ? 84 : 66;
  // Reserve a safety inset so a knot at its data-maximum (e.g. sustain=1)
  // never sits flush on the LCD bezel — the visible dot stays clearly
  // inside the screen and the touch hit-area has room to breathe. Wider
  // padding on narrow viewports because the finger-vs-glass margin is
  // tighter there.
  const PAD_X = narrow ? 6 : 4;
  const PAD_Y = narrow ? 8 : 4;
  const innerW = PLOT_W - 2 * PAD_X;
  const innerH = PLOT_H - 2 * PAD_Y;
  const xPerS = innerW / ADSR_TOTAL_VIS_S;

  const geom = computeAdsrGeom(env, PAD_X, PAD_Y, innerW, innerH, xPerS);

  const [active, setActive] = useState<AdsrAxis | null>(null);

  const setEnv = useEditorStore((s) => s.setFxEnvelope);
  const resetEnv = useEditorStore((s) => s.resetFxEnvelope);

  // One drag controller shared between the per-knot AdsrNodes and the
  // PlotProxyZone so a tap-anywhere grab and a direct knot-grab feed the
  // exact same start-snapshot / move / release pipeline.
  const drag = useAdsrDrag({
    env,
    kind,
    plotH: PLOT_H,
    xPerS,
    setEnv,
    resetEnv,
    setActive,
  });

  // Stable per-instance suffix so multiple ENV-views (split panels,
  // tests) can't collide on SVG ids. crypto.randomUUID would be cleanest
  // but isn't available in jsdom; useId is React-built-in and stable.
  const uid = useId();
  const clipId = `vas-env-clip-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const curve = buildAdsrPath(geom);
  const filledCurve = `${curve} L${geom.ox},${geom.oy} Z`;

  return (
    <div className="flex flex-col h-full px-2 py-1.5 justify-center">
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        // overflow=visible lets the r=14 invisible hit-targets extend
        // beyond the LCD bezel, so a knot pinned at e.g. sustain=1 (top
        // of the inner plot) is still grabbable even if the user's
        // finger lands a few pixels above the screen.
        overflow="visible"
        // touch-action on the <g> alone isn't enough on some mobile
        // browsers — duplicating it on the SVG keeps page scroll from
        // hijacking the knot drag.
        style={{ display: "block", touchAction: "none", overflow: "visible" }}
      >
        <defs>
          <filter id="vas-crt-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="0.7" />
          </filter>
        </defs>
        {/* Background trace — the full envelope curve, dim. Reads as the
         *  "future" portion when there's an active hold. */}
        <path
          d={curve}
          stroke="#9FE08E"
          strokeWidth="1.0"
          strokeOpacity={0.32}
          fill="none"
          filter="url(#vas-crt-glow)"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Scope playhead — fills under the curve up to the current
         *  envelope position, brightens the traced segment, and rides
         *  a glow ball at the leading edge. No-op when no pad is held. */}
        <EnvelopePlayhead
          kind={kind}
          env={env}
          geom={geom}
          plotH={PLOT_H}
          curve={curve}
          filledCurve={filledCurve}
          clipId={clipId}
        />
        {/* Plot-wide tap-anywhere proxy. Sits BELOW the AdsrNodes so a
         *  direct hit on a knot's hit-circle still wins; touches that
         *  miss every knot's r=14 zone fall through to here and grab
         *  the nearest knot. Crucial for tiny mobile LCDs where finger-
         *  precision on a maxed-out knot near the edge is impractical. */}
        <PlotProxyZone geom={geom} plotW={PLOT_W} plotH={PLOT_H} drag={drag} />
        <AdsrNode
          axis="A"
          cx={geom.ax}
          cy={geom.ay}
          active={active === "A"}
          drag={drag}
        />
        <AdsrNode
          axis="D"
          cx={geom.dx}
          cy={geom.dy}
          active={active === "D"}
          drag={drag}
        />
        <AdsrNode
          axis="S"
          cx={geom.sx}
          cy={geom.sy}
          active={active === "S"}
          drag={drag}
        />
        {/* R = release-end visual marker. Always at the bottom-right
         *  corner — non-interactive. Drag the S knot to change release
         *  time (or vertical drag for sustain level). */}
        <circle
          cx={geom.rx}
          cy={geom.ry}
          r={2.5}
          fill="#9FE08E"
          opacity={0.85}
          filter="url(#vas-crt-glow)"
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

/** Bezier "knee" — distance the control points are pulled along the
 *  tangent. 0.7 gives the sharp-then-plateau exponential feel of the
 *  OP-1's envelope. */
const ADSR_BEZIER_K = 0.7;

interface AdsrGeom {
  // Inner-plot origin (bottom-left of the safety-inset region). The
  // envelope curve starts here and the release marker sits at (rx, ry)
  // — never on the SVG / LCD bezel edge, so finger and visible dot stay
  // inside the screen.
  ox: number;
  oy: number;
  // Anchors (P0..P4 along the curve).
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rx: number;
  ry: number;
  // Bezier control points for each curved phase.
  attackC1: { x: number; y: number };
  attackC2: { x: number; y: number };
  decayC1: { x: number; y: number };
  decayC2: { x: number; y: number };
  releaseC1: { x: number; y: number };
  releaseC2: { x: number; y: number };
}

function computeAdsrGeom(
  env: ADSREnvelope,
  padX: number,
  padY: number,
  innerW: number,
  innerH: number,
  xPerS: number,
): AdsrGeom {
  const ox = padX;
  const oy = padY + innerH; // inner bottom (sustain=0 floor)
  const topY = padY; // inner top (sustain=1 ceiling)
  const rightX = padX + innerW;

  const ax = ox + clamp(env.attackS * xPerS, 0, innerW);
  const ay = topY;
  const dx = clamp(ax + env.decayS * xPerS, ax, rightX);
  const dy = topY + (1 - env.sustain) * innerH;
  const rxStart = clamp(rightX - env.releaseS * xPerS, ox, rightX);
  const sx = Math.max(dx, rxStart);
  const sy = dy;
  const rx = rightX;
  const ry = oy;
  const K = ADSR_BEZIER_K;
  return {
    ox,
    oy,
    ax,
    ay,
    dx,
    dy,
    sx,
    sy,
    rx,
    ry,
    attackC1: { x: ox, y: oy - K * (oy - ay) },
    attackC2: { x: ax - K * (ax - ox), y: ay },
    decayC1: { x: ax, y: ay + K * (dy - ay) },
    decayC2: { x: dx - K * (dx - ax), y: dy },
    releaseC1: { x: sx, y: sy + K * (ry - sy) },
    releaseC2: { x: rx - K * (rx - sx), y: ry },
  };
}

/** Build an OP-1-style cubic-Bezier ADSR path string from the geometry
 *  computed by `computeAdsrGeom`. Sustain stays a straight horizontal
 *  segment so the level reads unambiguously. */
function buildAdsrPath(g: AdsrGeom): string {
  return [
    `M${g.ox},${g.oy}`,
    `C${g.attackC1.x},${g.attackC1.y} ${g.attackC2.x},${g.attackC2.y} ${g.ax},${g.ay}`,
    `C${g.decayC1.x},${g.decayC1.y} ${g.decayC2.x},${g.decayC2.y} ${g.dx},${g.dy}`,
    `L${g.sx},${g.sy}`,
    `C${g.releaseC1.x},${g.releaseC1.y} ${g.releaseC2.x},${g.releaseC2.y} ${g.rx},${g.ry}`,
  ].join(" ");
}

/** Cubic-Bezier evaluator. */
function bezierAt(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  u: number,
): { x: number; y: number } {
  const v = 1 - u;
  const v2 = v * v;
  const u2 = u * u;
  return {
    x: v2 * v * p0.x + 3 * v2 * u * p1.x + 3 * v * u2 * p2.x + u2 * u * p3.x,
    y: v2 * v * p0.y + 3 * v2 * u * p1.y + 3 * v * u2 * p2.y + u2 * u * p3.y,
  };
}

/** Wallclock cap on the sustain-hop sweep. The hop runs at fixed speed
 *  regardless of how long the release time is — keeps it feeling snappy
 *  for big releases (no slow-motion crawl) and crisp for short releases
 *  (no missed-it-already blink). */
const ADSR_HOP_MAX_S = 0.08;
/** Hop also can't take more than this fraction of the release window —
 *  so very short releases keep at least some bezier-trace time. */
const ADSR_SUSTAIN_HOP_FRAC = 0.5;

/** Phase of the rendered indicator. `sustain-hop` is the visual sweep
 *  across the horizontal sustain segment after release — the audio is
 *  already in release fade, but the dot still has to cross to (sx, sy)
 *  before tracing the release bezier. */
type AdsrPhase =
  | "attack"
  | "decay"
  | "sustain"
  | "sustain-hop"
  | "release";

/** Sample the bezier-traced envelope curve at envelope-local time
 *  `localT`. Returns the (x, y) point ON the visible curve so the
 *  indicator stays glued to the path. `holding` pins us at the sustain
 *  knee while the user is still pressing the pad. */
function curvePointAtTime(
  env: ADSREnvelope,
  localT: number,
  geom: AdsrGeom,
  holding: boolean,
): { x: number; y: number; phase: AdsrPhase } {
  const A = env.attackS;
  const D = env.decayS;
  const R = env.releaseS;
  const origin = { x: geom.ox, y: geom.oy };
  const aP3 = { x: geom.ax, y: geom.ay };
  const dP3 = { x: geom.dx, y: geom.dy };
  const sP0 = { x: geom.sx, y: geom.sy };
  const rP3 = { x: geom.rx, y: geom.ry };

  if (localT < A && A > 0) {
    const u = clamp01v(localT / A);
    return { ...bezierAt(origin, geom.attackC1, geom.attackC2, aP3, u), phase: "attack" };
  }
  if (localT < A + D && D > 0) {
    const u = clamp01v((localT - A) / D);
    return { ...bezierAt(aP3, geom.decayC1, geom.decayC2, dP3, u), phase: "decay" };
  }
  if (holding) {
    return { x: geom.dx, y: geom.dy, phase: "sustain" };
  }

  // Released. Two visual sub-phases share the R-second window:
  //   sustain-hop: ADSR_SUSTAIN_HOP_FRAC × R wiping (dx, dy) → (sx, sy)
  //   release:     remainder running the release bezier → (rx, ry)
  // This gives the dot a chance to cross the sustain plateau visibly
  // instead of teleporting from D-knee to S-knee. The audio's release
  // fade (linear in envelopeAt) starts immediately at the same moment;
  // the visual here is purely a stylised reading of "the voice was
  // released and is now winding down across the path".
  if (R <= 0) {
    return { x: geom.rx, y: geom.ry, phase: "release" };
  }
  const localPostAD = localT - (A + D);
  const hopDur = Math.min(ADSR_HOP_MAX_S, R * ADSR_SUSTAIN_HOP_FRAC);
  if (localPostAD < hopDur) {
    const t = hopDur > 0 ? localPostAD / hopDur : 1;
    const easedT = easeOutCubic(t);
    return {
      x: geom.dx + (geom.sx - geom.dx) * easedT,
      y: geom.dy + (geom.sy - geom.dy) * easedT,
      phase: "sustain-hop",
    };
  }
  const releaseDur = R - hopDur;
  const u = clamp01v((localPostAD - hopDur) / Math.max(releaseDur, 1e-6));
  return { ...bezierAt(sP0, geom.releaseC1, geom.releaseC2, rP3, u), phase: "release" };
}

const clamp01v = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ease-out cubic for the sustain-hop sweep. Front-loaded (fast at the
 *  start, settles toward the S-knee) — feels like a real "snap to next
 *  position" instead of a uniform glide. Lets the comet trail feel
 *  punchy at the leading edge. */
function easeOutCubic(t: number): number {
  const v = 1 - t;
  return 1 - v * v * v;
}

/**
 * Scope-style live indicator on the ADSR curve. While a pad/key is held
 * (persistent or preview), the curve segment the envelope has already
 * "played through" lights up bright with a translucent fill underneath,
 * the unplayed segment stays dim, and a glowing ball rides the bezier
 * at the leading edge. After release, the trail keeps tracing through
 * the release tail until it reaches the floor.
 *
 * Time source:
 *   - Persistent hold (playback running): `playback.currentTime - inS`
 *   - Preview hold (playback paused): a RAF-driven synthetic timer that
 *     starts when the preview latches, so the trace still ramps through
 *     attack → decay → sustain even with the playhead frozen.
 *   - No hold for `kind`: hidden, returns null.
 */
function EnvelopePlayhead({
  kind,
  env,
  geom,
  plotH,
  curve,
  filledCurve,
  clipId,
}: {
  kind: FxKind;
  env: ADSREnvelope;
  geom: AdsrGeom;
  plotH: number;
  curve: string;
  filledCurve: string;
  clipId: string;
}) {
  const fxHolds = useEditorStore((s) => s.fxHolds);
  const fx = useEditorStore((s) => s.fx);
  // FX inS/outS live in timeline-time. The indicator's "where on the
  // ADSR curve are we right now" computation must compare against the
  // same axis — using master-time would put the dot in the wrong phase
  // every time the playhead enters a duplicate-pill slot.
  const currentTime = useEditorStore((s) => s.playback.timelineT);

  // Pick the active hold for this kind (persistent beats preview).
  let activeHold:
    | { mode: "persistent" | "preview"; startS: number }
    | null = null;
  for (const h of Object.values(fxHolds)) {
    if (h.kind !== kind) continue;
    if (h.mode === "persistent") {
      activeHold = h;
      break;
    }
    if (!activeHold) activeHold = h;
  }

  // No hold → check for any active fx of this kind in the timeline.
  // Lets the indicator keep tracing through the release tail once the
  // user has let go: the fx's outS was extended by R, so the release
  // bezier still has time to play out.
  let releasedFx: { inS: number; outS: number } | null = null;
  if (!activeHold) {
    for (const f of fx) {
      if (f.kind !== kind) continue;
      if (f.inS <= currentTime && currentTime < f.outS) {
        releasedFx = { inS: f.inS, outS: f.outS };
        break;
      }
    }
  }

  // Preview-mode synthetic timer — drives the indicator through
  // attack → decay even though playback isn't advancing.
  const [previewT, setPreviewT] = useState(0);
  const previewMode = activeHold?.mode === "preview";
  useEffect(() => {
    if (!previewMode) {
      setPreviewT(0);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      setPreviewT((performance.now() - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewMode]);

  // Pulse RAF — keeps the dot animating while it parks in sustain.
  const [pulse, setPulse] = useState(0);
  const visible = !!activeHold || !!releasedFx;
  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    const start = performance.now();
    const tick = () => {
      setPulse((performance.now() - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  if (!activeHold && !releasedFx) return null;

  const isHeld = !!activeHold;
  let localT: number;
  if (activeHold) {
    localT =
      activeHold.mode === "preview"
        ? previewT
        : Math.max(0, currentTime - activeHold.startS);
  } else {
    // Released — drive the hop + release animation off "time since
    // release was triggered" rather than "time since fx started".
    // Held capsules can have any localT (e.g. 5 s after a long hold);
    // feeding that straight into curvePointAtTime makes the post-A+D
    // arithmetic blow past hop+release on the very first frame and
    // teleport to the release-end point. We re-anchor: pretend the
    // playhead is just past A+D, and grow from there at real-time.
    const f = releasedFx as { inS: number; outS: number };
    const releaseStartMaster = f.outS - env.releaseS;
    const releaseElapsed = Math.max(0, currentTime - releaseStartMaster);
    localT = env.attackS + env.decayS + releaseElapsed;
  }

  // While held (persistent or preview audition): pin at sustain knee.
  // Otherwise: traverse sustain-hop then release-bezier.
  const pt = curvePointAtTime(env, localT, geom, isHeld);

  // Sustain-pulse modulation — small radius oscillation while parked.
  const inSustain = pt.phase === "sustain";
  const pulseScale = inSustain ? 1 + 0.15 * Math.sin(pulse * 2 * Math.PI * 1.4) : 1;
  const dotR = 2.4 * pulseScale;
  const haloR = 6.5 * pulseScale;

  // Comet trail during the sustain-hop sweep — a fading line from the
  // sustain start (dx, dy) to the current dot position. Phosphor-tube
  // afterimage, makes the jump read as a deliberate dash instead of a
  // teleport. Brightest at the head, fading toward the tail.
  const showHopTrail = pt.phase === "sustain-hop";
  const trailGradId = `${clipId}-trail`;

  return (
    <g pointerEvents="none">
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={Math.max(0, pt.x)} height={plotH} />
        </clipPath>
        {showHopTrail && (
          <linearGradient
            id={trailGradId}
            gradientUnits="userSpaceOnUse"
            x1={geom.dx}
            y1={geom.dy}
            x2={pt.x}
            y2={pt.y}
          >
            <stop offset="0%" stopColor="#9FE08E" stopOpacity={0} />
            <stop offset="60%" stopColor="#9FE08E" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#E8FFD9" stopOpacity={1} />
          </linearGradient>
        )}
      </defs>
      {/* Past-trace area-fill — translucent green under the curve up to
       *  the indicator's x. Reads as "energy already deposited". */}
      <path
        d={filledCurve}
        fill="#9FE08E"
        fillOpacity={0.18}
        stroke="none"
        clipPath={`url(#${clipId})`}
        filter="url(#vas-crt-glow)"
      />
      {/* Past-trace bright stroke — the played portion is rendered
       *  bright on top of the dim background curve. */}
      <path
        d={curve}
        stroke="#9FE08E"
        strokeWidth="1.6"
        fill="none"
        clipPath={`url(#${clipId})`}
        filter="url(#vas-crt-glow)"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Sustain-hop comet trail. Lit only while crossing the plateau
       *  between the D-knee and the S-knee — the phosphor "dash" that
       *  carries the playhead from one end of sustain to the other.
       *  Stacked layers (wide soft halo → mid → bright spine) give the
       *  trail a real "bloom" instead of a flat line. */}
      {showHopTrail && (
        <>
          <line
            x1={geom.dx}
            y1={geom.dy}
            x2={pt.x}
            y2={pt.y}
            stroke="#9FE08E"
            strokeOpacity={0.45}
            strokeWidth={5}
            strokeLinecap="round"
            filter="url(#vas-crt-glow)"
          />
          <line
            x1={geom.dx}
            y1={geom.dy}
            x2={pt.x}
            y2={pt.y}
            stroke={`url(#${trailGradId})`}
            strokeWidth={2.6}
            strokeLinecap="round"
            filter="url(#vas-crt-glow)"
          />
          <line
            x1={geom.dx}
            y1={geom.dy}
            x2={pt.x}
            y2={pt.y}
            stroke="#FFFFFF"
            strokeOpacity={0.7}
            strokeWidth={0.8}
            strokeLinecap="round"
          />
        </>
      )}
      {/* Faint vertical scope line dropping from the indicator down to
       *  the floor. Sells the oscilloscope-readout feel without
       *  overwhelming the curve itself. */}
      <line
        x1={pt.x}
        x2={pt.x}
        y1={pt.y + 1}
        y2={plotH}
        stroke="#9FE08E"
        strokeOpacity={0.22}
        strokeWidth={0.6}
      />
      {/* Glow ball rides the leading edge. Halo + bright core. The halo
       *  blooms during sustain-hop for a real "comet head" feel — the
       *  trail's brightest point should also be its biggest. */}
      <circle
        cx={pt.x}
        cy={pt.y}
        r={showHopTrail ? haloR * 2.0 : haloR}
        fill="#9FE08E"
        opacity={showHopTrail ? 0.5 : 0.18}
        filter="url(#vas-crt-glow)"
      />
      <circle
        cx={pt.x}
        cy={pt.y}
        r={showHopTrail ? dotR * 1.6 : dotR}
        fill="#FFFFFF"
        filter="url(#vas-crt-glow)"
      />
      {/* Bright pinpoint core — only visible during the hop, makes the
       *  comet head pop out of its halo. */}
      {showHopTrail && (
        <circle
          cx={pt.x}
          cy={pt.y}
          r={dotR * 0.6}
          fill="#FFFFFF"
        />
      )}
    </g>
  );
}

type AdsrAxis = "A" | "D" | "S";

/** Handlers returned by `useAdsrDrag`. Wired to whichever element should
 *  receive pointer-down (an AdsrNode <g>, the PlotProxyZone <rect>, …);
 *  the same handlers are shared across all drag surfaces so there is a
 *  single source of truth for the start-snapshot and active axis. */
interface AdsrDrag {
  beginDrag: (axis: AdsrAxis, e: ReactPointerEvent<Element>) => void;
  onPointerMove: (e: ReactPointerEvent<Element>) => void;
  onPointerUp: (e: ReactPointerEvent<Element>) => void;
  resetEnv: () => void;
}

/** Pointer-driven ADSR drag controller. Snapshots the envelope at
 *  pointer-down and accumulates per-axis deltas with the encoder-style
 *  shift-fine sensitivity (6×). The same instance is shared between the
 *  per-knot AdsrNodes and the plot-wide PlotProxyZone — both surfaces
 *  feed into one startRef so a drag started in either place behaves
 *  identically and the active-axis indicator stays consistent. */
function useAdsrDrag(opts: {
  env: ADSREnvelope;
  kind: FxKind;
  plotH: number;
  xPerS: number;
  setEnv: (kind: FxKind, partial: Partial<ADSREnvelope>) => void;
  resetEnv: (kind: FxKind) => void;
  setActive: (a: AdsrAxis | null) => void;
}): AdsrDrag {
  const startRef = useRef<{
    x: number;
    y: number;
    env: ADSREnvelope;
    axis: AdsrAxis;
  } | null>(null);

  // Belt-and-suspenders against stuck drags when the pointerup is lost
  // off-window or off-element. Pairs with the `e.buttons === 0` guard
  // in onPointerMove for re-entries that arrive without an up event.
  const setActive = opts.setActive;
  useEffect(() => {
    function clearStaleDrag() {
      if (startRef.current) {
        startRef.current = null;
        setActive(null);
      }
    }
    window.addEventListener("pointerup", clearStaleDrag);
    window.addEventListener("pointercancel", clearStaleDrag);
    window.addEventListener("blur", clearStaleDrag);
    return () => {
      window.removeEventListener("pointerup", clearStaleDrag);
      window.removeEventListener("pointercancel", clearStaleDrag);
      window.removeEventListener("blur", clearStaleDrag);
    };
  }, [setActive]);

  const beginDrag = (axis: AdsrAxis, e: ReactPointerEvent<Element>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startRef.current = {
      x: e.clientX,
      y: e.clientY,
      env: { ...opts.env },
      axis,
    };
    opts.setActive(axis);
  };

  const onPointerMove = (e: ReactPointerEvent<Element>) => {
    const start = startRef.current;
    if (!start) return;
    // Stale-drag guard. setPointerCapture can lose the up event when
    // the cursor leaves the browser window — without this, the next
    // move snaps the knot back to the cursor as if the user were still
    // holding the button. `e.buttons === 0` means no button is pressed.
    if (e.buttons === 0) {
      startRef.current = null;
      opts.setActive(null);
      return;
    }
    const sens = e.shiftKey ? 6 : 1;
    const dxPx = (e.clientX - start.x) / sens;
    const dyPx = (e.clientY - start.y) / sens;
    const dS = dxPx / opts.xPerS;
    const dLevel = -dyPx / opts.plotH; // up = larger sustain

    if (start.axis === "A") {
      const next = clamp(start.env.attackS + dS, 0, ADSR_MAX_A_S);
      opts.setEnv(opts.kind, { attackS: next });
    } else if (start.axis === "D") {
      const nextD = clamp(start.env.decayS + dS, 0, ADSR_MAX_D_S);
      const nextS = clamp(start.env.sustain + dLevel, 0, 1);
      opts.setEnv(opts.kind, { decayS: nextD, sustain: snapDetent(nextS) });
    } else {
      // S: X-drag = release time (drag left → larger releaseS, since
      // sx = rightX - releaseS*xPerS). Y-drag = sustain level (linked
      // with the D knot).
      const nextR = clamp(start.env.releaseS - dS, 0, ADSR_MAX_R_S);
      const nextS = clamp(start.env.sustain + dLevel, 0, 1);
      opts.setEnv(opts.kind, { releaseS: nextR, sustain: snapDetent(nextS) });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<Element>) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    startRef.current = null;
    opts.setActive(null);
  };

  const resetEnv = () => opts.resetEnv(opts.kind);

  return { beginDrag, onPointerMove, onPointerUp, resetEnv };
}

interface AdsrNodeProps {
  axis: AdsrAxis;
  cx: number;
  cy: number;
  active: boolean;
  drag: AdsrDrag;
}

/**
 * One draggable phosphor knot on the ADSR curve. Pointer-down delegates
 * to the shared `useAdsrDrag` controller; the visible dot enlarges
 * while active. Double-click resets the whole envelope to the kind's
 * default.
 */
function AdsrNode({ axis, cx, cy, active, drag }: AdsrNodeProps) {
  const onPointerDown = (e: ReactPointerEvent<SVGGElement>) => {
    drag.beginDrag(axis, e);
    e.stopPropagation();
  };
  const onDoubleClick = (e: ReactPointerEvent<SVGGElement>) => {
    e.stopPropagation();
    drag.resetEnv();
  };

  const r = active ? 3.5 : 2.5;
  return (
    <g
      onPointerDown={onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      onDoubleClick={onDoubleClick}
      style={{ cursor: "grab", touchAction: "none" }}
    >
      {/* Larger invisible hit-target — fingers on touch screens need a
       *  generous tap area; the visible knot is just 5–7 px. r=14 SVG
       *  units → ~30 px tap diameter on a typical mobile LCD width
       *  (close to the 44 px Apple HIG target without overlapping
       *  neighbouring knots). The PlotProxyZone behind these knots
       *  catches anything outside this radius. */}
      <circle cx={cx} cy={cy} r={14} fill="transparent" pointerEvents="all" />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="#9FE08E"
        filter="url(#vas-crt-glow)"
        opacity={active ? 1 : 0.85}
        pointerEvents="none"
      />
    </g>
  );
}

/** Plot-wide pointer surface that grabs the nearest knot when the user
 *  taps anywhere inside the LCD. Removes the need for finger-precision
 *  on small mobile screens — even with knots pinned at their data-max
 *  (e.g. sustain=1 hugging the inner top), tapping near them is enough.
 *  Renders below the AdsrNodes so direct hits on a knot's hit-circle
 *  still take priority via SVG paint-order. */
function PlotProxyZone({
  geom,
  plotW,
  plotH,
  drag,
}: {
  geom: AdsrGeom;
  plotW: number;
  plotH: number;
  drag: AdsrDrag;
}) {
  const onPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // SVG uses preserveAspectRatio="none" with viewBox=0,0,plotW,plotH,
    // so client px → SVG units is a straight per-axis ratio.
    const svgX = ((e.clientX - rect.left) / rect.width) * plotW;
    const svgY = ((e.clientY - rect.top) / rect.height) * plotH;
    const candidates: { axis: AdsrAxis; cx: number; cy: number }[] = [
      { axis: "A", cx: geom.ax, cy: geom.ay },
      { axis: "D", cx: geom.dx, cy: geom.dy },
      { axis: "S", cx: geom.sx, cy: geom.sy },
    ];
    let nearestAxis: AdsrAxis = "A";
    let nearestD2 = Infinity;
    for (const c of candidates) {
      const dx = c.cx - svgX;
      const dy = c.cy - svgY;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearestAxis = c.axis;
      }
    }
    drag.beginDrag(nearestAxis, e);
  };

  return (
    <rect
      x={0}
      y={0}
      width={plotW}
      height={plotH}
      fill="transparent"
      pointerEvents="all"
      onPointerDown={onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerUp}
      style={{ touchAction: "none" }}
    />
  );
}

/** Soft detent at sustain = 0 / 0.5 / 1.0 within ±2 % — same UX language
 *  as the encoder's bipolar centre detent. */
function snapDetent(v: number): number {
  if (Math.abs(v - 0) < 0.02) return 0;
  if (Math.abs(v - 0.5) < 0.02) return 0.5;
  if (Math.abs(v - 1) < 0.02) return 1;
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// — Constants & styles ————————————————————————————————————

const ENCODER_HOT = "#FF5722";
const ENCODER_COBALT = "#1F4E8C";

const ENC_OUTER = 50;
const ENC_BODY = 36;
const ENC_BODY_INSET = (ENC_OUTER - ENC_BODY) / 2;
const ENC_CAP = 28;
const ENC_CAP_INSET = (ENC_OUTER - ENC_CAP) / 2;

const ALUMINUM_BODY: CSSProperties = {
  background:
    "linear-gradient(180deg, #E8E1D0 0%, #D5CAA8 52%, #C9BFA6 100%)",
  border: "1px solid rgba(26,24,22,0.22)",
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.55)",
    "inset 0 -1px 0 rgba(0,0,0,0.10)",
    "0 1px 1px rgba(0,0,0,0.08)",
  ].join(", "),
};

const ALUMINUM_LABEL: CSSProperties = {
  color: "rgba(26,24,22,0.6)",
  textShadow: "0 0.5px 0 rgba(255,255,255,0.5)",
  fontWeight: 600,
};

const KNURLED_GRIP: CSSProperties = {
  background:
    "repeating-linear-gradient(90deg, rgba(26,24,22,0.22) 0px, rgba(26,24,22,0.22) 1px, rgba(255,255,255,0.55) 1px, rgba(255,255,255,0.55) 2px, transparent 2px, transparent 3px)",
  boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.06)",
};

const MECHANISM_BODY: CSSProperties = {
  background: "linear-gradient(180deg, #181513 0%, #0E0C0A 100%)",
  borderTop: "1px solid rgba(0,0,0,0.7)",
  borderLeft: "1px solid rgba(0,0,0,0.65)",
  borderRight: "1px solid rgba(0,0,0,0.65)",
  borderBottom: "none",
  borderRadius: "6px 6px 0 0",
  boxShadow: [
    "inset 0 5px 8px -2px rgba(0,0,0,0.55)",
    "inset 0 -8px 12px -2px rgba(0,0,0,0.75)",
    "inset 4px 0 8px -3px rgba(0,0,0,0.5)",
    "inset -4px 0 8px -3px rgba(0,0,0,0.5)",
  ].join(", "),
};

const BRUSHED_GRAIN: CSSProperties = {
  background:
    "repeating-linear-gradient(90deg, transparent 0, transparent 1px, rgba(255,255,255,0.025) 1px, rgba(255,255,255,0.025) 2px), linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%)",
};

/** LCD frame dimensions. On wide layouts the LCD is a fixed 158×78 plate
 *  next to the encoders; on narrow (mobile) layouts it spans the full
 *  panel width and gets a taller plot area so the ENV curve stays
 *  finger-friendly. */
function lcdStyle(narrow: boolean): CSSProperties {
  return {
    width: narrow ? "100%" : 158,
    height: narrow ? 96 : 78,
    background: "linear-gradient(180deg, #1A2418 0%, #1F2A1E 100%)",
    border: "1px solid rgba(0,0,0,0.7)",
    borderRadius: 3,
    boxShadow: [
      "inset 0 1px 1px rgba(0,0,0,0.7)",
      "inset 0 -1px 1px rgba(255,255,255,0.04)",
      "0 0 0 2px rgba(0,0,0,0.35)",
    ].join(", "),
  };
}

const LCD_TEXT: CSSProperties = {
  color: "#9FE08E",
  textShadow: "0 0 4px rgba(159,224,142,0.55), 0 0 1px rgba(159,224,142,0.9)",
  fontWeight: 600,
};

const LCD_TEXT_DIM: CSSProperties = {
  color: "#6EA060",
  textShadow: "0 0 3px rgba(110,160,96,0.4)",
  fontWeight: 700,
};

const LCD_HOT_DOT: CSSProperties = {
  color: ENCODER_HOT,
  textShadow: `0 0 4px ${ENCODER_HOT}cc`,
};

const LCD_COBALT_DOT: CSSProperties = {
  color: "#5BC0DE",
  textShadow: "0 0 4px #5BC0DEcc",
};

function padBodyStyle(
  pressed: boolean,
  selected: boolean,
  ledColor: string,
  glow: number,
): CSSProperties {
  return {
    width: 60,
    height: 60,
    minWidth: 48,
    minHeight: 48,
    background: "linear-gradient(180deg, #4A4640 0%, #2C2925 100%)",
    border: selected
      ? `1px solid ${ledColor}`
      : "1px solid rgba(0,0,0,0.7)",
    boxShadow: [
      "inset 0 1px 1px rgba(255,255,255,0.08)",
      "inset 0 -1px 1px rgba(0,0,0,0.6)",
      glow > 0
        ? `0 0 ${8 * glow}px ${ledColor}, 0 0 ${16 * glow}px ${ledColor}`
        : "0 1px 1px rgba(0,0,0,0.4)",
      selected ? `0 0 0 1px ${ledColor}40` : "",
    ]
      .filter(Boolean)
      .join(", "),
    transform: pressed ? "translateY(1px)" : "translateY(0)",
    transition: "box-shadow 220ms ease-out, transform 60ms ease-out, border-color 120ms",
  };
}

function padRubberStyle(pressed: boolean, color: string): CSSProperties {
  return {
    background: pressed
      ? `radial-gradient(circle at 50% 35%, ${lighten(color, 0.25)} 0%, ${color} 40%, ${darken(color, 0.4)} 100%)`
      : `radial-gradient(circle at 50% 35%, ${lighten(color, 0.18)} 0%, ${darken(color, 0.15)} 50%, ${darken(color, 0.5)} 100%)`,
    boxShadow:
      "inset 0 1px 1px rgba(255,255,255,0.18), inset 0 -1px 1px rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function lighten(hex: string, fraction: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return hex;
  const r = Math.min(255, Math.round(parseInt(c.slice(0, 2), 16) + 255 * fraction));
  const g = Math.min(255, Math.round(parseInt(c.slice(2, 4), 16) + 255 * fraction));
  const b = Math.min(255, Math.round(parseInt(c.slice(4, 6), 16) + 255 * fraction));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
function darken(hex: string, fraction: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return hex;
  const r = Math.max(0, Math.round(parseInt(c.slice(0, 2), 16) * (1 - fraction)));
  const g = Math.max(0, Math.round(parseInt(c.slice(2, 4), 16) * (1 - fraction)));
  const b = Math.max(0, Math.round(parseInt(c.slice(4, 6), 16) * (1 - fraction)));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
