/**
 * Threshold + min-pause sliders that drive the silence-detection
 * algorithm. Slider changes re-run silence detection on the cached
 * envelope (cheap, sub-ms) and write the new chunks back to the
 * Triage store + IDB.
 *
 * The actual per-chunk BPM detection only re-runs when chunk
 * boundaries change AND the chunk is long enough — handled inside
 * `detectChunksFromEnvelope`.
 */
import { useCallback, useRef } from "react";
import {
  detectChunksFromEnvelope,
} from "../../local/triage/chunk-detect";
import { jobsDb } from "../../local/jobs";
import { useTriageStore } from "../../local/triage/triage-store";
import type { SilenceConfig } from "../../storage/jobs-db";

export function DetectionPanel() {
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const setSilenceConfig = useTriageStore((s) => s.setSilenceConfig);
  const setChunks = useTriageStore((s) => s.setChunks);
  const chunks = useTriageStore((s) => s.chunks);
  const acceptedCount = chunks.filter((c) => c.accepted).length;
  const acceptedDurationMs = chunks
    .filter((c) => c.accepted)
    .reduce((acc, c) => acc + (c.endMs - c.startMs), 0);

  const liveDebounceRef = useRef<number | null>(null);
  const persistDebounceRef = useRef<number | null>(null);

  // Re-detect on slider change. Debounced (50 ms) so dragging stays
  // smooth — re-detection on the cached envelope is fast but the
  // per-chunk BPM analysis isn't free.
  const reDetect = useCallback(
    (config: SilenceConfig) => {
      const state = useTriageStore.getState();
      if (!state.pcm || !state.envelope || !state.jobId) return;
      void detectChunksFromEnvelope(
        state.pcm,
        state.pcmSampleRate,
        state.envelope,
        config,
      ).then((result) => {
        // Preserve existing accept/reject decisions where the chunk
        // boundaries match exactly. Any chunk whose start/end didn't
        // line up with an existing one starts default-accepted.
        const merged = result.chunks.map((c) => {
          const prev = state.chunks.find(
            (p) => p.startMs === c.startMs && p.endMs === c.endMs,
          );
          if (prev) {
            return { ...c, accepted: prev.accepted, bpmOctaveShift: prev.bpmOctaveShift };
          }
          return c;
        });
        setChunks(merged);
      });
    },
    [setChunks],
  );

  // Persist to IDB at a slower cadence (250 ms) so we don't hammer
  // IndexedDB on every slider tick.
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
    <section className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <header className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center justify-between">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Detection
        </span>
        <span className="font-mono text-[10px] tabular text-ink-3">
          {chunks.length} chunks
        </span>
      </header>
      <div className="p-3 space-y-4">
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
        <div className="border-t border-rule pt-2 grid grid-cols-2 gap-2 text-[11px]">
          <Stat label="Kept" value={`${acceptedCount} chunk${acceptedCount === 1 ? "" : "s"}`} />
          <Stat label="Time" value={formatDuration(acceptedDurationMs)} />
        </div>
        <div className="border-t border-rule pt-2">
          <SessionBpmRow />
        </div>
      </div>
    </section>
  );
}

function SessionBpmRow() {
  const sessionBpm = useTriageStore((s) => s.sessionBpmOverride);
  const setSessionBpm = useTriageStore((s) => s.setSessionBpm);
  // Local edit buffer so the user can type freely without the store
  // bouncing values back at every keystroke.
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          Session BPM
        </span>
        <span className="font-mono text-[10px] tabular text-ink-3">
          {sessionBpm ? "forced" : "auto per chunk"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={40}
          max={240}
          step={0.5}
          value={sessionBpm ?? ""}
          placeholder="auto"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") {
              setSessionBpm(null);
              return;
            }
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) setSessionBpm(n);
          }}
          className="flex-1 h-8 bg-paper-deep border border-rule rounded px-2 font-mono tabular text-sm text-ink focus:outline-none focus:border-cobalt"
        />
        {sessionBpm !== null && (
          <button
            type="button"
            onClick={() => setSessionBpm(null)}
            className="font-mono text-[10px] tracking-label uppercase text-ink-3 hover:text-ink"
            title="Revert to per-chunk auto-detected BPM"
          >
            auto
          </button>
        )}
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
    <label className="block">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular text-ink">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-hot"
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-display tracking-label uppercase text-[9px] text-ink-3">
        {label}
      </div>
      <div className="font-mono tabular text-ink">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
