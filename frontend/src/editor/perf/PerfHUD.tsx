/**
 * Dev-only performance HUD for live-performance latency measurement.
 *
 * Mounts a tiny floating panel in the bottom-right corner. Subscribes to
 * the `marks.ts` perf-event bus and shows rolling p50 / p95 / max for
 * each tracked metric. Auto-hides when perf is disabled.
 *
 * Visual style: TE-inspired LCD readout (mono font, deep panel, hot
 * accent on stale/slow rows). Stays out of the way (small, corner,
 * pointer-events-none on container so it doesn't intercept clicks).
 */
import { useEffect, useState } from "react";
import {
  PERF_ENABLED,
  subscribe,
  type PerfEvent,
  type PerfEventKind,
} from "../../core/perf/marks";
import { tokens } from "../design-tokens";
import { useEditorStore } from "../store";

const RING_SIZE = 50;
const REFRESH_MS = 250;

interface MetricBucket {
  /** Last-N samples in ms, newest at end. */
  samples: number[];
  /** Optional sub-tag (e.g. shader name, cam id) of latest sample. */
  lastTag?: string;
}

const KIND_LABELS: Record<PerfEventKind, string> = {
  "press-to-paint": "PRESS→PAINT",
  "shader-cold": "SHADER COLD",
  "fx-first-render": "FX 1st DRAW",
  "cam-switch-to-paint": "CAM SWITCH",
};

/** Order in which metrics are listed in the HUD. */
const KIND_ORDER: PerfEventKind[] = [
  "press-to-paint",
  "cam-switch-to-paint",
  "fx-first-render",
  "shader-cold",
];

function pushSample(bucket: MetricBucket, value: number, tag?: string): void {
  bucket.samples.push(value);
  if (bucket.samples.length > RING_SIZE) bucket.samples.shift();
  if (tag !== undefined) bucket.lastTag = tag;
}

function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * p),
  );
  return sorted[idx];
}

function fmt(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 10) return ms.toFixed(1);
  return ms.toFixed(0);
}

/**
 * Pick a foreground colour for a value in ms. Frame budget at 60 fps is
 * 16.7 ms; over that the press misses a frame.
 */
function colorFor(ms: number): string {
  if (ms === 0) return tokens.color.ink3;
  if (ms < 8) return tokens.color.success;
  if (ms < 16.7) return tokens.color.ink2;
  if (ms < 33) return tokens.color.warn;
  return tokens.color.hot;
}

export function PerfHUD(): JSX.Element | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (!PERF_ENABLED) return;
    const buckets = new Map<PerfEventKind, MetricBucket>();
    function bucketFor(kind: PerfEventKind): MetricBucket {
      let b = buckets.get(kind);
      if (!b) {
        b = { samples: [] };
        buckets.set(kind, b);
      }
      return b;
    }

    const onEvent = (ev: PerfEvent): void => {
      const b = bucketFor(ev.kind);
      const tag =
        ev.kind === "shader-cold"
          ? ev.name
          : ev.kind === "cam-switch-to-paint"
            ? ev.camId
            : ev.kind === "press-to-paint"
              ? ev.key
              : undefined;
      pushSample(b, ev.durationMs, tag);
    };
    const unsub = subscribe(onEvent);

    // Stash buckets on the window for ad-hoc inspection / agents.
    (window as unknown as { __perfBuckets?: Map<PerfEventKind, MetricBucket> })
      .__perfBuckets = buckets;
    // Expose the store so bench scripts can drive playback / loop /
    // seek without going through the timeline UI. Strictly perf-mode.
    (window as unknown as { __editorStore?: typeof useEditorStore })
      .__editorStore = useEditorStore;

    const interval = window.setInterval(() => {
      // Trigger render. Reading buckets in the render path is fine since
      // the bus only mutates samples in place.
      force((n) => (n + 1) & 0xffff);
    }, REFRESH_MS);

    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, []);

  if (!PERF_ENABLED) return null;

  const buckets =
    ((window as unknown as { __perfBuckets?: Map<PerfEventKind, MetricBucket> })
      .__perfBuckets) ?? new Map<PerfEventKind, MetricBucket>();

  return (
    <div
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 9999,
        pointerEvents: "none",
        fontFamily: tokens.font.mono,
        fontSize: 10,
        lineHeight: "13px",
        padding: "8px 10px",
        background: tokens.color.sunken,
        color: tokens.color.inkInverse,
        border: `1px solid ${tokens.color.ruleSoft}`,
        borderRadius: tokens.radius.sm,
        boxShadow: tokens.shadow.lcd,
        minWidth: 200,
      }}
      aria-hidden
    >
      <div
        style={{
          color: tokens.color.hot,
          textTransform: "uppercase",
          letterSpacing: 1,
          fontSize: 9,
          marginBottom: 4,
          borderBottom: `1px solid ${tokens.color.sunkenSoft}`,
          paddingBottom: 3,
        }}
      >
        ⚡ PERF · last {RING_SIZE}
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ color: tokens.color.ink3 }}>
            <th style={{ textAlign: "left", paddingRight: 6, fontWeight: 400 }}>
              metric
            </th>
            <th style={{ textAlign: "right", paddingLeft: 4, fontWeight: 400 }}>
              p50
            </th>
            <th style={{ textAlign: "right", paddingLeft: 4, fontWeight: 400 }}>
              p95
            </th>
            <th style={{ textAlign: "right", paddingLeft: 4, fontWeight: 400 }}>
              max
            </th>
            <th style={{ textAlign: "right", paddingLeft: 4, fontWeight: 400 }}>
              n
            </th>
          </tr>
        </thead>
        <tbody>
          {KIND_ORDER.map((kind) => {
            const b = buckets.get(kind);
            const samples = b?.samples ?? [];
            const p50 = pct(samples, 0.5);
            const p95 = pct(samples, 0.95);
            const max = samples.length > 0 ? Math.max(...samples) : 0;
            return (
              <tr key={kind}>
                <td style={{ paddingRight: 6 }}>{KIND_LABELS[kind]}</td>
                <td
                  style={{
                    textAlign: "right",
                    paddingLeft: 4,
                    color: colorFor(p50),
                  }}
                >
                  {fmt(p50)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    paddingLeft: 4,
                    color: colorFor(p95),
                  }}
                >
                  {fmt(p95)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    paddingLeft: 4,
                    color: colorFor(max),
                  }}
                >
                  {fmt(max)}
                </td>
                <td
                  style={{
                    textAlign: "right",
                    paddingLeft: 4,
                    color: tokens.color.ink3,
                  }}
                >
                  {samples.length}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div
        style={{
          marginTop: 4,
          paddingTop: 3,
          borderTop: `1px solid ${tokens.color.sunkenSoft}`,
          color: tokens.color.ink3,
          fontSize: 9,
        }}
      >
        ms · 16.7 = 1 frame @ 60fps
      </div>
    </div>
  );
}
