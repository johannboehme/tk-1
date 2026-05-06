/**
 * Canvas strip that renders bar / beat / subdivision ticks above the
 * timeline. Same coordinate space as the Timeline canvas:
 *   x_px = (t - scrollX) * pxPerSec
 * with `pxPerSec = (innerWidth) / (duration / zoom)`.
 *
 * Click → seek the playhead to the corresponding time. Touch + click both
 * dispatch via `seek` on the editor store.
 */
import { useEffect, useRef } from "react";
import { useEditorStore } from "../../store";
import {
  effectiveBeatPhaseS,
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
} from "../../selectors/timing";
import { arrToMaster, masterToArr } from "../../arrangement-time";
import { buildRulerTicks } from "./beat-ruler-ticks";

interface BeatRulerProps {
  /** Total ruler width in CSS pixels (the timeline-canvas content width
   *  minus the left header). The ruler maps the visible time-window into
   *  this width. */
  contentWidthPx: number;
  /** Master-time at the left edge of the visible canvas. May be negative
   *  when a cam anchors before t=0. */
  viewStartS: number;
  /** Master-time at the right edge. */
  viewEndS: number;
  /** Height in CSS pixels (typically 24-28). */
  height?: number;
  /** Optional left offset (px) — typically the timeline header width so
   *  the ruler aligns with the canvas content. */
  leftPaddingPx?: number;
}

export function BeatRuler({
  contentWidthPx,
  viewStartS,
  viewEndS,
  height = 26,
  leftPaddingPx = 0,
}: BeatRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value ?? null);
  // The selectors return master-time. The ruler renders against the
  // arr-time canvas (`viewStartS`/`viewEndS` are arr-time), so project
  // master-bar phase into arr-time once. With single-take's
  // whole-master segment this is Identity; long-form gets one master-
  // bar grid running continuously across the song instead of a
  // separate phase per chunk.
  const arrSegments = useEditorStore((s) => s.arrangementSegments);
  const beatPhase = useEditorStore((s) =>
    masterToArr(effectiveBeatPhaseS(s.jobMeta), arrSegments),
  );
  const beatsPerBar = useEditorStore((s) => effectiveBeatsPerBar(s.jobMeta));
  const barOffsetBeats = useEditorStore((s) =>
    effectiveBarOffsetBeats(s.jobMeta),
  );
  const seek = useEditorStore((s) => s.seek);
  const loop = useEditorStore((s) => s.playback.loop);

  // Repaint whenever any of the dependencies change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(contentWidthPx * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${contentWidthPx}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, contentWidthPx, height);

    // Paper-bg ruler background.
    ctx.fillStyle = "#E8E1D0";
    ctx.fillRect(0, 0, contentWidthPx, height);
    // Bottom rule line.
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, height - 1, contentWidthPx, 1);

    const visibleS = viewEndS - viewStartS;

    // Loop band on the ruler — same accent as the audio-lane loop tint
    // so the user can see the loop region above the bar grid (matters
    // most for the OP-1 style Alt-arrow loop-shift, where the playhead
    // stays in the old region while the loop visually jumps along the
    // bar grid). Drawn before the ticks so they remain readable.
    if (loop && visibleS > 0) {
      const pxPerSecRaw = contentWidthPx / Math.max(0.001, visibleS);
      const xs = (loop.start - viewStartS) * pxPerSecRaw;
      const xe = (loop.end - viewStartS) * pxPerSecRaw;
      const xsClamped = Math.max(0, xs);
      const xeClamped = Math.min(contentWidthPx, xe);
      if (xeClamped > xsClamped) {
        ctx.fillStyle = "rgba(255,87,34,0.18)";
        ctx.fillRect(xsClamped, 0, xeClamped - xsClamped, height - 1);
        ctx.strokeStyle = "rgba(255,87,34,0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(
          xsClamped + 0.5,
          0.5,
          Math.max(0, xeClamped - xsClamped - 1),
          height - 2,
        );
      }
    }

    if (!bpm || visibleS <= 0) return;

    const pxPerSec = contentWidthPx / Math.max(0.001, visibleS);
    const ticks = buildRulerTicks({
      bpm,
      beatPhase,
      startS: viewStartS,
      endS: viewEndS,
      pxPerSec,
      beatsPerBar,
      barOffsetBeats,
    });

    // Pick a "nice" label step so the labelled bars are always at
    // round numbers (1/5/10/25/...) regardless of the zoom level.
    // labelStep is the smallest entry from NICE_STEPS such that one
    // step on screen covers at least MIN_LABEL_SPACING_PX.
    const beatS = 60 / bpm;
    const barS = beatS * beatsPerBar;
    const pxPerBar = barS * pxPerSec;
    const NICE_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    const MIN_LABEL_SPACING_PX = 36;
    let labelStep = NICE_STEPS[NICE_STEPS.length - 1];
    for (const s of NICE_STEPS) {
      if (s * pxPerBar >= MIN_LABEL_SPACING_PX) {
        labelStep = s;
        break;
      }
    }

    ctx.fillStyle = "#1A1816";
    ctx.font = "10px ui-monospace, JetBrains Mono, monospace";
    ctx.textBaseline = "top";
    // Centre the label horizontally over its tick. Without this,
    // single-digit labels look offset to the right of the tick because
    // their natural width is much smaller than a multi-digit label's,
    // making a fixed left-anchor visually inconsistent.
    ctx.textAlign = "center";

    // Reserve a 12 px band at the top for the bar-number labels so the
    // ticks never overlap them. All tick heights live inside the
    // remaining "tick area" below that band, scaled by kind.
    const TICK_AREA = Math.max(4, height - 12);

    // Single pass: draw the ticks; emit a label only when the bar
    // number is a multiple of labelStep (with bar 1 always shown so
    // the timeline always anchors at "1").
    for (const tick of ticks) {
      const x = (tick.t - viewStartS) * pxPerSec;
      let h: number;
      let opacity = 1;
      switch (tick.kind) {
        case "bar":
          h = TICK_AREA;
          break;
        case "beat":
          h = Math.round(TICK_AREA * 0.6);
          break;
        case "div8":
          h = Math.round(TICK_AREA * 0.35);
          opacity = 0.6;
          break;
        case "div16":
          h = Math.round(TICK_AREA * 0.22);
          opacity = 0.45;
          break;
      }
      ctx.fillStyle =
        tick.kind === "bar"
          ? "rgba(26,24,22,0.9)"
          : `rgba(26,24,22,${0.6 * opacity})`;
      ctx.fillRect(Math.floor(x), height - 1 - h, 1, h);
      if (
        tick.kind === "bar" &&
        tick.barNumber !== undefined &&
        (tick.barNumber === 1 || tick.barNumber % labelStep === 0)
      ) {
        ctx.fillStyle = "#1A1816";
        // textAlign=center → the second arg is the centre x of the
        // string. Anchored exactly on the tick column so a "1" sits
        // visually centred on the bar-1 tick, the same way "10" does.
        ctx.fillText(String(tick.barNumber), Math.floor(x), 1);
      }
    }
  }, [
    bpm,
    beatPhase,
    beatsPerBar,
    barOffsetBeats,
    viewStartS,
    viewEndS,
    contentWidthPx,
    height,
    loop,
  ]);

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const visibleS = viewEndS - viewStartS;
    if (visibleS <= 0) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Canvas runs in arr-time; `seek` takes master-time. Identity
    // for single-take's whole-master segment.
    const arrT = viewStartS + (x / contentWidthPx) * visibleS;
    seek(arrToMaster(arrT, arrSegments));
  }

  return (
    <div style={{ paddingLeft: leftPaddingPx }} className="relative select-none">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        className="block cursor-pointer"
        data-testid="beat-ruler"
      />
    </div>
  );
}
