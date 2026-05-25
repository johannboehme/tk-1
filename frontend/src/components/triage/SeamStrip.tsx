/**
 * Seam-preview editor — the bottom timeline morphs into this when the
 * user auditions a transition. Two stacked lanes, each its own little
 * timeline (bar ruler + waveform) for one chunk near the cut:
 *
 *     lane A:  [ bar ruler ]            loopIn ┊  ···A···  ┊ A.end
 *     lane B:  [ bar ruler ]      B.start ┊  ···B···  ┊ loopOut
 *
 * Each lane zooms (wheel) + pans (shift-wheel / trackpad-x) like the main
 * Triage timeline, but its view is CLAMPED to that chunk's own region
 * (± a couple bars) — you can't zoom/scroll out into the neighbouring
 * chunks, because the lanes aren't a continuous timeline. The view scale
 * is independent of the handles: dragging a handle moves only that handle,
 * the waveform stays put. Click a lane to set the playhead (snapped).
 * Four snap-aware handles: A.end / B.start are real chunk trims
 * (persisted); loopIn / loopOut are the ephemeral audition brackets.
 *
 * The engine (useTriageAudio seam branch) loops [loopIn→A.end]→[B.start→
 * loopOut] gaplessly and derives which lane is sounding from the playhead.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  chunkBeatPhaseS,
  effectiveChunkBpm,
  useTriageStore,
} from "../../local/triage/triage-store";
import { snapTime } from "../../editor/snap";
import type { Chunk } from "../../storage/jobs-db";
import { buildMips, drawEnvelopeWindow } from "./timeline-waveform";

const HOT = "#FF5722";
const BRASS = "#C9A95A";
const HEADER_H = 18;
const RULER_H = 16;
const LANE_GAP = 2;
const DEFAULT_VIEW_BARS = 6;
const MAX_VIEW_BARS = 16;
const MARGIN_BARS = 2;

type HandleKind = "loopIn" | "aEnd" | "bStart" | "loopOut";

export function SeamStrip() {
  const seam = useTriageStore((s) => s.playback.seam);
  const chunks = useTriageStore((s) => s.chunks);
  const snapMode = useTriageStore((s) => s.snapMode);
  const jobBpm = useTriageStore((s) => s.jobBpm?.value ?? null);
  const beatsPerBar = useTriageStore((s) => s.beatsPerBar);
  const envelope = useTriageStore((s) => s.envelope);
  const envelopeHz = useTriageStore((s) => s.envelopeHz);
  const audioDuration = useTriageStore((s) => s.audioDuration);
  const currentTime = useTriageStore((s) => s.playback.currentTime);
  const updateSeam = useTriageStore((s) => s.updateSeam);
  const updateChunk = useTriageStore((s) => s.updateChunk);
  const closeSeam = useTriageStore((s) => s.closeSeam);
  const seek = useTriageStore((s) => s.seek);

  const { mips, peak } = useMemo(() => buildMips(envelope), [envelope]);

  const a = seam ? chunks.find((c) => c.id === seam.aId) ?? null : null;
  const b = seam?.bId ? chunks.find((c) => c.id === seam.bId) ?? null : null;

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(188);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setWidth(Math.max(200, e.contentRect.width));
        setHeight(Math.max(120, e.contentRect.height));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!seam || !a) return null;

  const laneH = Math.max(36, (height - HEADER_H - LANE_GAP) / 2 - RULER_H);
  const laneBlockH = RULER_H + laneH;
  const laneATop = HEADER_H;
  const laneBTop = HEADER_H + laneBlockH + LANE_GAP;

  function applyHandle(kind: HandleKind, tS: number) {
    if (!a) return;
    if (kind === "loopIn") {
      updateSeam({
        loopInS: Math.max(a.startMs / 1000, Math.min(a.endMs / 1000 - 0.02, tS)),
      });
    } else if (kind === "aEnd") {
      const ms = Math.round(
        Math.max(a.startMs + 100, Math.min(audioDuration * 1000, tS * 1000)),
      );
      if (ms !== a.endMs) updateChunk(a.id, { endMs: ms, trimMode: "free" });
    } else if (kind === "bStart" && b) {
      const ms = Math.round(Math.max(0, Math.min(b.endMs - 100, tS * 1000)));
      if (ms !== b.startMs) updateChunk(b.id, { startMs: ms, trimMode: "free" });
    } else if (kind === "loopOut" && b) {
      updateSeam({
        loopOutS: Math.max(
          b.startMs / 1000 + 0.02,
          Math.min(b.endMs / 1000, tS),
        ),
      });
    }
  }

  const aHandles: LaneHandle[] = [
    { kind: "loopIn", timeS: seam.loopInS, color: BRASS, label: "in" },
    { kind: "aEnd", timeS: a.endMs / 1000, color: HOT, label: "A" },
  ];
  const bHandles: LaneHandle[] = b
    ? [
        { kind: "bStart", timeS: b.startMs / 1000, color: HOT, label: "B" },
        { kind: "loopOut", timeS: seam.loopOutS, color: BRASS, label: "out" },
      ]
    : [];

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full bg-paper-hi border border-rule rounded-md overflow-hidden select-none"
    >
      {/* Header */}
      <div
        className="absolute left-0 right-0 top-0 flex items-center justify-between px-2 bg-paper-deep border-b border-rule"
        style={{ height: HEADER_H }}
      >
        <span className="font-display tracking-label uppercase text-[9px] text-ink-2">
          Seam · transition preview {b ? "" : "· pick B"}
        </span>
        <button
          type="button"
          onClick={() => closeSeam()}
          className="font-mono text-[9px] tracking-label uppercase text-ink-3 hover:text-ink px-1"
          title="Close seam preview · Esc"
        >
          ✕ esc
        </button>
      </div>

      <SeamLane
        role="A"
        chunk={a}
        centerS={a.endMs / 1000}
        top={laneATop}
        width={width}
        rulerH={RULER_H}
        laneH={laneH}
        mips={mips}
        peak={peak}
        envelopeHz={envelopeHz}
        jobBpm={jobBpm}
        beatsPerBar={beatsPerBar}
        snapMode={snapMode}
        handles={aHandles}
        playheadS={currentTime}
        onSeek={seek}
        onHandle={applyHandle}
      />

      {b ? (
        <SeamLane
          role="B"
          chunk={b}
          centerS={b.startMs / 1000}
          top={laneBTop}
          width={width}
          rulerH={RULER_H}
          laneH={laneH}
          mips={mips}
          peak={peak}
          envelopeHz={envelopeHz}
          jobBpm={jobBpm}
          beatsPerBar={beatsPerBar}
          snapMode={snapMode}
          handles={bHandles}
          playheadS={currentTime}
          onSeek={seek}
          onHandle={applyHandle}
        />
      ) : (
        <div
          className="absolute flex items-center justify-center text-center px-3 bg-paper-deep border border-dashed border-rule rounded-sm"
          style={{ top: laneBTop, left: 0, width, height: laneBlockH }}
        >
          <span className="font-mono text-[10px] tracking-label uppercase text-ink-3">
            ◇ click a chunk in the list to set seam B
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Lane ────────────────────────────────────────────────────────────────

interface LaneHandle {
  kind: HandleKind;
  timeS: number;
  color: string;
  label: string;
}

interface SeamLaneProps {
  role: "A" | "B";
  chunk: Chunk;
  /** Master-time the view is initially centred on (A.end or B.start). */
  centerS: number;
  top: number;
  width: number;
  rulerH: number;
  laneH: number;
  mips: Float32Array[];
  peak: number;
  envelopeHz: number;
  jobBpm: number | null;
  beatsPerBar: number;
  snapMode: ReturnType<typeof useTriageStore.getState>["snapMode"];
  handles: LaneHandle[];
  playheadS: number;
  onSeek: (tS: number) => void;
  onHandle: (kind: HandleKind, tS: number) => void;
}

function SeamLane({
  role,
  chunk,
  centerS,
  top,
  width,
  rulerH,
  laneH,
  mips,
  peak,
  envelopeHz,
  jobBpm,
  beatsPerBar,
  snapMode,
  handles,
  playheadS,
  onSeek,
  onHandle,
}: SeamLaneProps) {
  const bpm = effectiveChunkBpm(chunk, jobBpm);
  const barS = bpm > 0 ? (60 / bpm) * beatsPerBar : 0;

  // Own view + bounds, FROZEN when the chunk identity changes — never
  // recomputed from the live chunk. So trimming A.end / B.start moves the
  // handle within a stable window instead of scrolling the waveform, and
  // you can't zoom/scroll out past this chunk's own region (± a couple
  // bars) into the neighbouring chunks (the lanes aren't a continuous
  // timeline). Outward extension beyond the margin is still reachable —
  // the handle clamps to the edge and re-opening re-frames.
  const [view, setView] = useState(() => initView(chunk, centerS, barS));
  useEffect(() => {
    setView(initView(chunk, centerS, barS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk.id]);

  const maxSpanS = Math.min(
    view.boundEndS - view.boundStartS,
    barS > 0 ? barS * MAX_VIEW_BARS : 20,
  );
  const minSpanS = Math.min(maxSpanS, barS > 0 ? barS / 4 : 0.2);
  const spanS = clamp(view.spanS, minSpanS, maxSpanS);
  const startS = clamp(
    view.startS,
    view.boundStartS,
    Math.max(view.boundStartS, view.boundEndS - spanS),
  );
  const winEndS = startS + spanS;
  const pxPerSec = spanS > 0 ? width / spanS : 1;
  const timeToX = (tS: number) => (tS - startS) * pxPerSec;

  const surfaceRef = useRef<HTMLDivElement | null>(null);

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const panS = ((e.deltaX || e.deltaY) / pxPerSec) * 0.5;
      setView((v) => ({
        ...v,
        startS: clamp(v.startS + panS, v.boundStartS, v.boundEndS - spanS),
      }));
      return;
    }
    const rect = surfaceRef.current?.getBoundingClientRect();
    const cursorX = rect ? e.clientX - rect.left : width / 2;
    const cursorT = startS + cursorX / pxPerSec;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const nextSpan = clamp(v.spanS * factor, minSpanS, maxSpanS);
      const nextStart = clamp(
        cursorT - (cursorX / width) * nextSpan,
        v.boundStartS,
        v.boundEndS - nextSpan,
      );
      return { ...v, startS: nextStart, spanS: nextSpan };
    });
  }

  // Waveform.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(laneH * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${laneH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, laneH);
    drawEnvelopeWindow(ctx, {
      mips,
      envelopeHz,
      peak,
      t0S: startS,
      t1S: winEndS,
      w: width,
      h: laneH,
    });
  }, [mips, peak, envelopeHz, startS, winEndS, width, laneH]);

  const ticks = useMemo(
    () => barTicks(chunk, jobBpm, beatsPerBar, startS, winEndS, pxPerSec),
    [chunk, jobBpm, beatsPerBar, startS, winEndS, pxPerSec],
  );

  // Pointer interaction: background = seek-scrub, handle = trim/bracket.
  const dragRef = useRef<HandleKind | "seek" | null>(null);
  useEffect(() => {
    function snap(tS: number, shift: boolean): number {
      if (shift || snapMode === "off" || bpm <= 0) return tS;
      return snapTime(tS, snapMode, {
        bpm,
        beatPhase: chunkBeatPhaseS(chunk),
        beatsPerBar,
      });
    }
    function timeFromClientX(clientX: number): number {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const x = rect ? clientX - rect.left : 0;
      return startS + x / pxPerSec;
    }
    function onMove(ev: MouseEvent) {
      const kind = dragRef.current;
      if (!kind) return;
      const tS = snap(timeFromClientX(ev.clientX), ev.shiftKey);
      if (kind === "seek") onSeek(Math.max(0, tS));
      else onHandle(kind, tS);
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
  }, [chunk, bpm, beatsPerBar, snapMode, pxPerSec, startS, onSeek, onHandle]);

  const playheadX =
    playheadS >= startS && playheadS <= winEndS ? timeToX(playheadS) : null;

  return (
    <div className="absolute left-0" style={{ top, width }}>
      {/* Bar ruler */}
      <div
        className="relative bg-paper-deep border-b border-rule overflow-hidden"
        style={{ height: rulerH }}
      >
        {ticks.map((tk, i) => {
          const x = timeToX(tk.tS);
          return (
            <span key={i}>
              <span
                className="absolute bottom-0"
                style={{
                  left: x,
                  width: tk.downbeat ? 1.5 : 1,
                  height: tk.downbeat ? "70%" : "35%",
                  background: tk.downbeat ? HOT : "#FF572266",
                  marginLeft: tk.downbeat ? -0.75 : -0.5,
                }}
              />
              {tk.downbeat && tk.bar != null && (
                <span
                  className="absolute font-display tracking-label uppercase tabular leading-none"
                  style={{ left: x + 2, top: 2, fontSize: 8, color: "#7A5E1F" }}
                >
                  {tk.bar}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* Waveform + interaction surface */}
      <div
        ref={surfaceRef}
        className="relative overflow-hidden cursor-text"
        style={{
          height: laneH,
          background: "rgba(0,0,0,0.04)",
          boxShadow: "inset 0 1px 3px rgba(0,0,0,0.10)",
        }}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).dataset.seamHandle) return;
          dragRef.current = "seek";
          const rect = surfaceRef.current?.getBoundingClientRect();
          const x = rect ? e.clientX - rect.left : 0;
          const raw = startS + x / pxPerSec;
          const snapped =
            e.shiftKey || snapMode === "off" || bpm <= 0
              ? raw
              : snapTime(raw, snapMode, {
                  bpm,
                  beatPhase: chunkBeatPhaseS(chunk),
                  beatsPerBar,
                });
          onSeek(Math.max(0, snapped));
        }}
      >
        <canvas ref={canvasRef} className="pointer-events-none" />
        <span className="absolute left-1 top-0.5 font-display tracking-label uppercase text-[8px] text-ink-3 pointer-events-none">
          {role === "A" ? "A · out" : "B · in"}
        </span>

        {playheadX != null && (
          <span
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: playheadX,
              width: 2,
              background: HOT,
              boxShadow: "0 0 4px rgba(255,87,34,0.6)",
            }}
          />
        )}

        {handles.map((h) => {
          // Keep the handle grabbable even if its value drifted outside
          // the frozen window (e.g. trimmed past the margin) by pinning it
          // to the nearest edge.
          const x = clamp(timeToX(h.timeS), 1, width - 1);
          return (
            <div
              key={h.kind}
              data-seam-handle={h.kind}
              className="absolute top-0 bottom-0 flex justify-center cursor-ew-resize"
              style={{ left: x - 6, width: 12 }}
              title={handleTitle(h.kind)}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                dragRef.current = h.kind;
              }}
            >
              <span
                data-seam-handle={h.kind}
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{ width: 2, background: h.color, boxShadow: `0 0 4px ${h.color}` }}
              />
              <span
                data-seam-handle={h.kind}
                className="absolute top-0 px-0.5 font-mono text-[7px] tracking-label uppercase rounded-sm pointer-events-none"
                style={{ background: h.color, color: "#1A1612" }}
              >
                {h.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface LaneView {
  startS: number;
  spanS: number;
  /** Frozen pan/zoom bounds (chunk region ± margin) captured at frame
   *  time so trims don't move the window. */
  boundStartS: number;
  boundEndS: number;
}

function initView(chunk: Chunk, centerS: number, barS: number): LaneView {
  const marginS = barS > 0 ? barS * MARGIN_BARS : 1;
  const boundStartS = chunk.startMs / 1000 - marginS;
  const boundEndS = chunk.endMs / 1000 + marginS;
  const boundSpan = Math.max(0.2, boundEndS - boundStartS);
  const maxSpan = Math.min(boundSpan, barS > 0 ? barS * MAX_VIEW_BARS : 20);
  const spanS = Math.min(maxSpan, barS > 0 ? barS * DEFAULT_VIEW_BARS : 6);
  const startS = clamp(
    centerS - spanS / 2,
    boundStartS,
    Math.max(boundStartS, boundEndS - spanS),
  );
  return { startS, spanS, boundStartS, boundEndS };
}

function handleTitle(kind: HandleKind): string {
  switch (kind) {
    case "loopIn":
      return "Loop in (audition start) — drag · Shift bypasses snap";
    case "aEnd":
      return "A out — trims chunk A's end · Shift bypasses snap";
    case "bStart":
      return "B in — trims chunk B's start · Shift bypasses snap";
    case "loopOut":
      return "Loop out (audition end) — drag · Shift bypasses snap";
  }
}

interface Tick {
  tS: number;
  downbeat: boolean;
  bar: number | null;
}

function barTicks(
  chunk: Chunk,
  jobBpm: number | null,
  beatsPerBar: number,
  winStartS: number,
  winEndS: number,
  pxPerSec: number,
): Tick[] {
  const bpm = effectiveChunkBpm(chunk, jobBpm);
  if (bpm <= 0 || beatsPerBar <= 0) return [];
  const sPerBeat = 60 / bpm;
  const pxPerBeat = sPerBeat * pxPerSec;
  if (pxPerBeat < 4) return [];
  const showBeats = pxPerBeat >= 14;
  const anchorS = chunkBeatPhaseS(chunk);
  const ticks: Tick[] = [];
  const first = Math.ceil((winStartS - anchorS) / sPerBeat - 1e-9);
  const last = Math.floor((winEndS - anchorS) / sPerBeat + 1e-9);
  for (let i = first; i <= last; i++) {
    const downbeat = (((i % beatsPerBar) + beatsPerBar) % beatsPerBar) === 0;
    if (!downbeat && !showBeats) continue;
    ticks.push({
      tS: anchorS + i * sPerBeat,
      downbeat,
      bar: downbeat ? Math.floor(i / beatsPerBar) + 1 : null,
    });
  }
  return ticks;
}
