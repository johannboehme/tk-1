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
import { mergeRedetectedChunks } from "../../local/triage/redetect-merge";
import { jobsDb } from "../../local/jobs";
import { confirmDestructive } from "../../lib/confirm";
import {
  isChunkEffectivelyAccepted,
  useTriageStore,
} from "../../local/triage/triage-store";
import {
  BarCountLcd,
  LCD_BG,
  LCD_SHADOW,
  LCD_GREEN,
  LCD_AMBER,
  GLOW_GREEN,
  GLOW_AMBER,
} from "./BarCountLcd";
import type { SilenceConfig } from "../../storage/jobs-db";

export function DetectionPanel() {
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const setSilenceConfig = useTriageStore((s) => s.setSilenceConfig);
  const setChunks = useTriageStore((s) => s.setChunks);
  const chunks = useTriageStore((s) => s.chunks);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const setMinChunkBars = useTriageStore((s) => s.setMinChunkBars);
  const jobBpmValue = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  // Cached opens seed the store with an empty PCM and decode the real
  // one in the background. A re-detect in that window would run without
  // per-chunk analysis (no BPM, no onset anchor, no bar-snapped ends) —
  // hold the sliders until the decode lands.
  const pcmDecoding = useTriageStore((s) => s.pcmDecoding);
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
  /** One-shot session gate: the first slider tweak with downstream work
   *  (persisted arrangement, manual chunk edits) goes through the same
   *  confirmDestructive() dialog as reject/split/join. Once approved,
   *  subsequent tweaks in this Triage session run freely. */
  const redetectApprovedRef = useRef(false);
  /** Deduplicates concurrent approval checks during a slider drag —
   *  every onPointerMove would otherwise open its own dialog. */
  const approvalPromiseRef = useRef<Promise<boolean> | null>(null);

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
        // Reconcile against the CURRENT chunk list (not the kickoff
        // snapshot) via the overlap merge: keep/drop decisions, ids and
        // manual edits survive the boundary shifts every parameter
        // change produces — so arrangement / pill references stay
        // valid and a slider tweak doesn't quietly empty the user's
        // arrangement.
        const prev = useTriageStore.getState().chunks;
        setChunks(mergeRedetectedChunks(prev, result.chunks));
      });
    },
    [setChunks],
  );

  const ensureRedetectApproved = useCallback((): Promise<boolean> => {
    if (redetectApprovedRef.current) return Promise.resolve(true);
    if (approvalPromiseRef.current) return approvalPromiseRef.current;
    const pending = (async () => {
      const state = useTriageStore.getState();
      const hasManualEdits = state.chunks.some(
        (c) => c.trimMode !== "auto" || !c.accepted,
      );
      let hasArrangement = false;
      if (state.jobId) {
        const job = await jobsDb.getJob(state.jobId).catch(() => undefined);
        hasArrangement = (job?.arrangement ?? []).length > 0;
      }
      if (!hasManualEdits && !hasArrangement) {
        // Nothing downstream to protect — don't nag.
        redetectApprovedRef.current = true;
        return true;
      }
      const ok = await confirmDestructive({
        title: "Re-run detection?",
        body:
          "Changing detection settings re-segments the audio. Kept/dropped flags and manual edits carry over where chunks still overlap, but chunks the new segmentation drops disappear from the arrangement too.",
        destructiveLabel: "Re-detect",
      });
      if (ok) redetectApprovedRef.current = true;
      return ok;
    })().finally(() => {
      approvalPromiseRef.current = null;
    });
    approvalPromiseRef.current = pending;
    return pending;
  }, []);

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
    void ensureRedetectApproved().then((approved) => {
      if (!approved) return;
      // Read the config fresh — during a drag several onChange calls
      // can await the same approval, and each must stack on the latest
      // applied value, not on its own stale render snapshot.
      const next = { ...useTriageStore.getState().silenceConfig, ...patch };
      setSilenceConfig(next);
      if (liveDebounceRef.current !== null) {
        window.clearTimeout(liveDebounceRef.current);
      }
      liveDebounceRef.current = window.setTimeout(() => {
        reDetect(next);
        persist(next);
        liveDebounceRef.current = null;
      }, 50);
    });
  }

  return (
    <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 sm:gap-4 items-center">
      <div className="relative flex flex-col gap-1.5 min-w-0">
        <SliderRow
          label="Threshold"
          value={silenceConfig.thresholdDb}
          min={-80}
          max={-10}
          step={1}
          unit="dBFS"
          format={(v) => `${v} dB`}
          disabled={pcmDecoding}
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
          disabled={pcmDecoding}
          onChange={(v) => onChange({ minPauseMs: v })}
        />
        {pcmDecoding && (
          <span
            className="font-mono text-[9px] tracking-label uppercase"
            style={{ color: "#B8865A" }}
          >
            decoding audio… sliders unlock when it's done
          </span>
        )}
      </div>
      <BarCountLcd
        label="MIN"
        value={minChunkBars}
        onChange={setMinChunkBars}
        title="Hide chunks shorter than this many bars (0 = off)"
        ariaLabel={`Min bars filter ${minChunkBars === 0 ? "OFF" : `≥${minChunkBars}`} — click to change`}
      />
      <KeptCounter
        chunkCount={chunks.length}
        keptCount={acceptedCount}
        totalMs={acceptedDurationMs}
      />
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
  /** Freeze the fader (pointer + keyboard) — used while the background
   *  PCM decode is still running and a re-detect would be lossy. */
  disabled?: boolean;
  onChange: (v: number) => void;
}

/** Studio-fader-style slider: brass bezel cradle with a recessed dark
 *  track, phosphor-amber fill from min → current, and a chunky bevelled
 *  thumb. Uses a hidden `<input type="range">` for native a11y +
 *  keyboard semantics; the visual surface intercepts pointer events
 *  for the polished feel. Tick marks along the track give the scale a
 *  hardware-instrument vibe without crowding the panel. */
function SliderRow({ label, value, min, max, step, unit, format, disabled, onChange }: SliderRowProps) {
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
    if (disabled) return;
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onChange(pickFromClientX(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (disabled || !draggingRef.current) return;
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
          className={
            disabled
              ? "relative w-full h-full cursor-default"
              : "relative w-full h-full cursor-ew-resize"
          }
          role="slider"
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-disabled={disabled ? "true" : undefined}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            if (disabled) return;
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
          {/* Phosphor fill from left edge to current fraction. Goes cold
           *  (solid slate, no glow) while the control is frozen. */}
          <div
            className="absolute top-0 bottom-0 left-0 pointer-events-none"
            style={{
              width: `${fraction * 100}%`,
              background: disabled
                ? "linear-gradient(180deg, #4A443B 0%, #5D5546 100%)"
                : "linear-gradient(180deg, rgba(255,179,71,0.35) 0%, rgba(255,87,34,0.55) 100%)",
              boxShadow: disabled ? undefined : "0 0 8px rgba(255,138,79,0.55)",
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
