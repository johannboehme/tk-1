/**
 * Browser-Capability-Detection.
 *
 * Synchroner Teil (`detectCapabilities`) prüft nur API-Vorhandensein — keine
 * Codec-Spezifika, weil das ein async-Call ist (`isConfigSupported`). Codec-
 * Detection lebt in `codec/resolve.ts` und passiert pro Datei.
 *
 * `meetsMinRequirements` definiert die App-weite Min-Anforderung. Browser, die
 * darunter liegen, sehen die Error-Page. Mit den Min-Anforderungen kann die App
 * IMMER lokal rendern: entweder via WebCodecs (Chrome/Safari) oder via
 * ffmpeg.wasm (Firefox/Safari ohne WebCodecs-Encoder).
 */

export interface Capabilities {
  webAssembly: boolean;
  sharedArrayBuffer: boolean;
  /** True nur wenn der Server COOP/COEP-Header gesetzt hat. */
  crossOriginIsolated: boolean;
  /** Origin Private File System für lokale, persistente Files. */
  opfs: boolean;
  audioDecoder: boolean;
  videoDecoder: boolean;
  audioEncoder: boolean;
  videoEncoder: boolean;
  /** showSaveFilePicker. Falls fehlend, fallen wir auf `<a download>` zurück. */
  fileSystemAccess: boolean;
  /** WebGL2 für den Compositor-GPU-Pfad. Fehlt → Canvas2D-Fallback. */
  webgl2: boolean;
  /** WebGPU — V1 noch nicht genutzt, aber Detection ist da, damit der
   *  Renderer-Picker später ohne Logik-Änderung darauf umsteigen kann. */
  webgpu: boolean;
}

export interface MinRequirementsResult {
  ok: boolean;
  missing: ReadonlyArray<keyof Capabilities>;
}

/**
 * Min-Anforderungen für die App. Begründung im Plan-File:
 * - WebAssembly: Sync-Algorithmus (sync-core) und ffmpeg.wasm-Fallback.
 * - SharedArrayBuffer + crossOriginIsolated: WASM-Threads (Performance).
 * - OPFS: lokale, persistente Files ohne 4-GB-Memory-Limit.
 *
 * WebCodecs ist NICHT min-required — wir haben den ffmpeg.wasm-Fallback.
 * fileSystemAccess ist NICHT min-required — `<a download>` reicht.
 */
const MIN_REQUIRED: ReadonlyArray<keyof Capabilities> = [
  "webAssembly",
  "sharedArrayBuffer",
  "crossOriginIsolated",
  "opfs",
];

export function detectCapabilities(): Capabilities {
  const w = globalThis as typeof globalThis & {
    SharedArrayBuffer?: unknown;
    AudioDecoder?: unknown;
    VideoDecoder?: unknown;
    AudioEncoder?: unknown;
    VideoEncoder?: unknown;
    showSaveFilePicker?: unknown;
    crossOriginIsolated?: boolean;
  };

  return {
    webAssembly: typeof WebAssembly !== "undefined",
    sharedArrayBuffer: typeof w.SharedArrayBuffer !== "undefined",
    crossOriginIsolated: w.crossOriginIsolated === true,
    opfs:
      typeof navigator !== "undefined" &&
      typeof navigator.storage !== "undefined" &&
      typeof navigator.storage.getDirectory === "function",
    audioDecoder: typeof w.AudioDecoder !== "undefined",
    videoDecoder: typeof w.VideoDecoder !== "undefined",
    audioEncoder: typeof w.AudioEncoder !== "undefined",
    videoEncoder: typeof w.VideoEncoder !== "undefined",
    fileSystemAccess: typeof w.showSaveFilePicker === "function",
    webgl2: detectWebGL2(),
    // webgpu defaults to false here — `"gpu" in navigator` is too weak
    // to gate the renderer on (Linux Chrome has navigator.gpu but
    // requestAdapter() can return null on hosts without a compatible
    // GPU). Use `probeWebGPU()` async to get a real value, then merge
    // it into the Capabilities returned from this function.
    webgpu: false,
  };
}

/** Module-singleton cache for the async WebGPU probe. Resolves once
 *  per process — `requestAdapter` is cheap on subsequent calls but
 *  caching avoids re-creating the promise + dropping unused adapters. */
let webgpuProbeCache: Promise<boolean> | null = null;

/**
 * Real WebGPU probe: actually calls `navigator.gpu.requestAdapter()`.
 * This is the only way to know if the platform has a usable adapter
 * (Linux Chrome / FF can have `navigator.gpu` but no compatible
 * adapter). Cached — call as many times as you like.
 *
 * Usage at app boot:
 *   const caps = detectCapabilities();
 *   caps.webgpu = await probeWebGPU();
 *   // … pass `caps` to consumers (compositor, factory, etc.)
 */
export function probeWebGPU(): Promise<boolean> {
  if (webgpuProbeCache) return webgpuProbeCache;
  webgpuProbeCache = (async () => {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { gpu?: GPU };
    if (!nav.gpu) return false;
    try {
      const adapter = await nav.gpu.requestAdapter();
      return adapter != null;
    } catch {
      return false;
    }
  })();
  return webgpuProbeCache;
}

/** Test-only: clear the WebGPU probe cache. Used so a test that
 *  monkey-patches `navigator.gpu` can re-probe without bleeding cache
 *  state into the next test. */
export function _resetWebGPUProbeForTest(): void {
  webgpuProbeCache = null;
  _capabilitiesSingleton = null;
}

// ---- Boot-singleton that merges sync + async probes ------------------
//
// Render-Konsumenten (PreviewRuntime, Compositor.tsx) brauchen
// `caps.webgpu` zur Mount-Zeit synchron. Wir caching daher das
// async-merged Resultat in einem Module-Singleton und erwarten dass
// der App-Boot `initCapabilities()` einmal aufruft, bevor der erste
// Render-Konsument mountet.

let _capabilitiesSingleton: Capabilities | null = null;

/**
 * Sync detect + async probeWebGPU, mergen das Resultat, und cachen es
 * für synchrone `getCapabilities()`-Aufrufe. Mehrfacher Aufruf ist OK
 * — gibt das gecachte Resultat (oder die laufende Promise im Konflikt-
 * fall) zurück. Boot-Pfad: einmal in App.tsx awaiten.
 */
export async function initCapabilities(): Promise<Capabilities> {
  if (_capabilitiesSingleton) return _capabilitiesSingleton;
  const sync = detectCapabilities();
  const webgpu = await probeWebGPU();
  _capabilitiesSingleton = { ...sync, webgpu };
  return _capabilitiesSingleton;
}

/**
 * Synchroner Lookup. Returns das initialisierte Singleton wenn
 * `initCapabilities()` schon resolved hat; sonst ein sync-detect
 * (mit `webgpu: false` weil noch nicht geprobed). Compositor.tsx /
 * PreviewRuntime callen das.
 *
 * Race-Condition-Behandlung: wenn ein Konsument vor dem Boot-Probe
 * mountet, sieht er webgpu=false → fällt auf WebGL2 zurück. Bei
 * Re-Mount nach erfolgreichem Probe wird WebGPU benutzt. Akzeptabel
 * weil App.tsx alle Render-Pfade hinter einem `ready`-State gatet
 * der initCapabilities() awaitet.
 */
export function getCapabilities(): Capabilities {
  return _capabilitiesSingleton ?? detectCapabilities();
}

/** Probe a throwaway canvas for a WebGL2 context. The canvas is
 *  immediately discarded — DOM cost is one allocation. Returns false in
 *  jsdom (no `document` or `getContext('webgl2')`). */
function detectWebGL2(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    return gl !== null;
  } catch {
    return false;
  }
}

export function meetsMinRequirements(caps: Capabilities): MinRequirementsResult {
  const missing = MIN_REQUIRED.filter((key) => caps[key] !== true);
  return {
    ok: missing.length === 0,
    missing,
  };
}

/**
 * Whether the browser can decode media files that exceed Chromium's
 * ~2 GiB single-ArrayBuffer cap. Streaming the encoded bytes off disk
 * (`File.stream()` → mp4box chunked → WebCodecs `AudioDecoder` /
 * `VideoDecoder`) is the only path that scales past that limit; without
 * BOTH WebCodecs decoders we have no way to handle multi-GB files.
 *
 * Browsers that fail this check today (May 2026):
 *   - Safari (AudioDecoder is in Technology Preview but not yet stable)
 *   - Firefox (full WebCodecs support is still landing)
 *
 * Smaller files still work in those browsers via the existing
 * `decodeAudioData` + ffmpeg.wasm fast path.
 */
export function supportsLargeMediaFiles(caps: Capabilities): boolean {
  return caps.audioDecoder && caps.videoDecoder;
}

/**
 * Per-file hard cap when `supportsLargeMediaFiles(caps) === false`.
 * Set well below Chromium's ~2 GiB ArrayBuffer ceiling so the fallback
 * decoders (`decodeAudioData`, ffmpeg.wasm MEMFS) have room to copy.
 */
export const LEGACY_BROWSER_MAX_FILE_BYTES = 1.9 * 1024 * 1024 * 1024;

/**
 * Menschenlesbares Label für jede Capability — verwendet auf der Error-Page
 * und im Settings-Capability-Report.
 */
export function describeCapability(key: keyof Capabilities): string {
  switch (key) {
    case "webAssembly":
      return "WebAssembly";
    case "sharedArrayBuffer":
      return "SharedArrayBuffer";
    case "crossOriginIsolated":
      return "Cross-Origin Isolation (COOP/COEP)";
    case "opfs":
      return "Origin Private File System";
    case "audioDecoder":
      return "WebCodecs AudioDecoder";
    case "videoDecoder":
      return "WebCodecs VideoDecoder";
    case "audioEncoder":
      return "WebCodecs AudioEncoder";
    case "videoEncoder":
      return "WebCodecs VideoEncoder";
    case "fileSystemAccess":
      return "File System Access API";
    case "webgl2":
      return "WebGL 2.0";
    case "webgpu":
      return "WebGPU";
  }
}
