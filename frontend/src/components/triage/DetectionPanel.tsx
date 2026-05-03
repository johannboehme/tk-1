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
import { useCallback, useRef, useState } from "react";
import { detectChunksFromEnvelope } from "../../local/triage/chunk-detect";
import { jobsDb } from "../../local/jobs";
import {
  isChunkEffectivelyAccepted,
  useTriageStore,
} from "../../local/triage/triage-store";
import { HardwarePopover } from "../../editor/components/HardwarePopover";
import type { SilenceConfig } from "../../storage/jobs-db";

/** Bar-length threshold options for the min-bars filter. 0 = off. */
const MIN_BARS_OPTIONS: ReadonlyArray<{ value: number; label: string; short: string }> = [
  { value: 0, label: "OFF", short: "OFF" },
  { value: 1, label: "≥ 1", short: "≥1" },
  { value: 2, label: "≥ 2", short: "≥2" },
  { value: 4, label: "≥ 4", short: "≥4" },
  { value: 8, label: "≥ 8", short: "≥8" },
  { value: 16, label: "≥ 16", short: "≥16" },
];

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
          onChange={(v) => onChange({ thresholdDb: v })}
        />
        <SliderRow
          label="Min pause"
          value={silenceConfig.minPauseMs}
          min={250}
          max={10000}
          step={50}
          unit="ms"
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

/** Brass-bezel LCD readout + chip-grid popover for the min-bars
 *  filter. Visual vocabulary mirrors the BpmReadout / counter LCDs:
 *  cream bezel, scanline-screen LCD, mint-green when off, amber when
 *  the filter is engaged. The chip grid uses the same pattern as the
 *  time-signature picker. */
function MinBarsFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const matched = MIN_BARS_OPTIONS.find((o) => o.value === value);
  const isDefault = value === 0;
  const lcdColor = isDefault ? LCD_GREEN : LCD_AMBER;
  const lcdGlow = isDefault ? GLOW_GREEN : GLOW_AMBER;

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
        BARS
      </span>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Min bars filter ${matched?.label ?? "off"} — click to change`}
        title="Hide chunks shorter than this many bars"
        className={[
          "font-mono tabular tracking-[0.05em]",
          "text-base px-2 rounded-[3px] w-[58px]",
          "relative cursor-pointer transition",
          "border border-black/40 hover:brightness-110",
          "inline-flex items-center justify-center leading-none",
        ].join(" ")}
        style={{
          height: 28,
          background: LCD_BG,
          boxShadow: LCD_SHADOW,
          color: lcdColor,
          textShadow: lcdGlow,
        }}
      >
        {matched?.short ?? "OFF"}
      </button>
      <HardwarePopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="center"
        ariaLabel="Choose minimum bar length"
      >
        <MinBarsGrid
          value={value}
          onPick={(n) => {
            onChange(n);
            setOpen(false);
          }}
        />
      </HardwarePopover>
    </div>
  );
}

function MinBarsGrid({
  value,
  onPick,
}: {
  value: number;
  onPick: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 240 }}>
      <div className="flex items-baseline justify-between px-0.5">
        <span className="font-display text-[9px] tracking-[0.18em] uppercase text-ink-2">
          Min bars
        </span>
        <span className="font-mono text-[9px] text-ink-3">
          hide chunks below
        </span>
      </div>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
      >
        {MIN_BARS_OPTIONS.map((o) => {
          const selected = o.value === value;
          const isOff = o.value === 0;
          const lcdColor = isOff ? LCD_GREEN : LCD_AMBER;
          const lcdGlow = isOff ? GLOW_GREEN : GLOW_AMBER;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onPick(o.value)}
              aria-pressed={selected}
              className={[
                "h-9 min-w-[60px] rounded-[3px] font-mono tabular tracking-[0.05em] text-sm",
                "transition active:translate-y-[1px]",
                selected ? "" : "hover:brightness-105",
              ].join(" ")}
              style={
                selected
                  ? {
                      background: LCD_BG,
                      boxShadow: LCD_SHADOW,
                      color: lcdColor,
                      textShadow: lcdGlow,
                      border: "1px solid rgba(0,0,0,0.5)",
                    }
                  : {
                      background:
                        "linear-gradient(180deg, #FBF8EE 0%, #ECE3CE 100%)",
                      boxShadow: [
                        "inset 0 1px 0 rgba(255,255,255,0.9)",
                        "inset 0 -1px 0 rgba(0,0,0,0.15)",
                        "0 1px 1px rgba(0,0,0,0.15)",
                      ].join(", "),
                      color: "#1A1816",
                      border: "1px solid rgba(0,0,0,0.18)",
                    }
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
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
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step, unit, onChange }: SliderRowProps) {
  return (
    <label className="grid grid-cols-[80px_1fr_64px] items-center gap-2 min-w-0">
      <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-hot h-1"
      />
      <span className="font-mono text-[11px] tabular text-ink text-right">
        {value} {unit}
      </span>
    </label>
  );
}

/** Small LCD-style readout that mirrors the BpmReadout brass plate
 *  language. Bonded visually to the deck strip so the user reads it as
 *  a meter, not a label. */
function KeptCounter({
  chunkCount,
  keptCount,
  totalMs,
}: {
  chunkCount: number;
  keptCount: number;
  totalMs: number;
}) {
  return (
    <div className="flex flex-col items-end shrink-0">
      <span className="font-display text-[8px] tracking-[0.18em] text-ink-3 uppercase mb-0.5">
        Kept
      </span>
      <div
        className="font-mono tabular px-2 rounded-[3px] inline-flex items-center gap-1.5"
        style={{
          height: 26,
          background: LCD_BG,
          boxShadow: LCD_SHADOW,
          color: LCD_GREEN,
          textShadow: GLOW_GREEN,
          border: "1px solid rgba(0,0,0,0.5)",
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
