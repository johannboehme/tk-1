/**
 * Sync Progress Panel — "tape console" view of an in-flight sync job.
 *
 * Layout: stack of channel-strips, one per cam plus a master strip on top
 * and an "analyze" strip on the bottom. Each strip shows a tape-reel that
 * spins while active and three stage pills that light up sequentially.
 *
 * Pure-presentation: state comes from `buildSyncProgressView()`, animations
 * via framer-motion. Honors `prefers-reduced-motion`.
 */
import { motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";
import type { LocalJob, MediaAsset } from "../../storage/jobs-db";
import {
  buildSyncProgressView,
  type CamProgressView,
  type CamState,
  type MasterState,
} from "./parse-stage";
import { RuleStrip } from "../../editor/components/RuleStrip";

export function SyncProgressPanel({ job }: { job: LocalJob }) {
  const cams: MediaAsset[] = useMemo(() => job.videos ?? [], [job.videos]);
  const view = useMemo(
    () =>
      buildSyncProgressView({
        status: job.status,
        stage: job.progress.stage,
        pct: job.progress.pct,
        cams,
      }),
    [job.status, job.progress.stage, job.progress.pct, cams],
  );

  const camById = new Map(cams.map((c) => [c.id, c]));

  return (
    <div
      className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel"
      data-testid="sync-progress-panel"
    >
      {/* Console title bar */}
      <div className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-3">
        <ConsoleLabel state={view.master} />
        <RuleStrip count={28} className="text-rule flex-1 max-w-[260px]" />
        <ProgressReadout pct={view.globalPct} master={view.master} />
      </div>

      {/* Master audio strip */}
      <MasterStrip
        state={view.master}
        audioFilename={job.audioFilename}
      />

      {/* Cam strips */}
      <ol className="divide-y divide-rule/60">
        {view.cams.map((c, i) => (
          <CamStrip
            key={c.id}
            view={c}
            index={i}
            asset={camById.get(c.id)}
            allCount={view.cams.length}
          />
        ))}
      </ol>

      {/* Footer hint */}
      <div className="bg-paper-panel/60 border-t border-rule px-3 py-2 flex items-center gap-2">
        <FooterHint master={view.master} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// CONSOLE LABEL — title block, morphs label depending on stage
// -----------------------------------------------------------------------------

function ConsoleLabel({ state }: { state: MasterState }) {
  const label =
    state === "failed"
      ? "Sync · halted"
      : state === "done"
        ? "Sync · finalising"
        : state === "detecting"
          ? "Sync · detecting chunks"
          : state === "analyzing"
            ? "Sync · analysing audio"
            : state === "decoding"
              ? "Sync · decoding master"
              : "Sync · queued";

  return (
    <div className="flex items-center gap-2">
      <RegistrationDot state={state} />
      <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
        {label}
      </span>
    </div>
  );
}

function RegistrationDot({ state }: { state: MasterState }) {
  const reduce = useReducedMotion();
  const isActive =
    state === "decoding" || state === "analyzing" || state === "detecting";
  const isFailed = state === "failed";
  const color = isFailed
    ? "#C0392B"
    : isActive
      ? "#FF5722"
      : state === "done"
        ? "#2A8A4A"
        : "#9A8F80";

  return (
    <motion.span
      className="inline-block w-2 h-2 rounded-full"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      animate={
        isActive && !reduce
          ? { opacity: [1, 0.45, 1] }
          : { opacity: 1 }
      }
      transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

// -----------------------------------------------------------------------------
// PROGRESS READOUT — LCD-style numeric progress
// -----------------------------------------------------------------------------

function ProgressReadout({
  pct,
  master,
}: {
  pct: number;
  master: MasterState;
}) {
  const display =
    master === "done" ? "100" : master === "failed" ? "ERR" : Math.round(pct).toString().padStart(2, "0");
  return (
    <span className="px-2 py-0.5 rounded bg-sunken text-paper-hi font-mono tabular text-[11px] tracking-label shadow-lcd">
      {display}
      {master !== "failed" && <span className="opacity-60 ml-0.5">%</span>}
    </span>
  );
}

// -----------------------------------------------------------------------------
// MASTER STRIP — top channel for the studio audio
// -----------------------------------------------------------------------------

function MasterStrip({
  state,
  audioFilename,
}: {
  state: MasterState;
  audioFilename: string;
}) {
  const isActive =
    state === "decoding" || state === "analyzing" || state === "detecting";
  return (
    <motion.div
      className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-3 py-3 items-center bg-paper-deep/60 border-b-2 border-rule"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Reel pair */}
      <div className="flex items-center gap-1.5">
        <TapeReel size={32} active={isActive} variant="master" />
        <TapeReel size={32} active={isActive} variant="master" delay={0.1} />
      </div>
      {/* Filename + label */}
      <div className="min-w-0">
        <div className="font-display tracking-label uppercase text-[10px] text-ink-3">
          Master Audio
        </div>
        <div className="font-mono text-xs text-ink truncate">{audioFilename}</div>
      </div>
      {/* Activity readout */}
      <div className="text-right">
        <MasterActivity state={state} />
      </div>
      {/* Hardware ID */}
      <div className="font-mono text-[10px] text-ink-3 tabular pl-2 border-l border-rule">
        22.05k · MONO
      </div>
    </motion.div>
  );
}

function MasterActivity({ state }: { state: MasterState }) {
  if (state === "decoding") {
    return <BarsAnimator label="DECODE" />;
  }
  if (state === "analyzing") {
    return <BarsAnimator label="ANALYSE" />;
  }
  if (state === "detecting") {
    return <BarsAnimator label="CHUNKS" />;
  }
  if (state === "done") {
    return (
      <span className="font-display tracking-label uppercase text-[10px] text-success">
        ● ready
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="font-display tracking-label uppercase text-[10px] text-danger">
        ● halted
      </span>
    );
  }
  return (
    <span className="font-display tracking-label uppercase text-[10px] text-ink-3">
      ○ standby
    </span>
  );
}

/** Mini equaliser bars — animates during master "active" stages. */
function BarsAnimator({ label }: { label: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-end gap-[2px] h-3">
        {[0.5, 0.9, 0.65, 0.4, 0.8].map((target, i) => (
          <motion.span
            key={i}
            className="block w-[2px] bg-hot rounded-[1px]"
            style={{ height: "30%" }}
            animate={
              reduce
                ? { height: `${target * 100}%` }
                : {
                    height: [
                      `${target * 30}%`,
                      `${target * 100}%`,
                      `${target * 50}%`,
                      `${target * 80}%`,
                    ],
                  }
            }
            transition={{
              duration: 0.7 + i * 0.07,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "easeInOut",
            }}
          />
        ))}
      </span>
      <span className="font-display tracking-label uppercase text-[10px] text-hot">
        {label}
      </span>
    </span>
  );
}

// -----------------------------------------------------------------------------
// CAM STRIP — one row per cam with stage pills + tape reel
// -----------------------------------------------------------------------------

function CamStrip({
  view,
  index,
  asset,
  allCount,
}: {
  view: CamProgressView;
  index: number;
  asset: MediaAsset | undefined;
  allCount: number;
}) {
  const color = asset?.color ?? "#9A8F80";
  const filename = asset?.filename ?? view.id;
  const reduce = useReducedMotion();

  const isActive = view.state === "syncing" || view.state === "frames";

  return (
    <motion.li
      className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-3 py-3 items-center"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{
        duration: 0.32,
        delay: reduce ? 0 : Math.min(0.05 * index, 0.4),
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {/* Cam color stripe + name */}
      <div className="flex items-center gap-2 min-w-0">
        <motion.span
          className="w-1.5 h-9 rounded-sm shrink-0"
          style={{ background: color, boxShadow: `0 0 4px ${color}55` }}
          animate={
            isActive && !reduce
              ? { boxShadow: [`0 0 4px ${color}55`, `0 0 10px ${color}aa`, `0 0 4px ${color}55`] }
              : { boxShadow: `0 0 4px ${color}55` }
          }
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="min-w-0">
          <div className="font-display font-semibold tracking-label uppercase text-[11px] text-ink">
            Cam {index + 1}
            <span className="font-mono normal-case ml-1.5 text-ink-3 text-[10px]">
              {index + 1}/{allCount}
            </span>
          </div>
          <div
            className="font-mono text-[11px] text-ink-3 truncate max-w-[220px]"
            title={filename}
          >
            {filename}
          </div>
        </div>
      </div>

      {/* Stage pills */}
      <div className="flex items-center gap-1.5">
        <StagePill
          label="SYNC"
          state={
            view.state === "syncing"
              ? "active"
              : view.state === "frames" || view.state === "done"
                ? "done"
                : view.state === "failed"
                  ? "failed"
                  : "pending"
          }
          fraction={view.state === "syncing" ? view.fraction : undefined}
        />
        <Connector
          lit={view.state === "frames" || view.state === "done"}
        />
        <StagePill
          label="FRAMES"
          state={
            view.state === "frames"
              ? "active"
              : view.state === "done"
                ? "done"
                : view.state === "failed"
                  ? "pending"
                  : "pending"
          }
          fraction={view.state === "frames" ? view.fraction : undefined}
        />
      </div>

      {/* Tape reel */}
      <div className="flex items-center justify-center w-12">
        <TapeReel size={36} active={isActive} variant="cam" color={color} />
      </div>

      {/* Status text */}
      <div className="text-right min-w-[88px]">
        <CamStatusText state={view.state} fraction={view.fraction} />
      </div>
    </motion.li>
  );
}

function CamStatusText({
  state,
  fraction,
}: {
  state: CamState;
  fraction: number;
}) {
  if (state === "done") {
    return (
      <motion.span
        className="font-display tracking-label uppercase text-[10px] text-success"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 18 }}
      >
        ● done
      </motion.span>
    );
  }
  if (state === "failed") {
    return (
      <span className="font-display tracking-label uppercase text-[10px] text-danger">
        ● halted
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="font-display tracking-label uppercase text-[10px] text-ink-3">
        ○ pending
      </span>
    );
  }
  // active states — show rolling % within the cam's slice
  return (
    <span className="font-mono tabular text-[11px] text-hot">
      {Math.round(fraction * 100)}%
    </span>
  );
}

// -----------------------------------------------------------------------------
// STAGE PILL — three-state LED pill
// -----------------------------------------------------------------------------

type PillState = "pending" | "active" | "done" | "failed";

function StagePill({
  label,
  state,
  fraction,
}: {
  label: string;
  state: PillState;
  /** When active, drives the inner progress fill (0..1). */
  fraction?: number;
}) {
  const reduce = useReducedMotion();
  const colors = {
    pending: { bg: "#DDD4BE", border: "#C9BFA6", text: "#9A8F80", led: "#9A8F8055" },
    active: { bg: "#FAF6EC", border: "#FF5722", text: "#1A1816", led: "#FF5722" },
    done: { bg: "#FAF6EC", border: "#2A8A4A", text: "#1A1816", led: "#2A8A4A" },
    failed: { bg: "#FAF6EC", border: "#C0392B", text: "#1A1816", led: "#C0392B" },
  }[state];

  const fill = state === "active" ? Math.max(0.05, fraction ?? 0) : state === "done" ? 1 : 0;

  return (
    <motion.span
      className="relative inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-display tracking-label uppercase text-[9.5px] font-semibold overflow-hidden"
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.text,
        boxShadow:
          state === "active" || state === "done"
            ? `0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(0,0,0,0.06)`
            : `0 1px 1px rgba(0,0,0,0.04) inset`,
      }}
      animate={state === "done" ? { scale: [1, 1.06, 1] } : { scale: 1 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
    >
      {/* progress fill — sits behind label */}
      <motion.span
        aria-hidden
        className="absolute inset-0 origin-left pointer-events-none"
        style={{
          background: `linear-gradient(90deg, ${colors.led}22, ${colors.led}10)`,
        }}
        initial={false}
        animate={{ scaleX: fill }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      />
      <motion.span
        aria-hidden
        className="relative inline-block w-1 h-1 rounded-full shrink-0"
        style={{ background: colors.led }}
        animate={
          state === "active" && !reduce
            ? { boxShadow: [`0 0 0px ${colors.led}`, `0 0 6px ${colors.led}`, `0 0 0px ${colors.led}`] }
            : { boxShadow: state === "done" ? `0 0 4px ${colors.led}` : "none" }
        }
        transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
      />
      <span className="relative">{label}</span>
    </motion.span>
  );
}

function Connector({ lit }: { lit: boolean }) {
  return (
    <span
      className="block h-px w-2"
      style={{
        background: lit ? "#2A8A4A" : "#C9BFA6",
        boxShadow: lit ? `0 0 4px #2A8A4A` : "none",
      }}
    />
  );
}

// -----------------------------------------------------------------------------
// TAPE REEL — small SVG with rotating spokes
// -----------------------------------------------------------------------------

function TapeReel({
  size,
  active,
  variant,
  color,
  delay = 0,
}: {
  size: number;
  active: boolean;
  variant: "master" | "cam";
  color?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const hub = variant === "master" ? "#1A1816" : color ?? "#5C544A";
  const ring = "#3A352E";

  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      className="block"
      animate={
        active && !reduce
          ? { rotate: 360 }
          : { rotate: 0 }
      }
      transition={{
        duration: 1.4,
        repeat: active && !reduce ? Infinity : 0,
        ease: "linear",
        delay,
      }}
    >
      {/* outer rim */}
      <circle cx="18" cy="18" r="16.5" fill="#1A1816" stroke={ring} strokeWidth="0.6" />
      <circle cx="18" cy="18" r="14.5" fill="none" stroke="#3A352E" strokeWidth="0.4" />
      {/* spokes */}
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <line
          key={angle}
          x1="18"
          y1="6"
          x2="18"
          y2="30"
          stroke="#5C544A"
          strokeWidth="0.6"
          transform={`rotate(${angle} 18 18)`}
        />
      ))}
      {/* hub */}
      <circle cx="18" cy="18" r="5" fill={hub} stroke="#1A1816" strokeWidth="0.6" />
      <circle cx="18" cy="18" r="1.6" fill="#1A1816" />
      {/* highlight */}
      <circle cx="14" cy="14" r="1.2" fill="#FAF6EC" opacity="0.18" />
    </motion.svg>
  );
}

// -----------------------------------------------------------------------------
// FOOTER HINT — explains current state in plain language
// -----------------------------------------------------------------------------

function FooterHint({ master }: { master: MasterState }) {
  const text =
    master === "done"
      ? "All set — opening editor."
      : master === "failed"
        ? "Sync halted. See error below."
        : master === "detecting"
          ? "Marking chunks for the Triage step…"
          : master === "analyzing"
            ? "Listening for tempo + downbeats…"
            : master === "decoding"
              ? "Decoding the master audio for matching."
              : "Reading the song. Cams next.";
  return (
    <span className="font-mono text-[11px] text-ink-3 italic">{text}</span>
  );
}
