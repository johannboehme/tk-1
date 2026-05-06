import { describe, expect, it, vi } from "vitest";
import { PreviewRuntime } from "./preview-runtime";
import type { CompositorBackend, SourcesMap } from "./backend";
import type { FrameDescriptor } from "./frame-descriptor";
import {
  VideoElementPool,
  type VideoCam,
  type VideoElementPoolOptions,
} from "./video-element-pool";
import type { Clip, ImageClip, VideoClip } from "../types";
import type { EditorStoreSnapshot } from "./build-descriptor";
import { useEditorStore } from "../store";
import { generatePills } from "../arrangement-pills";

function videoClip(id: string, more: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: "video",
    id,
    filename: `${id}.mp4`,
    color: "#fff",
    sourceDurationS: 10,
    syncOffsetMs: 0,
    syncOverrideMs: 0,
    startOffsetS: 0,
    driftRatio: 1,
    candidates: [],
    selectedCandidateIdx: 0,
    displayW: 1920,
    displayH: 1080,
    ...more,
  };
}

function imageClip(id: string, more: Partial<ImageClip> = {}): ImageClip {
  return {
    kind: "image",
    id,
    filename: `${id}.png`,
    color: "#fff",
    durationS: 5,
    startOffsetS: 0,
    displayW: 800,
    displayH: 600,
    ...more,
  };
}

function snapshot(over: Partial<EditorStoreSnapshot> = {}): EditorStoreSnapshot {
  const clips = over.clips ?? [];
  // Mirror the post-loadJob invariant: every job carries a populated
  // pills + arrangementSegments shape (synthesized for single-take in
  // synthesizeJobLoadShape). Tests focused on cam/cut/rotation behavior
  // care about the active-cam answer, not the segment/pill plumbing —
  // synthesize defaults from clips so the descriptor builder finds an
  // active cam.
  const segments =
    clips.length > 0
      ? [
          {
            in: 0,
            out: Math.max(
              ...clips.map((c) =>
                c.kind === "image" ? c.durationS : c.sourceDurationS,
              ),
              60,
            ),
          },
        ]
      : [];
  const arrangement = [{ id: "__default__", chunkId: "__default_chunk__" }];
  const chunks = [
    {
      id: "__default_chunk__",
      startMs: 0,
      endMs: (segments[0]?.out ?? 0) * 1000,
      bpmOctaveShift: 0 as const,
      effectiveBpm: 0,
      beatsPerBar: 4,
      accepted: true,
      trimMode: "free" as const,
    },
  ];
  return {
    clips,
    cuts: [],
    fx: [],
    exportSpec: { preset: "web" },
    pills:
      clips.length > 0 ? generatePills(arrangement, chunks, clips) : [],
    arrangementSegments: segments,
    ...over,
  };
}

interface MockBackend extends CompositorBackend {
  drawFrame: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  warmup: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  /** Last descriptor the backend was asked to draw. */
  lastDescriptor: FrameDescriptor | null;
  /** Last sources map. */
  lastSources: SourcesMap | null;
}

function makeBackend(): MockBackend {
  const b: MockBackend = {
    id: "canvas2d",
    init: vi.fn(async () => undefined),
    resize: vi.fn(),
    warmup: vi.fn(async () => undefined),
    drawFrame: vi.fn((d: FrameDescriptor, s: SourcesMap) => {
      b.lastDescriptor = d;
      b.lastSources = s;
    }),
    dispose: vi.fn(),
    lastDescriptor: null,
    lastSources: null,
  };
  return b;
}

function makePool(): VideoElementPool {
  // Minimal stub — the pool tests cover the real logic; here we only
  // care that the runtime delegates correctly.
  const elements = new Map<string, HTMLVideoElement>();
  const inRange = new Map<string, boolean>();
  const pool = {
    syncAll: vi.fn(),
    getElement: vi.fn((id: string) => elements.get(id) ?? null),
    isSourceInRange: vi.fn((id: string) => inRange.get(id) ?? true),
    setCams: vi.fn(),
    mount: vi.fn(),
    unmount: vi.fn(),
    dispose: vi.fn(),
  } as unknown as VideoElementPool;
  // Attach a fake element for any id we want to "have" in the pool.
  (pool as unknown as {
    _add: (id: string, el?: HTMLVideoElement) => void;
    _setInRange: (id: string, v: boolean) => void;
  })._add = (id: string, el?: HTMLVideoElement) => {
    elements.set(id, el ?? document.createElement("video"));
  };
  (pool as unknown as { _setInRange: (id: string, v: boolean) => void })._setInRange =
    (id: string, v: boolean) => {
      inRange.set(id, v);
    };
  return pool;
}

/** Build a video element with controllable seeking/readyState — the
 *  runtime reads both to decide whether the source is "ready" or
 *  whether the last-good-frame fallback should kick in. */
function makeFakeVideoEl(over: { readyState?: number; seeking?: boolean } = {}): HTMLVideoElement {
  const el = document.createElement("video");
  Object.defineProperty(el, "readyState", {
    configurable: true,
    get: () => over.readyState ?? 4,
  });
  Object.defineProperty(el, "seeking", {
    configurable: true,
    get: () => over.seeking ?? false,
  });
  return el;
}

function makeRuntime(opts: {
  snap: EditorStoreSnapshot;
  playback?: { currentTime: number; timelineT?: number; isPlaying: boolean };
  cams?: Record<string, { videoUrl: string }>;
  backend?: MockBackend;
  pool?: VideoElementPool;
  loadBitmap?: (url: string) => Promise<ImageBitmap>;
  createBitmapFromVideo?: (el: HTMLVideoElement) => Promise<ImageBitmap>;
  now?: () => number;
}) {
  const backend = opts.backend ?? makeBackend();
  const pool = opts.pool ?? makePool();
  const canvas = document.createElement("canvas");
  const cams = opts.cams ?? {};
  const playbackIn = opts.playback ?? { currentTime: 0, isPlaying: false };
  const playback = {
    currentTime: playbackIn.currentTime,
    timelineT: playbackIn.timelineT ?? playbackIn.currentTime,
    isPlaying: playbackIn.isPlaying,
  };
  const rt = new PreviewRuntime({
    canvas,
    cams,
    capabilities: { webgl2: false, webgpu: false },
    cssW: 100,
    cssH: 50,
    dpr: 1,
    initialScale: 1,
    createBackendFn: vi.fn(async () => backend),
    createPool: () => pool,
    raf: vi.fn(() => 0),
    cancelRaf: vi.fn(),
    readSnapshot: () => opts.snap,
    readPlayback: () => playback,
    loadBitmap: opts.loadBitmap,
    createBitmapFromVideo: opts.createBitmapFromVideo,
    now: opts.now,
  });
  return { rt, backend, pool, canvas };
}

// ----------------------------------------------------------------------

describe("PreviewRuntime — init lifecycle", () => {
  it("init creates pool + backend and warms up", async () => {
    const backend = makeBackend();
    const { rt } = makeRuntime({ snap: snapshot(), backend });
    await rt.init();
    expect(backend.warmup).toHaveBeenCalled();
  });

  it("init forwards initial caps (cssW × dpr × scale) to the backend factory", async () => {
    const backend = makeBackend();
    const factoryFn = vi.fn(async () => backend);
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 200,
      cssH: 100,
      dpr: 2,
      initialScale: 0.5,
      createBackendFn: factoryFn,
      createPool: () => makePool(),
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snapshot(),
      readPlayback: () => ({ currentTime: 0, timelineT: 0, isPlaying: false }),
    });
    await rt.init();
    // pixel = cssW * dpr * scale = 200 * 2 * 0.5 = 200; cssH * 2 * 0.5 = 100
    expect(factoryFn).toHaveBeenCalledWith(
      canvas,
      expect.objectContaining({ pixelW: 200, pixelH: 100, cssW: 200, cssH: 100 }),
      expect.any(Object),
    );
  });
});

describe("PreviewRuntime — tick", () => {
  it("syncs the pool, builds descriptor, calls backend.drawFrame", async () => {
    const backend = makeBackend();
    const pool = makePool();
    (pool as unknown as { _add: (id: string) => void })._add("a");
    const clips: Clip[] = [videoClip("a")];
    const { rt } = makeRuntime({
      snap: snapshot({ clips }),
      playback: { currentTime: 1.5, isPlaying: true },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
    });
    await rt.init();
    rt.tick();
    // syncAll receives a Map<clipId, target> built from descriptor.layers'
    // pre-resolved sourceTimeS, plus the playback flag.
    const syncAll = (pool as unknown as { syncAll: ReturnType<typeof vi.fn> }).syncAll;
    expect(syncAll).toHaveBeenCalledTimes(1);
    const [targets, playing] = syncAll.mock.calls[0];
    expect(targets).toBeInstanceOf(Map);
    expect((targets as Map<string, { sourceT: number }>).get("a")?.sourceT).toBeCloseTo(1.5, 6);
    expect(playing).toBe(true);
    expect(backend.drawFrame).toHaveBeenCalled();
    expect(backend.lastDescriptor?.tMaster).toBe(1.5);
    expect(backend.lastDescriptor?.layers).toHaveLength(1);
  });

  it("populates the sources map with the pool's video element for the active cam", async () => {
    const backend = makeBackend();
    const pool = makePool();
    (pool as unknown as { _add: (id: string) => void })._add("a");
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [videoClip("a")] }),
      playback: { currentTime: 0.5, isPlaying: false },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
    });
    await rt.init();
    rt.tick();
    const src = backend.lastSources?.get("a");
    expect(src?.kind).toBe("video");
  });

  it("does not draw when init was not called", () => {
    const backend = makeBackend();
    const { rt } = makeRuntime({ snap: snapshot(), backend });
    rt.tick();
    expect(backend.drawFrame).not.toHaveBeenCalled();
  });
});

describe("PreviewRuntime — image bitmap cache", () => {
  it("triggers bitmap load on first tick that needs it", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    let loadResolve!: (bm: ImageBitmap) => void;
    const loadBitmap = vi.fn(
      () => new Promise<ImageBitmap>((res) => {
        loadResolve = res;
      }),
    );
    const backend = makeBackend();
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [imageClip("img1")] }),
      cams: { img1: { videoUrl: "img1.png" } },
      backend,
      loadBitmap,
    });
    await rt.init();
    rt.tick();
    expect(loadBitmap).toHaveBeenCalledWith("img1.png");
    // First tick: bitmap not ready yet → sources map omits the entry
    expect(backend.lastSources?.get("img1")).toBeUndefined();
    // Resolve the load and tick again
    loadResolve(fakeBitmap);
    await Promise.resolve();
    rt.tick();
    expect(backend.lastSources?.get("img1")).toEqual({ kind: "image", bitmap: fakeBitmap });
  });

  it("dedupes concurrent bitmap loads for the same clip", async () => {
    const loadBitmap = vi.fn(() => new Promise<ImageBitmap>(() => {}));
    const backend = makeBackend();
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [imageClip("img1")] }),
      cams: { img1: { videoUrl: "img1.png" } },
      backend,
      loadBitmap,
    });
    await rt.init();
    rt.tick();
    rt.tick();
    rt.tick();
    expect(loadBitmap).toHaveBeenCalledTimes(1);
  });
});

describe("PreviewRuntime — image clips without pre-set dims", () => {
  // Background: image clips arrive in the store without `displayW`/`displayH`
  // (the V1 `<img>`-overlay that previously reported `naturalWidth/Height`
  // is gone since the V1 preview path was dropped). `buildPreviewLayers`
  // early-exits when dims are missing, so the image never enters
  // `descriptor.layers`, so `buildSourcesMap`'s lazy `ensureImageBitmap`
  // is never called — chicken-and-egg lock that leaves the preview black.
  // The runtime must (a) trigger bitmap loads for image clips up front,
  // independent of the descriptor, and (b) report `bm.width`/`bm.height`
  // back to the store so the next frame can build the layer.

  function imageClipNoDims(id: string): ImageClip {
    // Helper builds an image clip with displayW/H deliberately unset —
    // this is the production state for a freshly-added image, before
    // anything has reported its natural dims.
    const c = imageClip(id);
    delete (c as { displayW?: number }).displayW;
    delete (c as { displayH?: number }).displayH;
    return c;
  }

  it("kicks off bitmap load even when image has no displayW/H (no chicken-and-egg)", async () => {
    const fakeBitmap = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    const loadBitmap = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [imageClipNoDims("img1")] }),
      cams: { img1: { videoUrl: "img1.png" } },
      backend,
      loadBitmap,
    });
    await rt.init();
    // First tick — even though the image is dropped from the descriptor
    // (no displayW/H → buildPreviewLayers early-exits), the load must
    // still start.
    rt.tick();
    expect(loadBitmap).toHaveBeenCalledWith("img1.png");
  });

  it("reports bm.width/height to the store via setClipDisplayDims after load", async () => {
    const fakeBitmap = { width: 1234, height: 567, close: vi.fn() } as unknown as ImageBitmap;
    const loadBitmap = vi.fn(async () => fakeBitmap);
    const setSpy = vi.fn();
    const getStateSpy = vi
      .spyOn(useEditorStore, "getState")
      .mockReturnValue({ setClipDisplayDims: setSpy } as unknown as ReturnType<
        typeof useEditorStore.getState
      >);
    try {
      const { rt } = makeRuntime({
        snap: snapshot({ clips: [imageClipNoDims("img1")] }),
        cams: { img1: { videoUrl: "img1.png" } },
        loadBitmap,
      });
      await rt.init();
      rt.tick();
      // Let the loadBitmap promise resolve and its .then run.
      await Promise.resolve();
      await Promise.resolve();
      expect(setSpy).toHaveBeenCalledWith("img1", 1234, 567);
    } finally {
      getStateSpy.mockRestore();
    }
  });

  it("does NOT report dims when bitmap load fails", async () => {
    const loadBitmap = vi.fn(async () => {
      throw new Error("nope");
    });
    const setSpy = vi.fn();
    const getStateSpy = vi
      .spyOn(useEditorStore, "getState")
      .mockReturnValue({ setClipDisplayDims: setSpy } as unknown as ReturnType<
        typeof useEditorStore.getState
      >);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { rt } = makeRuntime({
        snap: snapshot({ clips: [imageClipNoDims("img1")] }),
        cams: { img1: { videoUrl: "img1.png" } },
        loadBitmap,
      });
      await rt.init();
      rt.tick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(setSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      getStateSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("reports dims exactly once per image — no per-frame churn", async () => {
    const fakeBitmap = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    const loadBitmap = vi.fn(async () => fakeBitmap);
    const setSpy = vi.fn();
    const getStateSpy = vi
      .spyOn(useEditorStore, "getState")
      .mockReturnValue({ setClipDisplayDims: setSpy } as unknown as ReturnType<
        typeof useEditorStore.getState
      >);
    try {
      const { rt } = makeRuntime({
        snap: snapshot({ clips: [imageClipNoDims("img1")] }),
        cams: { img1: { videoUrl: "img1.png" } },
        loadBitmap,
      });
      await rt.init();
      // Run many ticks; the load resolves once, the dim-report fires once.
      for (let i = 0; i < 30; i++) {
        rt.tick();
        await Promise.resolve();
      }
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(loadBitmap).toHaveBeenCalledTimes(1);
    } finally {
      getStateSpy.mockRestore();
    }
  });

  it("kicks off bitmap load for an image added live via setCams (no init-time clip)", async () => {
    // Repro of the live + Media flow: editor opens with no clips, user
    // drops an image, addClip + setCams fire. The runtime must catch
    // the dim-less image on the reconcile path, not just at init().
    const fakeBitmap = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
    const loadBitmap = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const playback = { currentTime: 0, timelineT: 0, isPlaying: false };
    const snap: { value: EditorStoreSnapshot } = { value: snapshot({ clips: [] }) };
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      initialScale: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => pool,
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snap.value,
      readPlayback: () => playback,
      loadBitmap,
    });
    await rt.init();

    // Live add: new clip with NO displayW/H + cams URL update.
    snap.value = snapshot({ clips: [imageClipNoDims("img1")] });
    rt.setCams({ img1: { videoUrl: "img1.png" } });
    rt.tick();
    expect(loadBitmap).toHaveBeenCalledWith("img1.png");
  });
});

describe("PreviewRuntime — last-good-frame cache (hides black flash on seek/wrap)", () => {
  // Background: when the user scrubs the playhead OR a loop wraps to
  // its start, the pool re-sets `<video>.currentTime`. The browser's
  // decoder needs 1–3 frames before a real frame is available; in the
  // meantime drawImage(<video>) can produce empty/transparent pixels,
  // and the backend's unconditional black background-clear shows
  // through as a black flash. The runtime holds the last successful
  // <video> frame as an ImageBitmap per layerId and hands it to the
  // backend as a fallback while seeking.

  it("uses cached fallback when video is seeking and in-range", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createBitmapFromVideo = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const readyEl = makeFakeVideoEl({ readyState: 4, seeking: false });
    (pool as unknown as { _add: (id: string, el?: HTMLVideoElement) => void })._add(
      "a",
      readyEl,
    );
    let nowMs = 0;
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [videoClip("a")] }),
      playback: { currentTime: 0.5, isPlaying: false },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
      createBitmapFromVideo,
      now: () => nowMs,
    });
    await rt.init();
    // Tick 1: video ready → snapshot scheduled. Throttle is per-layer
    // wall-clock, so even with the deterministic now() the scheduling
    // path runs.
    rt.tick();
    // Let the snapshot promise resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(createBitmapFromVideo).toHaveBeenCalledTimes(1);

    // Now the video is "seeking" — flip the descriptor to mid-seek.
    Object.defineProperty(readyEl, "seeking", {
      configurable: true,
      get: () => true,
    });
    nowMs = 50; // < throttle window
    rt.tick();

    const src = backend.lastSources?.get("a");
    expect(src?.kind).toBe("video");
    expect((src as { fallback?: ImageBitmap }).fallback).toBe(fakeBitmap);
    expect((src as { preferFallback?: boolean }).preferFallback).toBe(true);
  });

  it("does NOT use fallback when layer is out of range (black is correct)", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createBitmapFromVideo = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const readyEl = makeFakeVideoEl({ readyState: 4, seeking: false });
    (pool as unknown as { _add: (id: string, el?: HTMLVideoElement) => void })._add(
      "a",
      readyEl,
    );
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [videoClip("a")] }),
      playback: { currentTime: 0.5, isPlaying: false },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
      createBitmapFromVideo,
    });
    await rt.init();
    // Populate cache: tick 1, video ready.
    rt.tick();
    await Promise.resolve();
    await Promise.resolve();

    // Now the layer is out of range — even if seeking, fallback must
    // NOT be used. Black is correct in a between-clips gap.
    Object.defineProperty(readyEl, "seeking", {
      configurable: true,
      get: () => true,
    });
    (pool as unknown as { _setInRange: (id: string, v: boolean) => void })._setInRange(
      "a",
      false,
    );
    rt.tick();
    const src = backend.lastSources?.get("a");
    // Either no entry at all (descriptor builder may drop the layer)
    // or a video source without preferFallback. The contract is just:
    // do not paint the cached image.
    if (src && src.kind === "video") {
      expect((src as { preferFallback?: boolean }).preferFallback).not.toBe(true);
    }
  });

  it("does NOT use fallback when video is ready (real frame wins)", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createBitmapFromVideo = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const readyEl = makeFakeVideoEl({ readyState: 4, seeking: false });
    (pool as unknown as { _add: (id: string, el?: HTMLVideoElement) => void })._add(
      "a",
      readyEl,
    );
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [videoClip("a")] }),
      playback: { currentTime: 0.5, isPlaying: false },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
      createBitmapFromVideo,
    });
    await rt.init();
    rt.tick();
    await Promise.resolve();
    await Promise.resolve();
    rt.tick();
    const src = backend.lastSources?.get("a");
    expect(src?.kind).toBe("video");
    expect((src as { preferFallback?: boolean }).preferFallback).not.toBe(true);
  });

  it("evicts cached bitmap on cam removal (no leak)", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createBitmapFromVideo = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const readyEl = makeFakeVideoEl({ readyState: 4, seeking: false });
    (pool as unknown as { _add: (id: string, el?: HTMLVideoElement) => void })._add(
      "a",
      readyEl,
    );
    const snap: { value: EditorStoreSnapshot } = {
      value: snapshot({ clips: [videoClip("a")] }),
    };
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: { a: { videoUrl: "a.mp4" } },
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      initialScale: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => pool,
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snap.value,
      readPlayback: () => ({ currentTime: 0.5, timelineT: 0.5, isPlaying: false }),
      createBitmapFromVideo,
    });
    await rt.init();
    rt.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(createBitmapFromVideo).toHaveBeenCalledTimes(1);

    // Remove the cam from store + cams map.
    snap.value = snapshot({ clips: [] });
    rt.setCams({});
    rt.tick();

    expect(fakeBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("throttles snapshot creation per layer (~100ms)", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createBitmapFromVideo = vi.fn(async () => ({
      close: vi.fn(),
    }) as unknown as ImageBitmap);
    void fakeBitmap;
    const backend = makeBackend();
    const pool = makePool();
    const readyEl = makeFakeVideoEl({ readyState: 4, seeking: false });
    (pool as unknown as { _add: (id: string, el?: HTMLVideoElement) => void })._add(
      "a",
      readyEl,
    );
    let nowMs = 0;
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [videoClip("a")] }),
      playback: { currentTime: 0.5, isPlaying: false },
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
      createBitmapFromVideo,
      now: () => nowMs,
    });
    await rt.init();

    // Many fast ticks within the throttle window.
    for (let i = 0; i < 6; i++) {
      nowMs = i * 16; // ~60Hz
      rt.tick();
      await Promise.resolve();
    }
    expect(createBitmapFromVideo).toHaveBeenCalledTimes(1);

    // Step past the throttle window.
    nowMs = 200;
    rt.tick();
    await Promise.resolve();
    expect(createBitmapFromVideo).toHaveBeenCalledTimes(2);
  });
});

describe("PreviewRuntime — setCams (live + Media flow)", () => {
  it("forwards a newly-added cam URL to the pool on the next tick", async () => {
    // Repro for the bug where adding a video to an already-running editor
    // wouldn't actually mount its <video> element: the pool's setCams was
    // called with the STALE cams map captured at construction time.
    const backend = makeBackend();
    const pool = makePool();
    const setCamsSpy = (pool as unknown as { setCams: ReturnType<typeof vi.fn> })
      .setCams;
    (pool as unknown as { _add: (id: string) => void })._add("a");
    const clipsBefore: Clip[] = [videoClip("a")];
    const playback = { currentTime: 0, timelineT: 0, isPlaying: false };
    const snap: { value: EditorStoreSnapshot } = { value: snapshot({ clips: clipsBefore }) };
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: { a: { videoUrl: "a.mp4" } },
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      initialScale: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => pool,
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snap.value,
      readPlayback: () => playback,
    });
    await rt.init();

    // Simulate the editor's "+ Media" flow: a 2nd cam gets appended to
    // the store AND its URL is registered in the runtime's cams map.
    snap.value = snapshot({ clips: [videoClip("a"), videoClip("b")] });
    rt.setCams({ a: { videoUrl: "a.mp4" }, b: { videoUrl: "b.mp4" } });
    setCamsSpy.mockClear();
    rt.tick();

    // Pool should be reconciled with BOTH cams now.
    expect(setCamsSpy).toHaveBeenCalledTimes(1);
    const arg = setCamsSpy.mock.calls[0][0] as VideoCam[];
    const ids = arg.map((c) => c.clip.id).sort();
    expect(ids).toEqual(["a", "b"]);
    const newCam = arg.find((c) => c.clip.id === "b");
    expect(newCam?.videoUrl).toBe("b.mp4");
  });

  it("uses the updated cams map when loading bitmaps for newly-added image clips", async () => {
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const loadBitmap = vi.fn(async () => fakeBitmap);
    const backend = makeBackend();
    const pool = makePool();
    const playback = { currentTime: 0, timelineT: 0, isPlaying: false };
    const snap: { value: EditorStoreSnapshot } = { value: snapshot({ clips: [] }) };
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      initialScale: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => pool,
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snap.value,
      readPlayback: () => playback,
      loadBitmap,
    });
    await rt.init();

    snap.value = snapshot({ clips: [imageClip("img1")] });
    rt.setCams({ img1: { videoUrl: "img1.png" } });
    rt.tick();

    expect(loadBitmap).toHaveBeenCalledWith("img1.png");
  });
});

describe("PreviewRuntime — resize + scale dial", () => {
  it("resize() forwards new pixel dims to the backend", async () => {
    const backend = makeBackend();
    const { rt } = makeRuntime({ snap: snapshot(), backend });
    await rt.init();
    backend.resize.mockClear();
    rt.resize(400, 200, 2);
    expect(backend.resize).toHaveBeenCalledWith(
      expect.objectContaining({ pixelW: 800, pixelH: 400, cssW: 400, cssH: 200 }),
    );
  });

  it("setScale clamps to [0.1, 2] and resizes the backbuffer", async () => {
    const backend = makeBackend();
    const { rt } = makeRuntime({ snap: snapshot(), backend });
    await rt.init();
    backend.resize.mockClear();
    rt.setScale(0.75);
    expect(backend.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ pixelW: 75, pixelH: 38 }),
    );
    rt.setScale(10); // clamps to 2
    expect(backend.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ pixelW: 200, pixelH: 100 }),
    );
    rt.setScale(0.001); // clamps to 0.1
    expect(backend.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ pixelW: 10, pixelH: 5 }),
    );
  });
});

describe("PreviewRuntime — start/stop loop", () => {
  it("start() schedules a RAF; stop() cancels it", async () => {
    const raf = vi.fn(() => 42);
    const cancelRaf = vi.fn();
    const canvas = document.createElement("canvas");
    const backend = makeBackend();
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => makePool(),
      raf,
      cancelRaf,
      readSnapshot: () => snapshot(),
      readPlayback: () => ({ currentTime: 0, timelineT: 0, isPlaying: false }),
    });
    await rt.init();
    rt.start();
    expect(raf).toHaveBeenCalledTimes(1);
    rt.stop();
    expect(cancelRaf).toHaveBeenCalledWith(42);
  });

  it("start() is idempotent — second call doesn't schedule another RAF", async () => {
    const raf = vi.fn(() => 1);
    const canvas = document.createElement("canvas");
    const backend = makeBackend();
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => makePool(),
      raf,
      cancelRaf: () => undefined,
      readSnapshot: () => snapshot(),
      readPlayback: () => ({ currentTime: 0, timelineT: 0, isPlaying: false }),
    });
    await rt.init();
    rt.start();
    rt.start();
    expect(raf).toHaveBeenCalledTimes(1);
  });
});

describe("PreviewRuntime — dispose", () => {
  it("disposes backend, pool, and closes cached bitmaps", async () => {
    const backend = makeBackend();
    const pool = makePool();
    const fakeBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const { rt } = makeRuntime({
      snap: snapshot({ clips: [imageClip("img1")] }),
      cams: { img1: { videoUrl: "img1.png" } },
      backend,
      pool,
      loadBitmap: () => Promise.resolve(fakeBitmap),
    });
    await rt.init();
    rt.tick();
    await Promise.resolve(); // let load resolve
    rt.tick(); // populate cache
    rt.dispose();
    expect(backend.dispose).toHaveBeenCalled();
    expect((pool as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(fakeBitmap.close).toHaveBeenCalled();
  });
});

describe("PreviewRuntime — pool reconciliation dirty-flag", () => {
  // pool.setCams reconciles slots (Set membership + per-slot updates).
  // It allocates a new VideoCam[] every call. On a quiet timeline that
  // never changes, calling it 60×/sec is pure GC churn. The runtime
  // should only re-reconcile when the clips list reference OR the cams
  // URL map reference actually changes.

  it("does NOT call pool.setCams when neither clips nor cams map changed", async () => {
    const backend = makeBackend();
    const pool = makePool();
    const setCamsSpy = (pool as unknown as { setCams: ReturnType<typeof vi.fn> })
      .setCams;
    const clips: Clip[] = [videoClip("a")];
    const snap: { value: EditorStoreSnapshot } = { value: snapshot({ clips }) };
    const { rt } = makeRuntime({
      snap: snap.value,
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
    });
    // Force the test runtime to read the same snapshot ref each tick
    // (the makeRuntime helper captures opts.snap at construction).
    rt["opts"].readSnapshot = () => snap.value;
    await rt.init();
    setCamsSpy.mockClear();
    rt.tick();
    rt.tick();
    rt.tick();
    expect(setCamsSpy).not.toHaveBeenCalled();
  });

  it("calls pool.setCams once when the clips list reference changes", async () => {
    const backend = makeBackend();
    const pool = makePool();
    const setCamsSpy = (pool as unknown as { setCams: ReturnType<typeof vi.fn> })
      .setCams;
    const snap: { value: EditorStoreSnapshot } = {
      value: snapshot({ clips: [videoClip("a")] }),
    };
    const { rt } = makeRuntime({
      snap: snap.value,
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
    });
    rt["opts"].readSnapshot = () => snap.value;
    await rt.init();
    setCamsSpy.mockClear();
    rt.tick();
    // New clips array reference (e.g. user added a clip).
    snap.value = snapshot({ clips: [videoClip("a"), videoClip("b")] });
    rt.tick();
    rt.tick(); // unchanged after the propagation tick
    expect(setCamsSpy).toHaveBeenCalledTimes(1);
  });

  it("calls pool.setCams once when the cams URL map reference changes", async () => {
    const backend = makeBackend();
    const pool = makePool();
    const setCamsSpy = (pool as unknown as { setCams: ReturnType<typeof vi.fn> })
      .setCams;
    const snap: { value: EditorStoreSnapshot } = {
      value: snapshot({ clips: [videoClip("a")] }),
    };
    const { rt } = makeRuntime({
      snap: snap.value,
      cams: { a: { videoUrl: "a.mp4" } },
      backend,
      pool,
    });
    rt["opts"].readSnapshot = () => snap.value;
    await rt.init();
    setCamsSpy.mockClear();
    rt.tick();
    rt.setCams({ a: { videoUrl: "a.mp4" }, b: { videoUrl: "b.mp4" } });
    rt.tick();
    rt.tick();
    expect(setCamsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("PreviewRuntime — frame-budget watchdog", () => {
  /** Helper: build a runtime with an injected clock so we can simulate
   *  ticks of arbitrary duration. */
  function makeWithClock(opts: {
    backend?: MockBackend;
    pool?: VideoElementPool;
    frameBudgetMs?: number;
    /** Sequence of (tick-start, intermediate, tick-end) timestamps the
     *  injected `now()` returns in order. */
    nowSequence?: number[];
  }) {
    const backend = opts.backend ?? makeBackend();
    const pool = opts.pool ?? makePool();
    let nowIdx = 0;
    const nowSeq = opts.nowSequence ?? [];
    const canvas = document.createElement("canvas");
    const rt = new PreviewRuntime({
      canvas,
      cams: {},
      capabilities: { webgl2: false, webgpu: false },
      cssW: 100,
      cssH: 50,
      dpr: 1,
      initialScale: 1,
      frameBudgetMs: opts.frameBudgetMs ?? 14,
      createBackendFn: vi.fn(async () => backend),
      createPool: () => pool,
      raf: () => 0,
      cancelRaf: () => undefined,
      readSnapshot: () => snapshot(),
      readPlayback: () => ({ currentTime: 0, timelineT: 0, isPlaying: false }),
      now: () => {
        const v = nowSeq[Math.min(nowIdx, nowSeq.length - 1)] ?? 0;
        nowIdx++;
        return v;
      },
    });
    return { rt, backend, pool, advanceTick: () => rt.tick() };
  }

  it("draws normally when ticks stay under the budget", async () => {
    // Each tick reads now() at: tickStart, drawStart, drawEnd, tickEnd.
    // 4 reads/tick → 8 entries for 2 ticks. Both ticks: 5 ms total.
    const seq = [0, 1, 4, 5, 100, 101, 104, 105];
    const { rt, backend } = makeWithClock({ nowSequence: seq, frameBudgetMs: 14 });
    await rt.init();
    rt.tick();
    rt.tick();
    expect(backend.drawFrame).toHaveBeenCalledTimes(2);
  });

  it("skips the next draw after a tick that exceeded the budget", async () => {
    // Tick 1: 30ms total → blows 14ms budget → arms the skip
    // Tick 2: must skip drawFrame
    // Tick 3: short again → resumes drawing
    // 4 now()-reads per non-skipped tick (start, drawStart, drawEnd, tickEnd)
    // 2 now()-reads per skipped tick (start, tickEnd).
    const seq = [
      0, 1, 30, 31, // tick 1: 31ms
      100, 102, // tick 2: skipped — no drawFrame timestamps
      200, 201, 204, 205, // tick 3: 5ms
    ];
    const { rt, backend } = makeWithClock({ nowSequence: seq, frameBudgetMs: 14 });
    await rt.init();
    rt.tick(); // overshoots — schedules skip
    expect(backend.drawFrame).toHaveBeenCalledTimes(1);
    rt.tick(); // skip
    expect(backend.drawFrame).toHaveBeenCalledTimes(1);
    rt.tick(); // back to drawing
    expect(backend.drawFrame).toHaveBeenCalledTimes(2);
  });

  it("still syncs the video pool on a skipped tick (cam decoders stay aligned)", async () => {
    const seq = [
      0, 1, 30, 31, // tick 1
      100, 102, // tick 2 (skipped)
    ];
    const pool = makePool();
    const { rt } = makeWithClock({ nowSequence: seq, pool, frameBudgetMs: 14 });
    await rt.init();
    rt.tick(); // overshoots
    rt.tick(); // skipped
    const syncSpy = (pool as unknown as { syncAll: ReturnType<typeof vi.fn> }).syncAll;
    // pool.syncAll fired on both ticks (init does not call it).
    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  it("disabling the watchdog (frameBudgetMs=Infinity) never skips", async () => {
    const seq = [
      0, 1, 100, 101, // 101ms — would normally trigger skip
      200, 201, 300, 301,
    ];
    const { rt, backend } = makeWithClock({
      nowSequence: seq,
      frameBudgetMs: Infinity,
    });
    await rt.init();
    rt.tick();
    rt.tick();
    expect(backend.drawFrame).toHaveBeenCalledTimes(2);
  });
});

// silence the "unused variable" lint for the imported VideoCam helper.
void ((): VideoCam | null => null);
void ((_: VideoElementPoolOptions) => null);
