import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { ChunkyButton } from "../editor/components/ChunkyButton";
import { MonoReadout } from "../editor/components/MonoReadout";
import { SegmentedControl } from "../editor/components/SegmentedControl";
import { RuleStrip } from "../editor/components/RuleStrip";
import { TrashIcon } from "../editor/components/icons";
import { formatDuration } from "../components/ProgressBar";
import { ReelStage } from "../components/reel/ReelStage";
import { useReelStore } from "../local/reel/reel-store";
import {
  ASPECT_RATIO_PRESETS,
  RESOLUTION_LONG_SIDE_PRESETS,
  deriveResolution,
} from "../editor/exportPresets";
import type { AspectRatio } from "../editor/types";

export default function Reel() {
  const { id } = useParams<{ id: string }>();
  const loadReel = useReelStore((s) => s.loadReel);
  const reset = useReelStore((s) => s.reset);

  useEffect(() => {
    if (id) void loadReel(id);
    return () => reset();
  }, [id, loadReel, reset]);

  const members = useReelStore((s) => s.members);
  const title = useReelStore((s) => s.title);
  const exportSpec = useReelStore((s) => s.exportSpec);
  const render = useReelStore((s) => s.render);
  const setTitle = useReelStore((s) => s.setTitle);
  const setExport = useReelStore((s) => s.setExport);
  const moveMember = useReelStore((s) => s.moveMember);
  const removeMember = useReelStore((s) => s.removeMember);
  const startRender = useReelStore((s) => s.startRender);
  const totalDurationS = useReelStore((s) => s.totalDurationS);
  const selectedMemberId = useReelStore((s) => s.selectedMemberId);
  const selectMember = useReelStore((s) => s.selectMember);
  const setMemberViewport = useReelStore((s) => s.setMemberViewport);
  const resetMemberViewport = useReelStore((s) => s.resetMemberViewport);
  const selected = members.find((m) => m.memberId === selectedMemberId) ?? null;

  const stage = exportSpec.resolution && typeof exportSpec.resolution === "object"
    ? exportSpec.resolution
    : { w: 1920, h: 1080 };
  const aspect = (exportSpec.aspectRatio ?? "16:9") as AspectRatio;
  const longSide = exportSpec.resolutionLongSide ?? Math.max(stage.w, stage.h);
  const renderable = members.filter((m) => !m.missing).length;
  const rendering = render.status === "running";

  function setAspect(a: AspectRatio) {
    if (a === "custom") return;
    const res = deriveResolution(a, longSide);
    setExport({ aspectRatio: a, resolution: res, resolutionLongSide: longSide });
  }
  function setLongSide(ls: number) {
    if (aspect === "custom") return;
    const res = deriveResolution(aspect, ls);
    setExport({ resolution: res, resolutionLongSide: ls });
  }

  return (
    <div className="h-screen flex flex-col min-h-0 paper-bg overflow-hidden">
      <header className="border-b border-rule bg-paper-hi shrink-0">
        <div className="h-14 px-3 sm:px-5 flex items-center gap-3">
          <Link
            to="/jobs"
            className="font-mono text-[11px] tracking-label uppercase text-ink-2 hover:text-ink"
          >
            ← Library
          </Link>
          <span className="font-display tracking-label uppercase text-[11px] text-ink-2">
            REEL
          </span>
          <input
            value={title ?? ""}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled reel"
            className="flex-1 min-w-0 bg-transparent font-display font-semibold text-lg text-ink outline-none placeholder:text-ink-2/50"
          />
          <ChunkyButton
            variant="primary"
            size="md"
            disabled={renderable < 1 || rendering}
            onClick={() => void startRender()}
          >
            {rendering ? "Rendering…" : "Render reel"}
          </ChunkyButton>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_320px] overflow-hidden">
        {/* Member sequence */}
        <section className="overflow-y-auto p-4 sm:p-6">
          <div className="flex items-center gap-3 mb-4">
            <MonoReadout label="CLIPS" value={String(members.length).padStart(2, "0")} />
            <MonoReadout label="TOTAL" value={formatDuration(totalDurationS())} />
            <MonoReadout label="STAGE" value={`${stage.w}×${stage.h}`} />
            <RuleStrip count={24} className="text-rule flex-1 max-w-[160px]" />
          </div>

          {selected && !selected.missing && (
            <div className="mb-4 max-w-[640px]">
              <ReelStage
                stage={stage}
                videoUrl={selected.videoUrl}
                viewport={selected.viewport}
                onViewport={(patch) => setMemberViewport(selected.memberId, patch)}
                onReset={() => resetMemberViewport(selected.memberId)}
              />
              <p className="mt-1.5 font-mono text-[11px] text-ink-2">
                {selected.title} — drag to pan · wheel to zoom · double-click to reset
              </p>
            </div>
          )}

          {members.length === 0 ? (
            <p className="font-mono text-sm text-ink-2">
              This reel is empty. Add projects from the Library.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {members.map((m, i) => (
                <li
                  key={m.memberId}
                  onClick={() => selectMember(m.memberId)}
                  className={[
                    "flex items-center gap-3 bg-paper-hi border rounded-lg p-2 cursor-pointer transition-colors",
                    m.missing
                      ? "border-danger/60"
                      : m.memberId === selectedMemberId
                        ? "border-hot ring-1 ring-hot/40"
                        : "border-rule hover:border-ink-2",
                  ].join(" ")}
                >
                  <span className="font-mono text-xs tabular text-ink-2 w-6 text-center shrink-0">
                    {i + 1}
                  </span>
                  <div className="h-12 w-20 rounded-md bg-sunken overflow-hidden shrink-0">
                    {m.posterUrl && (
                      <img
                        src={m.posterUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-display font-semibold text-sm text-ink truncate">
                      {m.title}
                    </div>
                    <div className="font-mono text-[11px] tabular text-ink-2">
                      {m.missing ? (
                        <span className="text-danger">missing — project deleted</span>
                      ) : (
                        formatDuration(m.fullDurationS)
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <IconBtn
                      label="Move up"
                      disabled={i === 0}
                      onClick={() => moveMember(m.memberId, -1)}
                    >
                      ↑
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      disabled={i === members.length - 1}
                      onClick={() => moveMember(m.memberId, 1)}
                    >
                      ↓
                    </IconBtn>
                    <button
                      onClick={() => removeMember(m.memberId)}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-ink-2 hover:text-danger"
                      aria-label="Remove from reel"
                    >
                      <TrashIcon width={14} height={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* Output format + render */}
        <aside className="border-t lg:border-t-0 lg:border-l border-rule bg-paper-hi/60 overflow-y-auto p-4 sm:p-5 flex flex-col gap-5">
          <div>
            <span className="label mb-2 block">Output format</span>
            <div className="flex flex-col gap-3">
              <SegmentedControl<AspectRatio>
                label="Aspect"
                value={aspect}
                onChange={setAspect}
                size="sm"
                fullWidth
                options={ASPECT_RATIO_PRESETS.map((a) => ({ value: a, label: a }))}
              />
              <SegmentedControl<string>
                label="Resolution"
                value={String(longSide)}
                onChange={(v) => setLongSide(Number(v))}
                size="sm"
                fullWidth
                options={RESOLUTION_LONG_SIDE_PRESETS.map((p) => ({
                  value: String(p),
                  label: `${p}p`,
                }))}
              />
              <SegmentedControl<"h264" | "h265">
                label="Codec"
                value={exportSpec.video_codec ?? "h264"}
                onChange={(v) => setExport({ video_codec: v })}
                size="sm"
                fullWidth
                options={[
                  { value: "h264", label: "H.264" },
                  { value: "h265", label: "H.265" },
                ]}
              />
            </div>
          </div>

          <RuleStrip count={40} className="text-rule" />

          {render.status === "running" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] tracking-label uppercase text-ink-2">
                  {render.stage}
                </span>
                <span className="font-mono text-[11px] tabular text-ink-2">
                  {Math.round(render.pct)}%
                </span>
              </div>
              <div className="h-1.5 bg-paper-deep rounded-full overflow-hidden">
                <div
                  className="h-full bg-hot transition-all"
                  style={{ width: `${render.pct}%` }}
                />
              </div>
            </div>
          )}

          {render.status === "error" && (
            <p className="font-mono text-xs text-danger">{render.error}</p>
          )}

          {render.status === "done" && render.resultUrl && (
            <a href={render.resultUrl} download={`${title || "reel"}.mp4`}>
              <ChunkyButton variant="primary" size="md" className="w-full">
                Download MP4
              </ChunkyButton>
            </a>
          )}

          {renderable < 1 && (
            <p className="font-mono text-xs text-ink-2">
              Add at least one renderable project to this reel.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md font-mono text-ink-2 hover:text-ink disabled:opacity-30 disabled:hover:text-ink-2"
    >
      {children}
    </button>
  );
}
