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
import { useCallback, useRef } from "react";
import { detectChunksFromEnvelope } from "../../local/triage/chunk-detect";
import { jobsDb } from "../../local/jobs";
import {
  applyMinBarsFilter,
  useTriageStore,
} from "../../local/triage/triage-store";
import type { SilenceConfig } from "../../storage/jobs-db";

/** Bar-length threshold options for the min-bars filter. 0 = off. */
const MIN_BARS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "off" },
  { value: 1, label: "≥ 1 bar" },
  { value: 2, label: "≥ 2 bars" },
  { value: 4, label: "≥ 4 bars" },
  { value: 8, label: "≥ 8 bars" },
  { value: 16, label: "≥ 16 bars" },
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
const GLOW_GREEN =
  "0 0 5px rgba(157,239,208,0.4), 0 0 1px rgba(157,239,208,0.8)";

export function DetectionPanel() {
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const setSilenceConfig = useTriageStore((s) => s.setSilenceConfig);
  const setChunks = useTriageStore((s) => s.setChunks);
  const chunks = useTriageStore((s) => s.chunks);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const setMinChunkBars = useTriageStore((s) => s.setMinChunkBars);
  const acceptedCount = chunks.filter((c) => c.accepted).length;
  const acceptedDurationMs = chunks
    .filter((c) => c.accepted)
    .reduce((acc, c) => acc + (c.endMs - c.startMs), 0);

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
        // Re-apply the active min-bars filter so newly-emitted short
        // chunks don't leak in as accepted on slider tweaks.
        const filtered = applyMinBarsFilter(
          merged,
          state.minChunkBars,
          state.jobBpm?.value ?? null,
          state.beatsPerBar,
        );
        setChunks(filtered);
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

function MinBarsFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col items-start gap-1 shrink-0">
      <span className="font-display text-[8px] tracking-[0.18em] text-ink-3 uppercase">
        Min bars
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={[
          "h-[26px] rounded-[3px] border border-black/40",
          "font-mono tabular text-[11px] text-ink",
          "bg-paper-hi px-2 pr-6 cursor-pointer",
          "focus:outline-none focus:border-cobalt",
        ].join(" ")}
        title="Auto-drop chunks shorter than this many bars"
      >
        {MIN_BARS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
