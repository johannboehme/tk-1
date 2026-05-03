/**
 * Multi-lane Timeline.
 *
 * Layout (left → right): one column of HTML headers (PROGRAM label, per-cam
 * Lane-Headers, MASTER AUDIO label), then a single full-height canvas that
 * draws every lane in horizontal bands. The PROGRAM strip on top and the
 * custom hardware-mixer scrollbar at the bottom are HTML — they need rich
 * skeuomorph styling and live above/below the canvas.
 *
 * The canvas hosts: video-lane thumbnail tiles + clip pills + audio waveform
 * + trim handles + loop region + the global playhead. One canvas keeps the
 * playhead a single straight line spanning every lane.
 */
import {
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEditorStore } from "../store";
import { clipRangeS, isVideoClip, type Clip } from "../types";
import { LaneHeader, type CamStatus } from "./timeline/LaneHeader";
import { AddMediaButton } from "./AddMediaButton";
import { ProgramStrip } from "./timeline/ProgramStrip";
import { tapeHeightForMode } from "./timeline/tape-height";
import { SegmentedControl } from "./SegmentedControl";
import { BeatRuler } from "./timeline/BeatRuler";
import { BpmReadout } from "./BpmReadout";
import { SnapModeButtons } from "./SnapModeButtons";
import { snapTime, type SnapCtx, type SnapMode } from "../snap";
import { DEFAULT_MATCH_CONFIDENCE_THRESHOLD } from "../match-snap";
import {
  effectiveBeatPhaseS,
  effectiveBeatsPerBar,
  effectiveBarOffsetBeats,
} from "../selectors/timing";
import { BarsHeader } from "./timeline/BarsHeader";
import { useIsNarrowViewport } from "../use-is-narrow";
import { MASTER_AUDIO_ID } from "../types";

interface CamAssetInfo {
  /** OPFS object URL for this cam's thumbnail strip (may be null). */
  framesUrl: string | null;
  /** OPFS object URL of the cam's image file (image clips only). When
   *  set the lane shows it as a single fitted preview instead of the
   *  tiled video thumbnail strip. */
  imageUrl?: string | null;
  /** Source aspect ratio (width / height) — drives thumbnail tile geometry. */
  aspect: number;
}

interface Props {
  /** Per-cam asset info, keyed by camId. */
  cams: Record<string, CamAssetInfo>;
  peaks: [number, number][];
  audioDuration: number;
  /** Audio-lane height in px. Defaults to the legacy 88 to keep the waveform familiar. */
  audioLaneHeight?: number;
  /** Per-video-lane height in px. */
  videoLaneHeight?: number;
  /** Called when the user clicks the × on a lane header. The Editor wires
   *  this to removeCamFromJob — undefined means the delete affordance is
   *  hidden (e.g. for the very first cam in a single-cam project). */
  onDeleteClip?: (camId: string) => void;
}

type DragKind =
  | { kind: "playhead" }
  | { kind: "trim-in" }
  | { kind: "trim-out" }
  | { kind: "loop"; offset: number }
  | {
      /** Resize an image clip's right edge → grows durationS. */
      kind: "image-resize-end";
      camId: string;
      grabT: number;
      origDurationS: number;
      origStartOffsetS: number;
    }
  | {
      /** Resize an image clip's left edge → shifts startOffsetS while
       *  keeping the right edge in place. */
      kind: "image-resize-start";
      camId: string;
      grabT: number;
      origDurationS: number;
      origStartOffsetS: number;
    }
  | {
      /** Trim a video clip's right edge — narrows trimOutS within
       *  [trimInS+0.05, sourceDurationS]. */
      kind: "video-trim-out";
      camId: string;
      origStartS: number;
      origTrimInS: number;
      origTrimOutS: number;
      sourceDurationS: number;
    }
  | {
      /** Trim a video clip's left edge — narrows trimInS within
       *  [0, trimOutS-0.05]. */
      kind: "video-trim-in";
      camId: string;
      origStartS: number;
      origTrimInS: number;
      origTrimOutS: number;
      sourceDurationS: number;
    }
  | {
      kind: "clip-move";
      camId: string;
      grabT: number;
      origStartOffsetS: number;
      /** syncOverrideMs at drag-start. Drag mutates this (not
       *  startOffsetS) so the cam's audio/video alignment actually
       *  shifts against the master audio — startOffsetS is purely
       *  visual and would silently desync the cam's audio. */
      origSyncOverrideMs: number;
      /** Visible master-timeline startS at drag-start. Used to compute
       *  the pointer's intended new startS independently of any
       *  candidate-switch that may happen mid-drag — without it, the
       *  algoSync delta cascades and the user "jumps" past middle
       *  candidates. */
      origStartS: number;
    }
  | { kind: "scrollbar"; offsetX: number };

const HANDLE_HIT = 14;
const TARGET_TILE_W = 64;
/** Default lane-header column width on desktop. The narrow-viewport
 *  variant (`HEADER_W_COMPACT`) is used on phone-sized screens — see
 *  LaneHeader.tsx for the matching compact body. */
const HEADER_W_DEFAULT = 156;
const HEADER_W_COMPACT = 64;
const SCROLLBAR_H = 14;

export function Timeline({
  cams,
  peaks,
  audioDuration,
  audioLaneHeight = 48,
  videoLaneHeight = 48,
  onDeleteClip,
}: Props) {
  // Phone-sized viewports get a 64 px lane-header column instead of the
  // default 156 px — without this the header eats over half the timeline
  // canvas on a 280–390 px wide screen.
  const isNarrow = useIsNarrowViewport();
  const HEADER_W = isNarrow ? HEADER_W_COMPACT : HEADER_W_DEFAULT;
  const wrapRef = useRef<HTMLDivElement>(null);
  // Lane-stack vertical scroll state — drives the custom fader-thumb.
  const laneStackRef = useRef<HTMLDivElement>(null);
  const [laneScroll, setLaneScroll] = useState({
    top: 0,
    height: 0,
    viewport: 0,
  });
  const updateLaneScroll = () => {
    const el = laneStackRef.current;
    if (!el) return;
    setLaneScroll({
      top: el.scrollTop,
      height: el.scrollHeight,
      viewport: el.clientHeight,
    });
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const dragRef = useRef<DragKind | null>(null);
  /** Set during a clip-move drag so the PROGRAM strip can show match
   *  markers only while the user is actually re-aligning a cam. */
  const [activeClipMoveDragId, setActiveClipMoveDragId] = useState<
    string | null
  >(null);
  /** Snapshot of the timeline-range at drag-start. Frozen for the
   *  duration of a clip-move so the canvas doesn't rescale under the
   *  user's cursor — without this freeze, dragging right extends the
   *  range, the pixel-per-second shrinks, and the pill seems to
   *  asymptote to the canvas edge instead of following the pointer. */
  const frozenTimelineRangeRef = useRef<{
    startS: number;
    endS: number;
    span: number;
  } | null>(null);

  // Store reads — narrow selectors to keep re-renders cheap.
  const jobMeta = useEditorStore((s) => s.jobMeta);
  const trim = useEditorStore((s) => s.trim);
  const arrangementSegments = useEditorStore((s) => s.arrangementSegments);
  const setTrim = useEditorStore((s) => s.setTrim);
  const loop = useEditorStore((s) => s.playback.loop);
  const setLoop = useEditorStore((s) => s.setLoop);
  const seek = useEditorStore((s) => s.seek);
  const zoom = useEditorStore((s) => s.ui.zoom);
  const scrollX = useEditorStore((s) => s.ui.scrollX);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setScrollX = useEditorStore((s) => s.setScrollX);
  const clips = useEditorStore((s) => s.clips);
  const cuts = useEditorStore((s) => s.cuts);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setClipStartOffset = useEditorStore((s) => s.setClipStartOffset);
  const setImageClipDuration = useEditorStore((s) => s.setImageClipDuration);
  const setVideoClipTrim = useEditorStore((s) => s.setVideoClipTrim);
  const setClipSyncOverride = useEditorStore((s) => s.setClipSyncOverride);
  const setSelectedCandidateIdx = useEditorStore((s) => s.setSelectedCandidateIdx);
  const resetClipAlignment = useEditorStore((s) => s.resetClipAlignment);
  const removeCutAt = useEditorStore((s) => s.removeCutAt);
  const clearCuts = useEditorStore((s) => s.clearCuts);
  const clearAllFx = useEditorStore((s) => s.clearAllFx);
  const preparingCamIds = useEditorStore((s) => s.preparingCamIds);
  const currentTime = useEditorStore((s) => s.playback.currentTime);
  const holdGesture = useEditorStore((s) => s.holdGesture);
  const snapMode = useEditorStore((s) => s.ui.snapMode);
  const lanesLocked = useEditorStore((s) => s.ui.lanesLocked);
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value ?? null);
  const beatPhase = useEditorStore((s) => effectiveBeatPhaseS(s.jobMeta));
  const beatsPerBar = useEditorStore((s) => effectiveBeatsPerBar(s.jobMeta));
  const barOffsetBeats = useEditorStore((s) =>
    effectiveBarOffsetBeats(s.jobMeta),
  );
  const quantizePreview = useEditorStore((s) => s.quantizePreview);
  const fx = useEditorStore((s) => s.fx);
  const fxHolds = useEditorStore((s) => s.fxHolds);
  const programStripMode = useEditorStore((s) => s.ui.programStripMode);
  const setProgramStripMode = useEditorStore((s) => s.setProgramStripMode);
  const xClearProgress = useEditorStore((s) => s.ui.xClearProgress);
  // FX edits via timeline are gone — the lane is read-only now. All
  // mutation goes through the live-hold + erase API in the store.
  const liveFxIds = useMemo(() => {
    const set = new Set<string>();
    for (const k in fxHolds) set.add(fxHolds[k].fxId);
    return set;
  }, [fxHolds]);
  const takePromoteTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const duration = jobMeta?.duration || audioDuration || 0;
  // The visible/scroll range covers the union of the master audio AND
  // every cam's master-timeline span (incl. their match-marker positions
  // so candidate ticks at negative master-time stay reachable). During
  // an active clip-move drag we *freeze* this range to the snapshot
  // captured at drag-start (`frozenTimelineRangeRef`) — without that
  // freeze, dragging right would extend the range, shrink pxPerSec, and
  // the pill would asymptote to the canvas edge instead of following
  // the pointer.
  const liveTimelineRange = useMemo(() => {
    let lo = 0;
    let hi = duration;
    for (const c of clips) {
      const r = clipRangeS(c);
      if (r.startS < lo) lo = r.startS;
      if (r.endS > hi) hi = r.endS;
      // Candidate-marker positions only apply to video clips.
      if (isVideoClip(c)) {
        for (const cand of c.candidates) {
          const t = -(cand.offsetMs + c.syncOverrideMs) / 1000;
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
      }
    }
    return { startS: lo, endS: hi, span: hi - lo };
  }, [clips, duration]);
  const timelineRange = activeClipMoveDragId && frozenTimelineRangeRef.current
    ? frozenTimelineRangeRef.current
    : liveTimelineRange;
  const timelineStartS = timelineRange.startS;
  const timelineSpan = Math.max(1e-6, timelineRange.span);
  const visibleDur = timelineSpan / zoom;
  // scrollX semantics: offset (≥0) from timelineStartS. We clamp here so
  // a stale scrollX doesn't escape after the range changes (e.g. user
  // drags a cam further left, shrinking timelineStartS).
  const maxScroll = Math.max(0, timelineSpan - visibleDur);
  const clampedScroll = Math.max(0, Math.min(maxScroll, scrollX));
  const viewStart = timelineStartS + clampedScroll;
  const viewEnd = viewStart + visibleDur;

  // Auto-page: when the playhead moves outside the visible range (during
  // playback or via a programmatic seek), snap scrollX so the playhead
  // reappears at the start of the next "screen". Gated on the playhead
  // having moved this render — otherwise scrolling away while paused
  // would snap straight back.
  const lastPlayheadRef = useRef(currentTime);
  useEffect(() => {
    const moved = currentTime !== lastPlayheadRef.current;
    lastPlayheadRef.current = currentTime;
    if (!moved) return;
    if (currentTime >= viewStart && currentTime <= viewEnd) return;
    const next = Math.max(0, Math.min(maxScroll, currentTime - timelineStartS));
    if (Math.abs(next - clampedScroll) > 1e-6) setScrollX(next);
  }, [currentTime, viewStart, viewEnd, timelineStartS, maxScroll, clampedScroll, setScrollX]);

  // ---- Layout offsets (canvas y-coordinates per lane) ----
  const videoBands = clips.map((_, i) => ({
    top: i * videoLaneHeight,
    bottom: (i + 1) * videoLaneHeight,
  }));
  const audioBand = {
    top: clips.length * videoLaneHeight,
    bottom: clips.length * videoLaneHeight + audioLaneHeight,
  };
  const canvasH = audioBand.bottom;

  // ---- Resize observer ----
  // Re-runs when HEADER_W flips between desktop (156) and compact (64)
  // so a viewport-width change re-derives canvasWidth from the new
  // header column width — otherwise the canvas drifts ~92 px wider or
  // narrower than the actual lane area until the next browser resize.
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setCanvasWidth(Math.max(0, w - HEADER_W));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [HEADER_W]);

  // Re-measure the lane-stack scroll geometry whenever the cam count
  // changes — adding / removing lanes shifts scrollHeight, and the
  // thumb size needs to follow.
  useEffect(() => {
    updateLaneScroll();
  }, [clips.length]);

  // Global drag terminator. setPointerCapture on the canvas SHOULD
  // route a pointerup to us regardless of where the cursor lands, but
  // in practice the up event can be lost (cursor leaves the browser
  // window, OS swallows the up, capture interrupted by a layout
  // change). When that happens the dragRef stays armed and the next
  // pointermove over the canvas snaps the trim/clip to the cursor as
  // if the user were still holding the button — the bug the user
  // reports as "stays in zieh-modus". Listening on window covers the
  // off-canvas releases too. Pairs with the `e.buttons === 0` guard
  // in onPointerMove for re-entry without a release event at all.
  useEffect(() => {
    function clearStaleDrag() {
      if (dragRef.current) {
        dragRef.current = null;
        setActiveClipMoveDragId(null);
        frozenTimelineRangeRef.current = null;
      }
    }
    window.addEventListener("pointerup", clearStaleDrag);
    window.addEventListener("pointercancel", clearStaleDrag);
    window.addEventListener("blur", clearStaleDrag);
    return () => {
      window.removeEventListener("pointerup", clearStaleDrag);
      window.removeEventListener("pointercancel", clearStaleDrag);
      window.removeEventListener("blur", clearStaleDrag);
    };
  }, [setActiveClipMoveDragId]);

  // ---- Per-cam thumbnail Image objects ----
  // Video clips: load the frames-strip (multiple stills laid out
  // horizontally). Image clips: load the image asset itself so the lane
  // shows a real preview, not a coloured pill.
  const camImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [camImagesReady, setCamImagesReady] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const map = new Map<string, HTMLImageElement>();
    let pending = 0;
    for (const clip of clips) {
      const camAsset = cams[clip.id];
      if (!camAsset) continue;
      const url =
        clip.kind === "image"
          ? camAsset.imageUrl ?? null
          : camAsset.framesUrl;
      if (!url) continue;
      pending++;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      img.onload = () => {
        if (cancelled) return;
        map.set(clip.id, img);
        camImagesRef.current = map;
        setCamImagesReady((n) => n + 1);
      };
      img.onerror = () => {
        if (!cancelled) setCamImagesReady((n) => n + 1);
      };
    }
    if (pending === 0) {
      camImagesRef.current = map;
      setCamImagesReady((n) => n + 1);
    }
    return () => {
      cancelled = true;
    };
  }, [clips, cams]);

  // ---- t↔x helpers ----
  const tToX = useCallback(
    (t: number) => ((t - viewStart) / visibleDur) * canvasWidth,
    [viewStart, visibleDur, canvasWidth],
  );
  const xToT = useCallback(
    (x: number) => viewStart + (x / canvasWidth) * visibleDur,
    [viewStart, visibleDur, canvasWidth],
  );

  // ---- Active-cam status per lane (drives LED color) ----
  const camStatusByCamId = useMemo(() => {
    const result: Record<string, CamStatus> = {};
    const ranges = clips.map((c) => {
      const r = clipRangeS(c);
      return { id: c.id, startS: r.startS, endS: r.endS };
    });
    const activeId = (() => {
      const s = useEditorStore.getState();
      return s.activeCamId(currentTime);
    })();
    for (const cam of clips) {
      const range = ranges.find((r) => r.id === cam.id)!;
      const hasMaterial = currentTime >= range.startS && currentTime < range.endS;
      const status: CamStatus =
        cam.id === activeId
          ? "on-air"
          : hasMaterial
            ? "available"
            : "off";
      result[cam.id] = status;
    }
    return result;
  }, [clips, cuts, currentTime]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Canvas drawing ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvasWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvasH * dpr));
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasH}px`;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const ctx: CanvasRenderingContext2D = ctx2d;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background — paper-deep, the same tone the unselected SidePanel tabs
    // sit on. Keeps the timeline inside the existing palette.
    ctx.fillStyle = "#E8E1D0"; // paper-deep
    ctx.fillRect(0, 0, canvasWidth, canvasH);

    // Per-video-lane: thumbnails + clip pill.
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const band = videoBands[i];
      drawVideoLane({
        ctx,
        clip,
        bandTop: band.top,
        bandH: videoLaneHeight,
        canvasWidth,
        viewStart,
        visibleDur,
        img: camImagesRef.current.get(clip.id) ?? null,
        aspect: cams[clip.id]?.aspect ?? 16 / 9,
        selected: clip.id === selectedClipId,
      });
      // Match-point markers: vertical ticks at each candidate's implied
      // start position. Highlighted in MATCH mode; subtle otherwise so the
      // user can see all alternatives the matcher considered.
      drawMatchMarkers({
        ctx,
        clip,
        bandTop: band.top,
        bandH: videoLaneHeight,
        viewStart,
        visibleDur,
        canvasWidth,
        emphasized: snapMode === "match",
      });
      // Lane separator line below each video lane (subtle sepia rule).
      ctx.fillStyle = "#D8CFB8";
      ctx.fillRect(0, band.bottom - 1, canvasWidth, 1);
    }

    // Audio lane background — paper-panel, the only sibling tone in the
    // palette. Sets the audio band apart from the video lanes without
    // introducing a new hex. When the lane stack overflows vertically,
    // the audio lane is the one whose darker bg visually clashes with
    // the fader thumb to its right; clip it short by SCROLLBAR_H so
    // the seam falls between paper-panel and the scrollbar instead of
    // through it.
    const audioRightX = laneScroll.height > laneScroll.viewport + 0.5
      ? Math.max(0, canvasWidth - SCROLLBAR_H)
      : canvasWidth;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, audioBand.top, audioRightX, audioLaneHeight);
    ctx.clip();

    ctx.fillStyle = "#DDD4BE"; // paper-panel
    ctx.fillRect(0, audioBand.top, audioRightX, audioLaneHeight);

    // Audio waveform — same logic as before.
    if (peaks.length > 0 && audioDuration > 0) {
      const wfMid = audioBand.top + audioLaneHeight / 2;
      const peaksPerSec = peaks.length / audioDuration;
      const startIdx = Math.max(0, Math.floor(viewStart * peaksPerSec));
      const endIdx = Math.min(peaks.length, Math.ceil(viewEnd * peaksPerSec));
      ctx.fillStyle = "#5C544A";
      let prevX = -1;
      let colMin = 0;
      let colMax = 0;
      for (let i = startIdx; i < endIdx; i++) {
        const t = i / peaksPerSec;
        const x = Math.round(tToX(t));
        const [mn, mx] = peaks[i];
        if (x !== prevX) {
          if (prevX >= 0) {
            const yMax = wfMid - (Math.max(0, colMax) * audioLaneHeight) / 2;
            const yMin = wfMid + (Math.max(0, -colMin) * audioLaneHeight) / 2;
            ctx.fillRect(prevX, yMax, 1, Math.max(1, yMin - yMax));
          }
          prevX = x;
          colMin = mn;
          colMax = mx;
        } else {
          if (mn < colMin) colMin = mn;
          if (mx > colMax) colMax = mx;
        }
      }
      if (prevX >= 0) {
        const yMax = wfMid - (Math.max(0, colMax) * audioLaneHeight) / 2;
        const yMin = wfMid + (Math.max(0, -colMin) * audioLaneHeight) / 2;
        ctx.fillRect(prevX, yMax, 1, Math.max(1, yMin - yMax));
      }
    }

    // Trim dim — shading on AUDIO lane only, since trim still refers to the
    // master-audio render bounds.
    const xIn = tToX(trim.in);
    const xOut = tToX(trim.out);
    ctx.fillStyle = "rgba(232,225,208,0.78)";
    if (xIn > 0) ctx.fillRect(0, audioBand.top, xIn, audioLaneHeight);
    if (xOut < audioRightX)
      ctx.fillRect(xOut, audioBand.top, audioRightX - xOut, audioLaneHeight);

    // Arrange handoff: dim every region NOT covered by an arrangement
    // segment, so the user reads at-a-glance which slices of the master
    // audio actually play. Segments overlap the trim shading naturally.
    if (arrangementSegments.length > 0) {
      // Build [trim.in, trim.out] minus the union of segment ranges,
      // then fill those gaps. Sort + walk segments so overlapping or
      // out-of-order segments still render correctly.
      const sorted = [...arrangementSegments]
        .map((s) => ({
          inS: Math.max(trim.in, s.in),
          outS: Math.min(trim.out, s.out),
        }))
        .filter((s) => s.outS > s.inS)
        .sort((a, b) => a.inS - b.inS);
      let cursor = trim.in;
      ctx.fillStyle = "rgba(232,225,208,0.62)";
      for (const seg of sorted) {
        if (seg.inS > cursor) {
          const gapX = tToX(cursor);
          const gapEnd = tToX(seg.inS);
          ctx.fillRect(gapX, audioBand.top, Math.max(1, gapEnd - gapX), audioLaneHeight);
        }
        cursor = Math.max(cursor, seg.outS);
      }
      if (cursor < trim.out) {
        const tailX = tToX(cursor);
        const tailEndX = tToX(trim.out);
        ctx.fillRect(
          tailX,
          audioBand.top,
          Math.max(1, tailEndX - tailX),
          audioLaneHeight,
        );
      }
      // Hot tick at every segment boundary (in + out) — like splice marks
      // in a tape edit. Reads even when the audio waveform is busy.
      ctx.fillStyle = "rgba(255,87,34,0.55)";
      for (const seg of sorted) {
        const sx = tToX(seg.inS);
        const ex = tToX(seg.outS);
        if (sx >= 0 && sx <= audioRightX) {
          ctx.fillRect(sx, audioBand.top, 1, audioLaneHeight);
        }
        if (ex >= 0 && ex <= audioRightX) {
          ctx.fillRect(ex, audioBand.top, 1, audioLaneHeight);
        }
      }
    }

    // Loop band on audio lane.
    if (loop) {
      const xs = tToX(loop.start);
      const xe = tToX(loop.end);
      ctx.fillStyle = "rgba(255,87,34,0.18)";
      ctx.fillRect(xs, audioBand.top, Math.max(1, xe - xs), audioLaneHeight);
      ctx.strokeStyle = "rgba(255,87,34,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        xs + 0.5,
        audioBand.top + 0.5,
        Math.max(0, xe - xs - 1),
        audioLaneHeight - 1,
      );
    }

    // Trim handles on the audio lane (top + bottom brackets). Clamped to
    // the audio's effective right edge so the rightmost handle doesn't
    // poke under the vertical fader.
    drawHandle(ctx, xIn, audioBand.top, audioLaneHeight);
    drawHandle(
      ctx,
      Math.min(xOut, audioRightX),
      audioBand.top,
      audioLaneHeight,
    );

    // Audio-start marker (corrected position). Shown when the analyzer
    // detected a silent intro OR the user nudged the start manually.
    const rawAudioStartS = jobMeta?.audioStartS ?? 0;
    const audioNudgeS = jobMeta?.audioStartNudgeS ?? 0;
    if (rawAudioStartS > 0 || audioNudgeS !== 0) {
      const xMark = tToX(rawAudioStartS + audioNudgeS);
      if (xMark >= 0 && xMark <= audioRightX) {
        ctx.fillStyle = "rgba(255,107,0,0.85)";
        ctx.fillRect(Math.floor(xMark), audioBand.top, 1, audioLaneHeight);
        // Small triangle flag at the top so the marker reads even when
        // the playhead overlaps it.
        ctx.beginPath();
        ctx.moveTo(xMark, audioBand.top);
        ctx.lineTo(xMark + 5, audioBand.top);
        ctx.lineTo(xMark, audioBand.top + 5);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();

    // Selection outline when Master Audio is the SyncTuner target.
    if (selectedClipId === MASTER_AUDIO_ID) {
      ctx.strokeStyle = "#FF6B00";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        1,
        audioBand.top + 1,
        audioRightX - 2,
        audioLaneHeight - 2,
      );
    }

    // Playhead — spans all lanes.
    const xp = tToX(currentTime);
    ctx.strokeStyle = "#FF5722";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xp, 0);
    ctx.lineTo(xp, canvasH);
    ctx.stroke();
    // Playhead grip (top).
    ctx.fillStyle = "#FF5722";
    ctx.beginPath();
    ctx.moveTo(xp - 6, 0);
    ctx.lineTo(xp + 6, 0);
    ctx.lineTo(xp, 9);
    ctx.closePath();
    ctx.fill();

    // Q-hold quantize preview: ghost markers at the snapped target
    // positions. Drawn last so they overlay every lane.
    if (quantizePreview) {
      ctx.save();
      ctx.fillStyle = "rgba(0, 102, 204, 0.85)"; // cobalt
      ctx.strokeStyle = "rgba(0, 102, 204, 0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      for (const change of quantizePreview.cuts) {
        const xTo = tToX(change.to);
        if (xTo < -2 || xTo > canvasWidth + 2) continue;
        ctx.beginPath();
        ctx.moveTo(xTo, 0);
        ctx.lineTo(xTo, canvasH);
        ctx.stroke();
      }
      // Faded "from" line for each off-grid cut (visual hint of the move).
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      for (const change of quantizePreview.cuts) {
        const xFrom = tToX(change.from);
        if (xFrom < -2 || xFrom > canvasWidth + 2) continue;
        ctx.beginPath();
        ctx.moveTo(xFrom, 0);
        ctx.lineTo(xFrom, canvasH);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    canvasWidth,
    canvasH,
    audioBand.top,
    audioLaneHeight,
    videoLaneHeight,
    viewStart,
    viewEnd,
    visibleDur,
    duration,
    peaks,
    audioDuration,
    trim.in,
    trim.out,
    arrangementSegments,
    loop,
    currentTime,
    clips,
    cams,
    selectedClipId,
    camImagesReady,
    tToX,
    videoBands,
    snapMode,
    quantizePreview,
    // Re-draw when the audio-start marker shifts (raw or user-nudged) so
    // the orange flag tracks the SyncTuner knob in real time.
    jobMeta?.audioStartS,
    jobMeta?.audioStartNudgeS,
    // Re-draw when overflow toggles so the audio-lane clip-rect picks up
    // the new audioRightX. Without these, initial mount captures the
    // pre-measure {height:0, viewport:0} state and the audio lane gets
    // painted under the fader thumb forever.
    laneScroll.height,
    laneScroll.viewport,
  ]);

  // ---- Hit-testing & drag ----
  function findClipAt(x: number, y: number): { clip: Clip; band: { top: number; bottom: number } } | null {
    for (let i = 0; i < clips.length; i++) {
      const band = videoBands[i];
      if (y < band.top || y >= band.bottom) continue;
      const range = clipRangeS(clips[i]);
      const x1 = tToX(range.startS);
      const x2 = tToX(range.endS);
      if (x >= x1 && x <= x2) return { clip: clips[i], band };
      return null; // hit the lane but missed the pill → no clip selected
    }
    return null;
  }

  /** Lane-only hit-test: returns the clip whose lane band contains `y`,
   *  regardless of whether the pointer's `x` lands inside the pill. Used
   *  to make the WHOLE row a selection target so the user can park the
   *  playhead with a normal click and still send I/O to that clip. */
  function findLaneAt(y: number): { clip: Clip; band: { top: number; bottom: number } } | null {
    for (let i = 0; i < clips.length; i++) {
      const band = videoBands[i];
      if (y >= band.top && y < band.bottom) return { clip: clips[i], band };
    }
    return null;
  }

  /** Edge-handle hit-test for clip resizing. Detects whether the pointer
   *  is on the LEFT or RIGHT edge of a clip's pill (within HANDLE_HIT px).
   *  Image clips: both edges are draggable. Video clips: trim handles on
   *  both edges (constrained within the source's full length). */
  function findClipResizeEdge(
    x: number,
    y: number,
  ): { clip: Clip; edge: "start" | "end"; band: { top: number; bottom: number } } | null {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const band = videoBands[i];
      if (y < band.top || y >= band.bottom) continue;
      const range = clipRangeS(c);
      const xStart = tToX(range.startS);
      const xEnd = tToX(range.endS);
      // End edge first — when start and end are very close together (a
      // freshly-trimmed sliver) the user is more likely aiming at the
      // visible right edge.
      if (Math.abs(x - xEnd) <= HANDLE_HIT) return { clip: c, edge: "end", band };
      if (Math.abs(x - xStart) <= HANDLE_HIT) return { clip: c, edge: "start", band };
    }
    return null;
  }

  function classifyAudioHit(x: number): "trim-in" | "trim-out" | "playhead" | "loop" | null {
    const xp = tToX(currentTime);
    const xIn = tToX(trim.in);
    const xOut = tToX(trim.out);
    if (Math.abs(x - xIn) <= HANDLE_HIT) return "trim-in";
    if (Math.abs(x - xOut) <= HANDLE_HIT) return "trim-out";
    if (Math.abs(x - xp) <= HANDLE_HIT) return "playhead";
    if (loop) {
      const xs = tToX(loop.start);
      const xe = tToX(loop.end);
      if (x >= xs && x <= xe) return "loop";
    }
    return null;
  }

  // Build the snap context for this drag. `extraCandidates` is set during
  // a clip-move so MATCH mode can snap the cam to its alternative offsets.
  function buildSnapCtx(extraCandidates?: number[]): SnapCtx {
    return {
      bpm,
      beatPhase,
      beatsPerBar,
      barOffsetBeats,
      candidatePositions: extraCandidates,
    };
  }

  // Wrap a raw timeline-time through the active snap mode. Shift-hold
  // bypasses snapping (standard NLE-style anti-snap modifier).
  function snapped(t: number, e: { shiftKey: boolean }, candPositions?: number[]): number {
    if (e.shiftKey || snapMode === "off") return t;
    return snapTime(t, snapMode, buildSnapCtx(candPositions));
  }

  // ─── Multi-touch pinch-zoom + 2-finger pan ─────────────────────────
  //
  // Pinch and 2-finger pan are the only practical zoom/pan affordances
  // on a phone; trackpad ctrl-wheel doesn't help touch users. We track
  // every active pointer; when ≥ 2 are down we cancel any single-finger
  // drag (so seek/playhead doesn't fight the gesture) and:
  //   - zoom anchored at the gesture centroid by the ratio of current
  //     finger-distance to start-distance
  //   - pan by however much the centroid has translated since the
  //     previous frame (frame-relative so the math stays stable)
  // The single-finger path falls through unchanged so tap-to-seek and
  // clip drags still work with a stylus or one finger.
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  );
  const gestureRef = useRef<
    | {
        startDist: number;
        startZoom: number;
        startScroll: number;
        startCentroidX: number;
        startTAtCentroid: number;
        lastCentroidX: number;
      }
    | null
  >(null);

  function pointersCentroid(): { x: number; y: number } {
    const pts = Array.from(activePointersRef.current.values());
    const n = pts.length || 1;
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  function pointersDistance(): number {
    const pts = Array.from(activePointersRef.current.values());
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Track this pointer for multi-touch detection.
    activePointersRef.current.set(e.pointerId, { x, y });

    // 2nd finger lands → enter pinch/pan mode. Tear down any single-
    // finger drag started by the first finger so it doesn't keep
    // seeking while the user is pinching.
    if (activePointersRef.current.size >= 2) {
      dragRef.current = null;
      setActiveClipMoveDragId(null);
      const centroid = pointersCentroid();
      gestureRef.current = {
        startDist: pointersDistance() || 1,
        startZoom: zoom,
        startScroll: clampedScroll,
        startCentroidX: centroid.x,
        startTAtCentroid: xToT(centroid.x),
        lastCentroidX: centroid.x,
      };
      return;
    }

    const tRaw = xToT(x);

    // Audio lane → existing trim/loop/playhead/seek behavior.
    if (y >= audioBand.top) {
      const k = classifyAudioHit(x);
      if (k === null) {
        // Click on empty audio = scrub + target master-audio for the
        // SyncTuner. Selection is decoupled from the seek/drag so the
        // user can still scrub freely while the panel switches mode.
        setSelectedClipId(MASTER_AUDIO_ID);
        seek(snapped(tRaw, e));
        dragRef.current = { kind: "playhead" };
      } else if (k === "trim-in") {
        dragRef.current = { kind: "trim-in" };
      } else if (k === "trim-out") {
        dragRef.current = { kind: "trim-out" };
      } else if (k === "playhead") {
        dragRef.current = { kind: "playhead" };
      } else if (k === "loop" && loop) {
        dragRef.current = { kind: "loop", offset: tRaw - loop.start };
      }
      return;
    }

    // Video lane:
    //   * Locked (default): click anywhere = scrub the playhead (the
    //     playhead can be dragged through dense clips without getting
    //     stuck).
    //   * Unlocked: click on the right edge of an image clip = resize
    //     drag (durationS); click on a clip pill = drag-move that clip;
    //     click on empty area = scrub the playhead. Selection always
    //     happens.
    if (!lanesLocked) {
      const edge = findClipResizeEdge(x, y);
      if (edge) {
        setSelectedClipId(edge.clip.id);
        const range = clipRangeS(edge.clip);
        if (edge.clip.kind === "image") {
          dragRef.current = {
            kind: edge.edge === "end" ? "image-resize-end" : "image-resize-start",
            camId: edge.clip.id,
            grabT: tRaw,
            origDurationS: edge.clip.durationS,
            origStartOffsetS: edge.clip.startOffsetS,
          };
        } else if (isVideoClip(edge.clip)) {
          dragRef.current = {
            kind: edge.edge === "end" ? "video-trim-out" : "video-trim-in",
            camId: edge.clip.id,
            origStartS: range.startS,
            origTrimInS: edge.clip.trimInS ?? 0,
            origTrimOutS:
              edge.clip.trimOutS ?? edge.clip.sourceDurationS,
            sourceDurationS: edge.clip.sourceDurationS,
          };
        }
        return;
      }
    }
    const hit = findClipAt(x, y);
    if (hit) {
      setSelectedClipId(hit.clip.id);
      if (!lanesLocked) {
        const r = clipRangeS(hit.clip);
        dragRef.current = {
          kind: "clip-move",
          camId: hit.clip.id,
          grabT: tRaw,
          origStartOffsetS: hit.clip.startOffsetS,
          // Image clips have no syncOverrideMs; the field is irrelevant
          // for them but the drag struct keeps a slot to keep the shape stable.
          origSyncOverrideMs: isVideoClip(hit.clip) ? hit.clip.syncOverrideMs : 0,
          origStartS: r.startS,
        };
        // Freeze the timeline range so pxPerSec stays stable through
        // the drag.
        frozenTimelineRangeRef.current = liveTimelineRange;
        setActiveClipMoveDragId(hit.clip.id);
      } else {
        seek(snapped(tRaw, e));
        dragRef.current = { kind: "playhead" };
      }
    } else {
      // Empty area inside a video lane → still treat the lane as a
      // selection target so I/O hotkeys (and any per-clip controls) can
      // address that clip without forcing the playhead onto its pill.
      // Falls back to deselecting only if the pointer is outside any
      // lane band.
      const lane = findLaneAt(y);
      setSelectedClipId(lane ? lane.clip.id : null);
      seek(snapped(tRaw, e));
      dragRef.current = { kind: "playhead" };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Stale-drag guard. If we have a pending drag but the pointer is
    // moving WITHOUT any mouse button pressed, the pointerup must have
    // fired outside our capture (e.g. user released the mouse off-canvas
    // or in a place where the OS swallowed the up event). Clear the drag
    // so the next move doesn't snap the trim/clip back to the cursor.
    // `e.buttons` is a bitmask of currently-held buttons — 0 means none.
    if (dragRef.current && e.buttons === 0) {
      onPointerUp();
      return;
    }

    // Update tracked pointer position whenever the pointer is captured
    // here. The map only contains pointers that went through the
    // canvas's onPointerDown, so plain hover events are skipped.
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x, y });
    }

    // ── Multi-touch zoom + pan ───────────────────────────────────
    if (gestureRef.current && activePointersRef.current.size >= 2) {
      const g = gestureRef.current;
      const centroid = pointersCentroid();
      const dist = pointersDistance();
      const scale = Math.max(0.0001, dist / g.startDist);
      // Anchor zoom on the time the centroid was over when the gesture
      // started, then pan so that point follows the centroid (gives a
      // "pin the timeline under your fingers" feel).
      const newZoom = Math.max(1, Math.min(64, g.startZoom * scale));
      const newVisible = timelineSpan / newZoom;
      const desiredViewStart = g.startTAtCentroid - (centroid.x / canvasWidth) * newVisible;
      const newScroll = Math.max(
        0,
        Math.min(timelineSpan - newVisible, desiredViewStart - timelineStartS),
      );
      if (newZoom !== zoom) setZoom(newZoom);
      setScrollX(newScroll);
      g.lastCentroidX = centroid.x;
      return;
    }

    if (!dragRef.current) return;
    const tRaw = Math.max(0, Math.min(duration, xToT(x)));
    const drag = dragRef.current;
    if (drag.kind === "playhead") {
      seek(snapped(tRaw, e));
    } else if (drag.kind === "image-resize-end") {
      // New right edge follows the pointer (snapped to the active grid),
      // durationS = new-right - startOffsetS.
      const newRightS = snapped(xToT(x), e);
      const newDuration = newRightS - drag.origStartOffsetS;
      setImageClipDuration(drag.camId, newDuration);
    } else if (drag.kind === "image-resize-start") {
      // Left edge moves; right edge stays fixed at orig + origDuration.
      const origRight = drag.origStartOffsetS + drag.origDurationS;
      const newLeft = Math.min(origRight - 0.1, snapped(xToT(x), e));
      setClipStartOffset(drag.camId, newLeft);
      setImageClipDuration(drag.camId, origRight - newLeft);
    } else if (drag.kind === "video-trim-out") {
      // New right edge on master timeline → trimOutS = new-right -
      // (origStartS - origTrimInS) so the un-trimmed startS stays put.
      const baseStartS = drag.origStartS - drag.origTrimInS;
      const newRightS = snapped(xToT(x), e);
      const newTrimOutS = newRightS - baseStartS;
      setVideoClipTrim(drag.camId, drag.origTrimInS, newTrimOutS);
    } else if (drag.kind === "video-trim-in") {
      const baseStartS = drag.origStartS - drag.origTrimInS;
      const newLeftS = snapped(xToT(x), e);
      const newTrimInS = newLeftS - baseStartS;
      setVideoClipTrim(drag.camId, newTrimInS, drag.origTrimOutS);
    } else if (drag.kind === "trim-in") {
      setTrim({ in: snapped(tRaw, e), out: trim.out });
    } else if (drag.kind === "trim-out") {
      setTrim({ in: trim.in, out: snapped(tRaw, e) });
    } else if (drag.kind === "loop" && loop) {
      const len = loop.end - loop.start;
      const newStartRaw = Math.max(trim.in, Math.min(trim.out - len, tRaw - drag.offset));
      const newStart = snapped(newStartRaw, e);
      setLoop({ start: newStart, end: newStart + len });
    } else if (drag.kind === "clip-move") {
      const c = clips.find((cc) => cc.id === drag.camId);
      if (!c) return;
      // Pointer's intended new clip-startS, computed from the snapshot
      // taken at drag-start. Stable through any candidate-switch that
      // happens mid-drag (which would otherwise jolt algoSyncS and make
      // middle candidates unreachable).
      const targetStartS = drag.origStartS + (xToT(x) - drag.grabT);

      // Image clips: drag simply moves the placement offset. No sync
      // override, no candidate logic — startOffsetS *is* the placement.
      if (!isVideoClip(c)) {
        const snappedStart = snapped(targetStartS, e);
        if (c.startOffsetS !== snappedStart) {
          setClipStartOffset(drag.camId, snappedStart);
        }
        return;
      }

      // MATCH mode: always snap to the nearest candidate-implied startS.
      // No distance threshold — every candidate is a valid lock-target.
      // Shift bypasses snapping entirely. We use the orig syncOverrideMs
      // to compute candidate positions, so candidate-switching mid-drag
      // doesn't shift the math under us.
      if (snapMode === "match" && !e.shiftKey && c.candidates.length > 0) {
        type CandPos = { idx: number; startS: number };
        const positions: CandPos[] = c.candidates
          .map((cand, idx) => {
            if (cand.confidence < DEFAULT_MATCH_CONFIDENCE_THRESHOLD) return null;
            const totalMs = cand.offsetMs + drag.origSyncOverrideMs;
            return { idx, startS: -totalMs / 1000 };
          })
          .filter((p): p is CandPos => p !== null);
        if (positions.length > 0) {
          let bestIdx = positions[0].idx;
          let bestDist = Math.abs(positions[0].startS - targetStartS);
          for (let i = 1; i < positions.length; i++) {
            const d = Math.abs(positions[i].startS - targetStartS);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = positions[i].idx;
            }
          }
          if (bestIdx !== c.selectedCandidateIdx) {
            setSelectedCandidateIdx(drag.camId, bestIdx);
          }
          // Keep the user's syncOverrideMs untouched (their fine-tune
          // applies on top of whichever candidate is chosen). Reset
          // startOffsetS so the cam sits exactly on the candidate anchor.
          if (c.syncOverrideMs !== drag.origSyncOverrideMs) {
            setClipSyncOverride(drag.camId, drag.origSyncOverrideMs);
          }
          if (c.startOffsetS !== 0) setClipStartOffset(drag.camId, 0);
          return;
        }
      }

      // Non-MATCH (off / grid): mutate syncOverrideMs so the drag is a
      // *true* sync change. The cam's master-timeline range slides; each
      // VideoElementPool re-anchors each video.currentTime automatically via the
      // shared `camSourceTimeS` computation, so the master-audio playhead
      // doesn't visually jump.
      const targetSnapped = snapped(targetStartS, e);
      // startS = -(syncOffsetMs + syncOverrideMs)/1000 + startOffsetS + trimInS
      // → syncOverrideMs = -1000*(startS - startOffsetS - trimInS) - syncOffsetMs
      const trimInS = c.trimInS ?? 0;
      const newSyncOverrideMs =
        -1000 * (targetSnapped - drag.origStartOffsetS - trimInS) -
        c.syncOffsetMs;
      setClipSyncOverride(drag.camId, newSyncOverrideMs);
    }
  };

  const onPointerUp = (e?: ReactPointerEvent<HTMLCanvasElement>) => {
    // Drop the pointer from the multi-touch tracker. If we were in a
    // pinch gesture and we just dropped below 2 fingers, exit gesture
    // mode (the remaining finger should not start a new seek-drag —
    // user lifted only one of two, so wait for them to lift the other
    // before re-arming single-touch interactions).
    if (e?.pointerId !== undefined) {
      activePointersRef.current.delete(e.pointerId);
    }
    if (gestureRef.current) {
      if (activePointersRef.current.size < 2) {
        gestureRef.current = null;
        // Suppress the lingering single-finger drag — user is winding
        // down a pinch, not starting a scrub.
        dragRef.current = null;
        setActiveClipMoveDragId(null);
        frozenTimelineRangeRef.current = null;
      }
      return;
    }
    dragRef.current = null;
    setActiveClipMoveDragId(null);
    frozenTimelineRangeRef.current = null;
  };

  // Trackpad-aware wheel handling — three exclusive modes:
  //
  //   1. Pinch / Ctrl-wheel (browsers map trackpad pinch to wheel +
  //      ctrlKey, mouse Ctrl/Cmd+wheel does the same): zoom, anchored
  //      at the cursor's master-time. preventDefault stops the
  //      browser's page-zoom.
  //   2. Option(Mac) / Alt(Windows) + wheel: also zoom. The Option
  //      key sets event.altKey on macOS — kept as a mouse-only
  //      fallback for users without a trackpad pinch gesture.
  //   3. Horizontal wheel (|deltaX| > |deltaY|): scrub time. The
  //      trackpad's natural left/right swipe nudges scrollX.
  //   4. Plain vertical wheel: not handled here — bubbles to the
  //      lane container's `overflow-y: auto` for natural lane scroll.
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const isZoomGesture = e.ctrlKey || e.metaKey || e.altKey;
    if (isZoomGesture) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tAtCursor = xToT(x);
      // Pinch gestures emit small smooth deltas; mouse wheel emits
      // chunky 100+ ones. Scale the factor so the pinch feels natural
      // without making the mouse wheel laggy.
      const intensity = Math.min(1, Math.abs(e.deltaY) / 50);
      const step = 1 + 0.2 * intensity;
      const factor = e.deltaY < 0 ? step : 1 / step;
      const newZoom = Math.max(1, Math.min(64, zoom * factor));
      if (newZoom === zoom) return;
      const newVisible = timelineSpan / newZoom;
      const desiredViewStart = tAtCursor - (x / canvasWidth) * newVisible;
      const newScroll = Math.max(
        0,
        Math.min(timelineSpan - newVisible, desiredViewStart - timelineStartS),
      );
      setZoom(newZoom);
      setScrollX(newScroll);
      return;
    }

    // Horizontal wheel = time scrub. Only intercept when deltaX
    // dominates, so a near-vertical trackpad swipe still falls through
    // to the lane scroll.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && e.deltaX !== 0) {
      e.preventDefault();
      const dt = (e.deltaX / canvasWidth) * visibleDur;
      const cur = viewStart - timelineStartS;
      const next = Math.max(0, Math.min(timelineSpan - visibleDur, cur + dt));
      setScrollX(next);
      return;
    }
    // Plain vertical wheel: let it bubble so overflow-y on the lane
    // container scrolls. No preventDefault, no setScroll.
  };

  // ---- Custom hardware-mixer scrollbar ----
  const scrollbarVisible = zoom > 1.001 && timelineSpan > 0;
  const thumbW = scrollbarVisible
    ? Math.max(28, (visibleDur / timelineSpan) * canvasWidth)
    : canvasWidth;
  const thumbX = scrollbarVisible
    ? ((viewStart - timelineStartS) / timelineSpan) * canvasWidth
    : 0;

  const onScrollPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrollbarVisible) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < thumbX || x > thumbX + thumbW) {
      const newThumbX = Math.max(0, Math.min(canvasWidth - thumbW, x - thumbW / 2));
      setScrollX((newThumbX / canvasWidth) * timelineSpan);
      dragRef.current = { kind: "scrollbar", offsetX: thumbW / 2 };
    } else {
      dragRef.current = { kind: "scrollbar", offsetX: x - thumbX };
    }
  };
  const onScrollPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.kind !== "scrollbar") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newThumbX = Math.max(0, Math.min(canvasWidth - thumbW, x - dragRef.current.offsetX));
    setScrollX((newThumbX / canvasWidth) * timelineSpan);
  };
  const onScrollPointerUp = () => {
    if (dragRef.current?.kind === "scrollbar") dragRef.current = null;
  };

  // Cursor hint
  const [hoverCursor, setHoverCursor] = useState<string>("default");
  const onPointerHover = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y >= audioBand.top) {
      const k = classifyAudioHit(x);
      setHoverCursor(
        k === "trim-in" || k === "trim-out"
          ? "ew-resize"
          : k === "playhead"
            ? "grab"
            : k === "loop"
              ? "move"
              : "crosshair",
      );
    } else {
      // Video lane — over a clip the cursor is `pointer` (clip is selectable
      // + scrub-draggable). Alt-modifier shows a `move` cursor to hint at
      // the alternate clip-move drag behavior. Image clips have a resize
      // affordance on their right edge.
      if (!lanesLocked && findClipResizeEdge(x, y)) {
        setHoverCursor("ew-resize");
        return;
      }
      const overClip = findClipAt(x, y);
      if (overClip) {
        setHoverCursor(e.altKey ? "move" : "pointer");
      } else {
        setHoverCursor("crosshair");
      }
    }
  };

  const zoomPercent = useMemo(() => Math.round(zoom * 100), [zoom]);

  // Build CamLookups for the PROGRAM strip.
  const camLookupsForStrip = useMemo(
    () =>
      clips.map((c) => ({
        id: c.id,
        color: c.color,
        range: clipRangeS(c),
      })),
    [clips],
  );

  return (
    <div ref={wrapRef} className="w-full select-none">
      {/* DESKTOP / TABLET header — hidden below sm. The big BPM bezel,
       *  cassette snap-key plate, and labelled BOTH/CUTS/FX segmented
       *  control are all here. Wraps onto a second line on a Galaxy
       *  Fold-folded phone and used to eat 3 entire rows of vertical
       *  space, so we hide the whole thing on `<sm` and replace it
       *  with `<MobileTimelineHeader />` below. */}
      <div className="hidden sm:flex items-center gap-x-4 gap-y-2 px-1 mb-2 flex-wrap">
        <BpmReadout />
        <div className="min-w-0 flex-shrink">
          <SnapModeButtons />
        </div>
        <SegmentedControl
          size="sm"
          value={programStripMode}
          onChange={(v) => setProgramStripMode(v)}
          options={[
            { value: "both", label: "BOTH" },
            { value: "cuts", label: "CUTS" },
            { value: "fx", label: "FX" },
          ]}
        />
        <ActiveMatchReadout
          camId={activeClipMoveDragId}
          snapMode={snapMode}
          clips={clips}
        />
        <div className="sm:ml-auto flex items-center gap-3">
          <span className="text-[10px] tabular text-ink-3 font-mono">
            {zoomPercent}%
          </span>
          <span className="text-[10px] tabular text-ink-3 font-mono">
            {viewStart.toFixed(1)}s — {viewEnd.toFixed(1)}s
          </span>
        </div>
      </div>
      {/* MOBILE header — single ~24-px-tall row with all the same
       *  controls but stripped of every label, stencil and bezel. */}
      <div className="flex sm:hidden">
        <MobileTimelineHeader zoomPercent={zoomPercent} />
      </div>

      <div className="rounded-md overflow-hidden border border-rule shadow-panel bg-paper-hi-deep">
        {/* Bar/beat ruler row — bars + beats + subdivisions, click to seek. */}
        <div className="flex border-b border-rule">
          <BarsHeader width={HEADER_W} height={26} />
          <div className="flex-1" style={{ width: canvasWidth }}>
            <BeatRuler
              contentWidthPx={canvasWidth}
              viewStartS={viewStart}
              viewEndS={viewEnd}
              height={26}
            />
          </div>
        </div>

        {/* PROGRAM-Strip row — header cell hosts the "+ Add" entry so
         *  there's no separate strip pushing the timeline taller. The
         *  row height tracks the strip mode so FX/both layouts get
         *  chunkier capsules. */}
        <div className="flex">
          <div
            className="shrink-0 flex items-center justify-end border-r border-b border-rule bg-paper-hi"
            style={{ width: HEADER_W, height: tapeHeightForMode(programStripMode) }}
          >
            {jobMeta?.id && <AddMediaButton jobId={jobMeta.id} compact={isNarrow} />}
          </div>
          <div className="flex-1 relative" style={{ width: canvasWidth }}>
            <ProgramStrip
              cuts={cuts}
              cams={camLookupsForStrip}
              duration={duration}
              viewStartS={viewStart}
              viewEndS={viewEnd}
              width={canvasWidth}
              onRemoveCut={removeCutAt}
              onCutDrag={(fromAtTimeS, camId, rawNewT, ev) => {
                // Apply the same snap rules as the rest of the timeline:
                // SHIFT bypasses, MATCH falls through (no candidatePositions
                // for cut-set), grid modes round to the nearest beat/bar.
                const snappedT = ev.shiftKey
                  ? rawNewT
                  : useEditorStore.getState().snapMasterTime(rawNewT);
                return useEditorStore
                  .getState()
                  .moveCut(fromAtTimeS, camId, snappedT);
              }}
              paintPreview={(() => {
                if (!holdGesture || !holdGesture.painting) return null;
                const clip = clips.find((c) => c.id === holdGesture.camId);
                if (!clip) return null;
                const idx = clips.findIndex((c) => c.id === clip.id);
                return {
                  fromS: holdGesture.startS,
                  toS: currentTime,
                  color: clip.color,
                  camLabel: `CAM ${idx + 1}`,
                };
              })()}
              matchMarkers={(() => {
                // Show match markers ONLY while the user is actively
                // dragging a clip in MATCH mode — they're an interaction
                // affordance, not a permanent overlay. We render the
                // markers for that one clip (so candidates from other
                // cams don't pollute the view).
                if (snapMode !== "match" || !activeClipMoveDragId) {
                  return undefined;
                }
                const found = clips.find((cc) => cc.id === activeClipMoveDragId);
                if (!found || !isVideoClip(found)) return undefined;
                const c = found;
                if (!c.candidates || c.candidates.length === 0) {
                  return undefined;
                }
                return c.candidates
                  .filter(
                    (cand) =>
                      cand.confidence >= DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
                  )
                  .map((cand) => {
                    const idx = c.candidates.indexOf(cand);
                    const totalMs = cand.offsetMs + c.syncOverrideMs;
                    return {
                      t: -totalMs / 1000,
                      confidence: cand.confidence,
                      isPrimary: idx === c.selectedCandidateIdx,
                    };
                  });
              })()}
              mode={programStripMode}
              fx={fx}
              liveFxIds={liveFxIds}
              onClearCuts={clearCuts}
              onClearFx={clearAllFx}
              externalClearProgress={xClearProgress}
            />
          </div>
        </div>

        {/* Lanes row: HTML headers on the left, single canvas on the right.
         *  Wrapped in a max-height + overflow-y container so adding more
         *  cams doesn't push the timeline section into the preview area —
         *  past ~5 cam lanes a vertical scrollbar appears on the right.
         *
         *  The relative wrapper sits OUTSIDE the scroll container so the
         *  vertical fader-thumb (rendered as its sibling below) is pinned
         *  to the viewport edge instead of scrolling out of view with the
         *  content — without this, scrolling down to reveal the audio
         *  lane would also scroll the track upward and leave the audio
         *  lane uncovered on the right. */}
        <div className="relative">
        <div
          ref={laneStackRef}
          className="flex no-native-scrollbar"
          style={{
            maxHeight: 5 * videoLaneHeight + audioLaneHeight,
            overflowY: "auto",
          }}
          onScroll={updateLaneScroll}
        >
          <div className="shrink-0 flex flex-col" style={{ width: HEADER_W }}>
            {clips.map((clip, i) => (
              <LaneHeader
                key={clip.id}
                name={`Cam ${i + 1}`}
                filename={clip.filename}
                color={clip.color}
                status={camStatusByCamId[clip.id] ?? "off"}
                hotkeyLabel={i < 9 ? String(i + 1) : undefined}
                selected={clip.id === selectedClipId}
                pressed={holdGesture?.camId === clip.id}
                painting={
                  holdGesture?.camId === clip.id && holdGesture.painting
                }
                onSelectClip={() => setSelectedClipId(clip.id)}
                // onTake is intentionally omitted — the cassette-rec
                // model fires the immediate cut inside onTakeStart so a
                // tap and a hold use one code path.
                onTakeStart={() => {
                  const s = useEditorStore.getState();
                  // Single-active-hold guard: ignore if another TAKE is
                  // already engaged (button or keyboard).
                  if (s.holdGesture) return;
                  const startS = s.snapMasterTime(s.playback.currentTime);
                  s.beginHoldGesture(clip.id, startS);
                  s.addCut({ atTimeS: startS, camId: clip.id });
                  const existing = takePromoteTimerRef.current.get(clip.id);
                  if (existing) clearTimeout(existing);
                  const t = setTimeout(() => {
                    useEditorStore.getState().promoteHoldToPaint();
                  }, 500);
                  takePromoteTimerRef.current.set(clip.id, t);
                }}
                onTakeFinish={() => {
                  const promoteT = takePromoteTimerRef.current.get(clip.id);
                  if (promoteT) {
                    clearTimeout(promoteT);
                    takePromoteTimerRef.current.delete(clip.id);
                  }
                  const s2 = useEditorStore.getState();
                  const hold = s2.holdGesture;
                  // Only act on releases that match this clip's hold —
                  // otherwise a stale onTakeFinish (after a cancelHold
                  // via Esc) shouldn't re-apply anything.
                  if (!hold || hold.camId !== clip.id) return;
                  const endS = s2.snapMasterTime(s2.playback.currentTime);
                  if (hold.painting) {
                    s2.applyHoldRelease(
                      clip.id,
                      hold.startS,
                      endS,
                      hold.priorCuts,
                    );
                  }
                  s2.endHoldGesture();
                }}
                canReset={
                  isVideoClip(clip) &&
                  (clip.syncOverrideMs !== 0 ||
                    clip.startOffsetS !== 0 ||
                    clip.selectedCandidateIdx !== 0)
                }
                onReset={() => resetClipAlignment(clip.id)}
                preparing={preparingCamIds.has(clip.id)}
                onDelete={() => onDeleteClip?.(clip.id)}
                height={videoLaneHeight}
                compact={isNarrow}
              />
            ))}
            {/* MASTER · AUDIO header — narrower padding + abbreviated
             *  label on phone-sized viewports so the header stays inside
             *  the 64 px column. */}
            <div
              className={`shrink-0 flex items-center border-r border-t border-rule bg-paper-hi ${isNarrow ? "px-1.5" : "px-3"}`}
              style={{ height: audioLaneHeight }}
            >
              <span className="font-mono text-[9px] tracking-label uppercase text-ink-2 truncate">
                {isNarrow ? "MASTER" : "MASTER · AUDIO"}
              </span>
            </div>
          </div>
          <div className="flex-1" style={{ width: canvasWidth }}>
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={(e) => {
                onPointerMove(e);
                onPointerHover(e);
              }}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              // Block the system context menu so a long-press
              // (hold-to-erase, hold-to-paint cut, etc.) on Android
              // Chrome / iOS Safari doesn't pop the platform "save
              // image / select / share" callout that hijacks the
              // gesture and aborts the user's edit. `touchAction:
              // none` already disables scroll/zoom; adding the
              // callout suppression closes the last gap.
              onContextMenu={(e) => e.preventDefault()}
              style={{
                cursor: hoverCursor,
                touchAction: "none",
                display: "block",
                WebkitTouchCallout: "none",
                WebkitUserSelect: "none",
                userSelect: "none",
              }}
            />
          </div>
        </div>
        {/* Vertical fader-thumb sits OUTSIDE the scroll container so it
         *  stays pinned to the viewport edge regardless of scrollTop —
         *  inside the scroll container it would scroll up with the
         *  content and uncover the audio lane on the right. */}
        <VerticalFaderThumb
          scrollTop={laneScroll.top}
          scrollHeight={laneScroll.height}
          viewport={laneScroll.viewport}
          onScrollTo={(t) => {
            if (laneStackRef.current) laneStackRef.current.scrollTop = t;
          }}
        />
        </div>

        {/* Custom scrollbar — hardware mixer fader feel */}
        <div className="flex">
          <div
            className="shrink-0 border-r border-t border-rule bg-paper-hi"
            style={{ width: HEADER_W, height: SCROLLBAR_H }}
          />
          <div
            onPointerDown={onScrollPointerDown}
            onPointerMove={onScrollPointerMove}
            onPointerUp={onScrollPointerUp}
            onPointerCancel={onScrollPointerUp}
            className="flex-1 relative border-t border-rule"
            style={{
              width: canvasWidth,
              height: SCROLLBAR_H,
              touchAction: "none",
              cursor: scrollbarVisible ? "pointer" : "default",
              background:
                "linear-gradient(180deg, #C9BFA6 0%, #DDD4BE 50%, #C9BFA6 100%)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.18)",
            }}
          >
            {/* Tick row in the track for a fader-rail feel */}
            <div className="absolute inset-y-[3px] left-0 right-0 flex items-center justify-between pointer-events-none">
              {Array.from({ length: 24 }).map((_, i) => (
                <span
                  key={i}
                  className="w-px h-[6px] block"
                  style={{ background: "rgba(0,0,0,0.18)" }}
                />
              ))}
            </div>
            <div
              className="absolute top-[2px] bottom-[2px] rounded-sm transition-opacity"
              style={{
                left: thumbX,
                width: thumbW,
                background:
                  "linear-gradient(180deg, #FAF6EC 0%, #DDD4BE 50%, #C9BFA6 100%)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.7), inset 0 -1px 0 rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.12)",
                opacity: scrollbarVisible ? 1 : 0,
                pointerEvents: scrollbarVisible ? "auto" : "none",
              }}
            >
              {/* Knurled grip lines on the thumb */}
              <span
                className="absolute inset-y-1 left-1/2 -translate-x-1/2 flex gap-[1px]"
                style={{ width: 14 }}
              >
                {Array.from({ length: 5 }).map((_, i) => (
                  <span
                    key={i}
                    className="w-[1px] h-full block"
                    style={{ background: "rgba(0,0,0,0.22)" }}
                  />
                ))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- helpers ----

interface DrawVideoLaneArgs {
  ctx: CanvasRenderingContext2D;
  clip: Clip;
  bandTop: number;
  bandH: number;
  canvasWidth: number;
  viewStart: number;
  visibleDur: number;
  img: HTMLImageElement | null;
  aspect: number;
  selected: boolean;
}

function drawVideoLane({
  ctx,
  clip,
  bandTop,
  bandH,
  canvasWidth,
  viewStart,
  visibleDur,
  img,
  aspect,
  selected,
}: DrawVideoLaneArgs) {
  // Lane background — paper-deep, same as canvas BG, so video lanes feel
  // continuous and the audio lane reads as the contrasting band below.
  ctx.fillStyle = "#E8E1D0"; // paper-deep
  ctx.fillRect(0, bandTop, canvasWidth, bandH);

  // Clip range on the master timeline.
  const range = clipRangeS(clip);
  const xStart = ((range.startS - viewStart) / visibleDur) * canvasWidth;
  const xEnd = ((range.endS - viewStart) / visibleDur) * canvasWidth;
  if (xEnd <= 0 || xStart >= canvasWidth) return;
  const pillX = Math.max(0, xStart);
  const pillW = Math.min(canvasWidth, xEnd) - pillX;
  if (pillW <= 0) return;

  // Thumbnails — only inside the clip's pill region. Image clips show a
  // single object-fit:cover preview; video clips show the tiled
  // frame-strip sampled along the clip's source-time.
  if (img && img.width > 0 && img.height > 0) {
    const inset = 4;
    const drawTop = bandTop + inset;
    const drawH = bandH - inset * 2;
    ctx.save();
    roundRectPath(ctx, pillX, bandTop + 2, pillW, bandH - 4, 6);
    ctx.clip();

    if (clip.kind === "image") {
      // object-fit: cover — fill the pill, crop the image to fit
      // the lane height. Repeat horizontally if the pill is wider
      // than one display copy so a long-duration still doesn't end
      // up with awkward empty regions.
      const dispW = drawH * (img.width / img.height);
      if (dispW > 0) {
        for (let x = pillX; x < pillX + pillW; x += dispW) {
          const w = Math.min(dispW, pillX + pillW - x);
          ctx.drawImage(
            img,
            0,
            0,
            (w / dispW) * img.width,
            img.height,
            x,
            drawTop,
            w,
            drawH,
          );
        }
      }
    } else {
      const sourceTileW = img.height * aspect;
      const tilesShown = Math.max(2, Math.round(pillW / TARGET_TILE_W));
      const tileWDest = pillW / tilesShown;
      for (let i = 0; i < tilesShown; i++) {
        const tFrac = (i + 0.5) / tilesShown; // sample mid-tile
        const tInClip = range.startS + tFrac * (range.endS - range.startS);
        const sourceFrac = (tInClip - range.startS) / (range.endS - range.startS);
        const sx = Math.max(0, Math.min(img.width - sourceTileW, sourceFrac * img.width - sourceTileW / 2));
        ctx.drawImage(
          img,
          sx,
          0,
          sourceTileW,
          img.height,
          pillX + i * tileWDest,
          drawTop,
          tileWDest,
          drawH,
        );
      }
    }
    ctx.restore();
  }

  // Pill border + cam-color tint overlay (very subtle so thumbs stay visible).
  ctx.save();
  roundRectPath(ctx, pillX + 0.5, bandTop + 2.5, Math.max(0, pillW - 1), bandH - 5, 6);
  ctx.fillStyle = hexToRgba(clip.color, 0.1);
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? clip.color : hexToRgba(clip.color, 0.6);
  ctx.stroke();
  if (selected) {
    // Inner glow.
    ctx.shadowColor = hexToRgba(clip.color, 0.5);
    ctx.shadowBlur = 6;
    ctx.stroke();
  }
  ctx.restore();

  // Top color stripe — strong cam-color tab so the lane is identifiable
  // even when the pill is compressed.
  ctx.fillStyle = clip.color;
  ctx.fillRect(pillX, bandTop, pillW, 3);

  // Resize grips on both edges — three short vertical bars tucked
  // just inside the pill so the user sees the affordance without
  // needing to hover for the cursor change. Image and video clips
  // both resize (image: durationS / startOffsetS; video: trim in/out).
  if (pillW > 18) {
    ctx.save();
    ctx.fillStyle = "rgba(26,24,22,0.55)";
    const drawGrip = (cx: number) => {
      const gy = bandTop + bandH * 0.5 - 6;
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(cx + i * 2 - 2, gy, 1, 12);
      }
    };
    if (xStart >= 0) drawGrip(Math.max(0, xStart) + 4);
    if (xEnd <= canvasWidth) drawGrip(Math.min(canvasWidth - 1, xEnd) - 4);
    ctx.restore();
  }
}

/** Hardware-fader vertical scrollbar — mirrors the horizontal one's
 *  cassette-aesthetic but rotated 90°. Visible only when the lane
 *  stack overflows. Pointer-drag the thumb to scroll. */
function VerticalFaderThumb({
  scrollTop,
  scrollHeight,
  viewport,
  onScrollTo,
}: {
  scrollTop: number;
  scrollHeight: number;
  viewport: number;
  onScrollTo: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
  const overflows = scrollHeight > viewport + 0.5;
  const thumbH = overflows
    ? Math.max(28, (viewport / scrollHeight) * viewport)
    : 0;
  const trackInnerH = Math.max(0, viewport - thumbH);
  const maxScroll = Math.max(0, scrollHeight - viewport);
  const thumbY = maxScroll > 0 ? (scrollTop / maxScroll) * trackInnerH : 0;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!overflows) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startTop: scrollTop };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || trackInnerH <= 0) return;
    const dy = e.clientY - d.startY;
    const delta = (dy / trackInnerH) * maxScroll;
    onScrollTo(Math.max(0, Math.min(maxScroll, d.startTop + delta)));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  if (!overflows) return null;

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute right-0 top-0"
      style={{
        width: SCROLLBAR_H,
        height: viewport,
        background:
          "linear-gradient(90deg, #C9BFA6 0%, #DDD4BE 50%, #C9BFA6 100%)",
        boxShadow: "inset 1px 0 2px rgba(0,0,0,0.18)",
        touchAction: "none",
      }}
    >
      {/* Tick column for the fader-rail feel */}
      <div className="absolute inset-x-[3px] top-0 bottom-0 flex flex-col items-center justify-between pointer-events-none">
        {Array.from({ length: 16 }).map((_, i) => (
          <span
            key={i}
            className="h-px w-[6px] block"
            style={{ background: "rgba(0,0,0,0.18)" }}
          />
        ))}
      </div>
      {/* Thumb */}
      <div
        className="absolute left-[2px] right-[2px] rounded-sm"
        style={{
          top: thumbY,
          height: thumbH,
          background:
            "linear-gradient(90deg, #FAF6EC 0%, #DDD4BE 50%, #C9BFA6 100%)",
          boxShadow:
            "inset 1px 0 0 rgba(255,255,255,0.7), inset -1px 0 0 rgba(0,0,0,0.15), 1px 0 2px rgba(0,0,0,0.12)",
          cursor: "grab",
        }}
      >
        {/* Knurled grip lines on the thumb (rotated relative to horizontal). */}
        <span
          className="absolute left-1 right-1 top-1/2 -translate-y-1/2 flex flex-col gap-[1px]"
          style={{ height: 14 }}
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <span
              key={i}
              className="h-[1px] w-full block"
              style={{ background: "rgba(0,0,0,0.22)" }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, top: number, h: number) {
  ctx.fillStyle = "#1A1816";
  ctx.fillRect(x - 1, top, 2, h);
  ctx.fillRect(x - 6, top, 12, 8);
  ctx.fillRect(x - 6, top + h - 8, 12, 8);
  ctx.fillStyle = "#F2EDE2";
  ctx.fillRect(x - 1, top + 2, 2, 4);
  ctx.fillRect(x - 1, top + h - 6, 2, 4);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface DrawMatchMarkersArgs {
  ctx: CanvasRenderingContext2D;
  clip: Clip;
  bandTop: number;
  bandH: number;
  viewStart: number;
  visibleDur: number;
  canvasWidth: number;
  emphasized: boolean;
}

/** Render small ticks at each candidate-implied start position. The
 *  active candidate is rendered as a chunky filled triangle, alternates
 *  as thinner ticks fading out with confidence. In MATCH mode the alts
 *  brighten so the user can aim at them while dragging. Image clips have
 *  no candidates → early-out. */
function drawMatchMarkers({
  ctx,
  clip,
  bandTop,
  bandH,
  viewStart,
  visibleDur,
  canvasWidth,
  emphasized,
}: DrawMatchMarkersArgs) {
  if (!isVideoClip(clip)) return;
  if (!clip.candidates || clip.candidates.length === 0) return;
  ctx.save();
  for (let i = 0; i < clip.candidates.length; i++) {
    const c = clip.candidates[i];
    const totalMs = c.offsetMs + clip.syncOverrideMs;
    // Match position is fixed in master-timeline space: the absolute spot
    // where master audio correlates with cam audio. Do NOT add startOffsetS
    // — that would make markers slide with the lane drag and lose their
    // meaning (the user couldn't snap a dragged lane onto its match point).
    const startS = -totalMs / 1000;
    const x = ((startS - viewStart) / visibleDur) * canvasWidth;
    if (x < -8 || x > canvasWidth + 8) continue;
    const isPrimary = i === clip.selectedCandidateIdx;
    const conf = Math.max(0, Math.min(1, c.confidence));
    const baseOpacity = (isPrimary ? 1 : 0.35) * (emphasized ? 1 : 0.55);
    const opacity = baseOpacity * (0.4 + 0.6 * conf);
    const tickW = isPrimary ? 3 : 2;
    const tickH = isPrimary ? bandH - 6 : Math.round(bandH * 0.45);
    ctx.fillStyle = `rgba(255,87,34,${opacity})`; // hot
    ctx.fillRect(Math.floor(x), bandTop + 2, tickW, tickH);
    if (isPrimary) {
      // Filled inverted triangle on top to mark the active alignment.
      ctx.beginPath();
      ctx.moveTo(x - 4, bandTop);
      ctx.lineTo(x + 4, bandTop);
      ctx.lineTo(x, bandTop + 6);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Big "currently snapped to" readout that lights up only while a
 *  clip-move drag is active in MATCH mode. Mirrors the heatmap colour
 *  used by the markers themselves so the user can correlate them, and
 *  shows the percentage in big LCD-ish digits so they can decide
 *  whether to commit or keep dragging without staring at tiny numbers
 *  on the strip. */
function ActiveMatchReadout({
  camId,
  snapMode,
  clips,
}: {
  camId: string | null;
  snapMode: SnapMode;
  clips: Clip[];
}) {
  if (!camId || snapMode !== "match") return null;
  const found = clips.find((c) => c.id === camId);
  if (!found || !isVideoClip(found)) return null;
  const clip = found;
  if (clip.candidates.length === 0) return null;
  const cand = clip.candidates[clip.selectedCandidateIdx];
  if (!cand) return null;
  const conf = Math.max(0, Math.min(1, cand.confidence));
  const hue = Math.pow(conf, 2.2) * 135;
  const sat = 70 + 25 * conf;
  const light = 38 + 18 * conf;
  const color = `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
  const pct = Math.round(conf * 100);
  return (
    <div
      className="flex flex-col items-start"
      style={{
        background: "linear-gradient(180deg, #1A1612 0%, #0E0B08 100%)",
        boxShadow: [
          "inset 0 1px 0 rgba(255,255,255,0.08)",
          "inset 0 -1px 0 rgba(0,0,0,0.5)",
          "inset 0 0 12px rgba(0,0,0,0.55)",
          "0 1px 0 rgba(255,255,255,0.5)",
        ].join(", "),
        borderRadius: 6,
        padding: "3px 10px 4px",
        minWidth: 86,
      }}
    >
      <span
        className="font-display text-[8px] tracking-[0.2em] uppercase leading-none"
        style={{ color: "rgba(255,255,255,0.55)" }}
      >
        MATCH
      </span>
      <div className="flex items-baseline gap-1">
        <span
          className="font-mono tabular leading-none"
          style={{
            color,
            textShadow: `0 0 6px ${color}`,
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          {pct}
        </span>
        <span
          className="font-mono leading-none"
          style={{
            color: "rgba(255,255,255,0.5)",
            fontSize: 10,
          }}
        >
          %
        </span>
      </div>
    </div>
  );
}

/**
 * One-row, ~22-px-tall timeline header for phone-sized viewports.
 *
 * Replaces the full BPM bezel + cassette snap-key plate + labelled
 * BOTH/CUTS/FX segmented control + view-range readout that wraps onto
 * 3 rows on a Galaxy-Fold-folded screen. Same store surface (snap
 * mode, strip mode, lock toggle) but stripped of every label,
 * stencil and bezel — every interaction is a single tap on a small
 * pill. BPM/SIG are render-only here (rare on mobile; users edit on
 * desktop or via the SidePanel sync tab).
 */
const MOBILE_SNAP_MODES: { mode: SnapMode; label: string }[] = [
  { mode: "off", label: "·" },
  { mode: "match", label: "M" },
  { mode: "1", label: "1" },
  { mode: "1/2", label: "½" },
  { mode: "1/4", label: "¼" },
  { mode: "1/8", label: "⅛" },
  { mode: "1/16", label: "16" },
];

function MobileTimelineHeader({ zoomPercent }: { zoomPercent: number }) {
  const bpm = useEditorStore((s) => s.jobMeta?.bpm?.value);
  const sig = useEditorStore((s) => effectiveBeatsPerBar(s.jobMeta));
  const snapMode = useEditorStore((s) => s.ui.snapMode);
  const setSnapMode = useEditorStore((s) => s.setSnapMode);
  const programStripMode = useEditorStore((s) => s.ui.programStripMode);
  const setProgramStripMode = useEditorStore((s) => s.setProgramStripMode);
  const lanesLocked = useEditorStore((s) => s.ui.lanesLocked);
  const setLanesLocked = useEditorStore((s) => s.setLanesLocked);
  const hasBpm = useEditorStore((s) => Boolean(s.jobMeta?.bpm));

  const stripBtn = (
    label: string,
    value: typeof programStripMode,
    title: string,
  ) => {
    const active = programStripMode === value;
    return (
      <button
        key={value}
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={active}
        onClick={() => setProgramStripMode(value)}
        className={[
          "h-5 w-5 rounded-[3px] flex items-center justify-center font-display text-[9px] tracking-label uppercase border border-black/30",
          active
            ? "bg-ink text-paper-hi"
            : "bg-paper-hi text-ink-2",
        ].join(" ")}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="w-full flex items-center gap-1 px-0.5 mb-1 text-[10px]">
      {/* BPM · SIG — read-only on mobile. Tappable hit-area can land
       *  here in a future pass; for now the auto-detected BPM is
       *  almost always right and editing happens on desktop. */}
      <span
        className="shrink-0 font-mono tabular text-ink-2"
        style={{ fontSize: 10 }}
        title="BPM · time signature (edit on a wider viewport)"
      >
        {bpm ? Math.round(bpm) : "—"}·{sig}/4
      </span>

      {/* Snap-mode mini strip — horizontal-scrollable so all 7 fit on
       *  a 280-px screen. No LED, no stencil — just the divisions. */}
      <div
        className="flex items-center gap-0.5 overflow-x-auto no-native-scrollbar shrink min-w-0"
        role="group"
        aria-label="Snap mode"
      >
        {MOBILE_SNAP_MODES.map(({ mode, label }) => {
          const active = snapMode === mode;
          const disabled = mode !== "off" && mode !== "match" && !hasBpm;
          return (
            <button
              key={mode}
              type="button"
              title={`Snap: ${mode}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => setSnapMode(mode)}
              className={[
                "h-5 min-w-[18px] px-1 rounded-[3px] flex items-center justify-center",
                "font-mono text-[9px] tracking-tight border border-black/30 shrink-0",
                "disabled:opacity-30",
                active
                  ? "bg-ink text-paper-hi"
                  : "bg-paper-hi text-ink-2",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Strip-mode (BOTH/CUTS/FX) → single icons B / C / F. */}
      <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Program strip mode">
        {stripBtn("B", "both", "Show cuts and FX")}
        {stripBtn("C", "cuts", "Show cuts only")}
        {stripBtn("F", "fx", "Show FX only")}
      </div>

      {/* Lock toggle — same role as the cassette LOCK key on desktop. */}
      <button
        type="button"
        aria-label={lanesLocked ? "Unlock lanes" : "Lock lanes"}
        title={lanesLocked ? "Lanes locked — tap to drag clips" : "Lanes unlocked — tap to lock"}
        onClick={() => setLanesLocked(!lanesLocked)}
        className={[
          "h-5 w-5 rounded-[3px] flex items-center justify-center text-[10px] leading-none",
          "border border-black/30 shrink-0",
          lanesLocked ? "bg-paper-hi text-ink-2" : "bg-ink text-paper-hi",
        ].join(" ")}
      >
        {lanesLocked ? "🔒" : "🔓"}
      </button>

      <span className="ml-auto shrink-0 font-mono tabular text-ink-3" style={{ fontSize: 10 }}>
        {zoomPercent}%
      </span>
    </div>
  );
}
