/**
 * Cockpit for the Arrange page — OP-1 amber phosphor display.
 *
 * Layout (desktop):
 *   ┌──────┬────────────────┬─────────────────────────────────┐
 *   │ CAM  │  STAT  STACK   │  MEL — focused chunk            │
 *   │      │  total/item    │  (canvas, phosphor color ramp)  │
 *   │      │  bpm/play      │                                 │
 *   ├──────┴────────────────┴─────────────────────────────────┤
 *   │  [ KEY  DENS  BRGT  PEAK ]  ·  [ DRMS BASS MEL FRMT ]   │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Mel canvas renders an n_mels × n_frames ImageData per chunk via a
 * baked phosphor LUT (wine-black floor → copper mid → bright amber
 * peak). Frequency goes UP the y-axis (mel-bin 0 = bottom). The canvas
 * intrinsic size matches the data; CSS scales it to fill its slot, so
 * the browser's bilinear filter does the phosphor "bleed" for free.
 */
import { useEffect, useMemo, useRef } from "react";
import { useArrangeStore } from "../../local/arrange/arrange-store";
import {
  chunkAutoTags,
  chunkStemHeuristic,
  type ChunkMelData,
} from "../../local/arrange/chunk-mel";
import { CamPreviewArrange } from "./CamPreviewArrange";

// ─── Props (presentational layer) ──────────────────────────────────────

export interface CockpitAutoTags {
  key: string;
  dens: 0 | 1 | 2 | 3;
  brgt: 0 | 1 | 2 | 3 | 4;
  peakDb: number;
}

export interface CockpitStems {
  drums: number;
  bass: number;
  melody: number;
  formants: number;
}

export interface CockpitDisplayProps {
  totalDurationMs: number;
  itemIdx: number;
  itemCount: number;
  isPlaying: boolean;
  jobBpm: number | null;
  currentTime: number;
  mel: ChunkMelData | null;
  autoTags: CockpitAutoTags;
  stems: CockpitStems;
  /** Real playhead position within the displayed chunk in [0, 1].
   *  Null when no audio is playing inside this chunk. */
  playheadFraction: number | null;
  /** Called with a 0..1 fraction when the user clicks the spectrogram.
   *  Resolves to a master-time seek inside the displayed chunk. */
  onSeekToFraction?: (fraction: number) => void;
}

// ─── Phosphor color ramp ───────────────────────────────────────────────
// Three-stop interpolation tuned for OP-1 amber. Floor is not pure black
// — real LCDs leak a tiny warm bloom even when "off". Mid is hand-warm
// copper. Peak is phosphor-flare amber that reads as "lit" without going
// neon-orange. Baked once at module load: 256 × 4 bytes.
const PHOSPHOR_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  const FLOOR_RGB = [14, 8, 7];
  const MID_RGB = [154, 72, 24];
  const PEAK_RGB = [255, 138, 79];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number;
    if (t < 0.5) {
      const u = t / 0.5;
      r = lerp(FLOOR_RGB[0], MID_RGB[0], u);
      g = lerp(FLOOR_RGB[1], MID_RGB[1], u);
      b = lerp(FLOOR_RGB[2], MID_RGB[2], u);
    } else {
      const u = (t - 0.5) / 0.5;
      r = lerp(MID_RGB[0], PEAK_RGB[0], u);
      g = lerp(MID_RGB[1], PEAK_RGB[1], u);
      b = lerp(MID_RGB[2], PEAK_RGB[2], u);
    }
    lut[i * 4 + 0] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

// ─── Top-level shell (store-coupled) ───────────────────────────────────

export function PlayerCockpit() {
  // Pull only the arrays/scalars used by the LCD; useMemo + native
  // selectors short-circuit re-renders to the cells that actually
  // changed. (The cam preview manages its own subscriptions.)
  const arrangement = useArrangeStore((s) => s.arrangement);
  const chunks = useArrangeStore((s) => s.chunks);
  const focusedItemId = useArrangeStore((s) => s.focusedItemId);
  const currentItemId = useArrangeStore((s) => s.playback.currentItemId);
  const currentTime = useArrangeStore((s) => s.playback.currentTime);
  const isPlaying = useArrangeStore((s) => s.playback.isPlaying);
  const jobBpm = useArrangeStore((s) => s.jobBpm);
  const analysis = useArrangeStore((s) => s.analysis);
  const melByChunkId = useArrangeStore((s) => s.melByChunkId);
  const seek = useArrangeStore((s) => s.seek);
  const setCurrentItemId = useArrangeStore((s) => s.setCurrentItemId);

  const totalDurationMs = useMemo(() => {
    const lookup = new Map(chunks.map((c) => [c.id, c.endMs - c.startMs]));
    let total = 0;
    for (const item of arrangement) total += lookup.get(item.chunkId) ?? 0;
    return total;
  }, [arrangement, chunks]);

  // Item index = current playing item, falling back to focused item if
  // nothing is playing yet. Lets the LCD answer "what am I looking at?"
  // even before the user hits play.
  const showItemId = currentItemId ?? focusedItemId ?? null;
  const itemIdx = showItemId
    ? arrangement.findIndex((a) => a.id === showItemId) + 1
    : 0;

  // Resolve the chunk to glance — same priority as itemIdx so the
  // numeric counter and the phosphor mel always agree.
  const showChunk = useMemo(() => {
    if (!showItemId) return null;
    const item = arrangement.find((a) => a.id === showItemId);
    if (!item) return null;
    return chunks.find((c) => c.id === item.chunkId) ?? null;
  }, [showItemId, arrangement, chunks]);

  const mel = showChunk ? melByChunkId[showChunk.id] ?? null : null;
  const autoTags = useMemo<CockpitAutoTags>(
    () =>
      showChunk
        ? chunkAutoTags(showChunk, analysis, mel)
        : { key: "—", dens: 0, brgt: 0, peakDb: -Infinity },
    [showChunk, analysis, mel],
  );
  const stems = useMemo<CockpitStems>(
    () =>
      showChunk
        ? chunkStemHeuristic(showChunk, analysis)
        : { drums: 0, bass: 0, melody: 0, formants: 0 },
    [showChunk, analysis],
  );

  // Real playhead fraction within the *currently playing* chunk, in
  // [0, 1]. Null when nothing is playing, or when the displayed chunk
  // isn't the one the audio master is currently inside (e.g. user
  // focused a different chunk while playback runs elsewhere).
  let playheadFraction: number | null = null;
  if (isPlaying && currentItemId && showChunk && currentItemId === showItemId) {
    const tMs = currentTime * 1000;
    const span = showChunk.endMs - showChunk.startMs;
    if (span > 0) {
      const f = (tMs - showChunk.startMs) / span;
      if (f >= 0 && f <= 1) playheadFraction = f;
    }
  }

  // Click-to-seek: translate a 0..1 fraction across the spectrogram
  // back to a master-time inside `showChunk`. Also tag this item as
  // the current playback walker so the audio master picks up from
  // here even if the click landed in a chunk other than the focused
  // one. No-op when there's no chunk to seek inside.
  const onSeekToFraction =
    showChunk && showItemId
      ? (fraction: number) => {
          const span = showChunk.endMs - showChunk.startMs;
          if (span <= 0) return;
          const clamped = Math.max(0, Math.min(1, fraction));
          const targetMs = showChunk.startMs + clamped * span;
          if (currentItemId !== showItemId) {
            setCurrentItemId(showItemId);
          }
          seek(targetMs / 1000);
        }
      : undefined;

  return (
    <section className="flex items-stretch gap-2 sm:gap-3">
      <CamPreviewArrange />
      <CockpitLcd
        totalDurationMs={totalDurationMs}
        itemIdx={itemIdx}
        itemCount={arrangement.length}
        isPlaying={isPlaying}
        jobBpm={jobBpm}
        currentTime={currentTime}
        mel={mel}
        autoTags={autoTags}
        stems={stems}
        playheadFraction={playheadFraction}
        onSeekToFraction={onSeekToFraction}
      />
    </section>
  );
}

// ─── LCD ────────────────────────────────────────────────────────────────

function CockpitLcd({
  totalDurationMs,
  itemIdx,
  itemCount,
  isPlaying,
  jobBpm,
  currentTime,
  mel,
  autoTags,
  stems,
  playheadFraction,
  onSeekToFraction,
}: CockpitDisplayProps) {
  return (
    <div
      className="flex-1 relative rounded-md border border-rule overflow-hidden flex flex-col"
      style={{
        background:
          "linear-gradient(180deg, #0B0A09 0%, #181613 50%, #0B0A09 100%)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.55), 0 1px 6px rgba(0,0,0,0.6) inset, 0 0 0 1px rgba(0,0,0,0.5) inset",
      }}
    >
      {/* Ambient phosphor bloom */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 70% 40%, rgba(255,138,79,0.08), transparent 70%)",
        }}
      />
      {/* Subtle CRT scanlines */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.16) 3px, transparent 4px)",
          mixBlendMode: "multiply",
        }}
      />

      {/* Top row: stats + mel */}
      <div className="relative flex-1 min-h-0 flex items-stretch gap-2 sm:gap-3 px-2 sm:px-3 pt-2 sm:pt-3">
        <StatStack
          totalDurationMs={totalDurationMs}
          itemIdx={itemIdx}
          itemCount={itemCount}
          isPlaying={isPlaying}
          jobBpm={jobBpm}
          currentTime={currentTime}
        />
        <MelDisplay
          mel={mel}
          isPlaying={isPlaying}
          playheadFraction={playheadFraction}
          onSeekToFraction={onSeekToFraction}
        />
      </div>

      {/* Bottom strip: auto-tags + stems */}
      <div className="relative flex items-stretch gap-2 sm:gap-3 px-2 sm:px-3 pb-2 sm:pb-3 pt-2">
        <AutoTagsRow tags={autoTags} />
        <StemBarsRow stems={stems} />
      </div>
    </div>
  );
}

// ─── Stat stack ─────────────────────────────────────────────────────────

function StatStack({
  totalDurationMs,
  itemIdx,
  itemCount,
  isPlaying,
  jobBpm,
  currentTime,
}: Pick<
  CockpitDisplayProps,
  | "totalDurationMs"
  | "itemIdx"
  | "itemCount"
  | "isPlaying"
  | "jobBpm"
  | "currentTime"
>) {
  return (
    <div className="shrink-0 w-[88px] sm:w-[112px] flex flex-col justify-between py-0.5">
      <StatLine label="TOTAL" value={formatTime(totalDurationMs / 1000)} big />
      <StatLine
        label="ITEM"
        value={
          itemCount === 0 ? "—" : `${pad(itemIdx, 2)}/${pad(itemCount, 2)}`
        }
      />
      <StatLine label="BPM" value={jobBpm ? jobBpm.toFixed(0) : "—"} />
      <StatLine
        label="NOW"
        value={formatTime(currentTime)}
        muted={!isPlaying}
      />
      <PlayBadge isPlaying={isPlaying} />
    </div>
  );
}

function StatLine({
  label,
  value,
  big = false,
  muted = false,
}: {
  label: string;
  value: string;
  big?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="leading-none">
      <span
        className="block font-display text-[7px] tracking-label uppercase"
        style={{ color: "rgba(255,138,79,0.45)" }}
      >
        {label}
      </span>
      <span
        className={`block font-mono tabular leading-none ${
          big ? "text-sm sm:text-[15px]" : "text-[11px] sm:text-xs"
        }`}
        style={{
          color: muted ? "rgba(255,138,79,0.55)" : "#FF8A4F",
          textShadow: muted
            ? "0 0 4px rgba(255,138,79,0.25)"
            : "0 0 6px rgba(255,138,79,0.7), 0 0 12px rgba(255,87,34,0.3)",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PlayBadge({ isPlaying }: { isPlaying: boolean }) {
  return (
    <div className="flex items-center gap-1 mt-1">
      <span
        aria-hidden
        className={`block w-1.5 h-1.5 rounded-full ${
          isPlaying ? "animate-pulse" : ""
        }`}
        style={{
          background: isPlaying ? "#FF5722" : "rgba(255,138,79,0.3)",
          boxShadow: isPlaying
            ? "0 0 6px rgba(255,87,34,1), 0 0 10px rgba(255,87,34,0.45)"
            : "none",
        }}
      />
      <span
        className="font-display text-[8px] sm:text-[9px] tracking-label uppercase font-bold"
        style={{
          color: isPlaying ? "#FF5722" : "rgba(255,138,79,0.45)",
          textShadow: isPlaying
            ? "0 0 8px rgba(255,87,34,0.85)"
            : "0 0 3px rgba(255,255,255,0.05)",
        }}
      >
        {isPlaying ? "PLAY" : "READY"}
      </span>
    </div>
  );
}

// ─── Mel display ────────────────────────────────────────────────────────

function MelDisplay({
  mel,
  isPlaying,
  playheadFraction,
  onSeekToFraction,
}: {
  mel: ChunkMelData | null;
  isPlaying: boolean;
  playheadFraction: number | null;
  onSeekToFraction?: (fraction: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const seekable = !!mel && mel.nFrames > 0 && !!onSeekToFraction;
  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!seekable) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, x / rect.width));
    onSeekToFraction?.(fraction);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mel || mel.nFrames === 0 || mel.nMels === 0) return;
    canvas.width = mel.nFrames;
    canvas.height = mel.nMels;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const img = ctx.createImageData(mel.nFrames, mel.nMels);
    const dst = img.data;
    const src = mel.data;
    const { nMels, nFrames } = mel;
    for (let f = 0; f < nFrames; f++) {
      for (let m = 0; m < nMels; m++) {
        const v = src[f * nMels + m];
        const x = f;
        const y = nMels - 1 - m;
        const di = (y * nFrames + x) * 4;
        const li = v * 4;
        dst[di + 0] = PHOSPHOR_LUT[li + 0];
        dst[di + 1] = PHOSPHOR_LUT[li + 1];
        dst[di + 2] = PHOSPHOR_LUT[li + 2];
        dst[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [mel]);

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      role={seekable ? "button" : undefined}
      tabIndex={seekable ? 0 : undefined}
      aria-label={seekable ? "Seek within chunk" : undefined}
      className={`flex-1 min-w-0 relative rounded-sm overflow-hidden ${
        seekable ? "cursor-crosshair" : ""
      }`}
      style={{
        background: "#08070A",
        boxShadow:
          "0 0 0 1px rgba(0,0,0,0.85) inset, 0 1px 0 rgba(255,255,255,0.06), 0 1px 4px rgba(0,0,0,0.5) inset",
      }}
    >
      {mel && mel.nFrames > 0 ? (
        <>
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ imageRendering: "auto" }}
          />
          {/* Real playhead — driven by the audio master's currentTime
           *  inside the playing chunk. Null when nothing is playing
           *  inside the displayed chunk. */}
          {isPlaying && playheadFraction !== null && (
            <div
              aria-hidden
              className="absolute inset-y-0 w-px pointer-events-none"
              style={{
                left: `${(playheadFraction * 100).toFixed(2)}%`,
                background:
                  "linear-gradient(180deg, transparent, rgba(255,138,79,0.85), transparent)",
                boxShadow: "0 0 8px rgba(255,138,79,0.9)",
              }}
            />
          )}
        </>
      ) : (
        <EmptyMel />
      )}
    </div>
  );
}

function EmptyMel() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <span
        className="font-display text-[10px] sm:text-[11px] tracking-label uppercase"
        style={{
          color: "rgba(255,138,79,0.35)",
          textShadow: "0 0 6px rgba(255,138,79,0.25)",
        }}
      >
        ◇ awaiting signal
      </span>
    </div>
  );
}

// ─── Auto-tags row ──────────────────────────────────────────────────────

function AutoTagsRow({ tags }: { tags: CockpitAutoTags }) {
  return (
    <BezelStrip>
      <BezelCell label="KEY">
        <span className="font-mono tabular text-[10px] sm:text-[11px] phosphor-text">
          {tags.key}
        </span>
      </BezelCell>
      <BezelDivider />
      <BezelCell label="DENS">
        <DensGlyph value={tags.dens} />
      </BezelCell>
      <BezelDivider />
      <BezelCell label="BRGT">
        <BrgtGlyph value={tags.brgt} />
      </BezelCell>
      <BezelDivider />
      <BezelCell label="PEAK">
        <span className="font-mono tabular text-[10px] sm:text-[11px] phosphor-text">
          {Number.isFinite(tags.peakDb) ? `${tags.peakDb.toFixed(0)}dB` : "—"}
        </span>
      </BezelCell>
    </BezelStrip>
  );
}

function DensGlyph({ value }: { value: 0 | 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="block w-[5px] h-[5px] rounded-full"
          style={{
            background: i < value ? "#FF8A4F" : "rgba(255,138,79,0.18)",
            boxShadow: i < value ? "0 0 4px rgba(255,138,79,0.7)" : "none",
          }}
        />
      ))}
    </div>
  );
}

function BrgtGlyph({ value }: { value: 0 | 1 | 2 | 3 | 4 }) {
  const heights = [3, 5, 7, 9, 11];
  return (
    <div className="flex items-end gap-[1.5px] h-3">
      {heights.map((h, i) => (
        <span
          key={i}
          className="block w-[2.5px] rounded-[1px]"
          style={{
            height: `${h}px`,
            background: i <= value ? "#FF8A4F" : "rgba(255,138,79,0.18)",
            boxShadow: i <= value ? "0 0 3px rgba(255,138,79,0.7)" : "none",
          }}
        />
      ))}
    </div>
  );
}

// ─── Stem bars row ──────────────────────────────────────────────────────

function StemBarsRow({ stems }: { stems: CockpitStems }) {
  return (
    <BezelStrip className="hidden sm:flex shrink-0 w-[180px]">
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center w-full px-1">
        <StemRow label="DRMS" value={stems.drums} />
        <StemRow label="BASS" value={stems.bass} />
        <StemRow label="MEL" value={stems.melody} />
        <StemRow label="FRMT" value={stems.formants} />
      </div>
    </BezelStrip>
  );
}

function StemRow({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <>
      <span
        className="font-display text-[7px] tracking-label uppercase"
        style={{ color: "rgba(255,138,79,0.55)" }}
      >
        {label}
      </span>
      <span
        className="relative block h-[6px] rounded-[1.5px] overflow-hidden"
        style={{
          background: "rgba(0,0,0,0.7)",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.6) inset",
        }}
      >
        <span
          className="block h-full"
          style={{
            width: `${pct * 100}%`,
            background:
              "linear-gradient(90deg, rgba(255,138,79,0.6), #FF8A4F)",
            boxShadow: "0 0 6px rgba(255,138,79,0.55)",
            transition: "width 220ms ease-out",
          }}
        />
      </span>
      <span
        className="font-mono tabular text-[8px] phosphor-text"
        style={{ minWidth: 18, textAlign: "right" }}
      >
        {Math.round(pct * 100)}
      </span>
    </>
  );
}

// ─── Bezel primitives ───────────────────────────────────────────────────

function BezelStrip({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-sm ${className}`}
      style={{
        background: "rgba(0,0,0,0.45)",
        boxShadow:
          "0 0 0 1px rgba(0,0,0,0.7) inset, 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      {children}
    </div>
  );
}

function BezelCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-0.5 leading-none">
      <span
        className="font-display text-[7px] tracking-label uppercase"
        style={{ color: "rgba(255,138,79,0.45)" }}
      >
        {label}
      </span>
      <span className="phosphor-text">{children}</span>
    </div>
  );
}

function BezelDivider() {
  return (
    <span
      aria-hidden
      className="block w-px h-5 shrink-0"
      style={{
        background:
          "linear-gradient(180deg, transparent, rgba(255,138,79,0.18), transparent)",
      }}
    />
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}
