/**
 * Lazy ffmpeg.wasm loader.
 *
 * Uses the single-threaded core (~25 MB) served from `/ffmpeg-core/` (copied
 * from `@ffmpeg/core` at install time). Single-threaded keeps the COOP/COEP
 * setup simple — no SharedArrayBuffer-backed threads, no nested workers.
 * Slower than the MT core but the fallback path is rare so it's a fair
 * trade. The bundled `ffmpeg.worker.js` is the wrapper from
 * `@ffmpeg/ffmpeg`, which we serve via `classWorkerURL` so Vite doesn't
 * have to discover `new URL("./worker.js", import.meta.url)` inside the
 * library.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
// Vite handles `?worker&url` by building the worker (with its imports
// transitively bundled) and exposing the resulting URL as the default
// import. This sidesteps the relative-import problem we'd hit if we just
// dropped @ffmpeg/ffmpeg's worker.js into /public/ as-is.
import ffmpegWorkerUrl from "@ffmpeg/ffmpeg/worker?worker&url";

/** Injected by Vite's `define` from @ffmpeg/core's package.json. */
declare const __FFMPEG_CORE_VERSION__: string;

const BASE_URL = "/ffmpeg-core";
/** The core files sit at unversioned URLs but are runtime-cached
 *  CacheFirst (1 year) by the service worker. Keying the URL on the
 *  installed @ffmpeg/core version busts that cache exactly when the
 *  core actually changes — otherwise an updated wrapper (hashed chunk,
 *  updates every deploy) could run against a year-old cached core. */
const VERSION_QUERY = `?v=${__FFMPEG_CORE_VERSION__}`;

let loadPromise: Promise<FFmpeg> | null = null;

export function getFfmpeg(): Promise<FFmpeg> {
  if (!loadPromise) {
    const p = (async () => {
      const ffmpeg = new FFmpeg();
      try {
        // Use the ESM core build because @ffmpeg/ffmpeg's worker creates a
        // module-type Worker (when classWorkerURL is set) and needs a
        // dynamically importable script, not the UMD `importScripts` flavour.
        let coreURL: string;
        let wasmURL: string;
        try {
          [coreURL, wasmURL] = await Promise.all([
            toBlobURL(
              `${BASE_URL}/ffmpeg-core-esm.js${VERSION_QUERY}`,
              "text/javascript",
            ),
            toBlobURL(
              `${BASE_URL}/ffmpeg-core-esm.wasm${VERSION_QUERY}`,
              "application/wasm",
            ),
          ]);
        } catch (e) {
          // The core is ~25 MB and fetched on demand — a flaky connection
          // (or an offline PWA that never cached it) is the realistic
          // failure here. Name the cause so the banner is actionable.
          const cause = e instanceof Error ? e.message : String(e);
          throw new Error(
            `Could not download the media decoder (~25 MB) — ` +
              `check your connection and retry. (${cause})`,
          );
        }
        await ffmpeg.load({
          coreURL,
          wasmURL,
          classWorkerURL: ffmpegWorkerUrl,
        });
        return ffmpeg;
      } catch (e) {
        // Don't leave a half-initialized worker behind for the retry.
        try {
          ffmpeg.terminate();
        } catch {
          /* not spawned yet */
        }
        throw e;
      }
    })();
    loadPromise = p;
    // A rejected load must not be memoized forever: clear the memo so the
    // next decode retries (e.g. after connectivity returns) instead of
    // failing instantly with the stale error until page reload.
    p.catch(() => {
      if (loadPromise === p) loadPromise = null;
    });
  }
  return loadPromise;
}

/** Resets the singleton (test-only — production never needs this). */
export function _resetFfmpegForTests(): void {
  loadPromise = null;
}
