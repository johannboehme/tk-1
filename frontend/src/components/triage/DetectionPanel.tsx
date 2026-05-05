/**
 * Threshold + min-pause sliders + kept-counter LCD, laid out as a
 * horizontal "deck control strip" — meant to live next to the snap
 * cassette plate, between the upper rack and the timeline. The
 * counter doubles as a passive readout: as the user drags the
 * threshold the kept count + summed duration update live.
 *
 * Slider changes re-run silence detection on the cached envelope
 * (cheap, sub-ms) and write the new chunks back to the Triage store +
 * IDB.
 *
 * BPM lives on the brass plate inside ChunkInspector — this panel
 * is purely about "where do chunks begin and end".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { detectChunksFromEnvelope } from "../../local/triage/chunk-detect";
import { jobsDb } from "../../local/jobs";
import {
  isChunkEffectivelyAccepted,
  useTriageStore,
} from "../../local/triage/triage-store";
import type { SilenceConfig } from "../../storage/jobs-db";

const MIN_BARS_FILTER_MAX = 999;

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
const LCD_AMBER = "#FFB347";
const GLOW_GREEN =
  "0 0 5px rgba(157,239,208,0.4), 0 0 1px rgba(157,239,208,0.8)";
const GLOW_AMBER =
  "0 0 6px rgba(255,179,71,0.55), 0 0 1px rgba(255,179,71,0.9)";

export function DetectionPanel() {
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const setSilenceConfig = useTriageStore((s) => s.setSilenceConfig);
  const setChunks = useTriageStore((s) => s.setChunks);
  const chunks = useTriageStore((s) => s.chunks);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const setMinChunkBars = useTriageStore((s) => s.setMinChunkBars);
  const jobBpmValue = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  // "Kept" counts only chunks that survive both the user's manual
  // accept AND the active min-bars filter. Toggling the filter back
  // off restores the count without touching anyone's accept flag.
  const effectivelyAccepted = chunks.filter((c) =>
    isChunkEffectivelyAccepted(c, minChunkBars, jobBpmValue, beatsPerBar),
  );
  const acceptedCount = effectivelyAccepted.length;
  const acceptedDurationMs = effectivelyAccepted.reduce(
    (acc, c) => acc + (c.endMs - c.startMs),
    0,
  );

  const liveDebounceRef = useRef<number | null>(null);
  const persistDebounceRef = useRef<number | null>(null);

  const reDetect = useCallback(
    (config: SilenceConfig) => {
      const state = useTriageStore.getState();
      if (!state.envelope || !state.jobId) return;
      void detectChunksFromEnvelope(
        state.pcm ?? new Float32Array(0),
        state.pcmSampleRate,
        state.envelope,
        config,
      ).then((result) => {
        // Preserve the user's per-chunk accept/reject decisions across
        // re-detection. The min-bars filter is a view concern and
        // doesn't touch chunk.accepted here.
        const merged = result.chunks.map((c) => {
          const prev = state.chunks.find(
            (p) => p.startMs === c.startMs && p.endMs === c.endMs,
          );
          if (prev) {
            return {
              ...c,
              accepted: prev.accepted,
              bpmOctaveShift: prev.bpmOctaveShift,
              detectedBpm: c.detectedBpm ?? prev.detectedBpm,
              effectiveBpm: c.detectedBpm ? c.effectiveBpm : prev.effectiveBpm,
              audioStartMs: c.audioStartMs ?? prev.audioStartMs,
            };
          }
          return c;
        });
        setChunks(merged);
      });
    },
    [setChunks],
  );

  const persist = useCallback((config: SilenceConfig) => {
    const state = useTriageStore.getState();
    if (!state.jobId) return;
    if (persistDebounceRef.current !== null) {
      window.clearTimeout(persistDebounceRef.current);
    }
    persistDebounceRef.current = window.setTimeout(() => {
      void jobsDb.updateJob(state.jobId!, {
        silenceConfig: config,
        chunks: state.chunks,
      });
      persistDebounceRef.current = null;
    }, 250);
  }, []);

  function onChange(patch: Partial<SilenceConfig>) {
    const next = { ...silenceConfig, ...patch };
    setSilenceConfig(next);
    if (liveDebounceRef.current !== null) {
      window.clearTimeout(liveDebounceRef.current);
    }
    liveDebounceRef.current = window.setTimeout(() => {
      reDetect(next);
      persist(next);
      liveDebounceRef.current = null;
    }, 50);
  }

  return (
    <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 sm:gap-4 items-center">
      <div className="flex flex-col gap-1.5 min-w-0">
        <SliderRow
          label="Threshold"
          value={silenceConfig.thresholdDb}
          min={-80}
          max={-10}
          step={1}
          unit="dBFS"
          format={(v) => `${v} dB`}
          onChange={(v) => onChange({ thresholdDb: v })}
        />
        <SliderRow
          label="Min pause"
          value={silenceConfig.minPauseMs}
          min={250}
          max={10000}
          step={50}
          unit="ms"
          format={(v) =>
            v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} s` : `${v} ms`
          }
          onChange={(v) => onChange({ minPauseMs: v })}
        />
      </div>
      <MinBarsFilter
        value={minChunkBars}
        onChange={setMinChunkBars}
      />
      <KeptCounter
        chunkCount={chunks.length}
        keptCount={acceptedCount}
        totalMs={acceptedDurationMs}
      />
    </div>
  );
}

/** Brass-bezel LCD with click-to-edit number input — same edit
 *  pattern as the BpmReadout. User can type any positive integer
 *  (no power-of-2 restriction); 0 or empty turns the filter off.
 *  LCD reads mint-green when off, amber when engaged. */
function MinBarsFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(value > 0 ? String(value) : "");
    setEditing(true);
  }
  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onChange(0);
    } else {
      const n = Math.floor(Number(trimmed));
      if (Number.isFinite(n) && n >= 0 && n <= MIN_BARS_FILTER_MAX) {
        onChange(n);
      }
    }
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
  }

  const isDefault = value === 0;
  const lcdColor = isDefault ? LCD_GREEN : LCD_AMBER;
  const lcdGlow = isDefault ? GLOW_GREEN : GLOW_AMBER;
  const display = isDefault ? "OFF" : `≥${value}`;

  const bezel: React.CSSProperties = {
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

  const lcdShared: React.CSSProperties = {
    height: 28,
    background: LCD_BG,
    boxShadow: LCD_SHADOW,
    color: lcdColor,
    textShadow: lcdGlow,
  };
  const lcdClass = [
    "font-mono tabular tracking-[0.05em]",
    "text-base px-2 rounded-[3px] w-[68px]",
    "border border-black/40",
    "inline-flex items-center justify-center leading-none",
  ].join(" ");

  return (
    <div
      className="inline-flex items-center gap-2 self-center shrink-0"
      style={bezel}
    >
      <span
        aria-hidden
        className="font-display text-[8px] tracking-[0.18em] text-ink-2 leading-tight uppercase"
        style={{
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          letterSpacing: "0.18em",
        }}
      >
        MIN
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          min={0}
          max={MIN_BARS_FILTER_MAX}
          step={1}
          value={draft}
          placeholder="0"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          className={`${lcdClass} text-right outline-none focus:border-hot`}
          style={{
            ...lcdShared,
            paddingTop: 0,
            paddingBottom: 0,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          aria-label={`Min bars filter ${display} — click to change`}
          title="Hide chunks shorter than this many bars (0 = off)"
          className={`${lcdClass} cursor-pointer transition hover:brightness-110`}
          style={lcdShared}
        >
          {display}
        </button>
      )}
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Optional formatter — e.g. "ms" → "1.5 s" once the value crosses 1000. */
  format?: (value: number) => string;
  onChange: (v: number) => void;
}

/** Studio-fader-style slider: brass bezel cradle with a recessed dark
 *  track, phosphor-amber fill from min → current, and a chunky bevelled
 *  thumb. Uses a hidden `<input type="range">` for native a11y +
 *  keyboard semantics; the visual surface intercepts pointer events
 *  for the polished feel. Tick marks along the track give the scale a
 *  hardware-instrument vibe without crowding the panel. */
function SliderRow({ label, value, min, max, step, unit, format, onChange }: SliderRowProps) {
  const fraction = (value - min) / Math.max(1e-9, max - min);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  function pickFromClientX(clientX: number): number {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    let f = (clientX - rect.left) / Math.max(1, rect.width);
    f = Math.max(0, Math.min(1, f));
    let next = min + f * (max - min);
    if (step > 0) next = Math.round(next / step) * step;
    return Math.max(min, Math.min(max, next));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onChange(pickFromClientX(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    onChange(pickFromClientX(e.clientX));
  }
  function onPointerUp(e: React.PointerEvent) {
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Five tick marks (0, 25, 50, 75, 100 %) — purely decorative, gives
  // the eye a sense of how far the fader has travelled.
  const tickFractions = [0, 0.25, 0.5, 0.75, 1];
  const display = format ? format(value) : `${value} ${unit}`.trim();

  return (
    <div className="grid grid-cols-[80px_1fr_72px] items-center gap-2 min-w-0">
      <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
        {label}
      </span>
      <div
        className="relative h-7 select-none touch-none"
        style={{
          background:
            "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 50%, #C9BFA6 100%)",
          borderRadius: 5,
          padding: 4,
          boxShadow: [
            "inset 0 1px 0 rgba(255,255,255,0.85)",
            "inset 0 -1px 0 rgba(0,0,0,0.18)",
            "0 1px 1px rgba(0,0,0,0.10)",
          ].join(", "),
        }}
      >
        <div
          ref={trackRef}
          className="relative w-full h-full cursor-ew-resize"
          role="slider"
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            const big = e.shiftKey ? 10 : 1;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              onChange(Math.max(min, value - step * big));
            } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              onChange(Math.min(max, value + step * big));
            } else if (e.key === "Home") {
              e.preventDefault();
              onChange(min);
            } else if (e.key === "End") {
              e.preventDefault();
              onChange(max);
            }
          }}
          style={{
            background:
              "linear-gradient(180deg, #14110F 0%, #2A2722 100%)",
            borderRadius: 3,
            boxShadow: [
              "inset 0 1px 2px rgba(0,0,0,0.55)",
              "inset 0 -1px 0 rgba(255,255,255,0.05)",
              "inset 0 0 0 1px rgba(0,0,0,0.4)",
            ].join(", "),
            overflow: "hidden",
          }}
        >
          {/* Phosphor fill from left edge to current fraction. */}
          <div
            className="absolute top-0 bottom-0 left-0 pointer-events-none"
            style={{
              width: `${fraction * 100}%`,
              background:
                "linear-gradient(180deg, rgba(255,179,71,0.35) 0%, rgba(255,87,34,0.55) 100%)",
              boxShadow: "0 0 8px rgba(255,138,79,0.55)",
            }}
          />
          {/* Tick marks across the full track. */}
          {tickFractions.map((f, i) => (
            <span
              key={i}
              aria-hidden
              className="absolute top-1/2 pointer-events-none"
              style={{
                left: `${f * 100}%`,
                transform: "translate(-50%, -50%)",
                width: 1,
                height: 6,
                background: "rgba(250,246,236,0.25)",
              }}
            />
          ))}
          {/* Thumb — bevelled brass cap with an amber centre dot. */}
          <div
            className="absolute top-1/2 pointer-events-none"
            style={{
              left: `${fraction * 100}%`,
              transform: "translate(-50%, -50%)",
              width: 14,
              height: 18,
              borderRadius: 2,
              background:
                "linear-gradient(180deg, #FAF6EC 0%, #E8E1D0 45%, #BCB199 100%)",
              boxShadow: [
                "inset 0 1px 0 rgba(255,255,255,0.95)",
                "inset 0 -1px 0 rgba(0,0,0,0.30)",
                "0 2px 4px rgba(0,0,0,0.45)",
              ].join(", "),
            }}
          >
            <span
              aria-hidden
              className="absolute top-1/2 left-1/2 rounded-full"
              style={{
                transform: "translate(-50%, -50%)",
                width: 4,
                height: 4,
                background: "#FF8A4F",
                boxShadow:
                  "0 0 4px rgba(255,138,79,0.85), 0 0 1px rgba(255,87,34,0.95)",
              }}
            />
          </div>
        </div>
      </div>
      {/* Phosphor-amber LCD readout — same vocabulary as the KEPT/MIN
       *  LCDs so the deck strip reads as a coherent panel of
       *  instruments. */}
      <span
        className="font-mono tabular text-[10px] inline-flex items-center justify-center px-1.5 border border-black/40 leading-none"
        style={{
          height: 22,
          borderRadius: 3,
          background: LCD_BG,
          boxShadow: LCD_SHADOW,
          color: LCD_AMBER,
          textShadow: GLOW_AMBER,
        }}
      >
        {display}
      </span>
    </div>
  );
}

/** Brass-bezel LCD readout with vertical "KEPT" stencil. Visual
 *  vocabulary matches the MinBarsFilter trigger so the two sit
 *  side-by-side on the deck strip as a matched pair. */
function KeptCounter({
  chunkCount,
  keptCount,
  totalMs,
}: {
  chunkCount: number;
  keptCount: number;
  totalMs: number;
}) {
  const bezel: React.CSSProperties = {
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
  return (
    <div
      className="inline-flex items-center gap-2 self-center shrink-0"
      style={bezel}
    >
      <span
        aria-hidden
        className="font-display text-[8px] tracking-[0.18em] text-ink-2 leading-tight uppercase"
        style={{
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          letterSpacing: "0.18em",
        }}
      >
        KEPT
      </span>
      <div
        className="font-mono tabular px-2 rounded-[3px] inline-flex items-center gap-1.5 border border-black/40"
        style={{
          height: 28,
          background: LCD_BG,
          boxShadow: LCD_SHADOW,
          color: LCD_GREEN,
          textShadow: GLOW_GREEN,
        }}
      >
        <span className="text-[12px]">{keptCount}</span>
        <span className="text-[10px] opacity-60">/</span>
        <span className="text-[10px]">{chunkCount}</span>
        <span className="text-[10px] opacity-60">·</span>
        <span className="text-[12px]">{formatDuration(totalMs)}</span>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s.toString().padStart(2, "0")}`;
}
