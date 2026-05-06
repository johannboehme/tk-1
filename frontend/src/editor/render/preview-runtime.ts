/**
 * Live preview runtime — the single class that wires the new pipeline:
 *
 *   1. Owns the `VideoElementPool` (one `<video>` per cam, off-screen).
 *   2. Owns an `ImageBitmap` cache for image clips (loaded once each).
 *   3. Owns a `CompositorBackend` from the factory ladder.
 *   4. Drives one RAF: read store → sync pool → build descriptor →
 *      build sources map → backend.drawFrame.
 *
 * The runtime has no React. `Compositor.tsx` (Schritt 7) is a thin
 * shell that mounts the canvas + a parent for the video pool and
 * instantiates this class.
 */
import { AdaptiveScaler } from "./adaptive-scaler";
import type { CompositorBackend, LayerSource, SourcesMap } from "./backend";
import { createBackend, type BackendCapabilities } from "./factory";
import {
  buildPreviewFrameDescriptor,
  type EditorStoreSnapshot,
} from "./build-descriptor";
import {
  VideoElementPool,
  type PoolSyncTarget,
  type VideoCam,
  type VideoElementPoolOptions,
} from "./video-element-pool";
import { useEditorStore } from "../store";
import { isImageClip, isVideoClip, type Clip } from "../types";

export type ClipUrlMap = Readonly<Record<string, { videoUrl: string }>>;

export interface PreviewRuntimeOptions {
  canvas: HTMLCanvasElement;
  cams: ClipUrlMap;
  capabilities: BackendCapabilities;
  /** Initial CSS dims of the canvas. The runtime sets backbuffer to
   *  cssW * dpr * scale. */
  cssW: number;
  cssH: number;
  dpr?: number;
  /** Initial backbuffer scale (resolution dial). Default 1. */
  initialScale?: number;
  /** Per-tick frame-budget in ms. When a tick exceeds this, the next
   *  tick skips its draw to give the main thread breathing room — the
   *  audio scheduler RAF must keep firing on time even if a single
   *  preview frame's GPU upload spikes (multi-cam loop wrap on long
   *  files is the canonical trigger). Default 14ms ≈ 84% of a 60 Hz
   *  frame. Set to Infinity to disable. */
  frameBudgetMs?: number;
  /** Test-injection. Defaults to the production factory. */
  createBackendFn?: typeof createBackend;
  /** Test-injection. Defaults to `new VideoElementPool(opts)`. */
  createPool?: (opts: VideoElementPoolOptions) => VideoElementPool;
  /** Test-injection — overridable RAF schedulers. Defaults to window. */
  raf?: (cb: FrameRequestCallback) => number;
  cancelRaf?: (id: number) => void;
  /** Test-injection — read EditorStoreSnapshot. Defaults to useEditorStore. */
  readSnapshot?: () => EditorStoreSnapshot;
  /** Test-injection — read playback (currentTime + isPlaying + timelineT).
   *  `currentTime` is master-time (drives the audio decoder seek inside
   *  the pool); `timelineT` is the walker's authoritative timeline-position
   *  (drives every consumer that resolves "what should be on screen RIGHT
   *  HERE on the song"). */
  readPlayback?: () => {
    currentTime: number;
    timelineT: number;
    isPlaying: boolean;
  };
  /** Test-injection — load an image bitmap from a URL. */
  loadBitmap?: (url: string) => Promise<ImageBitmap>;
  /** Test-injection — snapshot a live `<video>` element into an
   *  ImageBitmap. Defaults to `createImageBitmap(el)`. */
  createBitmapFromVideo?: (el: HTMLVideoElement) => Promise<ImageBitmap>;
  /** Test-injection — high-resolution clock. Defaults to `performance.now`.
   *  Used by the frame-budget watchdog. */
  now?: () => number;
}

/** Minimum gap between two snapshot refreshes for the SAME layer.
 *  60Hz `createImageBitmap(<video>)` would churn the heap without
 *  meaningful benefit — the cache only needs to overbridge the 1–3
 *  decode-frames after a seek. */
const SNAPSHOT_THROTTLE_MS = 100;
const READY_HAVE_CURRENT_DATA = 2;

export class PreviewRuntime {
  private opts: Required<
    Pick<PreviewRuntimeOptions, "dpr" | "initialScale" | "raf" | "cancelRaf" | "readSnapshot" | "readPlayback" | "loadBitmap" | "createBitmapFromVideo" | "createBackendFn" | "createPool" | "now" | "frameBudgetMs">
  > &
    PreviewRuntimeOptions;

  private backend: CompositorBackend | null = null;
  private pool: VideoElementPool | null = null;
  private bitmaps = new Map<string, ImageBitmap>();
  /** Set of urls we're already loading — avoids duplicate fetches when
   *  the same image clip lingers across many RAF ticks before its
   *  bitmap resolves. */
  private bitmapsLoading = new Set<string>();
  /** Last successfully decoded `<video>` frame per layerId, captured
   *  whenever the element was ready at draw time. While the element is
   *  mid-seek (after a scrub or loop wrap) we hand this bitmap to the
   *  backend instead of the empty/transparent video — without it, the
   *  unconditional black background-clear flashes through for the
   *  1–3 decode frames the seek takes. */
  private lastGoodFrames = new Map<
    string,
    { bitmap: ImageBitmap; lastSnapshotMs: number }
  >();
  /** Layers for which a snapshot is currently in flight. Prevents two
   *  overlapping `createImageBitmap` calls for the same layer (the
   *  second would race the first and leak the loser). */
  private snapshotInFlight = new Set<string>();

  private rafId: number | null = null;
  private running = false;
  private scale: number;
  private cssW: number;
  private cssH: number;
  private dpr: number;
  /** Auto-scaling at runtime: misst tick-Latenz und reduziert die
   *  Backbuffer-Auflösung wenn die preview ins Stottern gerät. Macht
   *  4K-Multi-Cam mit FX spielbar (und damit als Instrument benutzbar)
   *  auch auf weniger leistungsstarken GPUs. */
  private adaptiveScaler: AdaptiveScaler;
  /** When the previous tick exceeded the frame budget, skip THIS
   *  tick's draw. One-shot — cleared every tick. Pool sync still
   *  runs (cheap) so cam decoders stay aligned. */
  private skipNextDraw = false;
  /** Last clip-list reference seen by `tick()`. Used to dirty-flag
   *  pool reconciliation: when the store's clips array reference is
   *  unchanged, no clip was added/removed/edited, so `pool.setCams`
   *  doesn't need to run. Prevents 60Hz heap churn (collectVideoCams
   *  allocates a fresh VideoCam[] on every call). */
  private lastReconciledClipsRef: readonly Clip[] | null = null;
  /** Last cams URL map reference seen by `tick()`. Symmetric to
   *  `lastReconciledClipsRef` for the runtime-side cams map (which
   *  changes when the editor receives a "+ Media" event). */
  private lastReconciledCamsRef: ClipUrlMap | null = null;

  constructor(options: PreviewRuntimeOptions) {
    this.cssW = options.cssW;
    this.cssH = options.cssH;
    this.dpr = options.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    this.scale = options.initialScale ?? 1;
    this.adaptiveScaler = new AdaptiveScaler(this.scale);
    this.opts = {
      ...options,
      dpr: this.dpr,
      initialScale: this.scale,
      raf: options.raf ?? ((cb) => requestAnimationFrame(cb)),
      cancelRaf: options.cancelRaf ?? ((id) => cancelAnimationFrame(id)),
      readSnapshot: options.readSnapshot ?? defaultReadSnapshot,
      readPlayback: options.readPlayback ?? defaultReadPlayback,
      loadBitmap: options.loadBitmap ?? defaultLoadBitmap,
      createBitmapFromVideo:
        options.createBitmapFromVideo ?? defaultCreateBitmapFromVideo,
      createBackendFn: options.createBackendFn ?? createBackend,
      createPool: options.createPool ?? ((o) => new VideoElementPool(o)),
      now:
        options.now ??
        (typeof performance !== "undefined"
          ? () => performance.now()
          : () => Date.now()),
      frameBudgetMs: options.frameBudgetMs ?? 14,
    };
  }

  /** Initialise backend + pool. Resolves once the runtime is ready to
   *  draw. After this returns the caller should call `attachVideoPool`
   *  to mount the `<video>` elements under a DOM parent, then `start()`
   *  to begin the RAF. */
  async init(): Promise<void> {
    const snapshot = this.opts.readSnapshot();
    const videoCams = collectVideoCams(snapshot.clips, this.opts.cams);
    this.pool = this.opts.createPool({
      cams: videoCams,
      onDimsReport: (id, w, h) => {
        useEditorStore.getState().setClipDisplayDims(id, w, h);
      },
    });
    // Seed the dirty-flag with the refs the pool was constructed
    // with so the first tick doesn't redundantly re-reconcile.
    this.lastReconciledClipsRef = snapshot.clips;
    this.lastReconciledCamsRef = this.opts.cams;
    // Kick off bitmap loads for any image clips already in the store.
    // The reconcile gate in tick() won't fire on the first tick (refs
    // match what we seeded above), so the eager start has to happen
    // here — otherwise an image present at editor open never loads.
    this.ensureAllImageBitmaps(snapshot.clips);
    const caps = this.computeCaps();
    this.backend = await this.opts.createBackendFn(this.opts.canvas, caps, this.opts.capabilities);
    await this.backend.warmup();
  }

  /** Mount the video pool's `<video>`s as children of `parent`. Safe
   *  to call multiple times — the pool itself is idempotent. */
  attachVideoPool(parent: HTMLElement): void {
    this.pool?.mount(parent);
  }

  /** Begin the RAF loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Pause the RAF loop. Backend + pool stay alive (decoders keep
   *  running so re-start is instant). */
  stop(): void {
    this.running = false;
    if (this.rafId != null) {
      this.opts.cancelRaf(this.rafId);
      this.rafId = null;
    }
  }

  /** Resize the canvas (CSS + backbuffer). The backbuffer is sized to
   *  cssW * dpr * scale to honour the resolution dial. */
  resize(cssW: number, cssH: number, dpr?: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    if (dpr != null) this.dpr = dpr;
    if (this.backend) {
      this.backend.resize(this.computeCaps());
    }
  }

  /** Replace the cam → URL map. Used by the Compositor's "+ Media" flow:
   *  when a video/image is added to the running editor, the new cam's
   *  asset URL must be plumbed into the runtime so its <video> element
   *  can be mounted (or its bitmap fetched) on the next tick. Without
   *  this, the descriptor builder sees the new clip in the store but
   *  the source map has no entry for it — the active layer renders
   *  nothing and the preview goes black. */
  setCams(cams: ClipUrlMap): void {
    this.opts = { ...this.opts, cams };
  }

  /** Resolution dial. 1.0 = native, 0.75 = 75 % linear scale (≈56 % of
   *  pixels). The CSS size of the canvas doesn't change — the browser
   *  upscales the backbuffer at composite time, which is essentially
   *  free on the GPU. */
  setScale(scale: number): void {
    this.scale = Math.max(0.1, Math.min(2, scale));
    // User override resets the auto-scaler so it doesn't immediately
    // fight back with a different value.
    this.adaptiveScaler.override(this.scale);
    if (this.backend) {
      this.backend.resize(this.computeCaps());
    }
  }

  /** Get the most recent auto-scaler decision — for the perf HUD or
   *  Settings telemetry. */
  getAdaptiveScale(): number {
    return this.adaptiveScaler.scale;
  }

  /** Hand-roll a single RAF tick. Useful for tests; production RAF
   *  loop calls this internally. */
  tick(): void {
    if (!this.backend || !this.pool) return;
    const tickStart = this.opts.now();
    const playback = this.opts.readPlayback();

    // Frame-budget watchdog: if the previous tick blew the budget, drop
    // this tick's draw. One-shot. Audio is on a separate thread so it
    // doesn't care about preview frame drops; the user's stated
    // priority (audio sacred, video can compensate) is exactly what
    // this implements. Pool sync still runs below (descriptor build is
    // cheap; the dropped work is the GPU draw).
    const skip = this.skipNextDraw;

    const snapshot = this.opts.readSnapshot();
    const descriptor = buildPreviewFrameDescriptor(
      snapshot,
      playback.currentTime,
      playback.timelineT,
    );

    // Pool sync: drive every cam from the descriptor's per-layer
    // `sourceTimeS` (the active pill's source-window applied at the
    // current `tTimeline`). Cams without a layer entry are paused — no
    // pill is on PROGRAM for them this tick. This is THE fix for the
    // "duplicate pill plays the wrong source frame" bug: the pool no
    // longer derives source-time from the cam-anchor (which can't tell
    // duplicate pills apart) but takes the pre-resolved value.
    const targets = collectPoolTargets(descriptor.layers);
    this.pool.syncAll(targets, playback.isPlaying);

    if (skip) {
      this.skipNextDraw = false;
      this.recordTickLatency(this.opts.now() - tickStart);
      return;
    }

    const sources = this.buildSourcesMap(
      descriptor.layers,
      snapshot.clips,
      targets,
    );

    // Close any pending fx-first-render perf mark on the first frame
    // we draw with active fx. Editor.tsx stashes the handle on
    // window.__fxFirstRenderPending when an F-hold begins; we pick it
    // up here with no compile-time coupling to the perf module.
    if (descriptor.fx.length > 0) {
      const w = window as unknown as {
        __fxFirstRenderPending?: { end: () => void };
      };
      if (w.__fxFirstRenderPending) {
        w.__fxFirstRenderPending.end();
        w.__fxFirstRenderPending = undefined;
      }
    }

    // Reconcile pool only when the inputs actually changed. Both refs
    // are stable across most ticks (clips changes on store mutations,
    // cams changes on `+Media` events), so reference equality is
    // enough — and avoids the per-frame VideoCam[] allocation that
    // collectVideoCams does inside.
    if (
      snapshot.clips !== this.lastReconciledClipsRef ||
      this.opts.cams !== this.lastReconciledCamsRef
    ) {
      this.pool.setCams(collectVideoCams(snapshot.clips, this.opts.cams));
      this.lastReconciledClipsRef = snapshot.clips;
      this.lastReconciledCamsRef = this.opts.cams;
      this.evictStaleFrames(snapshot.clips);
      // Image symmetric to the video pool: a newly-added image (live
      // "+ Media" flow) needs its bitmap fetched. We can't rely on
      // buildSourcesMap's lazy trigger because the image has no
      // displayW/H yet, so buildPreviewLayers drops it from
      // descriptor.layers and that loop never sees it.
      this.ensureAllImageBitmaps(snapshot.clips);
    }

    // Time the actual GPU/CPU work so the adaptive scaler sees real
    // backend latency. Excludes the bookkeeping above which is cheap.
    const t0 = this.opts.now();
    this.backend.drawFrame(descriptor, sources);
    const drawMs = this.opts.now() - t0;

    this.maybeRefreshSnapshots(descriptor.layers, targets);

    // Feed the adaptive scaler. Only react when the backend itself is
    // straining — visualizers/overlays/store reads are out of scope.
    this.adaptiveScaler.record(drawMs);
    const status = this.adaptiveScaler.consult();
    if (status.changed) {
      this.scale = status.scale;
      if (this.backend) this.backend.resize(this.computeCaps());
    }

    this.recordTickLatency(this.opts.now() - tickStart);
  }

  private recordTickLatency(tickMs: number): void {
    if (tickMs > this.opts.frameBudgetMs) {
      this.skipNextDraw = true;
    }
  }

  /** Stop the RAF, dispose backend + pool, revoke cached bitmaps. */
  dispose(): void {
    this.stop();
    if (this.pool) {
      this.pool.dispose();
      this.pool = null;
    }
    if (this.backend) {
      this.backend.dispose();
      this.backend = null;
    }
    for (const bm of this.bitmaps.values()) {
      try {
        bm.close();
      } catch {
        /* already closed */
      }
    }
    this.bitmaps.clear();
    this.bitmapsLoading.clear();
    for (const entry of this.lastGoodFrames.values()) {
      try {
        entry.bitmap.close();
      } catch {
        /* already closed */
      }
    }
    this.lastGoodFrames.clear();
    this.snapshotInFlight.clear();
  }

  // ---- internals ----

  private scheduleNext(): void {
    this.rafId = this.opts.raf(() => {
      this.rafId = null;
      if (!this.running) return;
      this.tick();
      this.scheduleNext();
    });
  }

  private computeCaps(): { pixelW: number; pixelH: number; cssW: number; cssH: number } {
    const pixelW = Math.max(1, Math.round(this.cssW * this.dpr * this.scale));
    const pixelH = Math.max(1, Math.round(this.cssH * this.dpr * this.scale));
    return { pixelW, pixelH, cssW: this.cssW, cssH: this.cssH };
  }

  private buildSourcesMap(
    layers: ReadonlyArray<{ layerId: string; source: { kind: string } }>,
    clips: readonly Clip[],
    targets: ReadonlyMap<string, PoolSyncTarget>,
  ): SourcesMap {
    const out = new Map<string, LayerSource>();
    for (const layer of layers) {
      if (layer.source.kind === "video") {
        const el = this.pool?.getElement(layer.layerId);
        if (!el) continue;
        // Last-good-frame fallback: only when (a) the cam is currently
        // in-range (out-of-range layers correctly stay black), (b) the
        // <video> can't deliver a fresh frame this tick (mid-seek or
        // pre-decode), and (c) we have a snapshot to substitute. Misses
        // any of these → standard video source.
        const target = targets.get(layer.layerId);
        const inRange =
          target != null
            ? (this.pool?.isSourceInRange(layer.layerId, target.sourceT) ?? true)
            : false;
        const ready =
          !el.seeking && el.readyState >= READY_HAVE_CURRENT_DATA;
        const cached = this.lastGoodFrames.get(layer.layerId);
        if (inRange && !ready && cached) {
          out.set(layer.layerId, {
            kind: "video",
            element: el,
            fallback: cached.bitmap,
            preferFallback: true,
          });
        } else {
          out.set(layer.layerId, { kind: "video", element: el });
        }
      } else if (layer.source.kind === "image") {
        const cached = this.bitmaps.get(layer.layerId);
        if (cached) {
          out.set(layer.layerId, { kind: "image", bitmap: cached });
        } else {
          this.ensureImageBitmap(layer.layerId, clips);
        }
      }
    }
    return out;
  }

  /** After a successful drawFrame, capture the live `<video>` of every
   *  active layer that's currently in-range and ready. Per-layer
   *  throttle keeps this cheap: most ticks hit the fast path
   *  (`now() - lastSnapshotMs < 100ms` → noop). The held bitmap is what
   *  `buildSourcesMap` substitutes during seeks/wraps. */
  private maybeRefreshSnapshots(
    layers: ReadonlyArray<{ layerId: string; source: { kind: string } }>,
    targets: ReadonlyMap<string, PoolSyncTarget>,
  ): void {
    if (!this.pool) return;
    let now: number | null = null;
    for (const layer of layers) {
      if (layer.source.kind !== "video") continue;
      if (this.snapshotInFlight.has(layer.layerId)) continue;
      const existing = this.lastGoodFrames.get(layer.layerId);
      if (now === null) now = this.opts.now();
      if (existing && now - existing.lastSnapshotMs < SNAPSHOT_THROTTLE_MS) {
        continue;
      }
      const el = this.pool.getElement(layer.layerId);
      if (!el) continue;
      if (el.seeking || el.readyState < READY_HAVE_CURRENT_DATA) continue;
      const target = targets.get(layer.layerId);
      if (!target || !this.pool.isSourceInRange(layer.layerId, target.sourceT)) {
        continue;
      }

      this.snapshotInFlight.add(layer.layerId);
      const layerId = layer.layerId;
      void this.opts
        .createBitmapFromVideo(el)
        .then((bm) => {
          this.snapshotInFlight.delete(layerId);
          // The cam may have been removed while we were awaiting — drop
          // the new bitmap rather than re-introducing it.
          if (!this.pool || !this.pool.getElement(layerId)) {
            try {
              bm.close();
            } catch {
              /* already closed */
            }
            return;
          }
          const prev = this.lastGoodFrames.get(layerId);
          if (prev) {
            try {
              prev.bitmap.close();
            } catch {
              /* already closed */
            }
          }
          this.lastGoodFrames.set(layerId, {
            bitmap: bm,
            lastSnapshotMs: this.opts.now(),
          });
        })
        .catch(() => {
          this.snapshotInFlight.delete(layerId);
        });
    }
  }

  /** Drop cached frames for cams that aren't in the current clip list
   *  anymore. Mirrors how `bitmaps` (image clips) decays — without
   *  this, removed cams' last-good-frames would leak ImageBitmaps. */
  private evictStaleFrames(clips: readonly Clip[]): void {
    if (this.lastGoodFrames.size === 0) return;
    const live = new Set<string>();
    for (const clip of clips) live.add(clip.id);
    for (const [id, entry] of this.lastGoodFrames) {
      if (live.has(id)) continue;
      try {
        entry.bitmap.close();
      } catch {
        /* already closed */
      }
      this.lastGoodFrames.delete(id);
    }
  }

  private ensureImageBitmap(clipId: string, clips: readonly Clip[]): void {
    if (this.bitmaps.has(clipId)) return;
    if (this.bitmapsLoading.has(clipId)) return;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip || !isImageClip(clip)) return;
    const url = this.opts.cams[clipId]?.videoUrl;
    if (!url) return;
    this.bitmapsLoading.add(clipId);
    void this.opts
      .loadBitmap(url)
      .then((bm) => {
        this.bitmapsLoading.delete(clipId);
        if (this.bitmaps.has(clipId)) {
          // Race: another load won. Drop the loser.
          bm.close();
          return;
        }
        this.bitmaps.set(clipId, bm);
        // Symmetric to VideoElementPool.onDimsReport for videos: tell
        // the store the image's natural dims so buildPreviewLayers
        // stops early-exiting on the missing displayW/H. Store setter
        // is a no-op when dims are unchanged, so this fires once per
        // image and doesn't churn the clips ref.
        useEditorStore.getState().setClipDisplayDims(clipId, bm.width, bm.height);
      })
      .catch((err) => {
        this.bitmapsLoading.delete(clipId);
        console.warn(`[compositor] image bitmap load failed for ${clipId}:`, err);
      });
  }

  private ensureAllImageBitmaps(clips: readonly Clip[]): void {
    for (const c of clips) {
      if (isImageClip(c)) this.ensureImageBitmap(c.id, clips);
    }
  }
}

// ---- helpers ----

/** Build per-cam pool sync targets from a freshly-built descriptor.
 *  Each video layer carries a pre-resolved `sourceTimeS` (the active
 *  pill's source-window applied at the current `tTimeline`); the pool
 *  uses that as `<video>.currentTime` instead of a cam-anchor scan. */
function collectPoolTargets(
  layers: ReadonlyArray<{
    layerId: string;
    source: { kind: string; sourceTimeS?: number };
  }>,
): Map<string, PoolSyncTarget> {
  const out = new Map<string, PoolSyncTarget>();
  for (const layer of layers) {
    if (layer.source.kind !== "video") continue;
    const t = layer.source.sourceTimeS;
    if (typeof t === "number" && Number.isFinite(t)) {
      out.set(layer.layerId, { sourceT: t });
    }
  }
  return out;
}

// ---- defaults ----

function defaultReadSnapshot(): EditorStoreSnapshot {
  const s = useEditorStore.getState();
  return {
    clips: s.clips,
    cuts: s.cuts,
    fx: s.fx,
    exportSpec: s.exportSpec,
    fxHolds: s.fxHolds,
    selectedFxKind: s.selectedFxKind,
    fxDefaults: s.fxDefaults,
    fxEnvelopes: s.fxEnvelopes,
    pills: s.pills,
    arrangementSegments: s.arrangementSegments,
  };
}

function defaultReadPlayback(): {
  currentTime: number;
  timelineT: number;
  isPlaying: boolean;
} {
  const s = useEditorStore.getState();
  return {
    currentTime: s.playback.currentTime,
    timelineT: s.playback.timelineT,
    isPlaying: s.playback.isPlaying,
  };
}

async function defaultLoadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

async function defaultCreateBitmapFromVideo(
  el: HTMLVideoElement,
): Promise<ImageBitmap> {
  return createImageBitmap(el);
}

function collectVideoCams(clips: readonly Clip[], cams: ClipUrlMap): VideoCam[] {
  const out: VideoCam[] = [];
  for (const clip of clips) {
    if (!isVideoClip(clip)) continue;
    const url = cams[clip.id]?.videoUrl;
    if (!url) continue;
    out.push({ clip, videoUrl: url });
  }
  return out;
}
