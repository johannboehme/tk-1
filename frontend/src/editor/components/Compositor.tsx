/**
 * Live preview compositor.
 *
 * Layout (back → front):
 *   1. <MasterAudio> outside the OutputFrameBox — invisible, drives the
 *      master clock. Cams are passive slaves of the store's currentTime.
 *   2. Hidden `<video>` pool (display:none) — owned by `PreviewRuntime`
 *      via `VideoElementPool`. Each cam's <video> stays mounted so its
 *      decoder stays warm; the runtime samples whichever cam is active
 *      as a GPU texture per RAF.
 *   3. <OutputFrameBox> wrapper that letterbox/pillarboxes a single
 *      `<canvas>` to the resolved output AR.
 *   4. <TestPattern> shown when no cam has material at currentTime
 *      (CSS DOM overlay — the backend stays out of the test-pattern
 *      business).
 */
import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store";
import { getCapabilities } from "../../local/capabilities";
import { MasterAudio } from "./MasterAudio";
import { TestPattern } from "./TestPattern";
import { OutputFrameBox } from "./OutputFrameBox";
import { StageInteractionOverlay } from "./StageInteractionOverlay";
import { PreviewRuntime, type ClipUrlMap } from "../render/preview-runtime";
import { COMPOSITOR_INITIAL_SCALE } from "../render/feature-flag";

interface Props {
  cams: ClipUrlMap;
  audioUrl: string;
}

export function Compositor({ cams, audioUrl }: Props) {
  // Single selector so we re-render only when the *active cam id* flips
  // — not on every 60 Hz currentTime tick. Zustand's default Object.is
  // comparison on the returned string short-circuits between flips.
  // (The previous two-selector form re-rendered the whole compositor
  // every frame just to feed currentTime into activeCamId.)
  const activeCamId = useEditorStore((s) => s.activeCamId(s.playback.currentTime));
  const showTestPattern = activeCamId === null;

  return (
    <div className="relative w-full h-full bg-sunken overflow-hidden">
      <MasterAudio audioUrl={audioUrl} />

      {showTestPattern && (
        <div className="absolute inset-0">
          <TestPattern />
        </div>
      )}

      <OutputFrameBox>
        <CompositorCanvas cams={cams} />
        <StageInteractionOverlay />
      </OutputFrameBox>
    </div>
  );
}

/** The canvas + runtime mount. Lives inside OutputFrameBox so its CSS
 *  size already equals the letterbox/pillarbox-fitted output box. */
function CompositorCanvas({ cams }: { cams: ClipUrlMap }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const poolHostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<PreviewRuntime | null>(null);
  // Track the latest cams prop so the post-init handoff and the cams
  // effect can both read it. Without the ref, a cam added BETWEEN
  // construction and init().then would be lost: the runtime starts with
  // the constructor-captured map and the cams effect runs before
  // runtimeRef is set, so its setCams call no-ops.
  const camsRef = useRef<ClipUrlMap>(cams);
  camsRef.current = cams;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const poolHost = poolHostRef.current;
    if (!canvas || !poolHost) return;

    // EditorShell renders `videoArea` in TWO sibling layouts (one
    // desktop, one tablet/mobile) that toggle via Tailwind responsive
    // classes — only one is visible at a time. React still mounts both
    // component instances. We don't want a hidden Compositor running
    // its own RAF + decoders + GL context, so skip init unless this
    // particular mount is actually visible. `offsetParent === null`
    // when any ancestor has `display: none` (per HTML spec).
    if (canvas.offsetParent === null) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));

    const runtime = new PreviewRuntime({
      canvas,
      cams,
      capabilities: getCapabilities(),
      cssW,
      cssH,
      dpr,
      initialScale: COMPOSITOR_INITIAL_SCALE,
    });

    let cancelled = false;
    void runtime
      .init()
      .then(() => {
        if (cancelled) {
          runtime.dispose();
          return;
        }
        runtime.attachVideoPool(poolHost);
        // Re-read canvas size now that init() has finished — between
        // the constructor and here the layout settled (the canvas's
        // initial getBoundingClientRect is often 0×0 because React's
        // useEffect runs before the first paint sizes the box). The
        // ResizeObserver in the next useEffect catches subsequent
        // changes; this catches the initial settle.
        const r = canvas.getBoundingClientRect();
        runtime.resize(
          Math.max(1, Math.round(r.width)),
          Math.max(1, Math.round(r.height)),
          window.devicePixelRatio || 1,
        );
        // Apply any cams that arrived during init() — see camsRef.
        runtime.setCams(camsRef.current);
        runtime.start();
        runtimeRef.current = runtime;
        // Expose for `setScale(0.75)` from the devtools console.
        (window as unknown as { __vasCompositor?: PreviewRuntime }).__vasCompositor = runtime;
      })
      .catch((err) => {
        console.error("[compositor] init failed:", err);
        setError(String(err));
      });

    return () => {
      cancelled = true;
      const w = window as unknown as { __vasCompositor?: PreviewRuntime };
      if (w.__vasCompositor === runtime) delete w.__vasCompositor;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      runtime.dispose();
    };
    // We deliberately do NOT depend on `cams` here — the runtime
    // reconciles its pool on every tick via `setCams(...)`, so adding
    // / removing a cam doesn't tear down the backend / decoder pool.
    // The separate effect below pushes prop changes into the runtime so
    // newly-added cams' URLs reach the pool / bitmap loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push cams-prop changes into the running runtime without tearing it
  // down. Without this the runtime keeps the cams map captured at mount,
  // and a newly-added video/image has no URL to mount its <video> with —
  // the active layer renders nothing and the preview goes black.
  useEffect(() => {
    runtimeRef.current?.setCams(cams);
  }, [cams]);

  // Track the canvas's container size and forward to the runtime.
  // The runtime might not exist yet on the first observation (init() is
  // async); the .then() callback in the mount effect calls resize once
  // explicitly to catch up. Subsequent grow events come through here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pending = null;
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));
      runtimeRef.current?.resize(cssW, cssH, window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(() => {
      // Coalesce — observer can fire multiple times in one frame.
      if (pending != null) return;
      pending = setTimeout(flush, 0);
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      if (pending != null) clearTimeout(pending);
    };
  }, []);

  // Page Visibility — pause the RAF when the tab is hidden so we don't
  // burn cycles in a background tab.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        runtimeRef.current?.stop();
      } else {
        runtimeRef.current?.start();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return (
    <>
      {/* Off-screen `<video>` pool. display:none on each element keeps
          the layout free of these and gives the decoder a stable home. */}
      <div ref={poolHostRef} aria-hidden style={{ display: "none" }} />
      <canvas
        ref={canvasRef}
        data-vas-compositor
        className="absolute inset-0 w-full h-full"
        style={{ background: "#1A1816" }}
      />
      {error && (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center text-[#ff8080] text-xs"
        >
          Compositor failed: {error}
        </div>
      )}
    </>
  );
}
