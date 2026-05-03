/**
 * Sync Patch Panel — uniform per-cam patchbay, regardless of cam count.
 *
 * One row per cam, hardware look that matches the timeline's Lane-Headers:
 * cam-color stripe + cam name + filename + OFFSET + DRIFT + a 3-LED
 * confidence bar matching the Tally aesthetic. Reads each cam's sync
 * straight from `VideoAsset.sync` — single source of truth, no mirror layer.
 *
 * Used by:
 *   - JobPage (read-only patchbay display after sync completes)
 *   - Triage (interactive — click on a row to select that cam for the
 *     SyncTuner / Cam-Preview)
 *
 * `selectedCamId` + `onSelectCam` enable the interactive variant. When
 * `onSelectCam` is omitted the panel renders without any hover/active
 * affordance — preserves the original JobPage look.
 */
import React from "react";
import { RuleStrip } from "../../editor/components/RuleStrip";
import { isVideoAsset, type LocalJob, type VideoAsset } from "../../storage/jobs-db";

interface Props {
  job: LocalJob;
  /** When provided, rows are clickable and the matching cam gets a
   *  highlighted border. Omit for the read-only display. */
  selectedCamId?: string | null;
  onSelectCam?: (camId: string) => void;
}

export function SyncPatchPanel({ job, selectedCamId, onSelectCam }: Props) {
  // Image cams have no sync result — they're not part of this panel.
  const videos: VideoAsset[] = (job.videos ?? []).filter(isVideoAsset);

  if (videos.length === 0) {
    return (
      <div className="rounded-md border border-rule px-4 py-6 text-center font-mono text-xs text-ink-3">
        No cams yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-rule overflow-hidden bg-paper-hi shadow-panel">
      <div className="bg-paper-panel border-b border-rule px-3 py-2 flex items-center gap-2">
        <span className="font-display tracking-label uppercase text-[10px] text-ink-2">
          {videos.length === 1 ? "Sync" : `Sync · ${videos.length} cams`}
        </span>
        <RuleStrip count={20} className="text-rule flex-1 max-w-[180px]" />
      </div>
      {/* Desktop / wider tablets: 5-column grid. */}
      <div className="hidden sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto] gap-x-4">
        <HeaderCell>CAM</HeaderCell>
        <HeaderCell>SOURCE</HeaderCell>
        <HeaderCell align="right">OFFSET</HeaderCell>
        <HeaderCell align="right">DRIFT</HeaderCell>
        <HeaderCell align="right">CONF</HeaderCell>
        {videos.map((cam, i) => (
          <SyncRow
            key={cam.id}
            cam={cam}
            index={i}
            last={i === videos.length - 1}
            selected={selectedCamId === cam.id}
            interactive={Boolean(onSelectCam)}
            onSelect={onSelectCam ? () => onSelectCam(cam.id) : undefined}
          />
        ))}
      </div>
      {/* Narrow phones: stacked card per cam — labels render inline so the
       *  numeric columns can't overflow. */}
      <div className="sm:hidden">
        {videos.map((cam, i) => (
          <SyncCard
            key={cam.id}
            cam={cam}
            index={i}
            last={i === videos.length - 1}
            selected={selectedCamId === cam.id}
            interactive={Boolean(onSelectCam)}
            onSelect={onSelectCam ? () => onSelectCam(cam.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function HeaderCell({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div
      className={[
        "px-3 py-2 font-display tracking-label uppercase text-[10px] text-ink-3 border-b border-rule bg-paper-panel/60",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

interface RowProps {
  cam: VideoAsset;
  index: number;
  last: boolean;
  selected: boolean;
  interactive: boolean;
  onSelect?: () => void;
}

function SyncRow({ cam, index, last, selected, interactive, onSelect }: RowProps) {
  const sync = cam.sync;
  const border = last ? "" : "border-b border-rule/50";
  // Selected rows get a cobalt left-edge accent — distinct from the
  // cam-color stripe so the user can tell at a glance which cam is
  // active even on a multi-cam job where colors compete.
  const selectedCls = selected ? "bg-cobalt/10" : interactive ? "hover:bg-paper-deep cursor-pointer" : "";
  const cellCls = `px-3 py-3 ${border} ${selectedCls}`;
  const handleKey = onSelect
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }
    : undefined;

  // The grid layout means each row is 5 sibling cells. Wrap them in a
  // common click handler via individual onClick — cells share state
  // but click on any of them selects the row.
  const sharedClick = onSelect;
  const sharedRole = interactive ? "button" : undefined;
  const sharedTabIndex = interactive ? 0 : undefined;

  return (
    <>
      {/* CAM cell — color stripe + name */}
      <div
        className={`${cellCls} flex items-center gap-2`}
        onClick={sharedClick}
        onKeyDown={handleKey}
        role={sharedRole}
        tabIndex={sharedTabIndex}
        aria-pressed={interactive ? selected : undefined}
      >
        <span
          className="w-1.5 h-7 rounded-sm shrink-0"
          style={{
            background: cam.color,
            boxShadow: `0 0 4px ${cam.color}55`,
          }}
        />
        <span className="font-display font-semibold text-xs tracking-label uppercase">
          Cam {index + 1}
        </span>
      </div>
      {/* SOURCE cell — filename */}
      <div
        className={`${cellCls} font-mono text-xs text-ink-2 truncate self-center min-w-0`}
        title={cam.filename}
        onClick={sharedClick}
      >
        {cam.filename}
      </div>
      {/* OFFSET */}
      <div
        className={`${cellCls} text-right font-mono tabular text-ink self-center`}
        onClick={sharedClick}
      >
        {sync ? `${sync.offsetMs.toFixed(1)} ms` : "—"}
      </div>
      {/* DRIFT */}
      <div
        className={`${cellCls} text-right font-mono tabular text-ink self-center`}
        onClick={sharedClick}
      >
        {sync ? `${((sync.driftRatio - 1) * 100).toFixed(3)}%` : "—"}
      </div>
      {/* CONFIDENCE — three-LED bar like a hardware tally */}
      <div className={`${cellCls} text-right self-center`} onClick={sharedClick}>
        {sync ? (
          <ConfidenceLeds value={sync.confidence} />
        ) : (
          <span className="font-mono text-ink-3">—</span>
        )}
      </div>
    </>
  );
}

/**
 * Mobile-only stacked card per cam. Renders the same data as SyncRow but
 * label-value pairs flow vertically so OFFSET/DRIFT/CONF can never push
 * the row past the viewport on a narrow phone.
 */
function SyncCard({ cam, index, last, selected, interactive, onSelect }: RowProps) {
  const sync = cam.sync;
  const border = last ? "" : "border-b border-rule/50";
  const selectedCls = selected ? "bg-cobalt/10" : interactive ? "hover:bg-paper-deep cursor-pointer" : "";
  const handleKey = onSelect
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }
    : undefined;
  return (
    <div
      className={`px-3 py-3 ${border} ${selectedCls}`}
      onClick={onSelect}
      onKeyDown={handleKey}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="w-1.5 h-7 rounded-sm shrink-0"
          style={{
            background: cam.color,
            boxShadow: `0 0 4px ${cam.color}55`,
          }}
        />
        <span className="font-display font-semibold text-xs tracking-label uppercase shrink-0">
          Cam {index + 1}
        </span>
        <span
          className="font-mono text-xs text-ink-2 truncate min-w-0"
          title={cam.filename}
        >
          {cam.filename}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] pl-3.5">
        <span className="font-display tracking-label uppercase text-ink-3">Offset</span>
        <span className="font-mono tabular text-ink text-right">
          {sync ? `${sync.offsetMs.toFixed(1)} ms` : "—"}
        </span>
        <span className="font-display tracking-label uppercase text-ink-3">Drift</span>
        <span className="font-mono tabular text-ink text-right">
          {sync ? `${((sync.driftRatio - 1) * 100).toFixed(3)}%` : "—"}
        </span>
        <span className="font-display tracking-label uppercase text-ink-3">Conf</span>
        <span className="text-right">
          {sync ? <ConfidenceLeds value={sync.confidence} /> : <span className="font-mono text-ink-3">—</span>}
        </span>
      </div>
    </div>
  );
}

/** 3-LED confidence indicator. Matches the analog Tally aesthetic of the
 * Lane-Headers in the timeline. */
function ConfidenceLeds({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  // High >= 70, Mid 30..70, Low < 30
  const lit = value >= 0.7 ? 3 : value >= 0.3 ? 2 : 1;
  const color = lit === 3 ? "#34D399" : lit === 2 ? "#FFB020" : "#FF3326";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="block w-[6px] h-[6px] rounded-full"
            style={{
              background: i < lit ? color : "#3A352E",
              boxShadow: i < lit ? `0 0 4px ${color}` : "none",
              opacity: i < lit ? 1 : 0.35,
            }}
          />
        ))}
      </span>
      <span className="font-mono tabular text-ink text-xs">{pct}%</span>
    </span>
  );
}
