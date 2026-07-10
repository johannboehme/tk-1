/**
 * TriageTimeline — the main visual surface of the Triage workflow.
 *
 * Stacked layers (all share the same time-window mapping):
 *   1. Time ruler (~22 px) — MM:SS marks, agnostic to musical timing
 *   2. Bar ruler (~22 px) — per-chunk beat/bar ticks, anchored at each
 *      chunk's `audioStartMs` and stepping at that chunk's effective
 *      tempo. Chunks are not aligned to each other.
 *   3. Waveform (Canvas2D) — RMS envelope as vertical bars
 *   4. Chunk lane (~32 px) — solid-color bars per chunk
 *
 * Trim drag uses the editor's `snapTime` helper with the active
 * `snapMode` from the store, anchored at the chunk's own `audioStartMs`.
 *
 * Plus a playhead overlay and zoom/pan affordances.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  chunkBeatPhaseS,
  chunkPassesFilter,
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";
import { snapTime } from "../../editor/snap";
import type { Chunk } from "../../storage/jobs-db";
import { autoFollowScrollX } from "./triage-auto-follow";
import {
  buildPyramidFromEnvelope,
  type PeakPyramid,
} from "../../local/waveform/peak-pyramid";
import { buildPeakPyramidAsync } from "../../local/waveform/build-pyramid-async";
import { drawWaveform, TRIAGE_STYLE } from "../../local/waveform/draw-waveform";
import {
  getCachedPyramid,
  savePyramid,
} from "../../local/waveform/pyramid-cache";
import { formatTime } from "../../lib/time-format";
import type { RulerTick as GridTick } from "../../editor/components/timeline/beat-ruler-ticks";
import {
  buildTimeRulerTicks,
  type TimeRulerTick,
} from "../../editor/components/timeline/time-ruler-ticks";
import { buildChunkGridTicks } from "./chunk-ruler-ticks";

// Visual hierarchy (top to bottom):
//   Time ruler — secondary, MM:SS for absolute reference, faint
//   Bar ruler  — PRIMARY navigation surface, bar numbers + downbeats
//   Waveform   — RMS envelope
//   Chunk lane — chunk blocks
const TIME_RULER_HEIGHT = 16;
const BAR_RULER_HEIGHT = 30;
const CHUNK_LANE_HEIGHT = 32;
const MAX_WAVEFORM_HEIGHT = 110;
const PLAYHEAD_COLOR = "#FF5722";
const HOT_COLOR = "#FF5722";
/** Visible width of a trim handle. Hit area is bigger via padding so
 *  the handle stays grabbable even at this thin spec — see ChunkBlock. */
const TRIM_HANDLE_PX = 2;
/** A chunk can't realistically be narrower than this on screen — at
 *  sub-3 px the rect rounds to a single line and disappears into the
 *  baseline. We render those as a tight pill at their anchor so the
 *  user keeps a click target without distorting the proportional
 *  weight of nearby chunks. */
const MIN_VISIBLE_CHUNK_PX = 3;
/** Below this, trim handles aren't shown — there's no room to grab
 *  them anyway, the user is expected to zoom in for surgical edits. */
const HANDLES_MIN_PX = 12;

export function TriageTimeline() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 320 });

  const audioDuration = useTriageStore((s) => s.audioDuration);
  const envelope = useTriageStore((s) => s.envelope);
  const envelopeHz = useTriageStore((s) => s.envelopeHz);
  const pcm = useTriageStore((s) => s.pcm);
  const pcmSampleRate = useTriageStore((s) => s.pcmSampleRate);
  const jobId = useTriageStore((s) => s.jobId);
  const chunks = useTriageStore((s) => s.chunks);
  const jobBpm = useTriageStore((s) => s.jobBpm);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const minChunkBars = useTriageStore((s) => s.minChunkBars);
  const snapMode = useTriageStore((s) => s.snapMode);
  const silenceConfig = useTriageStore((s) => s.silenceConfig);
  const focusedChunkId = useTriageStore((s) => s.focusedChunkId);
  const view = useTriageStore((s) => s.view);
  const setZoom = useTriageStore((s) => s.setZoom);
  const setScrollX = useTriageStore((s) => s.setScrollX);
  const focusChunk = useTriageStore((s) => s.focusChunk);
  const seek = useTriageStore((s) => s.seek);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  // NOTE: deliberately NOT subscribed to playback.currentTime — during
  // playback that field updates at ~60 Hz, and re-rendering the whole
  // timeline subtree (per-chunk framer-motion blocks, ruler tick maps)
  // per tick made triage playback sluggish on long-form jams. The
  // playhead lives in its own tiny child (TimelinePlayhead below) that
  // alone subscribes to the ticking value.
  const playbackMode = useTriageStore((s) => s.playback.mode);
  const sliceReveal = useTriageStore((s) => s.sliceReveal);
  const clearSliceReveal = useTriageStore((s) => s.clearSliceReveal);
  const reducedMotion = useReducedMotion();

  // Map each freshly-sliced piece to its left-to-right index so the
  // "downbeat guillotine" reveal staggers across the new pieces. Keyed
  // on the chunk list so it follows the pieces once they're in state.
  const revealOrder = useMemo(() => {
    if (!sliceReveal) return null;
    const ids = new Set(sliceReveal.pieceIds);
    const sorted = chunks
      .filter((c) => ids.has(c.id))
      .sort((a, b) => a.startMs - b.startMs);
    const index = new Map<string, number>();
    sorted.forEach((c, i) => index.set(c.id, i));
    return { index, gen: sliceReveal.gen };
  }, [sliceReveal, chunks]);

  // Tear the reveal marker down once the animation has played so it
  // doesn't re-fire on unrelated re-renders. Reduced-motion clears
  // immediately (the pieces are already in their final state).
  useEffect(() => {
    if (!sliceReveal) return;
    const ms = reducedMotion
      ? 0
      : Math.min(1200, 500 + sliceReveal.cutTimesS.length * 60);
    const t = window.setTimeout(() => clearSliceReveal(), ms);
    return () => window.clearTimeout(t);
  }, [sliceReveal, reducedMotion, clearSliceReveal]);

  // Track wrapper width AND height so the waveform breathes vertically
  // when the user gives the timeline column more room.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: Math.max(200, entry.contentRect.width),
          height: Math.max(180, entry.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const waveformHeight = Math.min(
    MAX_WAVEFORM_HEIGHT,
    Math.max(
      60,
      size.height - TIME_RULER_HEIGHT - BAR_RULER_HEIGHT - CHUNK_LANE_HEIGHT,
    ),
  );

  const visibleDuration = audioDuration > 0 ? audioDuration / view.zoom : 60;
  const pxPerSec = size.width / visibleDuration;
  const viewStartS = Math.min(
    Math.max(0, view.scrollX),
    Math.max(0, audioDuration - visibleDuration),
  );
  const viewEndS = viewStartS + visibleDuration;

  // Auto-follow: pan the timeline to the focused chunk so the user can
  // see what they're hearing in the loop. Triggers on focus-id changes
  // only — user pan/zoom afterwards is respected until the next focus
  // change. Direct clicks ON the timeline (chunk blocks, waveform,
  // bar-ruler) suppress the follow — the user already pointed at the
  // location they care about; re-centring would yank the cursor off
  // its target. Set in onPointerDownCapture below; consumed here.
  const suppressAutoFollowRef = useRef(false);
  useEffect(() => {
    if (!focusedChunkId) {
      suppressAutoFollowRef.current = false;
      return;
    }
    if (suppressAutoFollowRef.current) {
      suppressAutoFollowRef.current = false;
      return;
    }
    const chunk = chunks.find((c) => c.id === focusedChunkId);
    if (!chunk) return;
    const startS = chunk.startMs / 1000;
    // Sequence mode advances the playhead to each chunk's start. Only pan
    // when that point is off-screen — if it's already visible, let the
    // playhead jump there without yanking the view. (Loop/continue keep
    // the "bring the whole focused chunk into view" behaviour.)
    if (playbackMode === "sequence") {
      if (startS >= viewStartS && startS <= viewEndS) return;
      const visibleDur = viewEndS - viewStartS;
      setScrollX(Math.max(0, startS - visibleDur * 0.15));
      return;
    }
    const next = autoFollowScrollX({
      chunkStartS: startS,
      chunkEndS: chunk.endMs / 1000,
      viewStartS,
      viewEndS,
      audioDuration,
    });
    if (next != null) setScrollX(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-pan on focus-id changes
  }, [focusedChunkId]);

  // Stable identities — both sit in effect dependency arrays (waveform
  // redraw, window drag listeners) and in the memoized ChunkBlock's
  // props. As plain functions they'd get a fresh identity on every
  // render and defeat both.
  const timeToX = useCallback(
    (tS: number): number => (tS - viewStartS) * pxPerSec,
    [viewStartS, pxPerSec],
  );
  const xToTime = useCallback(
    (xPx: number): number => viewStartS + xPx / pxPerSec,
    [viewStartS, pxPerSec],
  );

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const panSecs = ((e.deltaX || e.deltaY) / pxPerSec) * 0.5;
      setScrollX(view.scrollX + panSecs);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorTimeBefore = xToTime(cursorX);
    const factor = Math.exp(-e.deltaY * 0.002);
    const nextZoom = Math.max(1, Math.min(500, view.zoom * factor));
    const nextVisible = audioDuration / nextZoom;
    const nextPxPerSec = size.width / nextVisible;
    const nextScroll = cursorTimeBefore - cursorX / nextPxPerSec;
    setZoom(nextZoom);
    setScrollX(Math.max(0, Math.min(audioDuration - nextVisible, nextScroll)));
  }

  // Touch: pinch-zoom + 1-finger pan.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<
    | {
        zoom: number;
        scrollX: number;
        midTime: number;
        midX: number;
        dist: number;
      }
    | null
  >(null);
  const panStartRef = useRef<{ scrollX: number; pointerX: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midX = (p1.x + p2.x) / 2 - rect.left;
      pinchStartRef.current = {
        zoom: view.zoom,
        scrollX: view.scrollX,
        midTime: xToTime(midX),
        midX,
        dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      };
      panStartRef.current = null;
    } else if (pointersRef.current.size === 1) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      panStartRef.current = {
        scrollX: view.scrollX,
        pointerX: e.clientX - rect.left,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2 && pinchStartRef.current) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const factor = dist / pinchStartRef.current.dist;
      const nextZoom = Math.max(
        1,
        Math.min(500, pinchStartRef.current.zoom * factor),
      );
      const nextVisible = audioDuration / nextZoom;
      const nextPxPerSec = size.width / nextVisible;
      const nextScroll =
        pinchStartRef.current.midTime - pinchStartRef.current.midX / nextPxPerSec;
      setZoom(nextZoom);
      setScrollX(
        Math.max(0, Math.min(audioDuration - nextVisible, nextScroll)),
      );
    } else if (pointersRef.current.size === 1 && panStartRef.current) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const deltaPx = pointerX - panStartRef.current.pointerX;
      const deltaSec = -deltaPx / pxPerSec;
      setScrollX(panStartRef.current.scrollX + deltaSec);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (e.pointerType !== "touch") return;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) panStartRef.current = null;
  }

  // ─── Pointer interaction ──────────────────────────────────────────────
  // Unified drag state — playhead scrub OR per-chunk trim handle. The
  // trim handles have their own onMouseDown with stopPropagation so
  // they never bubble here; the wrapper's onMouseDown handles the
  // remaining cases (playhead drag, chunk-lane focus).
  type DragState =
    | {
        kind: "trim";
        chunkId: string;
        edge: "left" | "right";
        anchorS: number;
      }
    | { kind: "playhead" };
  const dragRef = useRef<DragState | null>(null);
  const movedRef = useRef(false);

  /** Pick the snap context for a given master-time. We anchor on
   *  whichever chunk the cursor is currently INSIDE; if it's between
   *  chunks, fall back to the focused chunk; if neither, no snap.
   *  Always reads the latest jobBpm/snapMode/beatsPerBar via store. */
  function buildSnapAtTime(tS: number): {
    bpm: number;
    anchorS: number;
  } | null {
    const tMs = tS * 1000;
    const inside = chunks.find((c) => tMs >= c.startMs && tMs <= c.endMs);
    const focused = chunks.find((c) => c.id === focusedChunkId);
    const c = inside ?? focused ?? null;
    if (!c) return null;
    const bpm = effectiveChunkBpm(c, jobBpm?.value ?? null);
    if (bpm <= 0) return null;
    return { bpm, anchorS: chunkBeatPhaseS(c) };
  }

  function snapTimeS(tS: number, ev: { shiftKey: boolean }, ctx?: { bpm: number; anchorS: number } | null): number {
    if (ev.shiftKey || snapMode === "off") return tS;
    const snapCtx = ctx ?? buildSnapAtTime(tS);
    if (!snapCtx) return tS;
    return snapTime(tS, snapMode, {
      bpm: snapCtx.bpm,
      beatPhase: snapCtx.anchorS,
      beatsPerBar,
    });
  }

  function onWrapperMouseDown(e: React.MouseEvent) {
    // Only primary button.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Trim handles register their own onMouseDown with stopPropagation,
    // so they never reach here. Defensive double-check via data attr.
    if (target.dataset.trimHandle) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const tRaw = xToTime(xPx);
    const waveformTop = TIME_RULER_HEIGHT + BAR_RULER_HEIGHT;
    const chunkLaneTop = waveformTop + waveformHeight;

    // Click in the chunk lane on a chunk → focus it (no seek). The
    // chunk-lane click is purely a curation action.
    if (yPx >= chunkLaneTop) {
      const hit = chunks.find(
        (c) => tRaw * 1000 >= c.startMs && tRaw * 1000 <= c.endMs,
      );
      if (hit) {
        focusChunk(hit.id);
        return;
      }
      // Empty area in chunk lane → fall through to playhead scrub.
    }

    // Click anywhere in the WAVEFORM that lands inside a chunk's
    // bounds also focuses that chunk — the user shouldn't have to
    // hunt for the (sometimes thin) chunk-lane block to select it.
    // Then continue with playhead scrub so the seek lands at the
    // exact click position. focusChunk's seek to chunk start gets
    // overwritten by the seek() below, which is what we want.
    if (yPx >= waveformTop && yPx < chunkLaneTop) {
      const hit = chunks.find(
        (c) => tRaw * 1000 >= c.startMs && tRaw * 1000 <= c.endMs,
      );
      if (hit && hit.id !== focusedChunkId) {
        focusChunk(hit.id);
      }
    }

    // Playhead scrub — seek immediately + start tracking.
    movedRef.current = false;
    dragRef.current = { kind: "playhead" };
    seek(snapTimeS(tRaw, e));
  }

  // Stable identity (refs only) so the memoized ChunkBlock's props
  // don't churn — the block passes its own chunk back in.
  const startTrimDrag = useCallback(
    (chunk: Chunk, edge: "left" | "right", e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = false;
      dragRef.current = {
        kind: "trim",
        chunkId: chunk.id,
        edge,
        anchorS: chunkBeatPhaseS(chunk),
      };
    },
    [],
  );

  useEffect(() => {
    function onMove(ev: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      movedRef.current = true;
      const rect = wrapper.getBoundingClientRect();
      const xPx = ev.clientX - rect.left;
      const tRaw = xToTime(xPx);

      if (drag.kind === "playhead") {
        seek(snapTimeS(tRaw, ev));
        return;
      }

      // Trim drag: snap anchored at the chunk's own audio-start, with
      // the song-global BPM resolved fresh each move so changes mid-
      // drag (rare) take effect immediately.
      const chunk = chunks.find((c) => c.id === drag.chunkId);
      if (!chunk) return;
      const bpm = effectiveChunkBpm(chunk, jobBpm?.value ?? null);
      const snapped =
        ev.shiftKey || snapMode === "off" || bpm <= 0
          ? tRaw
          : snapTime(tRaw, snapMode, {
              bpm,
              beatPhase: drag.anchorS,
              beatsPerBar,
            });
      const timeMs = Math.round(snapped * 1000);
      const trimMode: "free" | "bar" = ev.shiftKey ? "free" : "bar";
      if (drag.edge === "left") {
        const next = Math.max(0, Math.min(chunk.endMs - 100, timeMs));
        if (next !== chunk.startMs) updateChunk(chunk.id, { startMs: next, trimMode });
      } else {
        const next = Math.max(
          chunk.startMs + 100,
          Math.min(audioDuration * 1000, timeMs),
        );
        if (next !== chunk.endMs) updateChunk(chunk.id, { endMs: next, trimMode });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // buildSnapAtTime / snapTimeS close over the current store values
    // so we re-install the listeners whenever any of those change.
  }, [
    chunks,
    focusedChunkId,
    updateChunk,
    xToTime,
    audioDuration,
    snapMode,
    beatsPerBar,
    jobBpm,
    seek,
  ]);

  const timeTicks = useTimeRuler(viewStartS, viewEndS, size.width);
  const barTicks = usePerChunkBarTicks(
    chunks,
    focusedChunkId,
    jobBpm?.value ?? null,
    beatsPerBar,
    viewStartS,
    viewEndS,
    pxPerSec,
  );
  // ─── Waveform ──────────────────────────────────────────────────────────
  // Source the silhouette from a transient-preserving min/max peak pyramid —
  // Ableton-grade detail that holds up at any zoom. Preference order:
  //   1. The pyramid precomputed + persisted in the sync step (instant, no pop).
  //   2. A lazy in-memory build from the store PCM (jobs synced before the
  //      cache existed).
  //   3. A degenerate pyramid from the 10 Hz RMS envelope, painted immediately
  //      while 1/2 are still loading/building.
  const [cachedPyramid, setCachedPyramid] = useState<PeakPyramid | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void getCachedPyramid(jobId, pcmSampleRate).then((p) => {
      if (!cancelled && p) setCachedPyramid(p);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, pcmSampleRate]);

  const [pcmPyramid, setPcmPyramid] = useState<PeakPyramid | null>(null);
  useEffect(() => {
    // Fallback build only when there's no persisted pyramid. Keep an
    // already-built pyramid if `pcm` later empties — the store detaches its PCM
    // buffer after load (BPM re-detection / worker transfer).
    if (cachedPyramid || !pcm || pcm.length === 0) return;
    let cancelled = false;
    void buildPeakPyramidAsync(pcm, pcmSampleRate, {
      baseSamplesPerBucket: 64,
    }).then((p) => {
      if (cancelled) return;
      setPcmPyramid(p);
      // Backfill the cache so jobs synced before the pyramid was persisted
      // become instant on the next open. Only persist if the source PCM
      // survived the whole build — the store may detach its buffer mid-build,
      // which would leave the tail of the pyramid zeroed; saving that would
      // bake a half-flat waveform into the cache.
      if (jobId && pcm.length > 0 && p.levels.length > 0) {
        void savePyramid(jobId, p).catch(() => {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pcm, pcmSampleRate, cachedPyramid, jobId]);
  const envelopePyramid = useMemo(
    () =>
      envelope && envelope.length > 0
        ? buildPyramidFromEnvelope(envelope, envelopeHz, pcmSampleRate)
        : null,
    [envelope, envelopeHz, pcmSampleRate],
  );
  const pyramid = cachedPyramid ?? pcmPyramid ?? envelopePyramid;

  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = size.width;
    const cssH = waveformHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!pyramid || pyramid.levels.length === 0) {
      // No data yet — leave the recessed paper-hi panel empty.
      return;
    }

    // Crisp transient-accurate body via the shared engine (one vertex per
    // device pixel, no smoothing). Triage normalizes to its loudest point so
    // the lane stays well-filled and the silence threshold reads consistently.
    const colMax = drawWaveform(ctx, {
      pyramid,
      pcm: pcm && pcm.length > 0 ? pcm : null,
      t0S: viewStartS,
      t1S: viewEndS,
      cssW,
      cssH,
      dpr,
      style: TRIAGE_STYLE,
      normalize: "peak",
    });

    // Silence overlay — still driven by the 10 Hz RMS envelope + dB threshold
    // (detection semantics unchanged), but shaped to the crisp body via colMax
    // so the amber tint stays locked to the silhouette.
    if (envelope && envelope.length > 0) {
      const cx = cssH / 2;
      const half = cssH / 2 - 2;
      const yTop = (v: number) => cx - v * half;
      const yBot = (v: number) => cx + v * half;
      const thresholdLin = Math.pow(10, silenceConfig.thresholdDb / 20);
      const thresholdNorm = thresholdLin / pyramid.globalPeak;
      const n = colMax.length;

      // Peak-hold the RMS envelope per CSS column for the threshold test.
      const sPerEnv = 1 / envelopeHz;
      const envCol = new Float32Array(n);
      for (let x = 0; x < n; x++) {
        const t0 = xToTime(x);
        const t1 = xToTime(x + 1);
        const i0 = Math.max(0, Math.floor(t0 / sPerEnv));
        const i1 = Math.min(envelope.length, Math.ceil(t1 / sPerEnv));
        let m = 0;
        for (let i = i0; i < i1; i++) if (envelope[i] > m) m = envelope[i];
        envCol[x] = m;
      }

      // Phosphor-amber tint over above-threshold spans, shaped to the body.
      const tintGrad = ctx.createLinearGradient(0, 0, 0, cssH);
      tintGrad.addColorStop(0, "rgba(255, 87, 34, 0)");
      tintGrad.addColorStop(0.5, "rgba(255, 87, 34, 0.28)");
      tintGrad.addColorStop(1, "rgba(255, 87, 34, 0)");
      ctx.fillStyle = tintGrad;
      let spanStart = -1;
      for (let x = 0; x <= n; x++) {
        const above = x < n && envCol[x] > thresholdLin;
        if (above && spanStart < 0) spanStart = x;
        else if (!above && spanStart >= 0) {
          const spanEnd = x;
          ctx.beginPath();
          ctx.moveTo(spanStart, yTop(colMax[spanStart]));
          for (let xx = spanStart + 1; xx < spanEnd; xx++) {
            ctx.lineTo(xx, yTop(colMax[xx]));
          }
          for (let xx = spanEnd - 1; xx >= spanStart; xx--) {
            ctx.lineTo(xx, yBot(colMax[xx]));
          }
          ctx.closePath();
          ctx.fill();
          spanStart = -1;
        }
      }

      // Threshold guides — phosphor-amber hairline dashes, mirrored
      // across the centre. Dashed gives "guideline" not "limit fence".
      const thresholdY = cx - thresholdNorm * half;
      if (thresholdY > 0 && thresholdY < cssH) {
        ctx.strokeStyle = "rgba(255,138,79,0.55)";
        ctx.lineWidth = 0.75;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, thresholdY);
        ctx.lineTo(cssW, thresholdY);
        const thresholdYBottom = cx + thresholdNorm * half;
        if (thresholdYBottom < cssH) {
          ctx.moveTo(0, thresholdYBottom);
          ctx.lineTo(cssW, thresholdYBottom);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [
    pyramid,
    pcm,
    envelope,
    envelopeHz,
    size.width,
    waveformHeight,
    viewStartS,
    viewEndS,
    silenceConfig,
    xToTime,
  ]);

  const totalHeight =
    TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight + CHUNK_LANE_HEIGHT;

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full bg-paper-hi border border-rule rounded-md overflow-hidden select-none touch-none"
      onWheel={onWheel}
      onMouseDown={onWrapperMouseDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Capture-phase: runs before child handlers that mutate
      // focusedChunkId. Marks the next focus change as user-initiated
      // from this surface so the auto-follow effect skips it.
      onPointerDownCapture={() => {
        suppressAutoFollowRef.current = true;
      }}
      // Reset on release so a click that didn't end up changing the
      // focused chunk doesn't leave a stale flag for the next
      // shortcut-driven focus change.
      onPointerUpCapture={() => {
        suppressAutoFollowRef.current = false;
      }}
    >
      {/* Time ruler — secondary surface. Faint MM:SS for absolute
       *  reference; visually subordinate to the bar ruler below so
       *  the user's eye reads "musical grid" first. */}
      <div
        className="absolute left-0 top-0 right-0 bg-paper-bg border-b border-rule pointer-events-none"
        style={{ height: TIME_RULER_HEIGHT }}
      >
        {timeTicks.map((tick, i) => (
          <div
            key={`t-${i}`}
            className="absolute top-0 bottom-0 flex items-end pl-1"
            style={{
              left: timeToX(tick.t),
              color: tick.major ? "#A89F8B" : "#C9BFA6",
            }}
          >
            <span
              className="font-mono text-[8px] tracking-label uppercase pb-0.5 leading-none"
              style={{ opacity: tick.major ? 0.85 : 0.55 }}
            >
              {tick.label}
            </span>
            <span
              className="absolute right-0 bottom-0 w-px"
              style={{
                background: tick.major ? "#A89F8B" : "#C9BFA6",
                height: tick.major ? "60%" : "30%",
                opacity: tick.major ? 0.7 : 0.45,
              }}
            />
          </div>
        ))}
      </div>

      {/* Bar ruler — PRIMARY navigation surface. Per-chunk grid with
       *  numbered downbeats; each chunk's bar 1 sits at its
       *  audio-start onset. Beats between bars are thinner ticks at
       *  high zoom. */}
      <div
        className="absolute left-0 right-0 bg-paper-deep border-b border-rule pointer-events-none"
        style={{
          top: TIME_RULER_HEIGHT,
          height: BAR_RULER_HEIGHT,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -1px 0 rgba(0,0,0,0.08)",
        }}
      >
        {barTicks.map((tick, i) => {
          const dim = tick.extension === true;
          const barMajor = tick.kind === "bar" && tick.labeled === true;
          // Five tiers of marker, each with its own stroke + height so
          // the eye reads the hierarchy at every zoom:
          //   bar labeled:   2px,   100%, labeled with bar number
          //   bar unlabeled: 1.5px,  70%, no label
          //   beat:          1px,    40%
          //   div8:          1px,    25%
          //   div16:         1px,    15%
          let tickWidth = 1;
          let tickHeight = "40%";
          let tickColor = dim ? "#FF572233" : "#FF5722B0";
          if (barMajor) {
            tickWidth = 2;
            tickHeight = "100%";
            tickColor = dim ? "#FF572266" : HOT_COLOR;
          } else if (tick.kind === "bar") {
            tickWidth = 1.5;
            tickHeight = "70%";
            tickColor = dim ? "#FF572255" : "#FF5722CC";
          } else if (tick.kind === "div8") {
            tickHeight = "25%";
            tickColor = dim ? "#FF572222" : "#FF572288";
          } else if (tick.kind === "div16") {
            tickHeight = "15%";
            tickColor = dim ? "#FF572218" : "#FF572266";
          }
          const x = timeToX(tick.t);
          return (
            <span key={`b-${i}`}>
              <span
                className="absolute bottom-0"
                style={{
                  left: x,
                  width: tickWidth,
                  height: tickHeight,
                  background: tickColor,
                  marginLeft: -tickWidth / 2,
                }}
              />
              {barMajor && (
                <span
                  className="absolute font-display tracking-[0.05em] uppercase tabular leading-none select-none"
                  style={{
                    left: x + 3,
                    top: 3,
                    fontSize: 9,
                    color: dim ? "#FF572277" : "#1A1612",
                    fontWeight: dim ? 400 : 700,
                  }}
                >
                  {tick.barNumber}
                </span>
              )}
            </span>
          );
        })}
        {/* Anchor flag — marks the focused chunk's bar-grid phase anchor
         *  (audioStartMs). Distinct brass colour + a "1" glyph so the
         *  user can read at-a-glance whether the grid is in phase with
         *  the audio. After Conform shifts the anchor, this is the only
         *  immediate visual cue that something changed. */}
        {focusedChunkId &&
          (() => {
            const focused = chunks.find((c) => c.id === focusedChunkId);
            if (!focused) return null;
            const anchorS = chunkBeatPhaseS(focused);
            if (anchorS < viewStartS || anchorS > viewEndS) return null;
            const x = timeToX(anchorS);
            return (
              <span
                aria-hidden
                className="absolute pointer-events-none"
                style={{
                  left: x,
                  top: 0,
                  bottom: 0,
                  width: 0,
                }}
              >
                <span
                  className="absolute"
                  style={{
                    left: -1,
                    top: 0,
                    width: 2,
                    height: "100%",
                    background: "#C9A95A",
                    boxShadow: "0 0 4px rgba(201,169,90,0.6)",
                  }}
                />
                <span
                  className="absolute font-display tracking-[0.05em] uppercase tabular leading-none select-none"
                  style={{
                    left: 3,
                    top: 3,
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#7A5E1F",
                  }}
                >
                  1
                </span>
              </span>
            );
          })()}
      </div>

      <div
        className="absolute left-0 right-0"
        style={{ top: TIME_RULER_HEIGHT + BAR_RULER_HEIGHT }}
      >
        <canvas ref={waveformCanvasRef} />
      </div>

      <div
        className="absolute left-0 right-0 border-t border-rule bg-paper-deep"
        style={{
          top: TIME_RULER_HEIGHT + BAR_RULER_HEIGHT + waveformHeight,
          height: CHUNK_LANE_HEIGHT,
        }}
      >
        {chunks.map((chunk) => {
          const revealIndex = revealOrder?.index.get(chunk.id) ?? null;
          return (
          <ChunkBlock
            // Remount sliced pieces (incl. the kept-id first piece) so the
            // reveal animation fires on every slice, keyed on the gen.
            key={
              revealIndex != null
                ? `${chunk.id}-rev${revealOrder!.gen}`
                : chunk.id
            }
            chunk={chunk}
            timeToX={timeToX}
            visibleStart={viewStartS}
            visibleEnd={viewEndS}
            focused={chunk.id === focusedChunkId}
            revealIndex={revealIndex}
            reducedMotion={!!reducedMotion}
            // Filter is a view concern — chunks below the threshold
            // render as effectively-rejected without touching their
            // .accepted flag, so toggling the filter back off restores
            // the visual.
            effectivelyAccepted={
              chunk.accepted &&
              chunkPassesFilter(chunk, minChunkBars, jobBpm?.value ?? null, beatsPerBar)
            }
            onTrimStart={startTrimDrag}
          />
          );
        })}
      </div>

      {/* Downbeat-guillotine blades — a phosphor line drops on every cut,
       *  staggered left→right, when a chunk is sliced. Spans waveform +
       *  chunk lane so the cut reads as a clean vertical incision. */}
      <AnimatePresence>
        {sliceReveal && !reducedMotion &&
          sliceReveal.cutTimesS.map((t, i) => {
            const x = timeToX(t);
            if (x < -2 || x > size.width + 2) return null;
            return (
              <motion.div
                key={`blade-${sliceReveal.gen}-${i}`}
                aria-hidden
                className="absolute pointer-events-none"
                style={{
                  left: x - 1,
                  top: TIME_RULER_HEIGHT + BAR_RULER_HEIGHT,
                  height: waveformHeight + CHUNK_LANE_HEIGHT,
                  width: 2,
                  background: HOT_COLOR,
                  boxShadow:
                    "0 0 6px rgba(255,87,34,0.85), 0 0 2px rgba(255,87,34,1)",
                  transformOrigin: "top",
                }}
                initial={{ opacity: 0, scaleY: 0.2 }}
                animate={{ opacity: [0, 1, 0], scaleY: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, delay: i * 0.05, times: [0, 0.35, 1] }}
              />
            );
          })}
      </AnimatePresence>

      <TimelinePlayhead
        viewStartS={viewStartS}
        viewEndS={viewEndS}
        timeToX={timeToX}
        heightPx={totalHeight}
      />
    </div>
  );
}

/** The one element that tracks the 60 Hz playback clock. Isolated in
 *  its own component so the per-tick store update re-renders exactly
 *  this line — never the chunk lane or the rulers above. */
function TimelinePlayhead({
  viewStartS,
  viewEndS,
  timeToX,
  heightPx,
}: {
  viewStartS: number;
  viewEndS: number;
  timeToX: (t: number) => number;
  heightPx: number;
}) {
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  if (currentTime < viewStartS || currentTime > viewEndS) return null;
  return (
    <div
      data-testid="triage-playhead"
      className="absolute top-0 pointer-events-none"
      style={{
        left: timeToX(currentTime),
        height: heightPx,
        width: 2,
        background: PLAYHEAD_COLOR,
        boxShadow: "0 0 4px rgba(255,87,34,0.6)",
      }}
    />
  );
}

interface ChunkBlockProps {
  chunk: Chunk;
  timeToX: (t: number) => number;
  visibleStart: number;
  visibleEnd: number;
  focused: boolean;
  /** chunk.accepted AND passes the active min-bars filter. Drives the
   *  visual treatment (hot vs muted, strikethrough). The chunk's own
   *  accepted flag stays the user's manual decision. */
  effectivelyAccepted: boolean;
  /** Left-to-right position among freshly-sliced pieces, or null when
   *  this block isn't part of an in-flight slice reveal. Drives the
   *  staggered "deal" animation. */
  revealIndex: number | null;
  reducedMotion: boolean;
  onTrimStart: (chunk: Chunk, edge: "left" | "right", e: React.MouseEvent) => void;
}

/** Memoized: on focus / filter / single-chunk edits only the affected
 *  blocks re-render — with 100+ chunks per long-form jam the untouched
 *  framer-motion blocks are the expensive part of the lane. All props
 *  are identity-stable (store chunk objects, useCallback handlers). */
const ChunkBlock = memo(function ChunkBlock({
  chunk,
  timeToX,
  visibleStart,
  visibleEnd,
  focused,
  effectivelyAccepted,
  revealIndex,
  reducedMotion,
  onTrimStart,
}: ChunkBlockProps) {
  const startS = chunk.startMs / 1000;
  const endS = chunk.endMs / 1000;
  if (endS < visibleStart || startS > visibleEnd) return null;

  const left = timeToX(startS);
  const right = timeToX(endS);
  const exactWidthPx = right - left;
  const tooNarrow = exactWidthPx < MIN_VISIBLE_CHUNK_PX;
  const widthPx = tooNarrow ? MIN_VISIBLE_CHUNK_PX : exactWidthPx;
  // Centre the pill at the true block midpoint so its visual position
  // still matches the chunk's master-time even after the min-width
  // clamp. Without this, sub-3-px chunks would always stick to their
  // start edge and read as offset.
  const renderLeft = tooNarrow
    ? (left + right) / 2 - MIN_VISIBLE_CHUNK_PX / 2
    : left;

  const bg = effectivelyAccepted ? HOT_COLOR : "#5D5546";
  const fg = effectivelyAccepted ? "#FAF6EC" : "#A89F8B";

  // Slice-reveal "deal": each new piece grows from its left seam and
  // settles, staggered left→right, with a one-shot phosphor flash. The
  // flash is a transient animation overlay — not a status layer — so it
  // fades fully and never marks state. Skipped under reduced-motion.
  const dealing = revealIndex != null && !reducedMotion;
  const dealDelay = revealIndex != null ? revealIndex * 0.06 : 0;
  const flashColor = effectivelyAccepted ? "#FFD7A8" : "#9C8F73";
  const dealProps = dealing
    ? {
        initial: { scaleX: 0.9, y: -3 },
        animate: { scaleX: 1, y: 0 },
        transition: {
          duration: 0.34,
          delay: dealDelay,
          ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
        },
      }
    : {};
  const flash = dealing ? (
    <motion.div
      aria-hidden
      className="absolute inset-0 pointer-events-none"
      style={{ background: flashColor }}
      initial={{ opacity: 0.8 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 0.5, delay: dealDelay, ease: "easeOut" }}
    />
  ) : null;

  const showLabel = !tooNarrow && widthPx >= 120;
  const showHandles = !tooNarrow && widthPx >= HANDLES_MIN_PX;
  // Shrink the hit-area on small blocks so the two handles don't cover
  // the whole block (otherwise the centre is unclickable and you can't
  // focus). Capped at 8 px on big blocks for a comfortable grab.
  const handleHitPx = Math.max(4, Math.min(8, widthPx / 3));

  const tooltip = `${chunk.id}: ${formatTime(startS)} → ${formatTime(endS)}${
    chunk.detectedBpm ? ` · ${chunk.detectedBpm.toFixed(1)} BPM` : ""
  }${chunk.accepted && !effectivelyAccepted ? " · filtered out" : ""}`;

  // Pill mode — block too narrow to host content. Render a compact
  // rounded rectangle that's still visible at full zoom-out + reads
  // as proportionally tiny next to the rest of the lane.
  if (tooNarrow) {
    return (
      <motion.div
        className="absolute top-1 bottom-1 rounded-[2px] overflow-hidden"
        style={{
          left: renderLeft,
          width: widthPx,
          background: bg,
          transformOrigin: "left center",
          outline: focused ? `1.5px solid ${HOT_COLOR}` : undefined,
          outlineOffset: focused ? 1 : undefined,
          boxShadow: focused
            ? "0 0 4px rgba(255,87,34,0.65)"
            : "inset 0 1px 0 rgba(255,255,255,0.18)",
          zIndex: focused || dealing ? 2 : 1,
        }}
        title={tooltip}
        {...dealProps}
      >
        {flash}
      </motion.div>
    );
  }

  return (
    <motion.div
      className="absolute top-0 bottom-0 flex items-center px-1 overflow-hidden"
      style={{
        left: renderLeft,
        width: widthPx,
        background: bg,
        color: fg,
        transformOrigin: "left center",
        // Hot-orange ring + inner brass hairline = the 3-fach Tell
        // shared with Arrange's Frame component. Keeps the whole
        // selection language coherent across screens.
        outline: focused ? `2px solid ${HOT_COLOR}` : undefined,
        outlineOffset: focused ? -2 : undefined,
        boxShadow: focused
          ? "inset 0 0 0 1px rgba(255,255,255,0.35), 0 0 6px rgba(255,87,34,0.45)"
          : undefined,
        zIndex: focused || dealing ? 2 : 1,
      }}
      title={tooltip}
      {...dealProps}
    >
      {flash}
      {!effectivelyAccepted && (
        // Soft diagonal hatch instead of the old hard 1-px white line —
        // reads as "set aside" without screaming "deleted".
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, rgba(250,246,236,0.18) 0 1.5px, transparent 1.5px 6px)",
          }}
        />
      )}
      {showLabel && (
        <span className="font-mono text-[10px] tracking-label uppercase truncate relative">
          {`${formatTime(startS)} · ${(endS - startS).toFixed(1)}s${
            chunk.detectedBpm ? ` · ${chunk.detectedBpm.toFixed(0)}` : ""
          }`}
        </span>
      )}
      {showHandles && (
        <>
          <div
            data-trim-handle="left"
            className="absolute left-0 top-0 bottom-0 cursor-ew-resize"
            style={{ width: handleHitPx }}
            onMouseDown={(e) => onTrimStart(chunk, "left", e)}
            title="Drag to trim start (Shift = bypass snap)"
          >
            <div
              data-trim-handle="left"
              className="absolute left-0 top-0 bottom-0 pointer-events-none"
              style={{
                width: TRIM_HANDLE_PX,
                background: focused ? HOT_COLOR : "rgba(15,12,9,0.55)",
                boxShadow: focused
                  ? "0 0 4px rgba(255,87,34,0.7)"
                  : "1px 0 0 rgba(255,255,255,0.18)",
              }}
            />
          </div>
          <div
            data-trim-handle="right"
            className="absolute right-0 top-0 bottom-0 cursor-ew-resize"
            style={{ width: handleHitPx }}
            onMouseDown={(e) => onTrimStart(chunk, "right", e)}
            title="Drag to trim end (Shift = bypass snap)"
          >
            <div
              data-trim-handle="right"
              className="absolute right-0 top-0 bottom-0 pointer-events-none"
              style={{
                width: TRIM_HANDLE_PX,
                background: focused ? HOT_COLOR : "rgba(15,12,9,0.55)",
                boxShadow: focused
                  ? "0 0 4px rgba(255,87,34,0.7)"
                  : "-1px 0 0 rgba(255,255,255,0.18)",
              }}
            />
          </div>
        </>
      )}
    </motion.div>
  );
});

function useTimeRuler(
  viewStartS: number,
  viewEndS: number,
  widthPx: number,
): TimeRulerTick[] {
  return useMemo(
    () => buildTimeRulerTicks(viewStartS, viewEndS, widthPx),
    [viewStartS, viewEndS, widthPx],
  );
}

/** Bar/beat ticks for the FOCUSED chunk only.
 *
 *  Long-form sessions with dozens of chunks turned the ruler into a
 *  festival of "1" labels — each chunk's bar 1 sat at its own anchor,
 *  and at low zoom they all fired at once and collided. Bar markers
 *  are a per-chunk-context tool anyway: the user only cares about the
 *  bar grid of whatever they're trimming or scrubbing. Other chunks
 *  show up as colored lane blocks below; that's enough to navigate.
 *
 *  The grid math (adaptive label stride, zoom-gated beats/subdivisions,
 *  extension flags outside the chunk's half-open span) lives in the
 *  canonical `buildRulerTicks` — see `chunk-ruler-ticks.ts`. */
function usePerChunkBarTicks(
  chunks: Chunk[],
  focusedChunkId: string | null,
  jobBpm: number | null,
  beatsPerBar: number,
  viewStartS: number,
  viewEndS: number,
  pxPerSec: number,
): GridTick[] {
  return useMemo(() => {
    if (!focusedChunkId) return [];
    const chunk = chunks.find((c) => c.id === focusedChunkId);
    if (!chunk) return [];
    return buildChunkGridTicks(
      chunk,
      jobBpm,
      beatsPerBar,
      viewStartS,
      viewEndS,
      pxPerSec,
    );
  }, [chunks, focusedChunkId, jobBpm, beatsPerBar, viewStartS, viewEndS, pxPerSec]);
}

