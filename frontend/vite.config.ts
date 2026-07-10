/// <reference types="vitest" />
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The ffmpeg core files live at unversioned URLs (/ffmpeg-core/*) and are
// runtime-cached CacheFirst for a year. The loader appends ?v=<version> so
// a core upgrade actually reaches existing clients (new URL → cache miss)
// instead of pinning a stale core against an updated wrapper forever.
// (@ffmpeg/core's exports map blocks `require("@ffmpeg/core/package.json")`,
// hence the direct file read.)
const ffmpegCoreVersion: string = JSON.parse(
  readFileSync(
    new URL("./node_modules/@ffmpeg/core/package.json", import.meta.url),
    "utf-8",
  ),
).version;

// COOP/COEP-Header sind Pflicht für SharedArrayBuffer und damit für
// WASM-Threads und ffmpeg.wasm. Sie werden im Dev-Server (hier) und im
// Production-nginx (nginx.conf) gesetzt — beides muss übereinstimmen, sonst
// crossOriginIsolated === false.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Read .env / .env.local from the repo root, not from frontend/. The
  // root is where docker-compose.yml lives, and we want a single source of
  // truth for both `npm run dev` (here) and the Docker build (which reads
  // the same .env to populate VITE_* build args).
  envDir: "..",
  define: {
    __FFMPEG_CORE_VERSION__: JSON.stringify(ffmpegCoreVersion),
  },
  plugins: [
    react(),
    VitePWA({
      // "prompt" (not "autoUpdate"): autoUpdate generates a SW with
      // skipWaiting + clientsClaim, so a deploy landing mid-session
      // activates the new SW immediately and purges the old hashed lazy
      // chunks from the precache (cleanupOutdatedCaches) — the server no
      // longer has them either, so the next Export / add-cam / ffmpeg
      // fallback dies with "Failed to fetch dynamically imported module"
      // in the middle of an editing session. With "prompt" the new SW
      // stays waiting until every tab of the old session is closed: live
      // sessions keep their fully-precached old build, fresh sessions get
      // the new one.
      registerType: "prompt",
      injectRegister: "auto",
      workbox: {
        // Precache the app shell only — ffmpeg-core (~31 MB ESM, ~62 MB
        // incl. UMD) is deliberately excluded so first contact stays fast.
        // It's served via runtimeCaching below: fetched on demand the first
        // time a render needs it, then cached for offline reuse.
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
        globIgnores: ["**/__test_fixtures__/**", "ffmpeg-core/**"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/ffmpeg-core/],
        runtimeCaching: [
          {
            urlPattern: /^.*\/ffmpeg-core\/.*$/,
            handler: "CacheFirst",
            options: {
              cacheName: "ffmpeg-core",
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: "TK-1 — Take One",
        short_name: "TK-1",
        description:
          "Multi-cam music video editor — audio is master, every angle aligns.",
        theme_color: "#FAF6EC",
        background_color: "#FAF6EC",
        display: "standalone",
        start_url: "/",
        scope: "/",
        lang: "en",
        icons: [
          { src: "/pwa-icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/pwa-icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      // SW im Dev aus — sonst kollidiert er mit Vite-HMR und der COOP/COEP-
      // Iteration. Verifikation läuft über `npm run build && npm run preview`.
      devOptions: { enabled: false },
    }),
  ],
  optimizeDeps: {
    include: ["mp4box", "mp4-muxer", "idb"],
    // ffmpeg.wasm spawns its own worker via
    // `new Worker(new URL('./worker.js', import.meta.url))`. The dep
    // optimizer flattens the directory layout and breaks those paths;
    // excluding lets Vite serve the package as-is so the runtime URL
    // resolution finds the worker file where the package expects it.
    // jassub stays in the optimizer (it has many transitive deps) but
    // we explicitly bundle its worker via `?worker&url` in compositor.ts.
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  // sync.worker.ts dynamically imports the wasm-pack output, which forces
  // code-splitting inside the worker bundle. Vite's default worker format
  // is "iife", which Rollup rejects for code-split outputs. ESM workers
  // are fine here — both workers are instantiated with { type: "module" }.
  worker: {
    format: "es",
  },
  server: {
    headers: crossOriginIsolationHeaders,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
