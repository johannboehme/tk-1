// Transport row with chunky play/pause + frame steppers + time readouts. Keyboard-aware.
import { useEffect } from "react";
import { useEditorStore } from "../store";
import { effectiveAudioStartS } from "../selectors/timing";
import {
  classifyIOTarget,
  imageInAtPlayhead,
  imageOutAtPlayhead,
  videoSourceTimeAtPlayhead,
} from "../io-points";
import {
  arrToMaster,
  masterToArr,
  totalArrDuration,
} from "../arrangement-time";
import { useRegisterShortcut } from "../shortcuts/useRegisterShortcut";
import { useIsNarrowViewport } from "../use-is-narrow";
import { ChunkyButton } from "./ChunkyButton";
import { TransportClock } from "./TransportClock";
import {
  ArrowKeysIcon,
  AudioStartIcon,
  InIcon,
  LoopIcon,
  OutIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
  StepBackIcon,
  StepFwdIcon,
} from "./icons";

type IOContextKind = "loop" | "video" | "image" | "master";

function ioInDescription(k: IOContextKind): string {
  switch (k) {
    case "loop":
      return "Set loop in-point at the playhead";
    case "video":
    case "image":
      return "Set clip in-point at the playhead";
    case "master":
      return "Set in-point at the playhead";
  }
}
function ioOutDescription(k: IOContextKind): string {
  switch (k) {
    case "loop":
      return "Set loop out-point at the playhead";
    case "video":
    case "image":
      return "Set clip out-point at the playhead";
    case "master":
      return "Set out-point at the playhead";
  }
}

export function TransportBar() {
  const meta = useEditorStore((s) => s.jobMeta);
  const isPlaying = useEditorStore((s) => s.playback.isPlaying);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  // Don't subscribe to currentTime here — it changes 60×/sec while
  // playing and would re-render this whole bar (and re-bind the
  // keyboard listener via the useEffect deps). All consumers below are
  // click/keyboard handlers; they read the current value imperatively
  // via getState() at the moment of the action.
  const trim = useEditorStore((s) => s.trim);
  const setTrim = useEditorStore((s) => s.setTrim);
  const loop = useEditorStore((s) => s.playback.loop);
  const setLoop = useEditorStore((s) => s.setLoop);
  const seek = useEditorStore((s) => s.seek);
  const stepByActiveSnap = useEditorStore((s) => s.stepByActiveSnap);
  const shiftLoop = useEditorStore((s) => s.shiftLoop);
  // Per-clip trim/placement actions: I/O routes here when a video or
  // image clip is selected. Same store actions the move-mode drag
  // handles call, so behavior + clamps stay identical.
  const setVideoClipTrim = useEditorStore((s) => s.setVideoClipTrim);
  const setImageClipDuration = useEditorStore((s) => s.setImageClipDuration);
  const setClipStartOffset = useEditorStore((s) => s.setClipStartOffset);
  // Read-only subscriptions to drive aria-labels + shortcut hints.
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const ioContextKind = useEditorStore((s) => {
    if (s.playback.loop) return "loop" as const;
    if (s.selectedClipId === null) return "master" as const;
    const clip = s.clips.find((c) => c.id === s.selectedClipId);
    if (!clip) return "master" as const;
    return clip.kind === "image" ? ("image" as const) : ("video" as const);
  });
  // Phone-sized viewports get an aggressively compacted transport bar:
  // every transport stepper + Play + IN/OUT/LOOP collapses to xs
  // (h-8 ≈ 28 px wide icon-only, no min-w) so the entire 8-button
  // block fits on ONE row at 280 px — vs the 2 we landed at last pass
  // and the 4 the original design produced. Play keeps its primary
  // (hot-orange) variant so it still reads as the main affordance
  // even at the same physical size as the steppers.
  const isNarrow = useIsNarrowViewport();
  const btnSize = isNarrow ? "xs" : "md";
  const playSize = isNarrow ? "xs" : "lg";
  const trimSize = isNarrow ? "xs" : "sm";

  const fps = meta?.fps && meta.fps > 0 ? meta.fps : 30;
  const duration = meta?.duration ?? 0;
  // Visibility gates on the raw value: if the file is non-silent throughout
  // we have nothing meaningful to jump to. The seek target itself uses the
  // user-corrected (effective) start.
  const audioStartS = meta?.audioStartS ?? 0;
  const arrSegments = useEditorStore((s) => s.arrangementSegments);
  const effectiveStart = effectiveAudioStartS(meta);
  // Skip-to-in / skip-to-out land on the master-time trim window — same
  // contract regardless of whether the job has one synthetic segment
  // (single-take) or many (long-form). seek() takes master-time so this
  // passes through unchanged.
  const seekStartS = trim.in;
  // Step a hair before the very end so the audio walker keeps the last
  // sample audible — landing exactly on trim.out trips the "past-last-
  // segment → pause" branch instantly.
  const seekEndS = Math.max(trim.in, trim.out - 1 / Math.max(1, fps));

  function step(deltaSec: number) {
    const t = useEditorStore.getState().playback.currentTime;
    // Stepping always honours segment boundaries — `arrSegments` is
    // populated for every job, so the round-trip through arr-time is
    // Identity for single-take and snaps to chunk-edges for long-form.
    const arrNow = masterToArr(t, arrSegments);
    const total = totalArrDuration(arrSegments);
    const arrNext = Math.max(0, Math.min(total, arrNow + deltaSec));
    seek(arrToMaster(arrNext, arrSegments));
  }

  // IN/OUT semantics are contextual:
  //   loop active           → edit the loop boundaries
  //   video clip selected   → edit that clip's source-trim (clamped to
  //                            [0, sourceDurationS] by the store action)
  //   image clip selected   → edit that clip's master-pill edges
  //                            (mirror of the move-mode drag handles)
  //   else                  → edit master trim (export region)
  // Same logic for buttons and keyboard shortcuts.
  function setInPointAtPlayhead() {
    const s = useEditorStore.getState();
    const t = s.playback.currentTime;
    const target = classifyIOTarget({
      loop,
      selectedClipId: s.selectedClipId,
      clips: s.clips,
    });
    switch (target.kind) {
      case "loop": {
        // Loop lives in arr-time on the composed timeline. Anchor on the
        // AUTHORITATIVE arr-playhead (`timelineT`), NOT `masterToArr(t)` —
        // a master-time scan snaps onto the first occurrence of a repeated
        // chunk, so the loop edge would jump to the wrong occurrence.
        const newStart = s.playback.timelineT;
        const newEnd = Math.max(loop!.end, newStart + 1 / fps);
        setLoop({ start: newStart, end: newEnd });
        return;
      }
      case "video": {
        const sourceT = videoSourceTimeAtPlayhead(target.clip, t);
        const outS = target.clip.trimOutS ?? target.clip.sourceDurationS;
        setVideoClipTrim(target.clip.id, sourceT, outS);
        return;
      }
      case "image": {
        const next = imageInAtPlayhead(target.clip, t);
        setClipStartOffset(target.clip.id, next.startOffsetS);
        setImageClipDuration(target.clip.id, next.durationS);
        return;
      }
      case "master":
        setTrim({ in: t, out: trim.out });
        return;
    }
  }
  function setOutPointAtPlayhead() {
    const s = useEditorStore.getState();
    const t = s.playback.currentTime;
    const target = classifyIOTarget({
      loop,
      selectedClipId: s.selectedClipId,
      clips: s.clips,
    });
    switch (target.kind) {
      case "loop": {
        // Authoritative arr-playhead — see setInPointAtPlayhead's loop case.
        const newEnd = s.playback.timelineT;
        const newStart = Math.min(loop!.start, newEnd - 1 / fps);
        setLoop({ start: newStart, end: newEnd });
        return;
      }
      case "video": {
        const sourceT = videoSourceTimeAtPlayhead(target.clip, t);
        const inS = target.clip.trimInS ?? 0;
        setVideoClipTrim(target.clip.id, inS, sourceT);
        return;
      }
      case "image": {
        setImageClipDuration(target.clip.id, imageOutAtPlayhead(target.clip, t));
        return;
      }
      case "master":
        setTrim({ in: trim.in, out: t });
        return;
    }
  }

  function toggleLoop() {
    if (loop) {
      setLoop(null);
      return;
    }
    // Anchor on the COMPOSED timeline (the user's tape) at the AUTHORITATIVE
    // arr-playhead (`timelineT`). Using `masterToArr(currentTime)` would scan
    // for the first segment whose master range contains the playhead and snap
    // onto the FIRST occurrence of a repeated chunk — so in long-form the loop
    // would land on the wrong occurrence (markers + audio jump away from where
    // the user pressed). Clamp to the playable arr-window so a fresh-open
    // playhead doesn't propose a region `setLoop` would clamp to null.
    const t_arr = useEditorStore.getState().playback.timelineT;
    const hi = totalArrDuration(arrSegments);
    const start = Math.max(0, Math.min(hi - 1 / fps, t_arr));
    const end = Math.min(hi, start + 2);
    setLoop({ start, end });
  }

  // Keyboard shortcuts (skip when an input/textarea is focused)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      // ignore if a knob is focused (it has its own handler)
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.dataset?.knob) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlaying(!isPlaying);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.altKey) shiftLoop(-1);
          else stepByActiveSnap(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.altKey) shiftLoop(1);
          else stepByActiveSnap(1);
          break;
        case "i":
        case "I":
          e.preventDefault();
          setInPointAtPlayhead();
          break;
        case "o":
        case "O":
          e.preventDefault();
          setOutPointAtPlayhead();
          break;
        case "l":
        case "L":
          e.preventDefault();
          toggleLoop();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    fps,
    duration,
    isPlaying,
    loop,
    setPlaying,
    setLoop,
    setTrim,
    setVideoClipTrim,
    setImageClipDuration,
    setClipStartOffset,
    selectedClipId,
    trim.in,
    trim.out,
    stepByActiveSnap,
    shiftLoop,
    arrSegments,
  ]);

  useRegisterShortcut({
    id: "transport.playpause",
    keys: ["Space"],
    description: "Play / pause",
    group: "Transport",
    icon: <PlayIcon />,
  });
  useRegisterShortcut({
    id: "transport.framestep",
    keys: ["←", "→"],
    description: "Step by snap target (frame, beat, bar, or match-point)",
    group: "Transport",
    icon: <ArrowKeysIcon />,
  });
  useRegisterShortcut({
    id: "transport.loopshift",
    keys: ["⌥←", "⌥→"],
    description: "Shift loop region by its length (OP-1 style; playback continues)",
    group: "Transport",
    icon: <LoopIcon />,
  });
  useRegisterShortcut({
    id: "transport.in",
    keys: ["I"],
    description: ioInDescription(ioContextKind),
    group: "Transport",
    icon: <InIcon />,
  });
  useRegisterShortcut({
    id: "transport.out",
    keys: ["O"],
    description: ioOutDescription(ioContextKind),
    group: "Transport",
    icon: <OutIcon />,
  });
  useRegisterShortcut({
    id: "transport.loop",
    keys: ["L"],
    description: loop
      ? "Disable loop"
      : "Loop a 2-second region from the playhead",
    group: "Transport",
    icon: <LoopIcon />,
  });

  return (
    // Mobile flattens the two button groups into a single flex row
    // (no nested wrappers, no inter-group gap) so all 8 icons fit on
    // ONE row at 280 px. Desktop keeps the wider gap + divider between
    // transport and IN/OUT/LOOP groups via the wrapper structure
    // below.
    <div
      className={
        isNarrow
          ? "flex items-center gap-0.5"
          : "flex items-center gap-x-3 gap-y-2 flex-wrap"
      }
    >
      <div className={`flex items-center ${isNarrow ? "contents" : "flex-wrap gap-1"}`}>
        <ChunkyButton
          variant="secondary"
          size={btnSize}
          onClick={() => seek(seekStartS)}
          aria-label="Jump to in point"
        >
          <SkipBackIcon />
        </ChunkyButton>
        {audioStartS > 0 && !isNarrow && (
          <ChunkyButton
            variant="secondary"
            size={btnSize}
            onClick={() => seek(effectiveStart)}
            aria-label="Jump to audio start"
          >
            <AudioStartIcon />
          </ChunkyButton>
        )}
        <ChunkyButton
          variant="secondary"
          size={btnSize}
          onClick={() => step(-1 / fps)}
          aria-label="Previous frame"
        >
          <StepBackIcon />
        </ChunkyButton>
        <ChunkyButton
          variant="primary"
          size={playSize}
          onClick={() => setPlaying(!isPlaying)}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <PauseIcon width={isNarrow ? 16 : 20} height={isNarrow ? 16 : 20} />
          ) : (
            <PlayIcon width={isNarrow ? 16 : 20} height={isNarrow ? 16 : 20} />
          )}
        </ChunkyButton>
        <ChunkyButton
          variant="secondary"
          size={btnSize}
          onClick={() => step(1 / fps)}
          aria-label="Next frame"
        >
          <StepFwdIcon />
        </ChunkyButton>
        <ChunkyButton
          variant="secondary"
          size={btnSize}
          onClick={() => seek(seekEndS)}
          aria-label="Jump to out point"
        >
          <SkipFwdIcon />
        </ChunkyButton>
      </div>

      {/* The vertical divider is meaningful only when both groups sit
       *  on the same row visually distinct; on narrow widths we drop
       *  it (along with the wrapper structure) so all 8 buttons sit
       *  in one flat flex row. */}
      <div className="hidden sm:block h-8 w-px bg-rule mx-1" />

      <div className={`flex items-center ${isNarrow ? "contents" : "flex-wrap gap-1"}`}>
        <ChunkyButton
          variant="secondary"
          size={trimSize}
          onClick={setInPointAtPlayhead}
          iconLeft={<InIcon />}
          aria-label={ioInDescription(ioContextKind)}
        >
          {!isNarrow && "IN"}
        </ChunkyButton>
        <ChunkyButton
          variant="secondary"
          size={trimSize}
          onClick={setOutPointAtPlayhead}
          iconLeft={<OutIcon />}
          aria-label={ioOutDescription(ioContextKind)}
        >
          {!isNarrow && "OUT"}
        </ChunkyButton>
        <ChunkyButton
          variant={loop ? "primary" : "secondary"}
          pressed={!!loop}
          size={trimSize}
          onClick={toggleLoop}
          iconLeft={<LoopIcon />}
          aria-label={loop ? "Disable loop" : "Loop a 2-second region from the playhead"}
        >
          {!isNarrow && "LOOP"}
        </ChunkyButton>
      </div>

      {/* Clock: hidden on phones — the timeline ruler shows the same
       *  master time, and the bezel here was eating an entire row.
       *  Desktop still floats it to the right of the IN/OUT/LOOP group. */}
      {!isNarrow && <TransportClock className="sm:ml-auto" />}
    </div>
  );
}
