/**
 * Lightweight perf-event bus for the editor.
 *
 * Goal: measure live-performance latency without leaving permanent
 * `console.log` spam in the hot path. Instrumentation sites emit typed
 * events through `emit()`; the dev-only `PerfHUD` subscribes to them and
 * shows rolling p50/p95.
 *
 * Enable via `?perf=1` in the URL or `localStorage.setItem("vasPerf","1")`.
 * When disabled, `emit()` is a no-op and `subscribe()` returns a no-op
 * unsubscribe — no allocations, no main-thread cost.
 *
 * Why a custom bus instead of `performance.mark` alone? PerformanceEntries
 * are buffered per-document and require name-prefix filtering and a poll
 * loop to consume. A 50-entry ring + pubsub is simpler and gives us typed
 * events that the HUD can render directly.
 */

export type PerfEvent =
  | {
      /** keypress → next React commit + next paint, in ms */
      kind: "press-to-paint";
      key: string;
      durationMs: number;
      perfNow: number;
    }
  | {
      /** WebGL2 fragment shader compile + link cost (cold path) */
      kind: "shader-cold";
      name: string;
      durationMs: number;
      perfNow: number;
    }
  | {
      /** Time from FX hold begin → first compositor RAF tick that
       *  drew the active fx. Closed by PreviewRuntime. */
      kind: "fx-first-render";
      durationMs: number;
      perfNow: number;
    }
  | {
      /** Time from cam-switch (active-cam-id changed) → next paint */
      kind: "cam-switch-to-paint";
      camId: string;
      durationMs: number;
      perfNow: number;
    };

export type PerfEventKind = PerfEvent["kind"];

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("perf") === "1") {
      return true;
    }
    return window.localStorage.getItem("vasPerf") === "1";
  } catch {
    return false;
  }
}

/** Resolved once per page load. Cheaper than reading localStorage in the
 *  hot path; flip the flag and reload. */
export const PERF_ENABLED: boolean = readEnabled();

type Listener = (ev: PerfEvent) => void;
const listeners = new Set<Listener>();

export function emit(ev: PerfEvent): void {
  if (!PERF_ENABLED) return;
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      /* listener errors must not break instrumentation sites */
    }
  }
}

export function subscribe(cb: Listener): () => void {
  if (!PERF_ENABLED) return () => undefined;
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Track keypress → paint latency. Call this synchronously from the
 * keydown handler. Uses a double-RAF: the first RAF runs after React
 * commit; the second runs after the browser paints that commit.
 *
 * No-op when perf is disabled.
 */
export function trackKeypressToPaint(key: string): void {
  if (!PERF_ENABLED) return;
  const t0 = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      emit({
        kind: "press-to-paint",
        key,
        durationMs: performance.now() - t0,
        perfNow: t0,
      });
    });
  });
}

/**
 * Wrap an async or sync block; reports its duration as a `shader-cold`
 * event. Used by the WebGL2 program-cache to log first-compile cost.
 */
export function timeShaderCompile<T>(name: string, fn: () => T): T {
  if (!PERF_ENABLED) return fn();
  const t0 = performance.now();
  const out = fn();
  emit({
    kind: "shader-cold",
    name,
    durationMs: performance.now() - t0,
    perfNow: t0,
  });
  return out;
}

/**
 * Track time from "FX hold began" (some store mutation set fxHolds
 * non-empty) until the FX overlay's RAF tick actually drew the first
 * frame with that FX visible.
 *
 * Caller pattern: pending = beginFxFirstRender(); then in the renderer's
 * tick, on the first draw call after a non-empty active list, call
 * pending?.end(). The owner is responsible for clearing the pending
 * handle so we don't double-count.
 */
export function beginFxFirstRender(): { end: () => void } | null {
  if (!PERF_ENABLED) return null;
  const t0 = performance.now();
  return {
    end() {
      emit({
        kind: "fx-first-render",
        durationMs: performance.now() - t0,
        perfNow: t0,
      });
    },
  };
}

/**
 * Track time from cam-switch initiated (e.g. `addCut` succeeded) until
 * the next paint. Symmetric with `trackKeypressToPaint` but tagged with
 * the cam id so the HUD can break it down per-cam.
 */
export function trackCamSwitchToPaint(camId: string): void {
  if (!PERF_ENABLED) return;
  const t0 = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      emit({
        kind: "cam-switch-to-paint",
        camId,
        durationMs: performance.now() - t0,
        perfNow: t0,
      });
    });
  });
}
